// bench/score/dimensions.js
//
// The seven-dimension scorer for the Mandrel self-benchmark harness
// (Epic #4211, Story #4217; extended by Epic #32, Story #36). Internal
// tooling only — never shipped in the distributed `.agents/` bundle, never
// run against the live repo.
//
// This module is the single source of truth for turning the raw inputs a
// single run recorded (frozen-suite results, the acceptance-eval verdict,
// plan-vs-actual counts, lifecycle timings/autonomy counters, the `claude -p`
// usage envelope, the ceremony/codegen token split, and the new
// maintainability/security sub-signals) into the seven per-run dimension
// values that land on a scorecard under `dimensions.<name>`.
//
// Every formula is the verbatim, reproducible definition from the binding
// measurement contract at bench/metrics/README.md § "The five dimensions"
// (original) and § "Maintainability" / § "Security" (Story #36 additions):
//
//   value side: quality, planningFidelity, autonomy, maintainability, security
//   cost side:  efficiency, overheadRatio
//
// Determinism: pure functions, no I/O, no clock, no randomness. The same
// inputs always yield the same dimension object, so a persisted scorecard is
// reproducible and re-scorable from its rawRefs.
//
// The distribution / noise-band across N runs is NOT computed here — that is
// the job of bench/metrics/variance.js (consumed by bench/score/differential.js).
// This module produces the single per-run point that feeds those bands.

/**
 * Quality weights (README § 1). The frozen acceptance suite is the objective
 * spine (`w_suite`); the acceptance-eval LLM judge is a cross-check
 * (`w_judge`). When the judge did not run (`acceptanceEvalScore == null`,
 * e.g. the control arm with no acceptance criteria) the judge weight folds
 * into the suite weight, renormalizing `w_suite` to 1.0.
 */
export const QUALITY_WEIGHTS = Object.freeze({ suite: 0.7, judge: 0.3 });

/**
 * Coerce a value to a finite number, or return `fallback`. Used to keep a
 * malformed recorded input from poisoning a formula with NaN.
 *
 * @param {unknown} v
 * @param {number} fallback
 * @returns {number}
 */
function finiteOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Coerce a value to a non-negative integer, defaulting to 0. Count inputs
 * (dispatches, blocked events, story counts) are always non-negative integers;
 * a missing or malformed field collapses to 0 rather than NaN.
 *
 * @param {unknown} v
 * @returns {number}
 */
function nonNegInt(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
    return Math.trunc(v);
  }
  return 0;
}

/**
 * Clamp a number into the closed interval [lo, hi].
 *
 * @param {number} v
 * @param {number} [lo=0]
 * @param {number} [hi=1]
 * @returns {number}
 */
function clamp(v, lo = 0, hi = 1) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * Jaccard distance between two path sets — the symmetric file-footprint drift
 * between a plan's `changes[]` paths (P) and the files actually touched (A):
 *
 *   drift = 1 − |P ∩ A| / |P ∪ A|        (0 when both sets are empty)
 *
 * @param {Iterable<string>} planned  Planned `changes[]` paths.
 * @param {Iterable<string>} actual   Actually-touched paths.
 * @returns {number} Jaccard distance in [0, 1].
 */
export function fileFootprintDrift(planned, actual) {
  const P = new Set(planned ?? []);
  const A = new Set(actual ?? []);
  if (P.size === 0 && A.size === 0) return 0;
  let intersection = 0;
  for (const p of P) {
    if (A.has(p)) intersection += 1;
  }
  const union = P.size + A.size - intersection;
  if (union === 0) return 0;
  return 1 - intersection / union;
}

/**
 * Quality — *is the output correct & on-intent?* (value side)
 *
 *   frozenSuitePassRate = frozenSuitePassed / frozenSuiteTotal      ∈ [0, 1]
 *   quality.score = w_suite·passRate + w_judge·acceptanceEvalScore  ∈ [0, 1]
 *     with w_judge folded into w_suite (→ 1.0) when acceptanceEvalScore null.
 *
 * A run that delivered no runnable app passes zero of its frozen assertions
 * (`frozenSuiteTotal === 0` is treated as pass-rate 0, NOT "no data"), so its
 * quality is 0 — exactly the README's stated behaviour.
 *
 * @param {object} input
 * @param {number} input.frozenSuitePassed   Count of passing frozen assertions.
 * @param {number} input.frozenSuiteTotal    Total frozen assertions.
 * @param {number|null} [input.acceptanceEvalScore]  LLM-judge cross-check in
 *   [0,1], or null when the judge did not run.
 * @returns {{
 *   score: number,
 *   frozenSuitePassRate: number,
 *   frozenSuitePassed: number,
 *   frozenSuiteTotal: number,
 *   acceptanceEvalScore: number|null
 * }}
 */
export function computeQuality(input = {}) {
  // UNMATERIALIZED delivery (`measured: false`): the mandrel `/deliver` never
  // landed on origin/main (the workspace holds only the seed baseline), so
  // there is no runnable app to probe. Score quality NULL, not 0 — a false 0 is
  // indistinguishable from a genuine "delivered broken code" miss and would
  // poison the differential. The absence is the honest autonomy signal, carried
  // separately as a `delivery-not-materialized` warning. Symmetric to the
  // touch-2 materialization guard and to planning-fidelity's `planObserved`.
  if (input.measured === false) {
    return {
      score: null,
      frozenSuitePassRate: null,
      frozenSuitePassed: 0,
      frozenSuiteTotal: 0,
      acceptanceEvalScore: null,
      guardrail: computeGuardrail(
        null,
        input.guardrailThreshold,
        DEFAULT_QUALITY_GUARDRAIL_THRESHOLD,
      ),
    };
  }
  const passed = nonNegInt(input.frozenSuitePassed);
  const total = nonNegInt(input.frozenSuiteTotal);
  // A delivered-but-empty suite (total 0) scores 0, never a divide-by-zero.
  const passRate = total > 0 ? clamp(passed / total) : 0;

  const judgeRaw = input.acceptanceEvalScore;
  const judgePresent =
    typeof judgeRaw === 'number' && Number.isFinite(judgeRaw);
  const acceptanceEvalScore = judgePresent ? clamp(judgeRaw) : null;

  let score;
  if (acceptanceEvalScore === null) {
    // Judge weight folds entirely onto the frozen suite.
    score = passRate;
  } else {
    score =
      QUALITY_WEIGHTS.suite * passRate +
      QUALITY_WEIGHTS.judge * acceptanceEvalScore;
  }

  const finalScore = clamp(score);
  return {
    score: finalScore,
    frozenSuitePassRate: passRate,
    frozenSuitePassed: passed,
    frozenSuiteTotal: total,
    acceptanceEvalScore,
    guardrail: computeGuardrail(
      finalScore,
      input.guardrailThreshold,
      DEFAULT_QUALITY_GUARDRAIL_THRESHOLD,
    ),
  };
}

/**
 * Planning fidelity — *did the plan match reality?* (value side)
 *
 *   storyAccuracy     = 1 − |planned − delivered| / max(planned, delivered, 1)
 *   rePlanPenalty     = 1 / (1 + rePlanCount)
 *   footprintAccuracy = 1 − fileFootprintDrift
 *   score = (storyAccuracy + rePlanPenalty + footprintAccuracy) / 3   ∈ [0, 1]
 *
 * **`null` for the control arm** — it authors no plan. The caller signals this
 * with `arm: 'control'` (or `planAuthored: false`); the score is then null and
 * the sub-signals are reported as zeros for shape stability.
 *
 * `fileFootprintDrift` may be supplied directly, or derived from
 * `plannedPaths` / `actualPaths` when both arrays are present.
 *
 * **Footprint proportionality (target-architecture §8).** The Jaccard-based
 * footprint term is inherently size-relative — one extra/missing file among
 * ten hurts far less than the same miss among two — so it already "scales
 * proportionally" as declared plan size grows. What it does NOT handle well
 * is the small-plan edge: a ≤1-file plan (including a plan that declared NO
 * files at all, e.g. the standalone single-Story path, which tracks
 * `actualPaths` but never threads a `plannedPaths` list) has essentially no
 * footprint signal to measure — a single incidental extra file (a touched
 * `package.json`, a renamed target) swings drift from 0 to 1 and previously
 * dragged a functionally-perfect delivery's score down to ~0.67. When the
 * declared plan size is known (via `plannedFileCount`, or derived from a
 * `plannedPaths` array — including an empty one) and is ≤1, the footprint
 * term is DROPPED from the mean entirely (average of the remaining two
 * sub-scores) rather than included as a noisy, unreliable signal. Plan size
 * is only "known" when the caller threads footprint-tracking inputs
 * (`plannedFileCount` or a `plannedPaths`/`actualPaths` array); a bare
 * precomputed `fileFootprintDrift` number with no path arrays carries no
 * plan-size signal, so the footprint term is kept in the mean unchanged
 * (back-compat with callers that only ever reported the scalar drift).
 *
 * @param {object} input
 * @param {'mandrel'|'control'} [input.arm]
 * @param {boolean} [input.planAuthored]   Explicit override; defaults to
 *   `arm !== 'control'`.
 * @param {number} [input.rePlanCount]
 * @param {number} [input.plannedStoryCount]
 * @param {number} [input.deliveredStoryCount]
 * @param {number} [input.fileFootprintDrift]  Precomputed Jaccard distance.
 * @param {number} [input.plannedFileCount]  Explicit declared-plan file
 *   count; overrides the count derived from `plannedPaths` when supplied.
 * @param {Iterable<string>} [input.plannedPaths]  Used iff fileFootprintDrift
 *   is not supplied and actualPaths is present. An array here (even empty)
 *   is also the plan-size signal for the footprint-drop rule above.
 * @param {Iterable<string>} [input.actualPaths]
 * @returns {{
 *   score: number|null,
 *   rePlanCount: number,
 *   plannedStoryCount: number,
 *   deliveredStoryCount: number,
 *   fileFootprintDrift: number,
 *   footprintDropped: boolean
 * }}
 */
export function computePlanningFidelity(input = {}) {
  const rePlanCount = nonNegInt(input.rePlanCount);
  const plannedStoryCount = nonNegInt(input.plannedStoryCount);
  const deliveredStoryCount = nonNegInt(input.deliveredStoryCount);

  const havePlannedPaths = Array.isArray(input.plannedPaths);
  const haveActualPaths = Array.isArray(input.actualPaths);

  // The footprint term is MEASURABLE only when the caller threaded a real
  // signal: an explicit scalar drift, or a plan/actual path set. With none of
  // those — e.g. the Epic-routed path, which threads only story counts — the
  // footprint cannot be measured, and must be DROPPED from the mean rather than
  // silently defaulting to a perfect 1.0 (which would inflate planning fidelity
  // on exactly the runs that decompose the most). This generalizes the same
  // §8/D-018 honesty rule already applied to ≤1-file plans to "unmeasurable".
  const footprintMeasurable =
    typeof input.fileFootprintDrift === 'number' ||
    havePlannedPaths ||
    haveActualPaths;

  let drift;
  if (typeof input.fileFootprintDrift === 'number') {
    drift = clamp(finiteOr(input.fileFootprintDrift, 0));
  } else if (havePlannedPaths || haveActualPaths) {
    drift = fileFootprintDrift(input.plannedPaths, input.actualPaths);
  } else {
    drift = 0;
  }

  // Plan size is only knowable when the caller threaded a footprint-tracking
  // signal. An explicit `plannedFileCount` wins; else derive from a
  // `plannedPaths` array (its Set size, so an empty array reads as 0); else,
  // when only `actualPaths` was tracked (the plan declared no files at all —
  // exactly the standalone-path shape), treat the declared plan as 0 files.
  // A bare scalar `fileFootprintDrift` with no path arrays leaves plan size
  // unknown (`null`) so legacy callers keep the original 3-way average.
  let plannedFileCount = null;
  if (
    typeof input.plannedFileCount === 'number' &&
    Number.isFinite(input.plannedFileCount)
  ) {
    plannedFileCount = Math.max(0, Math.trunc(input.plannedFileCount));
  } else if (havePlannedPaths) {
    plannedFileCount = new Set(input.plannedPaths).size;
  } else if (haveActualPaths) {
    plannedFileCount = 0;
  }
  const footprintDropped =
    !footprintMeasurable ||
    (plannedFileCount !== null && plannedFileCount <= 1);

  const planAuthored =
    typeof input.planAuthored === 'boolean'
      ? input.planAuthored
      : input.arm !== 'control';

  // `planObserved` is the caller's signal that a plan ledger was actually
  // discovered for this run (default: assume observed, for back-compat with
  // callers that don't thread it). When the mandrel arm produces no lifecycle
  // ledger, planned/delivered counts default to 0/0, which would otherwise
  // compute a PERFECT storyAccuracy (|0−0|/max(…,1) = 0 → 1) and credit Mandrel
  // with flawless planning fidelity it was never measured to have. Score that
  // unmeasured case as `null` so the report excludes it, never as a default 1.
  const planObserved = input.planObserved !== false;
  if (!planAuthored || !planObserved) {
    return {
      score: null,
      rePlanCount,
      plannedStoryCount,
      deliveredStoryCount,
      fileFootprintDrift: drift,
      footprintDropped,
    };
  }

  const storyAccuracy =
    1 -
    Math.abs(plannedStoryCount - deliveredStoryCount) /
      Math.max(plannedStoryCount, deliveredStoryCount, 1);
  const rePlanPenalty = 1 / (1 + rePlanCount);
  const footprintAccuracy = 1 - drift;

  const score = footprintDropped
    ? (storyAccuracy + rePlanPenalty) / 2
    : (storyAccuracy + rePlanPenalty + footprintAccuracy) / 3;

  return {
    score: clamp(score),
    rePlanCount,
    plannedStoryCount,
    deliveredStoryCount,
    fileFootprintDrift: drift,
    footprintDropped,
  };
}

/** Default cohort guardrail threshold for the autonomy dimension (§8). */
export const DEFAULT_AUTONOMY_GUARDRAIL_THRESHOLD = 0.99;

/**
 * Default cohort guardrail thresholds for the SATURATED value dimensions
 * (Story #157). Quality, maintainability, and security are demoted from
 * reported mandrel-vs-control deltas to pass/fail GUARDRAIL gates: both arms
 * score at ceiling on the current corpus, so their deltas are noise reported
 * as measurement. A gate against a fixed threshold restores a meaningful
 * signal — a drop below it is itself a finding — and their numeric deltas move
 * to the report appendix rather than the headline scorecard. These stay
 * demoted until a weak-model calibration probe demonstrates dynamic range.
 */
export const DEFAULT_QUALITY_GUARDRAIL_THRESHOLD = 0.9;
export const DEFAULT_MAINTAINABILITY_GUARDRAIL_THRESHOLD = 0.9;
export const DEFAULT_SECURITY_GUARDRAIL_THRESHOLD = 0.9;

/**
 * Evaluate a pass/fail GUARDRAIL verdict — is this run's (or cohort's) score
 * at/above the fixed cohort threshold the dimension is gated on? The single
 * shared primitive behind every guardrail dimension (autonomy, and — Story
 * #157 — the demoted saturated dimensions quality / maintainability /
 * security). Unlike a mandrel-vs-control DELTA, this is a gate against a fixed
 * threshold: a drop below it is itself a finding, not a comparison point.
 *
 * @param {number|null} score      Score in [0,1], or null (unmeasured).
 * @param {number} threshold       Requested threshold.
 * @param {number} fallback        Threshold used when `threshold` is non-finite.
 * @returns {{ threshold: number, met: boolean|null }}  `met` is null when the
 *   score itself is unmeasured — an undetermined guardrail is never reported
 *   as a pass or a fail.
 */
export function computeGuardrail(score, threshold, fallback) {
  const t = finiteOr(threshold, fallback);
  const met =
    typeof score === 'number' && Number.isFinite(score) ? score >= t : null;
  return { threshold: t, met };
}

/**
 * Evaluate the autonomy guardrail verdict — is this run's (or cohort's)
 * autonomy score at/above the threshold a fully-unattended pipeline is
 * expected to clear? Unlike the retired mandrel-vs-control autonomy DELTA
 * (target-architecture §8: "autonomy reclassified as a mandrel-arm guardrail
 * … rather than a delta"), this is a pass/fail gate against a fixed cohort
 * threshold — a drop below it is itself a finding, not a comparison point.
 *
 * @param {number|null} score       Autonomy score in [0,1], or null (unmeasured).
 * @param {number} [threshold=DEFAULT_AUTONOMY_GUARDRAIL_THRESHOLD]
 * @returns {{ threshold: number, met: boolean|null }}  `met` is null when the
 *   score itself is unmeasured — an undetermined guardrail is never reported
 *   as a pass or a fail.
 */
export function computeAutonomyGuardrail(
  score,
  threshold = DEFAULT_AUTONOMY_GUARDRAIL_THRESHOLD,
) {
  return computeGuardrail(
    score,
    threshold,
    DEFAULT_AUTONOMY_GUARDRAIL_THRESHOLD,
  );
}

/**
 * Autonomy — *how little human intervention?* (value side)
 *
 *   interventions = unattendedLandingFailure + terminal blockedEvents
 *                   + manualRescues + hitlStops
 *   score = 1 / (1 + interventions)                                  ∈ (0, 1]
 *
 * `score === 1.0` ⇔ a fully-unattended run that also LANDED unattended.
 *
 * **Redefinition (Ticket #121, item 2).** Autonomy is now unattended-landing
 * rate + terminal `agent::blocked` at run end + manual rescues ONLY:
 *   - `landed === false` (the mandrel PR did not land unattended) is itself an
 *     intervention — the one genuine reliability failure the old formula turned
 *     into an invisible null now costs an autonomy point. `landed === true` or
 *     `null` (control / undetermined) adds nothing.
 *   - `blockedEvents` is TERMINAL blocks only. Self-recovered close-validate
 *     gate retries were moved OUT of this counter into `efficiency.gateRetries`
 *     (they are priced in tokens, not a human-intervention signal) by
 *     `deriveAutonomyCounters`, so they no longer drag every gated run to 0.50.
 *   - `hitlStops` (a STOP the run actually halted at) is retained — a genuine
 *     human-in-the-loop pause is the opposite of autonomy.
 *
 * `observed` is the caller's signal that a real telemetry source existed for
 * this run (Epic ledger or recovered standalone telemetry). When absent the
 * counters default to 0 — which would otherwise score a PERFECT 1.0 for a run
 * whose autonomy was never measured — so that unmeasured case scores `null`.
 * The bare control arm has NO telemetry source and is no longer handed a free
 * `observed: true`: its autonomy is null (N/A), not an unearned 1.0 baseline
 * (Ticket #121, item 2).
 *
 * **Guardrail (§8).** The record additionally carries a `guardrail` verdict —
 * the score compared against a cohort threshold (default
 * `DEFAULT_AUTONOMY_GUARDRAIL_THRESHOLD`, 0.99) — so reporting can present
 * autonomy as a pass/fail gate. `guardrail.met` is `null` when the score is
 * unmeasured.
 *
 * @param {object} input
 * @param {number} [input.hitlStops]
 * @param {number} [input.blockedEvents]  TERMINAL blocks only (gate retries excluded).
 * @param {number} [input.manualRescues]
 * @param {boolean|null} [input.landed]  Unattended-landing datum: `false` ⇒ an
 *   intervention; `true`/`null` ⇒ none.
 * @param {boolean} [input.observed=true]  False ⇒ score is `null` (unmeasured).
 * @param {number} [input.guardrailThreshold=DEFAULT_AUTONOMY_GUARDRAIL_THRESHOLD]
 * @returns {{
 *   score: number|null,
 *   hitlStops: number,
 *   blockedEvents: number,
 *   manualRescues: number,
 *   landed: boolean|null,
 *   guardrail: { threshold: number, met: boolean|null }
 * }}
 */
export function computeAutonomy(input = {}) {
  const hitlStops = nonNegInt(input.hitlStops);
  const blockedEvents = nonNegInt(input.blockedEvents);
  const manualRescues = nonNegInt(input.manualRescues);
  const landed = typeof input.landed === 'boolean' ? input.landed : null;
  const unattendedLandingFailure = landed === false ? 1 : 0;
  const interventions =
    hitlStops + blockedEvents + manualRescues + unattendedLandingFailure;
  const observed = input.observed !== false;
  const score = observed ? 1 / (1 + interventions) : null;
  return {
    score,
    hitlStops,
    blockedEvents,
    manualRescues,
    landed,
    guardrail: computeAutonomyGuardrail(score, input.guardrailThreshold),
  };
}

/**
 * Maintainability weights — same two-oracle shape as QUALITY_WEIGHTS.
 * The objective spine (static-analysis / linter signal) is weighted 0.7;
 * the LLM judge cross-check is weighted 0.3. When the judge did not run
 * (`maintainabilityJudgeScore == null`) the judge weight folds into the
 * spine, renormalizing `w_spine` to 1.0 — identical to QUALITY_WEIGHTS
 * semantics.
 */
export const MAINTAINABILITY_WEIGHTS = Object.freeze({
  spine: 0.7,
  judge: 0.3,
});

/**
 * Security weights — same two-oracle shape as QUALITY_WEIGHTS and
 * MAINTAINABILITY_WEIGHTS.
 */
export const SECURITY_WEIGHTS = Object.freeze({ spine: 0.7, judge: 0.3 });

/**
 * Maintainability — *how readable and low-complexity is the output?*
 * (value side, Story #36)
 *
 *   spineScore = objectiveMaintainabilityScore          ∈ [0, 1]
 *   score = w_spine·spineScore + w_judge·judgeScore     ∈ [0, 1]
 *     with w_judge folded into w_spine (→ 1.0) when judgeScore null.
 *
 * Sub-signals recorded for provenance:
 *   - lintWarnings          — count of linter warnings emitted
 *   - complexityScore       — normalised cyclomatic complexity score ∈ [0, 1]
 *   - maintainabilityIndex  — normalised MI score ∈ [0, 1]
 *
 * When `objectiveMaintainabilityScore` is not supplied but individual
 * sub-signals are, the spine is the average of the finite sub-signals.
 * When neither is supplied the spine defaults to 0.
 *
 * **Loud nulls (§8).** A missing spine (no `objectiveMaintainabilityScore`
 * and no usable sub-signals) or a missing judge cross-check previously
 * defaulted / nulled silently — indistinguishable from "measured and it
 * happens to be 0/null". Both paths now push a warning code onto `warnings`
 * so the report can surface an operator-visible marker instead of a silent
 * `n/a`.
 *
 * @param {object} input
 * @param {number|null} [input.objectiveMaintainabilityScore]  Pre-computed
 *   spine in [0, 1], or null to derive from sub-signals.
 * @param {number|null} [input.maintainabilityJudgeScore]  LLM judge cross-
 *   check in [0, 1], or null when the judge did not run.
 * @param {number} [input.lintWarnings]
 * @param {number|null} [input.complexityScore]
 * @param {number|null} [input.maintainabilityIndex]
 * @returns {{
 *   score: number,
 *   lintWarnings: number,
 *   complexityScore: number|null,
 *   maintainabilityIndex: number|null,
 *   maintainabilityJudgeScore: number|null,
 *   warnings: string[]
 * }}
 */
export function computeMaintainability(input = {}) {
  // UNMATERIALIZED delivery (`measured: false`): the empty seed tree has no
  // code to analyse, so score NULL (excluded from the differential) rather than
  // a conservative 0 that would drag the mandrel arm down for a run that never
  // landed. Same rationale as computeQuality's `measured` path.
  if (input.measured === false) {
    return {
      score: null,
      lintWarnings: 0,
      complexityScore: null,
      maintainabilityIndex: null,
      maintainabilityJudgeScore: null,
      warnings: [],
      guardrail: computeGuardrail(
        null,
        input.guardrailThreshold,
        DEFAULT_MAINTAINABILITY_GUARDRAIL_THRESHOLD,
      ),
    };
  }
  const lintWarnings = nonNegInt(input.lintWarnings);
  const complexityScore =
    typeof input.complexityScore === 'number' &&
    Number.isFinite(input.complexityScore)
      ? clamp(input.complexityScore)
      : null;
  const maintainabilityIndex =
    typeof input.maintainabilityIndex === 'number' &&
    Number.isFinite(input.maintainabilityIndex)
      ? clamp(input.maintainabilityIndex)
      : null;

  const warnings = [];

  let spineScore;
  if (
    typeof input.objectiveMaintainabilityScore === 'number' &&
    Number.isFinite(input.objectiveMaintainabilityScore)
  ) {
    spineScore = clamp(input.objectiveMaintainabilityScore);
  } else {
    // Derive from sub-signals when the pre-computed spine is absent.
    const subs = [complexityScore, maintainabilityIndex].filter(
      (v) => v !== null,
    );
    if (subs.length > 0) {
      spineScore = subs.reduce((a, b) => a + b, 0) / subs.length;
    } else {
      spineScore = 0;
      warnings.push('maintainability-signal-absent');
    }
  }

  const judgeRaw = input.maintainabilityJudgeScore;
  const judgePresent =
    typeof judgeRaw === 'number' && Number.isFinite(judgeRaw);
  const maintainabilityJudgeScore = judgePresent ? clamp(judgeRaw) : null;
  if (!judgePresent) warnings.push('maintainability-judge-absent');

  let score;
  if (maintainabilityJudgeScore === null) {
    score = spineScore;
  } else {
    score =
      MAINTAINABILITY_WEIGHTS.spine * spineScore +
      MAINTAINABILITY_WEIGHTS.judge * maintainabilityJudgeScore;
  }

  const finalScore = clamp(score);
  return {
    score: finalScore,
    lintWarnings,
    complexityScore,
    maintainabilityIndex,
    maintainabilityJudgeScore,
    warnings,
    guardrail: computeGuardrail(
      finalScore,
      input.guardrailThreshold,
      DEFAULT_MAINTAINABILITY_GUARDRAIL_THRESHOLD,
    ),
  };
}

/**
 * Security — *how free of vulnerabilities is the output?* (value side,
 * Story #36)
 *
 *   spineScore = objectiveSecurityScore                 ∈ [0, 1]
 *   score = w_spine·spineScore + w_judge·judgeScore     ∈ [0, 1]
 *     with w_judge folded into w_spine (→ 1.0) when judgeScore null.
 *
 * Sub-signals recorded for provenance:
 *   - criticalFindings  — count of critical-severity findings from scanning
 *   - highFindings      — count of high-severity findings
 *   - secretsDetected   — boolean, true iff a secret was detected in output
 *
 * When `objectiveSecurityScore` is not supplied it defaults to 0 so that a
 * run with no scan data is conservatively scored lowest.
 *
 * **Loud nulls (§8).** A missing scan (`objectiveSecurityScore` absent) or a
 * missing judge cross-check previously defaulted / nulled silently —
 * indistinguishable from "scanned, genuinely 0" or "judge ran and abstained".
 * Both paths now push a warning code onto `warnings` so the report surfaces
 * an operator-visible marker instead of a silent `n/a`.
 *
 * @param {object} input
 * @param {number|null} [input.objectiveSecurityScore]  Pre-computed spine in
 *   [0, 1], or null/absent to use 0.
 * @param {number|null} [input.securityJudgeScore]  LLM judge cross-check in
 *   [0, 1], or null when the judge did not run.
 * @param {number} [input.criticalFindings]
 * @param {number} [input.highFindings]
 * @param {boolean} [input.secretsDetected]
 * @returns {{
 *   score: number,
 *   criticalFindings: number,
 *   highFindings: number,
 *   secretsDetected: boolean,
 *   securityJudgeScore: number|null,
 *   warnings: string[]
 * }}
 */
export function computeSecurity(input = {}) {
  // UNMATERIALIZED delivery (`measured: false`): no delivered code to scan, so
  // score NULL (excluded from the differential) rather than a 0 that would
  // penalize the mandrel arm for a run that never landed. See computeQuality.
  if (input.measured === false) {
    return {
      score: null,
      criticalFindings: 0,
      highFindings: 0,
      secretsDetected: false,
      securityJudgeScore: null,
      warnings: [],
      guardrail: computeGuardrail(
        null,
        input.guardrailThreshold,
        DEFAULT_SECURITY_GUARDRAIL_THRESHOLD,
      ),
    };
  }
  const criticalFindings = nonNegInt(input.criticalFindings);
  const highFindings = nonNegInt(input.highFindings);
  const secretsDetected = input.secretsDetected === true;

  const warnings = [];

  const objectiveScorePresent =
    typeof input.objectiveSecurityScore === 'number' &&
    Number.isFinite(input.objectiveSecurityScore);
  const spineScore = objectiveScorePresent
    ? clamp(input.objectiveSecurityScore)
    : 0;
  if (!objectiveScorePresent) warnings.push('security-signal-absent');

  const judgeRaw = input.securityJudgeScore;
  const judgePresent =
    typeof judgeRaw === 'number' && Number.isFinite(judgeRaw);
  const securityJudgeScore = judgePresent ? clamp(judgeRaw) : null;
  if (!judgePresent) warnings.push('security-judge-absent');

  let score;
  if (securityJudgeScore === null) {
    score = spineScore;
  } else {
    score =
      SECURITY_WEIGHTS.spine * spineScore +
      SECURITY_WEIGHTS.judge * securityJudgeScore;
  }

  const finalScore = clamp(score);
  return {
    score: finalScore,
    criticalFindings,
    highFindings,
    secretsDetected,
    securityJudgeScore,
    warnings,
    guardrail: computeGuardrail(
      finalScore,
      input.guardrailThreshold,
      DEFAULT_SECURITY_GUARDRAIL_THRESHOLD,
    ),
  };
}

/**
 * Efficiency — *what did it cost absolutely?* (cost side)
 *
 * A vector, never collapsed to a scalar: wall-clock, tokens, dispatches, plus
 * the input/output token split and an optional USD cost. Tokens and USD come
 * ONLY from the `claude -p` envelope; timings/dispatches from lifecycle.ndjson.
 *
 *   wallClockMs = run end − run start
 *   totalTokens = Σ (inputTokens + outputTokens) over the usage envelope
 *   dispatches  = count of Story sub-agent launches
 *   costUsd     = total USD from the envelope when reported, else null
 *
 * `totalTokens` is the TRUE, sub-agent-inclusive figure (from `modelUsage`);
 * `reportedTokens` preserves the parent-session-only figure, and the
 * input/cacheRead/cacheWrite/output kind split is persisted so scoring never
 * equates a cache read with an output token (Ticket #122, item 1).
 * `gateRetries` (self-recovered close-validate churn) is reported here as a
 * cost signal rather than an autonomy penalty (Ticket #121, item 2).
 *
 * @param {object} input
 * @param {number} input.wallClockMs
 * @param {number} input.totalTokens
 * @param {number} input.dispatches
 * @param {number} [input.reportedTokens]
 * @param {number} [input.inputTokens]
 * @param {number} [input.outputTokens]
 * @param {number} [input.cacheReadTokens]
 * @param {number} [input.cacheWriteTokens]
 * @param {number} [input.gateRetries]
 * @param {number|null} [input.costUsd]
 * @returns {{
 *   wallClockMs: number,
 *   totalTokens: number,
 *   reportedTokens: number,
 *   inputTokens: number,
 *   outputTokens: number,
 *   cacheReadTokens: number,
 *   cacheWriteTokens: number,
 *   dispatches: number,
 *   gateRetries: number,
 *   costUsd: number|null
 * }}
 */
export function computeEfficiency(input = {}) {
  const wallClockMs = Math.max(0, finiteOr(input.wallClockMs, 0));
  const totalTokens = nonNegInt(input.totalTokens);
  const inputTokens = nonNegInt(input.inputTokens);
  const outputTokens = nonNegInt(input.outputTokens);
  const cacheReadTokens = nonNegInt(input.cacheReadTokens);
  const cacheWriteTokens = nonNegInt(input.cacheWriteTokens);
  const dispatches = nonNegInt(input.dispatches);
  const gateRetries = nonNegInt(input.gateRetries);
  const costUsd =
    typeof input.costUsd === 'number' &&
    Number.isFinite(input.costUsd) &&
    input.costUsd >= 0
      ? input.costUsd
      : null;
  // `reportedTokens` (the parent-session-only figure) defaults to the true
  // `totalTokens` when the caller does not thread it, so a legacy caller that
  // only supplies one figure keeps reported == true (Ticket #122, item 1).
  const reportedTokens =
    typeof input.reportedTokens === 'number' &&
    Number.isFinite(input.reportedTokens) &&
    input.reportedTokens >= 0
      ? Math.trunc(input.reportedTokens)
      : totalTokens;
  return {
    wallClockMs,
    totalTokens,
    reportedTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    dispatches,
    gateRetries,
    costUsd,
  };
}

/**
 * Overhead ratio — *ceremony tax vs. shippable output?* (cost side)
 *
 *   tokenRatio = ceremonyTokens / codegenTokens                      (≥ 0)
 *   timeRatio  = ceremonyMs    / codegenMs   (null when unavailable)
 *
 * `ceremonyTokens + codegenTokens` equals `efficiency.totalTokens` by
 * construction of the lifecycle phase split (see the normalize slice). When
 * `codegenTokens === 0` (no shippable codegen recorded — e.g. a run that never
 * reached a Story-implementation phase) the ratio is reported as 0 rather than
 * Infinity: the schema constrains it to a finite `minimum: 0`, and a run that
 * shipped nothing has no meaningful per-unit-output tax. The control arm has
 * effectively no ceremony, so its ratio sits near the floor.
 *
 * @param {object} input
 * @param {number} input.ceremonyTokens
 * @param {number} input.codegenTokens
 * @param {number|null} [input.ceremonyMs]
 * @param {number|null} [input.codegenMs]
 * @returns {{
 *   tokenRatio: number,
 *   timeRatio: number|null,
 *   ceremonyTokens: number,
 *   codegenTokens: number
 * }}
 */
export function computeOverheadRatio(input = {}) {
  const ceremonyTokens = nonNegInt(input.ceremonyTokens);
  const codegenTokens = nonNegInt(input.codegenTokens);
  // A ratio with a zero denominator is UNMEASURED, not "zero overhead". A run
  // with no attributable codegen — e.g. the mandrel arm produced no lifecycle
  // ledger, so the token split collapsed everything into ceremony — yields
  // `null` here, NOT 0, so the value-add report excludes it instead of crediting
  // Mandrel with a flawless zero-overhead ratio it never demonstrated.
  const tokenRatio = codegenTokens > 0 ? ceremonyTokens / codegenTokens : null;

  const ceremonyMs = finiteOr(input.ceremonyMs, Number.NaN);
  const codegenMs = finiteOr(input.codegenMs, Number.NaN);
  let timeRatio = null;
  if (
    Number.isFinite(ceremonyMs) &&
    Number.isFinite(codegenMs) &&
    codegenMs > 0
  ) {
    timeRatio = ceremonyMs / codegenMs;
  }

  return { tokenRatio, timeRatio, ceremonyTokens, codegenTokens };
}

/**
 * Compute all seven dimensions from one run's recorded inputs and return the
 * `dimensions` sub-object exactly as it appears on a scorecard
 * (`bench/schemas/scorecard.schema.json#/properties/dimensions`).
 *
 * The caller (the normalize slice) assembles the rest of the scorecard
 * (`runId`, `model`, `env`, `rawRefs`, …) around this object.
 *
 * @param {object} run  The per-run inputs. Fields are grouped by dimension
 *   but passed flat for the convenience of the normalize slice, which already
 *   holds them all.
 * @param {'mandrel'|'control'} [run.arm]  Drives the planning-fidelity null.
 * @returns {{
 *   quality: ReturnType<typeof computeQuality>,
 *   planningFidelity: ReturnType<typeof computePlanningFidelity>,
 *   autonomy: ReturnType<typeof computeAutonomy>,
 *   maintainability: ReturnType<typeof computeMaintainability>,
 *   security: ReturnType<typeof computeSecurity>,
 *   efficiency: ReturnType<typeof computeEfficiency>,
 *   overheadRatio: ReturnType<typeof computeOverheadRatio>
 * }}
 */
export function computeDimensions(run = {}) {
  return {
    quality: computeQuality(run.quality ?? run),
    planningFidelity: computePlanningFidelity({
      arm: run.arm,
      ...(run.planningFidelity ?? run),
    }),
    autonomy: computeAutonomy(run.autonomy ?? run),
    maintainability: computeMaintainability(run.maintainability ?? run),
    security: computeSecurity(run.security ?? run),
    efficiency: computeEfficiency(run.efficiency ?? run),
    overheadRatio: computeOverheadRatio(run.overheadRatio ?? run),
  };
}
