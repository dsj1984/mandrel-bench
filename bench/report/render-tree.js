// bench/report/render-tree.js
//
// Results-tree rendering for the Mandrel self-benchmark harness (Epic #84,
// Story #90). Internal tooling only — never shipped in the distributed
// `.agents/` bundle, never run against the live repo.
//
// The "read an existing results tree and (re)render its artifacts" logic used
// to live ONLY inside `runMatrix` (bench/run.js): after a batch persisted its
// per-cell scorecards, that loop read each cohort's full on-disk store, rendered
// the per-run Markdown report, then aggregated the whole corpus and rendered the
// `results.html` dashboard. Two consumers now need that same logic — the run
// loop (which still calls it after a batch) and the standalone aggregate CLI
// (bench/report/aggregate-cli.js, which renders from downloaded artifacts with
// NO run) — so it is extracted here as a pair of pure-over-injected-I/O
// functions. This module imports NONE of the run loop, so a caller can render an
// existing tree without ever being able to launch a benchmark session.
//
// Determinism: rendering is pure over the append-ordered store — the same tree
// always yields the same report/dashboard bytes. Every filesystem touch is
// behind an injectable shim so the functions are unit-testable with no real disk.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { aggregateScorecards } from './aggregate.js';
import { renderDashboard } from './html.js';
import { readStore } from './persist.js';
import { renderReport } from './render.js';

/** The per-cohort append-only store filename inside each cohort directory. */
export const STORE_FILENAME = 'scorecards.ndjson';

/** The aggregate dashboard filename written at the results-tree root. */
export const DASHBOARD_FILENAME = 'results.html';

/**
 * Render one cohort's per-run Markdown report from its FULL on-disk store, and
 * write it to `<cohortDir>/reports/report-<stamp>.md`. Rendering over the whole
 * store (not just a caller-supplied subset) mirrors how the dashboard reads the
 * corpus, so a resumed batch never under-counts a cohort's cells.
 *
 * @param {object} args
 * @param {string} args.cohortDir  The per-cohort directory (`<results>/<model>/<version>`).
 * @param {string} args.stamp      Filesystem-safe report stamp (already sanitized).
 * @param {'iqr'|'sd'} [args.method='iqr']  Noise-band method threaded to renderReport.
 * @param {object} [deps]
 * @param {object} [deps.readStoreDeps]   Injected persist I/O shim for readStore.
 * @param {(p: string, data: string) => void} [deps.writeFileImpl]
 * @param {(p: string) => void} [deps.mkdirImpl]
 * @returns {{ dir: string, storePath: string, reportPath: string, report: string }}
 */
export function renderCohortReport(
  { cohortDir, stamp, method = 'iqr' },
  deps = {},
) {
  if (typeof cohortDir !== 'string' || cohortDir.length === 0) {
    throw new TypeError('renderCohortReport: cohortDir is required');
  }
  if (typeof stamp !== 'string' || stamp.length === 0) {
    throw new TypeError('renderCohortReport: stamp is required');
  }
  const writeFile = deps.writeFileImpl ?? writeFileSync;
  const mkdir = deps.mkdirImpl ?? ((p) => mkdirSync(p, { recursive: true }));

  const storePath = path.join(cohortDir, STORE_FILENAME);
  const fullStore = readStore({ storePath }, deps.readStoreDeps);
  const report = renderReport({ scorecards: fullStore, method });
  const reportsDir = path.join(cohortDir, 'reports');
  const reportPath = path.join(reportsDir, `report-${stamp}.md`);
  mkdir(reportsDir);
  writeFile(reportPath, report);
  return { dir: cohortDir, storePath, reportPath, report };
}

/**
 * Aggregate the FULL corpus across every cohort under `resultsDir` and render
 * the `results.html` dashboard, written to `<resultsDir>/results.html`. The
 * dashboard always reflects the whole longitudinal history on disk, not just one
 * run's or one cohort's scorecards.
 *
 * @param {object} args
 * @param {string} args.resultsDir  The results-tree root.
 * @param {object} [deps]
 * @param {object} [deps.aggregateDeps]  Injected FS shim for aggregateScorecards.
 * @param {(p: string, data: string) => void} [deps.writeFileImpl]
 * @param {(p: string) => void} [deps.mkdirImpl]
 * @returns {{ dashboardPath: string, dashboard: string, corpusSize: number }}
 */
export function renderDashboardFile({ resultsDir }, deps = {}) {
  if (typeof resultsDir !== 'string' || resultsDir.length === 0) {
    throw new TypeError('renderDashboardFile: resultsDir is required');
  }
  const writeFile = deps.writeFileImpl ?? writeFileSync;
  const mkdir = deps.mkdirImpl ?? ((p) => mkdirSync(p, { recursive: true }));

  const corpus = aggregateScorecards({ resultsDir }, deps.aggregateDeps);
  const dashboard = renderDashboard({ scorecards: corpus });
  const dashboardPath = path.join(resultsDir, DASHBOARD_FILENAME);
  mkdir(resultsDir);
  writeFile(dashboardPath, dashboard);
  return { dashboardPath, dashboard, corpusSize: corpus.length };
}
