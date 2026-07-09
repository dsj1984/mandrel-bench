// bench/scenarios/standalone-telemetry-adapter.js
//
// Standalone-path telemetry adapter for the Mandrel self-benchmark harness
// (Story #48). Internal tooling only — never shipped in the distributed
// `.agents/` bundle.
//
// WHY THIS EXISTS. The Epic delivery path writes an on-disk lifecycle ledger
// (`temp/epic-<id>/lifecycle.ndjson`) that `discoverLedger` (bench/run.js) reads
// to derive planning-fidelity and autonomy. The **standalone single-Story path**
// — which Mandrel 1.75.0 routes most work through — writes NO such ledger; its
// provenance is entirely GitHub-side (the Story's structured comments + label
// lifecycle + the linked PR). Without this adapter those value dimensions are
// unmeasured (correctly `null` after the #47 scorer fix, but still blind).
//
// This adapter recovers the SAME sub-signal shape `planningInputs` /
// `deriveAutonomyCounters` produce, from GitHub instead of an NDJSON ledger, so
// a standalone-routed mandrel cell yields MEASURED planning-fidelity + autonomy.
//
// SCOPE (Story #48, decided): planning-fidelity, autonomy, and a first-class
// `routingVerdict`. The overhead token-split stays `null` for standalone cells —
// it is genuinely unmeasurable there (no dispatch windows / per-phase token
// attribution), and is handled by leaving the ceremony/codegen split absent so
// `computeOverheadRatio` reports `tokenRatio: null` (never a faked 0).
//
// PHASE-SPLIT (Epic #66, Story #77, target-architecture §8). The "genuinely
// unmeasurable" framing above undersold what GitHub actually records: the
// Story issue's `createdAt` → `closedAt` span IS the story-implementation
// window, the same role `story.dispatch.start`/`.end` play in the Epic
// ledger. `collectStandaloneTelemetry` now also returns a `phases` block
// carrying those raw timestamps (plus the PR's `mergedAt`) and a derived
// `codegenMs` (the createdAt→closedAt span, clamped non-negative). The caller
// (`buildScorecard`, bench/collect/normalize.js) combines `codegenMs` with the
// session's total wall-clock + token envelope — which this adapter does not
// have access to — to produce a real ceremony/codegen token split, exactly
// the way `deriveTokenSplit` does for the Epic ledger path. When the
// timestamps can't be parsed, `codegenMs` is `null` and the caller falls back
// to the prior all-ceremony/no-split behaviour, now surfaced as a loud
// warning marker rather than a silent null.
//
// DETERMINISM. All GitHub access runs through one injected `ghJson` port so the
// unit tests stub every read with no network. The default port shells `gh` and
// parses its `--json` output.

import { execFileSync as defaultExecFileSync } from 'node:child_process';

/** Markers that count as autonomy interventions in the standalone flow. */
const BLOCKED_RE =
  /ap:structured-comment\s+type="(?:epic|story)?-?blocked"|agent::blocked/i;
const INTERVENTION_RE = /ap:structured-comment\s+type="intervention"/i;
const HITL_STOP_RE = /ap:structured-comment\s+type="hitl-stop"|hitl[-\s]?stop/i;
/** A re-plan / decomposition-revision structured comment. */
const REPLAN_RE = /ap:structured-comment\s+type="re-?plan"/i;

/**
 * Default `ghJson` port: run `gh <args>` and parse stdout as JSON. The child's
 * stderr is discarded so a non-zero-but-recoverable gh run never leaks chatter.
 *
 * @param {string[]} args  Arguments to `gh` (must include a `--json` selector).
 * @param {{ execFileSync?: typeof defaultExecFileSync }} [ports]
 * @returns {unknown} Parsed JSON.
 */
export function defaultGhJson(args, ports = {}) {
  const execFileSync = ports.execFileSync ?? defaultExecFileSync;
  const out = execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out);
}

/**
 * Correlate this run's mandrel cell to the standalone Story it produced in the
 * sandbox. The standalone path opens exactly one `type::story` issue per
 * delivery; runs are sequential and the sandbox is reset to baseline before
 * each, so "the newest `type::story` created at/after the run's start" is the
 * cell's Story deterministically — no free-text parsing of the session result.
 *
 * @param {object} args
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {string} args.sinceIso  Run-start timestamp (ISO-8601); only Stories
 *                                 created at/after this are considered.
 * @param {{ ghJson?: typeof defaultGhJson }} [ports]
 * @returns {number|null} The Story issue number, or null when none is found.
 */
export function discoverStandaloneStory({ owner, repo, sinceIso }, ports = {}) {
  const ghJson = ports.ghJson ?? defaultGhJson;
  const since = Date.parse(sinceIso);
  let issues;
  try {
    issues = ghJson(
      [
        'issue',
        'list',
        '--repo',
        `${owner}/${repo}`,
        '--label',
        'type::story',
        '--state',
        'all',
        '--json',
        'number,createdAt',
        '--limit',
        '50',
      ],
      ports,
    );
  } catch {
    return null;
  }
  if (!Array.isArray(issues)) return null;
  const fresh = issues
    .filter(
      (i) =>
        Number.isInteger(i?.number) &&
        Number.isFinite(Date.parse(i?.createdAt)) &&
        (!Number.isFinite(since) || Date.parse(i.createdAt) >= since),
    )
    .sort((a, b) => b.number - a.number);
  return fresh.length > 0 ? fresh[0].number : null;
}

/**
 * Read a delivered standalone Story's GitHub telemetry and return the planning +
 * autonomy sub-signals in the shape `buildScorecard` feeds to the scorer, plus
 * the `routingVerdict`. Returns `null` when the Story cannot be read (so the
 * caller leaves the value dims null rather than fabricating them).
 *
 * @param {object} args
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {number} args.storyNumber
 * @param {{ ghJson?: typeof defaultGhJson }} [ports]
 * @returns {{
 *   planning: { plannedStoryCount: number, deliveredStoryCount: number, rePlanCount: number, actualPaths?: string[] },
 *   autonomy: { hitlStops: number, blockedEvents: number, manualRescues: number },
 *   routingVerdict: 'story',
 *   phases: { createdAt: string|null, closedAt: string|null, prMergedAt: string|null, codegenMs: number|null }
 * } | null}
 */
export function collectStandaloneTelemetry(
  { owner, repo, storyNumber },
  ports = {},
) {
  const ghJson = ports.ghJson ?? defaultGhJson;
  const repoFlag = `${owner}/${repo}`;

  let issue;
  try {
    issue = ghJson(
      [
        'issue',
        'view',
        String(storyNumber),
        '--repo',
        repoFlag,
        '--json',
        'number,state,labels,comments,createdAt,closedAt',
      ],
      ports,
    );
  } catch {
    return null;
  }
  if (!issue || typeof issue !== 'object') return null;

  // The linked PR is the one from the deterministic `story-<n>` branch.
  let pr = null;
  try {
    const prs = ghJson(
      [
        'pr',
        'list',
        '--repo',
        repoFlag,
        '--head',
        `story-${storyNumber}`,
        '--state',
        'all',
        '--json',
        'number,mergedAt,files',
        '--limit',
        '5',
      ],
      ports,
    );
    if (Array.isArray(prs) && prs.length > 0) pr = prs[0];
  } catch {
    pr = null;
  }

  const labels = Array.isArray(issue.labels)
    ? issue.labels.map((l) => l?.name).filter((n) => typeof n === 'string')
    : [];
  const comments = Array.isArray(issue.comments)
    ? issue.comments.map((c) => (typeof c?.body === 'string' ? c.body : ''))
    : [];

  // Delivered ⇔ the PR merged AND the issue closed at agent::done. A run that
  // opened the Story but never merged scores deliveredStoryCount 0 (a real
  // planning miss), not a silent pass.
  const merged = Boolean(pr?.mergedAt);
  const closedDone =
    String(issue.state).toUpperCase() === 'CLOSED' &&
    labels.includes('agent::done');
  const delivered = merged && closedDone;

  const rePlanCount = comments.filter((b) => REPLAN_RE.test(b)).length;
  const actualPaths = Array.isArray(pr?.files)
    ? pr.files.map((f) => f?.path).filter((p) => typeof p === 'string')
    : undefined;

  // Autonomy interventions: an `agent::blocked` runtime pause, recorded
  // interventions, and HITL stops the run halted at. A clean headless delivery
  // has zero of each → autonomy 1.0 (measured, not defaulted).
  const blockedEvents =
    (labels.includes('agent::blocked') ? 1 : 0) +
    comments.filter((b) => BLOCKED_RE.test(b)).length;
  const manualRescues = comments.filter((b) => INTERVENTION_RE.test(b)).length;
  const hitlStops = comments.filter((b) => HITL_STOP_RE.test(b)).length;

  // The Story issue's createdAt → closedAt span is the story-implementation
  // window on the standalone path — the same role the Epic ledger's matched
  // `story.dispatch.start`/`.end` pair plays for `deriveTokenSplit`. Both
  // timestamps must parse for the span to be meaningful; a negative span
  // (clock skew / malformed data) clamps to 0 rather than going negative.
  const createdAt =
    typeof issue.createdAt === 'string' ? issue.createdAt : null;
  const closedAt = typeof issue.closedAt === 'string' ? issue.closedAt : null;
  const prMergedAt = typeof pr?.mergedAt === 'string' ? pr.mergedAt : null;
  const createdMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  const closedMs = closedAt ? Date.parse(closedAt) : Number.NaN;
  const codegenMs =
    Number.isFinite(createdMs) && Number.isFinite(closedMs)
      ? Math.max(0, closedMs - createdMs)
      : null;

  return {
    planning: {
      plannedStoryCount: 1,
      deliveredStoryCount: delivered ? 1 : 0,
      rePlanCount,
      ...(actualPaths ? { actualPaths } : {}),
    },
    autonomy: { hitlStops, blockedEvents, manualRescues },
    routingVerdict: 'story',
    phases: { createdAt, closedAt, prMergedAt, codegenMs },
  };
}
