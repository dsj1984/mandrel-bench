// bench/driver/arms.js
/**
 * Benchmark-arm registry for the Mandrel self-benchmark harness (Ticket #123).
 * Internal tooling only — never shipped in the distributed `.agents/` bundle,
 * never run against the live repo.
 *
 * The harness historically knew exactly two arms — `mandrel` and `control` —
 * and every module hardcoded that pair. Ticket #123 adds two OPT-IN variant
 * arms (additional cells within the same (model, frameworkVersion,
 * benchmarkVersion) cohort — D-014 identity unchanged):
 *
 *   - **`control-claudemd`** (arm 3): the IDENTICAL control path plus one
 *     static ~2KB `CLAUDE.md` (generic engineering conventions + security
 *     hygiene, no scenario-specific answers) seeded into the workspace.
 *     `(arm3 − control)` isolates the value of ANY static structure;
 *     `(mandrel − arm3)` is then the marginal value of orchestration.
 *   - **`mandrel-story-routed`** (arm 4): the full mandrel overlay/pipeline,
 *     but the plan-phase prompt overrides scope triage to route the task as
 *     ONE standalone Story (spec once, close-validate once, review once, one
 *     PR) instead of decomposing an Epic. This is the empirical Epic/Story
 *     merge A/B: the routing divergence from the scenario contract IS the
 *     treatment, so the routing-mismatch exclusion is made ARM-AWARE (the
 *     expected routing for this arm is `story`), not globally weakened.
 *   - **`mandrel-light`** (arm 5, Story #190): the full mandrel overlay, but a
 *     light-shaped scenario is delivered as ONE `/deliver-light` session
 *     straight from the scenario task prompt instead of the two-session
 *     `/plan` + `/deliver` pair. It exists to measure mandrel 2.13.0's
 *     single-session `/deliver-light` path — the biggest planned overhead
 *     lever — which no other arm invokes, so a `mandrel-light` cell is directly
 *     comparable to a `mandrel` cell on the same rung. It is a MANDREL-family
 *     arm (`isMandrelArm` true) for autonomy, per-arm bands, and
 *     materialization, and honours the scenario's declared routing (a light
 *     delivery is a single standalone Story), so it declares no routing
 *     override. Because `/deliver-light` escalates over-scope back to `/plan`,
 *     the cell records which path it actually took (light vs escalated) so an
 *     escalated cell is never counted as a light win — see
 *     `armDrivesDeliverLight` and bench/run.js's `deliveryPath` classification.
 *
 * Every variant maps onto exactly one BASE arm (`baseArm`), and all
 * pipeline-shape decisions (overlay vs bare clone, one session vs two-phase
 * plan/deliver, ledger discovery, materialization) key off the base arm so the
 * variants reuse the existing machinery rather than forking it.
 *
 * This module is a PURE LEAF (no imports, no I/O) so the driver, the run
 * orchestrator, and the collect/normalize slice can all share one definition.
 */

/** The two base arms every pipeline shape is defined for. */
export const BASE_ARMS = Object.freeze(['mandrel', 'control']);

/**
 * Every arm value a scorecard may carry. The two variants are OPT-IN via
 * `BENCH_ARMS`; the default arm set is unchanged (see `DEFAULT_ARM_SET`).
 */
export const KNOWN_ARMS = Object.freeze([
  'mandrel',
  'control',
  'control-claudemd',
  'mandrel-story-routed',
  'mandrel-light',
]);

/** The default arm set — unchanged by Ticket #123 (arms 3/4 are opt-in). */
export const DEFAULT_ARM_SET = Object.freeze(['mandrel', 'control']);

/**
 * Map any known arm onto its base arm — the pipeline shape it executes.
 * Throws on an unknown arm so a typo'd `BENCH_ARMS` entry fails fast instead
 * of silently running a mislabelled cell.
 *
 * @param {string} arm
 * @returns {'mandrel'|'control'}
 */
export function baseArm(arm) {
  switch (arm) {
    case 'mandrel':
    case 'mandrel-story-routed':
    case 'mandrel-light':
      return 'mandrel';
    case 'control':
    case 'control-claudemd':
      return 'control';
    default:
      throw new TypeError(
        `unknown benchmark arm ${JSON.stringify(arm)} — known arms: ${KNOWN_ARMS.join(', ')}`,
      );
  }
}

/**
 * Whether `arm` executes the mandrel pipeline shape (overlay + two-phase
 * plan/deliver + ledger discovery + materialization). False for unknown arms —
 * predicates never throw so telemetry gates degrade to the control shape
 * rather than aborting on a legacy/foreign record.
 *
 * @param {string} arm
 * @returns {boolean}
 */
export function isMandrelArm(arm) {
  return (
    arm === 'mandrel' ||
    arm === 'mandrel-story-routed' ||
    arm === 'mandrel-light'
  );
}

/**
 * Whether `arm` executes the control pipeline shape (bare clone, single
 * session, direct commits). False for unknown arms (see `isMandrelArm`).
 *
 * @param {string} arm
 * @returns {boolean}
 */
export function isControlArm(arm) {
  return arm === 'control' || arm === 'control-claudemd';
}

/**
 * The routing this arm FORCES regardless of the scenario contract, or null
 * when the arm honours the scenario's declared routing. For
 * `mandrel-story-routed` the expected routing is `'story'` by construction —
 * the forced routing IS the treatment — so the routing-mismatch comparison
 * downstream (bench/collect/normalize.js `resolveTelemetrySource`) compares
 * the observed verdict against THIS override instead of the scenario's
 * declared routing. Arm-aware, not globally weakened: an arm-4 run that
 * disobeys the override and routes as an Epic is still a mismatch (excluded —
 * the treatment failed to apply).
 *
 * @param {string} arm
 * @returns {'story'|null}
 */
export function routingOverrideForArm(arm) {
  return arm === 'mandrel-story-routed' ? 'story' : null;
}

/**
 * Whether this arm delivers a light-shaped scenario as ONE `/deliver-light`
 * session (arm 5, `mandrel-light`, Story #190) instead of the two-session
 * `/plan` + `/deliver` pair every other mandrel-base arm drives. True ONLY for
 * `mandrel-light`; false (and never throwing) for every other arm, so the
 * driver's session-shape branch and bench/run.js's `deliveryPath` classifier
 * both key off this one predicate rather than string-matching the arm inline.
 *
 * The arm declares NO routing override (`routingOverrideForArm` returns null
 * for it): a light delivery is a single standalone Story, which the
 * light-shaped scenarios already declare (`routing: 'story'`), so the arm
 * honours the scenario contract rather than forcing a routing.
 *
 * @param {string} arm
 * @returns {boolean}
 */
export function armDrivesDeliverLight(arm) {
  return arm === 'mandrel-light';
}

/**
 * Whether this arm's workspace is seeded with the static generic `CLAUDE.md`
 * fixture (arm 3 — see bench/driver/overlay.js `seedStaticClaudeMd`).
 *
 * @param {string} arm
 * @returns {boolean}
 */
export function armSeedsStaticClaudeMd(arm) {
  return arm === 'control-claudemd';
}

/**
 * Parse a `BENCH_ARMS` csv into a validated arm list. An unset / blank value
 * resolves to the (unchanged) default arm set; an unknown arm name throws so
 * the CLI fails fast BEFORE any sandbox is provisioned or cost is spent —
 * a mislabelled cell would silently corrupt the cohort otherwise. Duplicate
 * entries are preserved deliberately (the operator asked for them).
 *
 * @param {string|undefined|null} csv  Raw `BENCH_ARMS` env value.
 * @returns {string[]}
 */
export function parseBenchArms(csv) {
  if (csv == null || String(csv).trim() === '') return [...DEFAULT_ARM_SET];
  const arms = String(csv)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (arms.length === 0) return [...DEFAULT_ARM_SET];
  for (const arm of arms) baseArm(arm); // throws on an unknown arm
  return arms;
}
