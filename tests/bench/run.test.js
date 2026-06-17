// tests/bench/run.test.js
/**
 * Unit tests for bench/run.js — Story #3 (the orchestrator).
 *
 * The whole pipeline is exercised with every real effect injected: no `claude`
 * session, no git, no clone, no app server, no disk. The assertions prove:
 *   - the pure helpers (framework version, run identity, quality/planning
 *     inputs, model resolution, ledger discovery) behave, and
 *   - runFirstBenchmark emits a SCHEMA-VALID scorecard per (scenario × arm × run)
 *     and renders a report, with the mandrel/control asymmetries intact.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  buildRunIdentity,
  discoverLedger,
  planningInputs,
  qualityInputs,
  readFrameworkVersion,
  resolveModelId,
  runFirstBenchmark,
  sanitizeRunId,
} from '../../bench/run.js';

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
// Pure helpers
// ---------------------------------------------------------------------------

test('readFrameworkVersion: reads node_modules/mandrel/package.json version', () => {
  const v = readFrameworkVersion('/src', {
    existsImpl: (p) =>
      p.endsWith(path.join('node_modules', 'mandrel', 'package.json')),
    readFileImpl: () => JSON.stringify({ version: '1.70.0' }),
  });
  assert.equal(v, '1.70.0');
});

test('readFrameworkVersion: falls back to the dependency spec, stripped of ^', () => {
  const v = readFrameworkVersion('/src', {
    existsImpl: () => false,
    readFileImpl: (p) =>
      p.endsWith('package.json')
        ? JSON.stringify({ dependencies: { mandrel: '^1.71.0' } })
        : '{}',
  });
  assert.equal(v, '1.71.0');
});

test('sanitizeRunId: conforms to the schema pattern', () => {
  const id = sanitizeRunId('hello-world-mandrel-2026-06-16T19:42:11.000Z-r1');
  assert.match(id, /^[A-Za-z0-9._-]+$/);
  assert.ok(!id.includes(':'));
});

test('qualityInputs: mandrel maps proceed→1, control→null judge', () => {
  const frozen = { criteria: [{ met: true }, { met: false }, { met: true }] };
  assert.deepEqual(qualityInputs({ frozen, crossCheckDecision: 'proceed' }), {
    frozenSuitePassed: 2,
    frozenSuiteTotal: 3,
    acceptanceEvalScore: 1,
  });
  assert.equal(
    qualityInputs({ frozen, crossCheckDecision: null }).acceptanceEvalScore,
    null,
  );
  assert.equal(
    qualityInputs({ frozen, crossCheckDecision: 'redraft' })
      .acceptanceEvalScore,
    0,
  );
});

test('planningInputs: counts dispatch starts/ends', () => {
  const lifecycle = [
    { event: 'story.dispatch.start' },
    { event: 'story.dispatch.start' },
    { event: 'story.dispatch.end' },
    { event: 'epic.complete' },
  ];
  assert.deepEqual(planningInputs(lifecycle), {
    plannedStoryCount: 2,
    deliveredStoryCount: 1,
    rePlanCount: 0,
  });
});

test('resolveModelId: prefers the billed model, else the requested', () => {
  assert.equal(
    resolveModelId({ modelUsage: { 'claude-opus-4-8[1m]': {} } }, 'x'),
    'claude-opus-4-8[1m]',
  );
  assert.equal(resolveModelId({ modelUsage: {} }, 'requested'), 'requested');
});

test('buildRunIdentity: produces a schema-shaped run stamp', () => {
  const run = buildRunIdentity({
    scenario: 'hello-world',
    arm: 'mandrel',
    runIndex: 1,
    timestamp: '2026-06-16T19:42:11.000Z',
    modelId: 'claude-opus-4-8',
    frameworkVersion: '1.70.0',
    env: { node: 'v24.0.0', os: 'darwin' },
  });
  assert.match(run.runId, /^hello-world-mandrel-.*-r1$/);
  assert.equal(run.model.id, 'claude-opus-4-8');
  assert.equal(run.scenario, 'hello-world');
});

test('discoverLedger: archive-first, prefers a completed ledger', () => {
  const archiveLife = path.join(
    '/ws',
    'temp',
    'archive',
    'epic-100-9',
    'lifecycle.ndjson',
  );
  const files = {
    [archiveLife]: '{"event":"epic.start"}\n{"event":"epic.complete"}\n',
  };
  const found = discoverLedger(
    { workspacePath: '/ws' },
    {
      existsImpl: (p) =>
        p === path.join('/ws', 'temp', 'archive') ||
        p === path.join('/ws', 'temp') ||
        p === archiveLife,
      readdirImpl: (p) => {
        if (p === path.join('/ws', 'temp', 'archive')) return ['epic-100-9'];
        if (p === path.join('/ws', 'temp')) return ['archive'];
        return [];
      },
      readFileImpl: (p) => files[p] ?? '',
    },
  );
  assert.equal(found.lifecyclePath, archiveLife);
});

test('discoverLedger: returns null when no ledger exists', () => {
  const found = discoverLedger(
    { workspacePath: '/ws' },
    { existsImpl: () => false },
  );
  assert.equal(found, null);
});

// ---------------------------------------------------------------------------
// runFirstBenchmark — end to end with everything injected
// ---------------------------------------------------------------------------

const FAKE_SCENARIO = {
  id: 'hello-world',
  seed: { prompt: 'Build a hello-world server', acceptance: ['a', 'b'] },
  app: { startCommand: 'npm start', readinessPath: '/', portEnvVar: 'PORT' },
  acceptanceSuite: './acceptance.test.js',
  epicId: 99,
};

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

function benchDeps(record) {
  return {
    logger: { info() {}, warn() {} },
    // loadScenario seams
    loadDeps: {
      readFileImpl: () => JSON.stringify(FAKE_SCENARIO),
      importImpl: async () => ({
        evaluate: async () => ({
          scenario: 'hello-world',
          passed: true,
          criteria: [{ met: true }, { met: true }],
        }),
      }),
    },
    // sandbox seams
    provisionFn: (o) => {
      record.provisions.push(o.arm);
      return {
        workspacePath: `/ws-${o.arm}`,
        ephemeralRoot: '/tmp/root',
        arm: o.arm,
      };
    },
    teardownFn: (h) => record.teardowns.push(h.workspacePath),
    overlayFn: (o) => {
      record.overlays.push(o.arm);
      return { overlaid: true, arm: o.arm, copied: [] };
    },
    // session seam
    runSessionFn: (o) => {
      record.sessions.push({
        arm: o.arm,
        extraArgs: o.extraArgs,
        epicId: o.scenario.epicId,
      });
      return {
        arm: o.arm,
        scenarioId: o.scenario.id,
        model: o.model,
        prompt: 'p',
        status: 0,
        envelope: fakeEnvelope(),
      };
    },
    gitFn: (args) => record.git.push(args.join(' ')),
    // no ledger on disk (keeps the test free of NDJSON fixtures)
    discoverDeps: { existsImpl: () => false },
    // app + quality seams
    withRunningAppFn: async (_o, fn) =>
      fn('http://127.0.0.1:40000', { ready: true, port: 40000 }),
    scoreScenarioQualityFn: async () => ({
      frozen: { criteria: [{ met: true }, { met: true }] },
      crossCheck: { decision: 'proceed' },
      agree: true,
    }),
    // identity + fs seams
    nowFn: () => '2026-06-16T20:00:00.000Z',
    frameworkVersion: '1.70.0',
    env: { node: 'v24.16.0', os: 'darwin', host: 'test-host' },
    cpFn: () => {},
    mkdirFn: () => {},
    writeFileFn: (p, data) => record.writes.push({ p, data }),
    readFileImpl: () => '',
    // persist seam (in-memory store)
    persistDeps: {
      appendFileImpl: (p, data) => record.appended.push({ p, data }),
      existsImpl: () => true,
      mkdirImpl: () => {},
    },
  };
}

test('runFirstBenchmark: emits a schema-valid scorecard per arm and renders a report', async () => {
  const record = {
    provisions: [],
    teardowns: [],
    overlays: [],
    sessions: [],
    git: [],
    writes: [],
    appended: [],
  };
  const result = await runFirstBenchmark(
    {
      scenarios: ['hello-world'],
      arms: ['mandrel', 'control'],
      n: 1,
      sandbox: {
        repoUrl: 'git@github.com:dsj1984/mandrel-bench-sandbox.git',
        owner: 'dsj1984',
        repo: 'mandrel-bench-sandbox',
      },
      resultsDir: '/results',
    },
    benchDeps(record),
  );

  // Two scorecards, both schema-valid.
  assert.equal(result.scorecards.length, 2);
  for (const sc of result.scorecards) {
    const ok = validateScorecard(sc);
    assert.ok(
      ok,
      `scorecard invalid: ${JSON.stringify(validateScorecard.errors)}`,
    );
    assert.equal(sc.frameworkVersion, '1.70.0');
    assert.equal(sc.scenario, 'hello-world');
  }

  const mandrel = result.scorecards.find((s) => s.arm === 'mandrel');
  const control = result.scorecards.find((s) => s.arm === 'control');

  // Quality scored for both; control has no judge; control has no plan.
  assert.equal(mandrel.dimensions.quality.frozenSuitePassRate, 1);
  assert.equal(mandrel.dimensions.quality.acceptanceEvalScore, 1);
  assert.equal(control.dimensions.quality.acceptanceEvalScore, null);
  assert.equal(control.dimensions.planningFidelity.score, null);
  assert.equal(typeof mandrel.dimensions.planningFidelity.score, 'number');

  // Arm asymmetries: only the mandrel arm is overlaid and drives the Epic id.
  // BOTH arms get the bypassPermissions args (permission mode is orthogonal to
  // scaffolding — each must act headlessly). Both arms are torn down.
  assert.deepEqual(record.overlays, ['mandrel']);
  assert.equal(record.sessions.find((s) => s.arm === 'mandrel').epicId, 99);
  for (const arm of ['mandrel', 'control']) {
    assert.ok(
      record.sessions
        .find((s) => s.arm === arm)
        .extraArgs.includes('bypassPermissions'),
      `${arm} arm should carry bypassPermissions`,
    );
  }
  assert.equal(
    record.sessions.find((s) => s.arm === 'control').epicId,
    undefined,
  );
  assert.equal(record.teardowns.length, 2);

  // Persisted + report rendered.
  assert.equal(result.storePath, path.join('/results', 'scorecards.ndjson'));
  assert.equal(record.appended.length, 1);
  assert.match(result.report, /Value-Add Report/);
  assert.match(result.reportPath, /report-.*\.md$/);
});

test('runFirstBenchmark: requires sandbox coordinates', async () => {
  await assert.rejects(
    runFirstBenchmark({ sandbox: { repoUrl: 'x' } }, {}),
    /sandbox \{ repoUrl, owner, repo \}/,
  );
});
