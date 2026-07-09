/**
 * trap-oracle-shared.js — shared filesystem-scanning scaffolding for the
 * per-defect-class adversarial trap oracles under
 * `bench/scenarios/{story-scope,epic-scope}/traps/*.js` (Epic #66 audit
 * remediation, H5).
 *
 * Every trap oracle is a pure source-text scanner over the materialized
 * workspace tree: walk the tree (skipping build/dep dirs, dot-dirs — the
 * overlaid framework tree — and the `CLAUDE.md` overlay artifact), read each
 * scannable source file, and hand the collected text blobs to a per-class
 * `evaluateSources(sources)` heuristic. That walk-and-read scaffolding was
 * byte-for-byte duplicated across six trap-oracle modules; this module is the
 * single place it now lives. Each trap-oracle module keeps only its
 * `evaluateSources` heuristic and re-exports `evaluate` built from
 * `scanTree`.
 *
 * @module bench/scenarios/trap-oracle-shared
 */

import fs from 'node:fs';
import path from 'node:path';

/** Directories never scanned (build output / deps). */
export const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);

/**
 * Top-level FILE artifacts the bench overlays into the mandrel arm's workspace
 * that are framework material, not the delivered app. Skipped so the scanner
 * measures the deliverable, not the framework (same rule as the
 * security-adapter — the overlaid `.agents` / `.claude` dirs are dot-dirs and
 * skipped generically).
 */
export const OVERLAY_FILE_ARTIFACTS = new Set(['CLAUDE.md']);

/** File extensions considered source (skip binaries, lockfiles, the store). */
export const SCANNABLE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
]);

/**
 * Recursively collect scannable source-file paths under `dir`, skipping
 * build/dep dirs, dot-dirs (the overlaid framework tree), and the top-level
 * overlay file artifacts.
 *
 * @param {string} dir — absolute path to scan.
 * @param {Pick<typeof fs, 'readdirSync'>} fsImpl
 * @returns {string[]}
 */
export function collectSourceFiles(dir, fsImpl) {
  const result = [];
  let entries;
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip hidden directories — in the mandrel arm the overlaid framework
      // tree (`.agents`, `.claude`) lives in dot-dirs; scanning them would
      // attribute the framework's own code to the delivered app (a confound
      // the control arm never has).
      if (entry.name.startsWith('.')) continue;
      result.push(...collectSourceFiles(full, fsImpl));
    } else if (entry.isFile()) {
      if (OVERLAY_FILE_ARTIFACTS.has(entry.name)) continue;
      if (SCANNABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        result.push(full);
      }
    }
  }
  return result;
}

/**
 * Scan a materialized workspace tree and derive the trap verdict via the
 * supplied per-class `evaluateSources` heuristic — the shared shape every
 * trap oracle's `evaluate(deliveredTreePath, ports)` export delegates to.
 *
 * @param {string} deliveredTreePath — absolute path to the delivered app tree.
 * @param {(sources: Iterable<string>) => { score: 0|1, defectPresent: boolean, evidence: string[] }} evaluateSources
 *   — the per-defect-class heuristic that turns extracted source text into a verdict.
 * @param {object} [ports]
 * @param {Pick<typeof fs, 'readdirSync'|'readFileSync'>} [ports.fsImpl]
 *   — filesystem implementation (default: `node:fs`).
 * @returns {{ score: 0|1, defectPresent: boolean, evidence: string[] }}
 */
export function scanTree(deliveredTreePath, evaluateSources, ports = {}) {
  if (typeof deliveredTreePath !== 'string' || deliveredTreePath.length === 0) {
    throw new TypeError(
      'scanTree(deliveredTreePath): deliveredTreePath must be a non-empty string',
    );
  }
  const fsImpl = ports.fsImpl ?? fs;
  const files = collectSourceFiles(deliveredTreePath, fsImpl);
  const sources = [];
  for (const filePath of files) {
    try {
      sources.push(fsImpl.readFileSync(filePath, 'utf8'));
    } catch {
      // Unreadable file — skip; a partial scan is still a valid verdict.
    }
  }
  return evaluateSources(sources);
}
