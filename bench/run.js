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
import { provisionSandbox, teardownSandbox } from './driver/sandbox.js';
import { appendScorecards } from './report/persist.js';
import { renderReport } from './report/render.js';
import { scoreScenarioQuality as defaultScoreScenarioQuality } from './scenarios/acceptance-eval-adapter.js';

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
 * Resolve the exact model id to stamp: prefer the model the `claude -p`
 * envelope actually billed (the first key of `modelUsage`), else the requested
 * model.
 *
 * @param {object} envelope  Parsed session envelope.
 * @param {string} requestedModel
 * @returns {string}
 */
export function resolveModelId(envelope, requestedModel) {
  const usage = envelope?.modelUsage;
  if (usage && typeof usage === 'object') {
    const keys = Object.keys(usage);
    if (keys.length > 0 && keys[0].length > 0) return keys[0];
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

  const logger = deps.logger;
  const provision = deps.provisionFn ?? provisionSandbox;
  const teardown = deps.teardownFn ?? teardownSandbox;
  const overlay = deps.overlayFn ?? overlayFrameworkUnderTest;
  const runSessionFn = deps.runSessionFn ?? defaultRunSession;
  const withRunningAppFn = deps.withRunningAppFn ?? defaultWithRunningApp;
  const scoreQualityFn =
    deps.scoreScenarioQualityFn ?? defaultScoreScenarioQuality;
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

    // Discover + copy out the lifecycle ledger before teardown.
    let lifecycle = [];
    const signals = [];
    let rawRefs;
    const rawDir = path.join(resultsDir, '.raw');
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
        logger?.warn?.('[run] no lifecycle ledger found for the mandrel arm');
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

    const run = buildRunIdentity({
      scenario: scenario.id,
      arm,
      runIndex,
      timestamp: nowIso(),
      modelId: resolveModelId(session.envelope, model),
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
      rawRefs,
    });
    return scorecard;
  } finally {
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
 * @param {{ repoUrl: string, owner: string, repo: string }} opts.sandbox
 * @param {string} [opts.resultsDir]
 * @param {string} [opts.ephemeralRoot]
 * @param {object} [deps]
 * @returns {Promise<{ scorecards: object[], storePath: string, reportPath: string, report: string }>}
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
  } = opts;

  if (!sandbox?.repoUrl || !sandbox?.owner || !sandbox?.repo) {
    throw new TypeError(
      'runFirstBenchmark requires sandbox { repoUrl, owner, repo }',
    );
  }

  const logger = deps.logger;
  const writeFile = deps.writeFileFn ?? writeFileSync;
  const mkdir = deps.mkdirFn ?? ((p) => mkdirSync(p, { recursive: true }));

  const scorecards = [];
  for (const scenarioId of scenarios) {
    const { scenario, evaluate } = await loadScenario(
      scenarioId,
      deps.loadDeps,
    );
    for (let runIndex = 1; runIndex <= n; runIndex += 1) {
      for (const arm of arms) {
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
      }
    }
  }

  const storePath = path.join(resultsDir, 'scorecards.ndjson');
  appendScorecards({ storePath, scorecards }, deps.persistDeps);

  const report = renderReport({ scorecards, method: 'iqr' });
  const stamp = sanitizeRunId(scorecards[0]?.timestamp ?? `${Date.now()}`);
  const reportPath = path.join(resultsDir, `report-${stamp}.md`);
  mkdir(resultsDir);
  writeFile(reportPath, report);

  return { scorecards, storePath, reportPath, report };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Minimal CLI entry. Reads sandbox coordinates from the environment:
 *   BENCH_SANDBOX_REPO_URL, BENCH_SANDBOX_OWNER, BENCH_SANDBOX_REPO.
 * Optional: BENCH_SCENARIOS (csv), BENCH_ARMS (csv), BENCH_N.
 */
export async function main() {
  const sandbox = {
    repoUrl: process.env.BENCH_SANDBOX_REPO_URL,
    owner: process.env.BENCH_SANDBOX_OWNER,
    repo: process.env.BENCH_SANDBOX_REPO,
  };
  const opts = {
    sandbox,
    scenarios: (process.env.BENCH_SCENARIOS ?? 'hello-world')
      .split(',')
      .map((s) => s.trim()),
    arms: (process.env.BENCH_ARMS ?? 'mandrel,control')
      .split(',')
      .map((s) => s.trim()),
    n: Number(process.env.BENCH_N ?? '1'),
  };
  const logger = {
    info: (m) => process.stderr.write(`${m}\n`),
    warn: (m) => process.stderr.write(`${m}\n`),
    error: (m) => process.stderr.write(`${m}\n`),
  };
  const result = await runFirstBenchmark(opts, { logger });
  process.stderr.write(
    `\n[run] ${result.scorecards.length} scorecard(s) → ${result.storePath}\n` +
      `[run] report → ${result.reportPath}\n`,
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
