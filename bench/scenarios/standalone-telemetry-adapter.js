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

/**
 * Markers that count as autonomy interventions in the standalone flow.
 *
 * MUST match the STRUCTURED-COMMENT blocked form only — NOT the bare
 * `agent::blocked` substring (Ticket #121, item 3). The bare-substring
 * alternative counted ANY issue comment merely mentioning the label (e.g. a
 * delivery-summary comment that says "the run never went agent::blocked") as
 * an intervention, so every standalone cell scored exactly blockedEvents=1 →
 * autonomy 0.50, including hello-world. The genuine terminal-block signal is
 * the actual label-state transition, which `collectStandaloneTelemetry` reads
 * separately via `labels.includes('agent::blocked')` — the bare substring here
 * only double-counted delivery prose.
 */
const BLOCKED_RE = /ap:structured-comment\s+type="(?:epic|story)?-?blocked"/i;
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
 * Multi-Story counterpart to `discoverStandaloneStory`: return EVERY
 * `type::story` issue created at/after the run start, ascending by issue
 * number (creation order).
 *
 * WHY THIS EXISTS (v2 Epic collapse). Mandrel v2.0.0 deleted the Epic tier:
 * `/plan` now emits N Stories directly and `/deliver` takes the id list. A
 * decomposition-scoped scenario therefore opens 4-6 sibling `type::story`
 * issues where v1 opened one Epic. `discoverStandaloneStory` returns only the
 * NEWEST such issue, which — paired with the single-Story adapter's hardcoded
 * `plannedStoryCount: 1` — would score a 4-6 decomposition contract at a
 * permanent 0.5 while looking exactly like a real measurement. This function
 * is what makes the decomposition observable at all.
 *
 * @param {object} args
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {string} args.sinceIso  Run-start timestamp (ISO-8601).
 * @param {{ ghJson?: typeof defaultGhJson }} [ports]
 * @returns {number[]} Story issue numbers ascending; `[]` when none is found
 *                     or the read fails (never a throw).
 */
export function discoverStories({ owner, repo, sinceIso }, ports = {}) {
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
    return [];
  }
  if (!Array.isArray(issues)) return [];
  return issues
    .filter(
      (i) =>
        Number.isInteger(i?.number) &&
        Number.isFinite(Date.parse(i?.createdAt)) &&
        (!Number.isFinite(since) || Date.parse(i.createdAt) >= since),
    )
    .map((i) => i.number)
    .sort((a, b) => a - b);
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
 *   autonomy: { hitlStops: number, blockedEvents: number, manualRescues: number, gateRetries: number },
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
    // gateRetries is a lifecycle-ledger signal (self-recovered close-validate
    // churn, Ticket #121 item 2); the standalone GitHub telemetry has no
    // close-validate boundary to read, so it is 0 here (never inflates the
    // terminal blockedEvents count either — the two are disjoint by design).
    autonomy: { hitlStops, blockedEvents, manualRescues, gateRetries: 0 },
    routingVerdict: 'story',
    phases: { createdAt, closedAt, prMergedAt, codegenMs },
  };
}

/**
 * Aggregate the telemetry of the N sibling Stories a v2 decomposition-scoped
 * plan produced, in the same shape `buildScorecard` consumes.
 *
 * Each Story is read with `collectStandaloneTelemetry` — one code path for one
 * Story's GitHub facts, so the multi-Story numbers cannot drift from the
 * single-Story ones — and the per-Story results are combined:
 *
 * - **plannedStoryCount** — `storyNumbers.length`, i.e. what the PLAN opened.
 *   Deliberately NOT the count of Stories that could be read: a Story that
 *   vanished is a planning fact, and shrinking the denominator would silently
 *   forgive it. Unreadable Stories are surfaced as `unreadableStoryCount`.
 * - **deliveredStoryCount** — Stories that both merged a PR and closed at
 *   `agent::done`, so a partial delivery scores as the partial it is.
 * - **rePlanCount / autonomy counters** — summed; an intervention on any
 *   Story is an intervention in the run.
 * - **actualPaths** — the de-duplicated union across every Story's PR, since
 *   sibling Stories routinely touch a shared file.
 * - **phases** — `createdAt` is the earliest Story's, `closedAt` and
 *   `prMergedAt` the latest, so the block spans the whole delivery.
 *   `codegenMs` SUMS the per-Story implementation windows rather than taking
 *   the outer span, because the outer span would bank the idle gaps between
 *   Stories as codegen time. v2 `/deliver` walks the dependency graph and
 *   delivers Stories through one engine, so the windows are effectively
 *   sequential; were they ever run concurrently this sum would overcount, and
 *   that assumption is the one to revisit first if the split looks wrong.
 *
 * @param {object} args
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {number[]} args.storyNumbers  Story issue numbers (from `discoverStories`).
 * @param {{ ghJson?: typeof defaultGhJson }} [ports]
 * @returns {{
 *   planning: { plannedStoryCount: number, deliveredStoryCount: number, rePlanCount: number, actualPaths?: string[] },
 *   autonomy: { hitlStops: number, blockedEvents: number, manualRescues: number, gateRetries: number },
 *   routingVerdict: 'multi-story',
 *   storyNumbers: number[],
 *   unreadableStoryCount: number,
 *   phases: { createdAt: string|null, closedAt: string|null, prMergedAt: string|null, codegenMs: number|null }
 * } | null} `null` when no Story number was supplied, or when NOT ONE could be
 *   read — the value dims then stay unmeasured rather than reporting a fake 0.
 */
export function collectMultiStoryTelemetry(
  { owner, repo, storyNumbers },
  ports = {},
) {
  const numbers = Array.isArray(storyNumbers)
    ? storyNumbers.filter((n) => Number.isInteger(n))
    : [];
  if (numbers.length === 0) return null;

  const perStory = [];
  for (const storyNumber of numbers) {
    const t = collectStandaloneTelemetry({ owner, repo, storyNumber }, ports);
    if (t) perStory.push(t);
  }
  if (perStory.length === 0) return null;

  let deliveredStoryCount = 0;
  let rePlanCount = 0;
  let hitlStops = 0;
  let blockedEvents = 0;
  let manualRescues = 0;
  let gateRetries = 0;
  const paths = new Set();
  const createdMsList = [];
  const closedMsList = [];
  const mergedMsList = [];
  let codegenMs = null;

  for (const t of perStory) {
    deliveredStoryCount += t.planning.deliveredStoryCount;
    rePlanCount += t.planning.rePlanCount;
    hitlStops += t.autonomy.hitlStops;
    blockedEvents += t.autonomy.blockedEvents;
    manualRescues += t.autonomy.manualRescues;
    gateRetries += t.autonomy.gateRetries;
    for (const p of t.planning.actualPaths ?? []) paths.add(p);
    if (t.phases.createdAt) createdMsList.push(Date.parse(t.phases.createdAt));
    if (t.phases.closedAt) closedMsList.push(Date.parse(t.phases.closedAt));
    if (t.phases.prMergedAt) mergedMsList.push(Date.parse(t.phases.prMergedAt));
    if (t.phases.codegenMs != null)
      codegenMs = (codegenMs ?? 0) + t.phases.codegenMs;
  }

  /** Earliest/latest of a millisecond list, back as an ISO string. */
  const edge = (list, pick) => {
    const finite = list.filter((ms) => Number.isFinite(ms));
    if (finite.length === 0) return null;
    return new Date(pick(...finite)).toISOString().replace('.000Z', 'Z');
  };

  const actualPaths = [...paths].sort();

  return {
    planning: {
      // What the plan opened — NOT perStory.length. See the doc block.
      plannedStoryCount: numbers.length,
      deliveredStoryCount,
      rePlanCount,
      ...(actualPaths.length > 0 ? { actualPaths } : {}),
    },
    autonomy: { hitlStops, blockedEvents, manualRescues, gateRetries },
    routingVerdict: 'multi-story',
    storyNumbers: numbers,
    unreadableStoryCount: numbers.length - perStory.length,
    phases: {
      createdAt: edge(createdMsList, Math.min),
      closedAt: edge(closedMsList, Math.max),
      prMergedAt: edge(mergedMsList, Math.max),
      codegenMs,
    },
  };
}
