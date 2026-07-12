// tests/bench/fixtures/chain-cards.js
//
// Shared fixture builders for CHAIN scorecards (issue #124, PR-D): synthetic
// `brownfield-longitudinal` records carrying a `chain.touches[]` block with
// controllable per-touch outcome/cost slopes, null outcomes (unmaterialized
// touches), seeded-from gaps, and landed/advanced flags. Used by the
// degradation-slope scoring tests and the chain report/dashboard tests so
// both tiers exercise the exact same record shape.
//
// Determinism: fixed stamps, no clock, no randomness.

const MODEL = { id: 'claude-opus-4-8[1m]' };
const ENV = { node: 'v24.16.0', os: 'darwin' };

/**
 * One chain touch entry (scorecard.schema.json `$defs.chainTouchEntry`).
 *
 * @param {number} i  1-based touch index.
 * @param {object} [overrides]
 * @returns {object}
 */
export function chainTouch(i, overrides = {}) {
  return {
    touchIndex: i,
    changeRequestId: `touch-${i}`,
    landed: true,
    materialized: true,
    advanced: true,
    seededFromTouch: i - 1,
    appBoots: true,
    outcome: 0.95,
    cost: 1,
    regression: {
      baseTotal: 100,
      retainedTotal: 100,
      retainedPassed: 98,
      regressionRate: 0.02,
      additionsTotal: 4 * i,
      additionsPassed: 4 * i,
    },
    conventions: {
      classes: [
        { class: 'error-envelope', clean: true },
        { class: 'layering', clean: i !== 3 },
      ],
      cleanRate: i === 3 ? 0.5 : 1,
    },
    ...overrides,
  };
}

/**
 * One chain scorecard for `brownfield-longitudinal`. `touches` defaults to a
 * clean 5-touch linear chain whose outcome falls by `outcomeSlope` and cost
 * rises by `costSlope` per touch (exact OLS slopes by construction).
 *
 * @param {object} [args]
 * @returns {object}
 */
export function chainCard({
  arm = 'mandrel',
  run = 1,
  outcomeSlope = -0.02,
  costSlope = 0.05,
  touches = null,
  landedCount = 5,
  costPerLandedChange = 1.2,
  scenario = 'brownfield-longitudinal',
} = {}) {
  const touchList =
    touches ??
    [1, 2, 3, 4, 5].map((i) =>
      chainTouch(i, {
        outcome: 0.95 + outcomeSlope * (i - 1),
        cost: 1 + costSlope * (i - 1),
        landed: arm === 'control' ? null : true,
      }),
    );
  return {
    schemaVersion: 1,
    runId: `${scenario}-${arm}-r${run}`,
    timestamp: `2026-07-1${run}T10:00:00.000Z`,
    model: MODEL,
    frameworkVersion: '1.91.0',
    benchmarkVersion: '0.12.0',
    env: ENV,
    scenario,
    arm,
    routingVerdict: arm === 'control' ? null : 'story',
    routingMismatch: false,
    warnings: ['chain-aggregate-dimensions'],
    dimensions: {
      quality: { score: 0.9, frozenSuitePassRate: 0.9 },
      planningFidelity: { score: arm === 'control' ? null : 0.9 },
      autonomy: {
        score: 1,
        hitlStops: 0,
        blockedEvents: 0,
        manualRescues: 0,
        guardrail: { threshold: 0.99, met: true },
      },
      maintainability: { score: 0.9 },
      security: { score: 1 },
      overheadRatio: { tokenRatio: 3 },
      efficiency: {
        wallClockMs: 900000,
        totalTokens: 250000,
        dispatches: 3,
        costUsd: 1.1,
      },
    },
    chain: {
      advanceThreshold: 0.9,
      landedCount,
      costPerLandedChange,
      touches: touchList,
    },
  };
}
