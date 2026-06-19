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
 *     → overlay the framework-under-test (overlay.js, mandrel arm only)
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
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScorecard, parseNdjson } from './collect/normalize.js';
import { withRunningApp as defaultWithRunningApp } from './driver/app-runner.js';
import { overlayFrameworkUnderTest } from './driver/overlay.js';
import {
  DEFAULT_BENCH_MODEL,
  DEFAULT_SESSION_TIMEOUT_MS,
  runSession as defaultRunSession,
} from './driver/run-session.js';
import {
  provisionSandbox,
  resetSandboxBaseline,
  teardownSandbox,
} from './driver/sandbox.js';
import { aggregateScorecards } from './report/aggregate.js';
import { cohortDir } from './report/cohort-path.js';
import { renderDashboard } from './report/html.js';
import { appendScorecards, readStore } from './report/persist.js';
import { renderReport } from './report/render.js';
import { scoreScenarioQuality as defaultScoreScenarioQuality } from './scenarios/acceptance-eval-adapter.js';
import { runDimensionJudge as defaultRunDimensionJudge } from './scenarios/dimension-judge-adapter.js';
import { collectMaintainabilitySignals as defaultCollectMaintainabilitySignals } from './scenarios/maintainability-adapter.js';
import { collectSecuritySignals as defaultCollectSecuritySignals } from './scenarios/security-adapter.js';
import {
  collectStandaloneTelemetry,
  defaultGhJson,
  discoverStandaloneStory,
} from './scenarios/standalone-telemetry-adapter.js';

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

/**
 * Read the framework-under-test version from the pinned `mandrel` dependency
 * (`node_modules/mandrel/package.json`) — NOT the consumer's own
 * `package.json` version. Falls back to the dependency spec when the package is
 * absent.
 *
 * @param {string} sourceRoot
 * @param {object} [deps]
 * @param {(p: string, enc: string) => string} [deps.readFileImpl]
 * @param {(p: string) => boolean} [deps.existsImpl]
 * @returns {string}
 */
export function readFrameworkVersion(sourceRoot, deps = {}) {
  const read = deps.readFileImpl ?? readFileSync;
  const exists = deps.existsImpl ?? existsSync;
  const pkgPath = path.join(
    sourceRoot,
    'node_modules',
    'mandrel',
    'package.json',
  );
  if (exists(pkgPath)) {
    try {
      const v = JSON.parse(read(pkgPath, 'utf8')).version;
      if (typeof v === 'string' && v.length > 0) return v;
    } catch {
      // fall through
    }
  }
  // Fallback: the spec from the consumer package.json dependencies.
  try {
    const consumer = JSON.parse(
      read(path.join(sourceRoot, 'package.json'), 'utf8'),
    );
    const spec = consumer?.dependencies?.mandrel;
    if (typeof spec === 'string') return spec.replace(/^[\^~>=<\s]*/, '');
  } catch {
    // fall through
  }
  return 'unknown';
}

/**
 * Sanitize an arbitrary string into the scorecard `runId` pattern
 * (`^[A-Za-z0-9._-]+$`).
 *
 * @param {string} s
 * @returns {string}
 */
export function sanitizeRunId(s) {
  return String(s)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
  env,
}) {
  const idStamp = sanitizeRunId(`${scenario}-${arm}-${timestamp}-r${runIndex}`);
  return {
    runId: idStamp,
    timestamp,
    model: { id: modelId },
    frameworkVersion,
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
 * Derive the `securityInputs` object for `buildScorecard` from the raw
 * sub-signals returned by `collectSecuritySignals` and the optional judge
 * scores.
 *
 * The security adapter returns boolean MUST-presence signals; we map them to
 * the `criticalFindings` / `highFindings` / `secretsDetected` sub-signals that
 * `computeSecurity` in dimensions.js expects, and compute
 * `objectiveSecurityScore` as a weighted sum:
 *
 *   secretPenalty           = secretScanCount > 0 ? 0 : 1        weight 0.30
 *   vulnPenalty             = max(0, 1 − depAuditVulnCount / 10)  weight 0.20
 *   mustPresenceScore       = (validationOk + hashingOk + storageOk
 *                             + authzOk + rateLimitOk) / 5         weight 0.50
 *   objectiveSecurityScore  = secretPenalty·0.30 + vulnPenalty·0.20
 *                           + mustPresenceScore·0.50
 *
 * @param {object} sigs   Output of collectSecuritySignals (or {}).
 * @param {{ security?: number } | null} judgeScores  Batched judge output.
 * @returns {object}
 */
export function derivedSecurityInputs(sigs, judgeScores) {
  const secretScanCount =
    typeof sigs.secretScanCount === 'number' ? sigs.secretScanCount : 0;
  const depAuditVulnCount =
    typeof sigs.depAuditVulnCount === 'number' ? sigs.depAuditVulnCount : 0;

  const secretPenalty = secretScanCount > 0 ? 0 : 1;
  const vulnPenalty = Math.max(0, 1 - depAuditVulnCount / 10);

  const mustFlags = [
    sigs.hasEdgeInputValidation,
    sigs.hasPasswordHashing,
    sigs.hasSafeTokenStorage,
    sigs.hasServerSideAuthz,
    sigs.hasAuthRateLimiting,
  ];
  const mustCount = mustFlags.filter(Boolean).length;
  const mustPresenceScore = mustCount / 5;

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
 * Load a scenario definition + its frozen oracle's `evaluate` export.
 *
 * @param {string} scenarioId
 * @param {object} [deps]
 * @param {(p: string, enc: string) => string} [deps.readFileImpl]
 * @param {(spec: string) => Promise<object>} [deps.importImpl]
 * @returns {Promise<{ scenario: object, evaluate: Function }>}
 */
export async function loadScenario(scenarioId, deps = {}) {
  const read = deps.readFileImpl ?? readFileSync;
  const importImpl = deps.importImpl ?? ((spec) => import(spec));
  const dir = path.join(__dirname, 'scenarios', scenarioId);
  const scenario = JSON.parse(read(path.join(dir, 'scenario.json'), 'utf8'));
  const suiteRel = scenario.acceptanceSuite ?? './acceptance.test.js';
  const mod = await importImpl(path.join(dir, suiteRel));
  return { scenario, evaluate: mod.evaluate };
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
    arm,
    runIndex,
    model = DEFAULT_BENCH_MODEL,
    sandbox, // { repoUrl, owner, repo }
    sourceRoot = repoRoot(),
    resultsDir,
    ephemeralRoot,
    timeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
  } = opts;

  const baselineRef = sandbox.baselineRef ?? 'bench-baseline';

  const logger = deps.logger;
  const provision = deps.provisionFn ?? provisionSandbox;
  const teardown = deps.teardownFn ?? teardownSandbox;
  const resetSandbox = deps.resetSandboxFn ?? resetSandboxBaseline;
  const overlay = deps.overlayFn ?? overlayFrameworkUnderTest;
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
  const cp = deps.cpFn ?? cpSync;
  const mkdir = deps.mkdirFn ?? ((p) => mkdirSync(p, { recursive: true }));
  const writeFile = deps.writeFileFn ?? writeFileSync;

  const bridged = {
    id: scenario.id,
    taskPrompt: scenario.seed.prompt,
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
      { owner: sandbox.owner, repo: sandbox.repo, baselineRef },
      { ghFn: deps.ghApiFn, logger },
    );
  } catch (err) {
    logger?.warn?.(
      `[run] pre-run baseline reset failed (continuing): ${err?.message ?? err}`,
    );
  }

  const handle = provision(
    { repoUrl: sandbox.repoUrl, arm, ephemeralRoot },
    deps.provisionDeps,
  );
  try {
    if (arm === 'mandrel') {
      overlay(
        {
          workspacePath: handle.workspacePath,
          arm,
          sandbox: { owner: sandbox.owner, repo: sandbox.repo },
          sourceRoot,
        },
        deps.overlayDeps,
      );
    }

    // Both arms get the permission args so each can act headlessly; the mandrel
    // arm's /deliver --yes lives in the prompt (buildArmPrompt), not here.
    const extraArgs = [...SESSION_EXTRA_ARGS];
    // Bound the GitHub-side artifact search (Story #48): any standalone Story
    // the mandrel arm opens in the sandbox is created at/after this instant, so
    // it isolates this cell's Story from prior runs' (sandbox issues persist
    // across the per-run baseline reset).
    const runStartedAt = nowIso();

    const session = runSessionFn(
      {
        arm,
        scenario: bridged,
        cwd: handle.workspacePath,
        model,
        extraArgs,
        timeoutMs,
      },
      { invokeFn: deps.invokeFn, logger },
    );

    // Materialize the delivered code into the working tree. For the mandrel arm
    // a clean /deliver auto-merged onto the sandbox's default branch on GitHub,
    // so pull it down; best-effort (a blocked run leaves the default branch
    // empty → the oracle records quality=0, which is the correct signal).
    if (arm === 'mandrel') {
      try {
        gitFn(['fetch', 'origin', 'main'], handle.workspacePath);
        gitFn(['checkout', 'main'], handle.workspacePath);
        gitFn(['reset', '--hard', 'origin/main'], handle.workspacePath);
      } catch (err) {
        logger?.warn?.(
          `[run] could not materialize merged code (run may have blocked): ${err?.message ?? err}`,
        );
      }
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
    const idStampForRaw = sanitizeRunId(`${scenario.id}-${arm}-r${runIndex}`);
    if (arm === 'mandrel') {
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

    // Persist the cost envelope for provenance.
    const dest = path.join(rawDir, idStampForRaw);
    mkdir(dest);
    const envelopePath = path.join(dest, 'cost-envelope.json');
    writeFile(
      envelopePath,
      `${JSON.stringify(session.envelope.raw ?? session.envelope, null, 2)}\n`,
    );
    rawRefs = { ...(rawRefs ?? {}), costEnvelope: envelopePath };

    // Score Quality by bringing up the delivered app and probing it.
    const quality = await withRunningAppFn(
      { workspacePath: handle.workspacePath, app: scenario.app },
      async (baseUrl) => {
        if (arm === 'mandrel') {
          const r = await scoreQualityFn({
            evaluate,
            baseUrl,
            storyId: 1,
            epicId: scenario.epicId ?? null,
            transport: 'in-process',
          });
          return qualityInputs({
            frozen: r.frozen,
            crossCheckDecision: r.crossCheck?.decision ?? null,
          });
        }
        const frozen = await evaluate(baseUrl);
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

    // Run the single batched LLM-judge cross-check for both new dimensions.
    // The judge is enabled for both arms so the comparison is fair. A null
    // result (judge disabled / transport error) folds the 0.3 judge weight
    // into the objective spine — the dimension is still populated.
    let judgeScores = null;
    try {
      judgeScores = await runDimensionJudgeFn(
        { maintainabilitySignals, securitySignals },
        deps.dimensionJudgeDeps,
      );
    } catch (err) {
      logger?.warn?.(
        `[run] dimension judge failed (judge weight folded into spine): ${err?.message ?? err}`,
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

    const securityInputs = derivedSecurityInputs(securitySignals, judgeScores);

    const run = buildRunIdentity({
      scenario: scenario.id,
      arm,
      runIndex,
      timestamp: nowIso(),
      modelId,
      frameworkVersion,
      env,
    });

    const scorecard = buildScorecard({
      run,
      lifecycle,
      signals,
      envelope: session.envelope,
      quality,
      planning: arm === 'mandrel' ? planningInputs(lifecycle) : {},
      maintainabilityInputs,
      securityInputs,
      rawRefs,
      standalone,
    });
    return scorecard;
  } finally {
    // Primary post-run cleanup: rewind the sandbox repo's `main` back to the
    // clean baseline so the next run starts from a pristine tree. Best-effort:
    // a reset failure must not mask the run's own result or break teardown.
    try {
      resetSandbox(
        { owner: sandbox.owner, repo: sandbox.repo, baselineRef },
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
 * @param {number} [opts.n=1]
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
    n = 1,
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
    const { scenario, evaluate } = await loadScenario(
      scenarioId,
      deps.loadDeps,
    );
    if (epicIds[scenarioId] != null) scenario.epicId = epicIds[scenarioId];
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
            arm,
            runIndex,
            model,
            sandbox,
            resultsDir,
            ephemeralRoot,
          },
          deps,
        );
        scorecards.push(scorecard);
        // Persist + checkpoint the in-flight cell BEFORE evaluating the ceiling,
        // so a ceiling stop never abandons a partial / un-checkpointed cell.
        persistCell(scorecard, cell);
        completed += 1;
        const cellCost = scorecard?.dimensions?.efficiency?.costUsd;
        if (typeof cellCost === 'number') costUsd += cellCost;

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

  const cohorts = [];
  for (const [dir, cohortCards] of cohortReportCards) {
    const storePath = path.join(dir, 'scorecards.ndjson');
    // Render over the FULL on-disk cohort store, NOT just this run's
    // `cohortCards`. A resumed batch only produces the cells it actually
    // re-ran (the rest are skipped from the checkpoint), so rendering
    // `cohortCards` alone under-counts every resumed cell — a resumed N=8 that
    // re-ran 5 cells would report n=5 instead of the true n=8. This mirrors how
    // the dashboard reads the corpus (`aggregateScorecards`). Deterministic:
    // `readStore` + `renderReport` are pure over the append-ordered store.
    const fullStore = readStore({ storePath }, deps.persistDeps);
    const report = renderReport({ scorecards: fullStore, method: 'iqr' });
    const stamp = sanitizeRunId(cohortCards[0]?.timestamp ?? `${Date.now()}`);
    const reportsDir = path.join(dir, 'reports');
    const reportPath = path.join(reportsDir, `report-${stamp}.md`);
    mkdir(reportsDir);
    writeFile(reportPath, report);
    cohorts.push({ dir, storePath, reportPath, report });
  }

  // Regenerate the aggregate dashboard from the FULL corpus across every cohort
  // (not just this run's scorecards) so `results.html` always reflects the whole
  // longitudinal history on disk.
  const corpus = aggregateScorecards({ resultsDir }, deps.aggregateDeps);
  const dashboard = renderDashboard({ scorecards: corpus });
  const dashboardPath = path.join(resultsDir, 'results.html');
  mkdir(resultsDir);
  writeFile(dashboardPath, dashboard);

  return { scorecards, cohorts, dashboardPath, dashboard, skipped, stopped };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Normalize a scenario id into the `BENCH_EPIC_ID_<SCENARIO>` env-var suffix:
 * uppercased, every run of non `[A-Z0-9]` characters folded to a single `_`.
 * So `crud-db` → `CRUD_DB`, read as `BENCH_EPIC_ID_CRUD_DB`. Pure.
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
 *   3. `BENCH_EPIC_ID_<SCENARIO>` — one var per scenario (see `scenarioEnvSuffix`).
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
  // 2. JSON map: BENCH_EPIC_IDS = {"hello-world":99,"crud-db":100}.
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
 * Minimal CLI entry. Reads sandbox coordinates from the environment:
 *   BENCH_SANDBOX_REPO_URL, BENCH_SANDBOX_OWNER, BENCH_SANDBOX_REPO.
 * Optional: BENCH_SCENARIOS (csv), BENCH_ARMS (csv), BENCH_N,
 *   BENCH_SANDBOX_BASELINE_REF (clean baseline branch main is reset to
 *   before/after each run; default 'bench-baseline').
 * Per-scenario seed Epic ids (mandrel arm):
 *   BENCH_EPIC_ID (single-scenario back-compat → scenarios[0]),
 *   BENCH_EPIC_IDS (JSON map keyed by scenario id),
 *   BENCH_EPIC_ID_<SCENARIO> (one var per scenario; see scenarioEnvSuffix).
 * Batch bounds (resumable, cost-bounded loop):
 *   BENCH_MAX_RUNS (run-count ceiling for this invocation),
 *   BENCH_MAX_COST_USD (USD cost ceiling for this invocation),
 *   BENCH_CHECKPOINT (override the resume-checkpoint path).
 */
export async function main() {
  const sandbox = {
    repoUrl: process.env.BENCH_SANDBOX_REPO_URL,
    owner: process.env.BENCH_SANDBOX_OWNER,
    repo: process.env.BENCH_SANDBOX_REPO,
    baselineRef: process.env.BENCH_SANDBOX_BASELINE_REF ?? 'bench-baseline',
  };
  const scenarios = (process.env.BENCH_SCENARIOS ?? 'hello-world')
    .split(',')
    .map((s) => s.trim());
  const epicIds = resolveEpicIds(scenarios, process.env);
  const opts = {
    sandbox,
    scenarios,
    epicIds,
    arms: (process.env.BENCH_ARMS ?? 'mandrel,control')
      .split(',')
      .map((s) => s.trim()),
    n: Number(process.env.BENCH_N ?? '1'),
    maxRuns:
      process.env.BENCH_MAX_RUNS != null
        ? Number(process.env.BENCH_MAX_RUNS)
        : null,
    maxCostUsd:
      process.env.BENCH_MAX_COST_USD != null
        ? Number(process.env.BENCH_MAX_COST_USD)
        : null,
    ...(process.env.BENCH_CHECKPOINT
      ? { checkpointPath: process.env.BENCH_CHECKPOINT }
      : {}),
  };
  const logger = {
    info: (m) => process.stderr.write(`${m}\n`),
    warn: (m) => process.stderr.write(`${m}\n`),
    error: (m) => process.stderr.write(`${m}\n`),
  };
  const result = await runFirstBenchmark(opts, { logger });
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

// Run when invoked directly (not when imported by tests).
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    process.stderr.write(`[run] FATAL: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
}
