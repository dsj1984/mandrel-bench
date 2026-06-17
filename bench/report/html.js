// bench/report/html.js
//
// The browsable dashboard for the Mandrel self-benchmark harness
// (Epic #2, Story #17). Internal tooling only — never shipped in the
// distributed `.agents/` bundle, never run against the live repo.
//
// `renderDashboard({ scorecards })` turns the aggregated scorecard corpus (every
// run across every cohort) into ONE self-contained `results.html` string with:
//
//   1. An over-time TREND CHART (inline SVG) of the headline metrics — quality,
//      autonomy, efficiency total-tokens & cost, and overhead ratio — one series
//      per arm, filterable by cohort (model + framework version).
//   2. A sortable + filterable INDEX TABLE of every run (timestamp, scenario,
//      arm, model, frameworkVersion, the five dimension headlines, env) — sort
//      by any header, filter by scenario / arm / model / version + free text.
//   3. An in-page MODAL opened by clicking a row, showing the full per-dimension
//      breakdown and links to that run's `.raw/` artifacts and Markdown report.
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

/**
 * The headline metrics the trend chart plots, each with a label, a unit hint,
 * and a pure accessor onto a scorecard. Kept in module scope so the
 * server-side row projection and the client-side chart agree on exactly one set
 * of headlines (no second, divergent interpretation — Story out-of-scope rule).
 */
const HEADLINE_METRICS = Object.freeze([
  {
    key: 'quality',
    label: 'Quality',
    get: (sc) => sc?.dimensions?.quality?.score,
  },
  {
    key: 'autonomy',
    label: 'Autonomy',
    get: (sc) => sc?.dimensions?.autonomy?.score,
  },
  {
    key: 'totalTokens',
    label: 'Total tokens',
    get: (sc) => sc?.dimensions?.efficiency?.totalTokens,
  },
  {
    key: 'costUsd',
    label: 'Cost (USD)',
    get: (sc) => sc?.dimensions?.efficiency?.costUsd,
  },
  {
    key: 'overheadRatio',
    label: 'Overhead ratio',
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
    env: {
      node: typeof sc?.env?.node === 'string' ? sc.env.node : '',
      os: typeof sc?.env?.os === 'string' ? sc.env.os : '',
      host: typeof sc?.env?.host === 'string' ? sc.env.host : '',
    },
    // Index headlines (the five dimension headlines).
    quality: num(dims?.quality?.score),
    planningFidelity: num(dims?.planningFidelity?.score),
    autonomy: num(dims?.autonomy?.score),
    totalTokens: num(dims?.efficiency?.totalTokens),
    costUsd: num(dims?.efficiency?.costUsd),
    overheadRatio: num(dims?.overheadRatio?.tokenRatio),
    // Full per-dimension breakdown for the modal (the raw dimension objects).
    dimensions: {
      quality: dims?.quality ?? null,
      planningFidelity: dims?.planningFidelity ?? null,
      autonomy: dims?.autonomy ?? null,
      efficiency: dims?.efficiency ?? null,
      overheadRatio: dims?.overheadRatio ?? null,
    },
    rawRefs: sc?.rawRefs ?? null,
  };
}

/**
 * Build the JSON-safe corpus model the dashboard inlines: the projected rows
 * (sorted by timestamp then runId for a stable, diffable order) and the
 * headline-metric metadata the client chart reads. Pure.
 *
 * @param {Array<object>} scorecards
 * @returns {{ rows: object[], metrics: Array<{ key: string, label: string }> }}
 */
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
  const metrics = HEADLINE_METRICS.map(({ key, label }) => ({ key, label }));
  return { rows, metrics };
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
.dim-group h4 { margin: 0 0 6px; font-size: 13px; color: var(--accent); }
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
 */
const SCRIPT = `
"use strict";
(function () {
  var dataEl = document.getElementById("corpus");
  var MODEL = dataEl ? JSON.parse(dataEl.textContent) : { rows: [], metrics: [] };
  var ROWS = MODEL.rows || [];
  var METRICS = MODEL.metrics || [];

  // ---- shared cohort + filter state -------------------------------------
  function uniq(vals) {
    var seen = {}; var out = [];
    vals.forEach(function (v) { if (v !== "" && !seen[v]) { seen[v] = 1; out.push(v); } });
    out.sort();
    return out;
  }
  var COHORTS = uniq(ROWS.map(function (r) { return r.model + " @ " + r.frameworkVersion; }));

  // ---- index table ------------------------------------------------------
  var COLUMNS = [
    { key: "timestamp", label: "Timestamp", type: "str" },
    { key: "scenario", label: "Scenario", type: "str" },
    { key: "arm", label: "Arm", type: "str" },
    { key: "model", label: "Model", type: "str" },
    { key: "frameworkVersion", label: "Version", type: "str" },
    { key: "quality", label: "Quality", type: "num" },
    { key: "planningFidelity", label: "Planning", type: "num" },
    { key: "autonomy", label: "Autonomy", type: "num" },
    { key: "totalTokens", label: "Tokens", type: "num" },
    { key: "overheadRatio", label: "Overhead", type: "num" },
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
          " " + r.frameworkVersion + " " + envStr(r)).toLowerCase();
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
      ["Autonomy", dims.autonomy], ["Efficiency", dims.efficiency],
      ["Overhead ratio", dims.overheadRatio]
    ];
    groups.forEach(function (g) {
      html += "<div class='dim-group'><h4></h4>" + dimTable(g[1]) + "</div>";
    });
    html += "<div class='links'></div>";
    body.innerHTML = html;
    body.querySelector("h3").textContent = r.runId;
    body.querySelector(".sub").textContent =
      r.scenario + " · " + r.arm + " · " + r.model + " @ " + r.frameworkVersion +
      " · " + r.timestamp;
    var h4s = body.querySelectorAll(".dim-group h4");
    for (var i = 0; i < h4s.length; i++) h4s[i].textContent = groups[i][0];

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

  // ---- trend chart ------------------------------------------------------
  var selectedMetric = METRICS.length ? METRICS[0].key : null;
  var selectedCohort = "";

  function chartRows() {
    return ROWS.filter(function (r) {
      if (!selectedCohort) return true;
      return (r.model + " @ " + r.frameworkVersion) === selectedCohort;
    });
  }
  function renderChart() {
    var host = document.getElementById("chart");
    var rows = chartRows();
    var arms = ["mandrel", "control"];
    var colors = { mandrel: "#6ea8fe", control: "#f0883e" };
    var W = 760, H = 280, padL = 56, padR = 16, padT = 16, padB = 36;
    var series = {};
    var allVals = [];
    arms.forEach(function (arm) {
      var pts = rows.filter(function (r) { return r.arm === arm; })
        .map(function (r) { return { t: r.timestamp, v: r[selectedMetric] }; })
        .filter(function (p) { return p.v !== null && p.v !== undefined; })
        .sort(function (a, b) { return a.t < b.t ? -1 : a.t > b.t ? 1 : 0; });
      series[arm] = pts;
      pts.forEach(function (p) { allVals.push(p.v); });
    });
    if (allVals.length === 0) {
      host.innerHTML = "<p class='empty'>No data for this metric / cohort.</p>";
      return;
    }
    var n = Math.max.apply(null, arms.map(function (a) { return series[a].length; }));
    var maxX = Math.max(1, n - 1);
    var minV = Math.min.apply(null, allVals);
    var maxV = Math.max.apply(null, allVals);
    if (minV === maxV) { minV = minV - 1; maxV = maxV + 1; }
    var plotW = W - padL - padR, plotH = H - padT - padB;
    function x(i) { return padL + (maxX === 0 ? plotW / 2 : (i / maxX) * plotW); }
    function y(v) { return padT + plotH - ((v - minV) / (maxV - minV)) * plotH; }

    var svg = "<svg viewBox='0 0 " + W + " " + H + "' role='img' aria-label='Trend chart'>";
    // axes
    svg += "<line x1='" + padL + "' y1='" + padT + "' x2='" + padL + "' y2='" + (padT + plotH) + "' stroke='#2a2f3a'/>";
    svg += "<line x1='" + padL + "' y1='" + (padT + plotH) + "' x2='" + (W - padR) + "' y2='" + (padT + plotH) + "' stroke='#2a2f3a'/>";
    // y labels (min / max)
    svg += "<text x='" + (padL - 6) + "' y='" + (padT + 4) + "' fill='#9aa3b2' font-size='10' text-anchor='end'>" + fmtNum(maxV) + "</text>";
    svg += "<text x='" + (padL - 6) + "' y='" + (padT + plotH) + "' fill='#9aa3b2' font-size='10' text-anchor='end'>" + fmtNum(minV) + "</text>";
    arms.forEach(function (arm) {
      var pts = series[arm];
      if (pts.length === 0) return;
      var d = "";
      pts.forEach(function (p, i) {
        var px = x(i), py = y(p.v);
        d += (i === 0 ? "M" : "L") + px.toFixed(2) + " " + py.toFixed(2) + " ";
      });
      if (pts.length > 1) {
        svg += "<path d='" + d + "' fill='none' stroke='" + colors[arm] + "' stroke-width='2'/>";
      }
      pts.forEach(function (p, i) {
        svg += "<circle cx='" + x(i).toFixed(2) + "' cy='" + y(p.v).toFixed(2) +
          "' r='3.5' fill='" + colors[arm] + "'><title>" + arm + ": " + p.v + "</title></circle>";
      });
    });
    svg += "</svg>";
    host.innerHTML = svg;
  }
  function fmtNum(v) {
    if (Math.abs(v) >= 1000) return String(Math.round(v));
    return String(Math.round(v * 1000) / 1000);
  }
  function renderMetricButtons() {
    var host = document.getElementById("metric-btns");
    host.innerHTML = "";
    METRICS.forEach(function (m) {
      var b = document.createElement("button");
      b.textContent = m.label;
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

  var cohortSel = document.getElementById("chart-cohort");
  fillSelect("chart-cohort", COHORTS);
  cohortSel.addEventListener("change", function () { selectedCohort = cohortSel.value; renderChart(); });

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
<h2>Trend over time</h2>
<div class="controls">
<label for="chart-cohort">Cohort</label>
<select id="chart-cohort"><option value="">All cohorts</option></select>
<div class="metric-btns" id="metric-btns"></div>
</div>
<div class="panel"><div id="chart"></div>
<div class="legend"><span class="mandrel">mandrel</span><span class="control">control</span></div>
</div>
</section>
<section>
<h2>Run index</h2>
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
