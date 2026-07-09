// tests/bench/score/dimensions.test.js
//
// Unit tier (pure logic, no I/O) for the seven-dimension scorer
// (Epic #4211, Story #4217; extended by Epic #32, Story #36). Exercises
// bench/score/dimensions.js against the verbatim formulas in
// bench/metrics/README.md § "The five dimensions" (original) plus the
// Story #36 additions:
// quality, planningFidelity, autonomy, maintainability, security,
// efficiency, overheadRatio — plus the control-arm null behaviour, the
// divide-by-zero / no-codegen edges, and the judge-fold-when-null path for
// each two-oracle dimension.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeAutonomy,
  computeAutonomyGuardrail,
  computeDimensions,
  computeEfficiency,
  computeMaintainability,
  computeOverheadRatio,
  computePlanningFidelity,
  computeQuality,
  computeSecurity,
  DEFAULT_AUTONOMY_GUARDRAIL_THRESHOLD,
  fileFootprintDrift,
  MAINTAINABILITY_WEIGHTS,
  QUALITY_WEIGHTS,
  SECURITY_WEIGHTS,
} from '../../../bench/score/dimensions.js';

const approx = (actual, expected, eps = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} ≈ ${expected} (±${eps})`,
  );

describe('computeQuality', () => {
  it('blends frozen-suite pass rate (0.7) and judge score (0.3)', () => {
    const q = computeQuality({
      frozenSuitePassed: 6,
      frozenSuiteTotal: 6,
      acceptanceEvalScore: 0.5,
    });
    approx(q.frozenSuitePassRate, 1);
    // 0.7*1 + 0.3*0.5 = 0.85
    approx(q.score, QUALITY_WEIGHTS.suite * 1 + QUALITY_WEIGHTS.judge * 0.5);
    assert.equal(q.frozenSuitePassed, 6);
    assert.equal(q.frozenSuiteTotal, 6);
    assert.equal(q.acceptanceEvalScore, 0.5);
  });

  it('folds judge weight onto the suite when acceptanceEvalScore is null', () => {
    const q = computeQuality({
      frozenSuitePassed: 3,
      frozenSuiteTotal: 4,
      acceptanceEvalScore: null,
    });
    approx(q.frozenSuitePassRate, 0.75);
    // judge null ⇒ score === pass rate (w_suite renormalized to 1.0)
    approx(q.score, 0.75);
    assert.equal(q.acceptanceEvalScore, null);
  });

  it('treats a missing judge score the same as null', () => {
    const q = computeQuality({ frozenSuitePassed: 1, frozenSuiteTotal: 2 });
    approx(q.score, 0.5);
    assert.equal(q.acceptanceEvalScore, null);
  });

  it('scores a delivered-but-empty suite (total 0) as 0, not NaN', () => {
    const q = computeQuality({ frozenSuitePassed: 0, frozenSuiteTotal: 0 });
    approx(q.frozenSuitePassRate, 0);
    approx(q.score, 0);
  });

  it('a run that fails every assertion scores 0', () => {
    const q = computeQuality({
      frozenSuitePassed: 0,
      frozenSuiteTotal: 6,
      acceptanceEvalScore: 0,
    });
    approx(q.score, 0);
  });

  it('clamps an out-of-range judge score into [0,1]', () => {
    const q = computeQuality({
      frozenSuitePassed: 2,
      frozenSuiteTotal: 2,
      acceptanceEvalScore: 5,
    });
    assert.ok(q.acceptanceEvalScore <= 1 && q.acceptanceEvalScore >= 0);
    assert.ok(q.score <= 1);
  });
});

describe('fileFootprintDrift', () => {
  it('is 0 for identical path sets', () => {
    approx(fileFootprintDrift(['a', 'b'], ['a', 'b']), 0);
  });

  it('is 1 for disjoint path sets', () => {
    approx(fileFootprintDrift(['a'], ['b']), 1);
  });

  it('is the Jaccard distance for partial overlap', () => {
    // P={a,b,c} A={b,c,d} ∩=2 ∪=4 ⇒ 1 − 2/4 = 0.5
    approx(fileFootprintDrift(['a', 'b', 'c'], ['b', 'c', 'd']), 0.5);
  });

  it('is 0 when both sets are empty', () => {
    approx(fileFootprintDrift([], []), 0);
  });
});

describe('computePlanningFidelity', () => {
  it('averages story accuracy, re-plan penalty, and footprint accuracy', () => {
    const pf = computePlanningFidelity({
      arm: 'mandrel',
      rePlanCount: 0,
      plannedStoryCount: 2,
      deliveredStoryCount: 2,
      fileFootprintDrift: 0,
    });
    // storyAccuracy=1, rePlanPenalty=1, footprintAccuracy=1 ⇒ 1
    approx(pf.score, 1);
  });

  it('penalizes re-plans and story-count drift', () => {
    const pf = computePlanningFidelity({
      arm: 'mandrel',
      rePlanCount: 1, // penalty = 1/2
      plannedStoryCount: 2,
      deliveredStoryCount: 4, // accuracy = 1 - 2/4 = 0.5
      fileFootprintDrift: 0.25, // footprintAccuracy = 0.75
    });
    approx(pf.score, (0.5 + 0.5 + 0.75) / 3);
  });

  it('derives footprint drift from planned/actual paths when not supplied', () => {
    const pf = computePlanningFidelity({
      arm: 'mandrel',
      rePlanCount: 0,
      plannedStoryCount: 1,
      deliveredStoryCount: 1,
      plannedPaths: ['a', 'b'],
      actualPaths: ['b', 'c'], // ∩=1 ∪=3 ⇒ drift 2/3, footprintAccuracy 1/3
    });
    approx(pf.fileFootprintDrift, 2 / 3);
    approx(pf.score, (1 + 1 + 1 / 3) / 3);
  });

  it('is null for the control arm (no plan authored)', () => {
    const pf = computePlanningFidelity({
      arm: 'control',
      plannedStoryCount: 0,
      deliveredStoryCount: 1,
    });
    assert.equal(pf.score, null);
    // sub-signals still reported for shape stability
    assert.equal(pf.deliveredStoryCount, 1);
  });

  it('honours an explicit planAuthored:false override', () => {
    const pf = computePlanningFidelity({ planAuthored: false });
    assert.equal(pf.score, null);
  });

  it('scores null when the plan was not observed (no lifecycle ledger)', () => {
    // The mandrel arm with no ledger carries planned/delivered counts of 0/0,
    // which would otherwise compute a perfect storyAccuracy (|0−0|/max(…,1)=0
    // → 1) and a flawless score of 1. planObserved:false makes that unmeasured
    // case null instead of crediting Mandrel with planning it never showed.
    const pf = computePlanningFidelity({
      arm: 'mandrel',
      plannedStoryCount: 0,
      deliveredStoryCount: 0,
      planObserved: false,
    });
    assert.equal(pf.score, null);
  });

  describe('footprint proportionality (§8)', () => {
    it('scores a perfect delivery whose plan declares ≤1 file as 1.0 (footprint dropped)', () => {
      // A single-file plan whose declared path doesn't literally match the
      // one file actually touched (a natural naming guess) previously
      // clobbered a perfect delivery to (1 + 1 + 0) / 3 ≈ 0.667.
      const pf = computePlanningFidelity({
        arm: 'mandrel',
        rePlanCount: 0,
        plannedStoryCount: 1,
        deliveredStoryCount: 1,
        plannedPaths: ['index.js'],
        actualPaths: ['server.js'], // disjoint ⇒ drift 1, but plan is 1 file
      });
      approx(pf.score, 1);
      assert.equal(pf.footprintDropped, true);
    });

    it('drops the footprint term for a 0-file declared plan (plannedPaths absent, actualPaths tracked)', () => {
      // The standalone-path shape: no plannedPaths at all, only actualPaths
      // from the merged PR's file list. Previously this always computed
      // drift 1.0 (P empty ⇒ maximal Jaccard distance) regardless of quality.
      const pf = computePlanningFidelity({
        arm: 'mandrel',
        rePlanCount: 0,
        plannedStoryCount: 1,
        deliveredStoryCount: 1,
        actualPaths: ['src/server.js', 'src/store.js'],
      });
      approx(pf.score, 1);
      assert.equal(pf.footprintDropped, true);
      approx(pf.fileFootprintDrift, 1); // still reported, just excluded from the mean
    });

    it('drops the footprint term for an explicit plannedFileCount ≤ 1', () => {
      const pf = computePlanningFidelity({
        arm: 'mandrel',
        rePlanCount: 0,
        plannedStoryCount: 1,
        deliveredStoryCount: 1,
        plannedFileCount: 1,
        fileFootprintDrift: 0.9,
      });
      approx(pf.score, 1);
      assert.equal(pf.footprintDropped, true);
    });

    it('keeps the footprint term in the mean once the declared plan exceeds 1 file', () => {
      const pf = computePlanningFidelity({
        arm: 'mandrel',
        rePlanCount: 0,
        plannedStoryCount: 1,
        deliveredStoryCount: 1,
        plannedPaths: ['a.js', 'b.js'],
        actualPaths: ['a.js', 'b.js'],
      });
      approx(pf.score, 1);
      assert.equal(pf.footprintDropped, false);
    });

    it('a large plan with one incidental miss is penalized far less than a small one', () => {
      const bigPlan = computePlanningFidelity({
        arm: 'mandrel',
        plannedPaths: Array.from({ length: 10 }, (_, i) => `f${i}.js`),
        actualPaths: [
          ...Array.from({ length: 9 }, (_, i) => `f${i}.js`),
          'extra.js',
        ],
      });
      const smallPlan = computePlanningFidelity({
        arm: 'mandrel',
        plannedPaths: ['a.js', 'b.js'],
        actualPaths: ['a.js', 'extra.js'],
      });
      assert.ok(bigPlan.score > smallPlan.score);
    });

    it('does not drop the footprint term when plan size is unknown (bare scalar drift, no path arrays)', () => {
      // Back-compat: a caller that only ever reports the scalar drift (no
      // plannedPaths/actualPaths/plannedFileCount) carries no plan-size
      // signal, so the original 3-way average is preserved.
      const pf = computePlanningFidelity({
        arm: 'mandrel',
        rePlanCount: 0,
        plannedStoryCount: 1,
        deliveredStoryCount: 1,
        fileFootprintDrift: 1,
      });
      assert.equal(pf.footprintDropped, false);
      approx(pf.score, (1 + 1 + 0) / 3);
    });
  });
});

describe('computeAutonomy', () => {
  it('is 1.0 for a fully unattended run', () => {
    const a = computeAutonomy({
      hitlStops: 0,
      blockedEvents: 0,
      manualRescues: 0,
    });
    approx(a.score, 1);
  });

  it('collapses interventions via 1/(1+interventions)', () => {
    const a = computeAutonomy({
      hitlStops: 1,
      blockedEvents: 1,
      manualRescues: 1,
    });
    // interventions = 3 ⇒ 1/4
    approx(a.score, 0.25);
  });

  it('coerces malformed counters to 0', () => {
    const a = computeAutonomy({
      hitlStops: -3,
      blockedEvents: 'x',
      manualRescues: 2.9,
    });
    // -3→0, 'x'→0, 2.9→2 ⇒ interventions 2 ⇒ 1/3
    approx(a.score, 1 / 3);
  });

  it('scores null when autonomy was not observed (no lifecycle ledger)', () => {
    // Zero interventions from an ABSENT ledger is unmeasured, not "fully
    // unattended". Null keeps the unmeasured mandrel arm out of the comparison;
    // the control arm keeps its 1.0 baseline via the default observed:true.
    const a = computeAutonomy({
      hitlStops: 0,
      blockedEvents: 0,
      manualRescues: 0,
      observed: false,
    });
    assert.equal(a.score, null);
  });

  describe('autonomy guardrail (§8)', () => {
    it('formula is unchanged: still 1/(1+interventions)', () => {
      const a = computeAutonomy({
        hitlStops: 1,
        blockedEvents: 0,
        manualRescues: 0,
      });
      approx(a.score, 0.5);
    });

    it('carries a guardrail verdict with the default 0.99 threshold', () => {
      const a = computeAutonomy({
        hitlStops: 0,
        blockedEvents: 0,
        manualRescues: 0,
      });
      assert.equal(a.guardrail.threshold, DEFAULT_AUTONOMY_GUARDRAIL_THRESHOLD);
      assert.equal(a.guardrail.met, true);
    });

    it('fails the guardrail when the score drops below threshold', () => {
      const a = computeAutonomy({
        hitlStops: 1,
        blockedEvents: 0,
        manualRescues: 0,
      });
      assert.equal(a.guardrail.met, false);
    });

    it('honours a custom cohort threshold', () => {
      const a = computeAutonomy({
        hitlStops: 1,
        blockedEvents: 0,
        manualRescues: 0,
        guardrailThreshold: 0.4,
      });
      // score 0.5 ≥ 0.4
      assert.equal(a.guardrail.met, true);
      assert.equal(a.guardrail.threshold, 0.4);
    });

    it('reports guardrail.met null when the score itself is unmeasured', () => {
      const a = computeAutonomy({
        hitlStops: 0,
        blockedEvents: 0,
        manualRescues: 0,
        observed: false,
      });
      assert.equal(a.score, null);
      assert.equal(a.guardrail.met, null);
    });

    it('computeAutonomyGuardrail is directly usable against a bare score', () => {
      assert.equal(computeAutonomyGuardrail(1).met, true);
      assert.equal(computeAutonomyGuardrail(0.98).met, false);
      assert.equal(computeAutonomyGuardrail(null).met, null);
      assert.equal(computeAutonomyGuardrail(0.5, 0.4).met, true);
    });
  });
});

describe('computeMaintainability', () => {
  it('blends objective spine (0.7) and judge score (0.3)', () => {
    const m = computeMaintainability({
      objectiveMaintainabilityScore: 1,
      maintainabilityJudgeScore: 0.5,
    });
    // 0.7*1 + 0.3*0.5 = 0.85
    approx(
      m.score,
      MAINTAINABILITY_WEIGHTS.spine * 1 + MAINTAINABILITY_WEIGHTS.judge * 0.5,
    );
    assert.equal(m.maintainabilityJudgeScore, 0.5);
  });

  it('folds judge weight onto spine when maintainabilityJudgeScore is null', () => {
    const m = computeMaintainability({
      objectiveMaintainabilityScore: 0.8,
      maintainabilityJudgeScore: null,
    });
    // judge null ⇒ score === spine (w_spine renormalized to 1.0)
    approx(m.score, 0.8);
    assert.equal(m.maintainabilityJudgeScore, null);
  });

  it('folds judge weight onto spine when judge is absent (missing field)', () => {
    const m = computeMaintainability({ objectiveMaintainabilityScore: 0.75 });
    approx(m.score, 0.75);
    assert.equal(m.maintainabilityJudgeScore, null);
  });

  it('derives spine from sub-signals when objectiveMaintainabilityScore absent', () => {
    // complexityScore=0.8, maintainabilityIndex=0.6 ⇒ spine=(0.8+0.6)/2=0.7
    const m = computeMaintainability({
      complexityScore: 0.8,
      maintainabilityIndex: 0.6,
    });
    approx(m.score, 0.7);
    approx(m.complexityScore, 0.8);
    approx(m.maintainabilityIndex, 0.6);
  });

  it('defaults to 0 when no spine input at all', () => {
    const m = computeMaintainability({});
    approx(m.score, 0);
    assert.equal(m.lintWarnings, 0);
    assert.equal(m.complexityScore, null);
    assert.equal(m.maintainabilityIndex, null);
    assert.equal(m.maintainabilityJudgeScore, null);
  });

  it('records lintWarnings correctly', () => {
    const m = computeMaintainability({
      objectiveMaintainabilityScore: 0.9,
      lintWarnings: 3,
    });
    assert.equal(m.lintWarnings, 3);
    approx(m.score, 0.9);
  });

  describe('loud nulls (§8)', () => {
    it('warns maintainability-signal-absent when neither spine nor sub-signals are supplied', () => {
      const m = computeMaintainability({});
      assert.ok(m.warnings.includes('maintainability-signal-absent'));
    });

    it('does not warn maintainability-signal-absent when a spine is supplied', () => {
      const m = computeMaintainability({ objectiveMaintainabilityScore: 0.5 });
      assert.ok(!m.warnings.includes('maintainability-signal-absent'));
    });

    it('does not warn maintainability-signal-absent when only sub-signals are supplied', () => {
      const m = computeMaintainability({ complexityScore: 0.5 });
      assert.ok(!m.warnings.includes('maintainability-signal-absent'));
    });

    it('warns maintainability-judge-absent when the judge did not run', () => {
      const m = computeMaintainability({ objectiveMaintainabilityScore: 0.5 });
      assert.ok(m.warnings.includes('maintainability-judge-absent'));
    });

    it('does not warn maintainability-judge-absent when the judge ran', () => {
      const m = computeMaintainability({
        objectiveMaintainabilityScore: 0.5,
        maintainabilityJudgeScore: 0.5,
      });
      assert.ok(!m.warnings.includes('maintainability-judge-absent'));
    });
  });
});

describe('computeSecurity', () => {
  it('blends objective spine (0.7) and judge score (0.3)', () => {
    const s = computeSecurity({
      objectiveSecurityScore: 1,
      securityJudgeScore: 0.5,
    });
    // 0.7*1 + 0.3*0.5 = 0.85
    approx(s.score, SECURITY_WEIGHTS.spine * 1 + SECURITY_WEIGHTS.judge * 0.5);
    assert.equal(s.securityJudgeScore, 0.5);
  });

  it('folds judge weight onto spine when securityJudgeScore is null', () => {
    const s = computeSecurity({
      objectiveSecurityScore: 0.9,
      securityJudgeScore: null,
    });
    // judge null ⇒ score === spine
    approx(s.score, 0.9);
    assert.equal(s.securityJudgeScore, null);
  });

  it('folds judge weight onto spine when judge is absent (missing field)', () => {
    const s = computeSecurity({ objectiveSecurityScore: 0.8 });
    approx(s.score, 0.8);
    assert.equal(s.securityJudgeScore, null);
  });

  it('defaults objectiveSecurityScore to 0 when absent (conservative)', () => {
    const s = computeSecurity({});
    approx(s.score, 0);
    assert.equal(s.criticalFindings, 0);
    assert.equal(s.highFindings, 0);
    assert.equal(s.secretsDetected, false);
    assert.equal(s.securityJudgeScore, null);
  });

  it('records sub-signals — findings and secretsDetected', () => {
    const s = computeSecurity({
      objectiveSecurityScore: 0.5,
      criticalFindings: 2,
      highFindings: 5,
      secretsDetected: true,
    });
    assert.equal(s.criticalFindings, 2);
    assert.equal(s.highFindings, 5);
    assert.equal(s.secretsDetected, true);
  });

  describe('loud nulls (§8)', () => {
    it('warns security-signal-absent when no scan data was supplied', () => {
      const s = computeSecurity({});
      assert.ok(s.warnings.includes('security-signal-absent'));
    });

    it('does not warn security-signal-absent when a scan score was supplied', () => {
      const s = computeSecurity({ objectiveSecurityScore: 0 });
      assert.ok(!s.warnings.includes('security-signal-absent'));
    });

    it('warns security-judge-absent when the judge did not run', () => {
      const s = computeSecurity({ objectiveSecurityScore: 0.8 });
      assert.ok(s.warnings.includes('security-judge-absent'));
    });

    it('does not warn security-judge-absent when the judge ran', () => {
      const s = computeSecurity({
        objectiveSecurityScore: 0.8,
        securityJudgeScore: 0.9,
      });
      assert.ok(!s.warnings.includes('security-judge-absent'));
    });
  });
});

describe('computeEfficiency', () => {
  it('reports the vector and preserves a reported costUsd', () => {
    const e = computeEfficiency({
      wallClockMs: 612000,
      totalTokens: 184320,
      inputTokens: 151200,
      outputTokens: 33120,
      dispatches: 2,
      costUsd: 1.47,
    });
    assert.deepEqual(e, {
      wallClockMs: 612000,
      totalTokens: 184320,
      inputTokens: 151200,
      outputTokens: 33120,
      dispatches: 2,
      costUsd: 1.47,
    });
  });

  it('coerces a missing/negative costUsd to null', () => {
    assert.equal(computeEfficiency({ costUsd: -1 }).costUsd, null);
    assert.equal(computeEfficiency({}).costUsd, null);
  });
});

describe('computeOverheadRatio', () => {
  it('is ceremonyTokens / codegenTokens', () => {
    const o = computeOverheadRatio({
      ceremonyTokens: 148800,
      codegenTokens: 35520,
    });
    approx(o.tokenRatio, 148800 / 35520);
    assert.equal(o.timeRatio, null);
  });

  it('computes timeRatio when both ms values are present', () => {
    const o = computeOverheadRatio({
      ceremonyTokens: 4,
      codegenTokens: 1,
      ceremonyMs: 360,
      codegenMs: 100,
    });
    approx(o.timeRatio, 3.6);
  });

  it('reports null (unmeasured, not 0) when no codegen tokens were recorded', () => {
    // A zero denominator is an UNDEFINED ratio, not "zero overhead" — e.g. the
    // mandrel arm produced no lifecycle ledger, so nothing could be attributed
    // to codegen. Null keeps the unmeasured cell out of the value-add comparison
    // rather than crediting Mandrel with a flawless zero-overhead ratio.
    const o = computeOverheadRatio({ ceremonyTokens: 1000, codegenTokens: 0 });
    assert.equal(o.tokenRatio, null);
  });

  it('control-arm-like input (near-zero ceremony) sits near the floor', () => {
    // Distinct from the null case above: codegen IS present, ceremony is ~0, so
    // the ratio is a genuine, measured 0 (no overhead), not unmeasured.
    const o = computeOverheadRatio({ ceremonyTokens: 0, codegenTokens: 5000 });
    approx(o.tokenRatio, 0);
  });
});

describe('computeDimensions', () => {
  it('produces all seven dimensions with the canonical keys', () => {
    const dims = computeDimensions({
      arm: 'mandrel',
      frozenSuitePassed: 6,
      frozenSuiteTotal: 6,
      acceptanceEvalScore: 1,
      rePlanCount: 0,
      plannedStoryCount: 2,
      deliveredStoryCount: 2,
      fileFootprintDrift: 0.08,
      hitlStops: 0,
      blockedEvents: 0,
      manualRescues: 0,
      objectiveMaintainabilityScore: 0.9,
      maintainabilityJudgeScore: 0.85,
      objectiveSecurityScore: 1,
      securityJudgeScore: 1,
      wallClockMs: 612000,
      totalTokens: 184320,
      inputTokens: 151200,
      outputTokens: 33120,
      dispatches: 2,
      costUsd: 1.47,
      ceremonyTokens: 148800,
      codegenTokens: 35520,
    });
    assert.deepEqual(Object.keys(dims).sort(), [
      'autonomy',
      'efficiency',
      'maintainability',
      'overheadRatio',
      'planningFidelity',
      'quality',
      'security',
    ]);
    approx(dims.quality.score, 1);
    approx(dims.autonomy.score, 1);
    assert.equal(typeof dims.planningFidelity.score, 'number');
    assert.equal(typeof dims.maintainability.score, 'number');
    assert.equal(typeof dims.security.score, 'number');
  });

  it('returns maintainability and security keys alongside the original five', () => {
    const dims = computeDimensions({});
    assert.ok('maintainability' in dims, 'maintainability key missing');
    assert.ok('security' in dims, 'security key missing');
    assert.equal(typeof dims.maintainability.score, 'number');
    assert.equal(typeof dims.security.score, 'number');
  });

  it('nulls planningFidelity when arm is control', () => {
    const dims = computeDimensions({
      arm: 'control',
      frozenSuitePassed: 6,
      frozenSuiteTotal: 6,
      ceremonyTokens: 0,
      codegenTokens: 5000,
    });
    assert.equal(dims.planningFidelity.score, null);
    // control quality with no judge folds onto the frozen suite
    approx(dims.quality.score, 1);
  });
});
