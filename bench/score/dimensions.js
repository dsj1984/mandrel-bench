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

  return {
    score: clamp(score),
    frozenSuitePassRate: passRate,
    frozenSuitePassed: passed,
    frozenSuiteTotal: total,
    acceptanceEvalScore,
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
 * @param {object} input
 * @param {'mandrel'|'control'} [input.arm]
 * @param {boolean} [input.planAuthored]   Explicit override; defaults to
 *   `arm !== 'control'`.
 * @param {number} [input.rePlanCount]
 * @param {number} [input.plannedStoryCount]
 * @param {number} [input.deliveredStoryCount]
 * @param {number} [input.fileFootprintDrift]  Precomputed Jaccard distance.
 * @param {Iterable<string>} [input.plannedPaths]  Used iff fileFootprintDrift
 *   is not supplied and actualPaths is present.
 * @param {Iterable<string>} [input.actualPaths]
 * @returns {{
 *   score: number|null,
 *   rePlanCount: number,
 *   plannedStoryCount: number,
 *   deliveredStoryCount: number,
 *   fileFootprintDrift: number
 * }}
 */
export function computePlanningFidelity(input = {}) {
  const rePlanCount = nonNegInt(input.rePlanCount);
  const plannedStoryCount = nonNegInt(input.plannedStoryCount);
  const deliveredStoryCount = nonNegInt(input.deliveredStoryCount);

  let drift;
  if (typeof input.fileFootprintDrift === 'number') {
    drift = clamp(finiteOr(input.fileFootprintDrift, 0));
  } else if (input.plannedPaths || input.actualPaths) {
    drift = fileFootprintDrift(input.plannedPaths, input.actualPaths);
  } else {
    drift = 0;
  }

  const planAuthored =
    typeof input.planAuthored === 'boolean'
      ? input.planAuthored
      : input.arm !== 'control';

  if (!planAuthored) {
    return {
      score: null,
      rePlanCount,
      plannedStoryCount,
      deliveredStoryCount,
      fileFootprintDrift: drift,
    };
  }

  const storyAccuracy =
    1 -
    Math.abs(plannedStoryCount - deliveredStoryCount) /
      Math.max(plannedStoryCount, deliveredStoryCount, 1);
  const rePlanPenalty = 1 / (1 + rePlanCount);
  const footprintAccuracy = 1 - drift;

  const score = (storyAccuracy + rePlanPenalty + footprintAccuracy) / 3;

  return {
    score: clamp(score),
    rePlanCount,
    plannedStoryCount,
    deliveredStoryCount,
    fileFootprintDrift: drift,
  };
}

/**
 * Autonomy — *how little human intervention?* (value side)
 *
 *   interventions = hitlStops + blockedEvents + manualRescues
 *   score = 1 / (1 + interventions)                                  ∈ (0, 1]
 *
 * `score === 1.0` ⇔ zero interventions (fully unattended).
 *
 * @param {object} input
 * @param {number} [input.hitlStops]
 * @param {number} [input.blockedEvents]
 * @param {number} [input.manualRescues]
 * @returns {{
 *   score: number,
 *   hitlStops: number,
 *   blockedEvents: number,
 *   manualRescues: number
 * }}
 */
export function computeAutonomy(input = {}) {
  const hitlStops = nonNegInt(input.hitlStops);
  const blockedEvents = nonNegInt(input.blockedEvents);
  const manualRescues = nonNegInt(input.manualRescues);
  const interventions = hitlStops + blockedEvents + manualRescues;
  return {
    score: 1 / (1 + interventions),
    hitlStops,
    blockedEvents,
    manualRescues,
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
 *   maintainabilityJudgeScore: number|null
 * }}
 */
export function computeMaintainability(input = {}) {
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
    spineScore =
      subs.length > 0 ? subs.reduce((a, b) => a + b, 0) / subs.length : 0;
  }

  const judgeRaw = input.maintainabilityJudgeScore;
  const judgePresent =
    typeof judgeRaw === 'number' && Number.isFinite(judgeRaw);
  const maintainabilityJudgeScore = judgePresent ? clamp(judgeRaw) : null;

  let score;
  if (maintainabilityJudgeScore === null) {
    score = spineScore;
  } else {
    score =
      MAINTAINABILITY_WEIGHTS.spine * spineScore +
      MAINTAINABILITY_WEIGHTS.judge * maintainabilityJudgeScore;
  }

  return {
    score: clamp(score),
    lintWarnings,
    complexityScore,
    maintainabilityIndex,
    maintainabilityJudgeScore,
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
 *   securityJudgeScore: number|null
 * }}
 */
export function computeSecurity(input = {}) {
  const criticalFindings = nonNegInt(input.criticalFindings);
  const highFindings = nonNegInt(input.highFindings);
  const secretsDetected = input.secretsDetected === true;

  const spineScore =
    typeof input.objectiveSecurityScore === 'number' &&
    Number.isFinite(input.objectiveSecurityScore)
      ? clamp(input.objectiveSecurityScore)
      : 0;

  const judgeRaw = input.securityJudgeScore;
  const judgePresent =
    typeof judgeRaw === 'number' && Number.isFinite(judgeRaw);
  const securityJudgeScore = judgePresent ? clamp(judgeRaw) : null;

  let score;
  if (securityJudgeScore === null) {
    score = spineScore;
  } else {
    score =
      SECURITY_WEIGHTS.spine * spineScore +
      SECURITY_WEIGHTS.judge * securityJudgeScore;
  }

  return {
    score: clamp(score),
    criticalFindings,
    highFindings,
    secretsDetected,
    securityJudgeScore,
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
 * @param {object} input
 * @param {number} input.wallClockMs
 * @param {number} input.totalTokens
 * @param {number} input.dispatches
 * @param {number} [input.inputTokens]
 * @param {number} [input.outputTokens]
 * @param {number|null} [input.costUsd]
 * @returns {{
 *   wallClockMs: number,
 *   totalTokens: number,
 *   inputTokens: number,
 *   outputTokens: number,
 *   dispatches: number,
 *   costUsd: number|null
 * }}
 */
export function computeEfficiency(input = {}) {
  const wallClockMs = Math.max(0, finiteOr(input.wallClockMs, 0));
  const totalTokens = nonNegInt(input.totalTokens);
  const inputTokens = nonNegInt(input.inputTokens);
  const outputTokens = nonNegInt(input.outputTokens);
  const dispatches = nonNegInt(input.dispatches);
  const costUsd =
    typeof input.costUsd === 'number' &&
    Number.isFinite(input.costUsd) &&
    input.costUsd >= 0
      ? input.costUsd
      : null;
  return {
    wallClockMs,
    totalTokens,
    inputTokens,
    outputTokens,
    dispatches,
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
  const tokenRatio = codegenTokens > 0 ? ceremonyTokens / codegenTokens : 0;

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
