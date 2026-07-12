// tests/bench/scenarios/brownfield-longitudinal/chain-e2e.test.js
/**
 * End-to-end fixture smoke for the brownfield-longitudinal rung
 * (issue #124, PR-E) — one full fake COHORT CELL per arm, 4 arms × 5
 * touches, driven through the real dispatch spine:
 *
 *   real scenario.json → real `loadScenario` (touch prompts read from
 *   `touches/<k>/prompt.md`) → `runOneRun` chain routing → `runTouchChain`
 *   → a schema-valid one-record-per-cell scorecard → PR-D's report +
 *   dashboard renderers over the resulting 4-arm cohort.
 *
 * Everything expensive or remote is injected fake — session, git, GitHub
 * reads, app boot, judge, maintainability/security collectors — so NO live
 * `claude` session, network, or git remote is touched. The scoring
 * instruments, however, are REAL:
 *
 *   - the `mandrel` and `control` arms provision genuine scratch copies of
 *     the frozen Ledgerline seed, resolve `suite-evolution.js` through the
 *     scenario's own declaration, and run the REAL evolved frozen suite
 *     (`node --test` against the frozen mirror) at the touches where
 *     realness carries the proof — the pristine base green at k=1, the
 *     touch-5 supersede/addition arithmetic at k=5, and the corrupted-tree
 *     discrimination at control k=2 (the remaining touches get canned
 *     verdicts through the same resolved runner to bound wall-clock);
 *   - all arms load the four convention grep-oracles through the scenario's
 *     `conventionOracles` declaration and scan the real delivered tree;
 *   - the control arm's touch 2 ships a genuinely CORRUPTED tree (the error
 *     envelope's status wiring broken), proving the real frozen suite
 *     discriminates and the advance gate skips forward from last-good.
 *
 * The chain semantics exercised: an advancing chain (mandrel touches
 * 1-3, 5), an UNLANDED touch (mandrel touch 4 — spend recorded, outcome
 * null, suite skipped), a suite-driven SKIP-FORWARD (control touch 2), the
 * per-touch `.raw/<stamp>/touch<k>/` layout, the `chain.ndjson` ledger, the
 * arm-3 per-scenario CLAUDE.md fixture, and the arm-4 overlay path. The two
 * variant arms run on canned suite verdicts to keep the smoke's wall-clock
 * within budget — the real-suite path is already proven on the two primary
 * arms.
 */

import assert from 'node:assert/strict';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { renderDashboard } from '../../../../bench/report/html.js';
import {
  buildReportModel,
  renderReport,
} from '../../../../bench/report/render.js';
import { loadScenario, runOneRun } from '../../../../bench/run.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SCENARIO_DIR = path.join(
  REPO,
  'bench',
  'scenarios',
  'brownfield-longitudinal',
);
const SANDBOX_DIR = path.join(SCENARIO_DIR, 'sandbox');

const SCHEMA = JSON.parse(
  readFileSync(path.join(REPO, 'bench', 'schemas', 'scorecard.schema.json')),
);
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validateScorecard = ajv.compile(SCHEMA);

const SANDBOX = {
  repoUrl: 'https://github.com/dsj1984/bench-sbx-chain-e2e.git',
  owner: 'dsj1984',
  repo: 'bench-sbx-chain-e2e',
  baselineSha: 'SEED',
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

/** Canned green evolved-suite verdict (for the canned-suite variant arms). */
function cannedSuite(k) {
  return {
    touchIndex: k,
    base: {
      total: 102,
      retainedTotal: 100,
      retainedPassed: 100,
      retainedFailed: [],
      missing: [],
      supersededIds: [],
      regressionRate: 0,
    },
    additions: { total: 8, passed: 8, failed: [], missing: [], byTouch: {} },
  };
}

/**
 * Break the seed's error-envelope status wiring: every `sendError` responds
 * 500 regardless of the intended status. The frozen suite's 4xx assertions
 * (auth 401s, validation 422s, not-found 404s, …) then genuinely fail —
 * this is the corruption that proves the REAL evolved suite discriminates.
 */
function corruptErrorEnvelope(workspacePath) {
  const errorsPath = path.join(workspacePath, 'src', 'lib', 'errors.js');
  const source = readFileSync(errorsPath, 'utf8');
  const corrupted = source.replace(
    'res.writeHead(status,',
    'res.writeHead(500,',
  );
  assert.notEqual(
    corrupted,
    source,
    'seed drift: src/lib/errors.js no longer matches the corruption seam',
  );
  writeFileSync(errorsPath, corrupted);
}

/**
 * The injected-deps bag for one arm's chain cell. Sessions, git, GitHub,
 * app boot, judge, and collectors are fakes; provisioning copies the REAL
 * frozen seed into a scratch dir so the real suite/oracles can run.
 *
 * @param {object} record   Mutable capture state (one per arm).
 * @param {object} [opts]
 * @param {boolean} [opts.realTrees]     Copy the real seed per touch.
 * @param {number}  [opts.corruptTouch]  1-based touch whose tree is broken.
 * @param {number[]} [opts.realSuiteTouches]  Touch indexes whose evolved
 *   suite runs FOR REAL (`node --test` over the frozen mirror); the other
 *   touches get canned verdicts so the smoke's wall-clock stays bounded —
 *   the runner itself is identical either way (resolved through the
 *   scenario's own suite-evolution.js declaration). Omit for all-canned.
 */
function chainDeps(record, opts = {}) {
  let sessionCount = 0;
  let head = record.remoteMainSha;
  const armByWorkspace = new Map();
  return {
    logger: { info() {}, warn() {} },
    provisionFn: (o) => {
      record.provisions.push({ arm: o.arm, baselineSha: o.baselineSha });
      const k = record.provisions.length;
      let workspacePath = `/fake-ws-t${k}`;
      if (opts.realTrees) {
        workspacePath = mkdtempSync(
          path.join(tmpdir(), `chain-e2e-${o.arm}-t${k}-`),
        );
        cpSync(SANDBOX_DIR, workspacePath, { recursive: true });
        if (opts.corruptTouch === k) corruptErrorEnvelope(workspacePath);
      }
      armByWorkspace.set(workspacePath, o.arm);
      return { workspacePath, ephemeralRoot: tmpdir(), arm: o.arm };
    },
    teardownFn: (h) => {
      record.teardowns.push(h.workspacePath);
      if (opts.realTrees)
        rmSync(h.workspacePath, { recursive: true, force: true });
    },
    resetSandboxFn: (o) => {
      record.resets.push(o.sha ?? null);
      if (typeof o.sha === 'string') record.remoteMainSha = o.sha;
      return { reset: true, sha: o.sha ?? 'SEED' };
    },
    overlayFn: (o) => {
      record.overlays.push(o.arm);
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
      if (args[0] === 'reset') {
        head = record.remoteMainSha; // reset --hard origin/main
        return '';
      }
      if (args[0] === '-c' && args.includes('commit')) {
        const arm = armByWorkspace.get(cwd) ?? 'control';
        if (arm.startsWith('mandrel')) {
          throw new Error('nothing to commit, working tree clean');
        }
        head = `${path.basename(cwd)}-COMMIT`;
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
    withRunningAppFn: async (o, fn) => {
      record.appBoots.push(o.app?.readinessPath ?? null);
      return fn('http://127.0.0.1:40000', {});
    },
    ...(Array.isArray(opts.realSuiteTouches)
      ? {
          // No injected runner: runTouchChain resolves the scenario's own
          // suite-evolution.js declaration. The import wrapper runs the REAL
          // evolved frozen suite for the designated touches (each is a real
          // `node --test` pass over the frozen mirror, several seconds) and
          // cans the rest so the smoke stays within its wall-clock budget.
          importImpl: async (spec) => {
            const mod = await import(spec);
            if (spec.endsWith('suite-evolution.js')) {
              return {
                ...mod,
                runEvolvedSuite: (args) => {
                  const real = opts.realSuiteTouches.includes(args.touchIndex);
                  record.suiteRuns.push({ touchIndex: args.touchIndex, real });
                  return real
                    ? mod.runEvolvedSuite(args)
                    : cannedSuite(args.touchIndex);
                },
              };
            }
            return mod;
          },
        }
      : {
          runEvolvedSuiteFn: ({ touchIndex }) => {
            record.suiteRuns.push({ touchIndex, real: false });
            return cannedSuite(touchIndex);
          },
        }),
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
      hasPasswordHashing: true,
      hasSafeTokenStorage: true,
      hasServerSideAuthz: true,
      hasAuthRateLimiting: false,
    }),
    runDimensionJudgeFn: async () => ({ maintainability: 0.85, security: 0.9 }),
    collectSourceExcerptFn: () => '',
    ghJson: () => [],
    discoverDeps: { existsImpl: () => false },
    nowFn: () => '2026-07-12T09:00:00.000Z',
    frameworkVersion: '1.91.0',
    benchmarkVersion: '0.11.0',
    env: { node: 'v24.16.0', os: 'darwin', host: 'e2e-host' },
    mkdirFn: (p) => record.mkdirs.push(p),
    writeFileFn: (p, data) => record.writes.push({ p, data }),
    appendFileFn: (p, data) => record.appended.push({ p, data }),
  };
}

function freshRecord(overrides = {}) {
  return {
    remoteMainSha: 'SEED',
    landPerTouch: {},
    provisions: [],
    teardowns: [],
    resets: [],
    overlays: [],
    gatePackageJsonWrites: [],
    claudeMdSeeds: [],
    sessions: [],
    git: [],
    pushes: [],
    suiteRuns: [],
    appBoots: [],
    mkdirs: [],
    writes: [],
    appended: [],
    ...overrides,
  };
}

function ledgerLines(record) {
  return record.appended
    .filter((a) => a.p.endsWith('chain.ndjson'))
    .map((a) => JSON.parse(a.data));
}

function assertRawTouchLayout(record, arm) {
  const rawWrites = record.writes.map((w) => w.p);
  for (const k of [1, 2, 3, 4, 5]) {
    const dir = path.join(
      '.raw',
      `brownfield-longitudinal-${arm}-r1`,
      `touch${k}`,
    );
    for (const file of ['cost-envelope.json', 'session-result.json']) {
      assert.ok(
        rawWrites.some((p) => p.endsWith(path.join(dir, file))),
        `${arm}: ${file} persisted for touch${k}`,
      );
    }
  }
}

test('brownfield-longitudinal end-to-end smoke: 4 arms × 5 touches through the real loaded scenario', async () => {
  // Real loadScenario over the real scenario.json: 5 touches with prompt
  // text pulled from the real touches/<k>/prompt.md artifacts.
  const { scenario, evaluate, scenarioDir, touch2Evaluate, touches } =
    await loadScenario('brownfield-longitudinal');
  assert.equal(scenario.id, 'brownfield-longitudinal');
  assert.equal(evaluate, null);
  assert.equal(touch2Evaluate, null);
  assert.equal(scenario.chainAdvanceThreshold, 0.9);
  assert.equal(touches.length, 5);
  assert.deepEqual(
    touches.map((t) => t.id),
    [
      'credit-notes',
      'role-enforcement',
      'client-rename',
      'name-split',
      'receivables-perf',
    ],
  );
  for (const [i, t] of touches.entries()) {
    const onDisk = readFileSync(
      path.join(scenarioDir, 'touches', String(i + 1), 'prompt.md'),
      'utf8',
    );
    assert.equal(t.prompt, onDisk, `touch ${i + 1} prompt read from disk`);
  }

  const run = (arm, record, depOpts) =>
    runOneRun(
      {
        scenario,
        evaluate: null,
        scenarioDir,
        touches,
        arm,
        runIndex: 1,
        sandbox: { ...SANDBOX },
        resultsDir: '/results',
      },
      chainDeps(record, depOpts),
    );

  // ---- the four arms of one fake cohort, run concurrently ------------------
  const mandrelRecord = freshRecord({
    // Touch 4 lands NOTHING (no auto-merge, no recoverable PR-head branch):
    // the unlanded-touch path — real spend, null outcome, suite skipped.
    landPerTouch: { 1: 'T1SHA', 2: 'T2SHA', 3: 'T3SHA', 5: 'T5SHA' },
  });
  const controlRecord = freshRecord();
  const arm3Record = freshRecord();
  const arm4Record = freshRecord({
    landPerTouch: { 1: 'A1', 2: 'A2', 3: 'A3', 4: 'A4', 5: 'A5' },
  });

  const [mandrelCard, controlCard, arm3Card, arm4Card] = await Promise.all([
    // Real suite at k=1 (the full pristine base is green through the real
    // runner) and k=5 (the touch-5 supersede/addition arithmetic is real).
    run('mandrel', mandrelRecord, {
      realTrees: true,
      realSuiteTouches: [1, 5],
    }),
    // Control touch 2 delivers a genuinely broken tree: the REAL evolved
    // suite fails it below the 0.90 gate and the chain skips forward.
    run('control', controlRecord, {
      realTrees: true,
      corruptTouch: 2,
      realSuiteTouches: [2],
    }),
    run('control-claudemd', arm3Record, {}),
    run('mandrel-story-routed', arm4Record, {}),
  ]);
  const scorecards = [mandrelCard, controlCard, arm3Card, arm4Card];

  // ---- every cell: one schema-valid record carrying the chain block --------
  for (const card of scorecards) {
    assert.ok(
      validateScorecard(card),
      `${card.arm} scorecard invalid: ${JSON.stringify(validateScorecard.errors, null, 2)}`,
    );
    assert.equal(card.scenario, 'brownfield-longitudinal');
    assert.equal(card.chain.advanceThreshold, 0.9);
    assert.equal(card.chain.touches.length, 5);
    assert.ok(card.warnings.includes('chain-aggregate-dimensions'));
  }

  // ---- mandrel: advancing chain + one unlanded touch ------------------------
  {
    const t = mandrelCard.chain.touches;
    assert.deepEqual(
      t.map((x) => [
        x.touchIndex,
        x.landed,
        x.materialized,
        x.advanced,
        x.seededFromTouch,
      ]),
      [
        [1, true, true, true, 0],
        [2, true, true, true, 1],
        [3, true, true, true, 2],
        [4, false, false, false, 3],
        [5, true, true, true, 3], // skip-forward past the unlanded touch 4
      ],
    );
    // The REAL evolved suite ran for every materialized touch and never for
    // the unmaterialized one.
    assert.deepEqual(
      mandrelRecord.suiteRuns.map((r) => [r.touchIndex, r.real]),
      [
        [1, true],
        [2, false],
        [3, false],
        [5, true],
      ],
    );
    // Real suite-evolution arithmetic against the pristine seed: the full
    // base is retained and green at k=1; by k=5 the touch supersede lists
    // have retired 20 base ids (82 retained, still green), and all 43 frozen
    // additions ran (behavioural probes of unimplemented features — they
    // report failures, never `missing`).
    assert.equal(t[0].regression.baseTotal, 102);
    assert.equal(t[0].regression.retainedTotal, 102);
    assert.equal(t[0].regression.retainedPassed, 102);
    assert.equal(t[0].regression.regressionRate, 0);
    assert.equal(t[4].regression.retainedTotal, 82);
    assert.equal(t[4].regression.retainedPassed, 82);
    assert.equal(t[4].regression.additionsTotal, 43);
    assert.ok(t[4].regression.additionsPassed < 43);
    // The four convention oracles (loaded via scenario.conventionOracles)
    // scanned the real tree: the frozen seed is clean on all four classes.
    assert.equal(t[0].conventions.classes.length, 4);
    assert.equal(t[0].conventions.cleanRate, 1);
    // Unlanded touch 4: spend recorded, nothing measured.
    assert.equal(t[3].outcome, null);
    assert.equal(t[3].cost, 0.42);
    assert.equal('regression' in t[3], false);
    // Chain state: baselines advanced 0→T1→T2→T3, touch 5 re-seeded from T3.
    assert.deepEqual(
      mandrelRecord.provisions.map((p) => p.baselineSha),
      ['SEED', 'T1SHA', 'T2SHA', 'T3SHA', 'T3SHA'],
    );
    assert.equal(mandrelCard.chain.landedCount, 4);
    assert.ok(
      Math.abs(mandrelCard.chain.costPerLandedChange - (5 * 0.42) / 4) < 1e-9,
    );
    // Sessions carried the real prompts; phases captured per touch.
    assert.deepEqual(
      mandrelRecord.sessions.map((s) => s.prompt),
      touches.map((x) => x.prompt),
    );
    assert.deepEqual(
      t[0].phases.map((p) => p.phase),
      ['plan', 'deliver'],
    );
    // Raw layout + ledger + post-chain rewind to the pristine seed.
    assertRawTouchLayout(mandrelRecord, 'mandrel');
    const lines = ledgerLines(mandrelRecord);
    assert.equal(lines.length, 5);
    assert.deepEqual(lines[0], {
      touch: 1,
      headSha: 'T1SHA',
      landed: true,
      materialized: true,
      advanced: true,
      seededFromTouch: 0,
      baseSuite: { passed: 102, total: 102 },
      costUsd: 0.42,
    });
    assert.equal(lines[3].materialized, false);
    assert.equal(lines[4].seededFromTouch, 3);
    assert.equal(mandrelRecord.resets.at(-1), 'SEED');
    assert.equal(mandrelRecord.teardowns.length, 5);
  }

  // ---- control: the REAL suite catches the corrupted touch → skip-forward ---
  {
    const t = controlCard.chain.touches;
    // Landing is not a concept on the control arm.
    assert.ok(t.every((x) => x.landed === null && x.materialized === true));
    // Touch 2's broken error envelope genuinely fails the retained base
    // suite below the 0.90 gate — the real discrimination this smoke exists
    // to prove.
    assert.equal(t[1].advanced, false);
    assert.ok(
      t[1].regression.regressionRate > 0.1,
      `corrupted tree must regress > 10% of retained base tests, got ${t[1].regression.regressionRate}`,
    );
    assert.deepEqual(
      t.map((x) => [x.advanced, x.seededFromTouch]),
      [
        [true, 0],
        [false, 1],
        [true, 1], // skip-forward: touch 3 seeds from last-good touch 1
        [true, 3],
        [true, 4],
      ],
    );
    // 4 advances = 4 commit+force-push baselines; the failed touch pushed
    // nothing.
    assert.equal(controlRecord.pushes.length, 4);
    assert.equal(controlCard.chain.landedCount, 4);
    // Clean touches stay regression-free on the real suite.
    assert.equal(t[0].regression.regressionRate, 0);
    assert.equal(t[0].conventions.cleanRate, 1);
    assertRawTouchLayout(controlRecord, 'control');
    assert.equal(ledgerLines(controlRecord).length, 5);
    // Control provisioning: gate package.json per touch, no mandrel overlay,
    // no static CLAUDE.md (that is arm 3's treatment).
    assert.equal(controlRecord.gatePackageJsonWrites.length, 5);
    assert.deepEqual(controlRecord.overlays, []);
    assert.deepEqual(controlRecord.claudeMdSeeds, []);
  }

  // ---- arm 3 (control-claudemd): the per-scenario fixture (review note 3) ---
  {
    assert.equal(arm3Record.claudeMdSeeds.length, 5);
    const expectedFixture = path.join(scenarioDir, './control-claudemd.md');
    for (const seed of arm3Record.claudeMdSeeds) {
      assert.equal(seed.fixturePath, expectedFixture);
    }
    // The declared fixture is a real file (seedStaticClaudeMd would read it).
    assert.ok(readFileSync(expectedFixture, 'utf8').length > 500);
    assert.equal(arm3Card.chain.landedCount, 5);
    assert.equal(ledgerLines(arm3Record).length, 5);
  }

  // ---- arm 4 (mandrel-story-routed): full overlay pipeline per touch --------
  {
    assert.deepEqual(
      arm4Record.overlays,
      new Array(5).fill('mandrel-story-routed'),
    );
    assert.deepEqual(arm4Record.claudeMdSeeds, []);
    const t = arm4Card.chain.touches;
    assert.ok(t.every((x) => x.landed === true && x.advanced === true));
    assert.equal(arm4Card.chain.landedCount, 5);
    assert.deepEqual(
      t[0].phases.map((p) => p.phase),
      ['plan', 'deliver'],
    );
  }

  // ---- PR-D renderers over the resulting cohort -----------------------------
  {
    const report = renderReport({ scorecards });
    assert.ok(
      report.includes(
        '#### Touch chain (degradation slope — separate from the seven dimensions)',
      ),
      'markdown report renders the chain section',
    );
    for (const arm of [
      'mandrel',
      'control',
      'control-claudemd',
      'mandrel-story-routed',
    ]) {
      assert.ok(
        report.includes(`##### Per-touch line data — \`${arm}\``),
        `markdown report carries the ${arm} per-touch table`,
      );
    }
    assert.ok(
      report.includes('##### Landed changes & cost per landed change'),
      'markdown report carries the landed-change summary',
    );

    const model = buildReportModel({ scorecards });
    const cell = model.scenarios.find(
      (c) => c.scenario === 'brownfield-longitudinal',
    );
    assert.ok(cell?.chain, 'report model carries a chain block for the rung');

    const html = renderDashboard({ scorecards });
    assert.ok(
      html.includes('Touch chain'),
      'dashboard renders the touch-chain panel',
    );
    assert.ok(
      html.includes('chain-chart'),
      'dashboard renders the per-touch line charts',
    );
  }
});
