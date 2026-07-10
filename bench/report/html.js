// bench/report/html.js
//
// The browsable dashboard for the Mandrel self-benchmark harness
// (Epic #2, Story #17). Internal tooling only — never shipped in the
// distributed `.agents/` bundle, never run against the live repo.
//
// `renderDashboard({ scorecards })` turns the aggregated scorecard corpus (every
// run across every cohort) into ONE self-contained `results.html` string with:
//
//   1. An over-VERSIONS TREND CHART (inline SVG) of the headline metrics —
//      quality, autonomy, efficiency total-tokens & cost, and overhead ratio.
//      The x-axis is the COHORT (model + framework version), ordered
//      chronologically; each cohort is aggregated to one median point per arm
//      with an inter-quartile whisker (never a bare point — see metrics/README).
//      A Model filter narrows to one model so the version-over-version line is
//      clean; model changes appear as a second x-tick line and break the
//      connecting line (we never draw a cross-model "trend"). Every metric
//      carries an interpretation caption (value/cost side, range, which
//      direction is better, what "good" looks like) and a delta-vs-control
//      badge for the most recent cohort.
//   2. A sortable + filterable INDEX TABLE of every run (timestamp, scenario,
//      arm, model, frameworkVersion, benchmarkVersion, the dimension headlines,
//      env) — sort by any header, filter by scenario / arm / model / version +
//      free text,
//      with a "how to read" legend that states each dimension's good/bad
//      direction.
//   3. An in-page MODAL opened by clicking a row, showing the full per-dimension
//      breakdown (each group prefixed with a plain-English good/bad gloss) and
//      links to that run's `.raw/` artifacts and Markdown report.
//
// The dashboard carries ZERO runtime dependencies: the corpus is inlined as
// JSON, the chart is drawn as inline SVG, and sort/filter/modal are vanilla JS.
// No bundler, no vendored library, no CDN — it works offline and is byte-for-
// byte diffable.
//
// Determinism (mirrors render.js): pure, no I/O, no clock, no randomness. All
// run identity (ids, timestamps) is taken from the scorecard data, NEVER from
// `Date.now()`, so a persisted `results.html` is reproducible and diffable for a
// given corpus. The browser-side JS computes layout at view time, but the
// emitted string is fixed for a fixed corpus.

import { cohortSegments } from './cohort-path.js';
import {
  autonomyGuardrailRows,
  continuityRows,
  formatTrapStat,
  groupCells,
  phaseCostRows,
  trapAxisRows,
} from './render.js';

/**
 * The headline metrics the trend chart plots, each with a label, the side of
 * the value/cost frontier it sits on, the direction that is "better", a range
 * hint, a plain-English "what good looks like" gloss, and a pure accessor onto
 * a scorecard. Kept in module scope so the server-side row projection and the
 * client-side chart agree on exactly one set of headlines (no second, divergent
 * interpretation — Story out-of-scope rule).
 *
 * `side`   — 'value' (what scaffolding buys) | 'cost' (what it charges).
 * `better` — 'higher' | 'lower'. Drives the ▲/▼ hints and the delta verdict.
 */
const HEADLINE_METRICS = Object.freeze([
  {
    key: 'quality',
    label: 'Quality',
    side: 'value',
    better: 'higher',
    range: '0–1',
    good: '1.0 = every frozen acceptance assertion passes and the LLM judge agrees; below ~0.9 means assertions failed.',
    get: (sc) => sc?.dimensions?.quality?.score,
  },
  {
    key: 'autonomy',
    label: 'Autonomy',
    side: 'value',
    better: 'higher',
    range: '0–1',
    good: '1.0 = fully unattended (zero human interventions); each one drops it (0.5 = one, 0.33 = two). Reclassified as a mandrel-arm GUARDRAIL against a cohort threshold (default 0.99, see the Autonomy guardrail panel below) — never a mandrel-vs-control delta (Epic #66, Story #77/#79).',
    // Epic #66, Story #79: autonomy is a pass/fail guardrail, not a
    // mandrel-vs-control comparison — the bare control's zero-intervention
    // baseline is defined, not measured. The trend chart still plots the
    // score for inspection, but the delta-vs-control badge is suppressed.
    deltaExempt: true,
    get: (sc) => sc?.dimensions?.autonomy?.score,
  },
  {
    key: 'maintainability',
    label: 'Maintainability',
    side: 'value',
    better: 'higher',
    range: '0–1',
    good: '1.0 = code is clean, well-structured, and easy to change; lower scores indicate complexity, poor naming, or structural debt.',
    get: (sc) => sc?.dimensions?.maintainability?.score,
  },
  {
    key: 'security',
    label: 'Security',
    side: 'value',
    better: 'higher',
    range: '0–1',
    good: '1.0 = no known vulnerabilities or unsafe patterns detected; lower scores indicate secrets, injection risks, or other security findings.',
    get: (sc) => sc?.dimensions?.security?.score,
  },
  {
    key: 'totalTokens',
    label: 'Total tokens',
    side: 'cost',
    better: 'lower',
    range: '≥0 (count)',
    good: 'Absolute token cost for the whole run. Cheaper is better only at equal quality — read it alongside Quality.',
    get: (sc) => sc?.dimensions?.efficiency?.totalTokens,
  },
  {
    key: 'costUsd',
    label: 'Cost (USD)',
    side: 'cost',
    better: 'lower',
    range: '≥0 ($)',
    good: 'Absolute USD from the claude -p envelope. Lower is cheaper at equal quality; the mandrel−control gap is the price of the scaffolding.',
    get: (sc) => sc?.dimensions?.efficiency?.costUsd,
  },
  {
    key: 'overheadRatio',
    label: 'Overhead ratio',
    side: 'cost',
    better: 'lower',
    range: '≥0',
    good: 'Ceremony tokens per shippable-codegen token. Control sits near 0; the mandrel−control gap IS the ceremony tax. Should fall as tasks get bigger.',
    get: (sc) => sc?.dimensions?.overheadRatio?.tokenRatio,
  },
]);

/**
 * Coerce a value to a finite number or null. Used to project metrics into a
 * JSON-safe, NaN-free shape before they are inlined.
 *
 * @param {unknown} v
 * @returns {number|null}
 */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Project one scorecard into the compact, JSON-safe row the dashboard inlines.
 * Pure. Carries the index headlines, the full per-dimension breakdown the modal
 * needs, the env, and the rawRefs / report pointers for the modal links.
 *
 * @param {object} sc
 * @returns {object}
 */
export function toRow(sc) {
  const dims = sc?.dimensions ?? {};
  // The cohort's per-run Markdown reports live under
  // `<model-slug>/<frameworkVersion>/reports/`, relative to results.html (which
  // sits at the results root). We carry the relative reports-dir pointer rather
  // than a single report file because a report stamps a whole run (every cohort
  // scorecard for that run), not one scorecard — the dir is the deterministic,
  // record-derivable link to "this run's Markdown report(s)".
  const { modelSlug, frameworkVersion } = cohortSegments(sc);
  const reportsDir = `${modelSlug}/${frameworkVersion}/reports/`;
  return {
    runId: typeof sc?.runId === 'string' ? sc.runId : '',
    reportsDir,
    timestamp: typeof sc?.timestamp === 'string' ? sc.timestamp : '',
    scenario: typeof sc?.scenario === 'string' ? sc.scenario : '',
    arm: typeof sc?.arm === 'string' ? sc.arm : '',
    model: typeof sc?.model?.id === 'string' ? sc.model.id : '',
    frameworkVersion:
      typeof sc?.frameworkVersion === 'string' ? sc.frameworkVersion : '',
    benchmarkVersion:
      typeof sc?.benchmarkVersion === 'string' ? sc.benchmarkVersion : '',
    env: {
      node: typeof sc?.env?.node === 'string' ? sc.env.node : '',
      os: typeof sc?.env?.os === 'string' ? sc.env.os : '',
      host: typeof sc?.env?.host === 'string' ? sc.env.host : '',
    },
    // Index headlines (the seven dimension headlines).
    quality: num(dims?.quality?.score),
    planningFidelity: num(dims?.planningFidelity?.score),
    autonomy: num(dims?.autonomy?.score),
    maintainability: num(dims?.maintainability?.score),
    security: num(dims?.security?.score),
    totalTokens: num(dims?.efficiency?.totalTokens),
    costUsd: num(dims?.efficiency?.costUsd),
    overheadRatio: num(dims?.overheadRatio?.tokenRatio),
    // Per-phase session envelopes (D-019, Epic #86 Story #94): the mandrel
    // arm's /plan + /deliver phase cost/tokens/wall-clock; null for control.
    phases: Array.isArray(sc?.phases) ? sc.phases : null,
    // Full per-dimension breakdown for the modal (the raw dimension objects).
    dimensions: {
      quality: dims?.quality ?? null,
      planningFidelity: dims?.planningFidelity ?? null,
      autonomy: dims?.autonomy ?? null,
      maintainability: dims?.maintainability ?? null,
      security: dims?.security ?? null,
      efficiency: dims?.efficiency ?? null,
      overheadRatio: dims?.overheadRatio ?? null,
    },
    rawRefs: sc?.rawRefs ?? null,
  };
}

/**
 * Build the JSON-safe corpus model the dashboard inlines: the projected rows
 * (sorted by timestamp then runId for a stable, diffable order) and the
 * headline-metric metadata the client chart reads (key, label, and the
 * interpretation fields). Pure.
 *
 * Also computes the server-rendered, non-interactive **autonomy guardrail**
 * and **trap axis** panels (Epic #66, Story #79) by reusing the identical
 * pure helpers `bench/report/render.js` uses for the Markdown report — the
 * same "no second, divergent interpretation" discipline this module's header
 * comment commits to.
 *
 * @param {Array<object>} scorecards
 * @returns {{ rows: object[], metrics: Array<object>, guardrail: Array<object>, trapAxis: Array<{ scenario: string, rows: Array<object> }> }}
 */
/**
 * The cohort discriminant (D-014): the (model, frameworkVersion,
 * benchmarkVersion) triple, joined with a NUL separator that cannot occur in
 * any field so distinct triples never collide.
 *
 * @param {object} sc
 * @returns {string}
 */
function cohortTripleKey(sc) {
  return [
    sc?.model?.id ?? '',
    sc?.frameworkVersion ?? '',
    sc?.benchmarkVersion ?? '',
  ].join('\u0000');
}

/**
 * The subset of a corpus belonging to the MOST RECENT cohort — the cohort of
 * the latest-timestamp record (ISO-8601 timestamps sort lexically). This mirrors
 * how the client delta badge picks the most recent cohort, and is what the
 * server-rendered guardrail + trap-axis panels scope to so a second recorded
 * benchmarkVersion never blanks them. An empty corpus yields an empty subset.
 * Pure.
 *
 * @param {Array<object>} scorecards
 * @returns {Array<object>}
 */
function mostRecentCohortScorecards(scorecards) {
  if (scorecards.length === 0) return [];
  let latestKey = null;
  let latestTs = null;
  for (const sc of scorecards) {
    const ts = typeof sc?.timestamp === 'string' ? sc.timestamp : '';
    if (latestTs === null || ts > latestTs) {
      latestTs = ts;
      latestKey = cohortTripleKey(sc);
    }
  }
  return scorecards.filter((sc) => cohortTripleKey(sc) === latestKey);
}

export function buildDashboardModel(scorecards) {
  if (!Array.isArray(scorecards)) {
    throw new TypeError('buildDashboardModel: scorecards must be an array');
  }
  const rows = scorecards.map(toRow).sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp < b.timestamp ? -1 : 1;
    }
    return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
  });
  const metrics = HEADLINE_METRICS.map(
    ({ key, label, side, better, range, good, deltaExempt }) => ({
      key,
      label,
      side,
      better,
      range,
      good,
      ...(deltaExempt ? { deltaExempt: true } : {}),
    }),
  );
  // Scope the server-rendered guardrail + trap-axis panels to the MOST RECENT
  // cohort (the same one the client delta badge picks) before grouping. Feeding
  // the whole multi-cohort corpus to groupCells would mark every cell
  // non-inferential — and blank both panels permanently — the moment a second
  // benchmarkVersion is recorded, because groupCells suppresses any cell that
  // mixes benchmark versions. Scoping to one cohort keeps measurement-validity
  // intact (records never pool across benchmarkVersion within a cell) while the
  // panels keep rendering the current cohort.
  const cells = groupCells(mostRecentCohortScorecards(scorecards));
  const guardrail = autonomyGuardrailRows(cells);
  const trapAxis = cells
    .map((cell) => ({
      scenario: cell.scenario,
      rows: trapAxisRows(cell, 'iqr'),
    }))
    .filter((s) => s.rows.length > 0);
  // Per-phase cost panel (D-019): mandrel-only /plan vs /deliver cost per
  // scenario, reusing render.js's `phaseCostRows` so the dashboard and the
  // Markdown report share one interpretation.
  const phaseCost = phaseCostRows(cells);
  // Second-touch continuity panel (Epic #86, Story #96): mandrel-vs-control
  // delta of the second change's outcome + cost per scenario, reusing
  // render.js's `continuityRows` so the dashboard and the Markdown report share
  // one interpretation. Only scenarios carrying touch-2 data appear.
  const continuity = cells
    .map((cell) => ({
      scenario: cell.scenario,
      rows: continuityRows(cell, 'iqr'),
    }))
    .filter((s) => s.rows.length > 0);
  return { rows, metrics, guardrail, trapAxis, phaseCost, continuity };
}

/**
 * Escape a string for safe inclusion in HTML text / attribute context. The only
 * server-rendered dynamic content is static chrome; all corpus data is inlined
 * as JSON and rendered client-side via textContent, so this guards the few
 * literal interpolations.
 *
 * @param {unknown} s
 * @returns {string}
 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Serialize the inlined corpus as a JSON string safe to embed inside a
 * `<script type="application/json">` block: the only sequence that can break out
 * of such a block is `</script` (and `<!--`), so we neutralize `<` / `>`
 * unicode-escaped. Deterministic.
 *
 * @param {object} model
 * @returns {string}
 */
function safeJson(model) {
  return JSON.stringify(model)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(new RegExp(String.fromCharCode(0x2028), 'g'), '\\u2028')
    .replace(new RegExp(String.fromCharCode(0x2029), 'g'), '\\u2029');
}

/** The static CSS for the dashboard. Deterministic string. */
const STYLE = `
:root {
  --bg: #0f1115; --panel: #181b22; --border: #2a2f3a; --fg: #e6e8ec;
  --muted: #9aa3b2; --accent: #6ea8fe; --mandrel: #6ea8fe; --control: #f0883e;
  --good: #56d364; --bad: #f85149;
}
* { box-sizing: border-box; }
body {
  margin: 0; font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  background: var(--bg); color: var(--fg);
}
header { padding: 20px 24px; border-bottom: 1px solid var(--border); }
h1 { margin: 0 0 4px; font-size: 18px; }
.sub { color: var(--muted); font-size: 13px; }
main { padding: 20px 24px; }
section { margin-bottom: 28px; }
h2 { font-size: 15px; margin: 0 0 12px; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; align-items: center; }
.controls label { color: var(--muted); font-size: 12px; }
select, input[type=text] {
  background: var(--panel); color: var(--fg); border: 1px solid var(--border);
  border-radius: 6px; padding: 5px 8px; font: inherit;
}
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 14px; }
.trap-axis h3 { font-size: 13px; margin: 16px 0 6px; font-weight: 600; }
.trap-axis h3:first-child { margin-top: 0; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { cursor: pointer; user-select: none; color: var(--muted); font-weight: 600; }
th.sorted-asc::after { content: " \\25B2"; }
th.sorted-desc::after { content: " \\25BC"; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: rgba(110,168,254,0.08); }
.empty { color: var(--muted); padding: 24px; text-align: center; }
.legend { display: flex; gap: 16px; margin-top: 8px; font-size: 12px; color: var(--muted); }
.legend span::before { content: "\\25CF "; }
.legend .mandrel::before { color: var(--mandrel); }
.legend .control::before { color: var(--control); }
.metric-caption { margin-top: 10px; font-size: 12px; color: var(--muted); line-height: 1.5; }
.metric-caption .pill { color: var(--fg); }
.delta-readout { margin-top: 8px; font-size: 12px; }
.delta-readout .delta { display: inline-block; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border); }
.delta-readout .delta.good { color: var(--good); border-color: rgba(86,211,100,0.4); }
.delta-readout .delta.bad { color: var(--bad); border-color: rgba(248,81,73,0.4); }
details.help { margin-bottom: 12px; font-size: 12px; color: var(--muted); }
details.help summary { cursor: pointer; color: var(--accent); }
details.help ul { margin: 8px 0 0; padding-left: 18px; }
details.help li { margin: 3px 0; }
details.help b { color: var(--fg); font-weight: 600; }
.up { color: var(--good); } .down { color: var(--good); }
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.6);
  display: none; align-items: center; justify-content: center; padding: 24px;
}
.modal-backdrop.open { display: flex; }
.modal {
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
  max-width: 720px; width: 100%; max-height: 84vh; overflow: auto; padding: 20px;
}
.modal h3 { margin: 0 0 4px; font-size: 16px; }
.modal .close { float: right; cursor: pointer; color: var(--muted); font-size: 20px; line-height: 1; background: none; border: none; }
.modal table { margin-top: 12px; }
.modal .links a { color: var(--accent); margin-right: 14px; }
.modal .links { margin-top: 14px; }
.dim-group { margin-top: 14px; }
.dim-group h4 { margin: 0 0 2px; font-size: 13px; color: var(--accent); }
.dim-group .gloss { margin: 0 0 6px; font-size: 11px; color: var(--muted); }
svg { display: block; width: 100%; height: auto; }
.metric-btns { display: flex; flex-wrap: wrap; gap: 6px; }
.metric-btns button {
  background: var(--panel); color: var(--fg); border: 1px solid var(--border);
  border-radius: 6px; padding: 4px 10px; cursor: pointer; font: inherit;
}
.metric-btns button.active { border-color: var(--accent); color: var(--accent); }
`;

/**
 * The client-side script. A single template string (no template interpolation
 * of corpus data — the corpus is read from the inlined JSON block by id), so the
 * emitted bytes are fixed for a fixed corpus. Vanilla JS only.
 *
 * NOTE: this string is itself a JS template literal in the source, so it must
 * not contain backslash escape sequences (e.g. "\\n"): write separators as
 * literal characters instead.
 */
const SCRIPT = `
"use strict";
(function () {
  var dataEl = document.getElementById("corpus");
  var MODEL = dataEl ? JSON.parse(dataEl.textContent) : { rows: [], metrics: [] };
  var ROWS = MODEL.rows || [];
  var METRICS = MODEL.metrics || [];

  // ---- helpers ----------------------------------------------------------
  function uniq(vals) {
    var seen = {}; var out = [];
    vals.forEach(function (v) { if (v !== "" && !seen[v]) { seen[v] = 1; out.push(v); } });
    out.sort();
    return out;
  }
  function fmtNum(v) {
    if (v === null || v === undefined) return "—";
    if (Math.abs(v) >= 1000) return String(Math.round(v));
    return String(Math.round(v * 1000) / 1000);
  }
  // type-7 quantile (the same estimator the IQR noise-band uses in
  // bench/metrics/README.md), so the chart's median + whisker match the report.
  function quantile(sorted, p) {
    var n = sorted.length;
    if (n === 0) return null;
    if (n === 1) return sorted[0];
    var h = (n - 1) * p;
    var lo = Math.floor(h);
    var hi = Math.ceil(h);
    return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
  }
  function summarize(values) {
    var vals = values
      .filter(function (v) { return typeof v === "number" && isFinite(v); })
      .slice()
      .sort(function (a, b) { return a - b; });
    if (vals.length === 0) return null;
    return {
      n: vals.length,
      median: quantile(vals, 0.5),
      q1: quantile(vals, 0.25),
      q3: quantile(vals, 0.75)
    };
  }
  function metricMeta(key) {
    for (var i = 0; i < METRICS.length; i++) if (METRICS[i].key === key) return METRICS[i];
    return null;
  }

  // ---- cohorts (the x-axis) --------------------------------------------
  // A cohort is one (model, frameworkVersion, benchmarkVersion) cell (D-014):
  // the benchmark version joins the key so records from different benchmark
  // versions never collapse into one trend point. ROWS arrive timestamp-sorted
  // from the server, so first-seen order is chronological.
  var COHORTS = (function () {
    var seen = {}; var list = [];
    ROWS.forEach(function (r) {
      var id = r.model + " @ " + r.frameworkVersion + " · bench " + r.benchmarkVersion;
      if (!seen[id]) {
        seen[id] = {
          id: id,
          model: r.model,
          version: r.frameworkVersion,
          benchmarkVersion: r.benchmarkVersion
        };
        list.push(seen[id]);
      }
    });
    return list;
  })();
  var MODELS = uniq(ROWS.map(function (r) { return r.model; }));

  // ---- index table ------------------------------------------------------
  var COLUMNS = [
    { key: "timestamp", label: "Timestamp", type: "str" },
    { key: "scenario", label: "Scenario", type: "str" },
    { key: "arm", label: "Arm", type: "str" },
    { key: "model", label: "Model", type: "str" },
    { key: "frameworkVersion", label: "Version", type: "str" },
    { key: "benchmarkVersion", label: "Bench", type: "str", hint: "Benchmark harness version (D-014) — joins the cohort key; records across different benchmark versions never pool" },
    { key: "quality", label: "Quality", type: "num", hint: "Value side · 0–1 · higher is better (1.0 = all assertions pass + judge agrees)" },
    { key: "planningFidelity", label: "Planning", type: "num", hint: "Value side · 0–1 · higher is better · null for control (it authors no plan)" },
    { key: "autonomy", label: "Autonomy", type: "num", hint: "Value side · 0–1 · higher is better (1.0 = fully unattended; <1 = a human stepped in)" },
    { key: "maintainability", label: "Maintainability", type: "num", hint: "Value side · 0–1 · higher is better · clean, well-structured code scores near 1.0" },
    { key: "security", label: "Security", type: "num", hint: "Value side · 0–1 · higher is better · 1.0 = no vulnerabilities or unsafe patterns detected" },
    { key: "totalTokens", label: "Tokens", type: "num", hint: "Cost side · lower is cheaper (read against Quality)" },
    { key: "overheadRatio", label: "Overhead", type: "num", hint: "Cost side · lower is cheaper · ceremony tokens per codegen token (control ≈ 0)" },
    { key: "env", label: "Env", type: "str" }
  ];
  var sortKey = "timestamp";
  var sortDir = 1;

  function envStr(r) { return (r.env.os || "") + " / " + (r.env.node || ""); }
  function cell(r, key) {
    if (key === "env") return envStr(r);
    var v = r[key];
    if (v === null || v === undefined) return "—";
    if (typeof v === "number") {
      return Math.abs(v) >= 1000 ? String(v) : (Math.round(v * 1000) / 1000);
    }
    return v;
  }

  function activeFilters() {
    return {
      scenario: document.getElementById("f-scenario").value,
      arm: document.getElementById("f-arm").value,
      model: document.getElementById("f-model").value,
      version: document.getElementById("f-version").value,
      text: document.getElementById("f-text").value.toLowerCase().trim()
    };
  }

  function filteredRows() {
    var f = activeFilters();
    return ROWS.filter(function (r) {
      if (f.scenario && r.scenario !== f.scenario) return false;
      if (f.arm && r.arm !== f.arm) return false;
      if (f.model && r.model !== f.model) return false;
      if (f.version && r.frameworkVersion !== f.version) return false;
      if (f.text) {
        var hay = (r.runId + " " + r.scenario + " " + r.arm + " " + r.model +
          " " + r.frameworkVersion + " " + r.benchmarkVersion + " " + envStr(r)).toLowerCase();
        if (hay.indexOf(f.text) === -1) return false;
      }
      return true;
    });
  }

  function sortRows(rows) {
    var col = COLUMNS.filter(function (c) { return c.key === sortKey; })[0] || COLUMNS[0];
    return rows.slice().sort(function (a, b) {
      var av = col.key === "env" ? envStr(a) : a[col.key];
      var bv = col.key === "env" ? envStr(b) : b[col.key];
      if (col.type === "num") {
        var an = (av === null || av === undefined) ? -Infinity : av;
        var bn = (bv === null || bv === undefined) ? -Infinity : bv;
        return (an - bn) * sortDir;
      }
      av = av || ""; bv = bv || "";
      return (av < bv ? -1 : av > bv ? 1 : 0) * sortDir;
    });
  }

  function renderTable() {
    var rows = sortRows(filteredRows());
    var thead = document.getElementById("idx-head");
    var tbody = document.getElementById("idx-body");
    thead.innerHTML = "";
    var tr = document.createElement("tr");
    COLUMNS.forEach(function (c) {
      var th = document.createElement("th");
      th.textContent = c.label;
      if (c.hint) th.title = c.hint;
      if (c.key === sortKey) th.className = sortDir === 1 ? "sorted-asc" : "sorted-desc";
      th.addEventListener("click", function () {
        if (sortKey === c.key) { sortDir = -sortDir; } else { sortKey = c.key; sortDir = 1; }
        renderTable();
      });
      tr.appendChild(th);
    });
    thead.appendChild(tr);

    tbody.innerHTML = "";
    var emptyEl = document.getElementById("idx-empty");
    emptyEl.style.display = rows.length === 0 ? "block" : "none";
    rows.forEach(function (r) {
      var trb = document.createElement("tr");
      trb.setAttribute("data-runid", r.runId);
      COLUMNS.forEach(function (c) {
        var td = document.createElement("td");
        td.textContent = cell(r, c.key);
        trb.appendChild(td);
      });
      trb.addEventListener("click", function () { openModal(r.runId); });
      tbody.appendChild(trb);
    });
  }

  // ---- modal ------------------------------------------------------------
  var GLOSS = {
    "Quality": "Higher is better (0–1). 1.0 = every frozen assertion passes and the LLM judge agrees.",
    "Planning fidelity": "Higher is better (0–1). How well the plan predicted reality; null for control (no plan authored).",
    "Autonomy": "Higher is better (0–1]. 1.0 = fully unattended; each human intervention lowers it (0.5 = one, 0.33 = two).",
    "Maintainability": "Higher is better (0–1). 1.0 = clean, well-structured, easy-to-change code; lower scores indicate complexity, poor naming, or structural debt.",
    "Security": "Higher is better (0–1). 1.0 = no known vulnerabilities or unsafe patterns; lower scores indicate secrets, injection risks, or other security findings.",
    "Efficiency": "Absolute cost vector — lower is cheaper: wall-clock ms, total tokens, dispatches, USD. Judge against Quality.",
    "Overhead ratio": "Lower is cheaper (≥0). Ceremony tokens per shippable-codegen token; control ≈ 0, so the gap is Mandrel's tax."
  };
  function rowById(id) {
    for (var i = 0; i < ROWS.length; i++) { if (ROWS[i].runId === id) return ROWS[i]; }
    return null;
  }
  function dimTable(obj) {
    if (!obj) return "<p class='empty'>—</p>";
    var html = "<table>";
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      html += "<tr><td>" + k + "</td><td>" + (v === null || v === undefined ? "—" : v) + "</td></tr>";
    });
    return html + "</table>";
  }
  function openModal(id) {
    var r = rowById(id);
    if (!r) return;
    var body = document.getElementById("modal-body");
    var dims = r.dimensions || {};
    var html = "<button class='close' aria-label='Close'>&times;</button>";
    html += "<h3></h3><div class='sub'></div>";
    var groups = [
      ["Quality", dims.quality], ["Planning fidelity", dims.planningFidelity],
      ["Autonomy", dims.autonomy], ["Maintainability", dims.maintainability],
      ["Security", dims.security], ["Efficiency", dims.efficiency],
      ["Overhead ratio", dims.overheadRatio]
    ];
    groups.forEach(function (g) {
      html += "<div class='dim-group'><h4></h4><p class='gloss'></p>" + dimTable(g[1]) + "</div>";
    });
    html += "<div class='links'></div>";
    body.innerHTML = html;
    body.querySelector("h3").textContent = r.runId;
    body.querySelector(".sub").textContent =
      r.scenario + " · " + r.arm + " · " + r.model + " @ " + r.frameworkVersion +
      " · bench " + r.benchmarkVersion + " · " + r.timestamp;
    var h4s = body.querySelectorAll(".dim-group h4");
    var glosses = body.querySelectorAll(".dim-group .gloss");
    for (var i = 0; i < h4s.length; i++) {
      h4s[i].textContent = groups[i][0];
      glosses[i].textContent = GLOSS[groups[i][0]] || "";
    }

    var links = body.querySelector(".links");
    var refs = r.rawRefs || {};
    function addLink(href, label) {
      if (!href) return;
      var a = document.createElement("a");
      a.href = href; a.textContent = label; a.target = "_blank"; a.rel = "noopener";
      links.appendChild(a);
    }
    if (refs.costEnvelope) addLink(refs.costEnvelope, "cost envelope");
    if (refs.lifecycleNdjson) addLink(refs.lifecycleNdjson, "lifecycle");
    if (refs.signalsNdjson) {
      refs.signalsNdjson.forEach(function (s, i) { addLink(s, "signals " + i); });
    }
    if (refs.acceptanceEvalVerdict) addLink(refs.acceptanceEvalVerdict, "verdict");
    // Link to this run's cohort Markdown report directory.
    if (r.reportsDir) addLink(r.reportsDir, "Markdown report");

    body.querySelector(".close").addEventListener("click", closeModal);
    document.getElementById("modal-backdrop").classList.add("open");
  }
  function closeModal() { document.getElementById("modal-backdrop").classList.remove("open"); }

  // ---- trend chart (x-axis = cohort/version) ----------------------------
  var selectedMetric = METRICS.length ? METRICS[0].key : null;
  var selectedModel = "";

  function visibleCohorts() {
    return COHORTS.filter(function (c) { return !selectedModel || c.model === selectedModel; });
  }
  function cohortValues(cohort, arm) {
    return ROWS.filter(function (r) {
      return r.arm === arm && r.model === cohort.model &&
        r.frameworkVersion === cohort.version &&
        r.benchmarkVersion === cohort.benchmarkVersion;
    }).map(function (r) { return r[selectedMetric]; });
  }

  function renderChart() {
    var host = document.getElementById("chart");
    var meta = metricMeta(selectedMetric);
    var cohorts = visibleCohorts();
    var arms = ["mandrel", "control"];
    var colors = { mandrel: "#6ea8fe", control: "#f0883e" };

    // Aggregate each cohort to one summary per arm (median + IQR).
    var data = cohorts.map(function (c) {
      return {
        cohort: c,
        mandrel: summarize(cohortValues(c, "mandrel")),
        control: summarize(cohortValues(c, "control"))
      };
    });
    var allVals = [];
    data.forEach(function (d) {
      arms.forEach(function (a) {
        if (d[a]) { allVals.push(d[a].q1, d[a].q3, d[a].median); }
      });
    });
    if (allVals.length === 0) {
      host.innerHTML = "<p class='empty'>No data for this metric / model.</p>";
      renderCaption(meta, []);
      return;
    }

    var W = 760, H = 300, padL = 64, padR = 16, padT = 16, padB = 56;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var nC = data.length;
    function x(i) { return padL + (nC === 1 ? plotW / 2 : (i / (nC - 1)) * plotW); }
    var minV = Math.min.apply(null, allVals);
    var maxV = Math.max.apply(null, allVals);
    if (minV === maxV) { minV = minV - 1; maxV = maxV + 1; }
    var pad = (maxV - minV) * 0.08;
    minV -= pad; maxV += pad;
    function y(v) { return padT + plotH - ((v - minV) / (maxV - minV)) * plotH; }

    var svg = "<svg viewBox='0 0 " + W + " " + H + "' role='img' aria-label='Trend over versions'>";
    // gridlines + y labels (min / mid / max)
    [minV, (minV + maxV) / 2, maxV].forEach(function (yv) {
      svg += "<line x1='" + padL + "' y1='" + y(yv).toFixed(1) + "' x2='" + (W - padR) + "' y2='" + y(yv).toFixed(1) + "' stroke='#1e2230'/>";
      svg += "<text x='" + (padL - 8) + "' y='" + (y(yv) + 3).toFixed(1) + "' fill='#9aa3b2' font-size='10' text-anchor='end'>" + fmtNum(yv) + "</text>";
    });
    // axes
    svg += "<line x1='" + padL + "' y1='" + padT + "' x2='" + padL + "' y2='" + (padT + plotH) + "' stroke='#2a2f3a'/>";
    svg += "<line x1='" + padL + "' y1='" + (padT + plotH) + "' x2='" + (W - padR) + "' y2='" + (padT + plotH) + "' stroke='#2a2f3a'/>";
    // y-axis direction hint
    if (meta && (meta.better === "higher" || meta.better === "lower")) {
      var dirTxt = meta.better === "higher" ? "▲ better" : "▼ better";
      var cy = (padT + plotH / 2).toFixed(1);
      svg += "<text x='14' y='" + cy + "' fill='#9aa3b2' font-size='10' text-anchor='middle' transform='rotate(-90 14 " + cy + ")'>" + dirTxt + "</text>";
    }
    // x ticks: framework version, plus a benchmark-version sub-line when more
    // than one benchmark version is in view (so distinct-bench cohorts sharing
    // a framework version read apart), plus a model sub-line when multi-model.
    var multiModel = uniq(cohorts.map(function (c) { return c.model; })).length > 1;
    var multiBench = uniq(cohorts.map(function (c) { return c.benchmarkVersion; })).length > 1;
    data.forEach(function (d, i) {
      var px = x(i).toFixed(1);
      var yb = padT + plotH + 18;
      svg += "<text x='" + px + "' y='" + yb + "' fill='#9aa3b2' font-size='10' text-anchor='middle'>" + d.cohort.version + "</text>";
      if (multiBench) { yb += 12; svg += "<text x='" + px + "' y='" + yb + "' fill='#6b7280' font-size='9' text-anchor='middle'>bench " + d.cohort.benchmarkVersion + "</text>"; }
      if (multiModel) { yb += 12; svg += "<text x='" + px + "' y='" + yb + "' fill='#6b7280' font-size='9' text-anchor='middle'>" + d.cohort.model + "</text>"; }
    });
    svg += "<text x='" + (padL + plotW / 2).toFixed(1) + "' y='" + (H - 6) + "' fill='#6b7280' font-size='10' text-anchor='middle'>framework version" + (multiBench ? " / benchmark version" : "") + (multiModel ? " / model" : "") + "</text>";

    // series: per-arm segmented line over medians (break when model changes) +
    // IQR whisker + median dot per cohort.
    arms.forEach(function (arm) {
      var pts = [];
      data.forEach(function (d, i) { if (d[arm]) pts.push({ i: i, s: d[arm], model: d.cohort.model }); });
      for (var k = 0; k < pts.length; k++) {
        var p = pts[k];
        var px = x(p.i);
        if (k > 0 && pts[k - 1].model === p.model) {
          var q = pts[k - 1];
          svg += "<line x1='" + x(q.i).toFixed(2) + "' y1='" + y(q.s.median).toFixed(2) +
            "' x2='" + px.toFixed(2) + "' y2='" + y(p.s.median).toFixed(2) +
            "' stroke='" + colors[arm] + "' stroke-width='2'/>";
        }
        if (p.s.q3 !== p.s.q1) {
          svg += "<line x1='" + px.toFixed(2) + "' y1='" + y(p.s.q1).toFixed(2) +
            "' x2='" + px.toFixed(2) + "' y2='" + y(p.s.q3).toFixed(2) +
            "' stroke='" + colors[arm] + "' stroke-width='1' opacity='0.5'/>";
        }
        svg += "<circle cx='" + px.toFixed(2) + "' cy='" + y(p.s.median).toFixed(2) +
          "' r='4' fill='" + colors[arm] + "'><title>" + arm + " · " + data[p.i].cohort.version +
          " · median " + fmtNum(p.s.median) + " (n=" + p.s.n + ", IQR " + fmtNum(p.s.q1) + "–" + fmtNum(p.s.q3) + ")</title></circle>";
      }
    });
    svg += "</svg>";
    host.innerHTML = svg;

    renderCaption(meta, data);
  }

  function renderCaption(meta, data) {
    var capEl = document.getElementById("chart-caption");
    var deltaEl = document.getElementById("chart-delta");
    if (!capEl || !deltaEl) return;
    if (!meta) { capEl.textContent = ""; deltaEl.innerHTML = ""; return; }
    var sideTxt = meta.side === "value"
      ? "value side (what the scaffolding buys)"
      : "cost side (what the scaffolding charges)";
    var dirTxt = meta.better === "higher" ? "▲ higher is better"
      : meta.better === "lower" ? "▼ lower is cheaper" : "";
    capEl.innerHTML = "";
    var strong = document.createElement("span");
    strong.className = "pill";
    strong.textContent = meta.label + " — " + sideTxt + " · range " + meta.range + " · " + dirTxt + ". ";
    capEl.appendChild(strong);
    capEl.appendChild(document.createTextNode(meta.good));

    // Delta vs control on the most recent visible cohort with both arms.
    deltaEl.innerHTML = "";
    if (meta.deltaExempt) {
      // Epic #66, Story #77/#79: autonomy is a mandrel-arm GUARDRAIL against
      // a cohort threshold, never a mandrel-vs-control delta — the bare
      // control's zero-intervention baseline is defined, not measured, so a
      // delta badge here would misrepresent it as a comparison. See the
      // "Autonomy guardrail" panel below the run index for the real verdict.
      var note = document.createElement("span");
      note.className = "delta";
      note.textContent = "Guardrail metric — see the Autonomy guardrail panel below, not a mandrel-vs-control delta.";
      deltaEl.appendChild(note);
      return;
    }
    var latest = null;
    for (var i = data.length - 1; i >= 0; i--) {
      if (data[i].mandrel && data[i].control) { latest = data[i]; break; }
    }
    if (!latest) return;
    var m = latest.mandrel.median, c = latest.control.median;
    var diff = m - c;
    var better = meta.better === "higher" ? diff > 0
      : meta.better === "lower" ? diff < 0 : null;
    var cls = diff === 0 ? "" : (better ? "good" : "bad");
    var arrow = diff === 0 ? "=" : (diff > 0 ? "▲" : "▼");
    var verdict = diff === 0 ? "no difference"
      : better ? "mandrel better" : "mandrel worse";
    var span = document.createElement("span");
    span.className = "delta " + cls;
    span.textContent = "Latest cohort " + latest.cohort.version + " — mandrel " + fmtNum(m) +
      " vs control " + fmtNum(c) + "  " + arrow + " " + fmtNum(Math.abs(diff)) + " (" + verdict + ")";
    deltaEl.appendChild(span);
  }

  function renderMetricButtons() {
    var host = document.getElementById("metric-btns");
    host.innerHTML = "";
    METRICS.forEach(function (m) {
      var b = document.createElement("button");
      b.textContent = m.label;
      b.title = (m.side === "value" ? "Value side · " : "Cost side · ") +
        (m.better === "higher" ? "higher is better" : "lower is cheaper");
      if (m.key === selectedMetric) b.className = "active";
      b.addEventListener("click", function () { selectedMetric = m.key; renderMetricButtons(); renderChart(); });
      host.appendChild(b);
    });
  }

  // ---- wire up ----------------------------------------------------------
  function fillSelect(id, values) {
    var sel = document.getElementById(id);
    values.forEach(function (v) {
      var o = document.createElement("option"); o.value = v; o.textContent = v;
      sel.appendChild(o);
    });
  }
  fillSelect("f-scenario", uniq(ROWS.map(function (r) { return r.scenario; })));
  fillSelect("f-arm", uniq(ROWS.map(function (r) { return r.arm; })));
  fillSelect("f-model", uniq(ROWS.map(function (r) { return r.model; })));
  fillSelect("f-version", uniq(ROWS.map(function (r) { return r.frameworkVersion; })));
  ["f-scenario", "f-arm", "f-model", "f-version", "f-text"].forEach(function (id) {
    var el = document.getElementById(id);
    el.addEventListener("input", renderTable);
    el.addEventListener("change", renderTable);
  });

  var modelSel = document.getElementById("chart-model");
  fillSelect("chart-model", MODELS);
  modelSel.addEventListener("change", function () { selectedModel = modelSel.value; renderChart(); });

  document.getElementById("modal-backdrop").addEventListener("click", function (e) {
    if (e.target === this) closeModal();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeModal(); });

  renderMetricButtons();
  renderChart();
  renderTable();
})();
`;

/**
 * Server-rendered, static (non-interactive) "Autonomy guardrail" panel
 * (Epic #66, Story #77/#79): per-scenario met/dropped/unmeasured counts for
 * the mandrel-arm autonomy guardrail. Deterministic; reuses
 * `bench/report/render.js`'s `autonomyGuardrailRows` so the dashboard and the
 * Markdown report never diverge on this verdict.
 *
 * @param {Array<object>} rows  `autonomyGuardrailRows` output.
 * @returns {string}
 */
function renderGuardrailSection(rows) {
  const body = rows.length
    ? rows
        .map(
          (r) =>
            `<tr><td>${esc(r.scenario)}</td><td>${r.n}</td><td>${r.met}</td><td>${r.dropped}</td><td>${r.unmeasured}</td><td>${r.threshold ?? '—'}</td></tr>`,
        )
        .join('')
    : '';
  return `<section>
<h2>Autonomy guardrail (mandrel arm)</h2>
<div class="sub">Autonomy is a pass/fail guardrail against a cohort threshold (default 0.99) — never a mandrel-vs-control delta (Epic #66, Story #77/#79): the bare control arm's zero-intervention baseline is defined, not measured, so a delta against it was never a meaningful comparison. A drop below threshold is itself a finding.</div>
<div class="panel">
${
  rows.length
    ? `<table><thead><tr><th>Scenario</th><th>n</th><th>Met</th><th>Dropped</th><th>Unmeasured</th><th>Threshold</th></tr></thead><tbody>${body}</tbody></table>`
    : '<div class="empty">No mandrel-arm runs to evaluate.</div>'
}
</div>
</section>`;
}

/**
 * Server-rendered, static "Trap axis" panel (Epic #66, Story #74/#79):
 * per-class trap-oracle scores and `cleanRate`, as mean/spread/min
 * distributions per arm, in a section clearly separate from the seven
 * composite dimensions. Reuses `bench/report/render.js`'s `trapAxisRows` so
 * the dashboard and the Markdown report share one interpretation.
 *
 * @param {Array<{ scenario: string, rows: Array<object> }>} trapAxis
 * @returns {string}
 */
function renderTrapAxisSectionHtml(trapAxis) {
  const fmtStat = formatTrapStat;
  const scenarioBlocks = trapAxis
    .map((s) => {
      const rows = s.rows
        .map(
          (r) =>
            `<tr><td>${esc(r.label)}</td><td>${fmtStat(r.mandrel)}</td><td>${fmtStat(r.control)}</td></tr>`,
        )
        .join('');
      return `<h3>${esc(s.scenario)}</h3><table><thead><tr><th>Class</th><th>Mandrel</th><th>Control</th></tr></thead><tbody>${rows}</tbody></table>`;
    })
    .join('');
  return `<section>
<h2>Trap axis (differential — separate from the seven dimensions)</h2>
<div class="sub">Per-class adversarial trap-oracle verdicts the frozen suite is blind to, plus <code>cleanRate</code> (the mean of the declared classes). Higher is better (1 = clean, 0 = planted defect present). Never folded into the seven composite dimensions (Epic #66, Story #74/#79).</div>
<div class="panel trap-axis">
${trapAxis.length ? scenarioBlocks : '<div class="empty">No scenario in this corpus declares a trap class.</div>'}
</div>
</section>`;
}

/**
 * Server-rendered, static "Per-phase cost" panel (D-019, Epic #86 Story #94):
 * the mandrel arm's `/plan` vs `/deliver` mean USD cost per scenario, so a
 * reader sees which half of the pipeline the cost went to. Mandrel-only by
 * construction (the control arm is a single session and carries no `phases`).
 * Reuses `render.js`'s `phaseCostRows` so the dashboard and the Markdown report
 * share one interpretation.
 *
 * @param {Array<{ scenario: string, n: number, planCostUsd: number|null, deliverCostUsd: number|null, totalCostUsd: number|null }>} rows
 * @returns {string}
 */
function renderPhaseCostSectionHtml(rows) {
  const usd = (v) =>
    typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(4)) : '—';
  const body = (rows ?? [])
    .map(
      (r) =>
        `<tr><td>${esc(r.scenario)}</td><td>${r.n}</td><td>${usd(r.planCostUsd)}</td><td>${usd(r.deliverCostUsd)}</td><td>${usd(r.totalCostUsd)}</td></tr>`,
    )
    .join('');
  return `<section>
<h2>Per-phase cost (mandrel arm)</h2>
<div class="sub">The mandrel arm runs <code>/plan</code> and <code>/deliver</code> as two separate headless sessions (D-019), so cost is attributable to the planning half vs the delivery half. Mean USD cost per phase across the cell's mandrel runs; the control arm is a single session and carries no per-phase split.</div>
<div class="panel">
${
  rows && rows.length
    ? `<table><thead><tr><th>Scenario</th><th>n</th><th>Plan cost (USD)</th><th>Deliver cost (USD)</th><th>Total (USD)</th></tr></thead><tbody>${body}</tbody></table>`
    : '<div class="empty">No mandrel-arm records carry a per-phase cost split.</div>'
}
</div>
</section>`;
}

/**
 * Server-rendered, static "Continuity delta" panel (Epic #86, Story #96): the
 * mandrel-vs-control delta of the second change's outcome + cost per scenario —
 * the persistence-thesis measurement. Reuses `render.js`'s `continuityRows` so
 * the dashboard and the Markdown report share one interpretation. Only
 * scenarios carrying touch-2 data appear.
 *
 * @param {Array<{ scenario: string, rows: Array<object> }>} continuity
 * @returns {string}
 */
function renderContinuitySectionHtml(continuity) {
  const num = (v) =>
    typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(3)) : '—';
  const scenarioBlocks = (continuity ?? [])
    .map((s) => {
      const rows = s.rows
        .map(
          (r) =>
            `<tr><td>${esc(r.label)}</td><td>${num(r.mandrelCenter)}</td><td>${num(r.controlCenter)}</td><td>${num(r.delta)}</td><td>${esc(r.verdict)}</td></tr>`,
        )
        .join('');
      return `<h3>${esc(s.scenario)}</h3><table><thead><tr><th>Metric</th><th>Mandrel</th><th>Control</th><th>&Delta; (M&minus;C)</th><th>Verdict</th></tr></thead><tbody>${rows}</tbody></table>`;
    })
    .join('');
  return `<section>
<h2>Continuity delta (the second touch)</h2>
<div class="sub">Mandrel-vs-control delta of the FROZEN change request scored against the delivered tree — mandrel inherits its full pipeline output, control inherits delivered code only. Positive outcome delta / negative cost delta favour Mandrel. The persistence-thesis measurement (Epic #86, Story #96); never folded into the seven composite dimensions.</div>
<div class="panel continuity">
${continuity && continuity.length ? scenarioBlocks : '<div class="empty">No scenario in this corpus carries a scored second touch.</div>'}
</div>
</section>`;
}

/**
 * Render the self-contained dashboard HTML for the aggregated scorecard corpus.
 *
 * @param {object} args
 * @param {Array<object>} args.scorecards  The aggregated corpus (every run
 *   across every cohort). May be empty — an empty corpus renders a valid,
 *   non-crashing empty dashboard.
 * @returns {string}  One self-contained HTML document string. Deterministic for
 *   a given corpus.
 */
export function renderDashboard({ scorecards } = {}) {
  if (!Array.isArray(scorecards)) {
    throw new TypeError('renderDashboard: scorecards must be an array');
  }
  const model = buildDashboardModel(scorecards);
  const count = model.rows.length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mandrel Self-Benchmark — Results Dashboard</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>Mandrel Self-Benchmark — Results Dashboard</h1>
<div class="sub">Generated artifact (Epic #2). ${esc(count)} run(s) across every cohort. Pure, deterministic, zero-dependency — regenerated at the end of every <code>bench/run.js</code> run.</div>
</header>
<main>
<section>
<h2>Trend over framework versions</h2>
<details class="help">
<summary>How to read this chart</summary>
<ul>
<li>The <b>x-axis is the framework version</b> (one point per cohort), oldest on the left. When more than one model is in view a second tick line shows the model, and the line breaks across a model change — we never draw a cross-model "trend" (only like-model-to-like is comparable).</li>
<li>Each point is the <b>median</b> across that cohort's N runs for one arm; the faint vertical bar is the <b>inter-quartile (Q1–Q3) spread</b>. Hover a point for n and the exact band.</li>
<li><b><span class="up">mandrel</span></b> = clone carries <code>.agents/</code> and runs <code>/plan</code>→<code>/deliver</code>; <b>control</b> = bare task prompt, no scaffolding. The gap between the two arms is what the scaffolding buys (value) or charges (cost).</li>
<li><b>Value side</b> (Quality, Autonomy, Maintainability, Security) — <b>higher is better</b>. <b>Cost side</b> (Tokens, USD, Overhead ratio) — <b>lower is cheaper</b>; cheaper only "wins" at equal quality. The caption under the chart states the direction and what good looks like for the selected metric.</li>
</ul>
</details>
<div class="controls">
<label for="chart-model">Model</label>
<select id="chart-model"><option value="">All models</option></select>
<div class="metric-btns" id="metric-btns"></div>
</div>
<div class="panel"><div id="chart"></div>
<div class="legend"><span class="mandrel">mandrel</span><span class="control">control</span></div>
<div class="metric-caption" id="chart-caption"></div>
<div class="delta-readout" id="chart-delta"></div>
</div>
</section>
<section>
<h2>Run index</h2>
<details class="help">
<summary>What the dimension numbers mean</summary>
<ul>
<li><b>Quality</b> (value · 0–1 · ▲ better) — fraction of the frozen acceptance suite that passes, cross-checked by an LLM judge. 1.0 = fully correct; 0 = no runnable app.</li>
<li><b>Planning</b> (value · 0–1 · ▲ better) — how well the plan predicted reality (story-count, re-plan, file-footprint). <code>—</code> for control: it authors no plan.</li>
<li><b>Autonomy</b> (value · 0–1 · ▲ better) — 1.0 = fully unattended; each human intervention drops it (0.5 = one, 0.33 = two). Any value &lt; 1.0 is a finding.</li>
<li><b>Maintainability</b> (value · 0–1 · ▲ better) — 1.0 = clean, well-structured, easy-to-change code; lower scores indicate complexity or structural debt.</li>
<li><b>Security</b> (value · 0–1 · ▲ better) — 1.0 = no known vulnerabilities or unsafe patterns; lower scores indicate secrets, injection risks, or other findings.</li>
<li><b>Tokens</b> (cost · ▼ cheaper) — total tokens the run spent. Lower is cheaper, but only meaningful at equal Quality.</li>
<li><b>Overhead</b> (cost · ▼ cheaper) — ceremony tokens per shippable-codegen token. Control ≈ 0; the mandrel−control gap is the ceremony tax.</li>
</ul>
</details>
<div class="controls">
<label for="f-scenario">Scenario</label>
<select id="f-scenario"><option value="">all</option></select>
<label for="f-arm">Arm</label>
<select id="f-arm"><option value="">all</option></select>
<label for="f-model">Model</label>
<select id="f-model"><option value="">all</option></select>
<label for="f-version">Version</label>
<select id="f-version"><option value="">all</option></select>
<input type="text" id="f-text" placeholder="free-text filter…">
</div>
<div class="panel">
<table><thead id="idx-head"></thead><tbody id="idx-body"></tbody></table>
<div class="empty" id="idx-empty" style="display:none">No runs match the current filters.</div>
</div>
</section>
${renderGuardrailSection(model.guardrail)}
${renderPhaseCostSectionHtml(model.phaseCost)}
${renderTrapAxisSectionHtml(model.trapAxis)}
${renderContinuitySectionHtml(model.continuity)}
</main>
<div class="modal-backdrop" id="modal-backdrop">
<div class="modal" id="modal" role="dialog" aria-modal="true"><div id="modal-body"></div></div>
</div>
<script type="application/json" id="corpus">${safeJson(model)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
