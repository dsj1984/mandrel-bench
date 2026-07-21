// tests/bench/run-chain.test.js
/**
 * Unit tests for bench/run-chain.js — touch-chain semantics (issue #124,
 * PR-C). Fully fixture-driven via the same injected-deps pattern as
 * tests/bench/run.test.js: no live `claude` session, no real git remote, no
 * network, no disk. The assertions prove:
 *
 *   - the pure helpers (touch normalization, advance decision, pass-rate,
 *     dimension aggregation, chain block, cost fold, arm-3 fixture
 *     resolution) behave,
 *   - `runTouchChain` walks the chain per design §3 — advance (force-push
 *     baseline), skip-forward (seed from last-good), unmaterialized-delivery
 *     null, per-touch raw telemetry + the chain.ndjson ledger — and emits a
 *     SCHEMA-VALID one-record-per-cell scorecard with the `chain` block and
 *     the `chain-aggregate-dimensions` warning, and
 *   - `runOneRun` routes `touches[]` scenarios to the chain while the
 *     `changeRequest` path stays untouched (its own tests keep passing).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { loadScenario, runFirstBenchmark, runOneRun } from '../../bench/run.js';
import {
  aggregateChainDimensions,
  baseSuitePassRate,
  buildChainBlock,
  CHAIN_AGGREGATE_DIMENSIONS_WARNING,
  cellCostUsd,
  chainAdvanceDecision,
  DEFAULT_CHAIN_ADVANCE_THRESHOLD,
  normalizeScenarioTouches,
  resolveChainAdvanceThreshold,
  resolveControlClaudeMdFixture,
  runTouchChain,
} from '../../bench/run-chain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

const SCHEMA = JSON.parse(
  readFileSync(
    path.join(REPO, 'bench', 'schemas', 'scorecard.schema.json'),
    'utf8',
  ),
);
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validateScorecard = ajv.compile(SCHEMA);

// ---------------------------------------------------------------------------
// normalizeScenarioTouches
// ---------------------------------------------------------------------------

const CHAIN_SCENARIO = {
  id: 'brownfield-longitudinal',
  routing: 'story',
  targetN: 1,
  chainAdvanceThreshold: 0.9,
  app: { startCommand: 'npm start', readinessPath: '/healthz' },
  touches: [
    { id: 'credit-notes', prompt: 'Add credit notes end-to-end.' },
    { id: 'role-enforcement', prompt: 'Enforce admin/member roles.' },
  ],
};

test('normalizeScenarioTouches: inline prompts normalize with 1-based indexes', () => {
  const touches = normalizeScenarioTouches(CHAIN_SCENARIO, '/scen');
  assert.equal(touches.length, 2);
  assert.deepEqual(
    touches.map((t) => [t.index, t.id]),
    [
      [1, 'credit-notes'],
      [2, 'role-enforcement'],
    ],
  );
  assert.equal(touches[0].prompt, 'Add credit notes end-to-end.');
  assert.deepEqual(touches[0].supersedes, []);
  assert.equal(touches[0].acceptanceSuite, null);
});

test('normalizeScenarioTouches: promptPath reads the prompt from the scenario dir', () => {
  const reads = [];
  const touches = normalizeScenarioTouches(
    {
      touches: [
        {
          id: 'credit-notes',
          promptPath: './touches/1/prompt.md',
          acceptanceSuite: './touches/1/acceptance.test.js',
          supersedes: ['orders.list.default-page-size'],
        },
      ],
    },
    '/scen',
    {
      readFileImpl: (p) => {
        reads.push(p);
        return 'Prompt text from disk.';
      },
    },
  );
  assert.equal(touches[0].prompt, 'Prompt text from disk.');
  assert.equal(reads[0], path.join('/scen', './touches/1/prompt.md'));
  assert.equal(touches[0].acceptanceSuite, './touches/1/acceptance.test.js');
  assert.deepEqual(touches[0].supersedes, ['orders.list.default-page-size']);
});

test('normalizeScenarioTouches: validation failures throw', () => {
  assert.throws(() => normalizeScenarioTouches({ touches: [] }, '/s'), {
    name: 'TypeError',
    message: /non-empty array/,
  });
  assert.throws(
    () =>
      normalizeScenarioTouches(
        { touches: [{ id: 'a', prompt: 'p' }], changeRequest: { id: 'x' } },
        '/s',
      ),
    /mutually exclusive/,
  );
  assert.throws(
    () => normalizeScenarioTouches({ touches: [{ prompt: 'p' }] }, '/s'),
    /\.id must be a non-empty string/,
  );
  assert.throws(
    () =>
      normalizeScenarioTouches(
        {
          touches: [
            { id: 'a', prompt: 'p' },
            { id: 'a', prompt: 'q' },
          ],
        },
        '/s',
      ),
    /not unique/,
  );
  // Exactly one of prompt | promptPath.
  assert.throws(
    () =>
      normalizeScenarioTouches(
        { touches: [{ id: 'a', prompt: 'p', promptPath: './x.md' }] },
        '/s',
      ),
    /exactly one of prompt or promptPath/,
  );
  assert.throws(
    () => normalizeScenarioTouches({ touches: [{ id: 'a' }] }, '/s'),
    /exactly one of prompt or promptPath/,
  );
  assert.throws(
    () =>
      normalizeScenarioTouches(
        { touches: [{ id: 'a', prompt: 'p', supersedes: [1] }] },
        '/s',
      ),
    /supersedes must be an array/,
  );
  // promptPath with no scenario dir to resolve against.
  assert.throws(
    () =>
      normalizeScenarioTouches(
        { touches: [{ id: 'a', promptPath: './p.md' }] },
        null,
        { readFileImpl: () => 'x' },
      ),
    /requires a scenario directory/,
  );
});

// ---------------------------------------------------------------------------
// Pure decision helpers
// ---------------------------------------------------------------------------

test('resolveChainAdvanceThreshold: declared value wins, out-of-range/absent falls back to 0.90', () => {
  assert.equal(
    resolveChainAdvanceThreshold({ chainAdvanceThreshold: 0.75 }),
    0.75,
  );
  assert.equal(
    resolveChainAdvanceThreshold({}),
    DEFAULT_CHAIN_ADVANCE_THRESHOLD,
  );
  assert.equal(
    resolveChainAdvanceThreshold({ chainAdvanceThreshold: 1.5 }),
    DEFAULT_CHAIN_ADVANCE_THRESHOLD,
  );
  assert.equal(
    resolveChainAdvanceThreshold({ chainAdvanceThreshold: 'high' }),
    DEFAULT_CHAIN_ADVANCE_THRESHOLD,
  );
});

test('baseSuitePassRate: retained arithmetic, vacuous 1 on empty retained, null on no verdict', () => {
  assert.equal(
    baseSuitePassRate({ base: { retainedTotal: 100, retainedPassed: 95 } }),
    0.95,
  );
  assert.equal(
    baseSuitePassRate({ base: { retainedTotal: 0, retainedPassed: 0 } }),
    1,
  );
  assert.equal(baseSuitePassRate(null), null);
  assert.equal(baseSuitePassRate({}), null);
});

test('chainAdvanceDecision: fails closed on any missing gate', () => {
  const ok = {
    delivered: true,
    appBoots: true,
    baseSuitePassRate: 0.95,
    threshold: 0.9,
  };
  assert.equal(chainAdvanceDecision(ok), true);
  assert.equal(chainAdvanceDecision({ ...ok, baseSuitePassRate: 0.9 }), true);
  assert.equal(chainAdvanceDecision({ ...ok, delivered: false }), false);
  assert.equal(chainAdvanceDecision({ ...ok, appBoots: false }), false);
  assert.equal(chainAdvanceDecision({ ...ok, appBoots: null }), false);
  assert.equal(chainAdvanceDecision({ ...ok, baseSuitePassRate: 0.89 }), false);
  assert.equal(chainAdvanceDecision({ ...ok, baseSuitePassRate: null }), false);
});

test('aggregateChainDimensions: shape-preserving mean — floats averaged, integers rounded, booleans ORed, warnings unioned, all-null stays null', () => {
  const dims = (score, tokens, secrets, warnings) => ({
    quality: { score, frozenSuitePassRate: score },
    efficiency: { totalTokens: tokens, costUsd: score, wallClockMs: 100 },
    security: { secretsDetected: secrets, warnings, judge: null },
  });
  const agg = aggregateChainDimensions([
    dims(0.8, 11, false, ['a']),
    dims(0.6, 12, true, ['b']),
  ]);
  assert.ok(Math.abs(agg.quality.score - 0.7) < 1e-9);
  // 11.5 rounds because both inputs were integers (schema integer fields).
  assert.equal(agg.efficiency.totalTokens, 12);
  assert.equal(agg.security.secretsDetected, true);
  assert.deepEqual(agg.security.warnings, ['a', 'b']);
  assert.equal(agg.security.judge, null);
  assert.throws(() => aggregateChainDimensions([]), TypeError);
});

test('buildChainBlock: landedCount counts merged touches plus advanced touches where landing is not a concept; costPerLandedChange sums EVERY touch cost', () => {
  const block = buildChainBlock({
    touches: [
      { landed: true, advanced: true, cost: 10 },
      { landed: false, advanced: true, cost: 4 }, // unlanded-but-advanced: numerator only
      { landed: null, advanced: true, cost: 2 }, // control-style advanced ⇒ landed
      { landed: null, advanced: false, cost: 1 },
    ],
    threshold: 0.9,
  });
  assert.equal(block.landedCount, 2);
  assert.equal(block.costPerLandedChange, 17 / 2);
  assert.equal(block.advanceThreshold, 0.9);

  const none = buildChainBlock({
    touches: [{ landed: false, advanced: false, cost: 5 }],
    threshold: 0.9,
  });
  assert.equal(none.landedCount, 0);
  assert.equal(none.costPerLandedChange, null);
});

test('cellCostUsd: chain records sum touches[].cost; non-chain records keep the efficiency + touch2 fold', () => {
  assert.equal(
    cellCostUsd({
      dimensions: { efficiency: { costUsd: 0.5 } }, // per-touch MEAN — must NOT be added
      chain: { touches: [{ cost: 0.4 }, { cost: 0.6 }, { cost: null }] },
    }),
    1.0,
  );
  assert.equal(
    cellCostUsd({
      dimensions: { efficiency: { costUsd: 0.42 } },
      touch2: { cost: 0.3 },
    }),
    0.72,
  );
  assert.equal(
    cellCostUsd({ dimensions: { efficiency: { costUsd: 0.42 } } }),
    0.42,
  );
  assert.equal(cellCostUsd({}), 0);
});

test('resolveControlClaudeMdFixture: null default, scenario-relative resolution, throws without a scenario dir', () => {
  assert.equal(resolveControlClaudeMdFixture({}, '/scen'), null);
  assert.equal(
    resolveControlClaudeMdFixture(
      { controlClaudeMd: './fixtures/claude.md' },
      '/scen',
    ),
    path.join('/scen', './fixtures/claude.md'),
  );
  assert.throws(
    () => resolveControlClaudeMdFixture({ controlClaudeMd: './x.md' }, null),
    /requires a scenario directory/,
  );
});

// ---------------------------------------------------------------------------
// loadScenario — touches[] support
// ---------------------------------------------------------------------------

test('loadScenario: a touches[] scenario loads normalized touches and imports NO acceptance module', async () => {
  let imported = 0;
  const { scenario, evaluate, scenarioDir, touch2Evaluate, touches } =
    await loadScenario('brownfield-longitudinal', {
      readFileImpl: () => JSON.stringify(CHAIN_SCENARIO),
      importImpl: async () => {
        imported += 1;
        return { evaluate: async () => ({}) };
      },
    });
  assert.equal(scenario.id, 'brownfield-longitudinal');
  assert.equal(evaluate, null);
  assert.equal(touch2Evaluate, null);
  assert.equal(imported, 0);
  assert.ok(
    scenarioDir.endsWith(path.join('scenarios', 'brownfield-longitudinal')),
  );
  assert.deepEqual(
    touches.map((t) => t.id),
    ['credit-notes', 'role-enforcement'],
  );
});

test('loadScenario: touches[] + changeRequest is rejected (mutually exclusive)', async () => {
  await assert.rejects(
    loadScenario('bad-chain', {
      readFileImpl: () =>
        JSON.stringify({
          ...CHAIN_SCENARIO,
          changeRequest: { id: 'x', prompt: 'p' },
        }),
      importImpl: async () => ({ evaluate: async () => ({}) }),
    }),
    /mutually exclusive/,
  );
});

test('loadScenario: a changeRequest scenario is untouched (touches: null, oracles loaded)', async () => {
  const { touches, evaluate, touch2Evaluate } = await loadScenario(
    'story-scope',
    {
      readFileImpl: () =>
        JSON.stringify({
          id: 'story-scope',
          seed: { prompt: 'p' },
          changeRequest: { id: 'cr', prompt: 'change it' },
        }),
      importImpl: async () => ({ evaluate: async () => ({}) }),
    },
  );
  assert.equal(touches, null);
  assert.equal(typeof evaluate, 'function');
  assert.equal(typeof touch2Evaluate, 'function');
});

// ---------------------------------------------------------------------------
// runTouchChain — fixture-driven chain walks
// ---------------------------------------------------------------------------

function fakeEnvelope() {
  return {
    isError: false,
    usage: {
      totalTokens: 12000,
      inputTokens: 10000,
      outputTokens: 2000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    cost: { totalUsd: 0.42 },
    modelUsage: { 'claude-opus-4-8': {} },
    raw: { type: 'result', total_cost_usd: 0.42 },
  };
}

/** A passing evolved-suite verdict at touch k (regression-free). */
function goodSuite(k) {
  return {
    touchIndex: k,
    base: {
      total: 100,
      retainedTotal: 98,
      retainedPassed: 98,
      retainedFailed: [],
      missing: [],
      supersededIds: ['a', 'b'],
      regressionRate: 0,
    },
    additions: {
      total: 10 * k,
      passed: 10 * k,
      failed: [],
      missing: [],
      byTouch: {},
    },
  };
}

/** A regressed evolved-suite verdict (pass rate 0.5 — below every threshold). */
function badSuite(k) {
  return {
    touchIndex: k,
    base: {
      total: 100,
      retainedTotal: 100,
      retainedPassed: 50,
      retainedFailed: ['x'],
      missing: [],
      supersededIds: [],
      regressionRate: 0.5,
    },
    additions: {
      total: 10 * k,
      passed: 0,
      failed: ['y'],
      missing: [],
      byTouch: {},
    },
  };
}

/**
 * Injected-deps bag for `runTouchChain`, simulating a per-cell repo whose
 * remote `main` the fake session auto-merges onto (mandrel landing). State
 * lives on `record`:
 *   - `record.remoteMainSha` — the simulated remote main tip,
 *   - `record.landPerTouch[k]` — SHA the touch-k session "merges" onto main
 *     (undefined ⇒ the session lands nothing: unmaterialized for mandrel),
 *   - `record.suitePerTouch[k]` — canned evolved-suite verdict per touch.
 */
function chainDeps(record) {
  let sessionCount = 0;
  let head = record.remoteMainSha;
  return {
    logger: { info() {}, warn() {} },
    provisionFn: (o) => {
      record.provisions.push({ arm: o.arm, baselineSha: o.baselineSha });
      return {
        workspacePath: `/ws-t${record.provisions.length}`,
        ephemeralRoot: '/tmp/root',
        arm: o.arm,
      };
    },
    teardownFn: (h) => record.teardowns.push(h.workspacePath),
    resetSandboxFn: (o) => {
      record.resets.push(o.sha ?? null);
      // A reset rewinds the simulated remote main (the real API PATCH).
      if (typeof o.sha === 'string') record.remoteMainSha = o.sha;
      return { reset: true, sha: o.sha ?? 'SEED' };
    },
    overlayFn: (o) => {
      record.overlays.push(o.arm);
      // Story #153/#161: the scenario must reach `overlayExcludePaths()` so
      // the package.json contract carve-out is reachable in production.
      record.overlayScenarioIds.push(o.scenario?.id ?? null);
      return { overlaid: true, arm: o.arm, copied: [] };
    },
    writeGatePackageJsonFn: (o) => {
      record.gatePackageJsonWrites.push(o.workspacePath);
      return { workspacePath: o.workspacePath, pkg: {} };
    },
    seedStaticClaudeMdFn: (o) => {
      record.claudeMdSeeds.push({
        workspacePath: o.workspacePath,
        fixturePath: o.fixturePath ?? null,
      });
      return { workspacePath: o.workspacePath, claudeMdPath: 'x', bytes: 1 };
    },
    runSessionFn: (o) => {
      sessionCount += 1;
      const k = sessionCount;
      record.sessions.push({ arm: o.arm, prompt: o.scenario.taskPrompt });
      // Simulate the mandrel /deliver auto-merge landing on remote main.
      const landSha = record.landPerTouch?.[k];
      if (landSha && o.arm.startsWith('mandrel')) {
        record.remoteMainSha = landSha;
      }
      return {
        arm: o.arm,
        scenarioId: o.scenario.id,
        model: o.model,
        prompt: 'p',
        status: 0,
        envelope: fakeEnvelope(),
        phases: o.arm.startsWith('mandrel')
          ? [
              { phase: 'plan', costUsd: 0.21, tokens: 6000, wallClockMs: 1000 },
              {
                phase: 'deliver',
                costUsd: 0.21,
                tokens: 6000,
                wallClockMs: 2000,
              },
            ]
          : null,
      };
    },
    gitFn: (args, cwd) => {
      record.git.push(`${cwd} ${args.join(' ')}`);
      if (args[0] === 'fetch') return '';
      if (args[0] === 'checkout') return '';
      if (args[0] === 'reset') {
        head = record.remoteMainSha; // reset --hard origin/main
        return '';
      }
      if (args[0] === 'add') return '';
      if (args[0] === '-c' && args.includes('commit')) {
        // The control arm's working-tree edits become a fresh commit; a
        // clean (already-committed) mandrel tree exits non-zero with
        // "nothing to commit" — exactly what real git does.
        const idx = Number(/t(\d+)$/.exec(cwd)?.[1] ?? 0);
        const arm = record.provisions[idx - 1]?.arm ?? 'control';
        if (arm.startsWith('mandrel')) {
          throw new Error('nothing to commit, working tree clean');
        }
        head = `${cwd.replaceAll('/', '')}-COMMIT`;
        return '';
      }
      if (args[0] === 'push') {
        record.pushes.push(`${cwd} ${args.join(' ')}`);
        record.remoteMainSha = head;
        return '';
      }
      if (args[0] === 'rev-parse') return `${head}\n`;
      return '';
    },
    withRunningAppFn: async (_o, fn) => fn('http://127.0.0.1:40000', {}),
    runEvolvedSuiteFn: ({ deliveredTreePath, touchIndex }) => {
      record.suiteRuns.push({ deliveredTreePath, touchIndex });
      const canned = record.suitePerTouch?.[touchIndex];
      if (canned instanceof Error) throw canned;
      return canned ?? goodSuite(touchIndex);
    },
    conventionEvaluators: [
      (tree) => {
        record.conventionScans.push(tree);
        return { class: 'error-envelope', clean: true, findings: [] };
      },
      () => ({
        class: 'money-integer',
        clean: false,
        findings: ['src/x.js:3 — parseFloat on amountCents'],
      }),
    ],
    collectMaintainabilityFn: () => ({
      objectiveMaintainabilityScore: 0.8,
      lintErrorCount: 2,
      complexityScore: 0.75,
      maintainabilityIndex: null,
    }),
    collectSecurityFn: () => ({
      secretScanCount: 0,
      depAuditVulnCount: 0,
      hasEdgeInputValidation: true,
      hasPasswordHashing: false,
      hasSafeTokenStorage: true,
      hasServerSideAuthz: false,
      hasAuthRateLimiting: false,
    }),
    runDimensionJudgeFn: async () => ({ maintainability: 0.85, security: 0.9 }),
    ghJson: () => [],
    discoverDeps: { existsImpl: () => false },
    nowFn: () => '2026-07-12T09:00:00.000Z',
    frameworkVersion: '1.91.0',
    benchmarkVersion: '0.11.0',
    env: { node: 'v24.16.0', os: 'darwin', host: 'test-host' },
    mkdirFn: (p) => record.mkdirs.push(p),
    writeFileFn: (p, data) => record.writes.push({ p, data }),
    appendFileFn: (p, data) => record.appended.push({ p, data }),
    readFileImpl: () => '',
    // For runFirstBenchmark-level tests (persist + checkpoint + report seams).
    persistDeps: {
      appendFileImpl: (p, data) => record.storeAppends.push({ p, data }),
      existsImpl: () => true,
      mkdirImpl: () => {},
      readFileImpl: (p) =>
        record.storeAppends
          .filter((a) => a.p === p)
          .map((a) => a.data)
          .join(''),
    },
    checkpointDeps: {
      existsImpl: () => false,
      readFileImpl: () => '',
      appendFileImpl: (p, data) => record.checkpointed.push({ p, data }),
      mkdirImpl: () => {},
    },
  };
}

function freshChainRecord(overrides = {}) {
  return {
    remoteMainSha: 'SEED',
    landPerTouch: {},
    suitePerTouch: {},
    provisions: [],
    teardowns: [],
    resets: [],
    overlays: [],
    overlayScenarioIds: [],
    gatePackageJsonWrites: [],
    claudeMdSeeds: [],
    sessions: [],
    git: [],
    pushes: [],
    suiteRuns: [],
    conventionScans: [],
    mkdirs: [],
    writes: [],
    appended: [],
    storeAppends: [],
    checkpointed: [],
    ...overrides,
  };
}

const SANDBOX = {
  repoUrl: 'https://github.com/dsj1984/bench-sbx-chain.git',
  owner: 'dsj1984',
  repo: 'bench-sbx-chain',
  baselineSha: 'SEED',
};

test('runTouchChain (mandrel): both touches advance — force-pushed baseline, per-touch raw + ledger, schema-valid chain scorecard', async () => {
  const record = freshChainRecord({
    landPerTouch: { 1: 'T1SHA', 2: 'T2SHA' },
    suitePerTouch: { 1: goodSuite(1), 2: goodSuite(2) },
  });
  const deps = chainDeps(record);
  const touches = normalizeScenarioTouches(CHAIN_SCENARIO, '/scen');

  const scorecard = await runTouchChain(
    {
      scenario: CHAIN_SCENARIO,
      touches,
      scenarioDir: '/scen',
      arm: 'mandrel',
      runIndex: 1,
      sandbox: SANDBOX,
      resultsDir: '/results',
    },
    deps,
  );

  // Schema-valid one-record-per-cell scorecard with the chain block.
  assert.ok(
    validateScorecard(scorecard),
    `scorecard invalid: ${JSON.stringify(validateScorecard.errors, null, 2)}`,
  );
  assert.equal(scorecard.scenario, 'brownfield-longitudinal');
  assert.ok(scorecard.warnings.includes(CHAIN_AGGREGATE_DIMENSIONS_WARNING));

  // Chain block: both touches landed (main advanced past the chain baseline)
  // and advanced; the second seeded from the first.
  // Every per-touch overlay carries the scenario, so `overlayExcludePaths()`
  // can consult its package.json contract (Story #153).
  assert.deepEqual(record.overlays, ['mandrel', 'mandrel']);
  assert.deepEqual(record.overlayScenarioIds, [
    'brownfield-longitudinal',
    'brownfield-longitudinal',
  ]);

  const chain = scorecard.chain;
  assert.equal(chain.advanceThreshold, 0.9);
  assert.equal(chain.landedCount, 2);
  assert.equal(chain.touches.length, 2);
  assert.deepEqual(
    chain.touches.map((t) => [
      t.touchIndex,
      t.changeRequestId,
      t.landed,
      t.materialized,
      t.advanced,
      t.seededFromTouch,
      t.appBoots,
    ]),
    [
      [1, 'credit-notes', true, true, true, 0, true],
      [2, 'role-enforcement', true, true, true, 1, true],
    ],
  );
  // Per-touch outcome/cost + regression + conventions + phases captured.
  for (const t of chain.touches) {
    assert.equal(typeof t.outcome, 'number');
    assert.equal(t.cost, 0.42);
    assert.equal(t.regression.retainedTotal, 98);
    assert.equal(t.regression.retainedPassed, 98);
    assert.equal(t.regression.regressionRate, 0);
    assert.equal(t.conventions.cleanRate, 0.5);
    assert.deepEqual(
      t.phases.map((p) => p.phase),
      ['plan', 'deliver'],
    );
    assert.ok(t.dimensions?.quality);
  }
  // costPerLandedChange = Σ cost / landedCount.
  assert.ok(Math.abs(chain.costPerLandedChange - 0.42) < 1e-9);

  // Two sessions, one per touch, carrying the touch prompts.
  assert.deepEqual(
    record.sessions.map((s) => s.prompt),
    ['Add credit notes end-to-end.', 'Enforce admin/member roles.'],
  );

  // The chain baseline ADVANCED: touch 2's clone seeds from touch 1's pushed
  // tree, and each advance force-pushed HEAD onto the per-cell repo's main.
  assert.deepEqual(
    record.provisions.map((p) => p.baselineSha),
    ['SEED', 'T1SHA'],
  );
  assert.equal(record.pushes.length, 2);
  assert.ok(
    record.pushes[0].includes('push --force origin HEAD:refs/heads/main'),
  );

  // The evolved suite ran at the right touch indexes against the right trees.
  assert.deepEqual(
    record.suiteRuns.map((r) => r.touchIndex),
    [1, 2],
  );

  // Per-touch raw telemetry landed under .raw/<stamp>/touch<k>/.
  const rawWrites = record.writes.map((w) => w.p);
  for (const k of [1, 2]) {
    const dir = path.join(
      '.raw',
      'brownfield-longitudinal-mandrel-r1',
      `touch${k}`,
    );
    assert.ok(
      rawWrites.some((p) => p.endsWith(path.join(dir, 'cost-envelope.json'))),
      `cost envelope for touch${k} persisted`,
    );
    assert.ok(
      rawWrites.some((p) => p.endsWith(path.join(dir, 'session-result.json'))),
      `session result for touch${k} persisted`,
    );
  }

  // The chain ledger: one NDJSON line per touch with the design §3 fields.
  const ledger = record.appended.filter((a) => a.p.endsWith('chain.ndjson'));
  assert.equal(ledger.length, 2);
  const lines = ledger.map((l) => JSON.parse(l.data));
  assert.deepEqual(lines[0], {
    touch: 1,
    headSha: 'T1SHA',
    landed: true,
    materialized: true,
    advanced: true,
    seededFromTouch: 0,
    baseSuite: { passed: 98, total: 98 },
    costUsd: 0.42,
  });
  assert.equal(lines[1].touch, 2);
  assert.equal(lines[1].seededFromTouch, 1);

  // Post-chain: main is rewound to the ORIGINAL seed baseline for the next
  // serial run, and every workspace was torn down.
  assert.equal(record.resets.at(-1), 'SEED');
  assert.equal(record.teardowns.length, 2);
});

test('runTouchChain: a failing base suite does NOT advance — main rewound to last-good, next touch seeds from the seed (skip-forward)', async () => {
  const record = freshChainRecord({
    landPerTouch: { 1: 'T1SHA', 2: 'T2SHA' },
    suitePerTouch: { 1: badSuite(1), 2: goodSuite(2) },
  });
  const deps = chainDeps(record);
  const touches = normalizeScenarioTouches(CHAIN_SCENARIO, '/scen');

  const scorecard = await runTouchChain(
    {
      scenario: CHAIN_SCENARIO,
      touches,
      scenarioDir: '/scen',
      arm: 'mandrel',
      runIndex: 1,
      sandbox: SANDBOX,
      resultsDir: '/results',
    },
    deps,
  );

  assert.ok(
    validateScorecard(scorecard),
    JSON.stringify(validateScorecard.errors, null, 2),
  );
  const [t1, t2] = scorecard.chain.touches;
  // Touch 1 landed (the PR auto-merged) but did NOT advance (pass rate 0.5).
  assert.equal(t1.landed, true);
  assert.equal(t1.advanced, false);
  assert.equal(t1.seededFromTouch, 0);
  assert.equal(t1.regression.regressionRate, 0.5);
  // The rewind reset main back to the seed baseline (last-good = touch 0)…
  assert.ok(record.resets.includes('SEED'));
  // …so touch 2 was provisioned from the SEED baseline, not touch 1's tree.
  assert.deepEqual(
    record.provisions.map((p) => p.baselineSha),
    ['SEED', 'SEED'],
  );
  // Touch 2 recovered: seeded from the seed, advanced.
  assert.equal(t2.seededFromTouch, 0);
  assert.equal(t2.advanced, true);
  assert.equal(t2.landed, true);
  // Only touch 2 force-pushed a new baseline.
  assert.equal(record.pushes.length, 1);
  // landedCount still counts BOTH (landed:true regardless of advance); every
  // touch's spend is in the numerator.
  assert.equal(scorecard.chain.landedCount, 2);
  assert.ok(Math.abs(scorecard.chain.costPerLandedChange - 0.42) < 1e-9);
});

test('runTouchChain: an unmaterialized mandrel delivery scores null outcome, skips the suite, and cannot advance', async () => {
  const record = freshChainRecord({
    landPerTouch: { 2: 'T2SHA' }, // touch 1 lands NOTHING (no merge, no branch)
    suitePerTouch: { 2: goodSuite(2) },
  });
  const deps = chainDeps(record);
  const touches = normalizeScenarioTouches(CHAIN_SCENARIO, '/scen');

  const scorecard = await runTouchChain(
    {
      scenario: CHAIN_SCENARIO,
      touches,
      scenarioDir: '/scen',
      arm: 'mandrel',
      runIndex: 1,
      sandbox: SANDBOX,
      resultsDir: '/results',
    },
    deps,
  );

  assert.ok(
    validateScorecard(scorecard),
    JSON.stringify(validateScorecard.errors, null, 2),
  );
  const [t1, t2] = scorecard.chain.touches;
  assert.equal(t1.materialized, false);
  assert.equal(t1.landed, false);
  assert.equal(t1.advanced, false);
  assert.equal(t1.outcome, null);
  assert.equal(t1.appBoots, null);
  assert.equal(t1.cost, 0.42); // real spend still recorded
  assert.equal('regression' in t1, false);
  // The suite ran ONLY for touch 2 — never against the stale seed tree.
  assert.deepEqual(
    record.suiteRuns.map((r) => r.touchIndex),
    [2],
  );
  // Ledger line records the unmaterialized touch honestly.
  const line1 = JSON.parse(
    record.appended.filter((a) => a.p.endsWith('chain.ndjson'))[0].data,
  );
  assert.equal(line1.materialized, false);
  assert.equal(line1.advanced, false);
  assert.deepEqual(line1.baseSuite, { passed: 0, total: 0 });
  // Touch 2 still recovered from the seed.
  assert.equal(t2.advanced, true);
  assert.equal(t2.seededFromTouch, 0);
  // Record-level dimensions aggregate ONLY the materialized touch (touch 2).
  assert.ok(scorecard.warnings.includes(CHAIN_AGGREGATE_DIMENSIONS_WARNING));
  assert.equal(scorecard.dimensions.quality.score, t2.dimensions.quality.score);
});

test('runTouchChain (control): one session per touch, commit+push advances, landed stays null, landedCount counts advanced touches', async () => {
  const record = freshChainRecord({
    suitePerTouch: { 1: goodSuite(1), 2: goodSuite(2) },
  });
  const deps = chainDeps(record);
  const touches = normalizeScenarioTouches(CHAIN_SCENARIO, '/scen');

  const scorecard = await runTouchChain(
    {
      scenario: CHAIN_SCENARIO,
      touches,
      scenarioDir: '/scen',
      arm: 'control',
      runIndex: 1,
      sandbox: SANDBOX,
      resultsDir: '/results',
    },
    deps,
  );

  assert.ok(
    validateScorecard(scorecard),
    JSON.stringify(validateScorecard.errors, null, 2),
  );
  // Control provisioning path: gate package.json per touch, no overlay.
  assert.equal(record.gatePackageJsonWrites.length, 2);
  assert.deepEqual(record.overlays, []);
  // One single-session run per touch (no phases block on the touches).
  assert.equal(record.sessions.length, 2);
  const [t1, t2] = scorecard.chain.touches;
  assert.equal('phases' in t1, false);
  // Landing is not a concept for control — but its committed+pushed advanced
  // touches ARE its landed changes.
  assert.equal(t1.landed, null);
  assert.equal(t1.advanced, true);
  assert.equal(t2.seededFromTouch, 1);
  assert.equal(scorecard.chain.landedCount, 2);
  // Both advances committed the working tree and force-pushed it as main.
  assert.equal(record.pushes.length, 2);
  const commits = record.git.filter((c) => c.includes(' commit '));
  assert.equal(commits.length, 2);
  // Touch 2 seeded from touch 1's pushed commit.
  assert.deepEqual(record.provisions[1].baselineSha, 'ws-t1-COMMIT');
});

test('runTouchChain: a failed force-push demotes the advance and seeds forward from last-good', async () => {
  const record = freshChainRecord({
    landPerTouch: { 1: 'T1SHA', 2: 'T2SHA' },
    suitePerTouch: { 1: goodSuite(1), 2: goodSuite(2) },
  });
  const deps = chainDeps(record);
  const baseGit = deps.gitFn;
  deps.gitFn = (args, cwd) => {
    if (args[0] === 'push' && cwd === '/ws-t1') {
      throw new Error('remote rejected');
    }
    return baseGit(args, cwd);
  };
  const touches = normalizeScenarioTouches(CHAIN_SCENARIO, '/scen');

  const scorecard = await runTouchChain(
    {
      scenario: CHAIN_SCENARIO,
      touches,
      scenarioDir: '/scen',
      arm: 'mandrel',
      runIndex: 1,
      sandbox: SANDBOX,
      resultsDir: '/results',
    },
    deps,
  );
  const [t1, t2] = scorecard.chain.touches;
  assert.equal(t1.advanced, false, 'a failed baseline push is not an advance');
  assert.equal(t2.seededFromTouch, 0);
  assert.deepEqual(
    record.provisions.map((p) => p.baselineSha),
    ['SEED', 'SEED'],
  );
});

test('runTouchChain: an app that fails to boot blocks the advance even with a green suite', async () => {
  const record = freshChainRecord({
    landPerTouch: { 1: 'T1SHA' },
    suitePerTouch: { 1: goodSuite(1) },
  });
  const deps = chainDeps(record);
  deps.withRunningAppFn = async () => {
    throw new Error('EADDRINUSE');
  };
  const touches = normalizeScenarioTouches(
    { ...CHAIN_SCENARIO, touches: [CHAIN_SCENARIO.touches[0]] },
    '/scen',
  );
  const scorecard = await runTouchChain(
    {
      scenario: CHAIN_SCENARIO,
      touches,
      scenarioDir: '/scen',
      arm: 'mandrel',
      runIndex: 1,
      sandbox: SANDBOX,
      resultsDir: '/results',
    },
    deps,
  );
  const [t1] = scorecard.chain.touches;
  assert.equal(t1.appBoots, false);
  assert.equal(t1.advanced, false);
  assert.equal(record.pushes.length, 0);
});

test('runTouchChain: fails fast when no suite-evolution runner is resolvable (a chain that can never advance is a config error)', async () => {
  const record = freshChainRecord();
  const deps = chainDeps(record);
  delete deps.runEvolvedSuiteFn;
  deps.importImpl = async () => {
    throw new Error('ENOENT');
  };
  await assert.rejects(
    runTouchChain(
      {
        scenario: CHAIN_SCENARIO,
        touches: normalizeScenarioTouches(CHAIN_SCENARIO, '/scen'),
        scenarioDir: '/scen',
        arm: 'mandrel',
        runIndex: 1,
        sandbox: SANDBOX,
        resultsDir: '/results',
      },
      deps,
    ),
    /suite-evolution/,
  );
  assert.equal(record.sessions.length, 0, 'no cost spent before the failure');
});

test('runTouchChain (control-claudemd): seeds the per-scenario CLAUDE.md fixture when the scenario declares one (review note 3)', async () => {
  const record = freshChainRecord({
    suitePerTouch: { 1: goodSuite(1), 2: goodSuite(2) },
  });
  const deps = chainDeps(record);
  const scenario = {
    ...CHAIN_SCENARIO,
    controlClaudeMd: './control-claudemd.md',
  };
  await runTouchChain(
    {
      scenario,
      touches: normalizeScenarioTouches(scenario, '/scen'),
      scenarioDir: '/scen',
      arm: 'control-claudemd',
      runIndex: 1,
      sandbox: SANDBOX,
      resultsDir: '/results',
    },
    deps,
  );
  assert.equal(record.claudeMdSeeds.length, 2);
  assert.equal(
    record.claudeMdSeeds[0].fixturePath,
    path.join('/scen', './control-claudemd.md'),
  );
});

// ---------------------------------------------------------------------------
// runOneRun routing + the arm-3 fixture seam on the NON-chain path
// ---------------------------------------------------------------------------

test('runOneRun: routes a touches[] scenario to the chain path (chain block present, no greenfield build session)', async () => {
  const record = freshChainRecord({
    landPerTouch: { 1: 'T1SHA', 2: 'T2SHA' },
    suitePerTouch: { 1: goodSuite(1), 2: goodSuite(2) },
  });
  const deps = chainDeps(record);
  const touches = normalizeScenarioTouches(CHAIN_SCENARIO, '/scen');

  const scorecard = await runOneRun(
    {
      scenario: CHAIN_SCENARIO,
      evaluate: null,
      scenarioDir: '/scen',
      touches,
      arm: 'mandrel',
      runIndex: 1,
      sandbox: SANDBOX,
      resultsDir: '/results',
    },
    deps,
  );
  assert.ok(scorecard.chain, 'chain block present');
  assert.equal(scorecard.chain.touches.length, 2);
  // Every session was a TOUCH session — the seed IS the baseline, so no
  // greenfield build-from-prompt session ran.
  assert.deepEqual(
    record.sessions.map((s) => s.prompt),
    ['Add credit notes end-to-end.', 'Enforce admin/member roles.'],
  );
});

test('runOneRun (control-claudemd, non-chain): threads the per-scenario CLAUDE.md fixture into the seeding call', async () => {
  const record = freshChainRecord();
  const deps = chainDeps(record);
  // Minimal non-chain scenario on the classic path.
  const scenario = {
    id: 'hello-world',
    seed: { prompt: 'Build it', acceptance: ['a'] },
    app: { startCommand: 'npm start', readinessPath: '/' },
    controlClaudeMd: './fixtures/scenario-claude.md',
  };
  const evaluate = async () => ({ criteria: [{ met: true }] });
  deps.scoreScenarioQualityFn = async () => ({
    frozen: { criteria: [{ met: true }] },
    crossCheck: { decision: 'proceed' },
  });
  const scorecard = await runOneRun(
    {
      scenario,
      evaluate,
      scenarioDir: '/scen',
      arm: 'control-claudemd',
      runIndex: 1,
      sandbox: SANDBOX,
      resultsDir: '/results',
    },
    deps,
  );
  assert.ok(
    validateScorecard(scorecard),
    JSON.stringify(validateScorecard.errors),
  );
  assert.equal(record.claudeMdSeeds.length, 1);
  assert.equal(
    record.claudeMdSeeds[0].fixturePath,
    path.join('/scen', './fixtures/scenario-claude.md'),
  );
});

// ---------------------------------------------------------------------------
// runFirstBenchmark — the BENCH_MAX_COST_USD fold sums chain.touches[].cost
// ---------------------------------------------------------------------------

test('runFirstBenchmark: the cost ceiling sums every chain touch cost (not the mean efficiency figure)', async () => {
  const record = freshChainRecord({
    landPerTouch: { 1: 'T1SHA', 2: 'T2SHA' },
    suitePerTouch: { 1: goodSuite(1), 2: goodSuite(2) },
  });
  const deps = chainDeps(record);
  deps.loadDeps = {
    readFileImpl: () => JSON.stringify(CHAIN_SCENARIO),
    importImpl: async () => {
      throw new Error('no module should be imported for a touches[] scenario');
    },
  };

  const result = await runFirstBenchmark(
    {
      scenarios: ['brownfield-longitudinal'],
      arms: ['mandrel'],
      n: 2,
      sandbox: SANDBOX,
      resultsDir: '/results',
      // 2 touches × $0.42 = $0.84 per cell ⇒ the FIRST cell crosses a $0.80
      // ceiling. The per-touch-mean efficiency figure ($0.42) would NOT.
      maxCostUsd: 0.8,
    },
    deps,
  );

  assert.equal(result.stopped?.reason, 'maxCostUsd');
  assert.equal(result.scorecards.length, 1);
  assert.ok(Math.abs(result.stopped.costUsd - 0.84) < 1e-9);
});
