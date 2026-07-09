// bench/driver/topup-planner.js
/**
 * Cohort top-up planner for the Mandrel self-benchmark harness (Epic #84,
 * Story #89). Internal tooling only — never shipped in the distributed
 * `.agents/` bundle, never run against the live repo.
 *
 * This is the "has this combination already been benchmarked?" brain that lets
 * both CI and local runs execute ONLY the missing cells: a complete cohort is a
 * near-zero-cost no-op. Given a cohort stamp (model, framework/mandrel version,
 * benchmark version), the scenario set (each scenario's `targetN` sizing
 * contract with an explicit override precedence matching bench/run.js's H1
 * semantics), and the persisted results corpus, `planTopup` computes the
 * per-cell deficit `max(0, targetN - validRuns)` where a corpus record counts
 * toward a `(scenario × arm)` cell ONLY when it is:
 *   - schema-valid (validates against bench/schemas/scorecard.schema.json),
 *   - exact-triple-matched (same model + frameworkVersion + benchmarkVersion as
 *     the requested cohort), AND
 *   - not a routing mismatch (`routingMismatch !== true` — a record that
 *     measured a different pipeline than the scenario contract promises is a
 *     deficit, not a credit).
 *
 * `planTopup` is PURE (no clock, no I/O, no run invocation): it takes the
 * corpus + scenarios + cohort as data and returns a plan. The module also ships
 * its own standalone CLI entrypoint — `node bench/driver/topup-planner.js
 * --dry-run` prints the per-cell deficit and estimated cost as JSON and exits 0
 * WITHOUT invoking any benchmark run. Every real effect (reading the corpus,
 * loading scenarios, resolving the cohort stamp) is behind an injectable port,
 * so the CLI is exercised end to end by the unit suite with no real disk read,
 * and there is deliberately NO coupling to bench/run.js's run loop — this module
 * imports no run-executing code, so it can never launch a session.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { aggregateScorecards } from '../report/aggregate.js';
import { defaultCliLogger, runIfMain } from './cli-shell.js';
import { DEFAULT_BENCH_MODEL } from './run-session.js';
import {
  readBenchmarkVersion,
  readFrameworkVersion,
} from './version-readers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The two arms every cohort cell is sized for. */
export const DEFAULT_ARMS = Object.freeze(['mandrel', 'control']);

/** The Epic #66 3-rung scenario corpus, in difficulty order. */
export const DEFAULT_SCENARIO_IDS = Object.freeze([
  'hello-world',
  'story-scope',
  'epic-scope',
]);

/**
 * Conservative static per-run cost fallback (USD) used when the corpus carries
 * no observed `costUsd` history for a cell. Deliberately non-zero so a fresh
 * cohort with no history still yields a costed plan rather than a free one.
 */
export const DEFAULT_STATIC_COST_USD = 1.0;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly)
// ---------------------------------------------------------------------------

/** Round a USD amount to 4 decimals so float noise never leaks into a plan. */
function roundUsd(x) {
  return Math.round(x * 1e4) / 1e4;
}

let cachedValidate = null;

/**
 * Compile (and cache) the Ajv2020 validator for the scorecard schema. The
 * schema declares `$schema: draft/2020-12`, so we use the 2020 dialect entry
 * point (matching .agents/scripts/acceptance-eval.js) and register `ajv-formats`
 * for the `date-time` format the schema uses. `strict: false` mirrors the
 * project convention — the schema carries descriptive keywords Ajv's strict
 * mode would otherwise reject.
 *
 * @param {object} [deps]
 * @param {(p: string, enc: string) => string} [deps.readFileImpl]
 * @returns {(record: unknown) => boolean}
 */
export function scorecardValidator(deps = {}) {
  if (cachedValidate) return cachedValidate;
  const read = deps.readFileImpl ?? readFileSync;
  const schemaPath = path.resolve(
    __dirname,
    '..',
    'schemas',
    'scorecard.schema.json',
  );
  const schema = JSON.parse(read(schemaPath, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  cachedValidate = (record) => validate(record) === true;
  return cachedValidate;
}

/**
 * Resolve the per-scenario run-count target with the SAME precedence
 * bench/run.js applies (H1 semantics): an explicit operator override
 * (`nOverride`, sourced from `--n` / `BENCH_N`) applies uniformly to EVERY
 * scenario; absent that, the scenario's own declared `targetN` (accepting the
 * `target_n` snake-case spelling too) governs; falling back to 1 for a scenario
 * that declares neither. Pure.
 *
 * @param {object} scenario
 * @param {{ nOverride?: number|null }} [opts]
 * @returns {number}
 */
export function resolveTargetN(scenario, { nOverride = null } = {}) {
  if (typeof nOverride === 'number' && Number.isFinite(nOverride)) {
    return nOverride;
  }
  const declared = scenario?.targetN ?? scenario?.target_n;
  if (typeof declared === 'number' && Number.isFinite(declared)) {
    return declared;
  }
  return 1;
}

/**
 * Whether a scorecard's stamp exact-matches the requested cohort triple
 * (model, framework/mandrel version, benchmark version). This is the D-014
 * cohort discriminant the planner counts by — a record from any other cohort
 * measures a different thing and must never credit this cohort's deficit. Pure.
 *
 * @param {object} sc
 * @param {{ model: string, frameworkVersion: string, benchmarkVersion: string }} cohort
 * @returns {boolean}
 */
export function matchesCohort(sc, cohort) {
  return (
    sc?.model?.id === cohort?.model &&
    sc?.frameworkVersion === cohort?.frameworkVersion &&
    sc?.benchmarkVersion === cohort?.benchmarkVersion
  );
}

/**
 * Whether a scorecard counts as a VALID run toward its cell: schema-valid AND
 * exact-triple-matched AND not a routing mismatch. Pure.
 *
 * @param {object} sc
 * @param {{ model: string, frameworkVersion: string, benchmarkVersion: string }} cohort
 * @param {(record: unknown) => boolean} isValid
 * @returns {boolean}
 */
export function isValidRun(sc, cohort, isValid) {
  if (sc?.routingMismatch === true) return false;
  if (!matchesCohort(sc, cohort)) return false;
  return isValid(sc) === true;
}

/** Mean of a numeric list, or null when empty. */
function mean(values) {
  if (values.length === 0) return null;
  const sum = values.reduce((a, v) => a + v, 0);
  return sum / values.length;
}

/**
 * Plan the top-up for a cohort: per `(scenario × arm)` cell, how many valid runs
 * already exist, the deficit to reach `targetN`, and the estimated USD cost to
 * close it. A `max_cost_usd` ceiling — when supplied — is allocated across the
 * deficit cells in order; each cell whose cumulative allocation exceeds the
 * ceiling is marked `overCeiling`, and the plan as a whole is marked
 * `overCeiling` when the total estimate exceeds the ceiling. PURE — no I/O, no
 * clock, no run invocation.
 *
 * Cost estimation: a cell's per-run cost is the mean of the observed
 * `dimensions.efficiency.costUsd` across that cell's valid records; when the
 * corpus carries no observed cost for the cell, it falls back to the
 * per-scenario static estimate (`staticCostByScenario[scenarioId]`, then the
 * scenario's own `staticCostUsd`, then `defaultStaticCostUsd`). A cell's
 * estimated cost is `deficit × perRunCost`.
 *
 * @param {object} args
 * @param {{ model: string, frameworkVersion: string, benchmarkVersion: string }} args.cohort
 * @param {Array<object>} args.scenarios   Scenario objects (each `{ id, targetN? }`).
 * @param {Array<object>} args.corpus      Persisted scorecards (the results corpus).
 * @param {string[]} [args.arms]           Defaults to `DEFAULT_ARMS`.
 * @param {number|null} [args.nOverride]   Uniform run-count override (`--n` / `BENCH_N`).
 * @param {number|null} [args.maxCostUsd]  Cost ceiling in USD; null ⇒ no ceiling.
 * @param {Record<string, number>} [args.staticCostByScenario]
 * @param {number} [args.defaultStaticCostUsd]
 * @param {object} [deps]
 * @param {(record: unknown) => boolean} [deps.isValid]  Schema-validity predicate.
 * @returns {object} The plan.
 */
export function planTopup(
  {
    cohort,
    scenarios,
    corpus,
    arms = DEFAULT_ARMS,
    nOverride = null,
    maxCostUsd = null,
    staticCostByScenario = {},
    defaultStaticCostUsd = DEFAULT_STATIC_COST_USD,
  },
  deps = {},
) {
  if (!cohort || typeof cohort !== 'object') {
    throw new TypeError('planTopup: cohort is required');
  }
  for (const key of ['model', 'frameworkVersion', 'benchmarkVersion']) {
    if (typeof cohort[key] !== 'string' || cohort[key].length === 0) {
      throw new TypeError(`planTopup: cohort.${key} is required`);
    }
  }
  if (!Array.isArray(scenarios)) {
    throw new TypeError('planTopup: scenarios must be an array');
  }
  if (!Array.isArray(corpus)) {
    throw new TypeError('planTopup: corpus must be an array');
  }
  const isValid = deps.isValid ?? scorecardValidator(deps);

  const cells = [];
  for (const scenario of scenarios) {
    const scenarioId = scenario?.id;
    if (typeof scenarioId !== 'string' || scenarioId.length === 0) continue;
    const targetN = resolveTargetN(scenario, { nOverride });
    for (const arm of arms) {
      const validRecords = corpus.filter(
        (sc) =>
          sc?.scenario === scenarioId &&
          sc?.arm === arm &&
          isValidRun(sc, cohort, isValid),
      );
      const validRuns = validRecords.length;
      const deficit = Math.max(0, targetN - validRuns);

      const observedCosts = validRecords
        .map((sc) => sc?.dimensions?.efficiency?.costUsd)
        .filter((c) => typeof c === 'number' && Number.isFinite(c));
      const observedPerRun = mean(observedCosts);
      const staticPerRun =
        (typeof staticCostByScenario[scenarioId] === 'number'
          ? staticCostByScenario[scenarioId]
          : typeof scenario?.staticCostUsd === 'number'
            ? scenario.staticCostUsd
            : defaultStaticCostUsd) ?? defaultStaticCostUsd;
      const perRunCostUsd =
        observedPerRun != null ? observedPerRun : staticPerRun;
      const costSource = observedPerRun != null ? 'observed' : 'static';

      cells.push({
        scenario: scenarioId,
        arm,
        targetN,
        validRuns,
        deficit,
        perRunCostUsd: roundUsd(perRunCostUsd),
        estimatedCostUsd: roundUsd(deficit * perRunCostUsd),
        costSource,
      });
    }
  }

  // Deficit cells carry the ceiling allocation. Iterating in `cells` order
  // (scenario order × arm order) keeps the allocation deterministic.
  const deficitCells = [];
  let cumulative = 0;
  for (const cell of cells) {
    if (cell.deficit <= 0) continue;
    cumulative += cell.estimatedCostUsd;
    const overCeiling = maxCostUsd != null && cumulative > maxCostUsd;
    const deficitCell = {
      ...cell,
      cumulativeCostUsd: roundUsd(cumulative),
      overCeiling,
    };
    deficitCells.push(deficitCell);
  }

  const totalEstimatedCostUsd = roundUsd(
    deficitCells.reduce((a, c) => a + c.estimatedCostUsd, 0),
  );
  const overCeiling = maxCostUsd != null && totalEstimatedCostUsd > maxCostUsd;
  const cohortComplete = deficitCells.length === 0;

  return {
    cohort: {
      model: cohort.model,
      frameworkVersion: cohort.frameworkVersion,
      benchmarkVersion: cohort.benchmarkVersion,
    },
    arms: [...arms],
    nOverride: nOverride ?? null,
    maxCostUsd: maxCostUsd ?? null,
    cohortComplete,
    cells,
    deficitCells,
    totalDeficitRuns: deficitCells.reduce((a, c) => a + c.deficit, 0),
    totalEstimatedCostUsd,
    overCeiling,
  };
}

/**
 * Reduce a top-up plan to the CI fan-out matrix (`{ include: [...] }`),
 * allocating the invocation's `maxCostUsd` ceiling across the deficit cells
 * PROPORTIONALLY to each cell's estimated cost rather than a flat
 * `maxCostUsd / cells.length` split. The flat split starves an expensive
 * epic-scope cell (which needs a large per-cell ceiling for its in-loop stop)
 * while over-funding a cheap hello-world cell; a weighted split gives each cell
 * a ceiling scaled to what it is actually expected to spend. Each cell's share
 * is floored at `minCellCostUsd` so a zero-estimate cell still carries a usable
 * (non-zero) ceiling. When no cell carries a positive estimate the ceiling is
 * split evenly. PURE — no I/O, no clock.
 *
 * @param {ReturnType<typeof planTopup>} plan
 * @param {number|null} [maxCostUsd]  Ceiling to split; falls back to
 *   `plan.maxCostUsd` when null/non-finite.
 * @param {object} [opts]
 * @param {number} [opts.minCellCostUsd=0.01]  Per-cell allocation floor (USD).
 * @returns {{ include: Array<{ scenario: string, arm: string, deficit: number, allocatedCostUsd: number }> }}
 */
export function allocateMatrix(
  plan,
  maxCostUsd = null,
  { minCellCostUsd = 0.01 } = {},
) {
  const cells = Array.isArray(plan?.deficitCells) ? plan.deficitCells : [];
  const requested = Number(maxCostUsd);
  const ceiling =
    maxCostUsd != null && Number.isFinite(requested)
      ? requested
      : Number(plan?.maxCostUsd) || 0;

  const totalWeight = cells.reduce(
    (a, c) => a + (Number(c.estimatedCostUsd) || 0),
    0,
  );

  const include = cells.map((c) => {
    const weight = Number(c.estimatedCostUsd) || 0;
    const share =
      totalWeight > 0
        ? ceiling * (weight / totalWeight)
        : cells.length > 0
          ? ceiling / cells.length
          : 0;
    return {
      scenario: c.scenario,
      arm: c.arm,
      deficit: c.deficit,
      allocatedCostUsd: roundUsd(Math.max(minCellCostUsd, share)),
    };
  });

  return { include };
}

// ---------------------------------------------------------------------------
// CLI ports + entry (each real effect injectable; no run.js coupling)
// ---------------------------------------------------------------------------

// The cohort-stamp version readers (`readFrameworkVersion`,
// `readBenchmarkVersion`) live in the shared leaf module
// `driver/version-readers.js` — imported above — so the planner and the run
// loop resolve the cohort triple from one definition (D-014). That module
// imports nothing from bench/run.js, so the planner's no-run-loop-coupling
// invariant is preserved. They are re-exported here to keep this module's
// public surface (and its CLI resolver below) unchanged.
export { readBenchmarkVersion, readFrameworkVersion };

/**
 * Default cohort-stamp resolver: the requested model plus the framework and
 * benchmark versions read from disk. Injectable so tests supply a fixed cohort.
 *
 * @param {{ sourceRoot: string, model: string }} args
 * @param {object} [deps]
 * @returns {{ model: string, frameworkVersion: string, benchmarkVersion: string }}
 */
export function defaultResolveCohort({ sourceRoot, model }, deps = {}) {
  return {
    model,
    frameworkVersion: readFrameworkVersion(sourceRoot, deps),
    benchmarkVersion: readBenchmarkVersion(sourceRoot, deps),
  };
}

/**
 * Default scenario loader: read each `<scenariosDir>/<id>/scenario.json`. A
 * missing / unreadable scenario file is skipped (a scenario the corpus knows
 * but the tree does not still yields no cell rather than crashing the plan).
 *
 * @param {{ scenarioIds: string[], scenariosDir: string }} args
 * @param {object} [deps]
 * @returns {Array<object>}
 */
export function defaultLoadScenarios({ scenarioIds, scenariosDir }, deps = {}) {
  const read = deps.readFileImpl ?? readFileSync;
  const scenarios = [];
  for (const id of scenarioIds) {
    try {
      const raw = read(path.join(scenariosDir, id, 'scenario.json'), 'utf8');
      const parsed = JSON.parse(raw);
      scenarios.push(parsed);
    } catch {
      // Skip an unreadable scenario file rather than aborting the whole plan.
    }
  }
  return scenarios;
}

/**
 * Parse the top-up planner CLI args. `--dry-run` is the documented invocation;
 * the planner never executes a run, so it is effectively always a dry plan.
 *
 * @param {string[]} [argv]
 * @returns {object}
 */
export function parseTopupCliArgs(argv = []) {
  const result = {
    help: false,
    dryRun: false,
    resultsDir: null,
    model: null,
    n: null,
    maxCostUsd: null,
    scenarios: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--results-dir') {
      result.resultsDir = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--model') {
      result.model = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--n') {
      const raw = argv[i + 1];
      result.n = raw != null ? Number(raw) : null;
      i += 1;
    } else if (arg === '--max-cost-usd') {
      const raw = argv[i + 1];
      result.maxCostUsd = raw != null ? Number(raw) : null;
      i += 1;
    } else if (arg === '--scenarios') {
      const raw = argv[i + 1];
      result.scenarios =
        raw != null
          ? raw
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : null;
      i += 1;
    }
  }
  return result;
}

const HELP_TEXT = `Usage: node bench/driver/topup-planner.js [--dry-run] [options]

Plan the cohort top-up: per (scenario × arm) cell, report how many valid runs
already exist for the resolved cohort triple (model, frameworkVersion,
benchmarkVersion), the deficit to reach each scenario's targetN, and the
estimated USD cost to close it. Prints the plan as JSON to stdout and exits 0
WITHOUT invoking any benchmark run.

Options:
  --dry-run              Plan only (the planner never executes runs).
  --results-dir <path>   Results corpus root (default: <repo>/results).
  --model <id>           Model id for the cohort stamp (default: BENCH_MODEL or
                         the pinned bench default).
  --n <count>            Uniform per-scenario targetN override (as BENCH_N).
  --max-cost-usd <usd>   Cost ceiling allocated across deficit cells.
  --scenarios <csv>      Scenario ids to plan (default: the 3-rung corpus).
  -h, --help             Print this help and exit 0.
`;

/**
 * Top-up planner CLI entry. `--help` prints usage and exits 0 without touching
 * disk. Otherwise it reads the corpus, loads the scenarios, resolves the cohort
 * stamp, and prints the plan JSON — every effect behind an injectable port, so
 * no real run is ever launched.
 *
 * @param {string[]} [argv]
 * @param {Record<string, string|undefined>} [env]
 * @param {object} [deps]
 * @returns {Promise<number>} the process exit code.
 */
export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  deps = {},
) {
  const logger = deps.logger ?? defaultCliLogger();
  const write = deps.write ?? ((s) => process.stdout.write(s));
  const args = parseTopupCliArgs(argv);

  if (args.help) {
    write(HELP_TEXT);
    return 0;
  }

  const sourceRoot = deps.sourceRoot ?? path.resolve(__dirname, '..', '..');
  const resultsDir =
    args.resultsDir ?? deps.resultsDir ?? path.join(sourceRoot, 'results');
  const scenariosDir =
    deps.scenariosDir ?? path.join(sourceRoot, 'bench', 'scenarios');
  const model = args.model ?? env.BENCH_MODEL ?? DEFAULT_BENCH_MODEL;
  const nOverride =
    args.n ?? (env.BENCH_N != null ? Number(env.BENCH_N) : null);
  const maxCostUsd =
    args.maxCostUsd ??
    (env.BENCH_MAX_COST_USD != null ? Number(env.BENCH_MAX_COST_USD) : null);
  const scenarioIds = args.scenarios ?? [...DEFAULT_SCENARIO_IDS];

  const readCorpus = deps.readCorpus ?? ((a) => aggregateScorecards(a));
  const loadScenarios = deps.loadScenarios ?? defaultLoadScenarios;
  const resolveCohort = deps.resolveCohort ?? defaultResolveCohort;

  let plan;
  try {
    const corpus = readCorpus({ resultsDir });
    const scenarios = loadScenarios({ scenarioIds, scenariosDir });
    const cohort = resolveCohort({ sourceRoot, env, model });
    plan = planTopup(
      { cohort, scenarios, corpus, nOverride, maxCostUsd },
      { isValid: deps.isValid },
    );
  } catch (err) {
    logger.error(`[topup-planner] FATAL: ${err?.message ?? err}`);
    return 1;
  }

  write(`${JSON.stringify(plan, null, 2)}\n`);
  return 0;
}

// Run when invoked directly (not when imported by tests).
runIfMain(import.meta.url, () => {
  main().then((code) => {
    process.exitCode = code;
  });
});
