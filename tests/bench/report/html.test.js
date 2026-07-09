// tests/bench/report/html.test.js
//
// Unit tier (pure renderer, no I/O) for the dashboard HTML renderer
// (Epic #2, Story #17). Exercises bench/report/html.js against the Story's
// binding acceptance items:
//   - renderDashboard returns ONE self-contained HTML string, deterministic for
//     a given corpus (no clock, no randomness);
//   - the corpus is inlined as JSON and the dashboard carries the trend-chart
//     metrics, an index row per run, and the per-dimension modal detail;
//   - an empty corpus renders a valid, non-crashing (empty) dashboard.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDashboardModel,
  renderDashboard,
  toRow,
} from '../../../bench/report/html.js';

function card(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: 'hw-mandrel-r1',
    timestamp: '2026-06-16T19:42:11.000Z',
    model: { id: 'claude-opus-4-8[1m]' },
    frameworkVersion: '1.70.0',
    benchmarkVersion: '0.5.0',
    env: { node: 'v24.16.0', os: 'darwin', host: 'h' },
    scenario: 'hello-world',
    arm: 'mandrel',
    dimensions: {
      quality: {
        score: 1,
        frozenSuitePassRate: 1,
        frozenSuitePassed: 3,
        frozenSuiteTotal: 3,
        acceptanceEvalScore: 1,
      },
      planningFidelity: {
        score: 0.9,
        plannedStoryCount: 1,
        deliveredStoryCount: 1,
      },
      autonomy: {
        score: 0.5,
        hitlStops: 0,
        blockedEvents: 1,
        manualRescues: 0,
      },
      maintainability: { score: 0.85 },
      security: { score: 0.95 },
      efficiency: {
        wallClockMs: 1000,
        totalTokens: 7657338,
        dispatches: 1,
        costUsd: 8.6,
      },
      overheadRatio: { tokenRatio: 0.58 },
    },
    rawRefs: {
      lifecycleNdjson: '.raw/hw-mandrel-r1/lifecycle.ndjson',
      signalsNdjson: ['.raw/hw-mandrel-r1/signals-0.ndjson'],
      costEnvelope: '.raw/hw-mandrel-r1/cost-envelope.json',
    },
    ...overrides,
  };
}

const CONTROL = card({
  runId: 'hw-control-r1',
  arm: 'control',
  timestamp: '2026-06-16T18:00:00.000Z',
  dimensions: {
    quality: { score: 1, frozenSuitePassRate: 1 },
    planningFidelity: { score: null },
    autonomy: { score: 1, hitlStops: 0, blockedEvents: 0, manualRescues: 0 },
    efficiency: {
      wallClockMs: 500,
      totalTokens: 89398,
      dispatches: 0,
      costUsd: 0.16,
    },
    overheadRatio: { tokenRatio: 0 },
  },
  rawRefs: { costEnvelope: '.raw/hw-control-r1/cost-envelope.json' },
});

describe('toRow', () => {
  it('projects index headlines + full dimension breakdown + refs', () => {
    const row = toRow(card());
    assert.equal(row.runId, 'hw-mandrel-r1');
    assert.equal(row.model, 'claude-opus-4-8[1m]');
    // The slugified cohort reports dir (link to this run's Markdown report).
    assert.equal(row.reportsDir, 'claude-opus-4-8-1m/1.70.0/reports/');
    assert.equal(row.quality, 1);
    assert.equal(row.autonomy, 0.5);
    assert.equal(row.maintainability, 0.85);
    assert.equal(row.security, 0.95);
    assert.equal(row.totalTokens, 7657338);
    assert.equal(row.costUsd, 8.6);
    assert.equal(row.overheadRatio, 0.58);
    // Full breakdown for the modal.
    assert.equal(row.dimensions.efficiency.dispatches, 1);
    assert.equal(row.dimensions.autonomy.blockedEvents, 1);
    assert.equal(row.dimensions.maintainability.score, 0.85);
    assert.equal(row.dimensions.security.score, 0.95);
    assert.deepEqual(row.rawRefs.signalsNdjson, [
      '.raw/hw-mandrel-r1/signals-0.ndjson',
    ]);
    // D-014: the projected row carries benchmarkVersion so the client trend
    // view can key cohorts on the full stamp.
    assert.equal(row.benchmarkVersion, '0.5.0');
  });

  it('coerces non-finite / missing metrics to null', () => {
    const row = toRow({ model: {}, dimensions: {} });
    assert.equal(row.quality, null);
    assert.equal(row.costUsd, null);
    assert.equal(row.model, '');
    // A record with no benchmarkVersion projects to '' (never undefined).
    assert.equal(row.benchmarkVersion, '');
  });
});

describe('buildDashboardModel', () => {
  it('sorts rows by timestamp then runId and lists the headline metrics', () => {
    const model = buildDashboardModel([card(), CONTROL]);
    assert.deepEqual(
      model.rows.map((r) => r.runId),
      ['hw-control-r1', 'hw-mandrel-r1'],
    );
    const keys = model.metrics.map((m) => m.key);
    for (const k of [
      'quality',
      'autonomy',
      'maintainability',
      'security',
      'totalTokens',
      'costUsd',
      'overheadRatio',
    ]) {
      assert.ok(keys.includes(k), `metrics should include ${k}`);
    }
    // Maintainability and security are value-side, higher-is-better.
    const maint = model.metrics.find((m) => m.key === 'maintainability');
    assert.equal(maint.side, 'value');
    assert.equal(maint.better, 'higher');
    const sec = model.metrics.find((m) => m.key === 'security');
    assert.equal(sec.side, 'value');
    assert.equal(sec.better, 'higher');
  });

  it('throws on a non-array corpus', () => {
    assert.throws(() => buildDashboardModel(null), /must be an array/);
  });
});

describe('renderDashboard', () => {
  it('returns one self-contained HTML document', () => {
    const html = renderDashboard({ scorecards: [card(), CONTROL] });
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<\/html>\s*$/);
    // self-contained: no external script/style/link references.
    assert.ok(!/<script[^>]+src=/.test(html), 'no external script src');
    assert.ok(
      !/<link[^>]+rel=["']stylesheet/.test(html),
      'no external stylesheet',
    );
    assert.ok(
      !/https?:\/\//.test(html.replace(/rel=["']noopener["']/g, '')),
      'no network URLs',
    );
  });

  it('inlines the corpus as JSON', () => {
    const html = renderDashboard({ scorecards: [card(), CONTROL] });
    assert.match(html, /<script type="application\/json" id="corpus">/);
    // Both run ids appear in the inlined corpus.
    assert.ok(html.includes('hw-mandrel-r1'));
    assert.ok(html.includes('hw-control-r1'));
  });

  it('carries the trend-chart metrics, index table, and modal scaffolding', () => {
    const html = renderDashboard({ scorecards: [card(), CONTROL] });
    // Trend chart: both arms in the legend + the metric series keys inlined.
    assert.ok(html.includes('id="chart"'));
    assert.ok(html.includes('mandrel') && html.includes('control'));
    assert.ok(html.includes('"overheadRatio"'));
    // Maintainability and security appear as value-side headline metric keys.
    assert.ok(
      html.includes('"maintainability"'),
      'dashboard inlines maintainability metric key',
    );
    assert.ok(
      html.includes('"security"'),
      'dashboard inlines security metric key',
    );
    // Index table scaffolding.
    assert.ok(html.includes('id="idx-head"') && html.includes('id="idx-body"'));
    // Modal scaffolding + per-dimension breakdown wiring.
    assert.ok(html.includes('id="modal"') && html.includes('id="modal-body"'));
    assert.ok(html.includes('Planning fidelity'));
    assert.ok(
      html.includes('Maintainability'),
      'modal groups include Maintainability',
    );
    assert.ok(html.includes('Security'), 'modal groups include Security');
    // Modal links to raw artifacts + the Markdown report.
    assert.ok(html.includes('costEnvelope') || html.includes('cost envelope'));
    assert.ok(
      html.includes('Markdown report'),
      'modal links to the Markdown report',
    );
    assert.ok(
      html.includes('reportsDir'),
      'rows carry the cohort reports-dir pointer',
    );
  });

  it('is byte-for-byte deterministic for a given corpus', () => {
    const a = renderDashboard({ scorecards: [card(), CONTROL] });
    const b = renderDashboard({ scorecards: [card(), CONTROL] });
    assert.equal(a, b);
    // Order-independent: input order does not change the (timestamp-sorted) output.
    const c = renderDashboard({ scorecards: [CONTROL, card()] });
    assert.equal(a, c);
  });

  it('renders a valid, non-crashing empty dashboard for an empty corpus', () => {
    const html = renderDashboard({ scorecards: [] });
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /Results Dashboard/);
    assert.match(html, /"rows":\[\]/);
    assert.ok(html.includes('id="chart"'));
  });

  it('throws on a non-array corpus', () => {
    assert.throws(
      () => renderDashboard({ scorecards: null }),
      /must be an array/,
    );
  });

  it('keys the trend view on the full stamp including benchmarkVersion so different benchmark versions never collapse (D-014)', () => {
    const html = renderDashboard({
      scorecards: [
        card({ runId: 'm-05', benchmarkVersion: '0.5.0' }),
        card({ runId: 'm-06', benchmarkVersion: '0.6.0' }),
      ],
    });
    // The inlined corpus carries benchmarkVersion on every row...
    assert.match(html, /"benchmarkVersion":"0\.5\.0"/);
    assert.match(html, /"benchmarkVersion":"0\.6\.0"/);
    // ...and the client cohort key concatenates the benchmark version, so two
    // records that share (model, frameworkVersion) but differ in benchmark
    // version resolve to distinct cohorts (distinct trend points).
    assert.match(html, /\+ " · bench " \+ r\.benchmarkVersion/);
    assert.match(html, /r\.benchmarkVersion === cohort\.benchmarkVersion/);
  });

  it('exposes benchmarkVersion as an index-table column (D-014)', () => {
    const html = renderDashboard({ scorecards: [card(), CONTROL] });
    assert.match(html, /key: "benchmarkVersion", label: "Bench"/);
  });

  it('renders the autonomy-guardrail panel, marked deltaExempt (Epic #66, Story #77/#79)', () => {
    const html = renderDashboard({ scorecards: [card(), CONTROL] });
    assert.match(html, /Autonomy guardrail \(mandrel arm\)/);
    assert.match(html, /"deltaExempt":true/);
  });

  it('renders a trap-axis panel, empty when no scenario declares a trap class', () => {
    const html = renderDashboard({ scorecards: [card(), CONTROL] });
    assert.match(html, /Trap axis \(differential/);
    assert.match(html, /No scenario in this corpus declares a trap class/);
  });

  it('renders per-class trap distributions when a scorecard carries a trap block', () => {
    const trapCard = card({
      runId: 'trap-1',
      trap: {
        classes: [
          { class: 'plaintext-password', score: 1, defectPresent: false },
        ],
        cleanRate: 1,
      },
    });
    const html = renderDashboard({ scorecards: [trapCard] });
    assert.match(html, /plaintext-password/);
    assert.doesNotMatch(
      html,
      /No scenario in this corpus declares a trap class/,
    );
  });

  it('renders populated <td> values in both the guardrail and trap-axis tables (Epic #66 audit remediation, M4-M10)', () => {
    const trapCard = card({
      runId: 'trap-1',
      trap: {
        classes: [
          { class: 'plaintext-password', score: 1, defectPresent: false },
        ],
        cleanRate: 1,
      },
    });
    const html = renderDashboard({ scorecards: [trapCard, CONTROL] });

    // Autonomy-guardrail table: a real row for the hello-world scenario, not
    // just the "no data" empty-state div.
    assert.doesNotMatch(html, /No mandrel-arm runs to evaluate/);
    const guardrailTable = html.match(
      /<h2>Autonomy guardrail[\s\S]*?<table>([\s\S]*?)<\/table>/,
    );
    assert.ok(guardrailTable, 'guardrail table must render');
    assert.match(guardrailTable[1], /<td>hello-world<\/td>/);
    // n / met / dropped / unmeasured / threshold columns are populated cells,
    // not blank <td></td>.
    assert.doesNotMatch(guardrailTable[1], /<td><\/td>/);

    // Trap-axis table: a real per-class row with the mean/spread/min/n stat
    // string, not the empty-state div.
    const trapTable = html.match(
      /<h2>Trap axis[\s\S]*?<table>([\s\S]*?)<\/table>/,
    );
    assert.ok(trapTable, 'trap-axis table must render');
    assert.match(trapTable[1], /<td>plaintext-password<\/td>/);
    assert.match(trapTable[1], /<td>1 \(spread 0, min 1, n=1\)<\/td>/);
    assert.doesNotMatch(trapTable[1], /<td><\/td>/);
  });
});

describe('buildDashboardModel — guardrail + trap axis (Epic #66, Story #79)', () => {
  it('computes the autonomy-guardrail rows from the mandrel arm', () => {
    const model = buildDashboardModel([card(), CONTROL]);
    assert.ok(Array.isArray(model.guardrail));
    const row = model.guardrail.find((r) => r.scenario === 'hello-world');
    assert.ok(row);
    assert.equal(row.n, 1);
  });

  it('computes an empty trapAxis when no scorecard carries a trap block', () => {
    const model = buildDashboardModel([card(), CONTROL]);
    assert.deepEqual(model.trapAxis, []);
  });

  it('keeps the guardrail panel populated once a SECOND benchmarkVersion is recorded (M6)', () => {
    // Before the fix, feeding the whole multi-cohort corpus to groupCells
    // marked every cell non-inferential and BLANKED the guardrail permanently
    // the moment a second benchmarkVersion landed. The panel must scope to the
    // most-recent cohort and keep rendering.
    const olderCohort = [
      card({ runId: 'old-m', benchmarkVersion: '0.5.0' }),
      card({
        runId: 'old-c',
        arm: 'control',
        benchmarkVersion: '0.5.0',
        timestamp: '2026-06-16T17:00:00.000Z',
      }),
    ];
    const newerCohort = [
      card({
        runId: 'new-m',
        benchmarkVersion: '0.6.0',
        timestamp: '2026-07-09T19:42:11.000Z',
      }),
      card({
        runId: 'new-c',
        arm: 'control',
        benchmarkVersion: '0.6.0',
        timestamp: '2026-07-09T19:00:00.000Z',
      }),
    ];
    const model = buildDashboardModel([...olderCohort, ...newerCohort]);
    const row = model.guardrail.find((r) => r.scenario === 'hello-world');
    assert.ok(row, 'the guardrail must still render a hello-world row');
    // Scoped to the most-recent (0.6.0) cohort's single mandrel run — not
    // blanked, and not pooled across the two benchmark versions.
    assert.equal(row.n, 1);
    // The full index-table rows still reflect the WHOLE corpus.
    assert.equal(model.rows.length, 4);
  });
});
