// bench/score/plan-quality.js
//
// The intrinsic PLAN-QUALITY axis for the Mandrel self-benchmark harness
// (Epic #86, Story #95; D-019 attribution, docs/target-architecture.md §8).
// Internal tooling only — never shipped in the distributed `.agents/` bundle,
// never run against the live repo.
//
// This module scores the pre-delivery plan the mandrel arm's `/plan` session
// produced — the frozen snapshot `bench/run.js#snapshotPlanArtifacts` writes to
// `.raw/<run-stamp>/plan/` BETWEEN the two phase sessions (Epic #86, Story #94)
// — against the scenario's frozen spec, so a bad OUTCOME can be attributed to
// the PLAN phase versus the DELIVER phase rather than lumped into one opaque
// quality number. It is a MANDREL-ONLY axis: the control arm authors no plan,
// so its plan-quality is null, and — like planning-fidelity and autonomy — it
// is DELIBERATELY excluded from the Mandrel-vs-control differential
// (`SCALAR_DIMENSIONS` in bench/score/differential.js). Diffing it against a
// non-existent control plan was never a meaningful comparison.
//
// Three deterministic sub-inputs form the objective spine, each in [0, 1]:
//
//   1. coverage            — every FROZEN acceptance criterion (the scenario's
//                            `seed.acceptance`) is traceable to a Story AC in
//                            the plan snapshot (not merely mentioned in prose).
//   2. decompositionSanity — the Story count/sizing matches the scenario's
//                            MACHINE-READABLE routing contract
//                            (`scenario.json#storyCountContract`): epic-scope
//                            decomposes into 4-6 Stories; the story-routed
//                            rungs stay a single standalone Story.
//   3. constraintSurfacing — the security-baseline obligations the scenario's
//                            trap classes probe are SURFACED in the plan
//                            artifacts (the mandrel arm's security-baseline
//                            path is what a trap measures; surfacing the
//                            obligation in the plan is the value it adds).
//
// The composite folds a 0.7-weight objective spine with a 0.3-weight LLM-judge
// cross-check, folding the judge weight into the spine when the judge is null —
// the SAME two-oracle convention as `computeMaintainability` /
// `computeSecurity` in bench/score/dimensions.js.
//
// **Goodhart mitigation.** The standalone spine weight is low relative to the
// combined signal; the judge cross-checks substance the deterministic spine
// cannot see; and the ATTRIBUTION table always crosses the plan score with the
// delivered OUTCOME (and plan-adherence), so a plan that games the spine
// without a matching outcome surfaces as `plan-phase-gap`, never as a silent
// pass.
//
// Determinism: pure functions, no I/O, no clock, no randomness. The same
// inputs always yield the same object, so a persisted scorecard is
// reproducible and re-scorable from its plan snapshot.

/**
 * Plan-quality composite weights — the same two-oracle shape as
 * QUALITY_WEIGHTS / MAINTAINABILITY_WEIGHTS / SECURITY_WEIGHTS
 * (bench/score/dimensions.js). The deterministic spine is weighted 0.7; the
 * LLM-judge cross-check is weighted 0.3. When the judge did not run
 * (`judgeScore == null`) the judge weight folds into the spine, renormalizing
 * `w_spine` to 1.0.
 */
export const PLAN_QUALITY_WEIGHTS = Object.freeze({ spine: 0.7, judge: 0.3 });

/**
 * Fraction of a frozen criterion's significant tokens a single Story AC must
 * cover for that criterion to count as "traceable" to that AC. A criterion is
 * covered when SOME Story AC clears this overlap — traceability is to one AC,
 * not to the plan text as a whole.
 */
export const COVERAGE_MATCH_THRESHOLD = 0.5;

/**
 * The default threshold above which a plan-quality / outcome / plan-adherence
 * score is treated as "good" by the attribution table.
 */
export const ATTRIBUTION_THRESHOLD = 0.7;

/**
 * The four attribution classifications the decision table emits, crossing plan
 * quality × delivered outcome × plan-adherence.
 */
export const ATTRIBUTION_CLASSES = Object.freeze([
  'working-as-intended',
  'deliver-phase-gap',
  'plan-phase-gap',
  'model-compensating',
]);

/**
 * The security-baseline constraint vocabulary each trap class probes. A trap's
 * obligation is "surfaced" when ANY of its terms appears in the plan artifacts
 * — the mandrel arm's security-baseline path is exactly what the trap
 * measures, so naming the obligation in the plan (the Epic tech-spec sections
 * and the Story ACs) is the value the plan adds. These are matched against the
 * PLAN text, never the seed prompt (whose trap headroom is guarded separately
 * by `SECURITY_HINT_TERMS` in tests/bench/scenarios/scenario-defs.test.js).
 */
export const TRAP_CONSTRAINT_TERMS = Object.freeze({
  'plaintext-password': ['hash', 'bcrypt', 'scrypt', 'argon', 'pbkdf2', 'salt'],
  'token-generation': [
    'random',
    'randombytes',
    'crypto',
    'unpredictable',
    'uuid',
    'entropy',
  ],
  idor: [
    'ownership',
    'owner',
    'authorization',
    'per-user',
    'isolation',
    'access control',
  ],
  'pagination-bounds': [
    'pagination',
    'page size',
    'pagesize',
    'clamp',
    'upper limit',
    'maximum page',
  ],
  'cascade-delete': [
    'cascade',
    'orphan',
    'referential',
    'foreign key',
    'delete the tasks',
    'child rows',
  ],
  'session-invalidation': [
    'invalidate',
    'revoke',
    'verify the token',
    'signature',
    'tamper',
    'forge',
  ],
  'hardcoded-secret': [
    'environment variable',
    'process.env',
    'env var',
    'env-sourced',
    'not inlined',
    'do not inline',
    'signing key',
  ],
});

/**
 * Stopwords stripped before tokenizing acceptance text — high-frequency glue
 * words that carry no discriminating signal for coverage matching.
 */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'returns',
  'return',
  'that',
  'this',
  'when',
  'both',
  'only',
  'never',
  'its',
  'not',
  'every',
  'each',
  'all',
  'into',
  'from',
  'are',
  'was',
  'has',
  'have',
  'valid',
  'body',
]);

/**
 * Clamp a number into the closed interval [lo, hi]. Non-finite inputs collapse
 * to `lo`.
 *
 * @param {number} v
 * @param {number} [lo=0]
 * @param {number} [hi=1]
 * @returns {number}
 */
function clamp(v, lo = 0, hi = 1) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * The set of significant tokens in a piece of acceptance text: lower-cased
 * alphanumeric runs, keeping words of length ≥ 3 (which drops glue like "a",
 * "an", "of") plus any 3-digit run (so HTTP status codes 200/201/400/401/404/
 * 409 survive as strong matching signal), minus the stopword list.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function significantTokens(text) {
  const raw = String(text ?? '')
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  const out = new Set();
  for (const t of raw ?? []) {
    if (STOPWORDS.has(t)) continue;
    if (t.length >= 3 || /^\d{3}$/.test(t)) out.add(t);
  }
  return out;
}

/**
 * Coverage — is every FROZEN acceptance criterion traceable to a Story AC?
 *
 * For each frozen criterion, the best single Story AC is the one covering the
 * largest fraction of the criterion's significant tokens; the criterion is
 * COVERED when that fraction clears `COVERAGE_MATCH_THRESHOLD`. The score is
 * the fraction of frozen criteria that are covered. An empty frozen list has
 * nothing to trace and scores 1 (vacuously complete); a plan that authored no
 * Story ACs covers nothing and scores 0.
 *
 * @param {object} input
 * @param {string[]} input.frozenAcceptance  The scenario's `seed.acceptance`.
 * @param {string[]} input.storyAcceptance   Flat list of every Story AC string
 *   pulled from the plan snapshot's Story bodies.
 * @returns {{ score: number, total: number, covered: number, uncovered: number[] }}
 */
export function computeCoverage({
  frozenAcceptance = [],
  storyAcceptance = [],
} = {}) {
  const frozen = Array.isArray(frozenAcceptance) ? frozenAcceptance : [];
  const stories = Array.isArray(storyAcceptance) ? storyAcceptance : [];
  const total = frozen.length;
  if (total === 0) {
    return { score: 1, total: 0, covered: 0, uncovered: [] };
  }

  const storyTokenSets = stories.map((s) => significantTokens(s));
  const uncovered = [];
  let covered = 0;

  for (let i = 0; i < frozen.length; i += 1) {
    const want = significantTokens(frozen[i]);
    if (want.size === 0) {
      // A criterion with no significant tokens cannot be discriminated; treat
      // it as covered so it never drags the score on a degenerate string.
      covered += 1;
      continue;
    }
    let best = 0;
    for (const have of storyTokenSets) {
      let hits = 0;
      for (const tok of want) {
        if (have.has(tok)) hits += 1;
      }
      const frac = hits / want.size;
      if (frac > best) best = frac;
    }
    if (best >= COVERAGE_MATCH_THRESHOLD) covered += 1;
    else uncovered.push(i);
  }

  return { score: clamp(covered / total), total, covered, uncovered };
}

/**
 * Decomposition sanity — does the Story count match the scenario's
 * MACHINE-READABLE routing contract?
 *
 * A count inside `[minStories, maxStories]` scores 1. Outside the range the
 * score ramps down with the distance beyond the nearest bound, normalised by
 * `max(maxStories, 2)` so a single over/under-decomposition on a standalone
 * (1-Story) contract is a partial — not catastrophic — penalty. When no
 * contract is supplied the input is unmeasured and the score is null (the
 * caller folds a null sub-score out of the spine mean).
 *
 * @param {object} input
 * @param {{ mode?: string, minStories?: number, maxStories?: number }} [input.storyCountContract]
 * @param {number} input.plannedStoryCount  Stories the plan snapshot recorded.
 * @returns {{
 *   score: number|null,
 *   plannedStoryCount: number,
 *   minStories: number|null,
 *   maxStories: number|null,
 *   withinContract: boolean|null
 * }}
 */
export function computeDecompositionSanity({
  storyCountContract,
  plannedStoryCount,
} = {}) {
  const count =
    typeof plannedStoryCount === 'number' && Number.isFinite(plannedStoryCount)
      ? Math.max(0, Math.trunc(plannedStoryCount))
      : 0;

  const contract =
    storyCountContract && typeof storyCountContract === 'object'
      ? storyCountContract
      : null;
  if (
    !contract ||
    typeof contract.minStories !== 'number' ||
    typeof contract.maxStories !== 'number'
  ) {
    return {
      score: null,
      plannedStoryCount: count,
      minStories: null,
      maxStories: null,
      withinContract: null,
    };
  }

  const minStories = Math.max(0, Math.trunc(contract.minStories));
  const maxStories = Math.max(minStories, Math.trunc(contract.maxStories));
  const withinContract = count >= minStories && count <= maxStories;

  let score;
  if (withinContract) {
    score = 1;
  } else {
    const distance =
      count < minStories ? minStories - count : count - maxStories;
    const denom = Math.max(maxStories, 2);
    score = clamp(1 - distance / denom);
  }

  return {
    score,
    plannedStoryCount: count,
    minStories,
    maxStories,
    withinContract,
  };
}

/**
 * Build the constraint-surfacing obligations for a list of trap classes, using
 * the shared `TRAP_CONSTRAINT_TERMS` vocabulary. Unknown classes are skipped
 * (a trap class with no declared vocabulary carries no surfacing obligation).
 *
 * @param {Iterable<string>} trapClasses  Trap class names (e.g. from the
 *   scenario's `traps/<class>.js` module basenames).
 * @returns {Array<{ class: string, terms: string[] }>}
 */
export function obligationsForTrapClasses(trapClasses) {
  const out = [];
  for (const cls of trapClasses ?? []) {
    const terms = TRAP_CONSTRAINT_TERMS[cls];
    if (Array.isArray(terms) && terms.length > 0) {
      out.push({ class: cls, terms });
    }
  }
  return out;
}

/**
 * Constraint surfacing — are the security-baseline obligations the scenario's
 * traps probe present in the plan artifacts?
 *
 * An obligation is surfaced when ANY of its vocabulary terms appears
 * (case-insensitively) in the concatenated plan text. The score is the
 * fraction of obligations surfaced. A scenario with no trap obligations (e.g.
 * hello-world) has nothing to surface and scores 1.
 *
 * @param {object} input
 * @param {Array<{ class: string, terms: string[] }>} input.obligations
 * @param {string} input.planText  Concatenated plan artifact text (Epic body +
 *   Story bodies).
 * @returns {{ score: number, total: number, surfaced: number, missing: string[] }}
 */
export function computeConstraintSurfacing({
  obligations = [],
  planText = '',
} = {}) {
  const obs = Array.isArray(obligations) ? obligations : [];
  const total = obs.length;
  if (total === 0) {
    return { score: 1, total: 0, surfaced: 0, missing: [] };
  }
  const haystack = String(planText ?? '').toLowerCase();
  const missing = [];
  let surfaced = 0;
  for (const ob of obs) {
    const terms = Array.isArray(ob?.terms) ? ob.terms : [];
    const present = terms.some((t) =>
      haystack.includes(String(t).toLowerCase()),
    );
    if (present) surfaced += 1;
    else missing.push(ob?.class ?? 'unknown');
  }
  return { score: clamp(surfaced / total), total, surfaced, missing };
}

/**
 * Compute the intrinsic plan-quality axis for one run.
 *
 * **Mandrel-only.** The control arm authors no plan; when `arm === 'control'`
 * (or `planAuthored === false`) the whole block is null. Callers persist that
 * null and the differential table excludes the axis entirely, so plan-quality
 * never produces a Mandrel-vs-control delta row.
 *
 * The objective spine is the mean of the three sub-scores that are actually
 * measured (a null sub-score — e.g. decomposition sanity with no contract — is
 * folded OUT of the mean rather than counted as 0). The composite then folds
 * the 0.3-weight judge cross-check into the 0.7-weight spine, or renormalises
 * the spine to 1.0 when the judge is null — matching `computeMaintainability`.
 *
 * @param {object} input
 * @param {'mandrel'|'control'} [input.arm]
 * @param {boolean} [input.planAuthored]  Explicit override; defaults to
 *   `arm !== 'control'`.
 * @param {string[]} [input.frozenAcceptance]
 * @param {string[]} [input.storyAcceptance]
 * @param {{ mode?: string, minStories?: number, maxStories?: number }} [input.storyCountContract]
 * @param {number} [input.plannedStoryCount]
 * @param {Array<{ class: string, terms: string[] }>} [input.obligations]
 * @param {string} [input.planText]
 * @param {number|null} [input.judgeScore]  LLM-judge cross-check in [0,1], or
 *   null when the judge did not run.
 * @returns {{
 *   score: number,
 *   coverage: number,
 *   decompositionSanity: number|null,
 *   constraintSurfacing: number,
 *   judgeScore: number|null,
 *   plannedStoryCount: number,
 *   warnings: string[],
 *   detail: object
 * } | null}
 */
export function computePlanQuality(input = {}) {
  const planAuthored =
    typeof input.planAuthored === 'boolean'
      ? input.planAuthored
      : input.arm !== 'control';
  if (!planAuthored) return null;

  const warnings = [];

  const coverage = computeCoverage({
    frozenAcceptance: input.frozenAcceptance,
    storyAcceptance: input.storyAcceptance,
  });
  const decomposition = computeDecompositionSanity({
    storyCountContract: input.storyCountContract,
    plannedStoryCount: input.plannedStoryCount,
  });
  const constraint = computeConstraintSurfacing({
    obligations: input.obligations,
    planText: input.planText,
  });

  if (decomposition.score === null) {
    warnings.push('plan-quality-decomposition-contract-absent');
  }

  // The spine is the mean of the sub-scores that were actually measured; a
  // null sub-score (no contract) is folded out, never counted as 0.
  const subs = [coverage.score, decomposition.score, constraint.score].filter(
    (v) => typeof v === 'number' && Number.isFinite(v),
  );
  const spine =
    subs.length > 0 ? subs.reduce((a, b) => a + b, 0) / subs.length : 0;

  const judgeRaw = input.judgeScore;
  const judgePresent =
    typeof judgeRaw === 'number' && Number.isFinite(judgeRaw);
  const judgeScore = judgePresent ? clamp(judgeRaw) : null;
  if (!judgePresent) warnings.push('plan-quality-judge-absent');

  let score;
  if (judgeScore === null) {
    score = spine;
  } else {
    score =
      PLAN_QUALITY_WEIGHTS.spine * spine +
      PLAN_QUALITY_WEIGHTS.judge * judgeScore;
  }

  return {
    score: clamp(score),
    coverage: coverage.score,
    decompositionSanity: decomposition.score,
    constraintSurfacing: constraint.score,
    judgeScore,
    plannedStoryCount: decomposition.plannedStoryCount,
    warnings,
    detail: { coverage, decomposition, constraint, spine },
  };
}

/**
 * The attribution decision table (D-019, §3.4) — cross the intrinsic PLAN
 * quality with the delivered OUTCOME and plan-adherence so a bad outcome is
 * attributed to the phase that caused it rather than lumped into one number.
 *
 * Crossing all three inputs is the Goodhart backstop: a plan that games the
 * spine cannot classify as `working-as-intended` without a matching outcome.
 *
 *   outcome GOOD:
 *     plan GOOD  → working-as-intended  (plan and delivery both landed)
 *     plan WEAK  → model-compensating   (good outcome despite a weak plan)
 *   outcome WEAK:
 *     plan GOOD, adhered      → plan-phase-gap   (followed a good-looking plan
 *                                                 yet still failed — the plan
 *                                                 missed something)
 *     plan GOOD, NOT adhered  → deliver-phase-gap (diverged from a good plan —
 *                                                  delivery is at fault)
 *     plan WEAK               → plan-phase-gap    (a weak plan produced a weak
 *                                                  outcome)
 *
 * When plan-adherence is unmeasured (null), a weak-outcome / good-plan run is
 * attributed to `plan-phase-gap` (we cannot blame delivery for diverging when
 * divergence was never observed).
 *
 * @param {object} input
 * @param {number|null} input.planQualityScore   `planQuality.score`.
 * @param {number|null} input.outcomeScore        Delivered outcome — the frozen
 *   `dimensions.quality.score` (optionally min'd with the trap clean-rate by
 *   the caller).
 * @param {number|null} [input.planAdherenceScore] `dimensions.planningFidelity.score`.
 * @param {object} [input.thresholds]
 * @param {number} [input.thresholds.plan=ATTRIBUTION_THRESHOLD]
 * @param {number} [input.thresholds.outcome=ATTRIBUTION_THRESHOLD]
 * @param {number} [input.thresholds.adherence=ATTRIBUTION_THRESHOLD]
 * @returns {{
 *   classification: 'working-as-intended'|'deliver-phase-gap'|'plan-phase-gap'|'model-compensating'|null,
 *   planGood: boolean|null,
 *   outcomeGood: boolean|null,
 *   adhered: boolean|null
 * }}
 */
export function computeAttribution({
  planQualityScore,
  outcomeScore,
  planAdherenceScore,
  thresholds = {},
} = {}) {
  const planT = clamp(
    typeof thresholds.plan === 'number'
      ? thresholds.plan
      : ATTRIBUTION_THRESHOLD,
  );
  const outcomeT = clamp(
    typeof thresholds.outcome === 'number'
      ? thresholds.outcome
      : ATTRIBUTION_THRESHOLD,
  );
  const adherenceT = clamp(
    typeof thresholds.adherence === 'number'
      ? thresholds.adherence
      : ATTRIBUTION_THRESHOLD,
  );

  const finite = (v) => typeof v === 'number' && Number.isFinite(v);

  // Plan-quality and outcome are both required to attribute; without them the
  // table cannot render a verdict (e.g. the control arm, which has no plan).
  if (!finite(planQualityScore) || !finite(outcomeScore)) {
    return {
      classification: null,
      planGood: finite(planQualityScore) ? planQualityScore >= planT : null,
      outcomeGood: finite(outcomeScore) ? outcomeScore >= outcomeT : null,
      adhered: finite(planAdherenceScore)
        ? planAdherenceScore >= adherenceT
        : null,
    };
  }

  const planGood = planQualityScore >= planT;
  const outcomeGood = outcomeScore >= outcomeT;
  const adhered = finite(planAdherenceScore)
    ? planAdherenceScore >= adherenceT
    : null;

  let classification;
  if (outcomeGood) {
    classification = planGood ? 'working-as-intended' : 'model-compensating';
  } else if (planGood) {
    // A weak outcome from a good-looking plan: blame delivery only when it
    // demonstrably diverged from the plan; otherwise the plan missed something.
    classification = adhered === false ? 'deliver-phase-gap' : 'plan-phase-gap';
  } else {
    classification = 'plan-phase-gap';
  }

  return { classification, planGood, outcomeGood, adhered };
}
