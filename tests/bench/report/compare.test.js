// tests/bench/report/compare.test.js
//
// Unit tier (pure logic, no I/O) for the cross-run comparison
// (Epic #4211, Story #4218). Exercises bench/report/compare.js against the
// Story's binding acceptance item:
//   "surfaces the per-dimension deltas between two stored runs."
// Covers: per-dimension Mandrel-arm shift with the real-delta rule
// (improved / regressed / within-noise / incomparable), cohort-mismatch
// flagging, scenario presence in only one run, and the Markdown rendering.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  compareRuns,
  renderComparison,
} from '../../../bench/report/compare.js';

const MODEL = { id: 'claude-opus-4-8[1m]' };
const ENV = { node: 'v24.16.0', os: 'darwin' };

function card({
  scenario = 'hello-world',
  arm = 'mandrel',
  runId = `${scenario}-${arm}-r1`,
  quality = 1,
  planningFidelity = 0.9,
  autonomy = 1,
  maintainability = 0.9,
  security = 1,
  tokenRatio = 4,
  wallClockMs = 600000,
  totalTokens = 180000,
  dispatches = 2,
  costUsd = 1.4,
  frameworkVersion = '1.70.0',
  benchmarkVersion = '0.5.0',
  model = MODEL,
  env = ENV,
} = {}) {
  return {
    schemaVersion: 1,
    runId,
    timestamp: '2026-06-16T19:42:11.000Z',
    model,
    frameworkVersion,
    benchmarkVersion,
    env,
    scenario,
    arm,
    dimensions: {
      quality: { score: quality, frozenSuitePassRate: quality },
      planningFidelity: { score: arm === 'control' ? null : planningFidelity },
      autonomy: {
        score: autonomy,
        hitlStops: 0,
        blockedEvents: 0,
        manualRescues: 0,
      },
      maintainability: { score: maintainability },
      security: { score: security },
      overheadRatio: { tokenRatio },
      efficiency: { wallClockMs, totalTokens, dispatches, costUsd },
    },
  };
}

/** A run of N mandrel hello-world cards at a given quality center. */
function run({
  quality,
  totalTokens = 180000,
  fw = '1.70.0',
  bv = '0.5.0',
  model = MODEL,
  n = 4,
} = {}) {
  const cards = [];
  for (let i = 0; i < n; i += 1) {
    cards.push(
      card({
        scenario: 'hello-world',
        arm: 'mandrel',
        runId: `hw-m-${fw}-${bv}-${i}`,
        quality: quality + (i % 2 === 0 ? 0.002 : -0.002),
        totalTokens: totalTokens + i * 100,
        frameworkVersion: fw,
        benchmarkVersion: bv,
        model,
      }),
    );
    cards.push(
      card({
        scenario: 'hello-world',
        arm: 'control',
        runId: `hw-c-${fw}-${bv}-${i}`,
        quality: 0.5,
        totalTokens: 40000,
        tokenRatio: 0.1,
        frameworkVersion: fw,
        benchmarkVersion: bv,
        model,
      }),
    );
  }
  return cards;
}

describe('compareRuns — per-dimension cross-run deltas', () => {
  it('flags a real quality improvement when the candidate center clears the noise', () => {
    const baseline = run({ quality: 0.6 });
    const candidate = run({ quality: 0.95 });
    const cmp = compareRuns({ baseline, candidate });
    const hw = cmp.scenarios.find((s) => s.scenario === 'hello-world');
    const quality = hw.metrics.find((m) => m.metric === 'quality');
    assert.equal(quality.mandrel.comparable, true);
    assert.equal(quality.mandrel.verdict, 'improved');
    assert.ok(quality.mandrel.shift > 0);
    assert.ok(Math.abs(quality.mandrel.shift) > quality.mandrel.noiseFloor);
  });

  it('flags a real regression when the candidate quality center drops', () => {
    const baseline = run({ quality: 0.95 });
    const candidate = run({ quality: 0.6 });
    const cmp = compareRuns({ baseline, candidate });
    const quality = cmp.scenarios[0].metrics.find(
      (m) => m.metric === 'quality',
    );
    assert.equal(quality.mandrel.verdict, 'regressed');
    assert.ok(quality.mandrel.shift < 0);
  });

  it('treats overheadRatio as lower-is-better (a drop is an improvement)', () => {
    const baseline = [];
    const candidate = [];
    for (let i = 0; i < 4; i += 1) {
      baseline.push(
        card({ runId: `b-${i}`, tokenRatio: 4.0 + (i % 2 ? 0.01 : -0.01) }),
      );
      candidate.push(
        card({ runId: `c-${i}`, tokenRatio: 1.0 + (i % 2 ? 0.01 : -0.01) }),
      );
    }
    const cmp = compareRuns({ baseline, candidate });
    const overhead = cmp.scenarios[0].metrics.find(
      (m) => m.metric === 'overheadRatio',
    );
    assert.equal(overhead.mandrel.verdict, 'improved'); // ratio fell
    assert.ok(overhead.mandrel.shift < 0);
  });

  it('reports a hair-thin shift inside the band as within-noise', () => {
    // Wide spread, nearly-identical centers ⇒ within noise.
    const wide = (rid, fw) => [
      card({ runId: `${rid}-0`, quality: 0.4, frameworkVersion: fw }),
      card({ runId: `${rid}-1`, quality: 1.0, frameworkVersion: fw }),
      card({ runId: `${rid}-2`, quality: 0.5, frameworkVersion: fw }),
      card({ runId: `${rid}-3`, quality: 0.95, frameworkVersion: fw }),
    ];
    const cmp = compareRuns({
      baseline: wide('b', '1.70.0'),
      candidate: wide('c', '1.70.0'),
    });
    const quality = cmp.scenarios[0].metrics.find(
      (m) => m.metric === 'quality',
    );
    assert.equal(quality.mandrel.verdict, 'within-noise');
    assert.equal(quality.mandrel.shiftIsReal, false);
  });

  it('surfaces both arms’ centers for traceability', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.6 }),
      candidate: run({ quality: 0.9 }),
    });
    const quality = cmp.scenarios[0].metrics.find(
      (m) => m.metric === 'quality',
    );
    assert.ok(typeof quality.controlBaselineCenter === 'number');
    assert.ok(typeof quality.controlCandidateCenter === 'number');
  });

  it('includes every comparable metric (5 dimensions + 4 efficiency components; autonomy is a guardrail, not a delta — Epic #66, Story #77/#79)', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.9 }),
      candidate: run({ quality: 0.9 }),
    });
    const metricNames = cmp.scenarios[0].metrics.map((m) => m.metric);
    assert.equal(metricNames.length, 9);
    assert.ok(!metricNames.includes('autonomy'));
    assert.ok(metricNames.includes('quality'));
    assert.ok(metricNames.includes('maintainability'));
    assert.ok(metricNames.includes('security'));
    assert.ok(metricNames.includes('efficiency.totalTokens'));
    assert.ok(metricNames.includes('efficiency.costUsd'));
  });
});

describe('compareRuns — cohort safety', () => {
  it('matches cohorts when both runs share one (model, fw, env)', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.9, fw: '1.70.0' }),
      candidate: run({ quality: 0.9, fw: '1.70.0' }),
    });
    assert.equal(cmp.cohortMatch, true);
    assert.equal(cmp.cohortMismatchWarning, undefined);
  });

  it('flags (does not throw on) a cross-cohort comparison', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.9, fw: '1.70.0' }),
      candidate: run({ quality: 0.9, fw: '1.71.0' }),
    });
    assert.equal(cmp.cohortMatch, false);
    assert.match(cmp.cohortMismatchWarning, /not strictly like-to-like/);
  });

  it('annotates the single cohort key that changed (framework version only)', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.9, fw: '1.70.0', bv: '0.5.0' }),
      candidate: run({ quality: 0.9, fw: '1.71.0', bv: '0.5.0' }),
    });
    assert.equal(cmp.cohortMatch, false);
    assert.deepEqual(cmp.changedCohortKeys, ['frameworkVersion']);
    assert.equal(cmp.confounded, false);
    assert.match(cmp.cohortMismatchWarning, /only cohort key that changed/);
    assert.match(cmp.cohortMismatchWarning, /frameworkVersion/);
  });

  it('annotates a benchmark-version-only change (D-014)', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.9, fw: '1.70.0', bv: '0.5.0' }),
      candidate: run({ quality: 0.9, fw: '1.70.0', bv: '0.6.0' }),
    });
    assert.equal(cmp.cohortMatch, false);
    assert.deepEqual(cmp.changedCohortKeys, ['benchmarkVersion']);
    assert.equal(cmp.confounded, false);
    assert.match(cmp.cohortMismatchWarning, /benchmarkVersion/);
  });

  it('flags the comparison CONFOUNDED when more than one cohort key changed', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.9, fw: '1.70.0', bv: '0.5.0' }),
      candidate: run({ quality: 0.9, fw: '1.71.0', bv: '0.6.0' }),
    });
    assert.equal(cmp.cohortMatch, false);
    assert.equal(cmp.confounded, true);
    assert.deepEqual(cmp.changedCohortKeys, [
      'frameworkVersion',
      'benchmarkVersion',
    ]);
    assert.match(cmp.cohortMismatchWarning, /CONFOUNDED/);
  });

  it('leaves the attribution fields off a matched (single-cohort) comparison', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.9, fw: '1.70.0', bv: '0.5.0' }),
      candidate: run({ quality: 0.9, fw: '1.70.0', bv: '0.5.0' }),
    });
    assert.equal(cmp.cohortMatch, true);
    assert.equal(cmp.changedCohortKeys, undefined);
    assert.equal(cmp.confounded, undefined);
  });

  it('throws on non-array inputs', () => {
    assert.throws(
      () => compareRuns({ baseline: null, candidate: [] }),
      TypeError,
    );
  });
});

describe('compareRuns — internally multi-cohort runs are non-inferential (M7)', () => {
  it('suppresses a baseline run’s bands (null centers) when it mixes benchmark versions', () => {
    // A single run that internally spans >1 benchmarkVersion must NOT pool into
    // a shown band — matching groupCells’s "no band at the grouping seam"
    // contract. Its centers are nulled, not flagged-but-shown.
    const baseline = [
      ...run({ quality: 0.9, bv: '0.5.0', n: 2 }),
      ...run({ quality: 0.9, bv: '0.6.0', n: 2 }),
    ];
    const candidate = run({ quality: 0.9, bv: '0.6.0' });
    const cmp = compareRuns({ baseline, candidate });
    assert.equal(cmp.baselineNonInferential, true);
    assert.equal(cmp.candidateNonInferential, false);
    const quality = cmp.scenarios[0].metrics.find(
      (m) => m.metric === 'quality',
    );
    assert.equal(quality.mandrel.baselineCenter, null);
    assert.equal(quality.mandrel.comparable, false);
    assert.equal(quality.mandrel.verdict, 'incomparable');
    assert.equal(quality.controlBaselineCenter, null);
  });

  it('leaves single-benchmark-version runs fully comparable', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.9, bv: '0.5.0' }),
      candidate: run({ quality: 0.9, bv: '0.5.0' }),
    });
    assert.equal(cmp.baselineNonInferential, false);
    assert.equal(cmp.candidateNonInferential, false);
    const quality = cmp.scenarios[0].metrics.find(
      (m) => m.metric === 'quality',
    );
    assert.equal(quality.mandrel.comparable, true);
  });

  it('notes the suppression in the rendered Markdown', () => {
    const baseline = [
      ...run({ quality: 0.9, bv: '0.5.0', n: 2 }),
      ...run({ quality: 0.9, bv: '0.6.0', n: 2 }),
    ];
    const candidate = run({ quality: 0.9, bv: '0.6.0' });
    const md = renderComparison(compareRuns({ baseline, candidate }));
    assert.match(md, /Non-inferential run/);
  });
});

describe('compareRuns — scenario presence', () => {
  it('marks a scenario present in only one run as not cross-comparable', () => {
    const baseline = run({ quality: 0.9 }); // hello-world only
    const candidate = [
      ...run({ quality: 0.9 }),
      card({
        scenario: 'story-scope',
        arm: 'mandrel',
        runId: 'story-m',
        quality: 0.8,
      }),
    ];
    const cmp = compareRuns({ baseline, candidate });
    const story = cmp.scenarios.find((s) => s.scenario === 'story-scope');
    assert.equal(story.inBaseline, false);
    assert.equal(story.inCandidate, true);
  });
});

describe('renderComparison — Markdown', () => {
  it('renders the cohort line and a per-scenario delta table', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.6 }),
      candidate: run({ quality: 0.95 }),
    });
    const md = renderComparison(cmp, {
      baselineLabel: 'v1.70.0',
      candidateLabel: 'v1.71.0',
    });
    assert.match(md, /Cross-run comparison/);
    assert.match(md, /v1\.70\.0/);
    assert.match(md, /v1\.71\.0/);
    assert.match(md, /Scenario: `hello-world`/);
    assert.match(md, /improved/);
    assert.match(md, /Cohort:.*matched/);
  });

  it('renders the cohort-mismatch warning in the Markdown', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.9, fw: '1.70.0' }),
      candidate: run({ quality: 0.9, fw: '1.71.0' }),
    });
    const md = renderComparison(cmp);
    assert.match(md, /Cohort mismatch/);
  });

  it('is deterministic', () => {
    const cmp = compareRuns({
      baseline: run({ quality: 0.6 }),
      candidate: run({ quality: 0.95 }),
    });
    assert.equal(renderComparison(cmp), renderComparison(cmp));
  });
});
