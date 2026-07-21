// bench/score/differential.js
//
// The Mandrel-vs-control differential + cross-scenario calibration metrics for
// the Mandrel self-benchmark harness (Epic #4211, Story #4217). Internal
// tooling only — never shipped in the distributed `.agents/` bundle.
//
// This module sits on top of the per-run scorecards (bench/collect/normalize.js)
// and the noise-band primitive (bench/metrics/variance.js). It computes:
//
//   1. The per-dimension Mandrel-vs-control delta across the N runs of one
//      (scenario) cell, with the binding "real-delta" rule from
//      bench/metrics/README.md § "Real-delta rule":
//
//        deltaIsReal = |centerMandrel − centerControl|
//                        > max(spreadMandrel, spreadControl)
//
//      A delta that does not clear the larger of the two arms' noise-band
//      spreads is reported as "within noise" (no significant difference).
//
//   2. The two cross-scenario derived metrics (README § "Cross-scenario
//      derived metrics") — computed by comparing scenarios, never scored
//      per-run:
//        A. Difficulty monotonicity — Efficiency must RISE and Overhead ratio
//           must FALL as difficulty increases; a violation is a calibration
//           warning, surfaced explicitly.
//        B. Overhead floor — the fixed ceremony tax Mandrel pays above control
//           on the near-zero `hello-world` rung, with its own band over the
//           per-run differences.
//
// Determinism: pure functions, no I/O, no clock, no randomness.

import { noiseBand } from '../metrics/variance.js';

/**
 * The scorecard dimensions compared as a Mandrel-vs-control DELTA, in
 * canonical order, each tagged with the single per-run scalar that
 * represents it for differential purposes. `quality`, `planningFidelity` and
 * `overheadRatio` each have a natural headline scalar. `efficiency` is a
 * vector (README § 4 — "never collapsed to one number"), so it is
 * differenced per-component rather than as a single dimension; see
 * `EFFICIENCY_COMPONENTS`.
 *
 * `autonomy` is DELIBERATELY excluded (Epic #66, Story #77 / target-
 * architecture §8): it is reclassified as a mandrel-arm GUARDRAIL — the score
 * compared against a fixed cohort threshold (`dimensions.autonomy.guardrail`,
 * default 0.99) — rather than a mandrel-vs-control delta. The bare control
 * arm's autonomy is a defined baseline (1.0, zero interventions by
 * construction), not a measurement, so diffing it against Mandrel's measured
 * score was never a meaningful comparison; the guardrail verdict is rendered
 * separately (`bench/report/render.js` `renderAutonomyGuardrailSection`,
 * `bench/report/html.js`'s guardrail panel).
 *
 * `planQuality` is ALSO deliberately excluded (Epic #86, Story #95 / D-019):
 * it is a MANDREL-ONLY intrinsic axis — the control arm authors no plan, so its
 * plan-quality is null by construction, not a measurement. Diffing a measured
 * mandrel plan against a non-existent control plan is not a meaningful
 * comparison (identical reasoning to planningFidelity and autonomy). The axis
 * is scored per run by `bench/score/plan-quality.js` and rendered via the
 * attribution table (`bench/report/render.js` `renderAttributionSection`),
 * never as a delta row here. It lives at the scorecard's top level
 * (`scorecard.planQuality`), not under `dimensions`, so it can never leak into
 * this registry accidentally.
 *
 * The accessor pulls the scalar out of a scorecard's `dimensions.<name>`
 * sub-object, returning `null` when the value is null (e.g. planningFidelity on
 * the control arm) so it is filtered out of the band by `noiseBand`.
 */
export const SCALAR_DIMENSIONS = Object.freeze([
  { name: 'quality', accessor: (d) => d?.quality?.score ?? null },
  {
    name: 'planningFidelity',
    accessor: (d) => d?.planningFidelity?.score ?? null,
  },
  {
    name: 'maintainability',
    accessor: (d) => d?.maintainability?.score ?? null,
  },
  { name: 'security', accessor: (d) => d?.security?.score ?? null },
  {
    name: 'overheadRatio',
    accessor: (d) => d?.overheadRatio?.tokenRatio ?? null,
  },
]);

/**
 * The Efficiency vector components, each differenced independently (each gets
 * its own distribution + band, per README § 4).
 */
export const EFFICIENCY_COMPONENTS = Object.freeze([
  { name: 'wallClockMs', accessor: (d) => d?.efficiency?.wallClockMs ?? null },
  { name: 'totalTokens', accessor: (d) => d?.efficiency?.totalTokens ?? null },
  { name: 'dispatches', accessor: (d) => d?.efficiency?.dispatches ?? null },
  { name: 'costUsd', accessor: (d) => d?.efficiency?.costUsd ?? null },
]);

/**
 * Pull the per-run scalar values for one (dimension accessor) across a set of
 * scorecards. Non-finite / null entries are left in place; `noiseBand` filters
 * them, so a metric that is null for one arm (planningFidelity on control)
 * simply yields an empty band.
 *
 * @param {Array<object>} scorecards
 * @param {(dimensions: object) => number|null} accessor
 * @returns {Array<number|null>}
 */
function valuesFor(scorecards, accessor) {
  return scorecards.map((sc) => accessor(sc?.dimensions));
}

/**
 * Compute a noise-band, or `null` when no finite values are present (so a
 * dimension that is null for an arm — planningFidelity on control — does not
 * throw, it simply has no band).
 *
 * @param {Array<number|null>} values
 * @param {'iqr'|'ci'} method
 * @returns {import('../metrics/variance.js').NoiseBand|null}
 */
function bandOrNull(values, method) {
  try {
    return noiseBand(values, { method });
  } catch {
    // RangeError: no finite values to summarize.
    return null;
  }
}

/**
 * Default accessor for a scorecard's shared per-run SEED SHA — the key that
 * makes the mandrel arm's run and the control arm's run of the same replicate
 * a MATCHED PAIR (both arms of a cell run the same seed by construction).
 * Returns null when the scorecard carries no usable seed SHA, so such a run is
 * dropped from the paired set and counted as `unpaired` rather than silently
 * mis-paired on array position.
 *
 * @param {object} sc  One scorecard.
 * @returns {string|null}
 */
export function defaultSeedAccessor(sc) {
  const s = sc?.seedSha;
  return typeof s === 'string' && s.length > 0 ? s : null;
}

/**
 * Pair the mandrel and control arms of ONE cell by their shared SEED SHA —
 * never by array position. Both arms of a cell run the same per-replicate seed,
 * so run *i* of one arm and run *i* of the other are a matched pair only insofar
 * as they share a seed SHA. Grouping by that key is order-independent (two arms
 * whose runs are stored in different orders pair identically) and correct under
 * a resumed cohort that leaves the arms with different run counts or orders —
 * exactly the condition index alignment silently mispairs.
 *
 * A run whose seed SHA has no counterpart in the other arm, or that carries no
 * seed SHA at all, is dropped from the paired set and counted in the reported
 * `unpaired` tally so a shrinking pair count is visible rather than silent.
 * Duplicate seed SHAs within one arm are zipped in order against the other
 * arm's runs for the same seed, with any excess counted as unpaired.
 *
 * @param {Array<object>} mandrelRuns
 * @param {Array<object>} controlRuns
 * @param {(sc: object) => string|null} [seedAccessor=defaultSeedAccessor]
 * @returns {{
 *   pairs: Array<{ seedSha: string, mandrel: object, control: object }>,
 *   unpaired: { mandrel: number, control: number }
 * }}
 */
export function pairRunsBySeed(
  mandrelRuns,
  controlRuns,
  seedAccessor = defaultSeedAccessor,
) {
  const group = (runs) => {
    const bySeed = new Map();
    let noSeed = 0;
    for (const sc of runs ?? []) {
      const seed = seedAccessor(sc);
      if (seed === null || seed === undefined || seed === '') {
        noSeed += 1;
        continue;
      }
      if (!bySeed.has(seed)) bySeed.set(seed, []);
      bySeed.get(seed).push(sc);
    }
    return { bySeed, noSeed };
  };

  const m = group(mandrelRuns);
  const c = group(controlRuns);

  const pairs = [];
  let mUnpaired = m.noSeed;
  let cUnpaired = c.noSeed;

  // Sorted seed union keeps pairing deterministic regardless of arm order.
  const seeds = [...new Set([...m.bySeed.keys(), ...c.bySeed.keys()])].sort();
  for (const seed of seeds) {
    const mList = m.bySeed.get(seed) ?? [];
    const cList = c.bySeed.get(seed) ?? [];
    const pairedCount = Math.min(mList.length, cList.length);
    for (let i = 0; i < pairedCount; i += 1) {
      pairs.push({ seedSha: seed, mandrel: mList[i], control: cList[i] });
    }
    mUnpaired += mList.length - pairedCount;
    cUnpaired += cList.length - pairedCount;
  }

  return { pairs, unpaired: { mandrel: mUnpaired, control: cUnpaired } };
}

/**
 * Band a PAIRED difference distribution for one metric and derive its verdict
 * from whether the band EXCLUDES ZERO — the paired analogue of the pooled
 * real-delta rule. A paired difference band that excludes zero is a real
 * difference; one straddling zero is within noise.
 *
 * @param {string} name
 * @param {Array<number>} diffs  Per-pair differences (mandrel − control).
 * @param {'iqr'|'ci'} method
 * @returns {{
 *   metric: string,
 *   comparable: boolean,
 *   n: number,
 *   delta: number|null,
 *   diffBand: object|null,
 *   excludesZero: boolean,
 *   verdict: 'real'|'within-noise'|'incomparable'
 * }}
 */
function pairedCompare(name, diffs, method) {
  const band = bandOrNull(diffs, method);
  if (band === null) {
    return {
      metric: name,
      comparable: false,
      n: diffs.length,
      delta: null,
      diffBand: null,
      excludesZero: false,
      verdict: 'incomparable',
    };
  }
  const excludesZero = band.low > 0 || band.high < 0;
  return {
    metric: name,
    comparable: true,
    n: diffs.length,
    delta: band.center,
    diffBand: band,
    excludesZero,
    verdict: excludesZero ? 'real' : 'within-noise',
  };
}

/**
 * Compute the SEED-PAIRED differential for ONE scenario cell: for each scalar
 * dimension and efficiency component, the per-pair difference distribution
 * d_i = mandrel_i − control_i over seed-matched pairs, banded and verdicted by
 * whether the band excludes zero. At fixed N the paired block recovers roughly
 * the statistical power the pooled per-arm bands discard, because both arms of a
 * pair share the seed's difficulty draw (Story #157).
 *
 * Additive to — never a replacement for — the pooled bands in
 * {@link computeDifferential}: the paired result leads the report, the pooled
 * bands remain so stored prior-cohort scorecards still render.
 *
 * @param {object} args
 * @param {Array<object>} args.mandrelRuns
 * @param {Array<object>} args.controlRuns
 * @param {'iqr'|'ci'} [args.method='iqr']
 * @param {string} [args.scenario]
 * @param {(sc: object) => string|null} [args.seedAccessor=defaultSeedAccessor]
 * @returns {{
 *   scenario: string|undefined,
 *   method: 'iqr'|'ci',
 *   pairs: number,
 *   unpaired: { mandrel: number, control: number },
 *   dimensions: Record<string, object>,
 *   efficiency: Record<string, object>
 * }}
 */
export function computePairedDifferential({
  mandrelRuns,
  controlRuns,
  method = 'iqr',
  scenario,
  seedAccessor = defaultSeedAccessor,
}) {
  if (!Array.isArray(mandrelRuns) || !Array.isArray(controlRuns)) {
    throw new TypeError(
      'computePairedDifferential: mandrelRuns and controlRuns must be arrays',
    );
  }
  const { pairs, unpaired } = pairRunsBySeed(
    mandrelRuns,
    controlRuns,
    seedAccessor,
  );
  const diffsFor = (accessor) => {
    const out = [];
    for (const p of pairs) {
      const mv = accessor(p.mandrel?.dimensions);
      const cv = accessor(p.control?.dimensions);
      if (
        typeof mv === 'number' &&
        Number.isFinite(mv) &&
        typeof cv === 'number' &&
        Number.isFinite(cv)
      ) {
        out.push(mv - cv);
      }
    }
    return out;
  };

  const dimensions = {};
  for (const { name, accessor } of SCALAR_DIMENSIONS) {
    dimensions[name] = pairedCompare(name, diffsFor(accessor), method);
  }
  const efficiency = {};
  for (const { name, accessor } of EFFICIENCY_COMPONENTS) {
    efficiency[name] = pairedCompare(
      `efficiency.${name}`,
      diffsFor(accessor),
      method,
    );
  }

  return {
    scenario,
    method,
    pairs: pairs.length,
    unpaired,
    dimensions,
    efficiency,
  };
}

/**
 * Apply the binding real-delta rule to two arms' bands for one metric.
 *
 *   deltaIsReal = |centerMandrel − centerControl| > max(spreadMandrel, spreadControl)
 *
 * When either band is null (the metric was null for that arm across all its
 * runs — e.g. planningFidelity on control), the delta cannot be computed and
 * is reported with `deltaIsReal: false` and `comparable: false`.
 *
 * @param {object} args
 * @param {string} args.name
 * @param {import('../metrics/variance.js').NoiseBand|null} args.mandrelBand
 * @param {import('../metrics/variance.js').NoiseBand|null} args.controlBand
 * @returns {{
 *   metric: string,
 *   comparable: boolean,
 *   mandrelCenter: number|null,
 *   controlCenter: number|null,
 *   delta: number|null,
 *   noiseFloor: number|null,
 *   deltaIsReal: boolean,
 *   verdict: 'real'|'within-noise'|'incomparable',
 *   mandrelBand: object|null,
 *   controlBand: object|null
 * }}
 */
function compareBands({ name, mandrelBand, controlBand }) {
  if (mandrelBand === null || controlBand === null) {
    return {
      metric: name,
      comparable: false,
      mandrelCenter: mandrelBand ? mandrelBand.center : null,
      controlCenter: controlBand ? controlBand.center : null,
      delta: null,
      noiseFloor: null,
      deltaIsReal: false,
      verdict: 'incomparable',
      mandrelBand,
      controlBand,
    };
  }
  const delta = mandrelBand.center - controlBand.center;
  const noiseFloor = Math.max(mandrelBand.spread, controlBand.spread);
  const deltaIsReal = Math.abs(delta) > noiseFloor;
  return {
    metric: name,
    comparable: true,
    mandrelCenter: mandrelBand.center,
    controlCenter: controlBand.center,
    delta,
    noiseFloor,
    deltaIsReal,
    verdict: deltaIsReal ? 'real' : 'within-noise',
    mandrelBand,
    controlBand,
  };
}

/**
 * Compute the full Mandrel-vs-control differential for ONE scenario cell.
 *
 * @param {object} args
 * @param {Array<object>} args.mandrelRuns  Scorecards for the Mandrel arm.
 * @param {Array<object>} args.controlRuns  Scorecards for the control arm.
 * @param {'iqr'|'ci'} [args.method='iqr']  Band method passed to noiseBand.
 * @param {string} [args.scenario]          Optional scenario id for labelling.
 * @param {(sc: object) => string|null} [args.seedAccessor=defaultSeedAccessor]
 *   Seed-SHA accessor for the additive paired block.
 * @returns {{
 *   scenario: string|undefined,
 *   method: 'iqr'|'ci',
 *   n: { mandrel: number, control: number },
 *   unpaired: { mandrel: number, control: number },
 *   dimensions: Record<string, object>,
 *   efficiency: Record<string, object>,
 *   paired: ReturnType<typeof computePairedDifferential>
 * }}
 */
export function computeDifferential({
  mandrelRuns,
  controlRuns,
  method = 'iqr',
  scenario,
  seedAccessor = defaultSeedAccessor,
}) {
  if (!Array.isArray(mandrelRuns) || !Array.isArray(controlRuns)) {
    throw new TypeError(
      'computeDifferential: mandrelRuns and controlRuns must be arrays',
    );
  }

  const dimensions = {};
  for (const { name, accessor } of SCALAR_DIMENSIONS) {
    const mandrelBand = bandOrNull(valuesFor(mandrelRuns, accessor), method);
    const controlBand = bandOrNull(valuesFor(controlRuns, accessor), method);
    dimensions[name] = compareBands({ name, mandrelBand, controlBand });
  }

  const efficiency = {};
  for (const { name, accessor } of EFFICIENCY_COMPONENTS) {
    const mandrelBand = bandOrNull(valuesFor(mandrelRuns, accessor), method);
    const controlBand = bandOrNull(valuesFor(controlRuns, accessor), method);
    efficiency[name] = compareBands({
      name: `efficiency.${name}`,
      mandrelBand,
      controlBand,
    });
  }

  // Seed-paired block (Story #157) — additive. The pooled per-arm bands above
  // stay in the output so stored prior-cohort scorecards still render; the
  // paired block recovers the blocking power the pooled comparison discards.
  const paired = computePairedDifferential({
    mandrelRuns,
    controlRuns,
    method,
    scenario,
    seedAccessor,
  });

  return {
    scenario,
    method,
    n: { mandrel: mandrelRuns.length, control: controlRuns.length },
    unpaired: paired.unpaired,
    dimensions,
    efficiency,
    paired,
  };
}

/**
 * The second-touch CONTINUITY metrics (Epic #86, Story #96), each differenced
 * mandrel-vs-control independently. Unlike {@link SCALAR_DIMENSIONS}, the
 * accessor pulls from the SCORECARD's top-level `touch2` block (continuity
 * lives beside `trap`, not under `dimensions`):
 *
 *   - `touch2.outcome` — the second touch's composite quality in [0,1].
 *   - `touch2.cost`    — the second touch's session USD cost.
 *
 * The continuity delta answers the persistence thesis directly: does
 * inheriting Mandrel's artifacts make the NEXT change cheaper (cost delta < 0)
 * and safer/better (outcome delta > 0) than inheriting code alone?
 */
export const CONTINUITY_METRICS = Object.freeze([
  { name: 'touch2.outcome', accessor: (sc) => sc?.touch2?.outcome ?? null },
  { name: 'touch2.cost', accessor: (sc) => sc?.touch2?.cost ?? null },
]);

/**
 * Compute the second-touch CONTINUITY DELTA for ONE scenario cell — the
 * mandrel-vs-control difference of the second touch's outcome and cost, using
 * the same noise-band + real-delta machinery as {@link computeDifferential}.
 *
 * `present` is false when NEITHER arm carries any `touch2` block for the cell
 * (a touch-1-only scenario such as hello-world) — the caller renders no
 * continuity section for such a cell rather than an all-incomparable table.
 *
 * @param {object} args
 * @param {Array<object>} args.mandrelRuns  Scorecards for the Mandrel arm.
 * @param {Array<object>} args.controlRuns  Scorecards for the control arm.
 * @param {'iqr'|'ci'} [args.method='iqr']
 * @param {string} [args.scenario]
 * @returns {{
 *   scenario: string|undefined,
 *   method: 'iqr'|'ci',
 *   present: boolean,
 *   n: { mandrel: number, control: number },
 *   metrics: Record<string, object>
 * }}
 */
export function computeContinuityDelta({
  mandrelRuns,
  controlRuns,
  method = 'iqr',
  scenario,
}) {
  if (!Array.isArray(mandrelRuns) || !Array.isArray(controlRuns)) {
    throw new TypeError(
      'computeContinuityDelta: mandrelRuns and controlRuns must be arrays',
    );
  }
  const metrics = {};
  for (const { name, accessor } of CONTINUITY_METRICS) {
    const mandrelBand = bandOrNull(mandrelRuns.map(accessor), method);
    const controlBand = bandOrNull(controlRuns.map(accessor), method);
    metrics[name] = compareBands({ name, mandrelBand, controlBand });
  }
  const present =
    mandrelRuns.some((sc) => sc?.touch2 != null) ||
    controlRuns.some((sc) => sc?.touch2 != null);
  return {
    scenario,
    method,
    present,
    n: { mandrel: mandrelRuns.length, control: controlRuns.length },
    metrics,
  };
}

/**
 * Ordinary-least-squares slope of `y` on `x` over a set of points — the
 * degradation-slope primitive (issue #124, design §4). Returns `null` when
 * fewer than two points are supplied or every `x` is identical (the slope is
 * undefined, never a fabricated 0).
 *
 * @param {Array<{ x: number, y: number }>} points
 * @returns {number|null}
 */
export function olsSlope(points) {
  if (!Array.isArray(points)) {
    throw new TypeError('olsSlope: points must be an array');
  }
  const pts = points.filter(
    (p) =>
      typeof p?.x === 'number' &&
      Number.isFinite(p.x) &&
      typeof p?.y === 'number' &&
      Number.isFinite(p.y),
  );
  if (pts.length < 2) return null;
  const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
  const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) * (p.x - mx);
    sxy += (p.x - mx) * (p.y - my);
  }
  if (sxx === 0) return null;
  return sxy / sxx;
}

/**
 * Per-cell chain slopes + seeded-gap annotations for ONE chain scorecard
 * (issue #124, design §4). Returns `null` when the record carries no `chain`
 * block (a non-chain scorecard), so callers can filter chain cells cheaply.
 *
 * Exclusion rules (design §4/§5):
 *   - QUALITY regression (`outcomeSlope`): touches whose `outcome` is null
 *     (unmaterialized delivery / no suite verdict) are EXCLUDED — an
 *     unmeasured touch is never scored a fabricated 0.
 *   - COST regression (`costSlope`): every touch with a finite `cost` is
 *     INCLUDED, landed or not — the spend is real even when the change never
 *     materialized (the autonomy penalty in dollars).
 *   - `seededFromTouch` gaps (a touch seeded from an earlier tree than its
 *     immediate predecessor, i.e. skip-forward fired) are ANNOTATED, never
 *     silently pooled: each gap is reported so a reader knows some touch
 *     indices share a baseline.
 *
 * @param {object} sc  One scorecard (potentially carrying `chain.touches[]`).
 * @returns {{
 *   outcomeSlope: number|null,
 *   costSlope: number|null,
 *   outcomePoints: number,
 *   costPoints: number,
 *   seededGaps: Array<{ touchIndex: number, seededFromTouch: number }>
 * }|null}
 */
export function cellChainSlopes(sc) {
  const touches = sc?.chain?.touches;
  if (!Array.isArray(touches)) return null;
  const outcomePts = [];
  const costPts = [];
  const seededGaps = [];
  for (const t of touches) {
    const idx = t?.touchIndex;
    if (typeof idx !== 'number' || !Number.isFinite(idx)) continue;
    if (typeof t.outcome === 'number' && Number.isFinite(t.outcome)) {
      outcomePts.push({ x: idx, y: t.outcome });
    }
    if (typeof t.cost === 'number' && Number.isFinite(t.cost)) {
      costPts.push({ x: idx, y: t.cost });
    }
    if (
      typeof t.seededFromTouch === 'number' &&
      Number.isFinite(t.seededFromTouch) &&
      t.seededFromTouch !== idx - 1
    ) {
      seededGaps.push({ touchIndex: idx, seededFromTouch: t.seededFromTouch });
    }
  }
  return {
    outcomeSlope: olsSlope(outcomePts),
    costSlope: olsSlope(costPts),
    outcomePoints: outcomePts.length,
    costPoints: costPts.length,
    seededGaps,
  };
}

/**
 * Pool one arm's chain cells into its per-arm slope statistics: the per-cell
 * OLS slopes (each cell contributes ONE slope per metric — the cell-level
 * resampling unit the noise-band machinery expects), the pooled slope over
 * every per-touch point across all cells (the arm's headline point estimate),
 * and the seeded-gap annotations keyed by run id.
 *
 * @param {Array<object>} runs  One arm's scorecards.
 * @returns {{
 *   cells: number,
 *   outcomeSlopes: number[],
 *   costSlopes: number[],
 *   pooledOutcomeSlope: number|null,
 *   pooledCostSlope: number|null,
 *   seededGaps: Array<{ runId: string|null, touchIndex: number, seededFromTouch: number }>
 * }}
 */
function armChainSlopes(runs) {
  const outcomeSlopes = [];
  const costSlopes = [];
  const pooledOutcome = [];
  const pooledCost = [];
  const seededGaps = [];
  let cells = 0;
  for (const sc of runs ?? []) {
    const cell = cellChainSlopes(sc);
    if (cell === null) continue;
    cells += 1;
    if (cell.outcomeSlope !== null) outcomeSlopes.push(cell.outcomeSlope);
    if (cell.costSlope !== null) costSlopes.push(cell.costSlope);
    for (const t of sc.chain.touches) {
      const idx = t?.touchIndex;
      if (typeof idx !== 'number' || !Number.isFinite(idx)) continue;
      if (typeof t.outcome === 'number' && Number.isFinite(t.outcome)) {
        pooledOutcome.push({ x: idx, y: t.outcome });
      }
      if (typeof t.cost === 'number' && Number.isFinite(t.cost)) {
        pooledCost.push({ x: idx, y: t.cost });
      }
    }
    for (const gap of cell.seededGaps) {
      seededGaps.push({
        runId: typeof sc?.runId === 'string' ? sc.runId : null,
        ...gap,
      });
    }
  }
  return {
    cells,
    outcomeSlopes,
    costSlopes,
    pooledOutcomeSlope: olsSlope(pooledOutcome),
    pooledCostSlope: olsSlope(pooledCost),
    seededGaps,
  };
}

/**
 * Compute the DEGRADATION SLOPE differential for ONE chain scenario cell
 * (issue #124, design §4) — mandrel's thesis predicts a FLATTER slope: quality
 * degrades less (outcome slope less negative) and cost grows less (cost slope
 * less positive) across the touch chain than under the bare control arm.
 *
 * A cross-run derived metric like the continuity delta: per arm, every chain
 * cell contributes ONE per-cell OLS slope per metric (outcome-on-touchIndex,
 * cost-on-touchIndex), the arm's noise-band forms over those per-cell slopes
 * (the existing cell-level resampling approach — `noiseBand` over per-cell
 * values), and the headline read is mandrel slope − control slope under the
 * binding real-delta rule (`compareBands`, identical to every other
 * differential verdict in this module).
 *
 * Exclusion rules are per-cell (see {@link cellChainSlopes}): null outcomes
 * excluded from the quality regression, every finite cost included in the
 * cost regression, and `seededFromTouch` gaps annotated on the result —
 * never silently pooled.
 *
 * `present` is false when NEITHER arm carries any `chain` block for the cell
 * (a non-chain scenario) — the caller renders no chain section for such a
 * cell rather than an all-incomparable table.
 *
 * @param {object} args
 * @param {Array<object>} args.mandrelRuns  Scorecards for the Mandrel arm.
 * @param {Array<object>} args.controlRuns  Scorecards for the control arm.
 * @param {'iqr'|'ci'} [args.method='iqr']
 * @param {string} [args.scenario]
 * @returns {{
 *   scenario: string|undefined,
 *   method: 'iqr'|'ci',
 *   present: boolean,
 *   n: { mandrel: number, control: number },
 *   metrics: Record<'chain.outcomeSlope'|'chain.costSlope', object>,
 *   perArm: {
 *     mandrel: ReturnType<typeof armChainSlopes>,
 *     control: ReturnType<typeof armChainSlopes>
 *   },
 *   seededGaps: { mandrel: Array<object>, control: Array<object> }
 * }}
 */
export function degradationSlope({
  mandrelRuns,
  controlRuns,
  method = 'iqr',
  scenario,
}) {
  if (!Array.isArray(mandrelRuns) || !Array.isArray(controlRuns)) {
    throw new TypeError(
      'degradationSlope: mandrelRuns and controlRuns must be arrays',
    );
  }
  const mandrel = armChainSlopes(mandrelRuns);
  const control = armChainSlopes(controlRuns);
  const metrics = {
    'chain.outcomeSlope': compareBands({
      name: 'chain.outcomeSlope',
      mandrelBand: bandOrNull(mandrel.outcomeSlopes, method),
      controlBand: bandOrNull(control.outcomeSlopes, method),
    }),
    'chain.costSlope': compareBands({
      name: 'chain.costSlope',
      mandrelBand: bandOrNull(mandrel.costSlopes, method),
      controlBand: bandOrNull(control.costSlopes, method),
    }),
  };
  return {
    scenario,
    method,
    present: mandrel.cells > 0 || control.cells > 0,
    n: { mandrel: mandrel.cells, control: control.cells },
    metrics,
    perArm: { mandrel, control },
    seededGaps: {
      mandrel: mandrel.seededGaps,
      control: control.seededGaps,
    },
  };
}

/**
 * Per-arm cost-per-landed-change aggregation for ONE chain scenario cell
 * (issue #124, design §4/§5). PR-C computes the per-cell
 * `chain.costPerLandedChange` at scorecard build (Σ every touch's cost —
 * landed or not — ÷ landedCount; landed strictly means `landed: true` on
 * mandrel arms, with advanced control touches counting because landing is not
 * a concept there); this aggregates ACROSS the arm's cells: mean + noise-band
 * over the per-cell values, alongside the landed and strict-landed counts.
 * Cells whose `costPerLandedChange` is null (no touch landed) are excluded
 * from the mean/band but surface via `cellsWithNoLanding`.
 *
 * Returns `null` when the arm carries no chain records at all.
 *
 * @param {Array<object>} runs  One arm's scorecards.
 * @param {object} [options]
 * @param {'iqr'|'ci'} [options.method='iqr']
 * @returns {{
 *   cells: number,
 *   touchesTotal: number,
 *   landedCountTotal: number,
 *   landedCountMean: number,
 *   landedTrueTotal: number,
 *   cellsWithNoLanding: number,
 *   costPerLandedChange: { n: number, mean: number|null, band: object|null }
 * }|null}
 */
export function chainArmSummary(runs, { method = 'iqr' } = {}) {
  if (!Array.isArray(runs)) {
    throw new TypeError('chainArmSummary: runs must be an array');
  }
  const chainRuns = runs.filter((sc) => Array.isArray(sc?.chain?.touches));
  if (chainRuns.length === 0) return null;
  let touchesTotal = 0;
  let landedCountTotal = 0;
  let landedTrueTotal = 0;
  let cellsWithNoLanding = 0;
  const cplcValues = [];
  for (const sc of chainRuns) {
    touchesTotal += sc.chain.touches.length;
    const lc = sc.chain.landedCount;
    if (typeof lc === 'number' && Number.isFinite(lc)) landedCountTotal += lc;
    landedTrueTotal += sc.chain.touches.filter(
      (t) => t?.landed === true,
    ).length;
    const cplc = sc.chain.costPerLandedChange;
    if (typeof cplc === 'number' && Number.isFinite(cplc)) {
      cplcValues.push(cplc);
    } else {
      cellsWithNoLanding += 1;
    }
  }
  return {
    cells: chainRuns.length,
    touchesTotal,
    landedCountTotal,
    landedCountMean: landedCountTotal / chainRuns.length,
    landedTrueTotal,
    cellsWithNoLanding,
    costPerLandedChange: {
      n: cplcValues.length,
      mean:
        cplcValues.length > 0
          ? cplcValues.reduce((a, b) => a + b, 0) / cplcValues.length
          : null,
      band: bandOrNull(cplcValues, method),
    },
  };
}

/**
 * Center of a band over the Mandrel arm's per-run values for one metric in one
 * scenario cell — the building block of the cross-scenario metrics. Returns
 * `null` when the cell has no finite values.
 *
 * @param {Array<object>} scorecards
 * @param {(d: object) => number|null} accessor
 * @param {'iqr'|'ci'} method
 * @returns {number|null}
 */
function centerOf(scorecards, accessor, method) {
  const band = bandOrNull(valuesFor(scorecards, accessor), method);
  return band ? band.center : null;
}

/**
 * Cross-scenario metric A — **difficulty monotonicity** (calibration guardrail).
 *
 * Over the difficulty-ordered scenario list (easy → hard), comparing the
 * Mandrel arm's band centers, two things MUST hold for every adjacent pair:
 *
 *   - Efficiency (totalTokens) RISES:   center(tokens, sᵢ) < center(tokens, sᵢ₊₁)
 *   - Overhead ratio FALLS:             center(ratio,  sᵢ) > center(ratio,  sᵢ₊₁)
 *
 * A violation is a **calibration warning**, surfaced explicitly (never a silent
 * pass): it means the instrument is insensitive or a scenario is mis-graded.
 *
 * @param {object} args
 * @param {Array<{ scenario: string, difficulty: number, mandrelRuns: Array<object> }>} args.cells
 *   One entry per scenario, each carrying the scenario id, its numeric
 *   difficulty (from scenario.json), and the Mandrel arm's scorecards.
 * @param {'iqr'|'ci'} [args.method='iqr']
 * @returns {{
 *   ordered: Array<{ scenario: string, difficulty: number, totalTokens: number|null, tokenRatio: number|null }>,
 *   pairs: Array<{
 *     from: string, to: string,
 *     efficiencyRises: boolean, overheadFalls: boolean,
 *     holds: boolean,
 *     violations: string[]
 *   }>,
 *   monotonicityHolds: boolean,
 *   warnings: string[]
 * }}
 */
export function difficultyMonotonicity({ cells, method = 'iqr' }) {
  if (!Array.isArray(cells)) {
    throw new TypeError('difficultyMonotonicity: cells must be an array');
  }

  const ordered = cells
    .map((c) => ({
      scenario: c.scenario,
      difficulty: c.difficulty,
      totalTokens: centerOf(
        c.mandrelRuns ?? [],
        (d) => d?.efficiency?.totalTokens ?? null,
        method,
      ),
      tokenRatio: centerOf(
        c.mandrelRuns ?? [],
        (d) => d?.overheadRatio?.tokenRatio ?? null,
        method,
      ),
    }))
    .sort((a, b) => a.difficulty - b.difficulty);

  const pairs = [];
  const warnings = [];
  let monotonicityHolds = true;

  for (let i = 0; i < ordered.length - 1; i += 1) {
    const lo = ordered[i];
    const hi = ordered[i + 1];
    const violations = [];

    // Efficiency must rise (harder work costs more in absolute terms).
    const efficiencyRises =
      lo.totalTokens !== null &&
      hi.totalTokens !== null &&
      hi.totalTokens > lo.totalTokens;
    if (lo.totalTokens === null || hi.totalTokens === null) {
      violations.push(
        `efficiency.totalTokens not comparable between ${lo.scenario} and ${hi.scenario} (missing band center)`,
      );
    } else if (!efficiencyRises) {
      violations.push(
        `efficiency.totalTokens did not rise: ${lo.scenario}=${lo.totalTokens} ≥ ${hi.scenario}=${hi.totalTokens}`,
      );
    }

    // Overhead ratio must fall (ceremony amortizes over more output).
    const overheadFalls =
      lo.tokenRatio !== null &&
      hi.tokenRatio !== null &&
      hi.tokenRatio < lo.tokenRatio;
    if (lo.tokenRatio === null || hi.tokenRatio === null) {
      violations.push(
        `overheadRatio.tokenRatio not comparable between ${lo.scenario} and ${hi.scenario} (missing band center)`,
      );
    } else if (!overheadFalls) {
      violations.push(
        `overheadRatio.tokenRatio did not fall: ${lo.scenario}=${lo.tokenRatio} ≤ ${hi.scenario}=${hi.tokenRatio}`,
      );
    }

    const holds = violations.length === 0;
    if (!holds) {
      monotonicityHolds = false;
      for (const v of violations) {
        warnings.push(`[calibration] ${v}`);
      }
    }
    pairs.push({
      from: lo.scenario,
      to: hi.scenario,
      efficiencyRises,
      overheadFalls,
      holds,
      violations,
    });
  }

  return { ordered, pairs, monotonicityHolds, warnings };
}

/**
 * Cross-scenario metric B — **overhead floor** (framework finding).
 *
 * The fixed ceremony tax Mandrel pays on near-zero work, estimated from the
 * `hello-world` rung as the cost the Mandrel arm pays ABOVE the control arm:
 *
 *   overheadFloorTokens = center(totalTokens, hello-world, mandrel)
 *                        − center(totalTokens, hello-world, control)
 *   overheadFloorUsd    = center(costUsd,     hello-world, mandrel)
 *                        − center(costUsd,     hello-world, control)
 *
 * Computed on the band centers (so it inherits the distribution method) AND
 * reported with its own band derived from the per-run differences over
 * SEED-MATCHED pairs (Story #157) — the same seed-keyed pairing the paired
 * differential uses, so the floor's band no longer index-aligns over the
 * shorter arm and no longer mispairs a resumed cohort whose arms drifted out of
 * order. Runs with no seed counterpart drop out and surface in `unpaired`.
 *
 * A large floor with NO corresponding `quality.score` gain on `hello-world` is
 * the canonical evidence for the report's "ceremony-lite path for trivial
 * scopes" recommendation; this function surfaces that condition as a flag.
 *
 * @param {object} args
 * @param {Array<object>} args.mandrelRuns  hello-world Mandrel scorecards.
 * @param {Array<object>} args.controlRuns  hello-world control scorecards.
 * @param {'iqr'|'ci'} [args.method='iqr']
 * @param {number} [args.qualityGainEpsilon=0.05]  A Mandrel quality center
 *   that exceeds control by less than this is treated as "no quality gain".
 * @param {(sc: object) => string|null} [args.seedAccessor=defaultSeedAccessor]
 * @returns {{
 *   scenario: 'hello-world',
 *   overheadFloorTokens: number|null,
 *   overheadFloorUsd: number|null,
 *   tokenDiffBand: object|null,
 *   usdDiffBand: object|null,
 *   unpaired: { mandrel: number, control: number },
 *   qualityGain: number|null,
 *   noQualityGain: boolean,
 *   recommendCeremonyLite: boolean
 * }}
 */
export function overheadFloor({
  mandrelRuns,
  controlRuns,
  method = 'iqr',
  qualityGainEpsilon = 0.05,
  seedAccessor = defaultSeedAccessor,
}) {
  if (!Array.isArray(mandrelRuns) || !Array.isArray(controlRuns)) {
    throw new TypeError(
      'overheadFloor: mandrelRuns and controlRuns must be arrays',
    );
  }

  const tokenAccessor = (d) => d?.efficiency?.totalTokens ?? null;
  const usdAccessor = (d) => d?.efficiency?.costUsd ?? null;
  const qualityAccessor = (d) => d?.quality?.score ?? null;

  const mandrelTokens = centerOf(mandrelRuns, tokenAccessor, method);
  const controlTokens = centerOf(controlRuns, tokenAccessor, method);
  const overheadFloorTokens =
    mandrelTokens !== null && controlTokens !== null
      ? mandrelTokens - controlTokens
      : null;

  const mandrelUsd = centerOf(mandrelRuns, usdAccessor, method);
  const controlUsd = centerOf(controlRuns, usdAccessor, method);
  const overheadFloorUsd =
    mandrelUsd !== null && controlUsd !== null ? mandrelUsd - controlUsd : null;

  // Per-run paired differences over SEED-MATCHED pairs give the floor its own
  // band — the generalized seed-keyed pairing, not index alignment.
  const { pairs, unpaired } = pairRunsBySeed(
    mandrelRuns,
    controlRuns,
    seedAccessor,
  );
  const tokenDiffs = [];
  const usdDiffs = [];
  for (const p of pairs) {
    const mt = tokenAccessor(p.mandrel?.dimensions);
    const ct = tokenAccessor(p.control?.dimensions);
    if (typeof mt === 'number' && typeof ct === 'number') {
      tokenDiffs.push(mt - ct);
    }
    const mu = usdAccessor(p.mandrel?.dimensions);
    const cu = usdAccessor(p.control?.dimensions);
    if (typeof mu === 'number' && typeof cu === 'number') {
      usdDiffs.push(mu - cu);
    }
  }
  const tokenDiffBand = bandOrNull(tokenDiffs, method);
  const usdDiffBand = bandOrNull(usdDiffs, method);

  const mandrelQuality = centerOf(mandrelRuns, qualityAccessor, method);
  const controlQuality = centerOf(controlRuns, qualityAccessor, method);
  const qualityGain =
    mandrelQuality !== null && controlQuality !== null
      ? mandrelQuality - controlQuality
      : null;
  const noQualityGain =
    qualityGain !== null && qualityGain < qualityGainEpsilon;

  // The recommendation fires when there IS a positive overhead floor AND no
  // matching quality gain to justify it.
  const recommendCeremonyLite =
    overheadFloorTokens !== null && overheadFloorTokens > 0 && noQualityGain;

  return {
    scenario: 'hello-world',
    overheadFloorTokens,
    overheadFloorUsd,
    tokenDiffBand,
    usdDiffBand,
    unpaired,
    qualityGain,
    noQualityGain,
    recommendCeremonyLite,
  };
}

/**
 * Convenience top-level: compute the per-scenario differentials AND both
 * cross-scenario metrics from a full corpus of scorecards keyed by scenario
 * and arm. This is the function a report slice calls with everything it has.
 *
 * @param {object} args
 * @param {Array<{
 *   scenario: string,
 *   difficulty: number,
 *   mandrelRuns: Array<object>,
 *   controlRuns: Array<object>
 * }>} args.cells
 * @param {'iqr'|'ci'} [args.method='iqr']
 * @returns {{
 *   method: 'iqr'|'ci',
 *   perScenario: Array<ReturnType<typeof computeDifferential>>,
 *   difficultyMonotonicity: ReturnType<typeof difficultyMonotonicity>,
 *   overheadFloor: ReturnType<typeof overheadFloor>|null
 * }}
 */
export function scoreCorpus({ cells, method = 'iqr', seedAccessor }) {
  if (!Array.isArray(cells)) {
    throw new TypeError('scoreCorpus: cells must be an array');
  }

  const perScenario = cells.map((c) =>
    computeDifferential({
      scenario: c.scenario,
      mandrelRuns: c.mandrelRuns ?? [],
      controlRuns: c.controlRuns ?? [],
      method,
      seedAccessor,
    }),
  );

  const mono = difficultyMonotonicity({
    cells: cells.map((c) => ({
      scenario: c.scenario,
      difficulty: c.difficulty,
      mandrelRuns: c.mandrelRuns ?? [],
    })),
    method,
  });

  const floorCell = cells.find((c) => c.scenario === 'hello-world');
  const floor = floorCell
    ? overheadFloor({
        mandrelRuns: floorCell.mandrelRuns ?? [],
        controlRuns: floorCell.controlRuns ?? [],
        method,
        seedAccessor,
      })
    : null;

  return {
    method,
    perScenario,
    difficultyMonotonicity: mono,
    overheadFloor: floor,
  };
}
