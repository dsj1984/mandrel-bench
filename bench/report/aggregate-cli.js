// bench/report/aggregate-cli.js
//
// Standalone aggregate entrypoint for the Mandrel self-benchmark harness
// (Epic #84, Story #90). Internal tooling only — never shipped in the
// distributed `.agents/` bundle, never run against the live repo.
//
// This is the CI pipeline's "aggregate" job made runnable on its own: after the
// per-cell matrix jobs upload their scorecard artifacts, the aggregate job
// downloads them and runs THIS CLI to (1) MERGE the downloaded scorecards into
// the append-only `results/` NDJSON stores and (2) RENDER the per-cohort reports
// and the `results.html` dashboard from the resulting tree — WITHOUT ever
// invoking a benchmark run.
//
// Why standalone: the render logic used to live only inside `runMatrix`
// (bench/run.js), which couples it to the whole run loop (sandbox provisioning,
// model invocation, the cost ceiling). CI's aggregate step has already spent the
// money in the matrix jobs; it must merge + render from downloaded artifacts and
// nothing more. So the render logic is extracted to bench/report/render-tree.js
// (imported here) and this CLI imports NONE of bench/run.js — it can merge and
// render a results tree but can never launch a session.
//
// Merge is append-only and idempotent: a scorecard whose `runId` already exists
// in its cohort store is skipped, so re-running the aggregate over the same
// artifacts never duplicates a record. Every filesystem touch is behind an
// injectable port, so the whole CLI is exercised by the unit suite with no real
// disk and no network.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultCliLogger, runIfMain } from '../driver/cli-shell.js';
import { findCohortStores, STORE_FILENAME } from './aggregate.js';
import { cohortDir } from './cohort-path.js';
import { appendScorecards, parseStore, readStore } from './persist.js';
import { renderCohortReport, renderDashboardFile } from './render-tree.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Sanitize an arbitrary string into a filesystem-safe report stamp
 * (`^[A-Za-z0-9._-]+$`). Kept local so this CLI never imports bench/run.js
 * (whose module graph pulls in the whole run loop). Pure.
 *
 * @param {string} s
 * @returns {string}
 */
export function sanitizeStamp(s) {
  return String(s)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Recursively collect every `scorecards.ndjson` file under an artifacts root.
 * The per-cell matrix jobs each upload their own `results/` slice, so the
 * downloaded artifacts tree carries one or more per-cohort store files nested at
 * arbitrary depth. Order is deterministic (lexicographic at each level) so the
 * merge is stable. A non-existent root yields an empty list. Pure over the
 * injected FS shim.
 *
 * @param {object} args
 * @param {string} args.artifactsDir
 * @param {object} [deps]
 * @param {(p: string) => boolean} [deps.existsImpl]
 * @param {(p: string) => string[]} [deps.readdirImpl]
 * @param {(p: string) => { isDirectory: () => boolean }} [deps.statImpl]
 * @returns {string[]}  Absolute store paths, sorted.
 */
export function findArtifactStores({ artifactsDir }, deps = {}) {
  if (typeof artifactsDir !== 'string' || artifactsDir.length === 0) {
    throw new TypeError('findArtifactStores: artifactsDir is required');
  }
  const exists = deps.existsImpl ?? existsSync;
  const readdir = deps.readdirImpl ?? ((p) => readdirSync(p));
  const stat = deps.statImpl ?? ((p) => statSync(p));

  if (!exists(artifactsDir)) return [];

  const isDir = (p) => {
    try {
      return stat(p).isDirectory();
    } catch {
      return false;
    }
  };

  const found = [];
  const walk = (dir) => {
    const entries = [...readdir(dir)].sort();
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (isDir(full)) {
        walk(full);
      } else if (entry === STORE_FILENAME) {
        found.push(full);
      }
    }
  };
  walk(artifactsDir);
  return found;
}

/**
 * Read every scorecard record out of the downloaded artifacts tree. Each
 * discovered `scorecards.ndjson` is parsed via the same pure `parseStore` the
 * persist slice uses, so a malformed artifact fails loudly with its line number.
 * Pure over the injected FS shim.
 *
 * @param {object} args
 * @param {string} args.artifactsDir
 * @param {object} [deps]
 * @returns {Array<object>}  Every scorecard record found, in store-walk order.
 */
export function readArtifactScorecards({ artifactsDir }, deps = {}) {
  const read = deps.readFileImpl ?? readFileSync;
  const stores = findArtifactStores({ artifactsDir }, deps);
  const records = [];
  for (const storePath of stores) {
    for (const sc of parseStore(read(storePath, 'utf8'))) {
      records.push(sc);
    }
  }
  return records;
}

/**
 * Merge a batch of downloaded scorecards into the append-only `results/` tree,
 * routing each record to its cohort store (`<resultsDir>/<model>/<version>/
 * scorecards.ndjson`) via the same `cohortDir` derivation the run loop uses.
 *
 * Idempotent by `runId`: a record whose `runId` already exists in its target
 * cohort store — or that duplicates an earlier record in the SAME batch — is
 * skipped, so re-running the aggregate over the same artifacts never duplicates
 * a scorecard. Pure over the injected persist ports.
 *
 * @param {object} args
 * @param {Array<object>} args.records   Downloaded scorecards to merge.
 * @param {string} args.resultsDir       The results-tree root.
 * @param {object} [deps]
 * @param {object} [deps.persistDeps]    Injected I/O shim for readStore/appendScorecards.
 * @returns {{ appended: number, skippedDuplicates: number, cohortDirs: string[] }}
 */
export function mergeScorecards({ records, resultsDir }, deps = {}) {
  if (!Array.isArray(records)) {
    throw new TypeError('mergeScorecards: records must be an array');
  }
  if (typeof resultsDir !== 'string' || resultsDir.length === 0) {
    throw new TypeError('mergeScorecards: resultsDir is required');
  }
  const persistDeps = deps.persistDeps ?? {};

  // Group incoming records by their target cohort directory.
  const byCohort = new Map();
  for (const sc of records) {
    const dir = cohortDir({ resultsDir, scorecard: sc });
    if (!byCohort.has(dir)) byCohort.set(dir, []);
    byCohort.get(dir).push(sc);
  }

  let appended = 0;
  let skippedDuplicates = 0;
  const cohortDirs = [];

  for (const dir of [...byCohort.keys()].sort()) {
    const storePath = path.join(dir, STORE_FILENAME);
    // Seed the seen-set from the runIds already on disk so an existing cohort
    // store is never re-appended, then extend it per record so an artifact that
    // carries the same runId twice only lands once.
    const seen = new Set(
      readStore({ storePath }, persistDeps)
        .map((sc) => sc?.runId)
        .filter((id) => typeof id === 'string'),
    );
    const fresh = [];
    for (const sc of byCohort.get(dir)) {
      const runId = sc?.runId;
      if (typeof runId === 'string' && seen.has(runId)) {
        skippedDuplicates += 1;
        continue;
      }
      if (typeof runId === 'string') seen.add(runId);
      fresh.push(sc);
    }
    if (fresh.length > 0) {
      appendScorecards({ storePath, scorecards: fresh }, persistDeps);
      appended += fresh.length;
    }
    cohortDirs.push(dir);
  }

  return { appended, skippedDuplicates, cohortDirs };
}

/**
 * Render the per-cohort reports and the `results.html` dashboard from an EXISTING
 * results tree — every cohort store discovered under `resultsDir` gets a fresh
 * report, then the aggregate dashboard is rendered over the whole corpus. Does
 * NOT invoke any run. Pure over the injected render/FS ports.
 *
 * @param {object} args
 * @param {string} args.resultsDir
 * @param {string} args.stamp           Filesystem-safe report stamp.
 * @param {object} [deps]
 * @param {object} [deps.persistDeps]   readStore/aggregate FS shim.
 * @param {object} [deps.aggregateDeps] aggregateScorecards FS shim.
 * @param {(p: string, data: string) => void} [deps.writeFileImpl]
 * @param {(p: string) => void} [deps.mkdirImpl]
 * @returns {{ cohorts: object[], dashboardPath: string, corpusSize: number }}
 */
export function renderResultsTree({ resultsDir, stamp }, deps = {}) {
  const storePaths = findCohortStores({ resultsDir }, deps.aggregateDeps);
  const cohorts = [];
  for (const storePath of storePaths) {
    cohorts.push(
      renderCohortReport(
        { cohortDir: path.dirname(storePath), stamp, method: 'iqr' },
        {
          readStoreDeps: deps.persistDeps,
          writeFileImpl: deps.writeFileImpl,
          mkdirImpl: deps.mkdirImpl,
        },
      ),
    );
  }
  const { dashboardPath, corpusSize } = renderDashboardFile(
    { resultsDir },
    {
      aggregateDeps: deps.aggregateDeps,
      writeFileImpl: deps.writeFileImpl,
      mkdirImpl: deps.mkdirImpl,
    },
  );
  return { cohorts, dashboardPath, corpusSize };
}

/**
 * Parse the aggregate CLI args.
 *
 * @param {string[]} [argv]
 * @returns {object}
 */
export function parseAggregateCliArgs(argv = []) {
  const result = {
    help: false,
    artifactsDir: null,
    resultsDir: null,
    stamp: null,
    noMerge: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--no-merge') {
      result.noMerge = true;
    } else if (arg === '--artifacts-dir') {
      result.artifactsDir = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--results-dir') {
      result.resultsDir = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--stamp') {
      result.stamp = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return result;
}

const HELP_TEXT = `Usage: node bench/report/aggregate-cli.js [options]

Merge downloaded scorecard artifacts into the append-only results/ NDJSON stores,
then render the per-cohort Markdown reports and the results.html dashboard from
the resulting tree. Never invokes a benchmark run.

Options:
  --artifacts-dir <path>  Root of the downloaded scorecard artifacts to merge.
                          Omit (or pass --no-merge) to render the existing tree
                          without merging new artifacts.
  --results-dir <path>    Results-tree root (default: <repo>/results).
  --stamp <id>            Report-filename stamp (default: derived UTC timestamp).
  --no-merge              Skip the merge step; render the existing tree only.
  -h, --help              Print this help and exit 0.
`;

/**
 * Aggregate CLI entry. Reads the downloaded artifacts, merges them into the
 * results tree (unless `--no-merge`), renders the reports + dashboard, and prints
 * a JSON summary — every effect behind an injectable port, so no real run is ever
 * launched and the unit suite exercises it with no disk.
 *
 * @param {string[]} [argv]
 * @param {Record<string, string|undefined>} [env]
 * @param {object} [deps]
 * @returns {Promise<number>}  The process exit code.
 */
export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  deps = {},
) {
  const logger = deps.logger ?? defaultCliLogger();
  const write = deps.write ?? ((s) => process.stdout.write(s));
  const now = deps.now ?? (() => new Date().toISOString());
  const args = parseAggregateCliArgs(argv);

  if (args.help) {
    write(HELP_TEXT);
    return 0;
  }

  const sourceRoot = deps.sourceRoot ?? path.resolve(__dirname, '..', '..');
  const resultsDir =
    args.resultsDir ?? deps.resultsDir ?? path.join(sourceRoot, 'results');
  const artifactsDir = args.artifactsDir ?? deps.artifactsDir ?? null;
  // Prefer an explicit --stamp, then the CI run id (stable per workflow run, so
  // the report filename traces back to the dispatch), then a wall-clock stamp.
  const stamp = sanitizeStamp(args.stamp ?? env.GITHUB_RUN_ID ?? now());

  let summary;
  try {
    let merge = { appended: 0, skippedDuplicates: 0, cohortDirs: [] };
    if (!args.noMerge && artifactsDir) {
      const records = readArtifactScorecards({ artifactsDir }, deps);
      merge = mergeScorecards({ records, resultsDir }, deps);
      logger.info(
        `[aggregate-cli] merged ${merge.appended} scorecard(s) (${merge.skippedDuplicates} duplicate(s) skipped) into ${resultsDir}`,
      );
    } else {
      logger.info(
        `[aggregate-cli] merge skipped — rendering existing tree at ${resultsDir}`,
      );
    }

    const rendered = renderResultsTree({ resultsDir, stamp }, deps);
    logger.info(
      `[aggregate-cli] rendered ${rendered.cohorts.length} cohort report(s) + ${rendered.dashboardPath} (corpus: ${rendered.corpusSize})`,
    );

    summary = {
      resultsDir,
      artifactsDir,
      stamp,
      merged: merge.appended,
      skippedDuplicates: merge.skippedDuplicates,
      cohortsRendered: rendered.cohorts.map((c) => c.dir),
      dashboardPath: rendered.dashboardPath,
      corpusSize: rendered.corpusSize,
    };
  } catch (err) {
    logger.error(`[aggregate-cli] FATAL: ${err?.message ?? err}`);
    return 1;
  }

  write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

// Run when invoked directly (not when imported by tests).
runIfMain(import.meta.url, () => {
  main().then((code) => {
    process.exitCode = code;
  });
});
