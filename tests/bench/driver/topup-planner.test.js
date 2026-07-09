// tests/bench/driver/topup-planner.test.js
/**
 * Unit tests for bench/driver/topup-planner.js — Epic #84, Story #89.
 *
 * Verifies the cohort top-up planner:
 *   - `planTopup` is a PURE planning function: per (scenario × arm) cell the
 *     deficit is max(0, targetN - validRuns) where a corpus record only counts
 *     when it is schema-valid AND exact-triple-matched (model + frameworkVersion
 *     + benchmarkVersion) AND routingMismatch !== true,
 *   - targetN resolution matches bench/run.js H1 precedence (explicit override
 *     wins uniformly, else scenario.targetN / target_n, else 1),
 *   - a complete cohort reports cohortComplete with zero deficit cells,
 *   - cost estimates derive from observed per-run costUsd history, falling back
 *     to a static per-scenario estimate, and a max_cost_usd ceiling is allocated
 *     across deficit cells and marks the plan over-ceiling,
 *   - the CLI --dry-run prints per-cell deficit + estimated cost JSON and exits
 *     0 without invoking any run (all ports injected; no run.js coupling),
 *   - the ajv schema-validator dependency is declared in package.json.
 *
 * Every real effect (corpus read, scenario load, cohort resolve, stdout) is
 * INJECTED — no real disk read, no real `claude` session, no run is launched.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  allocateMatrix,
  DEFAULT_ARMS,
  defaultLoadScenarios,
  main,
  matchesCohort,
  parseTopupCliArgs,
  planTopup,
  resolveTargetN,
  scorecardValidator,
} from '../../../bench/driver/topup-planner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const COHORT = Object.freeze({
  model: 'claude-opus-4-8[1m]',
  frameworkVersion: '1.88.0',
  benchmarkVersion: '0.5.0',
});

/** A schema-valid scorecard base, loaded once from the shipped fixture. */
const SAMPLE = JSON.parse(
  readFileSync(
    path.join(REPO_ROOT, 'bench', 'fixtures', 'sample-scorecard.json'),
    'utf8',
  ),
);

/**
 * Build a schema-valid scorecard for a given cell, stamped with the requested
 * cohort triple. Overrides are shallow-merged so a test can flip one field
 * (e.g. benchmarkVersion, routingMismatch, costUsd) while keeping the record
 * schema-valid.
 */
function makeScorecard({
  scenario,
  arm,
  runId,
  cohort = COHORT,
  costUsd = 1.0,
  routingMismatch = false,
  overrides = {},
} = {}) {
  const sc = structuredClone(SAMPLE);
  sc.runId =
    runId ?? `${scenario}-${arm}-${Math.random().toString(36).slice(2)}`;
  sc.scenario = scenario;
  sc.arm = arm;
  sc.model = { ...sc.model, id: cohort.model };
  sc.frameworkVersion = cohort.frameworkVersion;
  sc.benchmarkVersion = cohort.benchmarkVersion;
  sc.routingMismatch = routingMismatch;
  if (arm === 'control') {
    // control has no routing pipeline; drop the mandrel-only routingVerdict.
    sc.routingVerdict = null;
  }
  sc.dimensions.efficiency.costUsd = costUsd;
  return { ...sc, ...overrides };
}

const SCENARIOS = [
  { id: 'hello-world', targetN: 4 },
  { id: 'story-scope', targetN: 8 },
];

// ---------------------------------------------------------------------------
// resolveTargetN — H1 precedence
// ---------------------------------------------------------------------------

test('resolveTargetN: explicit override wins uniformly over the scenario contract', () => {
  assert.equal(resolveTargetN({ id: 'x', targetN: 8 }, { nOverride: 2 }), 2);
});

test('resolveTargetN: falls back to the scenario targetN / target_n, else 1', () => {
  assert.equal(resolveTargetN({ id: 'x', targetN: 8 }), 8);
  assert.equal(resolveTargetN({ id: 'x', target_n: 6 }), 6);
  assert.equal(resolveTargetN({ id: 'x' }), 1);
});

// ---------------------------------------------------------------------------
// matchesCohort — the exact triple
// ---------------------------------------------------------------------------

test('matchesCohort: matches only on the exact (model, frameworkVersion, benchmarkVersion) triple', () => {
  const sc = makeScorecard({ scenario: 'hello-world', arm: 'mandrel' });
  assert.equal(matchesCohort(sc, COHORT), true);
  assert.equal(
    matchesCohort(sc, { ...COHORT, frameworkVersion: '1.70.0' }),
    false,
  );
  assert.equal(
    matchesCohort(sc, { ...COHORT, benchmarkVersion: '0.4.0' }),
    false,
  );
  assert.equal(matchesCohort(sc, { ...COHORT, model: 'other' }), false);
});

// ---------------------------------------------------------------------------
// planTopup — deficit counting (schema-valid + triple-matched + not mismatch)
// ---------------------------------------------------------------------------

test('planTopup: per-cell deficit is max(0, targetN - validRuns) over valid records only', () => {
  const corpus = [
    // hello-world / mandrel: 2 valid runs → deficit 2 (targetN 4)
    makeScorecard({ scenario: 'hello-world', arm: 'mandrel' }),
    makeScorecard({ scenario: 'hello-world', arm: 'mandrel' }),
    // a wrong-cohort record must NOT credit the cell
    makeScorecard({
      scenario: 'hello-world',
      arm: 'mandrel',
      cohort: { ...COHORT, benchmarkVersion: '0.4.0' },
    }),
    // a routing-mismatch record must NOT credit the cell (it is a deficit)
    makeScorecard({
      scenario: 'hello-world',
      arm: 'mandrel',
      routingMismatch: true,
    }),
    // a schema-invalid record must NOT credit the cell (missing runId)
    makeScorecard({
      scenario: 'hello-world',
      arm: 'mandrel',
      overrides: { runId: '' },
    }),
    // hello-world / control: 4 valid runs → deficit 0
    ...Array.from({ length: 4 }, () =>
      makeScorecard({ scenario: 'hello-world', arm: 'control' }),
    ),
  ];

  const plan = planTopup({
    cohort: COHORT,
    scenarios: [{ id: 'hello-world', targetN: 4 }],
    corpus,
  });

  const mandrel = plan.cells.find(
    (c) => c.scenario === 'hello-world' && c.arm === 'mandrel',
  );
  const control = plan.cells.find(
    (c) => c.scenario === 'hello-world' && c.arm === 'control',
  );
  assert.equal(mandrel.validRuns, 2);
  assert.equal(mandrel.deficit, 2);
  assert.equal(control.validRuns, 4);
  assert.equal(control.deficit, 0);
  assert.equal(plan.cohortComplete, false);
  // Only the mandrel cell is a deficit cell.
  assert.equal(plan.deficitCells.length, 1);
  assert.equal(plan.deficitCells[0].arm, 'mandrel');
});

test('planTopup: default arms are mandrel + control', () => {
  const plan = planTopup({
    cohort: COHORT,
    scenarios: [{ id: 'hello-world', targetN: 1 }],
    corpus: [],
  });
  assert.deepEqual(plan.arms, [...DEFAULT_ARMS]);
  // Two empty cells → both fully deficit.
  assert.equal(plan.cells.length, 2);
});

// ---------------------------------------------------------------------------
// planTopup — complete cohort
// ---------------------------------------------------------------------------

test('planTopup: a complete cohort reports cohortComplete with zero deficit cells', () => {
  const corpus = [];
  for (const { id, targetN } of SCENARIOS) {
    for (const arm of DEFAULT_ARMS) {
      for (let i = 0; i < targetN; i += 1) {
        corpus.push(
          makeScorecard({ scenario: id, arm, runId: `${id}-${arm}-${i}` }),
        );
      }
    }
  }

  const plan = planTopup({ cohort: COHORT, scenarios: SCENARIOS, corpus });

  assert.equal(plan.cohortComplete, true);
  assert.deepEqual(plan.deficitCells, []);
  assert.equal(plan.totalDeficitRuns, 0);
  assert.equal(plan.totalEstimatedCostUsd, 0);
  assert.equal(plan.overCeiling, false);
  for (const cell of plan.cells) assert.equal(cell.deficit, 0);
});

// ---------------------------------------------------------------------------
// planTopup — cost estimation + ceiling
// ---------------------------------------------------------------------------

test('planTopup: per-run cost derives from observed costUsd history (mean of the cell)', () => {
  const corpus = [
    makeScorecard({ scenario: 'hello-world', arm: 'mandrel', costUsd: 2.0 }),
    makeScorecard({ scenario: 'hello-world', arm: 'mandrel', costUsd: 4.0 }),
  ];
  const plan = planTopup({
    cohort: COHORT,
    scenarios: [{ id: 'hello-world', targetN: 4 }],
    corpus,
    arms: ['mandrel'],
  });
  const cell = plan.cells[0];
  assert.equal(cell.costSource, 'observed');
  assert.equal(cell.perRunCostUsd, 3.0); // mean(2, 4)
  assert.equal(cell.deficit, 2); // 4 - 2 valid
  assert.equal(cell.estimatedCostUsd, 6.0); // 2 × 3.0
});

test('planTopup: falls back to the static per-scenario estimate when no cost history exists', () => {
  const plan = planTopup({
    cohort: COHORT,
    scenarios: [{ id: 'hello-world', targetN: 3 }],
    corpus: [],
    arms: ['mandrel'],
    staticCostByScenario: { 'hello-world': 0.5 },
  });
  const cell = plan.cells[0];
  assert.equal(cell.costSource, 'static');
  assert.equal(cell.perRunCostUsd, 0.5);
  assert.equal(cell.deficit, 3);
  assert.equal(cell.estimatedCostUsd, 1.5); // 3 × 0.5
});

test('planTopup: a max_cost_usd ceiling is allocated across deficit cells and marks the plan over-ceiling', () => {
  // Two deficit cells, each 2 runs × $3 = $6 → total $12; ceiling $8.
  const corpus = [
    makeScorecard({ scenario: 'hello-world', arm: 'mandrel', costUsd: 3.0 }),
    makeScorecard({ scenario: 'hello-world', arm: 'mandrel', costUsd: 3.0 }),
    makeScorecard({ scenario: 'story-scope', arm: 'mandrel', costUsd: 3.0 }),
    makeScorecard({ scenario: 'story-scope', arm: 'mandrel', costUsd: 3.0 }),
  ];
  const plan = planTopup({
    cohort: COHORT,
    scenarios: [
      { id: 'hello-world', targetN: 4 },
      { id: 'story-scope', targetN: 4 },
    ],
    corpus,
    arms: ['mandrel'],
    maxCostUsd: 8,
  });

  assert.equal(plan.totalEstimatedCostUsd, 12);
  assert.equal(plan.overCeiling, true);
  assert.equal(plan.deficitCells.length, 2);
  // First cell cumulative $6 ≤ $8 → within ceiling; second cell cumulative $12 > $8 → over.
  assert.equal(plan.deficitCells[0].cumulativeCostUsd, 6);
  assert.equal(plan.deficitCells[0].overCeiling, false);
  assert.equal(plan.deficitCells[1].cumulativeCostUsd, 12);
  assert.equal(plan.deficitCells[1].overCeiling, true);
});

test('planTopup: no ceiling leaves every deficit cell within-ceiling and the plan not over', () => {
  const plan = planTopup({
    cohort: COHORT,
    scenarios: [{ id: 'hello-world', targetN: 2 }],
    corpus: [],
    arms: ['mandrel'],
  });
  assert.equal(plan.overCeiling, false);
  assert.equal(plan.deficitCells[0].overCeiling, false);
});

test('planTopup: rejects a cohort missing a stamp field', () => {
  assert.throws(
    () =>
      planTopup({
        cohort: { model: 'x', frameworkVersion: '1.0.0' },
        scenarios: [],
        corpus: [],
      }),
    /benchmarkVersion is required/,
  );
});

// ---------------------------------------------------------------------------
// scorecardValidator — the schema-validity gate
// ---------------------------------------------------------------------------

test('scorecardValidator: accepts a schema-valid scorecard and rejects a malformed one', () => {
  const isValid = scorecardValidator();
  const good = makeScorecard({ scenario: 'hello-world', arm: 'mandrel' });
  assert.equal(isValid(good), true);
  const bad = makeScorecard({ scenario: 'hello-world', arm: 'mandrel' });
  delete bad.dimensions; // required by the schema
  assert.equal(isValid(bad), false);
});

// ---------------------------------------------------------------------------
// CLI — --dry-run prints JSON, exits 0, invokes no run
// ---------------------------------------------------------------------------

test('main: --dry-run prints per-cell deficit + estimated cost JSON and exits 0 without invoking any run', async () => {
  const corpus = [
    makeScorecard({ scenario: 'hello-world', arm: 'mandrel', costUsd: 2.0 }),
  ];
  let captured = '';
  const readCorpusCalls = [];

  const code = await main(
    ['--dry-run'],
    {},
    {
      write: (s) => {
        captured += s;
      },
      readCorpus: (args) => {
        readCorpusCalls.push(args);
        return corpus;
      },
      loadScenarios: () => [{ id: 'hello-world', targetN: 4 }],
      resolveCohort: () => COHORT,
      logger: { info() {}, warn() {}, error() {} },
    },
  );

  assert.equal(code, 0);
  assert.equal(readCorpusCalls.length, 1);
  const plan = JSON.parse(captured);
  assert.equal(plan.cohortComplete, false);
  const mandrel = plan.cells.find(
    (c) => c.scenario === 'hello-world' && c.arm === 'mandrel',
  );
  assert.equal(mandrel.deficit, 3); // 4 - 1 valid
  assert.equal(mandrel.perRunCostUsd, 2.0);
  assert.equal(mandrel.estimatedCostUsd, 6.0); // 3 × 2.0
  assert.ok(Array.isArray(plan.deficitCells));
});

test('main: --help prints usage and exits 0 without reading the corpus', async () => {
  let captured = '';
  let corpusRead = false;
  const code = await main(
    ['--help'],
    {},
    {
      write: (s) => {
        captured += s;
      },
      readCorpus: () => {
        corpusRead = true;
        return [];
      },
      logger: { info() {}, warn() {}, error() {} },
    },
  );
  assert.equal(code, 0);
  assert.equal(corpusRead, false);
  assert.match(captured, /Usage: node bench\/driver\/topup-planner\.js/);
});

test('main: a port failure is reported and exits non-zero', async () => {
  const errors = [];
  const code = await main(
    ['--dry-run'],
    {},
    {
      write: () => {},
      readCorpus: () => {
        throw new Error('corpus boom');
      },
      logger: { info() {}, warn() {}, error: (m) => errors.push(m) },
    },
  );
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /corpus boom/);
});

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

test('parseTopupCliArgs: parses every flag', () => {
  const args = parseTopupCliArgs([
    '--dry-run',
    '--results-dir',
    '/tmp/r',
    '--model',
    'm1',
    '--n',
    '3',
    '--max-cost-usd',
    '9.5',
    '--scenarios',
    'hello-world, story-scope',
  ]);
  assert.equal(args.dryRun, true);
  assert.equal(args.resultsDir, '/tmp/r');
  assert.equal(args.model, 'm1');
  assert.equal(args.n, 3);
  assert.equal(args.maxCostUsd, 9.5);
  assert.deepEqual(args.scenarios, ['hello-world', 'story-scope']);
});

// ---------------------------------------------------------------------------
// defaultLoadScenarios — reads scenario.json, skips missing files
// ---------------------------------------------------------------------------

test('defaultLoadScenarios: reads scenario.json per id and skips unreadable ones', () => {
  const scenarios = defaultLoadScenarios(
    { scenarioIds: ['hello-world', 'does-not-exist'], scenariosDir: 'X' },
    {
      readFileImpl: (p) => {
        if (p.includes('hello-world'))
          return JSON.stringify({ id: 'hello-world', targetN: 4 });
        throw new Error('ENOENT');
      },
    },
  );
  assert.equal(scenarios.length, 1);
  assert.equal(scenarios[0].id, 'hello-world');
});

// ---------------------------------------------------------------------------
// Dependency declaration + no run.js coupling (structural guards)
// ---------------------------------------------------------------------------

test('package.json declares the ajv schema-validator dependency the planner imports directly', () => {
  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  );
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(deps.ajv, 'ajv must be declared in package.json');
  assert.ok(
    deps['ajv-formats'],
    'ajv-formats must be declared in package.json',
  );
});

test('the planner source imports no run-loop code (no coupling to bench/run.js)', () => {
  const src = readFileSync(
    path.join(REPO_ROOT, 'bench', 'driver', 'topup-planner.js'),
    'utf8',
  );
  assert.doesNotMatch(src, /from ['"][.]{2}\/run\.js['"]/);
  assert.doesNotMatch(src, /runFirstBenchmark|runOneRun/);
});

// ---------------------------------------------------------------------------
// allocateMatrix — weighted per-cell cost allocation (M5)
// ---------------------------------------------------------------------------

test('allocateMatrix: splits the ceiling PROPORTIONALLY to each cell estimatedCostUsd, not flat', () => {
  const plan = {
    maxCostUsd: 100,
    deficitCells: [
      {
        scenario: 'hello-world',
        arm: 'mandrel',
        deficit: 1,
        estimatedCostUsd: 1,
      },
      {
        scenario: 'epic-scope',
        arm: 'mandrel',
        deficit: 3,
        estimatedCostUsd: 9,
      },
    ],
  };
  const { include } = allocateMatrix(plan);
  // Total weight = 10; cheap cell gets 100 * 1/10 = 10, expensive gets 90.
  assert.equal(include[0].allocatedCostUsd, 10);
  assert.equal(include[1].allocatedCostUsd, 90);
  // The whole ceiling is distributed, and the expensive cell is NOT starved by
  // a flat 50/50 split.
  assert.equal(include[0].allocatedCostUsd + include[1].allocatedCostUsd, 100);
  assert.notEqual(include[0].allocatedCostUsd, include[1].allocatedCostUsd);
});

test('allocateMatrix: carries scenario, arm and deficit through unchanged', () => {
  const plan = {
    maxCostUsd: 50,
    deficitCells: [
      {
        scenario: 'story-scope',
        arm: 'control',
        deficit: 2,
        estimatedCostUsd: 5,
      },
    ],
  };
  const { include } = allocateMatrix(plan);
  assert.equal(include.length, 1);
  assert.deepEqual(
    {
      scenario: include[0].scenario,
      arm: include[0].arm,
      deficit: include[0].deficit,
    },
    { scenario: 'story-scope', arm: 'control', deficit: 2 },
  );
});

test('allocateMatrix: an explicit maxCostUsd arg overrides plan.maxCostUsd', () => {
  const plan = {
    maxCostUsd: 100,
    deficitCells: [
      {
        scenario: 'hello-world',
        arm: 'mandrel',
        deficit: 1,
        estimatedCostUsd: 2,
      },
      {
        scenario: 'epic-scope',
        arm: 'mandrel',
        deficit: 1,
        estimatedCostUsd: 2,
      },
    ],
  };
  const { include } = allocateMatrix(plan, 20);
  // Even weights ⇒ even split of the overriding ceiling (20), not 100.
  assert.equal(include[0].allocatedCostUsd, 10);
  assert.equal(include[1].allocatedCostUsd, 10);
});

test('allocateMatrix: falls back to an even split when no cell has a positive estimate', () => {
  const plan = {
    maxCostUsd: 30,
    deficitCells: [
      { scenario: 'a', arm: 'mandrel', deficit: 1, estimatedCostUsd: 0 },
      { scenario: 'b', arm: 'mandrel', deficit: 1, estimatedCostUsd: 0 },
      { scenario: 'c', arm: 'mandrel', deficit: 1, estimatedCostUsd: 0 },
    ],
  };
  const { include } = allocateMatrix(plan);
  for (const cell of include) assert.equal(cell.allocatedCostUsd, 10);
});

test('allocateMatrix: floors a tiny share at the per-cell minimum (never zero)', () => {
  const plan = {
    maxCostUsd: 100,
    deficitCells: [
      {
        scenario: 'tiny',
        arm: 'mandrel',
        deficit: 1,
        estimatedCostUsd: 0.0001,
      },
      {
        scenario: 'huge',
        arm: 'mandrel',
        deficit: 1,
        estimatedCostUsd: 1000000,
      },
    ],
  };
  const { include } = allocateMatrix(plan);
  assert.ok(
    include[0].allocatedCostUsd >= 0.01,
    'the near-zero-weight cell is floored, never allocated 0',
  );
});

test('allocateMatrix: an empty deficit list yields an empty include', () => {
  assert.deepEqual(allocateMatrix({ maxCostUsd: 100, deficitCells: [] }), {
    include: [],
  });
  assert.deepEqual(allocateMatrix({}), { include: [] });
});
