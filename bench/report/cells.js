// bench/report/cells.js
//
// Pure scenario-cell grouping for the Mandrel self-benchmark harness. Internal
// tooling only — never shipped in the distributed `.agents/` bundle, never run
// against the live repo.
//
// This is a NEUTRAL leaf: it groups a flat list of scorecards into
// difficulty-ordered scenario cells and carries the routing-mismatch and
// non-inferential (mixed-benchmark-version) flags. It imports NOTHING from the
// rendering surface (`render.js`) or any I/O module, so both the report renderer
// (`bench/report/render.js`) and the pure feedback-derivation core
// (`bench/feedback/derive.js`) can depend on the grouping without transitively
// loading the whole 1000+-line render module (M9). The routing-mismatch flag
// threshold lives here as the single source of truth so the derive step's
// finding summary + evidence stay in lock-step with the rendered report (H2).
//
// Determinism: pure functions, no I/O, no clock, no randomness.

/**
 * Difficulty ladder order (easy → hard) — the Epic #66 3-rung corpus.
 * `hello-world` is instrumentation only (floor/calibration framing, never a
 * value-delta rung); `story-scope` and `epic-scope` are the two value rungs,
 * each carrying its own trap-class axis. Mirrors the `difficulty` integers
 * declared on each scenario's `scenario.json`.
 */
export const DIFFICULTY_BY_SCENARIO = Object.freeze({
  'hello-world': 1,
  'story-scope': 3,
  'epic-scope': 5,
});

/**
 * Scenarios reported under the floor/calibration framing (Epic #66,
 * Story #76) rather than the value-delta tables: instrumentation rungs that
 * are deliberately too simple to show value (the overhead-floor estimate,
 * the cheap end of the monotonicity curve, and the CI canary) — never a
 * value rung in their own right. v1 ships one such rung.
 */
const FLOOR_CALIBRATION_SCENARIOS = new Set(['hello-world']);

/** Above this fraction of a cell's mandrel-arm records marked
 * `routingMismatch: true`, the mismatch is itself a scope-triage
 * calibration finding (target-architecture §3.3), not noise the harness
 * papers over. Single-sourced here so the report renderer AND the feedback
 * derive step read the identical threshold (H2).
 */
export const MISMATCH_RATE_FLAG_THRESHOLD = 0.25;

/**
 * Group a flat list of scorecards into difficulty-ordered scenario cells, each
 * carrying the Mandrel and control arms separately. Scenarios are ordered by
 * the difficulty ladder; an unknown scenario sorts last (and is still
 * rendered, so an out-of-ladder scenario is never silently dropped).
 *
 * Routing contract enforcement (Epic #66, Story #76): mandrel-arm records
 * carrying `routingMismatch: true` (an OBSERVED routing that diverges from
 * the scenario's DECLARED `routing` contract) are excluded from
 * `mandrelRuns` — the pool the differential/noise-band computation reads —
 * and instead surfaced via `mismatchedRuns` / `mismatchRate` / `mismatchFlag`
 * so a reader sees the deficit rather than a silently thinned pool.
 *
 * Non-inferential benchmark-version mixing (D-014, Story #87): a cell whose
 * records span MORE THAN ONE `benchmarkVersion` is NOT poolable — the harness
 * itself changed between those records, so a noise-band over them would
 * silently confound a benchmark change with a framework/model signal. Such a
 * cell is flagged `nonInferential: true`, its pooled arms are emptied (so NO
 * noise-band forms downstream — the "no band at the grouping seam" contract),
 * and the raw records are held on `nonInferentialRuns` so the report can still
 * count and label them. This is the render-time enforcement of the cohort
 * triple; `cohortKey()` in persist.js is its persistence-time counterpart. A
 * single benchmark version (the normal case) leaves the pool untouched.
 *
 * @param {Array<object>} scorecards
 * @returns {Array<{
 *   scenario: string,
 *   difficulty: number,
 *   mandrelRuns: Array<object>,
 *   controlRuns: Array<object>,
 *   mismatchedRuns: Array<object>,
 *   mismatchRate: number,
 *   mismatchFlag: boolean,
 *   floorCalibration: boolean,
 *   benchmarkVersions: string[],
 *   nonInferential: boolean,
 *   nonInferentialRuns: Array<object>
 * }>}
 */
export function groupCells(scorecards) {
  if (!Array.isArray(scorecards)) {
    throw new TypeError('groupCells: scorecards must be an array');
  }
  const byScenario = new Map();
  for (const sc of scorecards) {
    const scenario = sc?.scenario;
    if (typeof scenario !== 'string') continue;
    if (!byScenario.has(scenario)) {
      byScenario.set(scenario, {
        mandrelRuns: [],
        controlRuns: [],
        mismatchedRuns: [],
        benchmarkVersions: new Set(),
      });
    }
    const cell = byScenario.get(scenario);
    if (
      typeof sc.benchmarkVersion === 'string' &&
      sc.benchmarkVersion.length > 0
    ) {
      cell.benchmarkVersions.add(sc.benchmarkVersion);
    }
    if (sc.arm === 'mandrel') {
      if (sc.routingMismatch === true) cell.mismatchedRuns.push(sc);
      else cell.mandrelRuns.push(sc);
    } else if (sc.arm === 'control') {
      cell.controlRuns.push(sc);
    }
  }

  const cells = [];
  for (const [scenario, arms] of byScenario) {
    const benchmarkVersions = [...arms.benchmarkVersions].sort();
    // A cell that mixes >1 benchmark version is non-inferential: the harness
    // itself changed between those records, so they must never pool into one
    // band. An undetermined version (absent on every record) is not a mix.
    const nonInferential = benchmarkVersions.length > 1;
    const nonInferentialRuns = nonInferential
      ? [...arms.mandrelRuns, ...arms.mismatchedRuns, ...arms.controlRuns]
      : [];
    const totalMandrel = arms.mandrelRuns.length + arms.mismatchedRuns.length;
    const mismatchRate =
      !nonInferential && totalMandrel > 0
        ? arms.mismatchedRuns.length / totalMandrel
        : 0;
    cells.push({
      scenario,
      difficulty: DIFFICULTY_BY_SCENARIO[scenario] ?? Number.POSITIVE_INFINITY,
      // Suppress the pool when non-inferential so NO noise-band forms at the
      // grouping seam; otherwise pass the arms through unchanged.
      mandrelRuns: nonInferential ? [] : arms.mandrelRuns,
      controlRuns: nonInferential ? [] : arms.controlRuns,
      mismatchedRuns: nonInferential ? [] : arms.mismatchedRuns,
      mismatchRate,
      mismatchFlag:
        !nonInferential && mismatchRate > MISMATCH_RATE_FLAG_THRESHOLD,
      floorCalibration: FLOOR_CALIBRATION_SCENARIOS.has(scenario),
      benchmarkVersions,
      nonInferential,
      nonInferentialRuns,
    });
  }
  cells.sort((a, b) => {
    if (a.difficulty !== b.difficulty) return a.difficulty - b.difficulty;
    return a.scenario.localeCompare(b.scenario);
  });
  return cells;
}
