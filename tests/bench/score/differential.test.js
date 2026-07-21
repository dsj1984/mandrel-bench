// tests/bench/score/differential.test.js
//
// Unit tier (pure logic, no I/O) for the Mandrel-vs-control differential +
// cross-scenario calibration metrics (Epic #4211, Story #4217). Exercises
// bench/score/differential.js against the binding rules in
// bench/metrics/README.md § "Real-delta rule" and § "Cross-scenario derived
// metrics":
//   - per-dimension delta with the real-delta rule (clears vs within-noise),
//   - planningFidelity incomparable when control is null,
//   - difficulty monotonicity (holds, and an explicit warning on a violation),
//   - overhead floor estimate + the ceremony-lite recommendation flag.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONTINUITY_METRICS,
  cellChainSlopes,
  chainArmSummary,
  computeContinuityDelta,
  computeDifferential,
  computePairedDifferential,
  degradationSlope,
  difficultyMonotonicity,
  EFFICIENCY_COMPONENTS,
  olsSlope,
  overheadFloor,
  pairRunsBySeed,
  SCALAR_DIMENSIONS,
  scoreCorpus,
} from '../../../bench/score/differential.js';
import { chainCard, chainTouch } from '../fixtures/chain-cards.js';

const approx = (actual, expected, eps = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} ≈ ${expected} (±${eps})`,
  );

/**
 * Build a minimal scorecard carrying only the dimension scalars a test needs.
 * Missing dimensions default to benign values.
 */
function card({
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
  seedSha,
} = {}) {
  const sc = {
    dimensions: {
      quality: { score: quality },
      planningFidelity: { score: planningFidelity },
      autonomy: { score: autonomy },
      maintainability: { score: maintainability },
      security: { score: security },
      overheadRatio: { tokenRatio },
      efficiency: { wallClockMs, totalTokens, dispatches, costUsd },
    },
  };
  if (seedSha !== undefined) sc.seedSha = seedSha;
  return sc;
}

describe('SCALAR_DIMENSIONS — dimension registry', () => {
  it('includes maintainability and security', () => {
    const names = SCALAR_DIMENSIONS.map((d) => d.name);
    assert.ok(
      names.includes('maintainability'),
      'maintainability missing from SCALAR_DIMENSIONS',
    );
    assert.ok(
      names.includes('security'),
      'security missing from SCALAR_DIMENSIONS',
    );
  });

  it('accessor for maintainability extracts dimensions.maintainability.score', () => {
    const entry = SCALAR_DIMENSIONS.find((d) => d.name === 'maintainability');
    const sc = { maintainability: { score: 0.75 } };
    assert.equal(entry.accessor(sc), 0.75);
    assert.equal(entry.accessor({}), null);
  });

  it('accessor for security extracts dimensions.security.score', () => {
    const entry = SCALAR_DIMENSIONS.find((d) => d.name === 'security');
    const sc = { security: { score: 0.9 } };
    assert.equal(entry.accessor(sc), 0.9);
    assert.equal(entry.accessor({}), null);
  });

  it('excludes autonomy — reclassified as a mandrel-arm guardrail, not a delta (Epic #66, Story #77/#79)', () => {
    const names = SCALAR_DIMENSIONS.map((d) => d.name);
    assert.ok(!names.includes('autonomy'));
  });

  it('NEVER includes planQuality — a mandrel-only intrinsic axis, not a delta (Epic #86, Story #95)', () => {
    const names = SCALAR_DIMENSIONS.map((d) => d.name);
    assert.ok(
      !names.includes('planQuality'),
      'plan-quality is mandrel-only; the control arm authors no plan, so a delta row is never meaningful',
    );
    // It is also not folded into the efficiency component registry.
    assert.ok(
      !EFFICIENCY_COMPONENTS.map((d) => d.name).includes('planQuality'),
    );
  });
});

describe('computeDifferential — real-delta rule', () => {
  it('flags a delta that clears the larger noise-band spread as real', () => {
    // Mandrel quality tightly clustered near 1.0; control near 0.5. The gap
    // (~0.5) dwarfs either arm's spread ⇒ real.
    const mandrelRuns = [
      card({ quality: 1.0 }),
      card({ quality: 0.98 }),
      card({ quality: 1.0 }),
      card({ quality: 0.99 }),
    ];
    const controlRuns = [
      card({ quality: 0.5 }),
      card({ quality: 0.52 }),
      card({ quality: 0.48 }),
      card({ quality: 0.5 }),
    ];
    const diff = computeDifferential({ mandrelRuns, controlRuns });
    const q = diff.dimensions.quality;
    assert.equal(q.comparable, true);
    assert.equal(q.verdict, 'real');
    assert.equal(q.deltaIsReal, true);
    assert.ok(Math.abs(q.delta) > q.noiseFloor);
  });

  it('reports a delta within the noise-band as within-noise', () => {
    // Two heavily-overlapping clusters: centers differ by a hair, spreads are
    // wide ⇒ within noise.
    const mandrelRuns = [
      card({ quality: 0.7 }),
      card({ quality: 0.9 }),
      card({ quality: 0.6 }),
      card({ quality: 0.8 }),
    ];
    const controlRuns = [
      card({ quality: 0.68 }),
      card({ quality: 0.88 }),
      card({ quality: 0.62 }),
      card({ quality: 0.82 }),
    ];
    const q = computeDifferential({ mandrelRuns, controlRuns }).dimensions
      .quality;
    assert.equal(q.verdict, 'within-noise');
    assert.equal(q.deltaIsReal, false);
  });

  it('marks planningFidelity incomparable when control is null', () => {
    const mandrelRuns = [
      card({ planningFidelity: 0.9 }),
      card({ planningFidelity: 0.85 }),
    ];
    const controlRuns = [
      card({ planningFidelity: null }),
      card({ planningFidelity: null }),
    ];
    const pf = computeDifferential({ mandrelRuns, controlRuns }).dimensions
      .planningFidelity;
    assert.equal(pf.comparable, false);
    assert.equal(pf.verdict, 'incomparable');
    assert.equal(pf.deltaIsReal, false);
    assert.equal(pf.controlCenter, null);
  });

  it('differences each efficiency component independently', () => {
    const mandrelRuns = [
      card({ totalTokens: 180000 }),
      card({ totalTokens: 182000 }),
    ];
    const controlRuns = [
      card({ totalTokens: 40000 }),
      card({ totalTokens: 41000 }),
    ];
    const diff = computeDifferential({ mandrelRuns, controlRuns });
    assert.ok('totalTokens' in diff.efficiency);
    assert.ok('wallClockMs' in diff.efficiency);
    assert.ok('dispatches' in diff.efficiency);
    assert.ok('costUsd' in diff.efficiency);
    assert.equal(diff.efficiency.totalTokens.metric, 'efficiency.totalTokens');
    // 180k+ vs 40k tokens ⇒ a real gap.
    assert.equal(diff.efficiency.totalTokens.verdict, 'real');
  });

  it('carries the band method and arm sample sizes', () => {
    const diff = computeDifferential({
      mandrelRuns: [card(), card(), card()],
      controlRuns: [card(), card()],
      method: 'ci',
      scenario: 'story-scope',
    });
    assert.equal(diff.method, 'ci');
    assert.equal(diff.scenario, 'story-scope');
    assert.deepEqual(diff.n, { mandrel: 3, control: 2 });
  });
});

describe('difficultyMonotonicity — calibration guardrail', () => {
  // hello-world (easy): cheap + high overhead ratio.
  const helloMandrel = [
    card({ totalTokens: 180000, tokenRatio: 4.2 }),
    card({ totalTokens: 184000, tokenRatio: 4.0 }),
  ];
  // story-scope (hard): more expensive + lower overhead ratio.
  const storyMandrel = [
    card({ totalTokens: 520000, tokenRatio: 2.1 }),
    card({ totalTokens: 540000, tokenRatio: 2.0 }),
  ];

  it('holds when efficiency rises and overhead ratio falls down the ladder', () => {
    const result = difficultyMonotonicity({
      cells: [
        { scenario: 'hello-world', difficulty: 1, mandrelRuns: helloMandrel },
        { scenario: 'story-scope', difficulty: 2, mandrelRuns: storyMandrel },
      ],
    });
    assert.equal(result.monotonicityHolds, true);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0].efficiencyRises, true);
    assert.equal(result.pairs[0].overheadFalls, true);
    // Ordered easy → hard regardless of input order.
    assert.deepEqual(
      result.ordered.map((o) => o.scenario),
      ['hello-world', 'story-scope'],
    );
  });

  it('sorts by difficulty even when cells are supplied hard-first', () => {
    const result = difficultyMonotonicity({
      cells: [
        { scenario: 'story-scope', difficulty: 2, mandrelRuns: storyMandrel },
        { scenario: 'hello-world', difficulty: 1, mandrelRuns: helloMandrel },
      ],
    });
    assert.equal(result.monotonicityHolds, true);
    assert.deepEqual(result.pairs[0], {
      from: 'hello-world',
      to: 'story-scope',
      efficiencyRises: true,
      overheadFalls: true,
      holds: true,
      violations: [],
    });
  });

  it('flags a violation when efficiency does NOT rise', () => {
    // story-scope cheaper than hello-world ⇒ efficiency non-monotonic.
    const cheapStory = [card({ totalTokens: 100000, tokenRatio: 2.0 })];
    const result = difficultyMonotonicity({
      cells: [
        { scenario: 'hello-world', difficulty: 1, mandrelRuns: helloMandrel },
        { scenario: 'story-scope', difficulty: 2, mandrelRuns: cheapStory },
      ],
    });
    assert.equal(result.monotonicityHolds, false);
    assert.equal(result.pairs[0].efficiencyRises, false);
    assert.ok(result.warnings.some((w) => /did not rise/.test(w)));
    assert.ok(result.warnings.every((w) => w.startsWith('[calibration]')));
  });

  it('flags a violation when overhead ratio does NOT fall', () => {
    // story-scope ratio HIGHER than hello-world ⇒ overhead non-monotonic.
    const highRatioStory = [card({ totalTokens: 520000, tokenRatio: 5.0 })];
    const result = difficultyMonotonicity({
      cells: [
        { scenario: 'hello-world', difficulty: 1, mandrelRuns: helloMandrel },
        { scenario: 'story-scope', difficulty: 2, mandrelRuns: highRatioStory },
      ],
    });
    assert.equal(result.monotonicityHolds, false);
    assert.equal(result.pairs[0].overheadFalls, false);
    assert.ok(result.warnings.some((w) => /did not fall/.test(w)));
  });
});

describe('overheadFloor — framework finding', () => {
  it('estimates the token + USD floor as mandrel minus control on hello-world', () => {
    const mandrelRuns = [
      card({ totalTokens: 180000, costUsd: 1.4, quality: 1, seedSha: 'aa' }),
      card({ totalTokens: 184000, costUsd: 1.5, quality: 1, seedSha: 'bb' }),
    ];
    const controlRuns = [
      card({ totalTokens: 40000, costUsd: 0.3, quality: 1, seedSha: 'aa' }),
      card({ totalTokens: 42000, costUsd: 0.32, quality: 1, seedSha: 'bb' }),
    ];
    const floor = overheadFloor({ mandrelRuns, controlRuns });
    assert.equal(floor.scenario, 'hello-world');
    // median(180k,184k)=182k − median(40k,42k)=41k = 141000
    approx(floor.overheadFloorTokens, 141000);
    assert.ok(floor.overheadFloorUsd > 0);
    // The floor's own band now comes from SEED-MATCHED pairs (Story #157).
    assert.ok(floor.tokenDiffBand !== null);
    assert.equal(floor.unpaired.mandrel, 0);
    assert.equal(floor.unpaired.control, 0);
  });

  it('recommends a ceremony-lite path when the floor buys NO quality gain', () => {
    // Big token floor, identical quality ⇒ recommend ceremony-lite.
    const mandrelRuns = [
      card({ totalTokens: 180000, quality: 1 }),
      card({ totalTokens: 182000, quality: 1 }),
    ];
    const controlRuns = [
      card({ totalTokens: 40000, quality: 1 }),
      card({ totalTokens: 41000, quality: 1 }),
    ];
    const floor = overheadFloor({ mandrelRuns, controlRuns });
    assert.equal(floor.noQualityGain, true);
    assert.equal(floor.recommendCeremonyLite, true);
    approx(floor.qualityGain, 0);
  });

  it('does NOT recommend ceremony-lite when the floor buys a quality gain', () => {
    const mandrelRuns = [
      card({ totalTokens: 180000, quality: 1.0 }),
      card({ totalTokens: 182000, quality: 1.0 }),
    ];
    const controlRuns = [
      card({ totalTokens: 40000, quality: 0.4 }),
      card({ totalTokens: 41000, quality: 0.42 }),
    ];
    const floor = overheadFloor({ mandrelRuns, controlRuns });
    assert.equal(floor.noQualityGain, false);
    assert.equal(floor.recommendCeremonyLite, false);
    assert.ok(floor.qualityGain > 0.05);
  });
});

describe('seed-keyed pairing (Story #157)', () => {
  it('AC-1: pairs on the seed SHA, not array position — reordering an arm is invariant', () => {
    const mandrel = [
      card({ quality: 1.0, totalTokens: 180000, seedSha: 's1' }),
      card({ quality: 0.9, totalTokens: 200000, seedSha: 's2' }),
      card({ quality: 0.8, totalTokens: 220000, seedSha: 's3' }),
    ];
    const controlInOrder = [
      card({ quality: 0.5, totalTokens: 40000, seedSha: 's1' }),
      card({ quality: 0.4, totalTokens: 42000, seedSha: 's2' }),
      card({ quality: 0.3, totalTokens: 44000, seedSha: 's3' }),
    ];
    // Same runs, shuffled — a resumed cohort that stored them out of order.
    const controlShuffled = [
      controlInOrder[2],
      controlInOrder[0],
      controlInOrder[1],
    ];

    const inOrder = computePairedDifferential({
      mandrelRuns: mandrel,
      controlRuns: controlInOrder,
    });
    const shuffled = computePairedDifferential({
      mandrelRuns: mandrel,
      controlRuns: controlShuffled,
    });

    assert.equal(inOrder.pairs, 3);
    assert.equal(shuffled.pairs, 3);
    // The paired difference for every dimension is identical regardless of order.
    for (const name of ['planningFidelity', 'overheadRatio', 'quality']) {
      assert.equal(
        inOrder.dimensions[name].delta,
        shuffled.dimensions[name].delta,
        `dimension ${name} paired delta must be order-invariant`,
      );
    }
    for (const name of [
      'wallClockMs',
      'totalTokens',
      'costUsd',
      'dispatches',
    ]) {
      assert.equal(
        inOrder.efficiency[name].delta,
        shuffled.efficiency[name].delta,
        `efficiency.${name} paired delta must be order-invariant`,
      );
    }
  });

  it('AC-2: a run with no seed-SHA counterpart is dropped and counted in unpaired', () => {
    const mandrel = [
      card({ totalTokens: 180000, seedSha: 's1' }),
      card({ totalTokens: 190000, seedSha: 's2' }),
      card({ totalTokens: 200000, seedSha: 'orphan-m' }),
    ];
    const control = [
      card({ totalTokens: 40000, seedSha: 's1' }),
      card({ totalTokens: 41000, seedSha: 's2' }),
    ];
    const paired = computePairedDifferential({
      mandrelRuns: mandrel,
      controlRuns: control,
    });
    assert.equal(paired.pairs, 2);
    // The orphan mandrel run has no counterpart → 1 unpaired mandrel.
    assert.equal(paired.unpaired.mandrel, 1);
    assert.equal(paired.unpaired.control, 0);
    // Its value is excluded — the paired totalTokens band is over 2 pairs only.
    assert.equal(paired.efficiency.totalTokens.n, 2);
  });

  it('AC-2: runs carrying no seed SHA at all are all unpaired', () => {
    const paired = computePairedDifferential({
      mandrelRuns: [card(), card()],
      controlRuns: [card(), card()],
    });
    assert.equal(paired.pairs, 0);
    assert.equal(paired.unpaired.mandrel, 2);
    assert.equal(paired.unpaired.control, 2);
    assert.equal(paired.dimensions.overheadRatio.verdict, 'incomparable');
  });

  it('AC-3: each scalar dimension and efficiency component carries a paired band with a zero-exclusion verdict', () => {
    // Mandrel overheadRatio tightly above control → paired band excludes zero.
    const mk = (seed, ratio) => card({ tokenRatio: ratio, seedSha: seed });
    const mandrel = [
      mk('s1', 4.0),
      mk('s2', 4.1),
      mk('s3', 3.9),
      mk('s4', 4.05),
    ];
    const control = [
      card({ tokenRatio: 0.1, seedSha: 's1' }),
      card({ tokenRatio: 0.12, seedSha: 's2' }),
      card({ tokenRatio: 0.09, seedSha: 's3' }),
      card({ tokenRatio: 0.11, seedSha: 's4' }),
    ];
    const paired = computePairedDifferential({
      mandrelRuns: mandrel,
      controlRuns: control,
    });
    for (const name of SCALAR_DIMENSIONS.map((d) => d.name)) {
      assert.ok(name in paired.dimensions, `paired missing dimension ${name}`);
    }
    for (const name of EFFICIENCY_COMPONENTS.map((d) => d.name)) {
      assert.ok(name in paired.efficiency, `paired missing efficiency ${name}`);
    }
    const ratio = paired.dimensions.overheadRatio;
    assert.ok(ratio.diffBand !== null);
    assert.equal(ratio.excludesZero, true);
    assert.equal(ratio.verdict, 'real');
  });

  it('a paired difference band straddling zero is within-noise', () => {
    // Identical arms → differences centered on zero.
    const mandrel = [
      card({ planningFidelity: 0.9, seedSha: 's1' }),
      card({ planningFidelity: 0.9, seedSha: 's2' }),
      card({ planningFidelity: 0.9, seedSha: 's3' }),
    ];
    const control = [
      card({ planningFidelity: 0.9, seedSha: 's1' }),
      card({ planningFidelity: 0.9, seedSha: 's2' }),
      card({ planningFidelity: 0.9, seedSha: 's3' }),
    ];
    const paired = computePairedDifferential({
      mandrelRuns: mandrel,
      controlRuns: control,
    });
    assert.equal(paired.dimensions.planningFidelity.excludesZero, false);
    assert.equal(paired.dimensions.planningFidelity.verdict, 'within-noise');
  });

  it('AC-4: computeDifferential keeps the pooled per-arm bands AND adds the paired block', () => {
    const mandrel = [
      card({ quality: 1.0, seedSha: 's1' }),
      card({ quality: 0.98, seedSha: 's2' }),
    ];
    const control = [
      card({ quality: 0.5, seedSha: 's1' }),
      card({ quality: 0.52, seedSha: 's2' }),
    ];
    const diff = computeDifferential({
      mandrelRuns: mandrel,
      controlRuns: control,
    });
    // Pooled bands (what stored prior-cohort scorecards render) still present.
    assert.ok(diff.dimensions.quality.comparable);
    assert.ok(typeof diff.dimensions.quality.mandrelCenter === 'number');
    // Paired block is additive.
    assert.equal(diff.paired.pairs, 2);
    assert.ok('quality' in diff.paired.dimensions);
    assert.deepEqual(diff.unpaired, { mandrel: 0, control: 0 });
  });

  it('pairRunsBySeed zips duplicate seeds in order and counts the excess as unpaired', () => {
    const mandrel = [
      card({ seedSha: 'dup' }),
      card({ seedSha: 'dup' }),
      card({ seedSha: 'dup' }),
    ];
    const control = [card({ seedSha: 'dup' }), card({ seedSha: 'dup' })];
    const { pairs, unpaired } = pairRunsBySeed(mandrel, control);
    assert.equal(pairs.length, 2);
    assert.equal(unpaired.mandrel, 1);
    assert.equal(unpaired.control, 0);
  });
});

describe('scoreCorpus — top-level convenience', () => {
  it('computes per-scenario differentials plus both cross-scenario metrics', () => {
    const cells = [
      {
        scenario: 'hello-world',
        difficulty: 1,
        mandrelRuns: [
          card({ totalTokens: 180000, tokenRatio: 4.2, quality: 1 }),
        ],
        controlRuns: [card({ totalTokens: 40000, tokenRatio: 0, quality: 1 })],
      },
      {
        scenario: 'story-scope',
        difficulty: 2,
        mandrelRuns: [
          card({ totalTokens: 520000, tokenRatio: 2.0, quality: 1 }),
        ],
        controlRuns: [
          card({ totalTokens: 90000, tokenRatio: 0, quality: 0.9 }),
        ],
      },
    ];
    const result = scoreCorpus({ cells });
    assert.equal(result.perScenario.length, 2);
    assert.equal(result.difficultyMonotonicity.monotonicityHolds, true);
    assert.equal(result.overheadFloor.scenario, 'hello-world');
    approx(result.overheadFloor.overheadFloorTokens, 140000);
  });

  it('returns a null overhead floor when no hello-world cell is present', () => {
    const result = scoreCorpus({
      cells: [
        {
          scenario: 'story-scope',
          difficulty: 2,
          mandrelRuns: [card()],
          controlRuns: [card()],
        },
      ],
    });
    assert.equal(result.overheadFloor, null);
  });
});

describe('computeContinuityDelta — the second-touch continuity delta (Epic #86, Story #96)', () => {
  const touch2Card = (outcome, cost) => ({ touch2: { outcome, cost } });

  it('CONTINUITY_METRICS pull touch2.outcome / touch2.cost from the scorecard top level', () => {
    const names = CONTINUITY_METRICS.map((m) => m.name);
    assert.deepEqual(names, ['touch2.outcome', 'touch2.cost']);
    const outcome = CONTINUITY_METRICS.find((m) => m.name === 'touch2.outcome');
    assert.equal(outcome.accessor({ touch2: { outcome: 0.8 } }), 0.8);
    assert.equal(outcome.accessor({ dimensions: {} }), null);
  });

  it('computes the mandrel-minus-control delta of outcome and cost', () => {
    const mandrelRuns = [touch2Card(0.9, 0.2), touch2Card(0.9, 0.2)];
    const controlRuns = [touch2Card(0.6, 0.5), touch2Card(0.6, 0.5)];
    const d = computeContinuityDelta({
      mandrelRuns,
      controlRuns,
      scenario: 'story-scope',
    });
    assert.equal(d.present, true);
    assert.equal(d.scenario, 'story-scope');
    // Mandrel makes the 2nd change BETTER (+0.3 outcome) and CHEAPER (−0.3 cost).
    approx(d.metrics['touch2.outcome'].delta, 0.3);
    approx(d.metrics['touch2.cost'].delta, -0.3);
    assert.equal(d.metrics['touch2.outcome'].verdict, 'real');
  });

  it('is not present when neither arm carries a touch2 block (a touch-1-only cell)', () => {
    const d = computeContinuityDelta({
      mandrelRuns: [{ dimensions: {} }],
      controlRuns: [{ dimensions: {} }],
      scenario: 'hello-world',
    });
    assert.equal(d.present, false);
    // Both metrics are incomparable (no finite values ⇒ null bands).
    assert.equal(d.metrics['touch2.outcome'].comparable, false);
  });

  it('rejects non-array inputs', () => {
    assert.throws(
      () => computeContinuityDelta({ mandrelRuns: null, controlRuns: [] }),
      TypeError,
    );
  });
});

// ---------------------------------------------------------------------------
// Degradation slope + chain aggregation (issue #124, PR-D; design §4/§5)
// ---------------------------------------------------------------------------

describe('olsSlope — the degradation-slope primitive', () => {
  it('computes the exact OLS slope for a linear series', () => {
    const points = [1, 2, 3, 4, 5].map((x) => ({ x, y: 2 + 0.5 * x }));
    approx(olsSlope(points), 0.5);
  });

  it('computes the least-squares slope for a noisy series', () => {
    // y = x with one outlier at x=3: slope = Σ(x−x̄)(y−ȳ)/Σ(x−x̄)².
    const points = [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 6 },
    ];
    approx(olsSlope(points), 2.5);
  });

  it('returns null for <2 points or identical x (undefined slope, never 0)', () => {
    assert.equal(olsSlope([]), null);
    assert.equal(olsSlope([{ x: 1, y: 1 }]), null);
    assert.equal(
      olsSlope([
        { x: 2, y: 1 },
        { x: 2, y: 5 },
      ]),
      null,
    );
  });

  it('filters non-finite points before fitting', () => {
    const points = [
      { x: 1, y: 0 },
      { x: 2, y: null },
      { x: 3, y: 1 },
      { x: Number.NaN, y: 9 },
    ];
    approx(olsSlope(points), 0.5);
  });

  it('rejects a non-array input', () => {
    assert.throws(() => olsSlope(null), TypeError);
  });
});

describe('cellChainSlopes — per-cell slopes + exclusion rules', () => {
  it('returns null for a non-chain scorecard (the no-op guard)', () => {
    assert.equal(cellChainSlopes(card()), null);
    assert.equal(cellChainSlopes({ chain: {} }), null);
  });

  it('excludes null outcomes from the quality regression but keeps their cost', () => {
    const sc = chainCard({
      touches: [
        chainTouch(1, { outcome: 0.9, cost: 1 }),
        chainTouch(2, {
          outcome: null,
          cost: 2,
          materialized: false,
          advanced: false,
          seededFromTouch: 1,
        }),
        chainTouch(3, { outcome: 0.7, cost: 3, seededFromTouch: 1 }),
      ],
    });
    const cell = cellChainSlopes(sc);
    // Outcome regression over touches 1 and 3 only: (0.7−0.9)/(3−1) = −0.1.
    approx(cell.outcomeSlope, -0.1);
    assert.equal(cell.outcomePoints, 2);
    // Cost regression keeps ALL three touches: exact unit slope.
    approx(cell.costSlope, 1);
    assert.equal(cell.costPoints, 3);
  });

  it('annotates seededFromTouch gaps instead of silently pooling them', () => {
    const sc = chainCard({
      touches: [
        chainTouch(1),
        chainTouch(2, { advanced: false }),
        chainTouch(3, { seededFromTouch: 1 }),
        chainTouch(4),
      ],
    });
    assert.deepEqual(cellChainSlopes(sc).seededGaps, [
      { touchIndex: 3, seededFromTouch: 1 },
    ]);
  });

  it('reports null slopes when fewer than two measured points remain', () => {
    const sc = chainCard({
      touches: [
        chainTouch(1, { outcome: 0.9, cost: null }),
        chainTouch(2, { outcome: null, cost: null, materialized: false }),
      ],
    });
    const cell = cellChainSlopes(sc);
    assert.equal(cell.outcomeSlope, null);
    assert.equal(cell.costSlope, null);
  });
});

describe('degradationSlope — the chain headline (mandrel slope − control slope)', () => {
  it('is not present when neither arm carries a chain block (non-chain no-op)', () => {
    const d = degradationSlope({
      mandrelRuns: [card()],
      controlRuns: [card()],
      scenario: 'story-scope',
    });
    assert.equal(d.present, false);
    assert.deepEqual(d.n, { mandrel: 0, control: 0 });
    assert.equal(d.metrics['chain.outcomeSlope'].comparable, false);
    assert.equal(d.metrics['chain.outcomeSlope'].verdict, 'incomparable');
  });

  it('calls a real flatter-slope delta at n=2 when the gap clears both spreads', () => {
    const d = degradationSlope({
      mandrelRuns: [
        chainCard({ run: 1, outcomeSlope: -0.01, costSlope: 0.05 }),
        chainCard({ run: 2, outcomeSlope: -0.02, costSlope: 0.06 }),
      ],
      controlRuns: [
        chainCard({
          arm: 'control',
          run: 1,
          outcomeSlope: -0.08,
          costSlope: 0.3,
        }),
        chainCard({
          arm: 'control',
          run: 2,
          outcomeSlope: -0.09,
          costSlope: 0.35,
        }),
      ],
      scenario: 'brownfield-longitudinal',
    });
    assert.equal(d.present, true);
    assert.deepEqual(d.n, { mandrel: 2, control: 2 });
    const outcome = d.metrics['chain.outcomeSlope'];
    // Mandrel median slope −0.015 vs control −0.085: Δ = +0.07 (flatter),
    // clearing the max spread (0.01) ⇒ real.
    approx(outcome.delta, 0.07);
    approx(outcome.noiseFloor, 0.01);
    assert.equal(outcome.verdict, 'real');
    const cost = d.metrics['chain.costSlope'];
    approx(cost.delta, -0.27);
    assert.equal(cost.verdict, 'real');
    // Per-arm pooled slopes are the point estimate over EVERY touch point.
    approx(d.perArm.mandrel.pooledOutcomeSlope, -0.015);
    approx(d.perArm.control.pooledCostSlope, 0.325);
  });

  it('stays within noise at n=4 when the arm spreads swallow the delta', () => {
    const mandrelRuns = [-0.01, -0.09, -0.02, -0.08].map((s, i) =>
      chainCard({ run: i + 1, outcomeSlope: s }),
    );
    const controlRuns = [-0.03, -0.11, -0.04, -0.1].map((s, i) =>
      chainCard({ arm: 'control', run: i + 1, outcomeSlope: s }),
    );
    const d = degradationSlope({ mandrelRuns, controlRuns });
    const outcome = d.metrics['chain.outcomeSlope'];
    assert.equal(outcome.comparable, true);
    // Δ of medians is 0.02 but each arm's IQR spread is ~0.08 ⇒ within noise.
    approx(outcome.delta, 0.02);
    assert.equal(outcome.deltaIsReal, false);
    assert.equal(outcome.verdict, 'within-noise');
  });

  it('reports a single-arm cohort as incomparable but still present', () => {
    const d = degradationSlope({
      mandrelRuns: [chainCard({ run: 1 }), chainCard({ run: 2 })],
      controlRuns: [],
    });
    assert.equal(d.present, true);
    assert.deepEqual(d.n, { mandrel: 2, control: 0 });
    const outcome = d.metrics['chain.outcomeSlope'];
    assert.equal(outcome.comparable, false);
    assert.equal(outcome.verdict, 'incomparable');
    // The measured arm's band still carries its center for the report.
    assert.ok(outcome.mandrelBand);
    assert.equal(outcome.controlBand, null);
  });

  it('carries per-run seeded-gap annotations keyed by runId', () => {
    const gapped = chainCard({
      run: 1,
      touches: [
        chainTouch(1, { advanced: false }),
        chainTouch(2, { seededFromTouch: 0 }),
        chainTouch(3),
      ],
    });
    const d = degradationSlope({
      mandrelRuns: [gapped],
      controlRuns: [chainCard({ arm: 'control', run: 1 })],
    });
    assert.deepEqual(d.seededGaps.mandrel, [
      {
        runId: 'brownfield-longitudinal-mandrel-r1',
        touchIndex: 2,
        seededFromTouch: 0,
      },
    ]);
    assert.deepEqual(d.seededGaps.control, []);
  });

  it('rejects non-array inputs', () => {
    assert.throws(
      () => degradationSlope({ mandrelRuns: null, controlRuns: [] }),
      TypeError,
    );
  });
});

describe('chainArmSummary — cost-per-landed-change aggregation', () => {
  it('returns null when the arm carries no chain records', () => {
    assert.equal(chainArmSummary([card()]), null);
    assert.equal(chainArmSummary([]), null);
  });

  it('aggregates landed counts + mean/band of the per-cell costPerLandedChange', () => {
    const runs = [
      chainCard({ run: 1, landedCount: 5, costPerLandedChange: 1.0 }),
      chainCard({ run: 2, landedCount: 3, costPerLandedChange: 2.0 }),
    ];
    const s = chainArmSummary(runs);
    assert.equal(s.cells, 2);
    assert.equal(s.touchesTotal, 10);
    assert.equal(s.landedCountTotal, 8);
    approx(s.landedCountMean, 4);
    // Every fixture mandrel touch is landed:true ⇒ strict count = 10.
    assert.equal(s.landedTrueTotal, 10);
    assert.equal(s.cellsWithNoLanding, 0);
    approx(s.costPerLandedChange.mean, 1.5);
    assert.equal(s.costPerLandedChange.n, 2);
    approx(s.costPerLandedChange.band.center, 1.5);
  });

  it('excludes null costPerLandedChange cells from the mean but counts them', () => {
    const runs = [
      chainCard({ run: 1, landedCount: 5, costPerLandedChange: 2.0 }),
      chainCard({ run: 2, landedCount: 0, costPerLandedChange: null }),
    ];
    const s = chainArmSummary(runs);
    approx(s.costPerLandedChange.mean, 2.0);
    assert.equal(s.costPerLandedChange.n, 1);
    assert.equal(s.cellsWithNoLanding, 1);
  });

  it('counts landed strictly (landed:true) apart from the schema landedCount', () => {
    // Control-arm touches carry landed:null — strict count is 0 even though
    // the persisted landedCount (advanced touches) is 5.
    const s = chainArmSummary([
      chainCard({ arm: 'control', run: 1, landedCount: 5 }),
    ]);
    assert.equal(s.landedCountTotal, 5);
    assert.equal(s.landedTrueTotal, 0);
  });

  it('rejects a non-array input', () => {
    assert.throws(() => chainArmSummary(null), TypeError);
  });
});
