// bench/run-chain.js
/**
 * Touch-chain semantics for the brownfield-longitudinal rung (issue #124,
 * PR-C; design §3). `runTouchChain` generalizes `bench/run.js#runTouch2`
 * (one fixed change request) to N DECLARED touches with seeding rules:
 *
 *   - The scenario's seed overlay IS the baseline — there is no greenfield
 *     build-from-prompt phase. `runOneRun` routes a `touches[]` scenario
 *     here; `changeRequest` scenarios keep the existing touch-1 + touch-2
 *     path byte-for-byte.
 *   - Per touch k = 1..N: fresh workspace clone of the CURRENT chain
 *     baseline → session (the bridged `{ id, taskPrompt }` scenario; mandrel
 *     arms run the D-019 two-session plan+deliver inside `runSession`,
 *     control arms one session) → persist raw telemetry immediately
 *     (`.raw/<stamp>/touch<k>/`) → `materializeMandrelDelivery` against the
 *     current chain-baseline SHA → score (the scenario's evolved frozen
 *     suite at touch k + convention oracles + the full dimension set) →
 *     ADVANCE decision.
 *   - `advanced = delivered && baseSuitePassRate ≥
 *     (scenario.chainAdvanceThreshold ?? 0.90) && appBoots`. Advanced ⇒ the
 *     scored tree is committed + force-pushed as the new chain baseline
 *     (`main` in the disposable per-cell repo — the same force-reset
 *     discipline `resetSandboxBaseline` already applies between runs). Not
 *     advanced ⇒ `main` is force-reset back to the last-good baseline and
 *     touch k+1 seeds from it (skip-forward), recording `advanced: false,
 *     seededFromTouch: <j>`.
 *   - One NDJSON line per touch is appended to `.raw/<stamp>/chain.ndjson`:
 *     `{ touch, headSha, landed, materialized, advanced, seededFromTouch,
 *     baseSuite: { passed, total }, costUsd }`.
 *
 * Checkpoint/resume stays CELL-GRANULAR (v1): a crash re-runs the whole
 * cell; the per-touch `.raw/touch<k>/` artifacts keep a partial chain
 * attributable. // v2: intra-cell resume — checkpoint per touch keyed on
 * `(cell × touch)` and re-seed the chain baseline from the last advanced
 * touch's recorded headSha.
 *
 * Every real effect (session, git, app boot, suite run, collectors, judge,
 * GitHub reads, filesystem) is injectable via the same `deps` bag
 * `runOneRun` uses, so the whole chain path is unit-proven with fixtures
 * and no live session, git remote, or network.
 *
 * @module bench/run-chain
 */

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { buildScorecard } from './collect/normalize.js';
import { withRunningApp as defaultWithRunningApp } from './driver/app-runner.js';
import {
  armSeedsStaticClaudeMd,
  isMandrelArm,
  routingOverrideForArm,
} from './driver/arms.js';
import {
  overlayFrameworkUnderTest,
  seedStaticClaudeMd,
  writeGatePackageJson,
} from './driver/overlay.js';
import {
  DEFAULT_BENCH_MODEL,
  DEFAULT_SESSION_TIMEOUT_MS,
  runSession as defaultRunSession,
  rethrowIfTransientClaudeError,
} from './driver/run-session.js';
import {
  provisionSandbox,
  resetSandboxBaseline,
  teardownSandbox,
} from './driver/sandbox.js';
import {
  readBenchmarkVersion,
  readFrameworkVersion,
} from './driver/version-readers.js';
import { cohortDir } from './report/cohort-path.js';
import {
  buildRunIdentity,
  defaultPlanGhJson,
  derivedSecurityInputs,
  discoverLedger,
  discoverPlannedEpicId,
  materializeMandrelDelivery,
  repoRoot,
  resolveDeliveryBranch,
  resolveModelId,
  SESSION_EXTRA_ARGS,
  sanitizeRunId,
  scenarioApplicableMusts,
} from './run.js';
import {
  collectSourceExcerpt as defaultCollectSourceExcerpt,
  runDimensionJudge as defaultRunDimensionJudge,
} from './scenarios/dimension-judge-adapter.js';
import { collectMaintainabilitySignals as defaultCollectMaintainabilitySignals } from './scenarios/maintainability-adapter.js';
import { collectSecuritySignals as defaultCollectSecuritySignals } from './scenarios/security-adapter.js';
import { discoverStandaloneStory } from './scenarios/standalone-telemetry-adapter.js';

/**
 * The default base-suite pass-rate gate a touch must clear (alongside
 * `delivered` and `appBoots`) to advance the chain baseline (design §3).
 * A scenario overrides it via `scenario.chainAdvanceThreshold`.
 */
export const DEFAULT_CHAIN_ADVANCE_THRESHOLD = 0.9;

/** The record-level warning stamped when `dimensions` is a chain aggregate. */
export const CHAIN_AGGREGATE_DIMENSIONS_WARNING = 'chain-aggregate-dimensions';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * Normalize + validate a scenario's declared `touches[]` (design §3; the
 * on-disk counterpart is PR-B's `touches/<k>/` artifacts). Each entry is
 * `{ id, prompt | promptPath, acceptanceSuite?, supersedes? }`:
 *
 *   - `id` — non-empty string, unique across the chain,
 *   - exactly ONE of `prompt` (inline text) or `promptPath` (a path relative
 *     to the scenario directory, read at load time — e.g.
 *     `./touches/1/prompt.md`),
 *   - `acceptanceSuite` — optional relative path (informational here; the
 *     suite-evolution runner reads `touches/<k>/acceptance.test.js` itself),
 *   - `supersedes` — optional array of base `@suite-id` strings
 *     (informational here; the runner reads `touches/<k>/supersedes.json`).
 *
 * Returns `[{ index, id, prompt, acceptanceSuite, supersedes }]` with
 * `index` 1-based in declaration order.
 *
 * @param {object} scenario     The scenario.json object (must carry `touches`).
 * @param {string|null} scenarioDir  Absolute scenario dir (required when any
 *   entry uses `promptPath`).
 * @param {object} [deps]
 * @param {(p: string, enc: string) => string} [deps.readFileImpl]
 * @returns {Array<{ index: number, id: string, prompt: string, acceptanceSuite: string|null, supersedes: string[] }>}
 */
export function normalizeScenarioTouches(scenario, scenarioDir, deps = {}) {
  const read = deps.readFileImpl ?? readFileSync;
  const touches = scenario?.touches;
  if (!Array.isArray(touches) || touches.length === 0) {
    throw new TypeError(
      'scenario.touches must be a non-empty array of touch declarations',
    );
  }
  if (scenario.changeRequest != null) {
    throw new TypeError(
      'scenario declares BOTH touches[] and changeRequest — they are mutually exclusive (the chain replaces the greenfield touch-1 + change-request shape)',
    );
  }
  const seen = new Set();
  return touches.map((entry, i) => {
    const label = `scenario.touches[${i}]`;
    if (!entry || typeof entry !== 'object') {
      throw new TypeError(`${label} must be an object`);
    }
    if (typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new TypeError(`${label}.id must be a non-empty string`);
    }
    if (seen.has(entry.id)) {
      throw new TypeError(`${label}.id "${entry.id}" is not unique`);
    }
    seen.add(entry.id);
    const hasPrompt = typeof entry.prompt === 'string' && entry.prompt.length;
    const hasPath =
      typeof entry.promptPath === 'string' && entry.promptPath.length;
    if (Boolean(hasPrompt) === Boolean(hasPath)) {
      throw new TypeError(
        `${label} must declare exactly one of prompt or promptPath`,
      );
    }
    let prompt;
    if (hasPrompt) {
      prompt = entry.prompt;
    } else {
      if (typeof scenarioDir !== 'string' || scenarioDir.length === 0) {
        throw new TypeError(
          `${label}.promptPath requires a scenario directory to resolve against`,
        );
      }
      prompt = read(path.join(scenarioDir, entry.promptPath), 'utf8');
      if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        throw new TypeError(`${label}.promptPath resolved to an empty prompt`);
      }
    }
    if (
      entry.supersedes !== undefined &&
      (!Array.isArray(entry.supersedes) ||
        entry.supersedes.some((s) => typeof s !== 'string'))
    ) {
      throw new TypeError(
        `${label}.supersedes must be an array of @suite-id strings`,
      );
    }
    return {
      index: i + 1,
      id: entry.id,
      prompt,
      acceptanceSuite:
        typeof entry.acceptanceSuite === 'string'
          ? entry.acceptanceSuite
          : null,
      supersedes: Array.isArray(entry.supersedes) ? [...entry.supersedes] : [],
    };
  });
}

/**
 * Resolve the chain-advance threshold: the scenario's declared
 * `chainAdvanceThreshold` when it is a finite number in [0,1], else the
 * 0.90 default (design §3). Pure.
 *
 * @param {object} scenario
 * @returns {number}
 */
export function resolveChainAdvanceThreshold(scenario) {
  const declared = scenario?.chainAdvanceThreshold;
  if (
    typeof declared === 'number' &&
    Number.isFinite(declared) &&
    declared >= 0 &&
    declared <= 1
  ) {
    return declared;
  }
  return DEFAULT_CHAIN_ADVANCE_THRESHOLD;
}

/**
 * Base-suite pass rate from a suite-evolution verdict: retained passes ÷
 * retained total (an empty retained set is vacuously 1 — nothing could have
 * regressed). Null for a null/malformed verdict (no rate ⇒ never advance).
 * Pure.
 *
 * @param {{ base?: { retainedTotal?: number, retainedPassed?: number } }|null} suiteResult
 * @returns {number|null}
 */
export function baseSuitePassRate(suiteResult) {
  const base = suiteResult?.base;
  if (
    !base ||
    typeof base.retainedTotal !== 'number' ||
    typeof base.retainedPassed !== 'number'
  ) {
    return null;
  }
  return base.retainedTotal === 0
    ? 1
    : base.retainedPassed / base.retainedTotal;
}

/**
 * The chain-advance decision (design §3): `delivered && baseSuitePassRate ≥
 * threshold && appBoots`. A null pass-rate (no suite verdict) or a non-true
 * `appBoots` FAILS CLOSED — the chain never advances onto an unverified
 * tree. Pure.
 *
 * @param {object} args
 * @param {boolean} args.delivered
 * @param {boolean|null} args.appBoots
 * @param {number|null} args.baseSuitePassRate
 * @param {number} args.threshold
 * @returns {boolean}
 */
export function chainAdvanceDecision({
  delivered,
  appBoots,
  baseSuitePassRate: rate,
  threshold,
}) {
  return (
    delivered === true &&
    appBoots === true &&
    typeof rate === 'number' &&
    rate >= threshold
  );
}

/**
 * Mean-aggregate the per-touch dimension blocks into ONE record-level
 * `dimensions` object of the SAME shape (design §5: record-level dimensions
 * = mean over materialized touches, stamped with the
 * `chain-aggregate-dimensions` warning). Recursive, shape-preserving:
 *
 *   - numbers → mean of the non-null values (rounded when every input was
 *     an integer, so integer-typed schema fields like
 *     `efficiency.totalTokens` stay integers); null when all null,
 *   - booleans → OR (any touch tripping a flag trips the aggregate —
 *     conservative for e.g. `security.secretsDetected`),
 *   - string arrays → sorted union (dimension-level warning markers),
 *   - strings / other → first value,
 *   - objects → recurse over the union of keys.
 *
 * @param {Array<object>} dimsList  Non-empty list of per-touch `dimensions`.
 * @returns {object}
 */
export function aggregateChainDimensions(dimsList) {
  if (!Array.isArray(dimsList) || dimsList.length === 0) {
    throw new TypeError(
      'aggregateChainDimensions requires a non-empty dimensions list',
    );
  }
  const aggregateValues = (values) => {
    const present = values.filter((v) => v !== undefined);
    if (present.length === 0) return undefined;
    const nonNull = present.filter((v) => v !== null);
    if (nonNull.length === 0) return null;
    const sample = nonNull[0];
    if (typeof sample === 'number') {
      const nums = nonNull.filter((v) => typeof v === 'number');
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      return nums.every((v) => Number.isInteger(v)) ? Math.round(mean) : mean;
    }
    if (typeof sample === 'boolean') {
      return nonNull.some((v) => v === true);
    }
    if (Array.isArray(sample)) {
      if (nonNull.every((v) => Array.isArray(v))) {
        const flat = nonNull.flat();
        if (flat.every((v) => typeof v === 'string')) {
          return [...new Set(flat)].sort();
        }
      }
      return sample;
    }
    if (typeof sample === 'object') {
      const objs = nonNull.filter(
        (v) => v && typeof v === 'object' && !Array.isArray(v),
      );
      const keys = new Set();
      for (const o of objs) for (const k of Object.keys(o)) keys.add(k);
      const out = {};
      for (const k of keys) {
        const v = aggregateValues(objs.map((o) => o[k]));
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    return sample;
  };
  return aggregateValues(dimsList);
}

/**
 * Assemble the cell-level `chain` scorecard block (design §5) from the
 * per-touch entries: `landedCount` (merged-onto-main touches, plus advanced
 * touches on arms where landing is not a concept — the control arm commits
 * directly, so its advanced touches ARE its landed changes) and
 * `costPerLandedChange` = Σ every touch's cost ÷ landedCount (an
 * unlanded-but-advanced mandrel touch counts in the numerator only — the
 * autonomy penalty in dollars). Pure.
 *
 * @param {object} args
 * @param {Array<object>} args.touches  Per-touch chain entries.
 * @param {number} args.threshold       The resolved advance threshold.
 * @returns {{ advanceThreshold: number, landedCount: number, costPerLandedChange: number|null, touches: Array<object> }}
 */
export function buildChainBlock({ touches, threshold }) {
  const landedCount = touches.filter(
    (t) => t.landed === true || (t.landed == null && t.advanced === true),
  ).length;
  const totalCost = touches.reduce(
    (a, t) => a + (typeof t.cost === 'number' ? t.cost : 0),
    0,
  );
  return {
    advanceThreshold: threshold,
    landedCount,
    costPerLandedChange: landedCount > 0 ? totalCost / landedCount : null,
    touches,
  };
}

/**
 * The invocation-cost of one persisted cell, for the BENCH_MAX_COST_USD /
 * BENCH_MAX_RUNS accounting (audit H2, extended for chains): a chain record
 * sums EVERY `chain.touches[].cost` (each touch is its own session spend —
 * the record-level `efficiency.costUsd` is a per-touch MEAN, so adding it
 * on top would double-count); a non-chain record keeps the existing fold —
 * `dimensions.efficiency.costUsd` plus any `touch2.cost`. Pure.
 *
 * @param {object} scorecard
 * @returns {number}
 */
export function cellCostUsd(scorecard) {
  const chainTouches = scorecard?.chain?.touches;
  if (Array.isArray(chainTouches)) {
    return chainTouches.reduce(
      (a, t) => a + (typeof t?.cost === 'number' ? t.cost : 0),
      0,
    );
  }
  let cost = 0;
  const eff = scorecard?.dimensions?.efficiency?.costUsd;
  if (typeof eff === 'number') cost += eff;
  const t2 = scorecard?.touch2?.cost;
  if (typeof t2 === 'number') cost += t2;
  return cost;
}

/**
 * Resolve the arm-3 (`control-claudemd`) static CLAUDE.md fixture for a
 * scenario (issue #124 orchestrator review note 3): a scenario may declare
 * `controlClaudeMd` — a path relative to its scenario directory — to point
 * arm 3's seeded CLAUDE.md at scenario-specific content (the brownfield
 * rung wants it pointing at the repo's own docs); absent, the generic
 * `bench/fixtures/control-claudemd.md` default applies (returns null — the
 * seeding call falls through to `STATIC_CLAUDEMD_FIXTURE_PATH`). Pure.
 *
 * @param {object} scenario
 * @param {string|null} scenarioDir
 * @returns {string|null} Absolute fixture path, or null for the default.
 */
export function resolveControlClaudeMdFixture(scenario, scenarioDir) {
  const declared = scenario?.controlClaudeMd;
  if (typeof declared !== 'string' || declared.length === 0) return null;
  if (typeof scenarioDir !== 'string' || scenarioDir.length === 0) {
    throw new TypeError(
      'scenario.controlClaudeMd requires a scenario directory to resolve against',
    );
  }
  return path.join(scenarioDir, declared);
}

// ---------------------------------------------------------------------------
// The chain orchestrator
// ---------------------------------------------------------------------------

/**
 * Execute one (touches[] scenario × arm × run) as a TOUCH CHAIN (design §3)
 * and return the assembled cell scorecard, carrying the `chain` block and —
 * when at least one touch materialized — mean-aggregated record-level
 * `dimensions` stamped with the `chain-aggregate-dimensions` warning.
 *
 * The seed overlay is the baseline: there is no greenfield build phase.
 * Sandbox `main` is force-managed exactly like the existing per-run reset
 * discipline — rewound to the current chain baseline before every touch,
 * force-pushed forward on an advance, force-rewound to last-good on a
 * non-advance, and rewound to the ORIGINAL seed baseline when the chain
 * completes (so a cell's N serial runs each start from the pristine seed).
 *
 * @param {object} opts
 * @param {object} opts.scenario     The scenario.json object (declares `touches[]`).
 * @param {Array<object>} opts.touches  Normalized touches (see
 *   {@link normalizeScenarioTouches}).
 * @param {string|null} [opts.scenarioDir]
 * @param {'mandrel'|'control'|string} opts.arm
 * @param {number} opts.runIndex
 * @param {string} [opts.model]
 * @param {{ repoUrl: string, owner: string, repo: string, baselineRef?: string, baselineSha?: string, repoFullName?: string }} opts.sandbox
 * @param {string} [opts.sourceRoot]
 * @param {string} opts.resultsDir
 * @param {string} [opts.ephemeralRoot]
 * @param {number} [opts.timeoutMs]
 * @param {object} [deps]  The same injectable-deps bag `runOneRun` takes,
 *   plus the chain seams: `runEvolvedSuiteFn` (default: the scenario's own
 *   `suite-evolution.js#runEvolvedSuite`, resolved via `importImpl`),
 *   `conventionEvaluators` (default: the modules `scenario.conventionOracles`
 *   names, each exporting `evaluate(deliveredTreePath)`), `appendFileFn`,
 *   `importImpl`.
 * @returns {Promise<object>} The assembled scorecard.
 */
export async function runTouchChain(opts, deps = {}) {
  const {
    scenario,
    touches,
    scenarioDir = null,
    arm,
    runIndex,
    model = DEFAULT_BENCH_MODEL,
    sandbox,
    sourceRoot = repoRoot(),
    resultsDir,
    ephemeralRoot,
    timeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
  } = opts;

  if (!Array.isArray(touches) || touches.length === 0) {
    throw new TypeError('runTouchChain requires a non-empty touches array');
  }

  const logger = deps.logger;
  const provision = deps.provisionFn ?? provisionSandbox;
  const teardown = deps.teardownFn ?? teardownSandbox;
  const resetSandbox = deps.resetSandboxFn ?? resetSandboxBaseline;
  const overlay = deps.overlayFn ?? overlayFrameworkUnderTest;
  const writeGatePkgJson = deps.writeGatePackageJsonFn ?? writeGatePackageJson;
  const seedClaudeMd = deps.seedStaticClaudeMdFn ?? seedStaticClaudeMd;
  const runSessionFn = deps.runSessionFn ?? defaultRunSession;
  const withRunningAppFn = deps.withRunningAppFn ?? defaultWithRunningApp;
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
  const benchmarkVersion =
    deps.benchmarkVersion ?? readBenchmarkVersion(sourceRoot, deps);
  const mkdir = deps.mkdirFn ?? ((p) => mkdirSync(p, { recursive: true }));
  const writeFile = deps.writeFileFn ?? writeFileSync;
  const appendFile = deps.appendFileFn ?? appendFileSync;
  const readFile = deps.readFileImpl ?? readFileSync;
  const importImpl = deps.importImpl ?? ((spec) => import(spec));
  const ghJson = deps.ghJson ?? defaultPlanGhJson;

  // The evolved frozen-suite runner (PR-B): the injectable seam wins; else the
  // scenario's own suite-evolution module. A touches[] scenario without one is
  // a configuration error — the advance gate would fail closed on EVERY touch,
  // silently starving the chain, so fail fast before any cost is spent.
  let runEvolvedSuiteFn = deps.runEvolvedSuiteFn ?? null;
  if (!runEvolvedSuiteFn) {
    const rel =
      typeof scenario?.suiteEvolutionModule === 'string'
        ? scenario.suiteEvolutionModule
        : './suite-evolution.js';
    if (typeof scenarioDir === 'string' && scenarioDir.length > 0) {
      try {
        const mod = await importImpl(path.join(scenarioDir, rel));
        runEvolvedSuiteFn = mod.runEvolvedSuite ?? null;
      } catch (err) {
        throw new Error(
          `runTouchChain: could not load the suite-evolution runner ${rel}: ${err?.message ?? err}`,
        );
      }
    }
  }
  if (typeof runEvolvedSuiteFn !== 'function') {
    throw new TypeError(
      'runTouchChain: a touches[] scenario requires a suite-evolution runner (scenario suite-evolution.js or deps.runEvolvedSuiteFn)',
    );
  }

  // Convention grep-oracles (PR-B): injectable list of `evaluate` functions,
  // else the modules `scenario.conventionOracles` names. Absent ⇒ no
  // conventions block (best-effort axis, never a gate).
  let conventionEvaluators = deps.conventionEvaluators ?? null;
  if (
    !conventionEvaluators &&
    Array.isArray(scenario?.conventionOracles) &&
    typeof scenarioDir === 'string' &&
    scenarioDir.length > 0
  ) {
    conventionEvaluators = [];
    for (const rel of scenario.conventionOracles) {
      try {
        const mod = await importImpl(path.join(scenarioDir, rel));
        if (typeof mod.evaluate === 'function') {
          conventionEvaluators.push(mod.evaluate);
        }
      } catch (err) {
        logger?.warn?.(
          `[chain] could not load convention oracle ${rel} (skipped): ${err?.message ?? err}`,
        );
      }
    }
  }

  const threshold = resolveChainAdvanceThreshold(scenario);
  const baselineRef = sandbox.baselineRef ?? 'bench-baseline';
  const seedBaselineSha = sandbox.baselineSha ?? null;
  const idStampForRaw = sanitizeRunId(`${scenario.id}-${arm}-r${runIndex}`);
  const controlClaudeMdFixture = armSeedsStaticClaudeMd(arm)
    ? resolveControlClaudeMdFixture(scenario, scenarioDir)
    : null;

  // Best-effort reset of the per-cell repo's main to a known SHA. Mirrors the
  // pre/post-run discipline in runOneRun — a reset failure logs, never aborts.
  const resetMainTo = (sha, label) => {
    try {
      resetSandbox(
        { owner: sandbox.owner, repo: sandbox.repo, baselineRef, sha },
        { ghFn: deps.ghApiFn, logger },
      );
    } catch (err) {
      logger?.warn?.(
        `[chain] ${label} baseline reset failed (continuing): ${err?.message ?? err}`,
      );
    }
  };

  // The chain state: the SHA the next touch seeds from, and the index of the
  // last-good (advanced) touch — 0 is the seed itself.
  let chainBaselineSha = seedBaselineSha;
  let lastGoodTouch = 0;

  let cohortDirPath = null;
  let modelId = model;
  let lastEnvelope = null;
  const touchEntries = [];

  try {
    for (const touch of touches) {
      const k = touch.index;

      // Defensive pre-touch reset: the clone below must be taken from the
      // current chain baseline even if a prior touch's rewind was skipped.
      resetMainTo(chainBaselineSha ?? undefined, `pre-touch${k}`);

      const handle = provision(
        {
          repoUrl: sandbox.repoUrl,
          arm,
          ephemeralRoot,
          repoFullName: sandbox.repoFullName ?? null,
          baselineSha: chainBaselineSha,
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
              // Story #153: the scenario's package.json contract decides
              // whether package.json stays git-visible in the sandbox clone.
              scenario,
            },
            deps.overlayDeps,
          );
        } else {
          writeGatePkgJson(
            { workspacePath: handle.workspacePath },
            deps.overlayDeps,
          );
          if (armSeedsStaticClaudeMd(arm)) {
            // Arm 3: the per-scenario fixture seam (review note 3) — the
            // scenario's own CLAUDE.md content when declared, the generic
            // default otherwise.
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

        const runStartedAt = nowIso();
        const session = runSessionFn(
          {
            arm,
            scenario: { id: scenario.id, taskPrompt: touch.prompt },
            cwd: handle.workspacePath,
            model,
            extraArgs: [...SESSION_EXTRA_ARGS],
            timeoutMs,
          },
          { invokeFn: deps.invokeFn, logger },
        );
        lastEnvelope = session.envelope;
        modelId = resolveModelId(session.envelope, model);
        if (cohortDirPath == null) {
          cohortDirPath = cohortDir({
            resultsDir,
            scorecard: { model: { id: modelId }, frameworkVersion },
          });
        }
        const rawCellDir = path.join(cohortDirPath, '.raw', idStampForRaw);
        const rawTouchDir = path.join(rawCellDir, `touch${k}`);

        // Persist raw telemetry IMMEDIATELY (before materialization can move
        // the working tree, before teardown) — mirrors persistTouch2Raw.
        try {
          mkdir(rawTouchDir);
          writeFile(
            path.join(rawTouchDir, 'cost-envelope.json'),
            `${JSON.stringify(session.envelope?.raw ?? session.envelope ?? {}, null, 2)}\n`,
          );
          writeFile(
            path.join(rawTouchDir, 'session-result.json'),
            `${JSON.stringify(
              {
                isError: session.envelope?.isError ?? null,
                result: session.envelope?.result ?? null,
                terminalReason: session.envelope?.terminalReason ?? null,
                numTurns: session.envelope?.numTurns ?? null,
              },
              null,
              2,
            )}\n`,
          );
          if (isMandrelArm(arm)) {
            const found = discoverLedger(
              { workspacePath: handle.workspacePath },
              deps.discoverDeps,
            );
            if (found?.lifecyclePath) {
              writeFile(
                path.join(rawTouchDir, 'lifecycle.ndjson'),
                readFile(found.lifecyclePath, 'utf8'),
              );
            }
          }
        } catch (err) {
          logger?.warn?.(
            `[chain] touch${k}: could not persist raw telemetry (continuing): ${err?.message ?? err}`,
          );
        }

        // Materialize the delivered tree against the CURRENT chain baseline.
        // The control arm commits directly in the workspace, so it always
        // materializes (landing is not a concept — landed stays null).
        let landed = null;
        let delivered = true;
        if (isMandrelArm(arm)) {
          const routing =
            routingOverrideForArm(arm) ??
            (typeof scenario?.routing === 'string'
              ? scenario.routing
              : 'story');
          let epicId = null;
          let storyNumber = null;
          try {
            if (routing === 'story') {
              storyNumber = discoverStandaloneStory(
                {
                  owner: sandbox.owner,
                  repo: sandbox.repo,
                  sinceIso: runStartedAt,
                },
                { ghJson },
              );
            } else {
              epicId = discoverPlannedEpicId(
                {
                  owner: sandbox.owner,
                  repo: sandbox.repo,
                  sinceIso: runStartedAt,
                },
                { ghJson },
              );
            }
          } catch (err) {
            logger?.warn?.(
              `[chain] touch${k}: delivery-target discovery failed (PR-head branch unrecoverable): ${err?.message ?? err}`,
            );
          }
          const deliveryBranch = resolveDeliveryBranch({
            routing,
            epicId,
            storyNumber,
          });
          const m = materializeMandrelDelivery(
            {
              gitFn,
              workspacePath: handle.workspacePath,
              baselineSha: chainBaselineSha,
              deliveryBranch,
            },
            logger,
          );
          landed = m.landed;
          delivered = m.delivered;
        }
        const materialized = delivered;

        // Score the touch. An unmaterialized delivery records real spend but
        // leaves the outcome + behavioural axes unmeasured (never a false 0 on
        // the stale last-good tree).
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
        const touchRunId = sanitizeRunId(`${run.runId}-touch${k}`);

        let appBoots = null;
        let suiteResult = null;
        let conventions = null;
        let subCard;
        if (!materialized) {
          subCard = buildScorecard({
            run: { ...run, runId: touchRunId },
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
            landed: false,
          });
        } else {
          // App-boot probe (the third advance gate): can the delivered tree
          // still serve? Best-effort — a boot failure is a false verdict, not
          // an aborted cell.
          try {
            appBoots =
              (await withRunningAppFn(
                { workspacePath: handle.workspacePath, app: scenario.app },
                async () => true,
                deps.appRunnerDeps,
              )) === true;
          } catch (err) {
            appBoots = false;
            logger?.warn?.(
              `[chain] touch${k}: delivered app failed to boot: ${err?.message ?? err}`,
            );
          }

          // The evolved frozen suite at touch k (PR-B): retained base tests +
          // accumulated additions, run from the frozen mirror — never the
          // agent-editable in-sandbox copy.
          try {
            suiteResult = runEvolvedSuiteFn({
              deliveredTreePath: handle.workspacePath,
              touchIndex: k,
            });
          } catch (err) {
            logger?.warn?.(
              `[chain] touch${k}: evolved-suite run failed (no base-suite verdict — the touch cannot advance): ${err?.message ?? err}`,
            );
          }

          // Convention grep-oracles (best-effort, per-oracle isolation).
          if (
            Array.isArray(conventionEvaluators) &&
            conventionEvaluators.length > 0
          ) {
            const classes = [];
            for (const evaluateConvention of conventionEvaluators) {
              try {
                const v = evaluateConvention(handle.workspacePath);
                if (v && typeof v.class === 'string') {
                  classes.push({
                    class: v.class,
                    clean: Boolean(v.clean),
                    findings: Array.isArray(v.findings) ? v.findings : [],
                  });
                }
              } catch (err) {
                logger?.warn?.(
                  `[chain] touch${k}: convention oracle failed (skipped): ${err?.message ?? err}`,
                );
              }
            }
            if (classes.length > 0) {
              conventions = {
                classes,
                cleanRate:
                  classes.filter((c) => c.clean).length / classes.length,
              };
            }
          }

          // Full dimension set over the delivered tree (mirrors runTouch2).
          let maintainabilitySignals = {};
          try {
            maintainabilitySignals = collectMaintainabilityFn(
              handle.workspacePath,
              deps.collectMaintainabilityPorts,
            );
          } catch (err) {
            logger?.warn?.(
              `[chain] touch${k}: maintainability collector failed (scoring 0): ${err?.message ?? err}`,
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
              `[chain] touch${k}: security collector failed (scoring 0): ${err?.message ?? err}`,
            );
          }
          let judgeScores = null;
          try {
            let sourceExcerpt = '';
            try {
              sourceExcerpt = collectSourceExcerptFn(
                handle.workspacePath,
                deps.collectSourceExcerptPorts,
              );
            } catch (err) {
              logger?.warn?.(
                `[chain] touch${k}: source-excerpt collection failed (judge runs without it): ${err?.message ?? err}`,
              );
            }
            judgeScores = await runDimensionJudgeFn(
              { maintainabilitySignals, securitySignals, sourceExcerpt },
              deps.dimensionJudgeDeps,
            );
          } catch (err) {
            rethrowIfTransientClaudeError(err);
            logger?.warn?.(
              `[chain] touch${k}: dimension judge failed (judge weight folded into spine): ${err?.message ?? err}`,
            );
          }

          const quality = suiteResult
            ? {
                frozenSuitePassed:
                  (suiteResult.base?.retainedPassed ?? 0) +
                  (suiteResult.additions?.passed ?? 0),
                frozenSuiteTotal:
                  (suiteResult.base?.retainedTotal ?? 0) +
                  (suiteResult.additions?.total ?? 0),
                acceptanceEvalScore: null,
              }
            : { measured: false };

          subCard = buildScorecard({
            run: { ...run, runId: touchRunId },
            lifecycle: [],
            signals: [],
            envelope: session.envelope,
            quality,
            planning: {},
            maintainabilityInputs: {
              objectiveMaintainabilityScore:
                maintainabilitySignals.objectiveMaintainabilityScore ?? null,
              maintainabilityJudgeScore: judgeScores?.maintainability ?? null,
              lintWarnings: maintainabilitySignals.lintErrorCount ?? 0,
              complexityScore: maintainabilitySignals.complexityScore ?? null,
              maintainabilityIndex: null,
            },
            securityInputs: derivedSecurityInputs(
              securitySignals,
              judgeScores,
              scenarioApplicableMusts(scenario),
            ),
            trap: null,
            phases: null,
            scenarioRouting:
              typeof scenario?.routing === 'string' ? scenario.routing : null,
            landed,
          });
        }

        const cost = subCard.dimensions.efficiency.costUsd ?? null;
        const outcome = materialized
          ? (subCard.dimensions.quality.score ?? null)
          : null;
        const rate = baseSuitePassRate(suiteResult);
        let advanced = chainAdvanceDecision({
          delivered: materialized,
          appBoots,
          baseSuitePassRate: rate,
          threshold,
        });
        const seededFromTouch = lastGoodTouch;

        // Advance: commit the scored tree (the control arm's session edits
        // the working copy directly; the mandrel tree is already committed on
        // main or the PR-head checkout — the commit is then a no-op) and
        // force-push it as the new chain baseline.
        let headSha = null;
        if (advanced) {
          try {
            gitFn(['add', '-A'], handle.workspacePath);
            try {
              gitFn(
                [
                  '-c',
                  'user.name=mandrel-bench',
                  '-c',
                  'user.email=bench@localhost',
                  'commit',
                  '-m',
                  `bench(chain): touch ${k} baseline (${touch.id})`,
                ],
                handle.workspacePath,
              );
            } catch {
              // Nothing to commit — the delivered tree is already committed.
            }
            gitFn(
              ['push', '--force', 'origin', 'HEAD:refs/heads/main'],
              handle.workspacePath,
            );
            headSha =
              gitFn(['rev-parse', 'HEAD'], handle.workspacePath).trim() || null;
            chainBaselineSha = headSha ?? chainBaselineSha;
            lastGoodTouch = k;
          } catch (err) {
            advanced = false;
            logger?.warn?.(
              `[chain] touch${k}: could not advance the chain baseline (force-push failed) — seeding the next touch from touch ${lastGoodTouch}: ${err?.message ?? err}`,
            );
          }
        }
        if (!advanced) {
          if (headSha == null) {
            try {
              headSha =
                gitFn(['rev-parse', 'HEAD'], handle.workspacePath).trim() ||
                null;
            } catch {
              headSha = null;
            }
          }
          // Rewind any pollution (e.g. a mandrel auto-merge that landed a
          // failing tree on main) back to the last-good baseline, so the next
          // touch seeds from last-good — the skip-forward rule.
          resetMainTo(chainBaselineSha ?? undefined, `post-touch${k} rewind`);
          logger?.info?.(
            `[chain] touch${k} (${touch.id}) did not advance — touch ${k + 1} (if any) seeds from touch ${lastGoodTouch}.`,
          );
        }

        const baseSuite = {
          passed: suiteResult?.base?.retainedPassed ?? 0,
          total: suiteResult?.base?.retainedTotal ?? 0,
        };

        touchEntries.push({
          touchIndex: k,
          changeRequestId: touch.id,
          landed,
          materialized,
          advanced,
          seededFromTouch,
          appBoots,
          outcome,
          cost,
          dimensions: subCard.dimensions,
          ...(suiteResult
            ? {
                regression: {
                  baseTotal: suiteResult.base?.total ?? 0,
                  retainedTotal: baseSuite.total,
                  retainedPassed: baseSuite.passed,
                  regressionRate: suiteResult.base?.regressionRate ?? 0,
                  additionsTotal: suiteResult.additions?.total ?? 0,
                  additionsPassed: suiteResult.additions?.passed ?? 0,
                },
              }
            : {}),
          ...(conventions ? { conventions } : {}),
          ...(Array.isArray(session.phases) && session.phases.length > 0
            ? {
                phases: session.phases.map((p) => ({
                  phase: p.phase,
                  costUsd:
                    typeof p.costUsd === 'number' && Number.isFinite(p.costUsd)
                      ? p.costUsd
                      : null,
                  tokens:
                    typeof p.tokens === 'number' && p.tokens >= 0
                      ? Math.trunc(p.tokens)
                      : 0,
                  wallClockMs:
                    typeof p.wallClockMs === 'number' && p.wallClockMs >= 0
                      ? p.wallClockMs
                      : 0,
                })),
              }
            : {}),
        });

        // One ledger line per touch — append-only, crash-safe (the same
        // NDJSON discipline as the scorecard store).
        try {
          mkdir(rawCellDir);
          appendFile(
            path.join(rawCellDir, 'chain.ndjson'),
            `${JSON.stringify({
              touch: k,
              headSha,
              landed,
              materialized,
              advanced,
              seededFromTouch,
              baseSuite,
              costUsd: cost,
            })}\n`,
          );
        } catch (err) {
          logger?.warn?.(
            `[chain] touch${k}: could not append the chain ledger line: ${err?.message ?? err}`,
          );
        }
      } finally {
        teardown(handle, deps.teardownDeps);
      }
    }
  } finally {
    // The cell's N serial runs each start from the pristine seed: rewind main
    // to the ORIGINAL seed baseline once the chain completes (or aborts).
    resetMainTo(seedBaselineSha ?? undefined, 'post-chain');
  }

  // Assemble the ONE-record-per-cell scorecard (design §5). buildScorecard
  // stamps identity/routing/warnings; the per-touch chain entries live under
  // `chain`, and the record-level `dimensions` is the MEAN over the
  // materialized touches' dimension blocks — a lossy aggregate flagged with
  // the `chain-aggregate-dimensions` warning (per-touch dimensions stay
  // exact inside `chain.touches[]`).
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
  const scorecard = buildScorecard({
    run,
    lifecycle: [],
    signals: [],
    envelope: lastEnvelope ?? {},
    quality: { measured: false },
    planning: {},
    maintainabilityInputs: { measured: false },
    securityInputs: { measured: false },
    trap: null,
    phases: null,
    scenarioRouting:
      typeof scenario?.routing === 'string' ? scenario.routing : null,
    landed: null,
  });
  const materializedDims = touchEntries
    .filter((t) => t.materialized && t.dimensions)
    .map((t) => t.dimensions);
  if (materializedDims.length > 0) {
    scorecard.dimensions = aggregateChainDimensions(materializedDims);
    scorecard.warnings = [
      ...(scorecard.warnings ?? []),
      CHAIN_AGGREGATE_DIMENSIONS_WARNING,
    ];
  }
  scorecard.chain = buildChainBlock({ touches: touchEntries, threshold });
  return scorecard;
}
