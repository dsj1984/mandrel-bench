// bench/run.js
/**
 * Top-level run orchestrator for the Mandrel self-benchmark harness
 * (Epic #2, Story #3). Internal tooling only — never shipped in the distributed
 * `.agents/` bundle, never run against the live repo.
 *
 * This is the glue the harness was missing: the loop over
 * `N × scenarios × arms` that ties every existing pure component together into
 * one pipeline per run —
 *
 *   provision (sandbox.js)
 *     → overlay the framework-under-test (overlay.js, mandrel arm only) or
 *        write the gate package.json directly (control arm, Story #74)
 *     → run a headless `claude -p` session (run-session.js)
 *     → materialize the delivered code + discover the lifecycle ledger
 *     → start the delivered app and score Quality (app-runner.js + the
 *        acceptance-eval adapter)
 *     → normalize into a scorecard (collect/normalize.js → score/*)
 *     → persist + render (report/persist.js + report/render.js)
 *   teardown (sandbox.js, guaranteed)
 *
 * The scoring/persist/render modules are pure and carry no clock or identity —
 * this orchestrator stamps `runId`, `timestamp`, `env`, and `frameworkVersion`,
 * and is the single place real `claude`/git/app effects happen. Every such
 * effect is injectable so `runFirstBenchmark` is exercised end to end by the
 * unit suite with no real session, clone, or server.
 *
 * For v1 the first run is a risk-first N=1 smoke: `hello-world`, both arms.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScorecard, parseNdjson } from './collect/normalize.js';
import { withRunningApp as defaultWithRunningApp } from './driver/app-runner.js';
import {
  armSeedsStaticClaudeMd,
  isMandrelArm,
  parseBenchArms,
  routingOverrideForArm,
} from './driver/arms.js';
import {
  defaultCliLogger,
  runIfMain,
  sanitizeIdent,
} from './driver/cli-shell.js';
import { DEFAULT_TTL_HOURS, sweepLeakedRepos } from './driver/janitor.js';
import {
  overlayFrameworkUnderTest,
  seedStaticClaudeMd,
  writeGatePackageJson,
} from './driver/overlay.js';
import {
  DEFAULT_BENCH_MODEL,
  DEFAULT_SESSION_TIMEOUT_MS,
  defaultInvokeClaudeSession,
  runSession as defaultRunSession,
  parseSessionEnvelope,
  rethrowIfTransientClaudeError,
} from './driver/run-session.js';
import {
  createEphemeralRepo,
  defaultEphemeralRoot,
  destroyEphemeralRepo,
  provisionSandbox,
  resetSandboxBaseline,
  SANDBOX_DIR_PREFIX,
  sandboxRepoName,
  sanitizeGitHubTokenEnv,
  seedFromTemplate,
  teardownSandbox,
} from './driver/sandbox.js';
import {
  readBenchmarkVersion,
  readFrameworkVersion,
} from './driver/version-readers.js';
import { cohortDir } from './report/cohort-path.js';
import { appendScorecards } from './report/persist.js';
import {
  renderCohortReport,
  renderDashboardFile,
} from './report/render-tree.js';
import {
  cellCostUsd,
  normalizeScenarioTouches,
  resolveControlClaudeMdFixture,
  runTouchChain,
} from './run-chain.js';
import { scoreScenarioQuality as defaultScoreScenarioQuality } from './scenarios/acceptance-eval-adapter.js';
import {
  collectSourceExcerpt as defaultCollectSourceExcerpt,
  runDimensionJudge as defaultRunDimensionJudge,
} from './scenarios/dimension-judge-adapter.js';
import { collectMaintainabilitySignals as defaultCollectMaintainabilitySignals } from './scenarios/maintainability-adapter.js';
import { collectSecuritySignals as defaultCollectSecuritySignals } from './scenarios/security-adapter.js';
import {
  collectMultiStoryTelemetry,
  collectStandaloneTelemetry,
  defaultGhJson,
  discoverStandaloneStory,
  discoverStories,
} from './scenarios/standalone-telemetry-adapter.js';
import {
  runTrapOracles as defaultRunTrapOracles,
  TOUCH2_TRAPS_SUBDIR,
} from './scenarios/trap-runner.js';
import {
  computePlanQuality,
  obligationsForTrapClasses,
} from './score/plan-quality.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** This repo's root — the source of the framework-under-test overlay. */
export function repoRoot() {
  return path.resolve(__dirname, '..');
}

/**
 * Permission args passed to `claude -p` for BOTH arms. Permission mode is
 * orthogonal to scaffolding: a headless session (bare control or mandrel
 * pipeline) must be able to write and commit files without a TTY prompt to
 * act autonomously. The fair-comparison difference between the arms is the
 * presence of `.agents/` + the pipeline prompt, NOT the ability to act. Safe
 * because every run executes inside a throwaway sandbox clone.
 */
export const SESSION_EXTRA_ARGS = Object.freeze([
  '--permission-mode',
  'bypassPermissions',
]);

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------

// The cohort-stamp version readers (`readFrameworkVersion`,
// `readBenchmarkVersion`) live in the leaf module `driver/version-readers.js`
// so this run loop and the top-up planner share one definition (D-014). They
// are re-exported here to preserve this module's public surface.
export { readBenchmarkVersion, readFrameworkVersion };

/**
 * Sanitize an arbitrary string into the scorecard `runId` pattern
 * (`^[A-Za-z0-9._-]+$`). Thin alias over the shared `sanitizeIdent` in
 * `driver/cli-shell.js`.
 *
 * @param {string} s
 * @returns {string}
 */
export function sanitizeRunId(s) {
  return sanitizeIdent(s);
}

/**
 * Parse an OPTIONAL numeric env var (BENCH_N / BENCH_MAX_RUNS /
 * BENCH_MAX_COST_USD). An unset, empty, whitespace-only, or non-finite value
 * resolves to `undefined` — the "operator did not specify" signal — NOT the
 * poison `Number('') === 0`. This matters because CI passes these knobs
 * straight through from `workflow_dispatch` inputs, and a blank input arrives
 * as an EMPTY STRING (present, not unset). A blank `BENCH_N` reaching
 * `Number('')` would resolve to a uniform run-count override of 0, zeroing
 * every scenario's `targetN` so the cell runs nothing — silently producing an
 * empty cohort on the default (blank `target_n`) dispatch (Epic #84 review
 * finding). An explicit `'0'` is preserved (a deliberate zero override); only
 * blank / non-numeric input degrades to `undefined`.
 *
 * @param {unknown} value  A raw env-var value (string | undefined).
 * @returns {number|undefined}
 */
export function parseOptionalNumericEnv(value) {
  if (value == null) return undefined;
  const trimmed = String(value).trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build the run identity stamp for one (scenario × arm × run).
 *
 * @param {object} args
 * @param {string} args.scenario
 * @param {'mandrel'|'control'} args.arm
 * @param {number} args.runIndex   1-based.
 * @param {string} args.timestamp  ISO-8601 run-complete time.
 * @param {string} args.modelId
 * @param {string} args.frameworkVersion
 * @param {string} args.benchmarkVersion  This benchmark repo's own version (D-014).
 * @param {{ node: string, os: string, host?: string }} args.env
 * @returns {object} The `run` identity object buildScorecard expects.
 */
export function buildRunIdentity({
  scenario,
  arm,
  runIndex,
  timestamp,
  modelId,
  frameworkVersion,
  benchmarkVersion,
  env,
}) {
  const idStamp = sanitizeRunId(`${scenario}-${arm}-${timestamp}-r${runIndex}`);
  return {
    runId: idStamp,
    timestamp,
    model: { id: modelId },
    frameworkVersion,
    benchmarkVersion,
    env,
    scenario,
    arm,
  };
}

/**
 * Resolve the exact model id to stamp. A `claude -p` session reports usage for
 * the pinned main model AND any auxiliary models (e.g. a haiku fast-path for
 * cheap sub-operations), so the first `modelUsage` key is not reliably the
 * model under test. Prefer the requested (pinned) model when it appears in
 * `modelUsage` — it ran — else the highest-token-usage key, else the request.
 *
 * @param {object} envelope  Parsed session envelope.
 * @param {string} requestedModel
 * @returns {string}
 */
export function resolveModelId(envelope, requestedModel) {
  const usage = envelope?.modelUsage;
  if (usage && typeof usage === 'object') {
    const keys = Object.keys(usage);
    if (keys.includes(requestedModel)) return requestedModel;
    let best = null;
    let bestTokens = -1;
    for (const k of keys) {
      const u = usage[k] ?? {};
      const t =
        (u.inputTokens ?? u.input_tokens ?? 0) +
        (u.outputTokens ?? u.output_tokens ?? 0);
      if (t > bestTokens) {
        bestTokens = t;
        best = k;
      }
    }
    if (best) return best;
  }
  return requestedModel;
}

/**
 * Derive Quality inputs (the shape `buildScorecard` expects) from a frozen
 * oracle result + an optional acceptance-eval cross-check decision.
 *
 * @param {object} args
 * @param {{ criteria: Array<{ met: boolean }> }} args.frozen
 * @param {string|null} [args.crossCheckDecision]  e.g. 'proceed' (mandrel) or null (control).
 * @returns {{ frozenSuitePassed: number, frozenSuiteTotal: number, acceptanceEvalScore: number|null }}
 */
export function qualityInputs({ frozen, crossCheckDecision = null }) {
  const criteria = Array.isArray(frozen?.criteria) ? frozen.criteria : [];
  const frozenSuitePassed = criteria.filter((c) => c?.met === true).length;
  const frozenSuiteTotal = criteria.length;
  const acceptanceEvalScore =
    crossCheckDecision === null
      ? null
      : crossCheckDecision === 'proceed'
        ? 1
        : 0;
  return { frozenSuitePassed, frozenSuiteTotal, acceptanceEvalScore };
}

/**
 * Derive plan-vs-actual inputs from the lifecycle ledger: planned ≈ Story
 * dispatch starts, delivered ≈ Story dispatch ends. Re-plan events are not
 * separately emitted in the v1 bundle, so `rePlanCount` is 0.
 *
 * @param {Array<object>} lifecycle  Parsed lifecycle records.
 * @returns {{ plannedStoryCount: number, deliveredStoryCount: number, rePlanCount: number }}
 */
export function planningInputs(lifecycle = []) {
  let starts = 0;
  let ends = 0;
  for (const r of lifecycle) {
    if (r?.event === 'story.dispatch.start') starts += 1;
    else if (r?.event === 'story.dispatch.end') ends += 1;
  }
  return {
    plannedStoryCount: starts,
    deliveredStoryCount: ends,
    rePlanCount: 0,
  };
}

/**
 * Canonical security-MUST keys → the `collectSecuritySignals` boolean flag that
 * detects each (Ticket #122, item 3). A scenario declares which of these apply
 * via `scenario.security.applicableMusts`.
 */
export const SECURITY_MUST_FLAGS = Object.freeze({
  inputValidation: 'hasEdgeInputValidation',
  passwordHashing: 'hasPasswordHashing',
  safeTokenStorage: 'hasSafeTokenStorage',
  serverSideAuthz: 'hasServerSideAuthz',
  authRateLimiting: 'hasAuthRateLimiting',
});

/** The full MUST-key set, used as the fallback when a scenario declares none. */
const ALL_SECURITY_MUSTS = Object.freeze(Object.keys(SECURITY_MUST_FLAGS));

/**
 * Resolve a scenario's declared applicable-MUST set (Ticket #122, item 3):
 * `scenario.security.applicableMusts` when it is a non-empty array, else null
 * (the caller then scores all five). Pure.
 *
 * @param {object} scenario
 * @returns {string[]|null}
 */
export function scenarioApplicableMusts(scenario) {
  const declared = scenario?.security?.applicableMusts;
  return Array.isArray(declared) && declared.length > 0 ? declared : null;
}

/**
 * Derive the `securityInputs` object for `buildScorecard` from the raw
 * sub-signals returned by `collectSecuritySignals` and the optional judge
 * scores.
 *
 * The security adapter returns boolean MUST-presence signals; we map them to
 * the `criticalFindings` / `highFindings` / `secretsDetected` sub-signals that
 * `computeSecurity` in dimensions.js expects, and compute
 * `objectiveSecurityScore` as a weighted sum:
 *
 *   secretPenalty           = max(0, 1 − secretScanCount / 5)     weight 0.30
 *   vulnPenalty             = max(0, 1 − depAuditVulnCount / 10)  weight 0.20
 *   mustPresenceScore       = (validationOk + hashingOk + storageOk
 *                             + authzOk + rateLimitOk) / 5         weight 0.50
 *   objectiveSecurityScore  = secretPenalty·0.30 + vulnPenalty·0.20
 *                           + mustPresenceScore·0.50
 *
 * **Applicable MUST set (Ticket #122, item 3).** 3 of the 5 MUSTs are
 * UNREACHABLE under the scenarios' "no external web framework" + bearer-token
 * constraints: a schema-validation library import (`inputValidation`),
 * httpOnly cookies (`safeTokenStorage` — bearer tokens live in the
 * Authorization header, not cookies), and a rate-limit library import
 * (`authRateLimiting`). Scoring them anyway pinned the spine at a floor no
 * arm could clear. A scenario now declares the APPLICABLE MUST set via
 * `scenario.security.applicableMusts`; only those are scored, and the
 * mustPresenceScore divides by the applicable count rather than a hardcoded 5.
 * An absent/empty declaration falls back to all five (back-compat).
 *
 * @param {object} sigs   Output of collectSecuritySignals (or {}).
 * @param {{ security?: number } | null} judgeScores  Batched judge output.
 * @param {string[]|null} [applicableMusts]  The scenario's declared applicable
 *   MUST keys (subset of SECURITY_MUST_FLAGS keys); null/empty ⇒ all five.
 * @returns {object}
 */
export function derivedSecurityInputs(
  sigs,
  judgeScores,
  applicableMusts = null,
) {
  const secretScanCount =
    typeof sigs.secretScanCount === 'number' ? sigs.secretScanCount : 0;
  const depAuditVulnCount =
    typeof sigs.depAuditVulnCount === 'number' ? sigs.depAuditVulnCount : 0;

  // Proportional secret penalty (Story #55): a single hit no longer zeroes the
  // full 0.30 weight (the old `secretScanCount > 0 ? 0 : 1` binary cliff). Each
  // detected secret subtracts 1/5 of the weight, saturating at 5+ hits. The
  // adapter already excludes test-fixture credentials from the count, so this
  // penalty now responds to *delivered* secrets in graduated proportion rather
  // than punishing the mere presence of one example credential.
  const SECRET_PENALTY_SATURATION = 5;
  const secretPenalty = Math.max(
    0,
    1 - secretScanCount / SECRET_PENALTY_SATURATION,
  );
  const vulnPenalty = Math.max(0, 1 - depAuditVulnCount / 10);

  // Score only the APPLICABLE MUSTs (Ticket #122, item 3). An absent/empty
  // declaration scores all five (back-compat); an unknown key is ignored.
  const musts =
    Array.isArray(applicableMusts) && applicableMusts.length > 0
      ? applicableMusts.filter((k) => k in SECURITY_MUST_FLAGS)
      : ALL_SECURITY_MUSTS;
  const mustCount = musts.filter((k) =>
    Boolean(sigs[SECURITY_MUST_FLAGS[k]]),
  ).length;
  const mustPresenceScore = musts.length > 0 ? mustCount / musts.length : 1;

  const objectiveSecurityScore = Math.max(
    0,
    Math.min(
      1,
      secretPenalty * 0.3 + vulnPenalty * 0.2 + mustPresenceScore * 0.5,
    ),
  );

  // criticalFindings: treat secret hits as critical; depAudit vulns as high.
  const criticalFindings = secretScanCount;
  const highFindings = depAuditVulnCount;
  const secretsDetected = secretScanCount > 0;

  return {
    objectiveSecurityScore,
    securityJudgeScore: judgeScores?.security ?? null,
    criticalFindings,
    highFindings,
    secretsDetected,
  };
}

/**
 * Discover the lifecycle ledger + per-Story signals inside a delivered
 * workspace. A clean `/deliver` merge RELOCATES the ledger from the live
 * `temp/epic-<id>/` directory into a timestamped `temp/archive/epic-<id>-...`
 * directory (the cleaner listener fires on `epic.merge.confirmed`), so we look
 * in the archive FIRST, then the live dir. Among candidates we prefer the
 * ledger whose last record is `epic.complete` (a fully-merged run), else the
 * first found.
 *
 * @param {object} args
 * @param {string} args.workspacePath
 * @param {object} [deps]
 * @param {(p: string) => boolean} [deps.existsImpl]
 * @param {(p: string, opts?: object) => string[]} [deps.readdirImpl]
 * @param {(p: string, enc: string) => string} [deps.readFileImpl]
 * @returns {{ lifecyclePath: string, signalsPaths: string[] } | null}
 */
export function discoverLedger({ workspacePath }, deps = {}) {
  const exists = deps.existsImpl ?? existsSync;
  const readdir = deps.readdirImpl ?? ((p) => readdirSync(p));
  const read = deps.readFileImpl ?? readFileSync;

  const epicDirs = [];
  const tempDir = path.join(workspacePath, 'temp');
  const archiveDir = path.join(tempDir, 'archive');
  // Archive-first (the clean-merge location), then the live temp dir.
  if (exists(archiveDir)) {
    for (const name of readdir(archiveDir)) {
      if (name.startsWith('epic-')) epicDirs.push(path.join(archiveDir, name));
    }
  }
  if (exists(tempDir)) {
    for (const name of readdir(tempDir)) {
      if (name.startsWith('epic-')) epicDirs.push(path.join(tempDir, name));
    }
  }

  const candidates = [];
  for (const dir of epicDirs) {
    const lifecyclePath = path.join(dir, 'lifecycle.ndjson');
    if (!exists(lifecyclePath)) continue;
    let completed = false;
    try {
      const recs = parseNdjson(read(lifecyclePath, 'utf8'));
      completed = recs.some((r) => r?.event === 'epic.complete');
    } catch {
      // unreadable — still a candidate, just not "completed"
    }
    candidates.push({ dir, lifecyclePath, completed });
  }
  if (candidates.length === 0) return null;

  // Prefer a completed ledger; archive entries already sort ahead of live ones.
  const chosen = candidates.find((c) => c.completed) ?? candidates[0];

  const signalsPaths = [];
  const storiesDir = path.join(chosen.dir, 'stories');
  if (exists(storiesDir)) {
    for (const story of readdir(storiesDir)) {
      const sp = path.join(storiesDir, story, 'signals.ndjson');
      if (exists(sp)) signalsPaths.push(sp);
    }
  }
  return { lifecyclePath: chosen.lifecyclePath, signalsPaths };
}

/**
 * Resolve the PR-head delivery branch name for a mandrel run from the discovered
 * routing target (Ticket #121, item 1). The `/deliver` pipeline pushes an Epic
 * integration branch `epic/<epicId>` (epic routing) or a Story execution branch
 * `story-<storyId>` (standalone routing) and opens the change-request PR from
 * it; that branch's tip is the scoreable PR-head tree even when the PR never
 * merges. Returns null when the target is unknown (nothing to fetch).
 *
 * MULTI-STORY (v2 Epic collapse). A decomposition-scoped v2 run has N sibling
 * `story-<id>` branches, each with its own PR to `main` — there is no single
 * integration branch to fall back to. The happy path is unaffected: when the
 * PRs merge, `main` carries every Story and `materializeMandrelDelivery`
 * scores the merged tree without consulting this function. The fallback is
 * necessarily lossy, and resolves to the LAST Story's branch: Stories are
 * delivered in dependency order, so the highest-numbered branch is the one
 * built on the most previously-merged work and is the best single scoreable
 * approximation. A partial multi-Story delivery scored this way is therefore
 * an UNDER-estimate, never a fabrication — the `landed: false` flag the
 * caller records is what marks it as such.
 *
 * @param {{ routing?: string|null, epicId?: number|null, storyNumber?: number|null, storyNumbers?: number[]|null }|null} target
 * @returns {string|null}
 */
export function resolveDeliveryBranch(target) {
  if (!target || typeof target !== 'object') return null;
  const { routing, epicId, storyNumber, storyNumbers } = target;
  if (routing === 'multi-story') {
    const ns = Array.isArray(storyNumbers)
      ? storyNumbers.filter((n) => Number.isInteger(n))
      : [];
    return ns.length > 0 ? `story-${Math.max(...ns)}` : null;
  }
  if (routing === 'story' && storyNumber != null) return `story-${storyNumber}`;
  if (epicId != null) return `epic/${epicId}`;
  if (storyNumber != null) return `story-${storyNumber}`;
  return null;
}

/**
 * Materialize the mandrel arm's delivered tree into the working copy and
 * classify its LANDING (Ticket #121, item 1). This replaces the prior
 * "reset to origin/main; null the run when the SHA is unchanged" behaviour,
 * which discarded a perfectly-scoreable PR-head tree as a data-destroying null
 * (42% of the last cohort). New contract:
 *
 *   1. Fetch + reset the working copy to `origin/main`. If `main` advanced past
 *      the seed baseline, the PR MERGED → `{ landed: true, delivered: true,
 *      source: 'main' }` and the merged tree is scored.
 *   2. If `main` is unchanged (unlanded), fetch the PR-head delivery branch and
 *      check it out. If it exists and differs from the baseline, the unlanded
 *      PR-head tree IS scoreable → `{ landed: false, delivered: true, source:
 *      'branch' }`. This preserves the materialization guards' intent (no false
 *      zeros) while flipping the default from "null when unlanded" to "score the
 *      PR-head, flag landed:false".
 *   3. Only when neither a merged main nor a differing PR-head branch exists is
 *      the run genuinely unmaterialized → `{ landed: false, delivered: false,
 *      source: 'none' }` (quality/maintainability/security score null, NOT a
 *      false 0 on the empty seed tree).
 *
 * When `baselineSha` is unknown the landing comparison is impossible; the prior
 * behaviour (score `main`, assume delivered) is preserved with `landed: null`.
 *
 * @param {object} args
 * @param {(args: string[], cwd: string) => string} args.gitFn
 * @param {string} args.workspacePath
 * @param {string|null|undefined} args.baselineSha
 * @param {string|null} args.deliveryBranch
 * @param {{ warn?: Function, info?: Function }} [logger]
 * @returns {{ landed: boolean|null, delivered: boolean, source: 'main'|'branch'|'none' }}
 */
export function materializeMandrelDelivery(
  { gitFn, workspacePath, baselineSha, deliveryBranch },
  logger,
) {
  let mainHead = null;
  try {
    gitFn(['fetch', 'origin', 'main'], workspacePath);
    gitFn(['checkout', 'main'], workspacePath);
    gitFn(['reset', '--hard', 'origin/main'], workspacePath);
    mainHead = gitFn(['rev-parse', 'HEAD'], workspacePath).trim();
  } catch (err) {
    logger?.warn?.(
      `[run] could not reach origin/main to materialize delivery: ${err?.message ?? err}`,
    );
    // Fall through: still try the PR-head branch below (main is unreachable but
    // the delivery branch might be fetchable).
  }

  // No baseline to compare against → cannot determine landing; preserve the
  // prior "score main, assume delivered" behaviour with an undetermined landed.
  if (!baselineSha) {
    if (mainHead != null) {
      return { landed: null, delivered: true, source: 'main' };
    }
  } else if (mainHead != null && mainHead !== baselineSha) {
    // main advanced past the seed baseline → the PR merged (landed).
    return { landed: true, delivered: true, source: 'main' };
  }

  // Unlanded (or main unreachable): try to score the PR-head delivery branch so
  // an existing-but-unlanded tree is not discarded as null.
  if (deliveryBranch) {
    try {
      gitFn(['fetch', 'origin', deliveryBranch], workspacePath);
      gitFn(
        ['checkout', '-B', 'bench-pr-head', `origin/${deliveryBranch}`],
        workspacePath,
      );
      const branchHead = gitFn(['rev-parse', 'HEAD'], workspacePath).trim();
      if (!baselineSha || branchHead !== baselineSha) {
        logger?.info?.(
          `[run] delivery did not land — scoring the unlanded PR-head tree from origin/${deliveryBranch} (landed:false), not a null.`,
        );
        return { landed: false, delivered: true, source: 'branch' };
      }
    } catch (err) {
      logger?.warn?.(
        `[run] could not fetch PR-head branch origin/${deliveryBranch}: ${err?.message ?? err}`,
      );
    }
  }

  // Neither a merged main nor a differing PR-head branch — genuinely nothing to
  // score. landed is false only when we had a baseline to compare against.
  logger?.warn?.(
    '[run] delivery did not materialize (no merged main, no PR-head branch) — scoring quality as null (unmaterialized), not a false 0.',
  );
  return {
    landed: baselineSha ? false : null,
    delivered: false,
    source: 'none',
  };
}

// ---------------------------------------------------------------------------
// Phase-scoped sessions: between-session id-discovery + plan snapshot (D-019,
// Epic #86 Story #94)
// ---------------------------------------------------------------------------

/**
 * Default `gh --json` port for the plan-phase seam, running `gh <args>` with the
 * SANITIZED GitHub-token environment (`sanitizeGitHubTokenEnv` — BENCH_GITHUB_TOKEN
 * wins over ambient GH_TOKEN, whitespace-stripped) so the id-discovery and
 * snapshot reads use the same credential surface as the rest of the sandbox
 * lifecycle and add NO new one (Epic #86 security note). The child's stderr is
 * discarded. Injectable `execFileSync` so tests never spawn `gh`.
 *
 * @param {string[]} args  Arguments to `gh` (must include a `--json` selector).
 * @param {{ execFileSync?: typeof execFileSync }} [ports]
 * @returns {unknown} Parsed JSON.
 */
export function defaultPlanGhJson(args, ports = {}) {
  const exec = ports.execFileSync ?? execFileSync;
  const out = exec('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: sanitizeGitHubTokenEnv(),
  });
  return JSON.parse(out);
}

/**
 * Discover the Epic id the mandrel arm's PLAN session created on the ephemeral
 * repo (the id-discovery seam, F1 from Epic #86's pre-mortem). In the default
 * `--idea` drive the Epic is opened INSIDE the plan session, so the harness
 * never learns its id from stdout; after the plan session exits we recover it
 * the same deterministic way `discoverStandaloneStory` recovers a Story: the
 * newest `type::epic` issue created at/after the run's start (runs are
 * sequential and the sandbox is reset to baseline before each). Returns null
 * when none is found.
 *
 * @param {object} args
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {string} args.sinceIso  Run-start timestamp (ISO-8601); only Epics
 *   created at/after this are considered.
 * @param {{ ghJson?: typeof defaultPlanGhJson }} [ports]
 * @returns {number|null} The Epic issue number, or null when none is found.
 */
export function discoverPlannedEpicId({ owner, repo, sinceIso }, ports = {}) {
  const ghJson = ports.ghJson ?? defaultPlanGhJson;
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
        'type::epic',
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
 * Snapshot the plan artifacts the mandrel arm's PLAN session produced into
 * `.raw/<run-stamp>/plan/` BEFORE the deliver session starts (D-019). This
 * freezes what the plan is scored on so delivery can never retroactively alter
 * it. For epic-routed runs the Epic body (which carries the folded tech-spec
 * sections) plus every child Story body (with its inline `acceptance[]` /
 * `verify[]`) are captured; for story-routed runs the standalone Story body is.
 * A `manifest.json` records the routing + the captured ids. All GitHub reads run
 * through the injected `ghJson` port (sanitized env by default) so unit tests
 * stub every read with no network. Best-effort per-artifact: an unreadable
 * ticket is skipped, not fatal.
 *
 * @param {object} args
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {'epic'|'story'|null} args.routing
 * @param {number|null} [args.epicId]      Discovered/seed Epic id (epic routing).
 * @param {number|null} [args.storyNumber] Discovered Story id (story routing).
 * @param {string} args.planDir            Absolute `.raw/<stamp>/plan/` path.
 * @param {string} args.sinceIso           Run-start; bounds child-Story discovery.
 * @param {string|null} [args.capturedAt]  Stamp recorded in the manifest.
 * @param {object} [deps]
 * @param {typeof defaultPlanGhJson} [deps.ghJson]
 * @param {(p: string, opts?: object) => void} [deps.mkdirImpl]
 * @param {(p: string, data: string) => void} [deps.writeFileImpl]
 * @param {{ warn?: Function }} [deps.logger]
 * @returns {{ planDir: string, files: string[], manifest: object }}
 */
export function snapshotPlanArtifacts(
  {
    owner,
    repo,
    routing,
    epicId = null,
    storyNumber = null,
    planDir,
    sinceIso,
    capturedAt = null,
  },
  deps = {},
) {
  const ghJson = deps.ghJson ?? defaultPlanGhJson;
  const mkdir = deps.mkdirImpl ?? ((p) => mkdirSync(p, { recursive: true }));
  const writeFile = deps.writeFileImpl ?? writeFileSync;
  const logger = deps.logger;
  const repoFlag = `${owner}/${repo}`;
  const files = [];

  mkdir(planDir);

  const writeJson = (name, obj) => {
    const fp = path.join(planDir, name);
    writeFile(fp, `${JSON.stringify(obj, null, 2)}\n`);
    files.push(fp);
  };

  const manifest = {
    routing: routing ?? null,
    epicId: epicId ?? null,
    storyNumber: storyNumber ?? null,
    storyNumbers: [],
    capturedAt: capturedAt ?? null,
  };

  if (epicId != null) {
    // Epic-routed: capture the Epic body (tech-spec sections travel with it)
    // and every child Story body (its inline acceptance[]/verify[]).
    try {
      const epic = ghJson(
        [
          'issue',
          'view',
          String(epicId),
          '--repo',
          repoFlag,
          '--json',
          'number,title,body,labels',
        ],
        deps,
      );
      if (epic && typeof epic === 'object')
        writeJson(`epic-${epicId}.json`, epic);
    } catch (err) {
      logger?.warn?.(
        `[run] plan snapshot: could not read Epic #${epicId}: ${err?.message ?? err}`,
      );
    }
    let stories = [];
    try {
      stories = ghJson(
        [
          'issue',
          'list',
          '--repo',
          repoFlag,
          '--label',
          'type::story',
          '--state',
          'all',
          '--json',
          'number,title,body,createdAt',
          '--limit',
          '100',
        ],
        deps,
      );
    } catch (err) {
      logger?.warn?.(
        `[run] plan snapshot: could not list child Stories: ${err?.message ?? err}`,
      );
    }
    const since = Date.parse(sinceIso);
    const fresh = (Array.isArray(stories) ? stories : []).filter(
      (s) =>
        Number.isInteger(s?.number) &&
        (!Number.isFinite(since) ||
          !s?.createdAt ||
          !Number.isFinite(Date.parse(s.createdAt)) ||
          Date.parse(s.createdAt) >= since),
    );
    for (const s of fresh) {
      writeJson(`story-${s.number}.json`, {
        number: s.number,
        title: s.title,
        body: s.body,
      });
    }
    manifest.storyNumbers = fresh.map((s) => s.number);
  } else if (storyNumber != null) {
    // Story-routed: the standalone Story body IS the plan.
    try {
      const story = ghJson(
        [
          'issue',
          'view',
          String(storyNumber),
          '--repo',
          repoFlag,
          '--json',
          'number,title,body,labels',
        ],
        deps,
      );
      if (story && typeof story === 'object') {
        writeJson(`story-${storyNumber}.json`, story);
      }
    } catch (err) {
      logger?.warn?.(
        `[run] plan snapshot: could not read Story #${storyNumber}: ${err?.message ?? err}`,
      );
    }
  }

  writeJson('manifest.json', manifest);
  return { planDir, files, manifest };
}

/**
 * Extract candidate acceptance-criterion strings from a Story body's markdown.
 * Returns the body's list-item lines (bullets `-`/`*`/`+` or numbered `1.`),
 * stripped of their markers and inline bold/backtick emphasis; when the body
 * carries no list items at all, the whole trimmed body is returned as a single
 * entry so coverage still has text to trace against. Pure.
 *
 * @param {string} body  A Story body (markdown), e.g. from a plan snapshot.
 * @returns {string[]}
 */
export function extractStoryAcceptance(body) {
  const text = typeof body === 'string' ? body : '';
  const items = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = line.match(/^(?:[-*+]|\d+[.)])\s+(.*\S)/);
    if (m) items.push(m[1].replace(/[`*]/g, '').trim());
  }
  if (items.length > 0) return items;
  const trimmed = text.trim();
  return trimmed ? [trimmed] : [];
}

/**
 * Build the intrinsic PLAN-QUALITY block (Epic #86, Story #95; D-019) for one
 * MANDREL-arm run from the plan snapshot `snapshotPlanArtifacts` wrote between
 * the /plan and /deliver sessions. Reads the snapshot's Story/Epic bodies off
 * disk, assembles the `computePlanQuality` input from the scenario's frozen
 * spec (`seed.acceptance`), routing contract (`storyCountContract`), and trap
 * classes (→ security-baseline obligations), and returns the scorer's block.
 *
 * Returns null when there is no usable snapshot (e.g. the plan-phase discovery
 * failed and left `planSnapshot` null), so the caller threads null into
 * `buildScorecard` and the scorecard's plan-quality axis stays absent — exactly
 * the control-arm / legacy-corpus shape the renderer already tolerates.
 *
 * The attribution decision table is NOT computed here: it crosses the plan
 * score with the delivered OUTCOME and plan-adherence, which are only known once
 * `buildScorecard` has computed the dimensions, so `buildScorecard` attaches
 * `planQuality.attribution` from the same dimension scores the renderer reads.
 *
 * @param {object} args
 * @param {{ planDir: string, files: string[], manifest: object }|null} args.snapshot
 * @param {object} args.scenario   The scenario.json object (frozen spec).
 * @param {string[]} [args.trapClasses]  The scenario's declared trap classes.
 * @param {number|null} [args.judgeScore]  Optional LLM-judge cross-check.
 * @param {object} [deps]
 * @param {(p: string, enc: string) => string} [deps.readFileImpl]
 * @returns {object|null} the `computePlanQuality` block, or null.
 */
export function buildPlanQualityBlock(
  { snapshot, scenario, trapClasses = [], judgeScore = null },
  deps = {},
) {
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    !Array.isArray(snapshot.files) ||
    snapshot.files.length === 0
  ) {
    return null;
  }
  const readFile = deps.readFileImpl ?? readFileSync;
  const storyAcceptance = [];
  const planTextParts = [];
  let plannedStoryCount = 0;
  for (const fp of snapshot.files) {
    const base = path.basename(String(fp));
    const isStory = /^story-.*\.json$/.test(base);
    const isEpic = /^epic-.*\.json$/.test(base);
    if (!isStory && !isEpic) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFile(fp, 'utf8'));
    } catch {
      continue;
    }
    const body = typeof parsed?.body === 'string' ? parsed.body : '';
    if (isStory) {
      plannedStoryCount += 1;
      for (const ac of extractStoryAcceptance(body)) storyAcceptance.push(ac);
    }
    if (body) planTextParts.push(body);
  }

  const frozenAcceptance = Array.isArray(scenario?.seed?.acceptance)
    ? scenario.seed.acceptance
    : [];
  const storyCountContract =
    scenario?.storyCountContract &&
    typeof scenario.storyCountContract === 'object'
      ? scenario.storyCountContract
      : undefined;

  return computePlanQuality({
    arm: 'mandrel',
    frozenAcceptance,
    storyAcceptance,
    storyCountContract,
    plannedStoryCount,
    obligations: obligationsForTrapClasses(trapClasses),
    planText: planTextParts.join('\n'),
    judgeScore,
  });
}

// ---------------------------------------------------------------------------
// Batch resume + ceiling (Story #22)
// ---------------------------------------------------------------------------

/**
 * The default checkpoint filename, sitting beside the results tree root. The
 * checkpoint is an append-only NDJSON ledger of completed `(scenario × arm ×
 * run)` cell keys — the same crash-safe shape as the scorecard store, so a
 * partially-written final line never corrupts the cells before it.
 */
export const CHECKPOINT_FILENAME = '.batch-checkpoint.ndjson';

/**
 * Derive the stable identity string for one `(scenario × arm × run)` cell. This
 * is the unit of resumable work: the batch loop checkpoints a cell once its
 * scorecard has been persisted, and skips a cell on resume when its key is
 * already in the checkpoint. Pure — the same inputs always map to the same key.
 *
 * The separator is a unit-separator control char (``) so it can never
 * collide with a scenario id, arm, or run index value.
 *
 * @param {object} args
 * @param {string} args.scenario
 * @param {'mandrel'|'control'} args.arm
 * @param {number} args.runIndex   1-based.
 * @returns {string}
 */
export function cellKey({ scenario, arm, runIndex }) {
  return `${scenario}${arm}${runIndex}`;
}

/**
 * Read the set of completed cell keys from the checkpoint ledger. A non-existent
 * checkpoint reads as an empty set (a batch that never checkpointed is simply
 * starting fresh, not an error). Malformed / blank lines are skipped defensively
 * so a half-written final line never strands a resumable batch.
 *
 * @param {object} args
 * @param {string} args.checkpointPath
 * @param {object} [deps]
 * @param {(p: string) => boolean} [deps.existsImpl]
 * @param {(p: string, enc: string) => string} [deps.readFileImpl]
 * @returns {Set<string>}
 */
export function readCheckpoint({ checkpointPath }, deps = {}) {
  const exists = deps.existsImpl ?? existsSync;
  const read = deps.readFileImpl ?? readFileSync;
  const done = new Set();
  if (!checkpointPath || !exists(checkpointPath)) return done;
  const text = read(checkpointPath, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const rec = JSON.parse(trimmed);
      if (typeof rec?.cell === 'string' && rec.cell.length > 0) {
        done.add(rec.cell);
      }
    } catch {
      // half-written / corrupt line — skip it; the cell will simply re-run.
    }
  }
  return done;
}

/**
 * Append one completed-cell record to the checkpoint ledger, creating the parent
 * directory and file on first write. Append-only by design — the same crash-safe
 * semantics as the scorecard store.
 *
 * @param {object} args
 * @param {string} args.checkpointPath
 * @param {string} args.cell            The cell key (from `cellKey`).
 * @param {object} [deps]
 * @param {(p: string, data: string) => void} [deps.appendFileImpl]
 * @param {(p: string) => boolean} [deps.existsImpl]
 * @param {(p: string, opts: object) => void} [deps.mkdirImpl]
 * @returns {void}
 */
export function appendCheckpoint({ checkpointPath, cell }, deps = {}) {
  const append = deps.appendFileImpl ?? appendFileSync;
  const exists = deps.existsImpl ?? existsSync;
  const mkdir = deps.mkdirImpl ?? ((p) => mkdirSync(p, { recursive: true }));
  const dir = path.dirname(checkpointPath);
  if (dir && dir !== '.' && !exists(dir)) mkdir(dir, { recursive: true });
  append(checkpointPath, `${JSON.stringify({ cell })}\n`);
}

// ---------------------------------------------------------------------------
// I/O shell
// ---------------------------------------------------------------------------

/**
 * Load a scenario definition, its frozen oracle's `evaluate` export, and the
 * scenario's directory (so the caller can run its declared trap oracles via
 * `bench/scenarios/trap-runner.js`, Epic #66 Story #74 — replacing the former
 * single-oracle `scenario.trapOracle` field). The trap oracles are the
 * SEPARATE adversarial face: the frozen suite scores behavioural Quality both
 * arms can pass, while the per-class trap-runner source-scans the delivered
 * tree for planted defects. A scenario with no `traps/` directory is scored
 * exactly as before (the runner yields an empty `classes[]`).
 *
 * When the scenario declares a frozen `changeRequest` (Epic #86, Story #96 —
 * the "second touch"), its own frozen behavioural suite
 * (`changeRequest.acceptanceSuite`, default `./acceptance.touch2.test.js`) is
 * resolved too and returned as `touch2Evaluate`. A scenario with no
 * `changeRequest` (e.g. hello-world) resolves `touch2Evaluate` to `null`, and
 * the driver skips touch 2 for it.
 *
 * When the scenario declares a `touches[]` CHAIN (issue #124, PR-C — the
 * brownfield-longitudinal rung), the touches are normalized + validated via
 * `normalizeScenarioTouches` (prompt text loaded from `promptPath` at load
 * time) and returned as `touches`; the chain is MUTUALLY EXCLUSIVE with
 * `changeRequest` (the seed overlay is the baseline — there is no greenfield
 * touch-1 build or single frozen change request), so no top-level acceptance
 * suite or touch-2 oracle is resolved for it (`evaluate`/`touch2Evaluate` are
 * null — scoring runs through the scenario's suite-evolution runner instead).
 * A scenario with no `touches[]` returns `touches: null` and behaves exactly
 * as before.
 *
 * @param {string} scenarioId
 * @param {object} [deps]
 * @param {(p: string, enc: string) => string} [deps.readFileImpl]
 * @param {(spec: string) => Promise<object>} [deps.importImpl]
 * @returns {Promise<{ scenario: object, evaluate: Function|null, scenarioDir: string, touch2Evaluate: Function|null, touches: Array<object>|null }>}
 */
export async function loadScenario(scenarioId, deps = {}) {
  const read = deps.readFileImpl ?? readFileSync;
  const importImpl = deps.importImpl ?? ((spec) => import(spec));
  const dir = path.join(__dirname, 'scenarios', scenarioId);
  const scenario = JSON.parse(read(path.join(dir, 'scenario.json'), 'utf8'));
  if (scenario.touches !== undefined) {
    // Touch-chain scenario (issue #124, PR-C): normalize + validate the chain
    // declaration (this also rejects a `changeRequest` sibling). The chain
    // path scores through the scenario's suite-evolution runner, so no
    // greenfield acceptance module is imported here.
    const touches = normalizeScenarioTouches(scenario, dir, {
      readFileImpl: read,
    });
    return {
      scenario,
      evaluate: null,
      scenarioDir: dir,
      touch2Evaluate: null,
      touches,
    };
  }
  const suiteRel = scenario.acceptanceSuite ?? './acceptance.test.js';
  const mod = await importImpl(path.join(dir, suiteRel));
  let touch2Evaluate = null;
  if (scenario.changeRequest && typeof scenario.changeRequest === 'object') {
    const touch2Rel =
      scenario.changeRequest.acceptanceSuite ?? './acceptance.touch2.test.js';
    const touch2Mod = await importImpl(path.join(dir, touch2Rel));
    touch2Evaluate = touch2Mod.evaluate;
  }
  return {
    scenario,
    evaluate: mod.evaluate,
    scenarioDir: dir,
    touch2Evaluate,
    touches: null,
  };
}

// ---------------------------------------------------------------------------
// The second touch (Epic #86, Story #96): after touch 1 is scored, the driver
// runs the scenario's frozen CHANGE REQUEST as a FRESH session against the
// delivered tree, with arm-appropriate inheritance, then scores it with the
// full dimension set + the frozen touch-2 behavioural suite + the phase-scoped
// regression oracles. The continuity delta (mandrel touch-2 outcome/cost −
// control touch-2 outcome/cost) is the actual persistence-thesis measurement.
// ---------------------------------------------------------------------------

/**
 * Prepare the workspace the touch-2 session runs against, with
 * ARM-APPROPRIATE inheritance (Epic #86 pre-mortem, F2 point 3):
 *
 * - **mandrel** keeps its FULL pipeline output — the delivered tree with the
 *   `.agents` overlay and the tickets/plan state intact — so the second touch
 *   inherits everything Mandrel produced on the first. The touch-2 session
 *   runs in the SAME workspace directory (no copy).
 * - **control** is reduced to DELIVERED CODE ONLY — a fresh copy of the
 *   workspace with any framework/session artifacts (dot-dirs such as `.git` /
 *   `.agents` / `.claude`, and the `CLAUDE.md` overlay file) stripped — so it
 *   inherits nothing but the code it shipped, exactly the asymmetry the
 *   persistence thesis is testing.
 *
 * Every filesystem effect is injectable so the unit suite exercises the seam
 * without touching disk.
 *
 * @param {object} args
 * @param {'mandrel'|'control'} args.arm
 * @param {string} args.workspacePath  The touch-1 delivered workspace.
 * @param {object} [deps]
 * @param {(src: string, dest: string, opts: object) => void} [deps.cpFn]
 * @param {(p: string, opts?: object) => void} [deps.mkdirFn]
 * @returns {{ touch2Cwd: string, inheritance: 'full-pipeline'|'delivered-code-only' }}
 */
export function prepareTouch2Workspace({ arm, workspacePath }, deps = {}) {
  if (isMandrelArm(arm)) {
    // Full pipeline output travels forward untouched.
    return { touch2Cwd: workspacePath, inheritance: 'full-pipeline' };
  }
  // Control: reduce to delivered code only in a fresh sibling directory.
  const cp = deps.cpFn ?? cpSync;
  const mkdir = deps.mkdirFn ?? ((p) => mkdirSync(p, { recursive: true }));
  const reducedDir = `${workspacePath}--touch2-delivered`;
  mkdir(reducedDir);
  // Skip framework/session artifacts so the control arm inherits ONLY the code
  // it delivered — the same skip set the trap-oracle scanner uses (dot-dirs are
  // the overlaid framework tree; CLAUDE.md is the overlay file artifact).
  const STRIP = new Set(['.git', '.agents', '.claude', 'CLAUDE.md']);
  cp(workspacePath, reducedDir, {
    recursive: true,
    filter: (src) => !STRIP.has(path.basename(src)),
  });
  return { touch2Cwd: reducedDir, inheritance: 'delivered-code-only' };
}

/**
 * Run the scenario's frozen change request as the SECOND TOUCH against the
 * touch-1 delivered tree, and score it with the full dimension set, its own
 * frozen behavioural suite, and the phase-scoped (`traps-touch2/`) regression
 * oracles. Returns the compact `touch2` scorecard block (or `null` when the
 * scenario declares no change request / no touch-2 suite is available).
 *
 * The regression scan is run with `trapsSubdir: TOUCH2_TRAPS_SUBDIR` so it
 * discovers ONLY `traps-touch2/` — the touch-1 `traps/` scan is untouched, and
 * this scan never sees the touch-1 oracles.
 *
 * Every real effect (session, app boot, git, collectors, judge, trap-runner)
 * is injected via the same `deps` shape `runOneRun` uses, so the whole touch-2
 * path is unit-proven with fixtures and no live process.
 *
 * @param {object} opts
 * @param {object} opts.scenario
 * @param {Function} opts.touch2Evaluate  The frozen touch-2 oracle's `evaluate`.
 * @param {string|null} opts.scenarioDir
 * @param {'mandrel'|'control'} opts.arm
 * @param {number} opts.runIndex
 * @param {string} opts.model
 * @param {object} opts.sandbox
 * @param {{ workspacePath: string }} opts.handle
 * @param {string} opts.frameworkVersion
 * @param {string} opts.benchmarkVersion
 * @param {{ node: string, os: string, host?: string }} opts.env
 * @param {number} opts.timeoutMs
 * @param {object} [deps]
 * @returns {Promise<object|null>} the `touch2` scorecard block, or null.
 */
export async function runTouch2(opts, deps = {}) {
  const {
    scenario,
    touch2Evaluate,
    scenarioDir = null,
    arm,
    runIndex,
    model = DEFAULT_BENCH_MODEL,
    handle,
    frameworkVersion,
    benchmarkVersion,
    env,
    timeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
    // Directory to persist the touch-2 delivery's raw telemetry into before
    // sandbox teardown (Ticket #121, item 4). Null ⇒ skip the persistence.
    touch2RawDir = null,
  } = opts;

  if (
    !scenario?.changeRequest ||
    typeof scenario.changeRequest !== 'object' ||
    typeof touch2Evaluate !== 'function'
  ) {
    // No frozen change request declared (e.g. hello-world) — skip touch 2.
    return null;
  }

  const logger = deps.logger;
  const prepareWorkspace =
    deps.prepareTouch2WorkspaceFn ?? prepareTouch2Workspace;
  const runSessionFn = deps.runSessionFn ?? defaultRunSession;
  const withRunningAppFn = deps.withRunningAppFn ?? defaultWithRunningApp;
  const scoreQualityFn =
    deps.scoreScenarioQualityFn ?? defaultScoreScenarioQuality;
  const collectMaintainabilityFn =
    deps.collectMaintainabilityFn ?? defaultCollectMaintainabilitySignals;
  const collectSecurityFn =
    deps.collectSecurityFn ?? defaultCollectSecuritySignals;
  const runDimensionJudgeFn =
    deps.runDimensionJudgeFn ?? defaultRunDimensionJudge;
  const collectSourceExcerptFn =
    deps.collectSourceExcerptFn ?? defaultCollectSourceExcerpt;
  const runTrapOraclesFn = deps.runTrapOraclesFn ?? defaultRunTrapOracles;
  const gitFn =
    deps.gitFn ??
    ((args, cwd) =>
      execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }));
  const nowIso = deps.nowFn ?? (() => new Date().toISOString());
  const mkdirFn = deps.mkdirFn ?? ((p) => mkdirSync(p, { recursive: true }));
  const writeFileFn = deps.writeFileFn ?? writeFileSync;

  // Persist the touch-2 delivery's raw telemetry (cost envelope, lifecycle
  // ledger, session result) into `touch2RawDir` before sandbox teardown so a
  // `merge.unlanded` failure is attributable rather than invisible (Ticket
  // #121, item 4). Best-effort: a persistence failure never masks the touch-2
  // result. Called once the session envelope is available.
  const persistTouch2Raw = (envelopeToPersist, workspaceForLedger) => {
    if (typeof touch2RawDir !== 'string' || touch2RawDir.length === 0) return;
    try {
      mkdirFn(touch2RawDir);
      // Cost envelope + final session result.
      writeFileFn(
        path.join(touch2RawDir, 'cost-envelope.json'),
        `${JSON.stringify(envelopeToPersist?.raw ?? envelopeToPersist ?? {}, null, 2)}\n`,
      );
      writeFileFn(
        path.join(touch2RawDir, 'session-result.json'),
        `${JSON.stringify(
          {
            isError: envelopeToPersist?.isError ?? null,
            result: envelopeToPersist?.result ?? null,
            terminalReason: envelopeToPersist?.terminalReason ?? null,
            numTurns: envelopeToPersist?.numTurns ?? null,
          },
          null,
          2,
        )}\n`,
      );
      // Lifecycle ledger, when a mandrel-base arm produced one in the touch-2
      // tree.
      if (isMandrelArm(arm)) {
        const found = discoverLedger(
          { workspacePath: workspaceForLedger },
          deps.discoverDeps,
        );
        if (found?.lifecyclePath) {
          const read = deps.readFileImpl ?? readFileSync;
          try {
            writeFileFn(
              path.join(touch2RawDir, 'lifecycle.ndjson'),
              read(found.lifecyclePath, 'utf8'),
            );
          } catch (err) {
            logger?.warn?.(
              `[run] touch2: could not copy lifecycle ledger: ${err?.message ?? err}`,
            );
          }
        }
      }
    } catch (err) {
      logger?.warn?.(
        `[run] touch2: could not persist raw telemetry to ${touch2RawDir}: ${err?.message ?? err}`,
      );
    }
  };

  // Prepare the arm-appropriate touch-2 workspace.
  const { touch2Cwd, inheritance } = prepareWorkspace(
    { arm, workspacePath: handle.workspacePath },
    { cpFn: deps.cpFn, mkdirFn: deps.mkdirFn },
  );
  // The control arm's reduced touch-2 tree is a fresh sibling directory under
  // the ephemeral root (`${workspacePath}--touch2-delivered`). teardownSandbox
  // removes only `handle.workspacePath`, and the janitor sweeps only leaked
  // GitHub repos — so this sibling would leak and fill the ephemeral root
  // across a batch (audit M2). Clean it up in the finally below.
  const reducedDir =
    inheritance === 'delivered-code-only' && touch2Cwd !== handle.workspacePath
      ? touch2Cwd
      : null;
  const rmDir =
    deps.rmFn ?? ((p) => rmSync(p, { recursive: true, force: true }));

  try {
    // A fresh session drives the CHANGE REQUEST. The bridged scenario carries the
    // change-request prompt as its task; no `epicId` is threaded (the second
    // touch discovers/authors its own plan in-session for the mandrel arm).
    const bridged = {
      id: scenario.id,
      taskPrompt: scenario.changeRequest.prompt,
    };
    const extraArgs = [...SESSION_EXTRA_ARGS];
    const session = runSessionFn(
      {
        arm,
        scenario: bridged,
        cwd: touch2Cwd,
        model,
        extraArgs,
        timeoutMs,
      },
      { invokeFn: deps.invokeFn, logger },
    );

    // Persist the touch-2 delivery's raw telemetry BEFORE materialization (the
    // `git reset --hard` below can move the working tree off the delivery HEAD)
    // and before sandbox teardown, so an unlanded touch-2 (`merge.unlanded`) is
    // attributable rather than invisible (Ticket #121, item 4).
    persistTouch2Raw(session.envelope, touch2Cwd);

    // Materialize the delivered second-touch code. The mandrel arm's clean
    // /deliver auto-merged onto the sandbox default branch, so pull it into the
    // touch-2 workspace; the control arm committed directly in `touch2Cwd`.
    //
    // GUARD (baseline autopsy): auto-merge is flaky. When the change-request PR
    // does NOT land, `origin/main` still points at the touch-1 HEAD, so the reset
    // below silently restores touch-1 code and the frozen touch-2 suite scores a
    // STALE tree — a fabricated 0 indistinguishable from a genuine failure.
    // Capture the pre-touch-2 HEAD and compare: an unchanged SHA means the change
    // never materialized, surfaced as `materialized:false` + a null outcome (the
    // honest autonomy signal that the unattended PR failed to land) rather than a
    // false quality score on stale code.
    let materialized = true;
    if (isMandrelArm(arm)) {
      let preSha = null;
      try {
        preSha = gitFn(['rev-parse', 'origin/main'], touch2Cwd).trim();
      } catch {
        // No comparable baseline ref — leave materialized true and fall back to
        // the prior best-effort behaviour.
      }
      try {
        gitFn(['fetch', 'origin', 'main'], touch2Cwd);
        gitFn(['checkout', 'main'], touch2Cwd);
        gitFn(['reset', '--hard', 'origin/main'], touch2Cwd);
        const postSha = gitFn(['rev-parse', 'HEAD'], touch2Cwd).trim();
        if (preSha && postSha === preSha) {
          materialized = false;
          logger?.warn?.(
            `[run] touch2: change-request PR did not land — origin/main unchanged at ${postSha.slice(0, 8)}; scoring touch-2 outcome as null (stale touch-1 tree), not a false 0.`,
          );
        }
      } catch (err) {
        materialized = false;
        logger?.warn?.(
          `[run] touch2: could not materialize merged code (run may have blocked): ${err?.message ?? err}`,
        );
      }
    }

    // An unmaterialized change: record the session's real spend but leave the
    // outcome + behavioural dimensions unmeasured — scoring the stale tree would
    // fabricate a 0. (Control always materializes: it commits directly.)
    if (!materialized) {
      const run = buildRunIdentity({
        scenario: scenario.id,
        arm,
        runIndex,
        timestamp: nowIso(),
        modelId: resolveModelId(session.envelope, model),
        frameworkVersion,
        benchmarkVersion,
        env,
      });
      const subCard = buildScorecard({
        run: { ...run, runId: sanitizeRunId(`${run.runId}-touch2`) },
        lifecycle: [],
        signals: [],
        envelope: session.envelope,
        quality: {},
        planning: {},
        maintainabilityInputs: {},
        securityInputs: {},
        trap: null,
        phases: null,
        scenarioRouting:
          typeof scenario?.routing === 'string' ? scenario.routing : null,
        // The touch-2 change did NOT land unattended — feeds autonomy as an
        // unattended-landing failure (Ticket #121, items 1–2).
        landed: false,
      });
      return {
        changeRequestId:
          typeof scenario.changeRequest.id === 'string'
            ? scenario.changeRequest.id
            : null,
        inheritance,
        outcome: null,
        materialized: false,
        cost: subCard.dimensions.efficiency.costUsd ?? null,
        frozenSuitePassed: 0,
        frozenSuiteTotal: 0,
        totalTokens: subCard.dimensions.efficiency.totalTokens,
        wallClockMs: subCard.dimensions.efficiency.wallClockMs,
        dimensions: subCard.dimensions,
      };
    }

    // Score touch-2 Quality by booting the delivered app and driving the frozen
    // touch-2 behavioural suite (session invalidation / role-based access are
    // asserted HERE, behaviourally — never by a source-scan oracle).
    const quality = await withRunningAppFn(
      { workspacePath: touch2Cwd, app: scenario.app },
      async (baseUrl, appInfo) => {
        const restart = appInfo?.restart;
        if (isMandrelArm(arm)) {
          const r = await scoreQualityFn({
            evaluate: touch2Evaluate,
            baseUrl,
            storyId: 1,
            epicId: null,
            transport: 'in-process',
            evaluateDeps: { restart },
          });
          return qualityInputs({
            frozen: r.frozen,
            crossCheckDecision: r.crossCheck?.decision ?? null,
          });
        }
        const frozen = await touch2Evaluate(baseUrl, { restart });
        return qualityInputs({ frozen, crossCheckDecision: null });
      },
      deps.appRunnerDeps,
    );

    // Full dimension set: collect maintainability + security over the delivered
    // touch-2 tree (best-effort, same as touch 1).
    let maintainabilitySignals = {};
    try {
      maintainabilitySignals = collectMaintainabilityFn(
        touch2Cwd,
        deps.collectMaintainabilityPorts,
      );
    } catch (err) {
      logger?.warn?.(
        `[run] touch2: maintainability collector failed (scoring 0): ${err?.message ?? err}`,
      );
    }
    let securitySignals = {};
    try {
      securitySignals = collectSecurityFn(touch2Cwd, deps.collectSecurityPorts);
    } catch (err) {
      logger?.warn?.(
        `[run] touch2: security collector failed (scoring 0): ${err?.message ?? err}`,
      );
    }

    // Phase-scoped regression oracles: source-scan the touch-2 tree ONLY under
    // traps-touch2/. Best-effort: a runner error leaves the regression block off.
    let regression = null;
    if (typeof scenarioDir === 'string' && scenarioDir.length > 0) {
      try {
        const verdict = await runTrapOraclesFn(
          {
            scenarioDir,
            deliveredTreePath: touch2Cwd,
            trapsSubdir: TOUCH2_TRAPS_SUBDIR,
          },
          deps.trapRunnerDeps,
        );
        if (verdict.classes.length > 0) regression = verdict;
      } catch (err) {
        logger?.warn?.(
          `[run] touch2: regression trap-runner failed (no regression signal recorded): ${err?.message ?? err}`,
        );
      }
    }

    let judgeScores = null;
    try {
      // Bounded delivered-source excerpt for the judge (Ticket #122, item 4).
      let sourceExcerpt = '';
      try {
        sourceExcerpt = collectSourceExcerptFn(
          touch2Cwd,
          deps.collectSourceExcerptPorts,
        );
      } catch (err) {
        logger?.warn?.(
          `[run] touch2: source-excerpt collection failed (judge runs without it): ${err?.message ?? err}`,
        );
      }
      judgeScores = await runDimensionJudgeFn(
        { maintainabilitySignals, securitySignals, sourceExcerpt },
        deps.dimensionJudgeDeps,
      );
    } catch (err) {
      // Transient infra failure → abort so a resume redoes the cell; a genuine
      // judge abstention degrades below.
      rethrowIfTransientClaudeError(err);
      logger?.warn?.(
        `[run] touch2: dimension judge failed (judge weight folded into spine): ${err?.message ?? err}`,
      );
    }

    const maintainabilityInputs = {
      objectiveMaintainabilityScore:
        maintainabilitySignals.objectiveMaintainabilityScore ?? null,
      maintainabilityJudgeScore: judgeScores?.maintainability ?? null,
      lintWarnings: maintainabilitySignals.lintErrorCount ?? 0,
      complexityScore: maintainabilitySignals.complexityScore ?? null,
      maintainabilityIndex: null,
    };
    const securityInputs = derivedSecurityInputs(
      securitySignals,
      judgeScores,
      scenarioApplicableMusts(scenario),
    );

    // Build a full touch-2 sub-scorecard (the "full dimension set") and trim it
    // to the compact continuity block. The touch-2 run carries its own identity
    // stamp so its runId never collides with the touch-1 record.
    const run = buildRunIdentity({
      scenario: scenario.id,
      arm,
      runIndex,
      timestamp: nowIso(),
      modelId: resolveModelId(session.envelope, model),
      frameworkVersion,
      benchmarkVersion,
      env,
    });
    const subCard = buildScorecard({
      run: { ...run, runId: sanitizeRunId(`${run.runId}-touch2`) },
      lifecycle: [],
      signals: [],
      envelope: session.envelope,
      quality,
      planning: {},
      maintainabilityInputs,
      securityInputs,
      trap: null,
      phases: null,
      scenarioRouting:
        typeof scenario?.routing === 'string' ? scenario.routing : null,
      // The touch-2 change LANDED (materialized onto main); feeds autonomy.
      landed: isMandrelArm(arm) ? true : null,
    });

    const outcome = subCard.dimensions.quality.score;
    const cost = subCard.dimensions.efficiency.costUsd ?? null;
    return {
      changeRequestId:
        typeof scenario.changeRequest.id === 'string'
          ? scenario.changeRequest.id
          : null,
      inheritance,
      materialized: true,
      outcome,
      cost,
      frozenSuitePassed: quality.frozenSuitePassed,
      frozenSuiteTotal: quality.frozenSuiteTotal,
      totalTokens: subCard.dimensions.efficiency.totalTokens,
      wallClockMs: subCard.dimensions.efficiency.wallClockMs,
      dimensions: subCard.dimensions,
      ...(regression
        ? {
            regression: {
              classes: regression.classes.map((entry) => ({
                class: entry.class,
                score: entry.score,
                defectPresent: Boolean(entry.defectPresent),
                ...(Array.isArray(entry.evidence)
                  ? { evidence: entry.evidence }
                  : {}),
              })),
              cleanRate: regression.cleanRate,
            },
          }
        : {}),
    };
  } finally {
    // M3 (audit): the touch-2 mandrel arm calls runSessionFn with NO
    // betweenPhases, so its /deliver session gets deliverTarget=null and
    // self-discovers the plan it authored in-session via the fallback prompt.
    // This is a DELIBERATE, sane degradation for the second touch (the fallback
    // is designed for exactly this) — threading a full touch-2 id-discovery +
    // plan-snapshot seam for parity was judged higher-risk than its narrow
    // reliability benefit here, so it is intentionally left to the in-session
    // fallback rather than the touch-1 between-phases discovery path.
    //
    // M2 (audit): tear down the control arm's reduced touch-2 sibling so it
    // does not leak under the ephemeral root. Best-effort — a cleanup failure
    // must not mask the touch-2 result.
    if (reducedDir) {
      try {
        rmDir(reducedDir);
      } catch (err) {
        logger?.warn?.(
          `[run] touch2: could not remove the reduced control workspace ${reducedDir}: ${err?.message ?? err}`,
        );
      }
    }
  }
}

/**
 * Execute one (scenario × arm × run): provision → overlay → session →
 * materialize → discover ledger → score Quality → assemble scorecard. Teardown
 * is guaranteed by the caller's try/finally around the sandbox handle.
 *
 * @returns {Promise<object>} the assembled scorecard.
 */
export async function runOneRun(opts, deps = {}) {
  const {
    scenario, // the scenario.json object
    evaluate, // the frozen oracle
    scenarioDir = null, // absolute path to bench/scenarios/<id> (Story #74);
    // threaded into the trap-runner so both arms' delivered trees are scanned
    // for every declared trap class. null ⇒ no trap scan (e.g. legacy fakes).
    touch2Evaluate = null, // the frozen touch-2 oracle (Story #96); present only
    // when the scenario declares a `changeRequest`. null ⇒ the driver skips
    // touch 2 for this scenario (e.g. hello-world).
    touches = null, // normalized touch-chain declarations (issue #124, PR-C),
    // present only for a `touches[]` scenario. Routes the cell to
    // `runTouchChain` below; `changeRequest` scenarios are untouched.
    arm,
    runIndex,
    model = DEFAULT_BENCH_MODEL,
    sandbox, // { repoUrl, owner, repo, baselineSha? } — baselineSha (Story #71,
    // recorded on the ephemeral repo's seed handle) takes precedence over
    // baselineRef branch-resolution when present.
    sourceRoot = repoRoot(),
    resultsDir,
    ephemeralRoot,
    timeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
    skipTouch2 = false, // BENCH_SKIP_TOUCH2 diagnostic (touch-1-only runs)
  } = opts;

  // Touch-chain routing (issue #124, PR-C): a scenario declaring `touches[]`
  // runs as a CHAIN — the seed overlay is the baseline (no greenfield
  // build-from-prompt phase), each touch advances or skips forward per the
  // design §3 rules. `changeRequest` scenarios continue on the existing
  // touch-1 + touch-2 path below, byte-for-byte.
  const chainTouches =
    touches ??
    (Array.isArray(scenario?.touches) && scenario.touches.length > 0
      ? normalizeScenarioTouches(scenario, scenarioDir, {
          readFileImpl: deps.readFileImpl,
        })
      : null);
  if (Array.isArray(chainTouches) && chainTouches.length > 0) {
    return runTouchChain(
      {
        scenario,
        touches: chainTouches,
        scenarioDir,
        arm,
        runIndex,
        model,
        sandbox,
        sourceRoot,
        resultsDir,
        ephemeralRoot,
        timeoutMs,
      },
      deps,
    );
  }

  const baselineRef = sandbox.baselineRef ?? 'bench-baseline';
  const baselineSha = sandbox.baselineSha ?? undefined;

  const logger = deps.logger;
  const provision = deps.provisionFn ?? provisionSandbox;
  const teardown = deps.teardownFn ?? teardownSandbox;
  const resetSandbox = deps.resetSandboxFn ?? resetSandboxBaseline;
  const overlay = deps.overlayFn ?? overlayFrameworkUnderTest;
  const writeGatePkgJson = deps.writeGatePackageJsonFn ?? writeGatePackageJson;
  const seedClaudeMd = deps.seedStaticClaudeMdFn ?? seedStaticClaudeMd;
  const runTrapOraclesFn = deps.runTrapOraclesFn ?? defaultRunTrapOracles;
  const runSessionFn = deps.runSessionFn ?? defaultRunSession;
  const withRunningAppFn = deps.withRunningAppFn ?? defaultWithRunningApp;
  const scoreQualityFn =
    deps.scoreScenarioQualityFn ?? defaultScoreScenarioQuality;
  const collectMaintainabilityFn =
    deps.collectMaintainabilityFn ?? defaultCollectMaintainabilitySignals;
  const collectSecurityFn =
    deps.collectSecurityFn ?? defaultCollectSecuritySignals;
  const runDimensionJudgeFn =
    deps.runDimensionJudgeFn ?? defaultRunDimensionJudge;
  const collectSourceExcerptFn =
    deps.collectSourceExcerptFn ?? defaultCollectSourceExcerpt;
  const gitFn =
    deps.gitFn ??
    ((args, cwd) =>
      execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }));
  const nowIso = deps.nowFn ?? (() => new Date().toISOString());
  const env = deps.env ?? {
    node: process.version,
    os: process.platform,
    host: hostname(),
  };
  const frameworkVersion =
    deps.frameworkVersion ?? readFrameworkVersion(sourceRoot, deps);
  // The benchmark harness's OWN version (D-014) — read from THIS repo's
  // package.json, NOT the pinned mandrel dependency `frameworkVersion` reads.
  const benchmarkVersion =
    deps.benchmarkVersion ?? readBenchmarkVersion(sourceRoot, deps);
  const cp = deps.cpFn ?? cpSync;
  const mkdir = deps.mkdirFn ?? ((p) => mkdirSync(p, { recursive: true }));
  const writeFile = deps.writeFileFn ?? writeFileSync;

  const bridged = {
    id: scenario.id,
    taskPrompt: scenario.seed.prompt,
    // Seed Epic ids drive the plain mandrel arm ONLY: the story-routed
    // variant (arm 4, Ticket #123) authors its own standalone Story via the
    // --idea drive (entering at a seed Epic would contradict its routing
    // override), and control-base arms never touch the pipeline.
    ...(arm === 'mandrel' && scenario.epicId != null
      ? { epicId: scenario.epicId }
      : {}),
  };

  // Secondary, defensive pre-run reset: rewind the sandbox repo's `main` back
  // to the clean baseline BEFORE cloning, so the clone is taken from a clean
  // tree even if a previous run's post-cleanup was skipped or failed. This runs
  // for BOTH arms — the control arm clones `main` after the mandrel arm has
  // dirtied it, so it must also start from a clean baseline. Best-effort: a
  // reset failure must not abort the run (the post-run cleanup is the primary
  // guarantee).
  try {
    resetSandbox(
      {
        owner: sandbox.owner,
        repo: sandbox.repo,
        baselineRef,
        sha: baselineSha,
      },
      { ghFn: deps.ghApiFn, logger },
    );
  } catch (err) {
    logger?.warn?.(
      `[run] pre-run baseline reset failed (continuing): ${err?.message ?? err}`,
    );
  }

  const handle = provision(
    {
      repoUrl: sandbox.repoUrl,
      arm,
      ephemeralRoot,
      repoFullName: sandbox.repoFullName ?? null,
      baselineSha: baselineSha ?? null,
    },
    deps.provisionDeps,
  );
  try {
    if (isMandrelArm(arm)) {
      overlay(
        {
          workspacePath: handle.workspacePath,
          arm,
          sandbox: { owner: sandbox.owner, repo: sandbox.repo },
          sourceRoot,
        },
        deps.overlayDeps,
      );
    } else {
      // Control provisioning path (Story #74): no framework tree to overlay,
      // but the control-base arms still need the SAME real gate package.json
      // as the mandrel arm so gate-based signals are measured identically for
      // both arms (buildTargetPackageJson is now arm-agnostic).
      writeGatePkgJson(
        { workspacePath: handle.workspacePath },
        deps.overlayDeps,
      );
      // Arm 3 (`control-claudemd`, Ticket #123): the identical control path
      // plus ONE static CLAUDE.md seeded into the workspace — the only delta
      // from the control arm, so `(arm3 − control)` isolates the value of any
      // static structure. The CONTENT is per-scenario resolvable (issue #124
      // review note 3): a scenario may declare `controlClaudeMd` (relative to
      // its scenario dir) to point arm 3 at scenario-specific content; absent,
      // the generic `bench/fixtures/control-claudemd.md` default applies.
      if (armSeedsStaticClaudeMd(arm)) {
        const controlClaudeMdFixture = resolveControlClaudeMdFixture(
          scenario,
          scenarioDir,
        );
        seedClaudeMd(
          {
            workspacePath: handle.workspacePath,
            ...(controlClaudeMdFixture
              ? { fixturePath: controlClaudeMdFixture }
              : {}),
          },
          deps.overlayDeps,
        );
      }
    }

    // Both arms get the permission args so each can act headlessly; the mandrel
    // arm's /deliver --yes lives in the prompt (buildArmPrompt), not here.
    const extraArgs = [...SESSION_EXTRA_ARGS];
    // Bound the GitHub-side artifact search (Story #48): any standalone Story
    // the mandrel arm opens in the sandbox is created at/after this instant, so
    // it isolates this cell's Story from prior runs' (sandbox issues persist
    // across the per-run baseline reset).
    const runStartedAt = nowIso();

    // The `.raw/<stamp>/` subdir key for this cell's provenance artifacts (the
    // cost envelope, the lifecycle ledger, and the plan snapshot all land here).
    const idStampForRaw = sanitizeRunId(`${scenario.id}-${arm}-r${runIndex}`);

    // Between-session seam (D-019, Epic #86 Story #94), mandrel arm only. After
    // the PLAN session exits, discover the id(s) it created on the ephemeral
    // repo and snapshot the plan artifacts BEFORE the DELIVER session starts,
    // then thread the discovered id into the deliver prompt. All GitHub reads
    // run through the sanitized `gh` env (deps.ghJson in tests). Best-effort: a
    // discovery/snapshot failure logs and lets delivery fall back to in-session
    // Epic discovery rather than aborting the run.
    const planGhJson = deps.ghJson ?? defaultPlanGhJson;
    // The plan snapshot `snapshotPlanArtifacts` writes between the /plan and
    // /deliver sessions (D-019, Story #94). Surfaced out of the between-phases
    // hook into this run-scoped closure so the MANDREL arm can score the
    // intrinsic PLAN-QUALITY axis (Story #95) off it after delivery — the hook
    // itself keeps returning only `{ deliverTarget }`. Stays null for the
    // control arm and on any plan-phase discovery/snapshot failure.
    let planSnapshot = null;
    // The routing target the plan phase discovered (Ticket #121, item 1),
    // surfaced out of the between-phases hook so the post-session
    // materialization step can resolve the PR-head delivery branch to score
    // when the delivery does not land. Stays null for the control arm and on a
    // discovery failure (then no PR-head branch can be recovered).
    let deliveredTarget = null;
    // The routing this cell EXPECTS (arm-aware, Ticket #123): the arm's
    // forced routing override when it declares one (`mandrel-story-routed`
    // forces `story` — the override IS the treatment), else the scenario
    // contract's declared routing. The override also nulls the seed Epic id:
    // the story-routed plan session authors its own standalone Story, so the
    // discovery below must take the story path, never enter at a seed Epic.
    const forcedRouting = routingOverrideForArm(arm);
    const effectiveRouting =
      forcedRouting ??
      (typeof scenario?.routing === 'string'
        ? scenario.routing
        : scenario.epicId != null
          ? 'epic'
          : null);
    const seedEpicId =
      forcedRouting === 'story' ? null : (scenario.epicId ?? null);
    const betweenPhases = isMandrelArm(arm)
      ? ({ planEnvelope }) => {
          try {
            const modelForRaw = resolveModelId(planEnvelope, model);
            const planDir = path.join(
              cohortDir({
                resultsDir,
                scorecard: { model: { id: modelForRaw }, frameworkVersion },
              }),
              '.raw',
              idStampForRaw,
              'plan',
            );
            const routing = effectiveRouting;
            let epicId = seedEpicId;
            let storyNumber = null;
            let storyNumbers = null;
            let deliverTarget = null;
            if (routing === 'multi-story') {
              // v2 `/plan` opens N sibling Stories and `/deliver` takes the id
              // list; the space-separated ids interpolate straight into the
              // `/deliver <ids> --yes` prompt.
              storyNumbers = discoverStories(
                {
                  owner: sandbox.owner,
                  repo: sandbox.repo,
                  sinceIso: runStartedAt,
                },
                { ghJson: planGhJson },
              );
              deliverTarget =
                storyNumbers.length > 0 ? storyNumbers.join(' ') : null;
            } else if (routing === 'story' && epicId == null) {
              storyNumber = discoverStandaloneStory(
                {
                  owner: sandbox.owner,
                  repo: sandbox.repo,
                  sinceIso: runStartedAt,
                },
                { ghJson: planGhJson },
              );
              deliverTarget = storyNumber;
            } else {
              if (epicId == null) {
                epicId = discoverPlannedEpicId(
                  {
                    owner: sandbox.owner,
                    repo: sandbox.repo,
                    sinceIso: runStartedAt,
                  },
                  { ghJson: planGhJson },
                );
              }
              deliverTarget = epicId;
            }
            planSnapshot = snapshotPlanArtifacts(
              {
                owner: sandbox.owner,
                repo: sandbox.repo,
                routing,
                epicId,
                storyNumber,
                planDir,
                sinceIso: runStartedAt,
                capturedAt: runStartedAt,
              },
              {
                ghJson: planGhJson,
                mkdirImpl: mkdir,
                writeFileImpl: writeFile,
                logger,
              },
            );
            deliveredTarget = { routing, epicId, storyNumber, storyNumbers };
            return { deliverTarget };
          } catch (err) {
            logger?.warn?.(
              `[run] plan-phase id-discovery/snapshot failed (continuing): ${err?.message ?? err}`,
            );
            deliveredTarget = {
              routing: effectiveRouting,
              epicId: seedEpicId,
              storyNumber: null,
              storyNumbers: null,
            };
            return { deliverTarget: seedEpicId };
          }
        }
      : undefined;

    const session = runSessionFn(
      {
        arm,
        scenario: bridged,
        cwd: handle.workspacePath,
        model,
        extraArgs,
        timeoutMs,
      },
      { invokeFn: deps.invokeFn, logger, betweenPhases },
    );

    // Materialize the delivered code into the working tree and classify its
    // LANDING (Ticket #121, item 1). A clean /deliver auto-merges onto the
    // sandbox default branch; when it does NOT, `origin/main` is still the seed
    // baseline — but the delivered code lives on the PR-head branch, which IS
    // scoreable. `materializeMandrelDelivery` scores the PR-head tree in that
    // case (flagging `landed: false`) instead of discarding the run as a null on
    // the empty baseline tree, while still returning `delivered: false` only when
    // there is genuinely nothing to score (no merged main, no PR-head branch).
    // The control arm commits directly and always materializes (landed: N/A).
    let delivered = true;
    let landed = null;
    if (isMandrelArm(arm)) {
      const deliveryBranch = resolveDeliveryBranch(deliveredTarget);
      const m = materializeMandrelDelivery(
        {
          gitFn,
          workspacePath: handle.workspacePath,
          baselineSha,
          deliveryBranch,
        },
        logger,
      );
      delivered = m.delivered;
      landed = m.landed;
    }

    // Resolve the cohort directory up front (model id + framework version are
    // both known once the session returns), so every per-run artifact — `.raw/`
    // provenance, the store, and the Markdown report — lands under this run's
    // cohort directory `<resultsDir>/<model-slug>/<frameworkVersion>/` rather
    // than the flat root.
    const modelId = resolveModelId(session.envelope, model);
    const cohortDirPath = cohortDir({
      resultsDir,
      scorecard: { model: { id: modelId }, frameworkVersion },
    });

    // Discover + copy out the lifecycle ledger before teardown.
    let lifecycle = [];
    const signals = [];
    let rawRefs;
    // Standalone-path telemetry (Story #48), filled when the mandrel arm routed
    // through the single-Story path (no Epic ledger) and its GitHub Story was
    // recovered. Stays null for the control arm and for Epic-routed cells.
    let standalone = null;
    const rawDir = path.join(cohortDirPath, '.raw');
    // idStampForRaw was resolved before the session (the plan snapshot needs it).
    if (isMandrelArm(arm)) {
      const found = discoverLedger(
        { workspacePath: handle.workspacePath },
        deps.discoverDeps,
      );
      if (found) {
        const dest = path.join(rawDir, idStampForRaw);
        mkdir(dest);
        const lifeOut = path.join(dest, 'lifecycle.ndjson');
        cp(found.lifecyclePath, lifeOut, { recursive: false });
        const signalsOut = [];
        for (let i = 0; i < found.signalsPaths.length; i += 1) {
          const so = path.join(dest, `signals-${i}.ndjson`);
          cp(found.signalsPaths[i], so, { recursive: false });
          signalsOut.push(so);
        }
        lifecycle = parseNdjson(
          (deps.readFileImpl ?? readFileSync)(lifeOut, 'utf8'),
        );
        for (const sp of signalsOut) {
          for (const r of parseNdjson(
            (deps.readFileImpl ?? readFileSync)(sp, 'utf8'),
          )) {
            signals.push(r);
          }
        }
        rawRefs = { lifecycleNdjson: lifeOut, signalsNdjson: signalsOut };
      } else {
        // No Epic ledger — Mandrel routed this cell through the standalone
        // single-Story path. Recover planning + autonomy from the Story's
        // GitHub telemetry (Story #48) so the value dims are MEASURED, not null.
        const ghJson = deps.ghJson ?? defaultGhJson;
        if (effectiveRouting === 'multi-story') {
          // Decomposition-scoped v2 cell: aggregate across every sibling Story
          // the plan opened. Reusing the `standalone` slot is deliberate — the
          // normalize layer already reads `standalone.routingVerdict`, so the
          // aggregate flows through the existing measured-value path and
          // reports `multi-story` against the scenario's routing contract.
          let storyNumbers = [];
          try {
            storyNumbers = discoverStories(
              {
                owner: sandbox.owner,
                repo: sandbox.repo,
                sinceIso: runStartedAt,
              },
              { ghJson },
            );
          } catch (err) {
            logger?.warn?.(
              `[run] multi-Story discovery failed: ${err?.message ?? err}`,
            );
          }
          if (storyNumbers.length > 0) {
            standalone = collectMultiStoryTelemetry(
              { owner: sandbox.owner, repo: sandbox.repo, storyNumbers },
              { ghJson },
            );
            const unreadable = standalone?.unreadableStoryCount ?? 0;
            logger?.info?.(
              `[run] recovered multi-Story telemetry from ${storyNumbers.length} Stories ` +
                `(#${storyNumbers.join(', #')}) (routing=multi-story)` +
                (unreadable > 0 ? ` — ${unreadable} unreadable` : ''),
            );
          } else {
            logger?.warn?.(
              '[run] no Stories found for the multi-story-routed mandrel arm',
            );
          }
        } else {
          let storyNumber = null;
          try {
            storyNumber = discoverStandaloneStory(
              {
                owner: sandbox.owner,
                repo: sandbox.repo,
                sinceIso: runStartedAt,
              },
              { ghJson },
            );
          } catch (err) {
            logger?.warn?.(
              `[run] standalone Story discovery failed: ${err?.message ?? err}`,
            );
          }
          if (storyNumber != null) {
            standalone = collectStandaloneTelemetry(
              { owner: sandbox.owner, repo: sandbox.repo, storyNumber },
              { ghJson },
            );
            logger?.info?.(
              `[run] no Epic ledger — recovered standalone telemetry from Story #${storyNumber} (routing=story)`,
            );
          } else {
            logger?.warn?.(
              '[run] no Epic ledger and no standalone Story found for the mandrel arm',
            );
          }
        }
      }
    }

    // Persist the cost envelope for provenance.
    const dest = path.join(rawDir, idStampForRaw);
    mkdir(dest);
    const envelopePath = path.join(dest, 'cost-envelope.json');
    writeFile(
      envelopePath,
      `${JSON.stringify(session.envelope.raw ?? session.envelope, null, 2)}\n`,
    );
    rawRefs = { ...(rawRefs ?? {}), costEnvelope: envelopePath };

    // Score Quality by bringing up the delivered app and probing it — UNLESS the
    // mandrel delivery didn't materialize, in which case there is no app in the
    // empty seed tree: score quality as unmeasured (null), never a false 0.
    const quality = !delivered
      ? { measured: false }
      : await withRunningAppFn(
          { workspacePath: handle.workspacePath, app: scenario.app },
          async (baseUrl, appInfo) => {
            // Thread the app-runner's real `restart` into the frozen oracle so a
            // persistence criterion can test survival across an actual server
            // restart (Ticket #122, item 5).
            const restart = appInfo?.restart;
            if (isMandrelArm(arm)) {
              const r = await scoreQualityFn({
                evaluate,
                baseUrl,
                storyId: 1,
                epicId: scenario.epicId ?? null,
                transport: 'in-process',
                evaluateDeps: { restart },
              });
              return qualityInputs({
                frozen: r.frozen,
                crossCheckDecision: r.crossCheck?.decision ?? null,
              });
            }
            const frozen = await evaluate(baseUrl, { restart });
            return qualityInputs({ frozen, crossCheckDecision: null });
          },
          deps.appRunnerDeps,
        );

    // Collect maintainability and security sub-signals from the materialized
    // workspace tree. Both arms are measured identically so the comparison is
    // fair. Failures are best-effort: a collector error must not abort the run;
    // the dimension simply defaults to 0 (conservative).
    let maintainabilitySignals = {};
    try {
      maintainabilitySignals = collectMaintainabilityFn(
        handle.workspacePath,
        deps.collectMaintainabilityPorts,
      );
    } catch (err) {
      logger?.warn?.(
        `[run] maintainability collector failed (scoring 0): ${err?.message ?? err}`,
      );
    }

    let securitySignals = {};
    try {
      securitySignals = collectSecurityFn(
        handle.workspacePath,
        deps.collectSecurityPorts,
      );
    } catch (err) {
      logger?.warn?.(
        `[run] security collector failed (scoring 0): ${err?.message ?? err}`,
      );
    }

    // Multi-class differential trap signal (Epic #66, Story #74 — replaces
    // the single-oracle Story #57 mechanic). When the scenario declares one
    // or more trap classes under traps/<class>.js, the runner source-scans
    // the delivered tree for each planted defect and aggregates the
    // per-class verdicts. This is SEPARATE from the frozen Quality suite: it
    // is the differential axis a behavioural suite cannot see. Both arms are
    // scanned identically so the comparison is fair. Best-effort: a runner
    // error leaves the trap block off the scorecard rather than aborting the
    // run — a missing trap signal is conservative (no false delta).
    let trap = null;
    // Skip the trap scan on an unmaterialized delivery: an empty seed tree has
    // no planted defect to find, so the oracle would read a false cleanRate=1
    // (looks like a clean pass when nothing was delivered) and pollute the trap
    // axis. Leaving `trap` null excludes the cell from the trap differential.
    if (
      delivered &&
      typeof scenarioDir === 'string' &&
      scenarioDir.length > 0
    ) {
      try {
        const verdict = await runTrapOraclesFn(
          { scenarioDir, deliveredTreePath: handle.workspacePath },
          deps.trapRunnerDeps,
        );
        if (verdict.classes.length > 0) trap = verdict;
      } catch (err) {
        logger?.warn?.(
          `[run] trap-runner failed (no trap signal recorded): ${err?.message ?? err}`,
        );
      }
    }

    // Run the single batched LLM-judge cross-check for both new dimensions.
    // The judge is enabled for both arms so the comparison is fair. A null
    // result (judge disabled / transport error) folds the 0.3 judge weight
    // into the objective spine — the dimension is still populated.
    let judgeScores = null;
    // Skip the judge `claude -p` entirely when the delivery didn't land — there
    // is nothing to judge in the empty seed tree, and maintainability/security
    // are already forced to null below.
    try {
      if (delivered) {
        // Feed the judge a bounded excerpt of the delivered source (Ticket #122,
        // item 4) so it has an INDEPENDENT observation instead of re-scoring the
        // spine's own sub-signal JSON. Best-effort: an unreadable tree yields an
        // empty excerpt (the judge prompt simply omits the section).
        let sourceExcerpt = '';
        try {
          sourceExcerpt = collectSourceExcerptFn(
            handle.workspacePath,
            deps.collectSourceExcerptPorts,
          );
        } catch (err) {
          logger?.warn?.(
            `[run] source-excerpt collection failed (judge runs without it): ${err?.message ?? err}`,
          );
        }
        judgeScores = await runDimensionJudgeFn(
          { maintainabilitySignals, securitySignals, sourceExcerpt },
          deps.dimensionJudgeDeps,
        );
      }
    } catch (err) {
      // A transient infra failure (rate/session limit, overload, network) must
      // ABORT the cell so a resume redoes it — never bake a blip into a
      // "complete" scorecard. A genuine null (judge abstained) degrades below.
      rethrowIfTransientClaudeError(err);
      logger?.warn?.(
        `[run] dimension judge failed (judge weight folded into spine): ${err?.message ?? err}`,
      );
    }

    // An unmaterialized delivery has no code to analyse: mark maintainability +
    // security unmeasured (null) too, so they don't score a conservative 0 on
    // the empty seed tree and drag the mandrel arm down — same guard as quality.
    const maintainabilityInputs = !delivered
      ? { measured: false }
      : {
          objectiveMaintainabilityScore:
            maintainabilitySignals.objectiveMaintainabilityScore ?? null,
          maintainabilityJudgeScore: judgeScores?.maintainability ?? null,
          lintWarnings: maintainabilitySignals.lintErrorCount ?? 0,
          complexityScore: maintainabilitySignals.complexityScore ?? null,
          maintainabilityIndex: null,
        };

    const securityInputs = !delivered
      ? { measured: false }
      : derivedSecurityInputs(
          securitySignals,
          judgeScores,
          scenarioApplicableMusts(scenario),
        );

    // The second touch (Epic #86, Story #96). AFTER touch 1 is scored, run the
    // scenario's frozen change request as a fresh session against the delivered
    // tree (arm-appropriate inheritance) and score its continuity outcome/cost.
    // Skipped for a scenario with no `changeRequest` (e.g. hello-world). Best-
    // effort: a touch-2 failure leaves the block off the scorecard rather than
    // aborting the touch-1 record.
    //
    // BENCH_SKIP_TOUCH2 (diagnostic): an explicit operator opt-out that skips
    // the change-request touch for THIS invocation — for cheap touch-1-only
    // verification runs (e.g. the Gate G0 delivery-materialization repro,
    // docs/07-12-2026-analysis.md Phase 1 progress log) where touch-2 would
    // double the spend without informing the question. The scorecard simply
    // omits the `touch2` block, exactly as for a scenario with no
    // `changeRequest`; continuity for the cell is unmeasured, not failed.
    let touch2 = null;
    if (skipTouch2 && scenario?.changeRequest) {
      logger?.info?.(
        '[run] touch2: skipped via BENCH_SKIP_TOUCH2 (diagnostic touch-1-only run) — continuity unmeasured for this cell.',
      );
    }
    if (
      !skipTouch2 &&
      scenario?.changeRequest &&
      typeof touch2Evaluate === 'function'
    ) {
      try {
        touch2 = await runTouch2(
          {
            scenario,
            touch2Evaluate,
            scenarioDir,
            arm,
            runIndex,
            model,
            sandbox,
            handle,
            frameworkVersion,
            benchmarkVersion,
            env,
            timeoutMs,
            // Persist the touch-2 delivery's raw telemetry here before teardown
            // (Ticket #121, item 4).
            touch2RawDir: path.join(rawDir, idStampForRaw, 'touch2'),
          },
          deps,
        );
      } catch (err) {
        // Transient infra failure → abort the cell for a clean resume; a
        // genuine touch-2 failure (delivered app broken) degrades below.
        rethrowIfTransientClaudeError(err);
        logger?.warn?.(
          `[run] touch2 failed (no touch2 block recorded): ${err?.message ?? err}`,
        );
      }
    }

    const run = buildRunIdentity({
      scenario: scenario.id,
      arm,
      runIndex,
      timestamp: nowIso(),
      modelId,
      frameworkVersion,
      benchmarkVersion,
      env,
    });

    // Intrinsic PLAN-QUALITY axis (Epic #86, Story #95; D-019). MANDREL arm
    // ONLY: score the plan the /plan session authored — captured as
    // `planSnapshot` between the two phase sessions — against the scenario's
    // frozen spec. The control arm authors no plan, so its plan-quality is null
    // and the axis is excluded from the differential. A null snapshot (plan
    // discovery/snapshot failed) leaves the axis absent, exactly the shape the
    // renderer's attribution table already tolerates. The attribution decision
    // table itself is attached downstream by `buildScorecard`, which crosses
    // this score with the delivered dimensions it computes.
    const planQuality = isMandrelArm(arm)
      ? buildPlanQualityBlock(
          {
            snapshot: planSnapshot,
            scenario,
            trapClasses: Array.isArray(trap?.classes)
              ? trap.classes.map((c) => c.class)
              : [],
            judgeScore: null,
          },
          { readFileImpl: deps.readFileImpl },
        )
      : null;

    const scorecard = buildScorecard({
      run,
      lifecycle,
      signals,
      envelope: session.envelope,
      quality,
      planning: isMandrelArm(arm) ? planningInputs(lifecycle) : {},
      maintainabilityInputs,
      securityInputs,
      trap,
      // Per-phase session envelopes (D-019): the mandrel arm's ordered
      // /plan + /deliver sessions each carry their own cost/tokens/wall-clock,
      // summing to the run totals. `session.phases` is null for the control arm.
      phases: session.phases ?? null,
      touch2,
      // Intrinsic plan-quality axis (D-019, Story #95); mandrel-only, null for
      // the control arm and when no plan snapshot was captured.
      planQuality,
      rawRefs,
      standalone,
      scenarioRouting:
        typeof scenario?.routing === 'string' ? scenario.routing : null,
      // Loud autonomy marker: the mandrel /deliver produced NOTHING scoreable —
      // neither a merged main nor a PR-head branch (distinct from a
      // delivered-but-broken app, and distinct from an unlanded-but-scored
      // PR-head tree, which now scores normally with landed:false).
      deliveryNotMaterialized: isMandrelArm(arm) && !delivered,
      // Landing datum (Ticket #121, item 1): true = PR merged onto main; false =
      // an unlanded PR-head tree was scored; null = control / undetermined. Feeds
      // the autonomy dimension as unattended-landing.
      landed: isMandrelArm(arm) ? landed : null,
    });
    return scorecard;
  } finally {
    // Primary post-run cleanup: rewind the sandbox repo's `main` back to the
    // clean baseline so the next run starts from a pristine tree. Best-effort:
    // a reset failure must not mask the run's own result or break teardown.
    try {
      resetSandbox(
        {
          owner: sandbox.owner,
          repo: sandbox.repo,
          baselineRef,
          sha: baselineSha,
        },
        { ghFn: deps.ghApiFn, logger },
      );
    } catch (err) {
      logger?.warn?.(
        `[run] post-run baseline reset failed: ${err?.message ?? err}`,
      );
    }
    teardown(handle, deps.teardownDeps);
  }
}

/**
 * Run the benchmark over `N × scenarios × arms`, persist every scorecard to the
 * append-only store, and render a value-add report.
 *
 * @param {object} opts
 * @param {string[]} [opts.scenarios=['hello-world']]
 * @param {Array<'mandrel'|'control'>} [opts.arms=['mandrel','control']]
 * @param {number} [opts.n]   Explicit operator override for the run count,
 *   applied uniformly to EVERY scenario in this batch. When omitted (the
 *   default), each scenario's own `scenario.targetN` (its declared per-rung
 *   sizing contract — `scenario.json`'s `targetN`, e.g. 4 for hello-world, 8
 *   for story-scope/epic-scope) is used instead, falling back to 1 for a
 *   scenario that declares none (Epic #66 audit remediation, H1 — `targetN`
 *   was previously declared in every scenario contract but never read by the
 *   runtime, so a multi-scenario batch with no explicit override silently
 *   applied one global N to every rung regardless of its declared contract).
 * @param {string} [opts.model]
 * @param {{ repoUrl: string, owner: string, repo: string, baselineRef?: string }} opts.sandbox
 *   Sandbox repo coordinates. `baselineRef` (default `'bench-baseline'`) is the
 *   clean baseline branch `main` is reset to before/after each run.
 * @param {string} [opts.resultsDir]
 * @param {string} [opts.ephemeralRoot]
 * @param {number} [opts.maxRuns]   Run-count ceiling: stop cleanly after this
 *   many cells complete in this invocation (resumable cells skipped on resume do
 *   NOT count). Omit / `null` for no run-count ceiling.
 * @param {number} [opts.maxCostUsd]   Cost ceiling in USD: stop cleanly once the
 *   accumulated `dimensions.efficiency.costUsd` of this invocation's completed
 *   cells reaches it. The check fires AFTER the in-flight cell persists, so the loop
 *   stops between cells and never abandons a partial scorecard. Omit / `null`
 *   for no cost ceiling.
 * @param {string} [opts.checkpointPath]   Override the resume-checkpoint path.
 *   Defaults to `<resultsDir>/.batch-checkpoint.ndjson`.
 * @param {object} [deps]
 * @returns {Promise<{ scorecards: object[], cohorts: Array<{ dir: string, storePath: string, reportPath: string, report: string }>, dashboardPath: string, dashboard: string, skipped: number, stopped: null | { reason: 'maxRuns' | 'maxCostUsd', completed: number, costUsd: number } }>}
 */
export async function runFirstBenchmark(opts = {}, deps = {}) {
  const {
    scenarios = ['hello-world'],
    arms = ['mandrel', 'control'],
    n: nOverride,
    model = DEFAULT_BENCH_MODEL,
    sandbox,
    resultsDir = path.join(repoRoot(), 'results'),
    ephemeralRoot,
    maxRuns = null,
    maxCostUsd = null,
  } = opts;

  if (!sandbox?.repoUrl || !sandbox?.owner || !sandbox?.repo) {
    throw new TypeError(
      'runFirstBenchmark requires sandbox { repoUrl, owner, repo }',
    );
  }

  const logger = deps.logger;
  const writeFile = deps.writeFileFn ?? writeFileSync;
  const mkdir = deps.mkdirFn ?? ((p) => mkdirSync(p, { recursive: true }));

  // Per-scenario seed Epic ids (in the SANDBOX repo) for the mandrel arm's
  // drive-from-Epic-id path. Keyed by scenario id; the control arm ignores it.
  const epicIds = opts.epicIds ?? {};

  // Resume substrate: the checkpoint ledger records every completed cell so a
  // crashed / ceiling-stopped batch resumes without re-running or duplicating a
  // cell's scorecard. Read the already-done set ONCE up front.
  const checkpointPath =
    opts.checkpointPath ?? path.join(resultsDir, CHECKPOINT_FILENAME);
  const doneCells = readCheckpoint({ checkpointPath }, deps.checkpointDeps);

  const scorecards = [];
  let skipped = 0;
  let completed = 0;
  let costUsd = 0;
  let stopped = null;

  // The append-only store + per-run report + checkpoint are written PER CELL as
  // it completes, so an interrupted batch (crash or ceiling stop) always leaves a
  // consistent on-disk state: every persisted scorecard has a matching checkpoint
  // entry, and no half-written cell is left behind.
  const cohortReportCards = new Map();

  const persistCell = (scorecard, cell) => {
    const dir = cohortDir({ resultsDir, scorecard });
    const storePath = path.join(dir, 'scorecards.ndjson');
    // Append the scorecard FIRST, then the checkpoint — so a crash between the
    // two re-runs the cell (harmless duplicate the reader de-dups by runId)
    // rather than skipping an un-persisted cell (lost work). The scorecard is
    // persisted UNMUTATED (no `runIndex` field added) so the schema is unchanged
    // — the cell key lives only in the separate checkpoint ledger.
    appendScorecards({ storePath, scorecards: [scorecard] }, deps.persistDeps);
    appendCheckpoint({ checkpointPath, cell }, deps.checkpointDeps);
    if (!cohortReportCards.has(dir)) cohortReportCards.set(dir, []);
    cohortReportCards.get(dir).push(scorecard);
  };

  outer: for (const scenarioId of scenarios) {
    const { scenario, evaluate, scenarioDir, touch2Evaluate, touches } =
      await loadScenario(scenarioId, deps.loadDeps);
    if (epicIds[scenarioId] != null) scenario.epicId = epicIds[scenarioId];
    // Per-scenario run count (H1): an explicit operator override
    // (`opts.n`/`BENCH_N`) applies uniformly to every scenario; absent that,
    // each scenario's own declared `targetN` sizing contract governs, so a
    // mixed-scenario batch gets the right cell count per rung without the
    // operator having to split invocations manually.
    const n =
      typeof nOverride === 'number' && Number.isFinite(nOverride)
        ? nOverride
        : typeof scenario.targetN === 'number' &&
            Number.isFinite(scenario.targetN)
          ? scenario.targetN
          : 1;
    for (let runIndex = 1; runIndex <= n; runIndex += 1) {
      for (const arm of arms) {
        const cell = cellKey({ scenario: scenarioId, arm, runIndex });
        if (doneCells.has(cell)) {
          skipped += 1;
          logger?.info?.(
            `[run] ⏭️  resume: skip completed ${scenarioId} / ${arm} / run ${runIndex}/${n}`,
          );
          continue;
        }
        logger?.info?.(
          `[run] === ${scenarioId} / ${arm} / run ${runIndex}/${n} ===`,
        );
        const scorecard = await runOneRun(
          {
            scenario,
            evaluate,
            scenarioDir,
            touch2Evaluate,
            touches,
            arm,
            runIndex,
            model,
            sandbox,
            resultsDir,
            ephemeralRoot,
            skipTouch2: opts.skipTouch2 === true,
          },
          deps,
        );
        scorecards.push(scorecard);
        // Persist + checkpoint the in-flight cell BEFORE evaluating the ceiling,
        // so a ceiling stop never abandons a partial / un-checkpointed cell.
        persistCell(scorecard, cell);
        completed += 1;
        // Invocation-cost accounting (audit H2, extended for touch chains):
        // a change-request cell folds `efficiency.costUsd` + `touch2.cost`;
        // a chain cell sums EVERY `chain.touches[].cost` instead (its
        // record-level efficiency.costUsd is a per-touch MEAN, so adding it
        // would double-count) — see `cellCostUsd` in bench/run-chain.js.
        costUsd += cellCostUsd(scorecard);

        // Ceiling check fires AFTER the cell is fully persisted + checkpointed,
        // so the loop stops cleanly between cells.
        if (maxRuns != null && completed >= maxRuns) {
          stopped = { reason: 'maxRuns', completed, costUsd };
          logger?.info?.(
            `[run] 🛑 run-count ceiling reached (${completed}/${maxRuns}); stopping after the in-flight run. Resume to continue.`,
          );
          break outer;
        }
        if (maxCostUsd != null && costUsd >= maxCostUsd) {
          stopped = { reason: 'maxCostUsd', completed, costUsd };
          logger?.info?.(
            `[run] 🛑 cost ceiling reached ($${costUsd.toFixed(2)}/$${Number(maxCostUsd).toFixed(2)}); stopping after the in-flight run. Resume to continue.`,
          );
          break outer;
        }
      }
    }
  }

  // Render over the FULL on-disk cohort store, NOT just this run's cards. A
  // resumed batch only produces the cells it actually re-ran (the rest are
  // skipped from the checkpoint), so rendering the run's cards alone
  // under-counts every resumed cell — a resumed N=8 that re-ran 5 cells would
  // report n=5 instead of the true n=8. The render logic is shared with the
  // standalone aggregate CLI via bench/report/render-tree.js (Story #90).
  const cohorts = [];
  for (const [dir, cohortCards] of cohortReportCards) {
    const stamp = sanitizeRunId(cohortCards[0]?.timestamp ?? `${Date.now()}`);
    cohorts.push(
      renderCohortReport(
        { cohortDir: dir, stamp, method: 'iqr' },
        {
          readStoreDeps: deps.persistDeps,
          writeFileImpl: writeFile,
          mkdirImpl: mkdir,
        },
      ),
    );
  }

  // Regenerate the aggregate dashboard from the FULL corpus across every cohort
  // (not just this run's scorecards) so `results.html` always reflects the whole
  // longitudinal history on disk.
  const { dashboardPath, dashboard } = renderDashboardFile(
    { resultsDir },
    {
      aggregateDeps: deps.aggregateDeps,
      writeFileImpl: writeFile,
      mkdirImpl: mkdir,
    },
  );

  return { scorecards, cohorts, dashboardPath, dashboard, skipped, stopped };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Normalize a scenario id into the `BENCH_EPIC_ID_<SCENARIO>` env-var suffix:
 * uppercased, every run of non `[A-Z0-9]` characters folded to a single `_`.
 * So `story-scope` → `STORY_SCOPE`, read as `BENCH_EPIC_ID_STORY_SCOPE`. Pure.
 *
 * @param {string} scenarioId
 * @returns {string}
 */
export function scenarioEnvSuffix(scenarioId) {
  return String(scenarioId)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Resolve the per-scenario seed Epic-id map from the environment, threading them
 * into `runFirstBenchmark`'s `epicIds` map. Three sources, lowest-to-highest
 * precedence:
 *   1. `BENCH_EPIC_ID` — back-compat single-scenario id, applied to `scenarios[0]`.
 *   2. `BENCH_EPIC_IDS` — a JSON object map `{ "<scenario>": <id>, ... }`.
 *   3. `BENCH_EPIC_ID_<SCENARIO>` — one var per scenario (see `scenarioEnvSuffix`),
 *      e.g. `BENCH_EPIC_ID_STORY_SCOPE`.
 * Later sources override earlier ones for the same scenario. Only ids that parse
 * to a finite number are kept. Pure (reads from the supplied `env` bag).
 *
 * @param {string[]} scenarios
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {Record<string, number>}
 */
export function resolveEpicIds(scenarios, env = process.env) {
  const epicIds = {};
  const setIf = (scenario, raw) => {
    if (raw == null || String(raw).trim() === '') return;
    const num = Number(raw);
    if (Number.isFinite(num)) epicIds[scenario] = num;
  };
  // 1. Single-scenario back-compat: BENCH_EPIC_ID → scenarios[0].
  if (env.BENCH_EPIC_ID != null && scenarios.length > 0) {
    setIf(scenarios[0], env.BENCH_EPIC_ID);
  }
  // 2. JSON map: BENCH_EPIC_IDS = {"hello-world":99,"story-scope":100}.
  if (env.BENCH_EPIC_IDS) {
    try {
      const parsed = JSON.parse(env.BENCH_EPIC_IDS);
      if (parsed && typeof parsed === 'object') {
        for (const [scenario, raw] of Object.entries(parsed)) {
          setIf(scenario, raw);
        }
      }
    } catch {
      // Malformed JSON is ignored — the per-var form below still applies, and a
      // missing seed Epic falls back to the un-flagged ideation path per scenario.
    }
  }
  // 3. Per-scenario vars: BENCH_EPIC_ID_<SCENARIO> (highest precedence).
  for (const scenario of scenarios) {
    setIf(scenario, env[`BENCH_EPIC_ID_${scenarioEnvSuffix(scenario)}`]);
  }
  return epicIds;
}

/**
 * The two required environment variables for the ephemeral per-cell sandbox
 * lifecycle (Story #71 / docs/target-architecture.md §5). Auth/config
 * collapses to these two: `BENCH_GITHUB_TOKEN` (create/delete + contents +
 * issues + pull-requests scoped token) and `BENCH_SANDBOX_OWNER` (the
 * account/org ephemeral repos are created under).
 */
export const REQUIRED_SANDBOX_ENV_VARS = Object.freeze([
  'BENCH_GITHUB_TOKEN',
  'BENCH_SANDBOX_OWNER',
]);

/**
 * Fail-fast validation for the two required sandbox env vars. Pure — reads
 * only from the supplied `env` bag, never `process.env` directly, so it is
 * unit-testable with injected env. Called at CLI-entry startup, BEFORE any
 * model invocation or sandbox provisioning, per the Story #71 binding
 * contract: a missing var must abort before any cost is spent.
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateSandboxEnv(env = process.env) {
  for (const name of REQUIRED_SANDBOX_ENV_VARS) {
    const v = env[name];
    if (typeof v !== 'string' || v.trim() === '') {
      return {
        ok: false,
        message: `[run] FATAL: missing required environment variable ${name}. Set BENCH_GITHUB_TOKEN and BENCH_SANDBOX_OWNER before running the benchmark (see .env.example).`,
      };
    }
  }
  return { ok: true };
}

/**
 * Best-effort janitor sweep run at the start of every `main()` invocation,
 * BEFORE this invocation's own cells are provisioned, so a prior crashed
 * run's leaked `bench-sbx-*` repo is swept before we add another one
 * (Story #72). A sweep failure (e.g. a transient `gh repo list` error) must
 * never abort the benchmark run itself — it logs and the run proceeds.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} owner
 * @param {{ logger: object, sweepJanitorFn?: Function, janitorGhFn?: Function }} deps
 */
function runJanitorSweep(env, owner, deps) {
  const { logger } = deps;
  const sweepJanitorFn = deps.sweepJanitorFn ?? sweepLeakedRepos;
  try {
    sweepJanitorFn(
      {
        owner,
        ttlHours:
          env.BENCH_JANITOR_TTL_HOURS != null
            ? Number(env.BENCH_JANITOR_TTL_HOURS)
            : DEFAULT_TTL_HOURS,
      },
      { logger, ghFn: deps.janitorGhFn },
    );
  } catch (err) {
    logger.warn(
      `[run] janitor sweep failed (continuing): ${err?.message ?? err}`,
    );
  }
}

/**
 * Ephemeral sandbox lifecycle (Story #71, restructured under Epic #65 audit
 * remediation — the critical defect this remediation exists to fix):
 * create → seed → run(N serial) → destroy runs ONCE PER (scenario × arm)
 * CELL, not once for the whole invocation. Each cell gets its own private
 * `bench-sbx-*` repo, seeded from `bench/sandbox-template/`, used for that
 * cell's N serial runs, and destroyed once those runs complete — replacing
 * the retired standing external sandbox repo (docs/decisions.md D-013) and
 * matching docs/target-architecture.md §5.2's per-cell lifecycle (the
 * previous implementation provisioned a single shared repo for the entire
 * invocation, contradicting that design and silently defeating cell-level
 * parallelism). This cell's create-through-destroy sequence is scoped in
 * its own try/finally, so ANY failure after this cell's repo is
 * created — including a seed failure — still best-effort destroys this
 * cell's repo before the error propagates; a failed destroy itself is
 * best-effort too, logging and deferring to the janitor sweep rather than
 * masking the cell's own result.
 *
 * @param {{ scenarioId: string, arm: string, ctx: object, deps: object }} args
 *   `ctx` carries the invocation-wide, cross-cell state this cell needs to
 *   read (owner, cohort, ephemeralRoot, n, epicIds, resultsDir,
 *   checkpointPath, completedTotal, costTotal, maxRuns, maxCostUsd) — none
 *   of it is mutated in place; the caller folds the returned cell result
 *   into its own running totals.
 * @returns {Promise<{ cellResult: object, created: { repoFullName: string } }>}
 */
/**
 * Real production transport for the Maintainability/Security LLM judge.
 *
 * The dimension-judge-adapter ships a no-op `defaultJudgeTransport` (returns
 * null) and documents that "the production harness wires a real LLM transport
 * here" — but nothing did, so every real run recorded
 * `maintainability-judge-absent` / `security-judge-absent` and both dimensions
 * silently collapsed to spine-only. This factory IS that wiring: it shells one
 * additional `claude -p --output-format json` completion with the batched judge
 * prompt and returns the model's raw text answer for `parseJudgeResponse`.
 *
 * It runs in a neutral temp dir (no project files → a clean completion, not an
 * agentic session over the delivered tree) and degrades to `null` on any
 * non-zero exit or parse failure, so a judge hiccup simply folds the 0.3 judge
 * weight back into the objective spine — it never fails the run.
 *
 * @param {object} [args]
 * @param {string} [args.model=DEFAULT_BENCH_MODEL]  Same pinned model as the run.
 * @param {(input: object) => { status: number, stdout: string, stderr: string }} [args.invokeFn]
 *   Injected `claude -p` invoker (defaults to the real one; tests never reach
 *   here because they inject `dimensionJudgeDeps` / `runDimensionJudgeFn`).
 * @param {{ warn?: Function }} [args.logger]
 * @returns {(prompt: string) => Promise<string|null>}
 */
export function makeClaudeJudgeTransport({
  model = DEFAULT_BENCH_MODEL,
  invokeFn = defaultInvokeClaudeSession,
  logger,
} = {}) {
  return async (prompt) => {
    try {
      const { status, stdout, stderr } = invokeFn({
        prompt,
        model,
        cwd: tmpdir(),
        timeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
      });
      if (status !== 0) {
        logger?.warn?.(
          `[run] dimension judge: claude -p exited ${status} — judge folded into spine: ${
            stderr || '<no stderr>'
          }`,
        );
        return null;
      }
      return parseSessionEnvelope(stdout).result ?? null;
    } catch (err) {
      logger?.warn?.(
        `[run] dimension judge transport failed — judge folded into spine: ${
          err?.message ?? err
        }`,
      );
      return null;
    }
  };
}

async function runCell({ scenarioId, arm, ctx, deps }) {
  const { logger } = deps;
  const createEphemeralRepoFn =
    deps.createEphemeralRepoFn ?? createEphemeralRepo;
  const seedFromTemplateFn = deps.seedFromTemplateFn ?? seedFromTemplate;
  const destroyEphemeralRepoFn =
    deps.destroyEphemeralRepoFn ?? destroyEphemeralRepo;
  const mkdtempFn = deps.mkdtempFn ?? mkdtempSync;
  const rmFn = deps.rmFn ?? rmSync;
  const runFirstBenchmarkFn = deps.runFirstBenchmarkFn ?? runFirstBenchmark;

  const {
    owner,
    cohort,
    ephemeralRoot,
    n,
    epicIds,
    resultsDir,
    checkpointPath,
    completedTotal,
    costTotal,
    maxRuns,
    maxCostUsd,
    skipTouch2,
  } = ctx;

  const nonce = randomBytes(4).toString('hex');
  const repoName = sandboxRepoName({
    cohort,
    scenario: scenarioId,
    arm,
    nonce,
  });
  const created = createEphemeralRepoFn({ owner, name: repoName }, { logger });
  try {
    const seedDir = mkdtempFn(path.join(ephemeralRoot, SANDBOX_DIR_PREFIX));
    let seeded;
    try {
      seeded = seedFromTemplateFn(
        { repoFullName: created.repoFullName, workspacePath: seedDir },
        { logger },
      );
    } finally {
      try {
        rmFn(seedDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(
          `[run] could not clean up the local seed workspace ${seedDir}: ${err?.message ?? err}`,
        );
      }
    }

    const cellSandbox = {
      repoUrl: seeded.repoUrl,
      owner,
      repo: repoName,
      repoFullName: created.repoFullName,
      baselineSha: seeded.baselineSha,
    };

    const cellOpts = {
      sandbox: cellSandbox,
      scenarios: [scenarioId],
      arms: [arm],
      n,
      epicIds,
      resultsDir,
      checkpointPath,
      ...(maxRuns != null
        ? { maxRuns: Math.max(0, maxRuns - completedTotal) }
        : {}),
      ...(maxCostUsd != null
        ? { maxCostUsd: Math.max(0, maxCostUsd - costTotal) }
        : {}),
      ...(skipTouch2 === true ? { skipTouch2: true } : {}),
    };

    const cellResult = await runFirstBenchmarkFn(cellOpts, {
      logger,
      // Wire the real LLM-judge transport (the adapter's no-op default's
      // long-missing production caller). runFirstBenchmark forwards `deps`
      // to runOneRun and runTouch2, so both touches get the judge; tests call
      // those functions directly with their own deps and never hit this.
      dimensionJudgeDeps: {
        judgeTransport: makeClaudeJudgeTransport({ logger }),
      },
    });
    return { cellResult, created };
  } finally {
    // Best-effort: a failed delete must never abort/mask the cell's own
    // result — it logs and defers to the janitor sweep (sibling Story).
    destroyEphemeralRepoFn({ repoFullName: created.repoFullName }, { logger });
  }
}

/**
 * Formats and writes the final operator-facing stderr summary/dashboard
 * line for a completed (or early-stopped) `main()` invocation.
 *
 * @param {object} result
 */
function reportRunResult(result) {
  const cohortLines = result.cohorts
    .map(
      (c) => `[run]   store → ${c.storePath}\n[run]   report → ${c.reportPath}`,
    )
    .join('\n');
  const stoppedLine = result.stopped
    ? `[run] 🛑 stopped early (${result.stopped.reason}); resume to continue the batch.\n`
    : '';
  process.stderr.write(
    `\n[run] ${result.scorecards.length} scorecard(s) across ${result.cohorts.length} cohort(s)` +
      ` (${result.skipped} cell(s) skipped on resume):\n` +
      `${cohortLines}\n` +
      stoppedLine +
      `[run] dashboard → ${result.dashboardPath}\n`,
  );
}

/**
 * Minimal CLI entry. Sandbox coordinates are the ephemeral per-cell lifecycle
 * (Story #71): auth/config collapses to two env vars —
 *   BENCH_GITHUB_TOKEN (required) — token with repo create/delete scopes.
 *   BENCH_SANDBOX_OWNER (required) — the account/org ephemeral repos are
 *     created under.
 * Optional: BENCH_SCENARIOS (csv), BENCH_ARMS (csv — any of
 *   mandrel|control|control-claudemd|mandrel-story-routed; default
 *   mandrel,control — the Ticket #123 variant arms are opt-in), BENCH_N.
 * Per-scenario seed Epic ids (mandrel arm):
 *   BENCH_EPIC_ID (single-scenario back-compat → scenarios[0]),
 *   BENCH_EPIC_IDS (JSON map keyed by scenario id),
 *   BENCH_EPIC_ID_<SCENARIO> (one var per scenario; see scenarioEnvSuffix).
 * Batch bounds (resumable, cost-bounded loop):
 *   BENCH_MAX_RUNS (run-count ceiling for this invocation),
 *   BENCH_MAX_COST_USD (USD cost ceiling for this invocation),
 *   BENCH_CHECKPOINT (override the resume-checkpoint path).
 * Diagnostics:
 *   BENCH_SKIP_TOUCH2 ('1'/'true' — skip the frozen change-request touch for
 *     this invocation; touch-1-only verification runs. The scorecard omits
 *     the `touch2` block; continuity is unmeasured, not failed).
 *
 * @param {Record<string, string|undefined>} [env=process.env]  Injectable for
 *   tests — exercises the fail-fast / deprecation-warning contract without
 *   mutating real process env.
 * @param {{ logger?: object }} [deps]
 */
export async function main(env = process.env, deps = {}) {
  const logger = deps.logger ?? defaultCliLogger();

  // Fail fast — before any model invocation or sandbox provisioning.
  const validation = validateSandboxEnv(env);
  if (!validation.ok) {
    logger.error(validation.message);
    process.exitCode = 1;
    return;
  }

  const owner = env.BENCH_SANDBOX_OWNER;
  const scenarios = (env.BENCH_SCENARIOS ?? 'hello-world')
    .split(',')
    .map((s) => s.trim());
  const epicIds = resolveEpicIds(scenarios, env);

  // Janitor sweep (Story #72): runs at the start of every invocation, BEFORE
  // this invocation's own cells are provisioned. See runJanitorSweep() for
  // the full rationale.
  runJanitorSweep(env, owner, {
    logger,
    sweepJanitorFn: deps.sweepJanitorFn,
    janitorGhFn: deps.janitorGhFn,
  });

  const cohort = env.BENCH_COHORT ?? new Date().toISOString().slice(0, 10);
  const ephemeralRoot = defaultEphemeralRoot();
  // Validated arm parse (Ticket #123): the default arm set is unchanged
  // (mandrel,control); the arm-3/arm-4 variant cells are OPT-IN via
  // BENCH_ARMS (e.g. `BENCH_ARMS=control,control-claudemd` or
  // `BENCH_ARMS=mandrel,mandrel-story-routed`). An unknown arm name fails
  // fast HERE — before any sandbox is provisioned or cost is spent — because
  // a typo'd arm would otherwise run a mislabelled cell into the cohort.
  let arms;
  try {
    arms = parseBenchArms(env.BENCH_ARMS);
  } catch (err) {
    logger.error(`[run] FATAL: invalid BENCH_ARMS: ${err?.message ?? err}`);
    process.exitCode = 1;
    return;
  }
  // H1: an explicit BENCH_N is an operator override applied uniformly to
  // every scenario; when unset, leave `n` undefined so
  // `runFirstBenchmark`/`runCell` resolve each scenario's own declared
  // `targetN` sizing contract instead of silently defaulting to 1.
  const n = parseOptionalNumericEnv(env.BENCH_N);
  const maxRuns = parseOptionalNumericEnv(env.BENCH_MAX_RUNS) ?? null;
  const maxCostUsd = parseOptionalNumericEnv(env.BENCH_MAX_COST_USD) ?? null;
  // BENCH_SKIP_TOUCH2 (diagnostic): touch-1-only invocation — see runOneRun.
  const skipTouch2 =
    env.BENCH_SKIP_TOUCH2 === '1' || env.BENCH_SKIP_TOUCH2 === 'true';
  const resultsDir = path.join(repoRoot(), 'results');
  const checkpointPath =
    env.BENCH_CHECKPOINT ?? path.join(resultsDir, CHECKPOINT_FILENAME);

  // Aggregated across every cell this invocation provisions, so the final
  // operator summary (and the maxRuns/maxCostUsd ceilings, which are
  // invocation-wide, not per-cell) reflect the WHOLE batch, not just the last
  // cell's `runFirstBenchmarkFn` call.
  const allScorecards = [];
  const cohortsByDir = new Map();
  let totalSkipped = 0;
  let lastDashboardPath = null;
  let lastDashboard = null;
  let completedTotal = 0;
  let costTotal = 0;
  let overallStopped = null;

  cellLoop: for (const scenarioId of scenarios) {
    for (const arm of arms) {
      if (maxRuns != null && completedTotal >= maxRuns) {
        overallStopped = {
          reason: 'maxRuns',
          completed: completedTotal,
          costUsd: costTotal,
        };
        break cellLoop;
      }
      if (maxCostUsd != null && costTotal >= maxCostUsd) {
        overallStopped = {
          reason: 'maxCostUsd',
          completed: completedTotal,
          costUsd: costTotal,
        };
        break cellLoop;
      }

      // See runCell() for the full create → seed → run(N) → destroy
      // per-cell lifecycle and its try/finally teardown guarantee.
      const { cellResult } = await runCell({
        scenarioId,
        arm,
        ctx: {
          owner,
          cohort,
          ephemeralRoot,
          n,
          epicIds,
          resultsDir,
          checkpointPath,
          completedTotal,
          costTotal,
          maxRuns,
          maxCostUsd,
          skipTouch2,
        },
        deps: {
          logger,
          createEphemeralRepoFn: deps.createEphemeralRepoFn,
          seedFromTemplateFn: deps.seedFromTemplateFn,
          destroyEphemeralRepoFn: deps.destroyEphemeralRepoFn,
          mkdtempFn: deps.mkdtempFn,
          rmFn: deps.rmFn,
          runFirstBenchmarkFn: deps.runFirstBenchmarkFn,
        },
      });

      allScorecards.push(...cellResult.scorecards);
      for (const c of cellResult.cohorts) cohortsByDir.set(c.dir, c);
      totalSkipped += cellResult.skipped;
      lastDashboardPath = cellResult.dashboardPath;
      lastDashboard = cellResult.dashboard;
      completedTotal += cellResult.scorecards.length;
      for (const sc of cellResult.scorecards) {
        // Fold in the second-touch / chain-touch session spend too (audit H2,
        // extended for chains) — the same accounting as runFirstBenchmark.
        costTotal += cellCostUsd(sc);
      }
      if (cellResult.stopped) {
        overallStopped = {
          reason: cellResult.stopped.reason,
          completed: completedTotal,
          costUsd: costTotal,
        };
      }

      if (overallStopped) break cellLoop;
    }
  }

  const result = {
    scorecards: allScorecards,
    cohorts: [...cohortsByDir.values()],
    dashboardPath: lastDashboardPath,
    dashboard: lastDashboard,
    skipped: totalSkipped,
    stopped: overallStopped,
  };

  reportRunResult(result);
}

// Run when invoked directly (not when imported by tests).
runIfMain(import.meta.url, () => {
  main().catch((err) => {
    process.stderr.write(`[run] FATAL: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
});
