// bench/report/render.js
//
// The operator-facing value-add report for the Mandrel self-benchmark harness
// (Epic #4211, Story #4218). Internal tooling only — never shipped in the
// distributed `.agents/` bundle, never run against the live repo.
//
// This module turns a corpus of per-run scorecards (one per scenario × arm ×
// run, conforming to bench/schemas/scorecard.schema.json) into a single
// Markdown report. It sits on top of the scoring slice
// (bench/score/differential.js) and the noise-band primitive
// (bench/metrics/variance.js); it adds NO new statistics of its own — every
// number it prints is sourced from those modules so the report is a faithful
// rendering of the measurement contract (bench/metrics/README.md), not a
// second, divergent interpretation of it.
//
// The report renders, in order:
//
//   1. A header stamped with the cohort (model, framework version, benchmark
//      version, env) so a reader only ever compares like-to-like.
//   2. Per-scenario, per-dimension DISTRIBUTIONS — each dimension reported as a
//      noise-band for BOTH arms (never a bare point estimate), plus the
//      Mandrel-vs-bare delta and its real/within-noise verdict against the
//      noise floor (README § "Real-delta rule").
//   3. The per-difficulty SCALING VIEW — Efficiency (totalTokens) and Overhead
//      ratio across the difficulty ladder for both arms, with any monotonicity
//      violation surfaced as an explicit calibration warning (never a silent
//      pass).
//   4. A clearly-delineated "Recommended improvements" section of actionable,
//      evidence-linked recommendations — including the overhead-floor estimate
//      and the ceremony-lite recommendation when a positive floor buys no
//      quality gain.
//
// Determinism: pure functions, no I/O, no clock, no randomness. The same corpus
// always renders byte-for-byte the same report, so a persisted report is
// reproducible and diffable across runs.

import { noiseBand } from '../metrics/variance.js';
import {
  chainArmSummary,
  computeContinuityDelta,
  degradationSlope,
  EFFICIENCY_COMPONENTS,
  SCALAR_DIMENSIONS,
  scoreCorpus,
} from '../score/differential.js';
import {
  ATTRIBUTION_CLASSES,
  computeAttribution,
} from '../score/plan-quality.js';
import { groupCells } from './cells.js';

/**
 * Human-readable labels for the dimensions and efficiency components, used in
 * report headings. Keyed by the same `name` the scoring slice emits.
 */
const DIMENSION_LABELS = Object.freeze({
  quality: 'Quality',
  planningFidelity: 'Planning fidelity',
  autonomy: 'Autonomy',
  maintainability: 'Maintainability',
  security: 'Security',
  overheadRatio: 'Overhead ratio (tokens)',
  'efficiency.wallClockMs': 'Efficiency · wall-clock (ms)',
  'efficiency.totalTokens': 'Efficiency · total tokens',
  'efficiency.dispatches': 'Efficiency · dispatches',
  'efficiency.costUsd': 'Efficiency · cost (USD)',
});

/**
 * The saturated value dimensions DEMOTED from headline mandrel-vs-control
 * deltas to pass/fail guardrail gates (Story #157). Both arms score at ceiling
 * on the current corpus, so a reported delta is noise dressed as measurement.
 * The headline scorecard carries no numeric delta for them — a guardrail
 * verdict stands in — and their numeric deltas move to the report appendix.
 * They stay demoted until a weak-model calibration probe demonstrates dynamic
 * range (out of scope here).
 */
const DEMOTED_GUARDRAIL_DIMENSIONS = Object.freeze([
  'quality',
  'maintainability',
  'security',
]);

/**
 * Round a finite number to a fixed precision for display, leaving non-finite /
 * null values as an em-dash. Never throws.
 *
 * @param {unknown} v
 * @param {number} [digits=3]
 * @returns {string}
 */
function fmt(v, digits = 3) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  // Avoid "-0" and trailing-zero noise while keeping integers clean.
  const rounded = Number(v.toFixed(digits));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/**
 * Render a noise-band as a compact `center [low, high]` cell, or an em-dash
 * when the band is null (the metric was null for that arm across all runs).
 *
 * @param {import('../metrics/variance.js').NoiseBand|null} band
 * @param {number} [digits=3]
 * @returns {string}
 */
function fmtBand(band, digits = 3) {
  if (!band) return '—';
  return `${fmt(band.center, digits)} [${fmt(band.low, digits)}, ${fmt(band.high, digits)}]`;
}

/**
 * Build a noise-band over one arm's per-run values for a given accessor, or
 * null when no finite values are present (so a dimension that is null for an
 * arm — planningFidelity on control — renders as an em-dash rather than
 * throwing). Mirrors the private helper in the scoring slice so the report's
 * per-arm distributions use the identical band the delta was computed from.
 *
 * @param {Array<object>} scorecards
 * @param {(d: object) => number|null} accessor
 * @param {'iqr'|'ci'} method
 * @returns {import('../metrics/variance.js').NoiseBand|null}
 */
function armBand(scorecards, accessor, method) {
  try {
    return noiseBand(
      scorecards.map((sc) => accessor(sc?.dimensions)),
      { method },
    );
  } catch {
    return null;
  }
}

// `groupCells` and the scenario-cell constants it needs
// (`DIFFICULTY_BY_SCENARIO`, `MISMATCH_RATE_FLAG_THRESHOLD`) now live in the
// neutral leaf `bench/report/cells.js` (M9) so the pure feedback-derivation
// core can depend on the grouping without transitively loading this whole
// rendering module. Re-exported here to keep this module's public surface
// (and every importer / test that reads `groupCells` from render.js) unchanged.
export { groupCells } from './cells.js';

/**
 * Derive the cohort stamp (model, framework version, benchmark version, env)
 * from the corpus. The
 * harness only ever compares like-to-like, so every scorecard in a corpus is
 * expected to share one cohort; if more than one distinct value is present for
 * a field, that is itself a finding — we record every distinct value and flag
 * the mix so the report never silently averages across cohorts.
 *
 * `benchmarkVersion` (D-014) JOINS the stamp alongside model / framework
 * version / env — the harness itself is a variable, so a corpus that mixes
 * benchmark versions is `mixed` exactly as one that mixes framework versions.
 *
 * @param {Array<object>} scorecards
 * @returns {{
 *   models: string[],
 *   frameworkVersions: string[],
 *   benchmarkVersions: string[],
 *   nodes: string[],
 *   oses: string[],
 *   mixed: boolean
 * }}
 */
export function deriveCohort(scorecards) {
  const models = new Set();
  const frameworkVersions = new Set();
  const benchmarkVersions = new Set();
  const nodes = new Set();
  const oses = new Set();
  for (const sc of scorecards) {
    if (sc?.model?.id) models.add(sc.model.id);
    if (sc?.frameworkVersion) frameworkVersions.add(sc.frameworkVersion);
    if (sc?.benchmarkVersion) benchmarkVersions.add(sc.benchmarkVersion);
    if (sc?.env?.node) nodes.add(sc.env.node);
    if (sc?.env?.os) oses.add(sc.env.os);
  }
  const mixed =
    models.size > 1 ||
    frameworkVersions.size > 1 ||
    benchmarkVersions.size > 1 ||
    nodes.size > 1 ||
    oses.size > 1;
  return {
    models: [...models],
    frameworkVersions: [...frameworkVersions],
    benchmarkVersions: [...benchmarkVersions],
    nodes: [...nodes],
    oses: [...oses],
    mixed,
  };
}

/**
 * Render the cohort-stamp header block.
 *
 * @param {ReturnType<typeof deriveCohort>} cohort
 * @param {'iqr'|'ci'} method
 * @returns {string}
 */
function renderHeader(cohort, method) {
  const lines = [
    '# Mandrel Self-Benchmark — Value-Add Report',
    '',
    '> Internal tooling (Epic #4211). Each dimension is reported as a',
    '> distribution across N runs, never a point estimate. A Mandrel-vs-bare',
    '> delta is only called **real** when it clears the larger of the two arms’',
    '> noise-band spreads (see `bench/metrics/README.md` § Real-delta rule).',
    '',
    '## Cohort',
    '',
    `- **Model:** ${cohort.models.length ? cohort.models.join(', ') : '—'}`,
    `- **Framework version:** ${cohort.frameworkVersions.length ? cohort.frameworkVersions.join(', ') : '—'}`,
    `- **Benchmark version:** ${cohort.benchmarkVersions?.length ? cohort.benchmarkVersions.join(', ') : '—'}`,
    `- **Node:** ${cohort.nodes.length ? cohort.nodes.join(', ') : '—'}`,
    `- **OS:** ${cohort.oses.length ? cohort.oses.join(', ') : '—'}`,
    `- **Band method:** ${method}`,
  ];
  if (cohort.mixed) {
    lines.push(
      '',
      '> ⚠️ **Mixed cohort:** this corpus mixes more than one',
      '> (model, framework version, benchmark version, env) — comparisons',
      '> below are NOT strictly like-to-like. Re-run within a single cohort',
      '> for a clean verdict.',
    );
  }
  return lines.join('\n');
}

/**
 * Build the per-arm distribution rows + the differential verdict for every
 * dimension of one scenario cell. Returns a structured object the renderer
 * formats into a table; separated so it is unit-testable independent of the
 * Markdown shape.
 *
 * @param {object} cell  A `groupCells` entry.
 * @param {ReturnType<typeof computeDifferential>} diff  The scenario's
 *   differential from `scoreCorpus`.
 * @param {'iqr'|'ci'} method
 * @returns {Array<{
 *   metric: string,
 *   label: string,
 *   mandrelBand: object|null,
 *   controlBand: object|null,
 *   delta: number|null,
 *   noiseFloor: number|null,
 *   verdict: 'real'|'within-noise'|'incomparable'
 * }>}
 */
export function dimensionRows(cell, diff, method) {
  const rows = [];
  for (const { name, accessor } of SCALAR_DIMENSIONS) {
    // Saturated dimensions are demoted to guardrail gates (Story #157): their
    // numeric delta never appears in the headline scorecard — see the guardrail
    // section and the appendix.
    if (DEMOTED_GUARDRAIL_DIMENSIONS.includes(name)) continue;
    const cmp = diff.dimensions[name];
    rows.push({
      metric: name,
      label: DIMENSION_LABELS[name] ?? name,
      mandrelBand: armBand(cell.mandrelRuns, accessor, method),
      controlBand: armBand(cell.controlRuns, accessor, method),
      delta: cmp?.delta ?? null,
      noiseFloor: cmp?.noiseFloor ?? null,
      verdict: cmp?.verdict ?? 'incomparable',
    });
  }
  for (const { name, accessor } of EFFICIENCY_COMPONENTS) {
    const key = `efficiency.${name}`;
    const cmp = diff.efficiency[name];
    rows.push({
      metric: key,
      label: DIMENSION_LABELS[key] ?? key,
      mandrelBand: armBand(cell.mandrelRuns, accessor, method),
      controlBand: armBand(cell.controlRuns, accessor, method),
      delta: cmp?.delta ?? null,
      noiseFloor: cmp?.noiseFloor ?? null,
      verdict: cmp?.verdict ?? 'incomparable',
    });
  }
  return rows;
}

/**
 * Build the SEED-PAIRED difference rows for one scenario cell's headline
 * (Story #157): the per-pair difference band for each NON-demoted scalar
 * dimension and every efficiency component, read straight off the paired block
 * the scoring slice computed. The demoted saturated dimensions are excluded
 * from the headline exactly as `dimensionRows` excludes them; their paired
 * deltas live in the appendix.
 *
 * @param {ReturnType<typeof import('../score/differential.js').computeDifferential>} diff
 * @returns {Array<{
 *   metric: string,
 *   label: string,
 *   diffBand: object|null,
 *   delta: number|null,
 *   n: number,
 *   verdict: 'real'|'within-noise'|'incomparable'
 * }>}
 */
export function pairedRows(diff) {
  const rows = [];
  const pick = (metric, cmp) => ({
    metric,
    label: DIMENSION_LABELS[metric] ?? metric,
    diffBand: cmp?.diffBand ?? null,
    delta: cmp?.delta ?? null,
    n: cmp?.n ?? 0,
    verdict: cmp?.verdict ?? 'incomparable',
  });
  for (const { name } of SCALAR_DIMENSIONS) {
    if (DEMOTED_GUARDRAIL_DIMENSIONS.includes(name)) continue;
    rows.push(pick(name, diff?.paired?.dimensions?.[name]));
  }
  for (const { name } of EFFICIENCY_COMPONENTS) {
    const key = `efficiency.${name}`;
    rows.push(pick(key, diff?.paired?.efficiency?.[name]));
  }
  return rows;
}

/**
 * Build the APPENDIX delta rows for one scenario cell — the pooled per-arm
 * bands AND paired difference for the DEMOTED saturated dimensions
 * (quality / maintainability / security). These carry no headline delta any
 * longer (they are guardrail gates); their numeric deltas are preserved here so
 * the signal is auditable without cluttering the headline scorecard
 * (Story #157).
 *
 * @param {object} cell
 * @param {ReturnType<typeof import('../score/differential.js').computeDifferential>} diff
 * @param {'iqr'|'ci'} method
 * @returns {Array<{
 *   metric: string,
 *   label: string,
 *   mandrelBand: object|null,
 *   controlBand: object|null,
 *   delta: number|null,
 *   noiseFloor: number|null,
 *   verdict: string,
 *   pairedDelta: number|null,
 *   pairedVerdict: string
 * }>}
 */
export function appendixDimensionRows(cell, diff, method) {
  const rows = [];
  for (const { name, accessor } of SCALAR_DIMENSIONS) {
    if (!DEMOTED_GUARDRAIL_DIMENSIONS.includes(name)) continue;
    const cmp = diff?.dimensions?.[name];
    const paired = diff?.paired?.dimensions?.[name];
    rows.push({
      metric: name,
      label: DIMENSION_LABELS[name] ?? name,
      mandrelBand: armBand(cell.mandrelRuns, accessor, method),
      controlBand: armBand(cell.controlRuns, accessor, method),
      delta: cmp?.delta ?? null,
      noiseFloor: cmp?.noiseFloor ?? null,
      verdict: cmp?.verdict ?? 'incomparable',
      pairedDelta: paired?.delta ?? null,
      pairedVerdict: paired?.verdict ?? 'incomparable',
    });
  }
  return rows;
}

/**
 * Build the SATURATED-dimension guardrail rows (Story #157): per scenario × per
 * demoted dimension, how many mandrel-arm and control-arm runs met / dropped
 * below / left unmeasured the guardrail threshold the score is gated on. Mirrors
 * `autonomyGuardrailRows`, but reports BOTH arms because these dimensions are
 * scored on both. A (scenario, dimension) with no measured guardrail on either
 * arm — the legacy corpora that predate the guardrail — is skipped rather than
 * rendered as an all-unmeasured row.
 *
 * @param {Array<object>} cells  `groupCells` entries.
 * @returns {Array<{
 *   scenario: string,
 *   dimension: string,
 *   threshold: number|null,
 *   mandrel: { met: number, dropped: number, unmeasured: number },
 *   control: { met: number, dropped: number, unmeasured: number }
 * }>}
 */
export function saturatedGuardrailRows(cells) {
  const rows = [];
  const stat = (runs, dim) => {
    let met = 0;
    let dropped = 0;
    let unmeasured = 0;
    let threshold = null;
    for (const sc of runs ?? []) {
      const g = sc?.dimensions?.[dim]?.guardrail;
      if (!g || g.met === null || g.met === undefined) {
        unmeasured += 1;
        continue;
      }
      threshold = typeof g.threshold === 'number' ? g.threshold : threshold;
      if (g.met === true) met += 1;
      else dropped += 1;
    }
    return { met, dropped, unmeasured, threshold };
  };
  for (const cell of cells) {
    for (const dim of DEMOTED_GUARDRAIL_DIMENSIONS) {
      const mandrel = stat(cell.mandrelRuns, dim);
      const control = stat(cell.controlRuns, dim);
      // Skip when neither arm had a single MEASURED guardrail verdict (legacy
      // corpora without a guardrail block, or a wholly-unmeasured cell).
      if (
        mandrel.met + mandrel.dropped === 0 &&
        control.met + control.dropped === 0
      ) {
        continue;
      }
      rows.push({
        scenario: cell.scenario,
        dimension: dim,
        threshold: mandrel.threshold ?? control.threshold ?? null,
        mandrel: {
          met: mandrel.met,
          dropped: mandrel.dropped,
          unmeasured: mandrel.unmeasured,
        },
        control: {
          met: control.met,
          dropped: control.dropped,
          unmeasured: control.unmeasured,
        },
      });
    }
  }
  return rows;
}

const VERDICT_BADGE = Object.freeze({
  real: '✅ real',
  'within-noise': '≈ within noise',
  incomparable: '— n/a',
});

/**
 * Render one scenario's distribution table (every dimension, both arms, delta
 * + verdict).
 *
 * @param {object} cell
 * @param {ReturnType<typeof computeDifferential>} diff
 * @param {'iqr'|'ci'} method
 * @returns {string}
 */
/**
 * Summarize how Mandrel routed this scenario's cells (Story #48), so a reader
 * understands WHY ledger-derived dimensions are present or n/a. The verdict is
 * the observed plan shape (Story #158): 'story' (a single standalone Story) or
 * 'multi-story' (a decomposition into N sibling Stories). Returns '' when no
 * run carries a routingVerdict (older scorecards / control-only).
 *
 * @param {Array<object>} mandrelRuns
 * @returns {string}
 */
function renderRoutingNote(mandrelRuns) {
  const verdicts = [
    ...new Set(
      (mandrelRuns ?? []).map((sc) => sc?.routingVerdict).filter(Boolean),
    ),
  ];
  if (verdicts.length === 0) return '';
  if (verdicts.length === 1 && verdicts[0] === 'story') {
    return '> **Mandrel routing: standalone Story** — planning-fidelity & autonomy recovered from the Story’s GitHub telemetry (no lifecycle ledger); overhead-ratio is **n/a** (unmeasurable on the standalone path).';
  }
  if (verdicts.length === 1 && verdicts[0] === 'multi-story') {
    return '> **Mandrel routing: multi-Story decomposition** — the plan opened N sibling Stories; value dimensions derived from the lifecycle ledger.';
  }
  return `> **Mandrel routing: mixed** across runs (${verdicts.join(', ')}).`;
}

/**
 * Render the per-cell routing-mismatch note (Epic #66, Story #76): surfaces
 * the count + rate of mandrel-arm records excluded from the noise-band pool
 * because their observed routing diverged from the scenario's declared
 * contract. Returns '' when the cell has no mismatched records.
 *
 * @param {object} cell  A `groupCells` entry.
 * @returns {string}
 */
export function renderMismatchNote(cell) {
  const n = cell.mismatchedRuns?.length ?? 0;
  if (n === 0) return '';
  const pct = fmt(cell.mismatchRate * 100, 1);
  if (cell.mismatchFlag) {
    return (
      `> ⚠️ **Routing mismatch: ${pct}% of mandrel runs** (${n} record(s)) — ` +
      'above the 25% scope-triage threshold. Excluded from the noise-band ' +
      'pool below; this is itself a calibration finding, not noise.'
    );
  }
  return `> **Routing mismatch: ${pct}% of mandrel runs** (${n} record(s)) — excluded from the noise-band pool below.`;
}

/**
 * Render the non-inferential note (D-014, Story #87) for a cell whose records
 * span more than one `benchmarkVersion`. Such a cell's pool is suppressed (no
 * noise-band), so instead of the usual distribution table it carries an
 * explicit "non-inferential" banner naming the mixed versions — the harness
 * itself changed across those records, so no like-to-like verdict is possible.
 * Returns '' for the normal (single-benchmark-version) cell.
 *
 * @param {object} cell  A `groupCells` entry.
 * @returns {string}
 */
export function renderNonInferentialNote(cell) {
  if (!cell.nonInferential) return '';
  const versions = (cell.benchmarkVersions ?? []).join(', ');
  const n = cell.nonInferentialRuns?.length ?? 0;
  return (
    `> ⛔ **Non-inferential corpus:** this cell mixes ${cell.benchmarkVersions?.length ?? 0} ` +
    `benchmark versions (${versions}) across ${n} record(s). The benchmark ` +
    'harness itself changed between them, so they are NOT pooled into a ' +
    'noise-band — a delta here would confound a benchmark-repo change with a ' +
    'framework/model signal (D-014). Re-run within a single benchmark version ' +
    'for an inferential verdict.'
  );
}

/**
 * Render the floor/calibration framing note (Epic #66, Story #76) for a
 * cell tagged `floorCalibration: true` — instrumentation rungs (hello-world)
 * that are deliberately too simple to show value. Returns '' otherwise.
 *
 * @param {object} cell  A `groupCells` entry.
 * @returns {string}
 */
export function renderFloorCalibrationNote(cell) {
  if (!cell.floorCalibration) return '';
  return (
    '> 🧭 **Floor/calibration rung** — instrumentation, not a value rung. ' +
    'Distributions below are the overhead-floor + monotonicity-curve ' +
    'calibration signal, not a value-delta claim.'
  );
}

/**
 * Collect the distinct trap-class ids present across a set of scorecards
 * (Epic #66, Story #74 trap block), sorted for a stable render order.
 *
 * @param {Array<object>} scorecards
 * @returns {string[]}
 */
export function collectTrapClasses(scorecards) {
  const classes = new Set();
  for (const sc of scorecards ?? []) {
    for (const entry of sc?.trap?.classes ?? []) {
      if (typeof entry?.class === 'string') classes.add(entry.class);
    }
  }
  return [...classes].sort();
}

/**
 * Summarize one arm's per-run values for a trap accessor as mean + spread +
 * worst-case (min) — the shape the trap axis reports (Epic #66, Story #79):
 * "distributions with mean, spread, and min per arm", deliberately reusing
 * the noise-band's `spread` rather than inventing a second variance
 * statistic. Returns null when no finite values are present.
 *
 * @param {Array<object>} scorecards
 * @param {(sc: object) => number|null} accessor  Applied to the SCORECARD
 *   directly (trap lives at the top level, not under `dimensions`).
 * @param {'iqr'|'ci'} method
 * @returns {{ mean: number, spread: number, min: number, n: number }|null}
 */
export function trapArmStat(scorecards, accessor, method) {
  const vals = (scorecards ?? [])
    .map(accessor)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (vals.length === 0) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const min = Math.min(...vals);
  let spread = 0;
  try {
    spread = noiseBand(vals, { method }).spread;
  } catch {
    spread = 0;
  }
  return { mean, spread, min, n: vals.length };
}

/**
 * Build the structured trap-axis rows for one scenario cell: one row per
 * declared trap class plus a final `cleanRate` row, each with the mandrel
 * and control arm's { mean, spread, min } stat. Returns `[]` when the cell
 * carries no trap data at all (a non-trap scenario, e.g. hello-world).
 *
 * Deliberately SEPARATE from `dimensionRows` — the trap axis is never folded
 * into the seven composite dimensions (schema + normalize.js contract).
 *
 * @param {object} cell  A `groupCells` entry.
 * @param {'iqr'|'ci'} method
 * @returns {Array<{
 *   metric: string,
 *   label: string,
 *   mandrel: { mean: number, spread: number, min: number, n: number }|null,
 *   control: { mean: number, spread: number, min: number, n: number }|null
 * }>}
 */
export function trapAxisRows(cell, method) {
  const allRuns = [...cell.mandrelRuns, ...cell.mismatchedRuns];
  const classes = collectTrapClasses([...allRuns, ...cell.controlRuns]);
  if (classes.length === 0) return [];
  const rows = classes.map((cls) => {
    const accessor = (sc) => {
      const entry = sc?.trap?.classes?.find((c) => c.class === cls);
      return typeof entry?.score === 'number' ? entry.score : null;
    };
    return {
      metric: `trap.${cls}`,
      label: cls,
      mandrel: trapArmStat(cell.mandrelRuns, accessor, method),
      control: trapArmStat(cell.controlRuns, accessor, method),
    };
  });
  const cleanRateAccessor = (sc) =>
    typeof sc?.trap?.cleanRate === 'number' ? sc.trap.cleanRate : null;
  rows.push({
    metric: 'trap.cleanRate',
    label: 'cleanRate (mean of classes)',
    mandrel: trapArmStat(cell.mandrelRuns, cleanRateAccessor, method),
    control: trapArmStat(cell.controlRuns, cleanRateAccessor, method),
  });
  return rows;
}

/**
 * Format one arm's trap-axis stat (`{ mean, spread, min, n }`, as returned by
 * `trapArmStat`) as a compact `mean (spread …, min …, n=…)` cell, or an
 * em-dash when the arm has no finite trap data for this cell. Shared by the
 * Markdown report (`renderTrapAxisSection`, below) and the HTML dashboard
 * (`bench/report/html.js`'s `renderTrapAxisSectionHtml`) so the two
 * renderers can never drift on rounding/digit precision (Epic #66 audit
 * remediation, M4).
 *
 * @param {{ mean: number, spread: number, min: number, n: number }|null} s
 * @param {number} [digits=3]
 * @returns {string}
 */
export function formatTrapStat(s, digits = 3) {
  return s
    ? `${fmt(s.mean, digits)} (spread ${fmt(s.spread, digits)}, min ${fmt(s.min, digits)}, n=${s.n})`
    : '—';
}

/**
 * Render one scenario's trap-axis section (Epic #66, Story #79): per-class
 * scores and `cleanRate` as mean/spread/min distributions per arm, in a
 * section clearly separate from the seven-dimension table. Returns '' when
 * the cell carries no trap data.
 *
 * @param {object} cell
 * @param {'iqr'|'ci'} method
 * @returns {string}
 */
export function renderTrapAxisSection(cell, method) {
  const rows = trapAxisRows(cell, method);
  if (rows.length === 0) return '';
  const fmtStat = formatTrapStat;
  const lines = [
    '#### Trap axis (differential — separate from the seven dimensions)',
    '',
    'Per-class adversarial trap-oracle verdicts the frozen suite is blind to.',
    'Higher is better (1 = clean, 0 = planted defect present).',
    '',
    '| Class | Mandrel | Control |',
    '| --- | --- | --- |',
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.label} | ${fmtStat(r.mandrel)} | ${fmtStat(r.control)} |`,
    );
  }
  return lines.join('\n');
}

/**
 * Build the structured second-touch CONTINUITY rows for one scenario cell
 * (Epic #86, Story #96): one row for the continuity OUTCOME delta and one for
 * the continuity COST delta, each with the mandrel/control band centers and the
 * mandrel-minus-control delta (with its real/within-noise verdict). Returns
 * `[]` when the cell carries no `touch2` data at all (a touch-1-only scenario,
 * e.g. hello-world).
 *
 * Deliberately SEPARATE from `dimensionRows` and `trapAxisRows` — the
 * continuity axis is the second-touch persistence measurement, never folded
 * into the seven composite dimensions or the touch-1 trap axis.
 *
 * @param {object} cell  A `groupCells` entry.
 * @param {'iqr'|'ci'} method
 * @returns {Array<{
 *   metric: string,
 *   label: string,
 *   mandrelCenter: number|null,
 *   controlCenter: number|null,
 *   delta: number|null,
 *   verdict: string
 * }>}
 */
export function continuityRows(cell, method) {
  const delta = computeContinuityDelta({
    mandrelRuns: cell.mandrelRuns,
    controlRuns: cell.controlRuns,
    method,
    scenario: cell.scenario,
  });
  if (!delta.present) return [];
  const labels = {
    'touch2.outcome': 'outcome (quality of the 2nd change; higher is better)',
    'touch2.cost': 'cost (USD for the 2nd change; lower is better)',
  };
  return Object.entries(delta.metrics).map(([metric, cmp]) => ({
    metric,
    label: labels[metric] ?? metric,
    mandrelCenter: cmp.mandrelCenter,
    controlCenter: cmp.controlCenter,
    delta: cmp.delta,
    verdict: cmp.verdict,
  }));
}

/**
 * Render one scenario's second-touch CONTINUITY section (Epic #86, Story #96):
 * the mandrel-vs-control delta of the second change's outcome and cost — the
 * persistence-thesis measurement (does inheriting Mandrel's artifacts make the
 * NEXT change cheaper and better than inheriting code alone?). Returns '' when
 * the cell carries no touch-2 data.
 *
 * @param {object} cell
 * @param {'iqr'|'ci'} method
 * @returns {string}
 */
export function renderContinuitySection(cell, method) {
  const rows = continuityRows(cell, method);
  if (rows.length === 0) return '';
  const lines = [
    '#### Continuity delta (the second touch — separate from the seven dimensions)',
    '',
    'Mandrel-vs-control delta of the FROZEN change request scored against the',
    'delivered tree (mandrel inherits its full pipeline output; control inherits',
    'delivered code only). Positive outcome delta / negative cost delta favour Mandrel.',
    '',
    '| Metric | Mandrel | Control | Δ (mandrel − control) | Verdict |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.label} | ${fmt(r.mandrelCenter, 3)} | ${fmt(r.controlCenter, 3)} | ${fmt(r.delta, 3)} | ${r.verdict} |`,
    );
  }
  return lines.join('\n');
}

/**
 * Collect every arm of a cell that carries at least one chain record
 * (issue #124, PR-D), in a stable render order: the two primary arms first,
 * then any variant arms (Ticket #123 `extraArms`) sorted by arm id. Arms with
 * no chain data are omitted, so a non-chain cell yields `[]` — the guard the
 * chain section's no-op guarantee hangs off.
 *
 * @param {object} cell  A `groupCells` entry.
 * @returns {Array<{ arm: string, runs: Array<object> }>}
 */
export function chainArms(cell) {
  const hasChain = (runs) =>
    (runs ?? []).some((sc) => Array.isArray(sc?.chain?.touches));
  const arms = [];
  if (hasChain(cell.mandrelRuns)) {
    arms.push({ arm: 'mandrel', runs: cell.mandrelRuns });
  }
  if (hasChain(cell.controlRuns)) {
    arms.push({ arm: 'control', runs: cell.controlRuns });
  }
  for (const arm of Object.keys(cell.extraArms ?? {}).sort()) {
    if (hasChain(cell.extraArms[arm])) {
      arms.push({ arm, runs: cell.extraArms[arm] });
    }
  }
  return arms;
}

/**
 * Per-arm, per-touch aggregation of one chain cell (issue #124, PR-D): for
 * every arm carrying chain records, one row per touch index with the mean
 * outcome / cost / regression rate (`regression.regressionRate`) / convention
 * clean-rate (`conventions.cleanRate`) across the arm's cells, plus the
 * materialized / landed / advanced counts. This is the per-touch LINE DATA
 * the report and dashboard render — nulls are excluded from each mean (an
 * unmeasured touch never averages as 0), and `n` counts the cells that
 * carried the touch at all.
 *
 * @param {object} cell  A `groupCells` entry.
 * @returns {Array<{
 *   arm: string,
 *   rows: Array<{
 *     touchIndex: number,
 *     n: number,
 *     outcome: number|null,
 *     cost: number|null,
 *     regressionRate: number|null,
 *     cleanRate: number|null,
 *     materialized: number,
 *     landed: number,
 *     advanced: number
 *   }>
 * }>}
 */
export function chainTouchRows(cell) {
  const meanOf = (arr) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  return chainArms(cell).map(({ arm, runs }) => {
    const byTouch = new Map();
    for (const sc of runs) {
      for (const t of sc?.chain?.touches ?? []) {
        const idx = t?.touchIndex;
        if (typeof idx !== 'number' || !Number.isFinite(idx)) continue;
        if (!byTouch.has(idx)) {
          byTouch.set(idx, {
            n: 0,
            outcomes: [],
            costs: [],
            regressionRates: [],
            cleanRates: [],
            materialized: 0,
            landed: 0,
            advanced: 0,
          });
        }
        const agg = byTouch.get(idx);
        agg.n += 1;
        if (typeof t.outcome === 'number' && Number.isFinite(t.outcome)) {
          agg.outcomes.push(t.outcome);
        }
        if (typeof t.cost === 'number' && Number.isFinite(t.cost)) {
          agg.costs.push(t.cost);
        }
        const rr = t?.regression?.regressionRate;
        if (typeof rr === 'number' && Number.isFinite(rr)) {
          agg.regressionRates.push(rr);
        }
        const cr = t?.conventions?.cleanRate;
        if (typeof cr === 'number' && Number.isFinite(cr)) {
          agg.cleanRates.push(cr);
        }
        if (t.materialized === true) agg.materialized += 1;
        if (t.landed === true) agg.landed += 1;
        if (t.advanced === true) agg.advanced += 1;
      }
    }
    const rows = [...byTouch.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([touchIndex, agg]) => ({
        touchIndex,
        n: agg.n,
        outcome: meanOf(agg.outcomes),
        cost: meanOf(agg.costs),
        regressionRate: meanOf(agg.regressionRates),
        cleanRate: meanOf(agg.cleanRates),
        materialized: agg.materialized,
        landed: agg.landed,
        advanced: agg.advanced,
      }));
    return { arm, rows };
  });
}

/**
 * Per-arm landed-change summary rows for one chain cell (issue #124, PR-D):
 * `chainArmSummary` (the differential-layer aggregation of PR-C's per-cell
 * `chain.landedCount` / `chain.costPerLandedChange`) evaluated for every arm
 * carrying chain records. Returns `[]` for a non-chain cell.
 *
 * @param {object} cell  A `groupCells` entry.
 * @param {'iqr'|'ci'} method
 * @returns {Array<{ arm: string, summary: object }>}
 */
export function chainSummaryRows(cell, method) {
  return chainArms(cell)
    .map(({ arm, runs }) => ({
      arm,
      summary: chainArmSummary(runs, { method }),
    }))
    .filter((r) => r.summary !== null);
}

/**
 * Render the seeded-gap annotation lines for a chain cell's degradation-slope
 * result: every touch whose baseline was seeded from an earlier tree than its
 * immediate predecessor (skip-forward fired) is named — the design's
 * "annotated on the result, not silently pooled" rule. Returns `''` when no
 * arm carries a gap.
 *
 * @param {ReturnType<typeof degradationSlope>} slope
 * @returns {string}
 */
export function renderSeededGapNote(slope) {
  const parts = [];
  for (const arm of ['mandrel', 'control']) {
    for (const gap of slope.seededGaps[arm] ?? []) {
      parts.push(
        `${arm}${gap.runId ? ` \`${gap.runId}\`` : ''}: touch ${gap.touchIndex} seeded from touch ${gap.seededFromTouch}`,
      );
    }
  }
  if (parts.length === 0) return '';
  return (
    '> ⚠️ **Seeded-from gaps (skip-forward fired):** the touch baselines are ' +
    'not strictly sequential in the runs below — the slope pools touch ' +
    `indices that share a baseline. ${parts.join('; ')}.`
  );
}

/**
 * Render one scenario's TOUCH-CHAIN section (issue #124, PR-D; design §4/§5):
 * the degradation-slope headline (mandrel slope − control slope under the
 * real-delta rule, band over per-cell OLS slopes), the per-touch outcome /
 * cost / regression-rate / convention line-data tables per arm, and the
 * landed-count + cost-per-landed-change summary. Returns '' when the cell
 * carries no chain data at all, so every non-chain cohort renders
 * byte-identical to the pre-chain report.
 *
 * @param {object} cell  A `groupCells` entry.
 * @param {'iqr'|'ci'} method
 * @returns {string}
 */
export function renderChainSection(cell, method) {
  const arms = chainArms(cell);
  if (arms.length === 0) return '';
  const slope = degradationSlope({
    mandrelRuns: cell.mandrelRuns,
    controlRuns: cell.controlRuns,
    method,
    scenario: cell.scenario,
  });
  const lines = [
    '#### Touch chain (degradation slope — separate from the seven dimensions)',
    '',
    'Five chained change requests over the frozen seed: per arm, every cell',
    'contributes ONE OLS slope of per-touch outcome (and cost) on touch index;',
    'the band forms over the per-cell slopes and the headline is mandrel slope −',
    'control slope under the real-delta rule. Mandrel’s thesis predicts a',
    'FLATTER slope: outcome slope closer to 0 (quality degrades less) and a',
    'smaller cost slope (each next change stays cheap). Null outcomes',
    '(unmaterialized touches) are excluded from the quality regression but their',
    'cost stays in the cost regression.',
    '',
    '| Metric | Mandrel | Control | Δ (M−C) | Noise floor | Verdict |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  const slopeLabels = {
    'chain.outcomeSlope':
      'Outcome slope (quality per touch; flatter is better)',
    'chain.costSlope': 'Cost slope (USD per touch; flatter is cheaper)',
  };
  for (const [metric, cmp] of Object.entries(slope.metrics)) {
    lines.push(
      `| ${slopeLabels[metric] ?? metric} | ${fmtBand(cmp.mandrelBand, 4)} | ${fmtBand(cmp.controlBand, 4)} | ${fmt(cmp.delta, 4)} | ${fmt(cmp.noiseFloor, 4)} | ${VERDICT_BADGE[cmp.verdict]} |`,
    );
  }
  const gapNote = renderSeededGapNote(slope);
  if (gapNote) lines.push('', gapNote);

  for (const { arm, rows } of chainTouchRows(cell)) {
    lines.push(
      '',
      `##### Per-touch line data — \`${arm}\``,
      '',
      '| Touch | n | Outcome | Cost (USD) | Regression rate | Convention cleanRate | Materialized | Landed | Advanced |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const r of rows) {
      lines.push(
        `| ${r.touchIndex} | ${r.n} | ${fmt(r.outcome, 3)} | ${fmt(r.cost, 4)} | ${fmt(r.regressionRate, 3)} | ${fmt(r.cleanRate, 3)} | ${r.materialized} | ${r.landed} | ${r.advanced} |`,
      );
    }
  }

  const summaryRows = chainSummaryRows(cell, method);
  if (summaryRows.length > 0) {
    lines.push(
      '',
      '##### Landed changes & cost per landed change',
      '',
      'Σ every touch’s cost (landed or not) ÷ landed count, per cell, then mean +',
      'band across the arm’s cells — unlanded spend stays in the numerator (the',
      'autonomy penalty in dollars). `landed:true` counts strictly-landed mandrel',
      'touches; the landed total also counts advanced control touches (landing is',
      'not a concept on the control arm).',
      '',
      '| Arm | Cells | Touches | Landed (total) | landed:true | Cost/landed (mean) | Band |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const { arm, summary } of summaryRows) {
      lines.push(
        `| \`${arm}\` | ${summary.cells} | ${summary.touchesTotal} | ${summary.landedCountTotal} | ${summary.landedTrueTotal} | ${fmt(summary.costPerLandedChange.mean, 4)} | ${fmtBand(summary.costPerLandedChange.band, 4)} |`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * Build the per-scenario autonomy-guardrail summary (Epic #66, Story #77):
 * autonomy is a mandrel-arm pass/fail GUARDRAIL against a cohort threshold,
 * never a mandrel-vs-control delta (see `differential.js` `SCALAR_DIMENSIONS`
 * comment). Counts, per scenario, how many mandrel-arm runs met / dropped
 * below / left the threshold unmeasured.
 *
 * @param {Array<object>} cells  `groupCells` entries.
 * @returns {Array<{
 *   scenario: string,
 *   n: number,
 *   met: number,
 *   dropped: number,
 *   unmeasured: number,
 *   threshold: number|null
 * }>}
 */
export function autonomyGuardrailRows(cells) {
  const rows = [];
  for (const cell of cells) {
    const runs = cell.mandrelRuns ?? [];
    if (runs.length === 0) continue;
    let met = 0;
    let dropped = 0;
    let unmeasured = 0;
    let threshold = null;
    for (const sc of runs) {
      const g = sc?.dimensions?.autonomy?.guardrail;
      if (!g || g.met === null || g.met === undefined) {
        unmeasured += 1;
        continue;
      }
      threshold = typeof g.threshold === 'number' ? g.threshold : threshold;
      if (g.met === true) met += 1;
      else dropped += 1;
    }
    rows.push({
      scenario: cell.scenario,
      n: runs.length,
      met,
      dropped,
      unmeasured,
      threshold,
    });
  }
  return rows;
}

/**
 * Render the autonomy-guardrail section from `autonomyGuardrailRows`.
 *
 * @param {Array<object>} cells
 * @returns {string}
 */
export function renderAutonomyGuardrailSection(cells) {
  const rows = autonomyGuardrailRows(cells);
  const lines = [
    '## Autonomy guardrail (mandrel arm)',
    '',
    'Autonomy is a pass/fail GUARDRAIL against a cohort threshold — never a',
    'mandrel-vs-control delta (Epic #66, Story #77): the bare control arm’s',
    'zero-intervention baseline is defined, not measured, so a delta against',
    'it was never a meaningful comparison. A drop below threshold is itself a',
    'finding.',
    '',
  ];
  if (rows.length === 0) {
    lines.push('No mandrel-arm runs to evaluate.');
    return lines.join('\n');
  }
  lines.push(
    '| Scenario | n | Met | Dropped | Unmeasured | Threshold |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  for (const r of rows) {
    lines.push(
      `| \`${r.scenario}\` | ${r.n} | ${r.met} | ${r.dropped} | ${r.unmeasured} | ${fmt(r.threshold, 2)} |`,
    );
  }
  const anyDropped = rows.some((r) => r.dropped > 0);
  lines.push(
    '',
    anyDropped
      ? '⚠️ One or more scenarios dropped below the guardrail threshold — see Recommended improvements.'
      : '✅ Every measured mandrel-arm run met the guardrail threshold.',
  );
  return lines.join('\n');
}

/**
 * Findings derived from the autonomy guardrail (Epic #66, Story #77): a
 * scenario with any dropped run surfaces as a `medium` finding, evidence-
 * linked to the drop count.
 *
 * @param {Array<object>} cells
 * @returns {Array<{ id: string, severity: string, title: string, evidence: string, action: string }>}
 */
export function autonomyGuardrailFindings(cells) {
  const findings = [];
  for (const row of autonomyGuardrailRows(cells)) {
    if (row.dropped === 0) continue;
    findings.push({
      id: `autonomy-guardrail-drop-${row.scenario}`,
      severity: 'medium',
      title: `Investigate the autonomy guardrail drop on \`${row.scenario}\``,
      evidence: `${row.dropped}/${row.n} mandrel-arm run(s) fell below the ${fmt(row.threshold, 2)} guardrail threshold.`,
      action:
        'A fully-unattended pipeline should clear the guardrail on every run. ' +
        'Trace the lifecycle for the dropped run(s) to find the HITL stop, ' +
        'agent::blocked transition, or manual rescue that fired.',
    });
  }
  return findings;
}

/**
 * Build the per-phase cost rows (D-019, Epic #86 Story #94): one row per
 * scenario whose mandrel-arm records carry a `phases[]` block, with the mean
 * `/plan` and `/deliver` USD cost across the cell's mandrel runs plus their
 * total. The control arm never carries `phases`, so it contributes nothing —
 * the per-phase cost view is mandrel-only by construction. Returns `[]` when no
 * cell has any phase data (older corpora / control-only).
 *
 * @param {Array<object>} cells  `groupCells` entries.
 * @returns {Array<{
 *   scenario: string,
 *   n: number,
 *   planCostUsd: number|null,
 *   deliverCostUsd: number|null,
 *   totalCostUsd: number|null
 * }>}
 */
export function phaseCostRows(cells) {
  const mean = (arr) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const rows = [];
  for (const cell of cells ?? []) {
    const runs = cell.mandrelRuns ?? [];
    const planVals = [];
    const deliverVals = [];
    for (const sc of runs) {
      for (const ph of sc?.phases ?? []) {
        if (typeof ph?.costUsd !== 'number' || !Number.isFinite(ph.costUsd)) {
          continue;
        }
        if (ph.phase === 'plan') planVals.push(ph.costUsd);
        else if (ph.phase === 'deliver') deliverVals.push(ph.costUsd);
      }
    }
    if (planVals.length === 0 && deliverVals.length === 0) continue;
    const planCostUsd = mean(planVals);
    const deliverCostUsd = mean(deliverVals);
    const totalCostUsd =
      planCostUsd === null && deliverCostUsd === null
        ? null
        : (planCostUsd ?? 0) + (deliverCostUsd ?? 0);
    rows.push({
      scenario: cell.scenario,
      n: runs.length,
      planCostUsd,
      deliverCostUsd,
      totalCostUsd,
    });
  }
  return rows;
}

/**
 * Render the per-phase cost section (D-019): a mandrel-only table of `/plan` vs
 * `/deliver` cost per scenario, so a reader sees which half of the pipeline the
 * cost went to. Returns '' when no cell carries phase data (so control-only /
 * legacy corpora render nothing).
 *
 * @param {Array<object>} cells
 * @returns {string}
 */
export function renderPhaseCostSection(cells) {
  const rows = phaseCostRows(cells);
  if (rows.length === 0) return '';
  const lines = [
    '## Per-phase cost (mandrel arm)',
    '',
    'The mandrel arm runs `/plan` and `/deliver` as two separate headless',
    'sessions (D-019), so cost is attributable to the planning half vs the',
    'delivery half. Mean USD cost per phase across the cell’s mandrel runs; the',
    'control arm is a single session and carries no per-phase split.',
    '',
    '| Scenario | n | Plan cost (USD) | Deliver cost (USD) | Total (USD) |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    lines.push(
      `| \`${r.scenario}\` | ${r.n} | ${fmt(r.planCostUsd, 4)} | ${fmt(r.deliverCostUsd, 4)} | ${fmt(r.totalCostUsd, 4)} |`,
    );
  }
  return lines.join('\n');
}

/**
 * Human-readable labels for the attribution classes.
 */
const ATTRIBUTION_LABELS = Object.freeze({
  'working-as-intended': 'Working as intended',
  'deliver-phase-gap': 'Deliver-phase gap',
  'plan-phase-gap': 'Plan-phase gap',
  'model-compensating': 'Model compensating',
});

/**
 * Per-scenario attribution counts for the mandrel arm (Epic #86, Story #95;
 * D-019 §3.4). For each mandrel-arm run that carries a `planQuality` block, the
 * attribution decision table is computed per run — crossing the intrinsic plan
 * quality (`planQuality.score`) with the delivered OUTCOME
 * (`dimensions.quality.score`) and plan-adherence
 * (`dimensions.planningFidelity.score`) — and the run's classification is
 * tallied. A run's persisted `planQuality.attribution.classification` is
 * honoured when present; otherwise it is recomputed here from the same fields
 * (single source of truth: `computeAttribution`). Runs with no `planQuality`
 * block (control arm, legacy corpora) are skipped, so a corpus that predates
 * this axis renders no attribution table.
 *
 * @param {Array<object>} cells
 * @returns {Array<{
 *   scenario: string,
 *   n: number,
 *   counts: Record<string, number>,
 *   unattributed: number
 * }>}
 */
export function attributionRows(cells) {
  const rows = [];
  for (const cell of cells ?? []) {
    const runs = cell?.mandrelRuns ?? [];
    const counts = {};
    for (const cls of ATTRIBUTION_CLASSES) counts[cls] = 0;
    let n = 0;
    let unattributed = 0;
    for (const sc of runs) {
      const pq = sc?.planQuality;
      if (!pq || typeof pq !== 'object') continue;
      n += 1;
      const stored = pq.attribution?.classification;
      const classification = ATTRIBUTION_CLASSES.includes(stored)
        ? stored
        : computeAttribution({
            planQualityScore: pq.score,
            outcomeScore: sc?.dimensions?.quality?.score,
            planAdherenceScore: sc?.dimensions?.planningFidelity?.score,
          }).classification;
      if (classification && counts[classification] !== undefined) {
        counts[classification] += 1;
      } else {
        unattributed += 1;
      }
    }
    if (n === 0) continue;
    rows.push({ scenario: cell.scenario, n, counts, unattributed });
  }
  return rows;
}

/**
 * Render the attribution decision-table section (Epic #86, Story #95; D-019
 * §3.4): a mandrel-only table tallying how each scenario's runs attribute a
 * result to the plan phase vs the deliver phase (or working-as-intended /
 * model-compensating). Returns '' when no cell carries a `planQuality` block,
 * so control-only / legacy corpora render nothing.
 *
 * @param {Array<object>} cells
 * @returns {string}
 */
export function renderAttributionSection(cells) {
  const rows = attributionRows(cells);
  if (rows.length === 0) return '';
  const lines = [
    '## Plan-vs-deliver attribution (mandrel arm)',
    '',
    'Each mandrel-arm run crosses its intrinsic PLAN quality with the delivered',
    'OUTCOME and plan-adherence (D-019 §3.4), attributing a result to the plan',
    'phase vs the deliver phase rather than lumping both into one number.',
    'Crossing all three inputs is the Goodhart backstop — a plan cannot read as',
    '“working as intended” without a matching outcome.',
    '',
    `| Scenario | n | ${ATTRIBUTION_CLASSES.map((c) => ATTRIBUTION_LABELS[c]).join(' | ')} | Unattributed |`,
    `| --- | --- | ${ATTRIBUTION_CLASSES.map(() => '---').join(' | ')} | --- |`,
  ];
  for (const r of rows) {
    const cellVals = ATTRIBUTION_CLASSES.map((c) => r.counts[c] ?? 0).join(
      ' | ',
    );
    lines.push(
      `| \`${r.scenario}\` | ${r.n} | ${cellVals} | ${r.unattributed} |`,
    );
  }
  return lines.join('\n');
}

/**
 * Render the saturated-dimension guardrail section (Story #157): quality,
 * maintainability, and security are pass/fail GATES against a cohort threshold,
 * not mandrel-vs-control deltas — both arms sit at ceiling, so a delta is noise.
 * A drop below threshold on either arm is itself a finding.
 *
 * @param {Array<object>} cells
 * @returns {string}
 */
export function renderSaturatedGuardrailSection(cells) {
  const rows = saturatedGuardrailRows(cells);
  const lines = [
    '## Saturated-dimension guardrails (quality · maintainability · security)',
    '',
    'These value dimensions are SATURATED — both arms score at ceiling on the',
    'current corpus — so they are reported as pass/fail GUARDRAILS against a',
    'fixed cohort threshold rather than as mandrel-vs-control deltas (Story',
    '#157). A delta here would be noise dressed as measurement. Their numeric',
    'deltas are preserved in the appendix. A drop below threshold is itself a',
    'finding. They stay demoted until a weak-model calibration probe',
    'demonstrates dynamic range.',
    '',
  ];
  if (rows.length === 0) {
    lines.push('No guardrail-scored runs to evaluate.');
    return lines.join('\n');
  }
  lines.push(
    '| Scenario | Dimension | Threshold | Mandrel (met/dropped/unmeasured) | Control (met/dropped/unmeasured) |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const r of rows) {
    lines.push(
      `| \`${r.scenario}\` | ${DIMENSION_LABELS[r.dimension] ?? r.dimension} | ${fmt(r.threshold, 2)} | ${r.mandrel.met}/${r.mandrel.dropped}/${r.mandrel.unmeasured} | ${r.control.met}/${r.control.dropped}/${r.control.unmeasured} |`,
    );
  }
  const anyDropped = rows.some(
    (r) => r.mandrel.dropped > 0 || r.control.dropped > 0,
  );
  lines.push(
    '',
    anyDropped
      ? '⚠️ One or more runs dropped below a saturated-dimension guardrail — see Recommended improvements.'
      : '✅ Every measured run met its saturated-dimension guardrail threshold.',
  );
  return lines.join('\n');
}

/**
 * Findings from the saturated-dimension guardrails (Story #157): a
 * (scenario, dimension) with any dropped run on either arm surfaces as a
 * `medium` finding.
 *
 * @param {Array<object>} cells
 * @returns {Array<{ id: string, severity: string, title: string, evidence: string, action: string }>}
 */
export function saturatedGuardrailFindings(cells) {
  const findings = [];
  for (const r of saturatedGuardrailRows(cells)) {
    const dropped = r.mandrel.dropped + r.control.dropped;
    if (dropped === 0) continue;
    const label = DIMENSION_LABELS[r.dimension] ?? r.dimension;
    findings.push({
      id: `saturated-guardrail-drop-${r.scenario}-${r.dimension}`,
      severity: 'medium',
      title: `Investigate the ${label} guardrail drop on \`${r.scenario}\``,
      evidence: `${r.mandrel.dropped} mandrel + ${r.control.dropped} control run(s) fell below the ${fmt(r.threshold, 2)} ${label} guardrail threshold.`,
      action:
        `${label} is a saturated dimension expected to hold at ceiling. A drop ` +
        'is a genuine regression — trace the dropped run(s) to the defect that ' +
        'cost the dimension its ceiling score.',
    });
  }
  return findings;
}

/**
 * Render the appendix: the pooled AND paired numeric deltas for the DEMOTED
 * saturated dimensions, per scenario (Story #157). These no longer appear in
 * the headline scorecard; the appendix keeps them auditable.
 *
 * @param {Array<object>} cells
 * @param {ReturnType<typeof scoreCorpus>} corpus
 * @param {'iqr'|'ci'} method
 * @returns {string}
 */
export function renderAppendixSection(cells, corpus, method) {
  const lines = [
    '## Appendix — saturated-dimension deltas (demoted from headline)',
    '',
    'The numeric mandrel-vs-control deltas for the saturated dimensions, kept',
    'here for audit. They are NOT headline signal (Story #157): both arms are at',
    'ceiling, so the delta is within noise by construction. Read the guardrail',
    'section above for the reportable verdict.',
    '',
  ];
  let anyRow = false;
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    const diff = corpus.perScenario[i];
    const rows = appendixDimensionRows(cell, diff, method);
    if (rows.length === 0) continue;
    anyRow = true;
    lines.push(
      `### \`${cell.scenario}\``,
      '',
      '| Dimension | Mandrel | Control | Pooled Δ (M−C) | Paired Δ (M−C) | Pooled verdict |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const r of rows) {
      lines.push(
        `| ${r.label} | ${fmtBand(r.mandrelBand)} | ${fmtBand(r.controlBand)} | ${fmt(r.delta)} | ${fmt(r.pairedDelta)} | ${VERDICT_BADGE[r.verdict]} |`,
      );
    }
    lines.push('');
  }
  if (!anyRow) {
    lines.push('No saturated-dimension data in this corpus.');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function renderScenarioSection(cell, diff, method) {
  const rows = dimensionRows(cell, diff, method);
  const routingNote = renderRoutingNote(cell.mandrelRuns);
  const mismatchNote = renderMismatchNote(cell);
  const floorNote = renderFloorCalibrationNote(cell);
  const nonInferentialNote = renderNonInferentialNote(cell);
  // When the pool is suppressed (non-inferential), the pooled arms are empty;
  // report the raw held counts instead so the reader still sees the corpus size.
  const held = cell.nonInferentialRuns ?? [];
  const nMandrel = cell.nonInferential
    ? held.filter((r) => r?.arm === 'mandrel').length
    : cell.mandrelRuns.length;
  const nControl = cell.nonInferential
    ? held.filter((r) => r?.arm === 'control').length
    : cell.controlRuns.length;
  const paired = diff?.paired;
  const unpaired = paired?.unpaired ?? { mandrel: 0, control: 0 };
  const unpairedNote =
    unpaired.mandrel > 0 || unpaired.control > 0
      ? `> ⚠️ **Unpaired runs excluded from the paired block:** ${unpaired.mandrel} mandrel / ${unpaired.control} control run(s) had no seed-SHA counterpart and were dropped from the paired differences (they remain in the pooled bands).`
      : '';
  const header = [
    `### Scenario: \`${cell.scenario}\` (difficulty ${Number.isFinite(cell.difficulty) ? cell.difficulty : '?'})`,
    '',
    `n = ${nMandrel} mandrel / ${nControl} control · ${paired?.pairs ?? 0} seed-matched pair(s) · band = ${method} (\`center [low, high]\`)`,
    ...(nonInferentialNote ? ['', nonInferentialNote] : []),
    ...(floorNote ? ['', floorNote] : []),
    ...(routingNote ? ['', routingNote] : []),
    ...(mismatchNote ? ['', mismatchNote] : []),
    ...(unpairedNote ? ['', unpairedNote] : []),
  ];

  // Paired differential LEADS (Story #157): the seed-matched per-pair
  // difference recovers the blocking power the pooled bands discard.
  const pRows = pairedRows(diff);
  const pairedBlock = [
    '',
    '#### Paired differential (seed-matched, M−C per pair)',
    '',
    '| Dimension | Paired Δ (M−C) [low, high] | n pairs | Verdict |',
    '| --- | --- | --- | --- |',
    ...pRows.map((r) => {
      const digits = r.metric === 'efficiency.wallClockMs' ? 0 : 3;
      return `| ${r.label} | ${fmtBand(r.diffBand, digits)} | ${r.n} | ${VERDICT_BADGE[r.verdict]} |`;
    }),
  ];

  const pooledBlock = [
    '',
    '#### Pooled per-arm bands',
    '',
    '| Dimension | Mandrel | Control | Δ (M−C) | Noise floor | Verdict |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => {
      const digits = r.metric === 'efficiency.wallClockMs' ? 0 : 3;
      return `| ${r.label} | ${fmtBand(r.mandrelBand, digits)} | ${fmtBand(r.controlBand, digits)} | ${fmt(r.delta, digits)} | ${fmt(r.noiseFloor, digits)} | ${VERDICT_BADGE[r.verdict]} |`;
    }),
  ];

  const trapSection = renderTrapAxisSection(cell, method);
  const continuitySection = renderContinuitySection(cell, method);
  const chainSection = renderChainSection(cell, method);
  return [
    ...header,
    ...pairedBlock,
    ...pooledBlock,
    ...(trapSection ? ['', trapSection] : []),
    ...(continuitySection ? ['', continuitySection] : []),
    ...(chainSection ? ['', chainSection] : []),
  ].join('\n');
}

/**
 * Render the per-difficulty scaling view: Efficiency (totalTokens) and Overhead
 * ratio (tokenRatio) across the difficulty ladder for BOTH arms, with the
 * monotonicity verdict and any calibration warnings surfaced explicitly.
 *
 * @param {Array<object>} cells  Difficulty-ordered scenario cells.
 * @param {ReturnType<typeof scoreCorpus>} corpus  The scored corpus.
 * @param {'iqr'|'ci'} method
 * @returns {string}
 */
export function renderScalingView(cells, corpus, method) {
  const tokenAcc = (d) => d?.efficiency?.totalTokens ?? null;
  const ratioAcc = (d) => d?.overheadRatio?.tokenRatio ?? null;

  const lines = [
    '## Per-difficulty scaling view',
    '',
    'As difficulty rises, Efficiency (absolute tokens) must **rise** and the',
    'Overhead ratio must **fall** as ceremony amortizes over more output. A',
    'violation is a calibration warning, not a silent pass.',
    '',
    '| Scenario | Difficulty | Tokens (mandrel) | Tokens (control) | Overhead ratio (mandrel) | Overhead ratio (control) |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const cell of cells) {
    const mTokens = armBand(cell.mandrelRuns, tokenAcc, method);
    const cTokens = armBand(cell.controlRuns, tokenAcc, method);
    const mRatio = armBand(cell.mandrelRuns, ratioAcc, method);
    const cRatio = armBand(cell.controlRuns, ratioAcc, method);
    lines.push(
      `| \`${cell.scenario}\` | ${Number.isFinite(cell.difficulty) ? cell.difficulty : '?'} | ${fmtBand(mTokens, 0)} | ${fmtBand(cTokens, 0)} | ${fmtBand(mRatio)} | ${fmtBand(cRatio)} |`,
    );
  }

  const mono = corpus.difficultyMonotonicity;
  lines.push('', '### Monotonicity (Mandrel arm, calibration guardrail)', '');
  if (mono.ordered.length < 2) {
    lines.push(
      '- Not enough ladder rungs to evaluate monotonicity (needs ≥ 2 scenarios).',
    );
  } else if (mono.monotonicityHolds) {
    lines.push(
      '- ✅ Monotonicity holds across every adjacent rung (efficiency rises, overhead ratio falls).',
    );
  } else {
    lines.push(
      '- ⚠️ **Calibration warning — monotonicity violated.** The instrument may be',
      '  insensitive or a scenario mis-graded for difficulty:',
    );
    for (const w of mono.warnings) {
      lines.push(`  - ${w}`);
    }
  }
  return lines.join('\n');
}

/**
 * Build the structured "Recommended improvements" findings list from the scored
 * corpus. Each finding is actionable and evidence-linked (it cites the metric
 * and the number that triggered it). Returned as data so the renderer formats
 * it and tests can assert on the findings without parsing Markdown.
 *
 * Findings, in priority order:
 *   1. Overhead floor with no quality gain → ceremony-lite path (the canonical
 *      README § "Overhead floor" recommendation). Always reports the floor
 *      estimate even when it does NOT trigger a recommendation, so the section
 *      surfaces the overhead-floor estimate unconditionally.
 *   2. Monotonicity violations → recalibrate the difficulty ladder / instrument.
 *   3. Per-scenario dimensions where the bare control arm beats Mandrel by a
 *      REAL margin on a value dimension (a regression the scaffolding should
 *      not be causing).
 *
 * @param {ReturnType<typeof scoreCorpus>} corpus
 * @returns {Array<{
 *   id: string,
 *   severity: 'high'|'medium'|'info',
 *   title: string,
 *   evidence: string,
 *   action: string
 * }>}
 */
export function recommendImprovements(corpus) {
  const findings = [];

  // 1. Overhead floor — always surfaced; recommendation fires conditionally.
  const floor = corpus.overheadFloor;
  if (floor) {
    const tok = floor.overheadFloorTokens;
    const usd = floor.overheadFloorUsd;
    const floorEvidence =
      `hello-world overhead floor ≈ ${fmt(tok, 0)} tokens` +
      (typeof usd === 'number' ? ` / $${fmt(usd, 4)}` : '') +
      ` above control (quality gain ${fmt(floor.qualityGain)})`;
    if (floor.recommendCeremonyLite) {
      findings.push({
        id: 'overhead-floor-ceremony-lite',
        severity: 'high',
        title: 'Add a ceremony-lite path for trivial scopes',
        evidence: `${floorEvidence} — a positive floor with no matching quality gain.`,
        action:
          'Gate the full /plan→/deliver ceremony behind a complexity threshold so ' +
          'trivial scopes skip the planning/decomposition tax that buys no quality here.',
      });
    } else {
      findings.push({
        id: 'overhead-floor-estimate',
        severity: 'info',
        title: 'Overhead-floor estimate (fixed ceremony tax on near-zero work)',
        evidence: floorEvidence,
        action:
          floor.noQualityGain === false && typeof floor.qualityGain === 'number'
            ? 'The floor is currently justified by a quality gain on hello-world; keep monitoring as the ladder grows.'
            : 'No actionable floor finding for this cohort; recorded for tracking.',
      });
    }
  }

  // 2. Monotonicity violations.
  const mono = corpus.difficultyMonotonicity;
  if (mono && !mono.monotonicityHolds && mono.ordered.length >= 2) {
    findings.push({
      id: 'monotonicity-violation',
      severity: 'high',
      title: 'Recalibrate the difficulty ladder or the instrument',
      evidence: mono.warnings.join('; '),
      action:
        'Efficiency did not rise and/or overhead ratio did not fall across the ' +
        'ladder. Re-grade the scenario difficulties or widen the gap between rungs ' +
        'so the instrument is sensitive to scaling.',
    });
  }

  // 3. Real regressions on a value dimension (control beats mandrel).
  //    Higher-is-better for quality/planningFidelity ⇒ a positive
  //    (control − mandrel) gap that clears the noise floor is a regression.
  //    autonomy is EXCLUDED here — it is a guardrail, not a delta (see
  //    `autonomyGuardrailFindings`).
  const valueDimensions = new Set(['quality', 'planningFidelity']);
  for (const scenarioDiff of corpus.perScenario) {
    for (const name of valueDimensions) {
      const cmp = scenarioDiff.dimensions[name];
      if (!cmp?.comparable || !cmp.deltaIsReal) continue;
      // delta is (mandrel − control); a value dimension regresses when it is
      // negative AND real.
      if (cmp.delta < 0) {
        findings.push({
          id: `regression-${scenarioDiff.scenario}-${name}`,
          severity: 'medium',
          title: `Investigate the ${DIMENSION_LABELS[name] ?? name} regression on \`${scenarioDiff.scenario}\``,
          evidence: `Mandrel ${fmt(cmp.mandrelCenter)} vs control ${fmt(cmp.controlCenter)} (Δ ${fmt(cmp.delta)}, noise floor ${fmt(cmp.noiseFloor)}) — a real gap in the bare arm’s favour.`,
          action:
            'The scaffolding is costing a value dimension it should protect. ' +
            'Trace the lifecycle for this scenario to find where the regression enters.',
        });
      }
    }
  }

  return findings;
}

const SEVERITY_BADGE = Object.freeze({
  high: '🔴 High',
  medium: '🟠 Medium',
  info: '🔵 Info',
});

/**
 * Render the "Recommended improvements" section from the structured findings.
 *
 * @param {ReturnType<typeof recommendImprovements>} findings
 * @returns {string}
 */
function renderRecommendations(findings) {
  const lines = ['## Recommended improvements', ''];
  if (findings.length === 0) {
    lines.push(
      'No actionable findings for this cohort: no overhead-floor recommendation,',
      'no monotonicity violation, and no real value-dimension regression. The',
      'scaffolding is earning its tax at this frontier.',
    );
    return lines.join('\n');
  }
  for (const f of findings) {
    lines.push(
      `### ${SEVERITY_BADGE[f.severity] ?? f.severity} — ${f.title}`,
      '',
      `- **Evidence:** ${f.evidence}`,
      `- **Action:** ${f.action}`,
      '',
    );
  }
  // Drop the trailing blank line for a stable tail.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * Render the full value-add report from a corpus of per-run scorecards.
 *
 * @param {object} args
 * @param {Array<object>} args.scorecards  Flat list of scorecards (all
 *   scenarios × arms × runs) for ONE cohort.
 * @param {'iqr'|'ci'} [args.method='iqr']  Band method.
 * @returns {string}  The Markdown report.
 */
export function renderReport({ scorecards, method = 'iqr' } = {}) {
  if (!Array.isArray(scorecards)) {
    throw new TypeError('renderReport: scorecards must be an array');
  }

  const cohort = deriveCohort(scorecards);
  const cells = groupCells(scorecards);
  const corpus = scoreCorpus({
    cells: cells.map((c) => ({
      scenario: c.scenario,
      difficulty: c.difficulty,
      mandrelRuns: c.mandrelRuns,
      controlRuns: c.controlRuns,
    })),
    method,
  });

  const sections = [renderHeader(cohort, method), ''];

  sections.push('## Dimension distributions (Mandrel vs bare control)', '');
  if (cells.length === 0) {
    sections.push('No scorecards supplied — nothing to render.', '');
  } else {
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      const diff = corpus.perScenario[i];
      sections.push(renderScenarioSection(cell, diff, method), '');
    }
  }

  sections.push(renderAutonomyGuardrailSection(cells), '');
  sections.push(renderSaturatedGuardrailSection(cells), '');

  const phaseCostSection = renderPhaseCostSection(cells);
  if (phaseCostSection) sections.push(phaseCostSection, '');

  const attributionSection = renderAttributionSection(cells);
  if (attributionSection) sections.push(attributionSection, '');

  sections.push(renderScalingView(cells, corpus, method), '');

  const findings = [
    ...recommendImprovements(corpus),
    ...autonomyGuardrailFindings(cells),
    ...saturatedGuardrailFindings(cells),
  ];
  sections.push(renderRecommendations(findings));

  if (cells.length > 0) {
    sections.push('', renderAppendixSection(cells, corpus, method));
  }

  return `${sections
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

/**
 * Convenience structured form of the report (the same data the Markdown is
 * rendered from) for callers that want to consume the findings programmatically
 * rather than parse the Markdown. Pure; shares the corpus computation.
 *
 * @param {object} args
 * @param {Array<object>} args.scorecards
 * @param {'iqr'|'ci'} [args.method='iqr']
 * @returns {{
 *   cohort: ReturnType<typeof deriveCohort>,
 *   method: 'iqr'|'ci',
 *   scenarios: Array<{ scenario: string, difficulty: number, rows: ReturnType<typeof dimensionRows> }>,
 *   monotonicity: ReturnType<typeof scoreCorpus>['difficultyMonotonicity'],
 *   overheadFloor: ReturnType<typeof scoreCorpus>['overheadFloor'],
 *   recommendations: ReturnType<typeof recommendImprovements>
 * }}
 */
export function buildReportModel({ scorecards, method = 'iqr' } = {}) {
  if (!Array.isArray(scorecards)) {
    throw new TypeError('buildReportModel: scorecards must be an array');
  }
  const cohort = deriveCohort(scorecards);
  const cells = groupCells(scorecards);
  const corpus = scoreCorpus({
    cells: cells.map((c) => ({
      scenario: c.scenario,
      difficulty: c.difficulty,
      mandrelRuns: c.mandrelRuns,
      controlRuns: c.controlRuns,
    })),
    method,
  });
  return {
    cohort,
    method,
    scenarios: cells.map((cell, i) => ({
      scenario: cell.scenario,
      difficulty: cell.difficulty,
      rows: dimensionRows(cell, corpus.perScenario[i], method),
      paired: pairedRows(corpus.perScenario[i]),
      appendix: appendixDimensionRows(cell, corpus.perScenario[i], method),
      unpaired: corpus.perScenario[i]?.paired?.unpaired ?? {
        mandrel: 0,
        control: 0,
      },
      trap: trapAxisRows(cell, method),
      continuity: continuityRows(cell, method),
      // Chain block (issue #124, PR-D) — strictly additive: null for every
      // non-chain cell so pre-chain consumers of the model see no new data.
      chain:
        chainArms(cell).length > 0
          ? {
              slope: degradationSlope({
                mandrelRuns: cell.mandrelRuns,
                controlRuns: cell.controlRuns,
                method,
                scenario: cell.scenario,
              }),
              touchRows: chainTouchRows(cell),
              summary: chainSummaryRows(cell, method),
            }
          : null,
    })),
    monotonicity: corpus.difficultyMonotonicity,
    overheadFloor: corpus.overheadFloor,
    autonomyGuardrail: autonomyGuardrailRows(cells),
    phaseCost: phaseCostRows(cells),
    recommendations: [
      ...recommendImprovements(corpus),
      ...autonomyGuardrailFindings(cells),
    ],
  };
}
