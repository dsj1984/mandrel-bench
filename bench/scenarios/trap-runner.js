// bench/scenarios/trap-runner.js
/**
 * Per-class trap-oracle runner — the shared substrate every rung's
 * adversarial trap classes are scored through (Epic #66, Story #74).
 *
 * Contract (Epic #66 Tech Spec § Architecture & Design, point 2 — "Planted
 * pressure, separated detectors"): a scenario declares zero or more trap
 * classes as sibling modules under `bench/scenarios/<id>/traps/<class>.js`.
 * Each module exports:
 *
 *   evaluate(deliveredTreePath) → { class?, score: 0|1, defectPresent, evidence? }
 *     - `score` — 1 when the delivered code is clean (no planted defect
 *       detected), 0 when the defect is present. Higher is better.
 *     - `defectPresent` — boolean; the inverse framing of `score` (kept
 *       explicit so a consumer never has to invert a number to get the
 *       human-readable verdict).
 *     - `class` — optional; when omitted the class name is derived from the
 *       module's filename (`traps/plaintext-password.js` → `'plaintext-password'`).
 *     - `evidence` — optional array of human-readable justification lines.
 *       Oracles must never echo a captured secret/password value here.
 *
 * `evaluate` may be sync or async (the runner always awaits it) and receives
 * the ABSOLUTE path to the delivered workspace tree — never the sandbox
 * repo's URL or the harness's own scaffolding. Oracles live only in this repo
 * (`bench/scenarios/**`), never overlaid into either arm's sandbox — the #58
 * git-exclude discipline is the enforced boundary that keeps them out of the
 * mandrel arm's prompt/tree, and the control arm's sandbox is never overlaid
 * at all.
 *
 * `runTrapOracles` discovers every `traps/<class>.js` module under a
 * scenario directory, executes each oracle against the delivered tree, and
 * aggregates the per-class verdicts into `{ classes[], cleanRate }` —
 * `cleanRate` is the mean of the per-class scores. A scenario with no
 * `traps/` directory (or an empty one) yields `{ classes: [], cleanRate: null }`
 * — the caller (bench/run.js) treats an empty `classes[]` as "no trap block"
 * so the scorecard schema keeps `trap` optional and non-trap scenarios are
 * unaffected.
 *
 * Every filesystem/import effect is injectable so the unit suite exercises
 * discovery and aggregation without touching real scenario directories.
 *
 * @module bench/scenarios/trap-runner
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * The default trap-oracle discovery subdirectory — the touch-1 (first-touch)
 * scan globs `traps/`. The touch-2 (second-touch) regression scan uses a
 * SEPARATE convention, {@link TOUCH2_TRAPS_SUBDIR}, so a phase's oracles are
 * never discovered by the other phase's scan (Epic #86 pre-mortem F2 CRITICAL:
 * a touch-2 regression oracle placed under `traps/` would run at touch 1 and
 * corrupt the touch-1 cleanRate).
 */
export const DEFAULT_TRAPS_SUBDIR = 'traps';

/**
 * The touch-2 regression-oracle discovery subdirectory. Kept DISJOINT from
 * {@link DEFAULT_TRAPS_SUBDIR} so the touch-1 scan (`traps/` only) and its
 * cleanRate are provably unaffected by the presence of touch-2 regression
 * oracles, and vice-versa (Epic #86, Story #96).
 */
export const TOUCH2_TRAPS_SUBDIR = 'traps-touch2';

/**
 * Discover the trap-oracle modules declared under a scenario directory's
 * trap subdirectory. A missing subdirectory (or any unreadable directory) is
 * NOT an error — it means the scenario declares no trap classes for that
 * phase — so this returns an empty array rather than throwing.
 *
 * The `subdir` param is the phase-scoped discovery convention (Epic #86,
 * Story #96): touch 1 scans `traps/` ({@link DEFAULT_TRAPS_SUBDIR}) and touch
 * 2 scans `traps-touch2/` ({@link TOUCH2_TRAPS_SUBDIR}). Because the two
 * directories are disjoint, a touch-2 regression oracle is NEVER discovered by
 * the touch-1 scan (which is what keeps the touch-1 cleanRate uncorrupted) and
 * vice-versa.
 *
 * @param {string} scenarioDir  Absolute path to `bench/scenarios/<id>`.
 * @param {object} [deps]
 * @param {(p: string, opts: object) => Array<{name: string, isFile(): boolean}>} [deps.readdirFn]
 *   Injected `readdirSync` (called with `{ withFileTypes: true }`).
 * @param {string} [deps.subdir='traps']  The trap subdirectory to scan. The
 *   touch-2 regression scan passes `'traps-touch2'`.
 * @returns {Array<{ class: string, modulePath: string }>} Sorted by class
 *   name for deterministic ordering.
 */
export function discoverTrapModules(scenarioDir, deps = {}) {
  if (typeof scenarioDir !== 'string' || scenarioDir.length === 0) {
    throw new TypeError('discoverTrapModules requires a non-empty scenarioDir');
  }
  const readdir = deps.readdirFn ?? readdirSync;
  const subdir =
    typeof deps.subdir === 'string' && deps.subdir.length > 0
      ? deps.subdir
      : DEFAULT_TRAPS_SUBDIR;
  const trapsDir = path.join(scenarioDir, subdir);

  let entries;
  try {
    entries = readdir(trapsDir, { withFileTypes: true });
  } catch {
    // No trap subdirectory (or unreadable) — this scenario declares no trap
    // classes for this phase. A valid, common state; not an error.
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => ({
      class: path.basename(entry.name, '.js'),
      modulePath: path.join(trapsDir, entry.name),
    }))
    .sort((a, b) => a.class.localeCompare(b.class));
}

/**
 * Execute every declared trap-oracle module against the delivered tree and
 * aggregate their verdicts.
 *
 * @param {object} opts
 * @param {string} opts.scenarioDir        Absolute path to `bench/scenarios/<id>`.
 * @param {string} opts.deliveredTreePath  Absolute path to the delivered
 *   workspace tree (the sandbox clone's working directory).
 * @param {string} [opts.trapsSubdir='traps']  Phase-scoped discovery subdir
 *   (Epic #86, Story #96): touch 1 scans `traps/`, touch 2 scans
 *   `traps-touch2/`. Forwarded to {@link discoverTrapModules} as `subdir`.
 * @param {object} [deps]
 * @param {(p: string, opts: object) => Array<{name: string, isFile(): boolean}>} [deps.readdirFn]
 *   Forwarded to {@link discoverTrapModules}.
 * @param {(specifier: string) => Promise<object>} [deps.importImpl]
 *   Injected dynamic `import()`. Defaults to the real one.
 * @returns {Promise<{ classes: Array<{ class: string, score: number, defectPresent: boolean, evidence?: string[] }>, cleanRate: number|null }>}
 */
export async function runTrapOracles(opts = {}, deps = {}) {
  const { scenarioDir, deliveredTreePath, trapsSubdir } = opts;
  if (typeof scenarioDir !== 'string' || scenarioDir.length === 0) {
    throw new TypeError('runTrapOracles requires a non-empty scenarioDir');
  }
  if (typeof deliveredTreePath !== 'string' || deliveredTreePath.length === 0) {
    throw new TypeError(
      'runTrapOracles requires a non-empty deliveredTreePath',
    );
  }

  const importImpl = deps.importImpl ?? ((spec) => import(spec));
  // The phase-scoped discovery subdir travels via the opts (touch 2 passes
  // `trapsSubdir: 'traps-touch2'`); `deps.subdir` (used directly by unit tests
  // of discoverTrapModules) still wins when supplied.
  const modules = discoverTrapModules(scenarioDir, {
    ...deps,
    subdir: deps.subdir ?? trapsSubdir ?? DEFAULT_TRAPS_SUBDIR,
  });

  const classes = [];
  for (const { class: derivedClass, modulePath } of modules) {
    const mod = await importImpl(modulePath);
    if (typeof mod.evaluate !== 'function') {
      throw new TypeError(
        `trap-oracle module does not export evaluate(deliveredTreePath): ${modulePath}`,
      );
    }
    const verdict = await mod.evaluate(deliveredTreePath);
    classes.push({
      class: verdict?.class ?? derivedClass,
      score: verdict.score,
      defectPresent: Boolean(verdict.defectPresent),
      ...(Array.isArray(verdict.evidence)
        ? { evidence: verdict.evidence }
        : {}),
    });
  }

  const cleanRate =
    classes.length > 0
      ? classes.reduce((sum, c) => sum + c.score, 0) / classes.length
      : null;

  return { classes, cleanRate };
}
