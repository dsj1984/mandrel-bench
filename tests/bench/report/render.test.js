// tests/bench/report/render.test.js
//
// Unit tier (pure logic, no I/O) for the value-add report renderer
// (Epic #4211, Story #4218). Exercises bench/report/render.js against the
// Story's binding acceptance items:
//   - every dimension rendered as a distribution (a noise-band per arm),
//   - the Mandrel-vs-bare delta and the noise-band verdict,
//   - the per-difficulty scaling view (Efficiency + Overhead ratio, both arms),
//   - monotonicity violations surfaced as explicit calibration warnings,
//   - the overhead-floor estimate surfaced in Recommended improvements,
//   - a clearly-delineated, actionable, evidence-linked Recommended
//     improvements section.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  attributionRows,
  autonomyGuardrailFindings,
  autonomyGuardrailRows,
  buildReportModel,
  deriveCohort,
  dimensionRows,
  groupCells,
  phaseCostRows,
  recommendImprovements,
  renderAttributionSection,
  renderFloorCalibrationNote,
  renderMismatchNote,
  renderPhaseCostSection,
  renderReport,
  renderScalingView,
  trapAxisRows,
} from '../../../bench/report/render.js';
import { scoreCorpus } from '../../../bench/score/differential.js';

const MODEL = { id: 'claude-opus-4-8[1m]' };
const ENV = { node: 'v24.16.0', os: 'darwin' };
const FW = '1.70.0';
const BV = '0.5.0';

/**
 * Build a full per-run scorecard carrying the stamp + the dimension scalars a
 * test cares about. Defaults are benign and in-range.
 */
function card({
  scenario = 'hello-world',
  arm = 'mandrel',
  routingVerdict = null,
  routingMismatch = false,
  runId = `${scenario}-${arm}-r1`,
  quality = 1,
  planningFidelity = 0.9,
  autonomy = 1,
  autonomyGuardrailMet = true,
  autonomyGuardrailThreshold = 0.99,
  maintainability = 0.9,
  security = 1,
  tokenRatio = 4,
  wallClockMs = 600000,
  totalTokens = 180000,
  dispatches = 2,
  costUsd = 1.4,
  model = MODEL,
  frameworkVersion = FW,
  benchmarkVersion = BV,
  env = ENV,
  trap = null,
  phases = null,
} = {}) {
  const sc = {
    schemaVersion: 1,
    runId,
    timestamp: '2026-06-16T19:42:11.000Z',
    model,
    frameworkVersion,
    benchmarkVersion,
    env,
    scenario,
    arm,
    routingVerdict,
    routingMismatch,
    dimensions: {
      quality: { score: quality, frozenSuitePassRate: quality },
      planningFidelity: { score: arm === 'control' ? null : planningFidelity },
      autonomy: {
        score: autonomy,
        hitlStops: 0,
        blockedEvents: 0,
        manualRescues: 0,
        guardrail: {
          threshold: autonomyGuardrailThreshold,
          met: autonomyGuardrailMet,
        },
      },
      maintainability: { score: maintainability },
      security: { score: security },
      overheadRatio: { tokenRatio },
      efficiency: { wallClockMs, totalTokens, dispatches, costUsd },
    },
  };
  if (trap) sc.trap = trap;
  if (phases) sc.phases = phases;
  return sc;
}

/**
 * A small but realistic corpus: two scenarios × two arms × a few runs each,
 * shaped so monotonicity HOLDS (tokens rise, overhead ratio falls easy→hard)
 * and Mandrel clearly beats control on quality.
 */
function healthyCorpus() {
  const cards = [];
  // hello-world: low tokens, high overhead ratio.
  for (let i = 0; i < 4; i += 1) {
    cards.push(
      card({
        scenario: 'hello-world',
        arm: 'mandrel',
        runId: `hw-m-${i}`,
        quality: 1 - i * 0.005,
        tokenRatio: 4.2,
        totalTokens: 180000 + i * 1000,
        costUsd: 1.4,
      }),
    );
    cards.push(
      card({
        scenario: 'hello-world',
        arm: 'control',
        runId: `hw-c-${i}`,
        quality: 0.5 + i * 0.005,
        tokenRatio: 0.1,
        totalTokens: 40000 + i * 500,
        costUsd: 0.3,
      }),
    );
  }
  // story-scope: higher tokens, lower overhead ratio (amortized).
  for (let i = 0; i < 4; i += 1) {
    cards.push(
      card({
        scenario: 'story-scope',
        arm: 'mandrel',
        runId: `story-m-${i}`,
        quality: 0.95 - i * 0.005,
        tokenRatio: 1.5,
        totalTokens: 900000 + i * 5000,
        costUsd: 7.0,
      }),
    );
    cards.push(
      card({
        scenario: 'story-scope',
        arm: 'control',
        runId: `story-c-${i}`,
        quality: 0.4 + i * 0.005,
        tokenRatio: 0.1,
        totalTokens: 300000 + i * 2000,
        costUsd: 2.5,
      }),
    );
  }
  return cards;
}

describe('groupCells', () => {
  it('groups by scenario and arm, ordered by the difficulty ladder', () => {
    const cells = groupCells(healthyCorpus());
    assert.equal(cells.length, 2);
    assert.equal(cells[0].scenario, 'hello-world'); // difficulty 1 first
    assert.equal(cells[1].scenario, 'story-scope'); // difficulty 2 second
    assert.equal(cells[0].mandrelRuns.length, 4);
    assert.equal(cells[0].controlRuns.length, 4);
  });

  it('sorts an unknown scenario last without dropping it', () => {
    const cells = groupCells([
      card({ scenario: 'story-scope', runId: 'a' }),
      card({ scenario: 'mystery', runId: 'b' }),
      card({ scenario: 'hello-world', runId: 'c' }),
    ]);
    assert.deepEqual(
      cells.map((c) => c.scenario),
      ['hello-world', 'story-scope', 'mystery'],
    );
  });

  it('throws on a non-array input', () => {
    assert.throws(() => groupCells(null), TypeError);
  });

  it('tags hello-world cells with the floor/calibration framing marker, and no other scenario', () => {
    const cells = groupCells([
      card({ scenario: 'hello-world', runId: 'hw-1' }),
      card({ scenario: 'story-scope', runId: 'story-1' }),
    ]);
    const hw = cells.find((c) => c.scenario === 'hello-world');
    const story = cells.find((c) => c.scenario === 'story-scope');
    assert.equal(hw.floorCalibration, true);
    assert.equal(story.floorCalibration, false);
  });

  describe('routing-mismatch exclusion (Epic #66, Story #76)', () => {
    it('excludes routingMismatch:true mandrel records from the pool and reports the mismatch rate', () => {
      const cells = groupCells([
        card({ scenario: 'story-scope', arm: 'mandrel', runId: 'm-1' }),
        card({ scenario: 'story-scope', arm: 'mandrel', runId: 'm-2' }),
        card({
          scenario: 'story-scope',
          arm: 'mandrel',
          runId: 'm-3',
          routingMismatch: true,
        }),
        card({ scenario: 'story-scope', arm: 'control', runId: 'c-1' }),
      ]);
      const cell = cells.find((c) => c.scenario === 'story-scope');
      assert.equal(cell.mandrelRuns.length, 2);
      assert.deepEqual(
        cell.mandrelRuns.map((sc) => sc.runId),
        ['m-1', 'm-2'],
      );
      assert.equal(cell.mismatchedRuns.length, 1);
      assert.equal(cell.mismatchedRuns[0].runId, 'm-3');
      assert.ok(Math.abs(cell.mismatchRate - 1 / 3) < 1e-9);
    });

    it('flags a cell whose mismatch rate exceeds the 25% scope-triage threshold', () => {
      const cells = groupCells([
        card({ scenario: 'story-scope', arm: 'mandrel', runId: 'm-1' }),
        card({
          scenario: 'story-scope',
          arm: 'mandrel',
          runId: 'm-2',
          routingMismatch: true,
        }),
        card({
          scenario: 'story-scope',
          arm: 'mandrel',
          runId: 'm-3',
          routingMismatch: true,
        }),
      ]);
      const cell = cells.find((c) => c.scenario === 'story-scope');
      assert.ok(cell.mismatchRate > 0.25);
      assert.equal(cell.mismatchFlag, true);
    });

    it('does not flag a cell whose mismatch rate is at or below the 25% threshold', () => {
      const cells = groupCells([
        card({ scenario: 'story-scope', arm: 'mandrel', runId: 'm-1' }),
        card({ scenario: 'story-scope', arm: 'mandrel', runId: 'm-2' }),
        card({ scenario: 'story-scope', arm: 'mandrel', runId: 'm-3' }),
        card({
          scenario: 'story-scope',
          arm: 'mandrel',
          runId: 'm-4',
          routingMismatch: true,
        }),
      ]);
      const cell = cells.find((c) => c.scenario === 'story-scope');
      assert.equal(cell.mismatchRate, 0.25);
      assert.equal(cell.mismatchFlag, false);
    });

    it('reports a zero mismatch rate for a cell with no mandrel records at all', () => {
      const cells = groupCells([
        card({ scenario: 'story-scope', arm: 'control', runId: 'c-1' }),
      ]);
      const cell = cells.find((c) => c.scenario === 'story-scope');
      assert.equal(cell.mismatchRate, 0);
      assert.equal(cell.mismatchFlag, false);
    });
  });
});

describe('deriveCohort', () => {
  it('collects the distinct stamp values and flags a single cohort as not mixed', () => {
    const cohort = deriveCohort(healthyCorpus());
    assert.deepEqual(cohort.models, ['claude-opus-4-8[1m]']);
    assert.deepEqual(cohort.frameworkVersions, ['1.70.0']);
    // D-014: benchmarkVersion joins the stamp; a single-benchmark corpus is
    // not mixed and the env guard is unchanged.
    assert.deepEqual(cohort.benchmarkVersions, ['0.5.0']);
    assert.deepEqual(cohort.nodes, ['v24.16.0']);
    assert.equal(cohort.mixed, false);
  });

  it('flags a mixed cohort when stamps diverge', () => {
    const cohort = deriveCohort([
      card({ runId: 'a', frameworkVersion: '1.70.0' }),
      card({ runId: 'b', frameworkVersion: '1.71.0' }),
    ]);
    assert.equal(cohort.mixed, true);
    assert.equal(cohort.frameworkVersions.length, 2);
  });

  it('flags a mixed cohort when only the benchmark version diverges (D-014)', () => {
    const cohort = deriveCohort([
      card({ runId: 'a', benchmarkVersion: '0.5.0' }),
      card({ runId: 'b', benchmarkVersion: '0.6.0' }),
    ]);
    assert.equal(cohort.mixed, true);
    assert.deepEqual(cohort.benchmarkVersions, ['0.5.0', '0.6.0']);
    // The framework version did NOT diverge — the mix is purely the benchmark.
    assert.deepEqual(cohort.frameworkVersions, ['1.70.0']);
  });
});

describe('groupCells — benchmarkVersion non-inferential pooling (D-014, Story #87)', () => {
  it('does not pool a cell that mixes benchmark versions: no noise-band and a non-inferential flag', () => {
    // One (model, frameworkVersion) hello-world cell whose mandrel runs span
    // two benchmark versions — the harness itself changed between them.
    const corpus = [
      card({ runId: 'm-a', arm: 'mandrel', benchmarkVersion: '0.5.0' }),
      card({ runId: 'm-b', arm: 'mandrel', benchmarkVersion: '0.5.0' }),
      card({ runId: 'm-c', arm: 'mandrel', benchmarkVersion: '0.6.0' }),
      card({ runId: 'c-a', arm: 'control', benchmarkVersion: '0.5.0' }),
      card({ runId: 'c-b', arm: 'control', benchmarkVersion: '0.6.0' }),
    ];
    const cells = groupCells(corpus);
    const hw = cells.find((c) => c.scenario === 'hello-world');
    assert.equal(hw.nonInferential, true);
    assert.deepEqual(hw.benchmarkVersions, ['0.5.0', '0.6.0']);
    // No poolable runs remain at the grouping seam → no noise-band can form.
    assert.equal(hw.mandrelRuns.length, 0);
    assert.equal(hw.controlRuns.length, 0);
    // The raw records are still held for counting / labelling.
    assert.equal(hw.nonInferentialRuns.length, 5);
  });

  it('leaves a single-benchmark-version cell fully poolable (no false suppression)', () => {
    const cells = groupCells(healthyCorpus());
    for (const c of cells) {
      assert.equal(c.nonInferential, false);
      assert.equal(c.benchmarkVersions.length, 1);
    }
    const hw = cells.find((c) => c.scenario === 'hello-world');
    assert.ok(hw.mandrelRuns.length > 0);
  });
});

describe('dimensionRows — distributions per arm + delta verdict', () => {
  it('reports a noise-band for both arms on every dimension (no bare points)', () => {
    const cells = groupCells(healthyCorpus());
    const corpus = scoreCorpus({
      cells: cells.map((c) => ({
        scenario: c.scenario,
        difficulty: c.difficulty,
        mandrelRuns: c.mandrelRuns,
        controlRuns: c.controlRuns,
      })),
    });
    const rows = dimensionRows(cells[0], corpus.perScenario[0], 'iqr');
    // 5 scalar dimensions (autonomy is a guardrail, not a delta — Epic #66,
    // Story #77/#79) + 4 efficiency components = 9 rows.
    assert.equal(rows.length, 9);
    const quality = rows.find((r) => r.metric === 'quality');
    // Both arms have a band (a distribution), not a single number.
    assert.ok(
      quality.mandrelBand && typeof quality.mandrelBand.center === 'number',
    );
    assert.ok(
      quality.controlBand && typeof quality.controlBand.center === 'number',
    );
    assert.ok('low' in quality.mandrelBand && 'high' in quality.mandrelBand);
  });

  it('flags the Mandrel-vs-control quality gap as a real delta', () => {
    const cells = groupCells(healthyCorpus());
    const corpus = scoreCorpus({
      cells: cells.map((c) => ({
        scenario: c.scenario,
        difficulty: c.difficulty,
        mandrelRuns: c.mandrelRuns,
        controlRuns: c.controlRuns,
      })),
    });
    const rows = dimensionRows(cells[0], corpus.perScenario[0], 'iqr');
    const quality = rows.find((r) => r.metric === 'quality');
    assert.equal(quality.verdict, 'real');
    assert.ok(quality.delta > 0); // mandrel − control, mandrel higher
  });

  it('marks planningFidelity incomparable when the control arm is null', () => {
    const cells = groupCells(healthyCorpus());
    const corpus = scoreCorpus({
      cells: cells.map((c) => ({
        scenario: c.scenario,
        difficulty: c.difficulty,
        mandrelRuns: c.mandrelRuns,
        controlRuns: c.controlRuns,
      })),
    });
    const rows = dimensionRows(cells[0], corpus.perScenario[0], 'iqr');
    const pf = rows.find((r) => r.metric === 'planningFidelity');
    assert.equal(pf.verdict, 'incomparable');
    assert.equal(pf.controlBand, null); // control authored no plan
    assert.ok(pf.mandrelBand); // mandrel still has a distribution
  });
});

describe('renderScalingView — per-difficulty ladder', () => {
  it('renders Efficiency + Overhead ratio across the ladder for both arms', () => {
    const cells = groupCells(healthyCorpus());
    const corpus = scoreCorpus({
      cells: cells.map((c) => ({
        scenario: c.scenario,
        difficulty: c.difficulty,
        mandrelRuns: c.mandrelRuns,
        controlRuns: c.controlRuns,
      })),
    });
    const md = renderScalingView(cells, corpus, 'iqr');
    assert.match(md, /Per-difficulty scaling view/);
    assert.match(md, /Tokens \(mandrel\)/);
    assert.match(md, /Tokens \(control\)/);
    assert.match(md, /Overhead ratio \(mandrel\)/);
    assert.match(md, /Overhead ratio \(control\)/);
    // Both rungs present.
    assert.match(md, /hello-world/);
    assert.match(md, /story-scope/);
  });

  it('reports monotonicity holding on a healthy corpus', () => {
    const cells = groupCells(healthyCorpus());
    const corpus = scoreCorpus({
      cells: cells.map((c) => ({
        scenario: c.scenario,
        difficulty: c.difficulty,
        mandrelRuns: c.mandrelRuns,
        controlRuns: c.controlRuns,
      })),
    });
    const md = renderScalingView(cells, corpus, 'iqr');
    assert.match(md, /Monotonicity holds/);
  });

  it('surfaces a monotonicity violation as an explicit calibration warning', () => {
    // Invert the ladder: hello-world MORE expensive than story-scope ⇒ efficiency
    // does not rise ⇒ violation.
    const broken = [];
    for (let i = 0; i < 4; i += 1) {
      broken.push(
        card({
          scenario: 'hello-world',
          arm: 'mandrel',
          runId: `hw-m-${i}`,
          totalTokens: 900000,
          tokenRatio: 1.0,
        }),
      );
      broken.push(
        card({
          scenario: 'story-scope',
          arm: 'mandrel',
          runId: `story-m-${i}`,
          totalTokens: 180000, // LOWER than hello-world → violation
          tokenRatio: 4.0, // HIGHER than hello-world → violation
        }),
      );
    }
    const cells = groupCells(broken);
    const corpus = scoreCorpus({
      cells: cells.map((c) => ({
        scenario: c.scenario,
        difficulty: c.difficulty,
        mandrelRuns: c.mandrelRuns,
        controlRuns: c.controlRuns,
      })),
    });
    const md = renderScalingView(cells, corpus, 'iqr');
    assert.match(md, /Calibration warning/);
    assert.match(md, /\[calibration\]/);
    assert.equal(corpus.difficultyMonotonicity.monotonicityHolds, false);
  });
});

describe('recommendImprovements — actionable, evidence-linked findings', () => {
  it('surfaces the overhead-floor estimate even when it does not trigger a recommendation', () => {
    const corpus = scoreCorpus({
      cells: groupCells(healthyCorpus()).map((c) => ({
        scenario: c.scenario,
        difficulty: c.difficulty,
        mandrelRuns: c.mandrelRuns,
        controlRuns: c.controlRuns,
      })),
    });
    const findings = recommendImprovements(corpus);
    const floorFinding = findings.find((f) =>
      f.id.startsWith('overhead-floor'),
    );
    assert.ok(floorFinding, 'overhead floor must always be surfaced');
    assert.match(floorFinding.evidence, /overhead floor/i);
  });

  it('recommends a ceremony-lite path when a positive floor buys no quality gain', () => {
    // hello-world: Mandrel costs far more tokens than control, SAME quality.
    const cards = [];
    for (let i = 0; i < 4; i += 1) {
      cards.push(
        card({
          scenario: 'hello-world',
          arm: 'mandrel',
          runId: `hw-m-${i}`,
          quality: 0.9,
          totalTokens: 200000,
          costUsd: 1.6,
        }),
      );
      cards.push(
        card({
          scenario: 'hello-world',
          arm: 'control',
          runId: `hw-c-${i}`,
          quality: 0.9, // identical quality → no gain
          totalTokens: 40000,
          costUsd: 0.3,
        }),
      );
    }
    const corpus = scoreCorpus({
      cells: groupCells(cards).map((c) => ({
        scenario: c.scenario,
        difficulty: c.difficulty,
        mandrelRuns: c.mandrelRuns,
        controlRuns: c.controlRuns,
      })),
    });
    const findings = recommendImprovements(corpus);
    const ceremonyLite = findings.find(
      (f) => f.id === 'overhead-floor-ceremony-lite',
    );
    assert.ok(ceremonyLite, 'expected a ceremony-lite recommendation');
    assert.equal(ceremonyLite.severity, 'high');
    assert.match(ceremonyLite.action, /ceremony/i);
  });

  it('flags a real value-dimension regression where control beats mandrel', () => {
    // story-scope: control quality clearly HIGHER than mandrel (a regression the
    // scaffolding should not cause).
    const cards = [];
    for (let i = 0; i < 4; i += 1) {
      cards.push(
        card({
          scenario: 'story-scope',
          arm: 'mandrel',
          runId: `story-m-${i}`,
          quality: 0.4 + i * 0.005,
        }),
      );
      cards.push(
        card({
          scenario: 'story-scope',
          arm: 'control',
          runId: `story-c-${i}`,
          quality: 0.9 - i * 0.005,
        }),
      );
    }
    const corpus = scoreCorpus({
      cells: groupCells(cards).map((c) => ({
        scenario: c.scenario,
        difficulty: c.difficulty,
        mandrelRuns: c.mandrelRuns,
        controlRuns: c.controlRuns,
      })),
    });
    const findings = recommendImprovements(corpus);
    const regression = findings.find((f) =>
      f.id.startsWith('regression-story-scope-quality'),
    );
    assert.ok(regression, 'expected a quality regression finding');
    assert.equal(regression.severity, 'medium');
  });
});

describe('renderReport — full Markdown', () => {
  it('renders every required section', () => {
    const md = renderReport({ scorecards: healthyCorpus(), method: 'iqr' });
    assert.match(md, /# Mandrel Self-Benchmark — Value-Add Report/);
    assert.match(md, /## Cohort/);
    assert.match(md, /## Dimension distributions \(Mandrel vs bare control\)/);
    assert.match(md, /## Per-difficulty scaling view/);
    assert.match(md, /## Recommended improvements/);
    // Every dimension label appears.
    assert.match(md, /Quality/);
    assert.match(md, /Planning fidelity/);
    assert.match(md, /Autonomy/);
    assert.match(md, /Maintainability/);
    assert.match(md, /Security/);
    assert.match(md, /Overhead ratio/);
    assert.match(md, /Efficiency · total tokens/);
  });

  it('is deterministic — identical corpus renders byte-for-byte identically', () => {
    const a = renderReport({ scorecards: healthyCorpus() });
    const b = renderReport({ scorecards: healthyCorpus() });
    assert.equal(a, b);
  });

  it('renders a graceful empty report for an empty corpus', () => {
    const md = renderReport({ scorecards: [] });
    assert.match(md, /nothing to render/i);
    assert.match(md, /## Recommended improvements/);
  });

  it('surfaces the standalone routing verdict so n/a value dims are explained (Story #48)', () => {
    const scorecards = [
      card({
        scenario: 'story-scope',
        arm: 'mandrel',
        routingVerdict: 'story',
        runId: 'm1',
      }),
      card({ scenario: 'story-scope', arm: 'control', runId: 'c1' }),
    ];
    const md = renderReport({ scorecards, method: 'iqr' });
    assert.match(md, /Mandrel routing: standalone Story/);
    assert.match(md, /overhead-ratio is \*\*n\/a\*\*/);
  });

  it('surfaces the routing-mismatch note and excludes the mismatched record from the rendered n (Epic #66, Story #76)', () => {
    const scorecards = [
      card({ scenario: 'story-scope', arm: 'mandrel', runId: 'm1' }),
      card({
        scenario: 'story-scope',
        arm: 'mandrel',
        runId: 'm2',
        routingMismatch: true,
      }),
      card({ scenario: 'story-scope', arm: 'control', runId: 'c1' }),
    ];
    const md = renderReport({ scorecards, method: 'iqr' });
    assert.match(md, /Routing mismatch: 50% of mandrel runs/);
    assert.match(md, /n = 1 mandrel \/ 1 control/);
  });

  it('flags a scenario section when the mismatch rate exceeds 25% (Epic #66, Story #76)', () => {
    const scorecards = [
      card({ scenario: 'story-scope', arm: 'mandrel', runId: 'm1' }),
      card({
        scenario: 'story-scope',
        arm: 'mandrel',
        runId: 'm2',
        routingMismatch: true,
      }),
      card({
        scenario: 'story-scope',
        arm: 'mandrel',
        runId: 'm3',
        routingMismatch: true,
      }),
    ];
    const md = renderReport({ scorecards, method: 'iqr' });
    assert.match(md, /above the 25% scope-triage threshold/);
  });

  it('marks the hello-world section with the floor/calibration framing note (Epic #66, Story #76)', () => {
    const md = renderReport({ scorecards: healthyCorpus(), method: 'iqr' });
    const hwIndex = md.indexOf('Scenario: `hello-world`');
    const storyIndex = md.indexOf('Scenario: `story-scope`');
    const hwSection = md.slice(hwIndex, storyIndex);
    assert.match(hwSection, /Floor\/calibration rung/);
    assert.doesNotMatch(md.slice(storyIndex), /Floor\/calibration rung/);
  });

  it('surfaces the mixed-cohort warning in the header', () => {
    const md = renderReport({
      scorecards: [
        card({ runId: 'a', frameworkVersion: '1.70.0' }),
        card({ runId: 'b', frameworkVersion: '1.71.0' }),
      ],
    });
    assert.match(md, /Mixed cohort/);
  });

  it('stamps the benchmark version in the cohort header (D-014)', () => {
    const md = renderReport({ scorecards: healthyCorpus(), method: 'iqr' });
    assert.match(md, /\*\*Benchmark version:\*\* 0\.5\.0/);
  });

  it('labels a benchmark-version-mixed cell non-inferential and emits no noise-band for it (D-014)', () => {
    // A hello-world cell whose runs span two benchmark versions within one
    // (model, frameworkVersion) cohort must not be pooled into a band.
    const scorecards = [
      card({ runId: 'm-a', arm: 'mandrel', benchmarkVersion: '0.5.0' }),
      card({ runId: 'm-b', arm: 'mandrel', benchmarkVersion: '0.6.0' }),
      card({ runId: 'c-a', arm: 'control', benchmarkVersion: '0.5.0' }),
      card({ runId: 'c-b', arm: 'control', benchmarkVersion: '0.6.0' }),
    ];
    const md = renderReport({ scorecards, method: 'iqr' });
    // The corpus is labelled non-inferential at the grouping seam...
    assert.match(md, /Non-inferential corpus/);
    assert.match(md, /0\.5\.0, 0\.6\.0/);
    // ...and the whole corpus header flags the benchmark-version mix.
    assert.match(md, /Mixed cohort/);
  });

  it('throws on a non-array corpus', () => {
    assert.throws(() => renderReport({ scorecards: 'nope' }), TypeError);
  });
});

describe('buildReportModel — structured form', () => {
  it('returns the same findings the Markdown is built from', () => {
    const model = buildReportModel({ scorecards: healthyCorpus() });
    assert.equal(model.scenarios.length, 2);
    assert.ok(Array.isArray(model.recommendations));
    assert.ok(model.overheadFloor); // hello-world present → floor computed
    assert.equal(model.monotonicity.monotonicityHolds, true);
  });

  it('carries the trap-axis rows and the autonomy-guardrail rows (Epic #66, Story #79)', () => {
    const model = buildReportModel({ scorecards: healthyCorpus() });
    for (const s of model.scenarios) {
      assert.ok(Array.isArray(s.trap));
    }
    assert.ok(Array.isArray(model.autonomyGuardrail));
  });
});

describe('trapAxisRows — differential trap axis (Epic #66, Story #79)', () => {
  const trapMandrel = card({
    scenario: 'story-scope',
    arm: 'mandrel',
    runId: 'trap-m-1',
    trap: {
      classes: [
        { class: 'plaintext-password', score: 1, defectPresent: false },
      ],
      cleanRate: 1,
    },
  });
  const trapControl = card({
    scenario: 'story-scope',
    arm: 'control',
    runId: 'trap-c-1',
    trap: {
      classes: [{ class: 'plaintext-password', score: 0, defectPresent: true }],
      cleanRate: 0,
    },
  });

  it('returns [] for a cell with no trap data', () => {
    const cells = groupCells([card({ scenario: 'hello-world' })]);
    assert.deepEqual(trapAxisRows(cells[0], 'iqr'), []);
  });

  it('summarizes each declared class plus a cleanRate row as mean/spread/min per arm', () => {
    const cells = groupCells([trapMandrel, trapControl]);
    const rows = trapAxisRows(cells[0], 'iqr');
    const classRow = rows.find((r) => r.label === 'plaintext-password');
    assert.ok(classRow);
    assert.equal(classRow.mandrel.mean, 1);
    assert.equal(classRow.mandrel.min, 1);
    assert.equal(classRow.control.mean, 0);
    assert.equal(classRow.control.min, 0);
    const cleanRateRow = rows.find((r) => r.metric === 'trap.cleanRate');
    assert.ok(cleanRateRow);
    assert.equal(cleanRateRow.mandrel.mean, 1);
    assert.equal(cleanRateRow.control.mean, 0);
  });

  it('renders the trap axis in its own section, separate from the seven dimensions', () => {
    const md = renderReport({
      scorecards: [trapMandrel, trapControl],
      method: 'iqr',
    });
    assert.match(md, /Trap axis \(differential/);
    assert.match(md, /plaintext-password/);
  });
});

describe('autonomy guardrail — mandrel-arm pass/fail, never a delta (Epic #66, Story #77/#79)', () => {
  it('reports met/dropped/unmeasured counts per scenario', () => {
    const cells = groupCells([
      card({
        scenario: 'hello-world',
        arm: 'mandrel',
        runId: 'm1',
        autonomyGuardrailMet: true,
      }),
      card({
        scenario: 'hello-world',
        arm: 'mandrel',
        runId: 'm2',
        autonomyGuardrailMet: false,
      }),
    ]);
    const rows = autonomyGuardrailRows(cells);
    const row = rows.find((r) => r.scenario === 'hello-world');
    assert.equal(row.n, 2);
    assert.equal(row.met, 1);
    assert.equal(row.dropped, 1);
    assert.equal(row.threshold, 0.99);
  });

  it('surfaces a finding when a scenario has a dropped run', () => {
    const cells = groupCells([
      card({
        scenario: 'hello-world',
        arm: 'mandrel',
        runId: 'm1',
        autonomyGuardrailMet: false,
      }),
    ]);
    const findings = autonomyGuardrailFindings(cells);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].id, 'autonomy-guardrail-drop-hello-world');
  });

  it('does not appear as a Mandrel-vs-control delta row in the dimension table', () => {
    const md = renderReport({ scorecards: healthyCorpus(), method: 'iqr' });
    assert.match(md, /## Autonomy guardrail \(mandrel arm\)/);
    assert.doesNotMatch(md, /\| Autonomy \|/);
  });
});

describe('renderMismatchNote — direct coverage (Epic #66 audit remediation, M4-M10)', () => {
  it('returns "" when the cell has no mismatched records', () => {
    assert.equal(renderMismatchNote({ mismatchedRuns: [] }), '');
    assert.equal(renderMismatchNote({}), '');
  });

  it('renders the plain note when below the 25% scope-triage threshold', () => {
    const note = renderMismatchNote({
      mismatchedRuns: [{ runId: 'm-1' }],
      mismatchRate: 0.2,
      mismatchFlag: false,
    });
    assert.match(note, /Routing mismatch: 20% of mandrel runs/);
    assert.match(note, /\(1 record\(s\)\)/);
    assert.doesNotMatch(note, /⚠️/);
  });

  it('renders the warning-emoji branch when mismatchFlag is true (above threshold)', () => {
    const note = renderMismatchNote({
      mismatchedRuns: [{ runId: 'm-1' }, { runId: 'm-2' }, { runId: 'm-3' }],
      mismatchRate: 1 / 3,
      mismatchFlag: true,
    });
    assert.match(note, /⚠️ \*\*Routing mismatch: 33\.3% of mandrel runs\*\*/);
    assert.match(note, /\(3 record\(s\)\)/);
    assert.match(note, /above the 25% scope-triage threshold/);
  });
});

describe('renderFloorCalibrationNote — direct coverage (Epic #66 audit remediation, M4-M10)', () => {
  it('returns "" for a cell not tagged floorCalibration', () => {
    assert.equal(renderFloorCalibrationNote({ floorCalibration: false }), '');
    assert.equal(renderFloorCalibrationNote({}), '');
  });

  it('renders the floor/calibration framing note when floorCalibration is true', () => {
    const note = renderFloorCalibrationNote({ floorCalibration: true });
    assert.match(note, /🧭 \*\*Floor\/calibration rung\*\*/);
    assert.match(note, /instrumentation, not a value rung/);
  });
});

describe('per-phase cost (D-019, Epic #86 Story #94)', () => {
  const PHASES = [
    { phase: 'plan', costUsd: 0.4, tokens: 40000, wallClockMs: 120000 },
    { phase: 'deliver', costUsd: 1.0, tokens: 140000, wallClockMs: 480000 },
  ];

  function corpus() {
    const cards = [];
    for (let i = 0; i < 3; i += 1) {
      cards.push(
        card({
          scenario: 'story-scope',
          arm: 'mandrel',
          runId: `ss-m-${i}`,
          phases: PHASES,
        }),
      );
      // Control carries NO phases block.
      cards.push(
        card({ scenario: 'story-scope', arm: 'control', runId: `ss-c-${i}` }),
      );
    }
    return cards;
  }

  it('phaseCostRows: reports mean plan/deliver cost for the mandrel arm, omitting control', () => {
    const rows = phaseCostRows(groupCells(corpus()));
    assert.equal(rows.length, 1);
    const [r] = rows;
    assert.equal(r.scenario, 'story-scope');
    assert.ok(Math.abs(r.planCostUsd - 0.4) < 1e-9);
    assert.ok(Math.abs(r.deliverCostUsd - 1.0) < 1e-9);
    assert.ok(Math.abs(r.totalCostUsd - 1.4) < 1e-9);
  });

  it('phaseCostRows: returns [] when no record carries a phases block (control-only/legacy)', () => {
    const cards = [
      card({ scenario: 'story-scope', arm: 'mandrel', runId: 'm1' }),
      card({ scenario: 'story-scope', arm: 'control', runId: 'c1' }),
    ];
    assert.deepEqual(phaseCostRows(groupCells(cards)), []);
  });

  it('renderPhaseCostSection: renders a mandrel-only per-phase cost table', () => {
    const md = renderPhaseCostSection(groupCells(corpus()));
    assert.match(md, /Per-phase cost \(mandrel arm\)/);
    assert.match(md, /Plan cost \(USD\)/);
    assert.match(md, /Deliver cost \(USD\)/);
    assert.match(md, /`story-scope`/);
    assert.match(md, /0\.4/);
  });

  it('renderPhaseCostSection: empty string when there is no phase data', () => {
    assert.equal(renderPhaseCostSection([]), '');
  });

  it('renderReport: includes the per-phase cost section when phases are present', () => {
    const md = renderReport({ scorecards: corpus() });
    assert.match(md, /Per-phase cost \(mandrel arm\)/);
  });
});

describe('plan-vs-deliver attribution table (Epic #86, Story #95)', () => {
  // Attach a planQuality block to a card so the attribution table has data.
  const withPlanQuality = (opts, planQuality) => {
    const sc = card(opts);
    sc.planQuality = planQuality;
    return sc;
  };

  it('attributionRows tallies each mandrel run computed from planQuality × outcome × adherence', () => {
    const scorecards = [
      // good plan + good outcome → working-as-intended
      withPlanQuality(
        {
          scenario: 'epic-scope',
          arm: 'mandrel',
          runId: 'e1',
          quality: 0.95,
          planningFidelity: 0.9,
        },
        { score: 0.9 },
      ),
      // good plan + weak outcome + adhered → plan-phase-gap
      withPlanQuality(
        {
          scenario: 'epic-scope',
          arm: 'mandrel',
          runId: 'e2',
          quality: 0.3,
          planningFidelity: 0.9,
        },
        { score: 0.9 },
      ),
      // weak plan + good outcome → model-compensating
      withPlanQuality(
        {
          scenario: 'epic-scope',
          arm: 'mandrel',
          runId: 'e3',
          quality: 0.95,
          planningFidelity: 0.9,
        },
        { score: 0.2 },
      ),
      // control arm has no planQuality → skipped
      card({ scenario: 'epic-scope', arm: 'control', runId: 'e-c' }),
    ];
    const rows = attributionRows(groupCells(scorecards));
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.scenario, 'epic-scope');
    assert.equal(
      row.n,
      3,
      'only the three mandrel runs with planQuality are counted',
    );
    assert.equal(row.counts['working-as-intended'], 1);
    assert.equal(row.counts['plan-phase-gap'], 1);
    assert.equal(row.counts['model-compensating'], 1);
    assert.equal(row.counts['deliver-phase-gap'], 0);
  });

  it('honours a persisted attribution.classification when present', () => {
    const scorecards = [
      withPlanQuality(
        {
          scenario: 'epic-scope',
          arm: 'mandrel',
          runId: 'e1',
          quality: 0.95,
          planningFidelity: 0.9,
        },
        { score: 0.9, attribution: { classification: 'deliver-phase-gap' } },
      ),
    ];
    const rows = attributionRows(groupCells(scorecards));
    assert.equal(rows[0].counts['deliver-phase-gap'], 1);
    assert.equal(rows[0].counts['working-as-intended'], 0);
  });

  it('renderAttributionSection renders the table and is wired into renderReport', () => {
    const scorecards = [
      withPlanQuality(
        {
          scenario: 'epic-scope',
          arm: 'mandrel',
          runId: 'e1',
          quality: 0.95,
          planningFidelity: 0.9,
        },
        { score: 0.9 },
      ),
    ];
    const cells = groupCells(scorecards);
    const section = renderAttributionSection(cells);
    assert.match(section, /Plan-vs-deliver attribution \(mandrel arm\)/);
    assert.match(section, /Working as intended/);
    const md = renderReport({ scorecards });
    assert.match(md, /Plan-vs-deliver attribution \(mandrel arm\)/);
  });

  it('renders nothing for a corpus with no planQuality blocks', () => {
    const scorecards = [
      card({ scenario: 'epic-scope', arm: 'mandrel', runId: 'e1' }),
      card({ scenario: 'epic-scope', arm: 'control', runId: 'e-c' }),
    ];
    assert.equal(renderAttributionSection(groupCells(scorecards)), '');
    assert.equal(attributionRows(groupCells(scorecards)).length, 0);
  });
});
