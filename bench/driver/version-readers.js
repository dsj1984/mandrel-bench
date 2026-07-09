// bench/driver/version-readers.js
/**
 * Shared cohort-stamp version readers for the Mandrel self-benchmark harness.
 * Internal tooling only — never shipped in the distributed `.agents/` bundle,
 * never run against the live repo.
 *
 * These two readers stamp the cohort key's version fields (D-014,
 * docs/target-architecture.md § 11):
 *
 *   - `readFrameworkVersion` — the framework UNDER test (the pinned `mandrel`
 *     dependency), and
 *   - `readBenchmarkVersion` — the benchmark harness DOING the testing (THIS
 *     repo's own `package.json` version).
 *
 * They were previously duplicated byte-for-byte across `bench/run.js` and
 * `bench/driver/topup-planner.js`. This leaf module is the single source of
 * truth so both cohort discriminants agree by construction.
 *
 * DELIBERATELY LEAF: this module imports NOTHING from `bench/run.js` (whose
 * module graph pulls in the whole run loop — sandbox provisioning, model
 * invocation, the cost ceiling). The top-up planner must be able to resolve a
 * cohort stamp without any risk of launching a session, so its version readers
 * live here rather than in the run orchestrator. Pure over the injected FS
 * shims.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Read the framework-under-test version from the pinned `mandrel` dependency
 * (`node_modules/mandrel/package.json`) — NOT the consumer's own
 * `package.json` version. Falls back to the consumer's dependency spec (with a
 * leading range operator stripped) when the package is absent, then
 * `'unknown'`. Pure over the injected FS shims.
 *
 * @param {string} sourceRoot
 * @param {object} [deps]
 * @param {(p: string, enc: string) => string} [deps.readFileImpl]
 * @param {(p: string) => boolean} [deps.existsImpl]
 * @returns {string}
 */
export function readFrameworkVersion(sourceRoot, deps = {}) {
  const read = deps.readFileImpl ?? readFileSync;
  const exists = deps.existsImpl ?? existsSync;
  const pkgPath = path.join(
    sourceRoot,
    'node_modules',
    'mandrel',
    'package.json',
  );
  if (exists(pkgPath)) {
    try {
      const v = JSON.parse(read(pkgPath, 'utf8')).version;
      if (typeof v === 'string' && v.length > 0) return v;
    } catch {
      // fall through
    }
  }
  // Fallback: the spec from the consumer package.json dependencies.
  try {
    const consumer = JSON.parse(
      read(path.join(sourceRoot, 'package.json'), 'utf8'),
    );
    const spec = consumer?.dependencies?.mandrel;
    if (typeof spec === 'string') return spec.replace(/^[\^~>=<\s]*/, '');
  } catch {
    // fall through
  }
  return 'unknown';
}

/**
 * Read the BENCHMARK version — THIS repo's own `package.json` version — for the
 * cohort stamp (D-014, docs/target-architecture.md § 11). This is deliberately
 * NOT `readFrameworkVersion`: that reads the pinned `mandrel` dependency
 * (`node_modules/mandrel/package.json`), the framework UNDER test, whereas this
 * reads the version of the benchmark harness DOING the testing. The benchmark
 * is itself a variable — scoring formulas, scenario specs, and oracles all live
 * here — so a benchmark change can move numbers with no framework or model
 * change at all, and its version must join the cohort key. Falls back to
 * `'unknown'` when the file is absent or carries no `version`.
 *
 * @param {string} sourceRoot
 * @param {object} [deps]
 * @param {(p: string, enc: string) => string} [deps.readFileImpl]
 * @returns {string}
 */
export function readBenchmarkVersion(sourceRoot, deps = {}) {
  const read = deps.readFileImpl ?? readFileSync;
  try {
    const pkg = JSON.parse(read(path.join(sourceRoot, 'package.json'), 'utf8'));
    if (typeof pkg?.version === 'string' && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // fall through
  }
  return 'unknown';
}
