// bench/report/aggregate.js
//
// Cross-cohort aggregator for the Mandrel self-benchmark results tree
// (Epic #2, Story #17). Internal tooling only — never shipped in the
// distributed `.agents/` bundle, never run against the live repo.
//
// The store was split (Story #17) from one flat `results/scorecards.ndjson`
// into per-cohort stores at `results/<model-slug>/<frameworkVersion>/
// scorecards.ndjson`. The dashboard needs the WHOLE corpus across every
// cohort, so this module walks the results tree, finds every per-cohort store,
// and reads them all back into one flat list via `readStore` (the same pure
// parser the persist slice writes through, so the aggregator never re-derives a
// second, divergent parse).
//
// It mirrors persist.js's shape: a thin FS shell over the pure `readStore`
// core, with every filesystem touch injectable so the walk is unit-testable
// with no real disk. An empty (or absent) results tree yields an empty corpus —
// not a crash — so a fresh checkout renders a valid, empty dashboard.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { readStore } from './persist.js';

/** The per-cohort store filename the walk looks for in each leaf cohort dir. */
export const STORE_FILENAME = 'scorecards.ndjson';

/**
 * Find every per-cohort `scorecards.ndjson` under a results root. The tree is
 * `<resultsDir>/<model-slug>/<frameworkVersion>/scorecards.ndjson`, so the walk
 * descends at most two directory levels and collects any store file it finds.
 * Order is deterministic (lexicographic by directory name at each level) so the
 * aggregated corpus is stable across runs. Pure-ish: all FS access is via the
 * injectable shim.
 *
 * A non-existent results root yields an empty list (a tree that was never
 * written has no stores — not an error).
 *
 * @param {object} args
 * @param {string} args.resultsDir
 * @param {object} [deps]
 * @param {(p: string) => boolean} [deps.existsImpl]
 * @param {(p: string) => string[]} [deps.readdirImpl]
 * @param {(p: string) => { isDirectory: () => boolean }} [deps.statImpl]
 * @returns {string[]}  Absolute (resultsDir-joined) store paths, sorted.
 */
export function findCohortStores({ resultsDir }, deps = {}) {
  if (typeof resultsDir !== 'string' || resultsDir.length === 0) {
    throw new TypeError('findCohortStores: resultsDir is required');
  }
  const exists = deps.existsImpl ?? existsSync;
  const readdir = deps.readdirImpl ?? ((p) => readdirSync(p));
  const stat = deps.statImpl ?? ((p) => statSync(p));

  if (!exists(resultsDir)) return [];

  const isDir = (p) => {
    try {
      return stat(p).isDirectory();
    } catch {
      return false;
    }
  };

  const stores = [];
  const modelDirs = [...readdir(resultsDir)].sort();
  for (const modelName of modelDirs) {
    const modelPath = path.join(resultsDir, modelName);
    if (!isDir(modelPath)) continue;
    const versionDirs = [...readdir(modelPath)].sort();
    for (const versionName of versionDirs) {
      const versionPath = path.join(modelPath, versionName);
      if (!isDir(versionPath)) continue;
      const storePath = path.join(versionPath, STORE_FILENAME);
      if (exists(storePath)) stores.push(storePath);
    }
  }
  return stores;
}

/**
 * Read every per-cohort store under a results root into one flat corpus. Each
 * store is parsed through `readStore` (the same pure parser persist.js uses), so
 * a malformed line in any store fails loudly with its line number. An empty /
 * absent tree returns `[]`.
 *
 * @param {object} args
 * @param {string} args.resultsDir
 * @param {object} [deps]
 * @param {(p: string) => boolean} [deps.existsImpl]
 * @param {(p: string) => string[]} [deps.readdirImpl]
 * @param {(p: string) => { isDirectory: () => boolean }} [deps.statImpl]
 * @param {(p: string, enc: string) => string} [deps.readFileImpl]
 * @returns {Array<object>}  The aggregated scorecard corpus.
 */
export function aggregateScorecards({ resultsDir }, deps = {}) {
  const read = deps.readFileImpl ?? readFileSync;
  const exists = deps.existsImpl ?? existsSync;
  const stores = findCohortStores({ resultsDir }, deps);
  const corpus = [];
  for (const storePath of stores) {
    for (const sc of readStore(
      { storePath },
      { existsImpl: exists, readFileImpl: read },
    )) {
      corpus.push(sc);
    }
  }
  return corpus;
}
