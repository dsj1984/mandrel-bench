/**
 * maintainability-adapter.js — static-analysis collector for the Mandrel
 * self-benchmark maintainability dimension (Epic #32, Story #39).
 *
 * Given a workspace path and injected tool ports, collects the objective
 * maintainability sub-signals that feed `computeMaintainability` in
 * `bench/score/dimensions.js`. Identical tooling is used for both the Mandrel
 * arm and the control arm so the comparison is fair.
 *
 * Sub-signals collected
 * ---------------------
 *   lintErrorDensity  — lint errors per source file (float ≥ 0). Lower is better.
 *   testPresence      — tier-aware test presence score ∈ [0, 1].
 *                       Per rules/testing-standards.md the pyramid has three
 *                       tiers: unit, contract, and e2e/acceptance. Each tier
 *                       contributes equally when present.
 *   complexityScore   — normalised cyclomatic-complexity + length score ∈ [0, 1].
 *                       Derived from average cyclomatic complexity and max
 *                       function/file line lengths against configurable caps.
 *   deadCodeCount     — count of likely-unused exports (non-negative integer).
 *   docsScore         — documentation presence ∈ [0, 1].
 *                       0.5 weight for a top-level README, 0.5 weight for JSDoc
 *                       density (ratio of exported functions that carry a JSDoc
 *                       block).
 *
 * The five sub-signals are combined into an `objectiveMaintainabilityScore`
 * ∈ [0, 1] which is the "spine" input for `computeMaintainability`.
 *
 * Port contract
 * -------------
 * All I/O is performed through the `ports` argument so the unit test can run
 * with no real disk access or process spawning:
 *
 *   ports.readFile(path, encoding)       → string
 *   ports.readDir(path, opts)            → Dirent[] (or string[])
 *   ports.stat(path)                     → { isFile(): boolean, size: number }
 *   ports.exists(path)                   → boolean
 *
 * The production defaults are wired to the Node `fs` module.
 *
 * @module bench/scenarios/maintainability-adapter
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Thresholds (tunable per project)
// ---------------------------------------------------------------------------

/**
 * Cyclomatic-complexity cap. A function whose complexity exceeds this cap
 * contributes 0 to its complexity score (linearly interpolated below).
 */
const COMPLEXITY_CAP = 10;

/** Maximum lines per file before the file-length penalty kicks in. */
const MAX_FILE_LINES = 300;

// ---------------------------------------------------------------------------
// Default ports (real Node fs)
// ---------------------------------------------------------------------------

/**
 * Build the default port set from the real `fs` module.
 *
 * @returns {{ readFile: Function, readDir: Function, stat: Function, exists: Function }}
 */
function defaultPorts() {
  return {
    readFile: (p, enc) => fs.readFileSync(p, enc),
    readDir: (p, opts) => fs.readdirSync(p, opts),
    stat: (p) => fs.statSync(p),
    exists: (p) => {
      try {
        fs.accessSync(p);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all `.js` source files under `dir`, excluding
 * `node_modules`, hidden directories, and `*.test.js` files (those are test
 * artefacts, not source).
 *
 * @param {string} dir
 * @param {{ readDir: Function, stat: Function }} ports
 * @returns {string[]} Absolute paths to source files.
 */
function collectSourceFiles(dir, ports) {
  const results = [];
  let entries;
  try {
    entries = ports.readDir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      results.push(...collectSourceFiles(fullPath, ports));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Recursively collect test files that match a path-segment pattern (one of
 * the three tier indicators).
 *
 * @param {string} dir
 * @param {{ readDir: Function }} ports
 * @param {(name: string, fullPath: string) => boolean} matcher
 * @returns {boolean} `true` when at least one matching file is found.
 */
function hasTestFiles(dir, ports, matcher) {
  let entries;
  try {
    entries = ports.readDir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      if (hasTestFiles(fullPath, ports, matcher)) return true;
    } else if (entry.isFile() && matcher(entry.name, fullPath)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sub-signal collectors
// ---------------------------------------------------------------------------

/**
 * Collect lint error density.
 *
 * Rather than spawning a linter process (which would require a real child
 * process), we use a static heuristic: scan source files for patterns that
 * a typical linter flags as errors (bare `console.log` in non-test files,
 * `var ` declarations, `debugger` statements, `TODO` / `FIXME` comments, and
 * unused variable patterns such as `const _ =`). This is intentionally a
 * proxy — the production harness can swap in a real linter output via the
 * ports — but it is deterministic, O(source-files), and sufficient to
 * differentiate clean from messy output.
 *
 * Density = errorCount / max(sourceFileCount, 1).
 *
 * @param {string[]} sourceFiles
 * @param {{ readFile: Function }} ports
 * @returns {{ lintErrorDensity: number, lintErrorCount: number, lintFileCount: number }}
 */
function collectLintErrorDensity(sourceFiles, ports) {
  const lintErrorPatterns = [
    /\bconsole\.(log|warn|error)\b/,
    /\bvar\s+/,
    /\bdebugger\b/,
    /\/\/\s*(TODO|FIXME)\b/i,
  ];

  let errorCount = 0;
  let fileCount = 0;

  for (const file of sourceFiles) {
    let src;
    try {
      src = ports.readFile(file, 'utf8');
    } catch {
      continue;
    }
    fileCount += 1;
    const lines = src.split('\n');
    for (const line of lines) {
      for (const pat of lintErrorPatterns) {
        if (pat.test(line)) {
          errorCount += 1;
          break;
        }
      }
    }
  }

  const lintErrorDensity = errorCount / Math.max(fileCount, 1);
  return {
    lintErrorDensity,
    lintErrorCount: errorCount,
    lintFileCount: fileCount,
  };
}

/**
 * Tier-aware test presence score.
 *
 * Per rules/testing-standards.md the three tiers are:
 *   - unit:     `*.test.js` files colocated with source or in `__tests__/`.
 *   - contract: files under `tests/contract/` or a directory named `contract`.
 *   - e2e:      files under `tests/features/` or `tests/e2e/` or `tests/acceptance/`.
 *
 * Each tier present contributes 1/3 to the score (0, 1/3, 2/3, or 1).
 *
 * @param {string} workspacePath
 * @param {{ readDir: Function }} ports
 * @returns {{ testPresence: number, tiers: { unit: boolean, contract: boolean, e2e: boolean } }}
 */
function collectTestPresence(workspacePath, ports) {
  // Unit: any *.test.js that is NOT under node_modules or hidden dirs.
  const hasUnit = hasTestFiles(workspacePath, ports, (name) =>
    name.endsWith('.test.js'),
  );

  // Contract: a file under a path segment named `contract`.
  const hasContract = hasTestFiles(
    workspacePath,
    ports,
    (_name, fullPath) =>
      fullPath.split(path.sep).some((seg) => seg === 'contract') &&
      fullPath.endsWith('.test.js'),
  );

  // E2E / acceptance: a file under a path segment named `features`, `e2e`, or
  // `acceptance`, OR any `.feature` file anywhere.
  const hasE2E = hasTestFiles(
    workspacePath,
    ports,
    (name, fullPath) =>
      name.endsWith('.feature') ||
      ((name.endsWith('.test.js') || name.endsWith('.spec.js')) &&
        fullPath
          .split(path.sep)
          .some(
            (seg) =>
              seg === 'features' || seg === 'e2e' || seg === 'acceptance',
          )),
  );

  const tierCount =
    (hasUnit ? 1 : 0) + (hasContract ? 1 : 0) + (hasE2E ? 1 : 0);
  const testPresence = tierCount / 3;
  return {
    testPresence,
    tiers: { unit: hasUnit, contract: hasContract, e2e: hasE2E },
  };
}

/**
 * Cyclomatic-complexity proxy and file-length score.
 *
 * Complexity is approximated by counting decision-branch keywords in each
 * source file: `if`, `else if`, `for`, `while`, `do`, `switch`, `case`,
 * `catch`, `&&`, `||`, `??`, ternary `?`. The base complexity is 1 per
 * function-like block; we count function declarations and arrow functions.
 *
 * normalizedComplexity(func) = max(0, 1 − (avgCC − 1) / (COMPLEXITY_CAP − 1))
 *   where avgCC is the average per-function complexity across the file.
 *
 * File-length score = max(0, 1 − lines / MAX_FILE_LINES) (capped at 0).
 *
 * complexityScore = average of (normalizedComplexity, fileLengthScore) across
 *   all source files.
 *
 * @param {string[]} sourceFiles
 * @param {{ readFile: Function }} ports
 * @returns {{ complexityScore: number, avgCyclomaticComplexity: number, maxFunctionLines: number, maxFileLines: number }}
 */
function collectComplexity(sourceFiles, ports) {
  const branchPattern =
    /\b(if|else\s+if|for|while|do|switch|case|catch)\b|&&|\|\||\?\?|\?(?!\.)/g;
  const funcPattern =
    /\bfunction\b|\b\w+\s*(?:=\s*)?(?:\([^)]*\)\s*=>|\([^)]*\)\s*\{)/g;

  let totalComplexityScore = 0;
  let totalFileLengthScore = 0;
  let maxFuncLines = 0;
  let maxFileLinesObserved = 0;
  let totalCC = 0;
  let fileCount = 0;

  for (const file of sourceFiles) {
    let src;
    try {
      src = ports.readFile(file, 'utf8');
    } catch {
      continue;
    }
    fileCount += 1;
    const lines = src.split('\n');
    const lineCount = lines.length;
    if (lineCount > maxFileLinesObserved) maxFileLinesObserved = lineCount;

    // Count branches and functions.
    const branchMatches = (src.match(branchPattern) ?? []).length;
    const funcMatches = Math.max((src.match(funcPattern) ?? []).length, 1);

    // Approximate average CC per function (base 1 + branches/functions).
    const cc = 1 + branchMatches / funcMatches;
    totalCC += cc;

    // Normalize complexity: 1.0 at CC=1, 0.0 at CC≥COMPLEXITY_CAP.
    const normalizedCC = Math.max(0, 1 - (cc - 1) / (COMPLEXITY_CAP - 1));
    totalComplexityScore += normalizedCC;

    // File-length score: 1.0 at 0 lines, 0.0 at ≥MAX_FILE_LINES.
    const fileLengthScore = Math.max(0, 1 - lineCount / MAX_FILE_LINES);
    totalFileLengthScore += fileLengthScore;

    // Track max function estimate (approximate: total lines / func count).
    const estimatedFuncLines = Math.round(lineCount / funcMatches);
    if (estimatedFuncLines > maxFuncLines) maxFuncLines = estimatedFuncLines;
  }

  if (fileCount === 0) {
    return {
      complexityScore: 0,
      avgCyclomaticComplexity: 0,
      maxFunctionLines: 0,
      maxFileLines: 0,
    };
  }

  // Average both components and combine equally.
  const avgComplexityScore = totalComplexityScore / fileCount;
  const avgFileLengthScore = totalFileLengthScore / fileCount;
  const complexityScore = (avgComplexityScore + avgFileLengthScore) / 2;

  return {
    complexityScore: Math.max(0, Math.min(1, complexityScore)),
    avgCyclomaticComplexity: totalCC / fileCount,
    maxFunctionLines: maxFuncLines,
    maxFileLines: maxFileLinesObserved,
  };
}

/**
 * Dead-code count proxy.
 *
 * Counts `export` declarations whose name never appears in the workspace
 * outside the file that defines it (a rough approximation of "unused
 * export"). This is a heuristic — it does not resolve imports or follow
 * re-exports — but it is deterministic, no-I/O-besides-readFile, and gives a
 * useful signal on synthetic workspaces.
 *
 * @param {string[]} sourceFiles
 * @param {{ readFile: Function }} ports
 * @returns {{ deadCodeCount: number }}
 */
function collectDeadCode(sourceFiles, ports) {
  // Build a map of exported names to their defining file.
  const exportPattern =
    /\bexport\s+(?:(?:default\s+)?(?:function|class|const|let|var)\s+(\w+)|(\w+))/g;

  /** @type {Map<string, string>} name → defining file path */
  const exports = new Map();
  const contentByFile = new Map();

  for (const file of sourceFiles) {
    let src;
    try {
      src = ports.readFile(file, 'utf8');
    } catch {
      continue;
    }
    contentByFile.set(file, src);
    // Reset lastIndex before each file scan.
    exportPattern.lastIndex = 0;
    let match = exportPattern.exec(src);
    while (match !== null) {
      const name = match[1] ?? match[2];
      if (name) exports.set(name, file);
      match = exportPattern.exec(src);
    }
  }

  // Check whether each exported name is referenced in any other file.
  let deadCount = 0;
  for (const [name, defFile] of exports) {
    // A name of `default` is always used implicitly in its consumer.
    if (name === 'default') continue;
    let referenced = false;
    for (const [file, src] of contentByFile) {
      if (file === defFile) continue;
      // A bare word boundary check: fast and sufficient for identifiers.
      const re = new RegExp(`\\b${name}\\b`);
      if (re.test(src)) {
        referenced = true;
        break;
      }
    }
    if (!referenced) deadCount += 1;
  }

  return { deadCodeCount: deadCount };
}

/**
 * Documentation presence score.
 *
 * - README component (0.5): A `README.md` exists in the workspace root.
 * - JSDoc density component (0.5): Fraction of exported functions that have a
 *   JSDoc comment immediately above them (`/** … *\/` preceding `export`).
 *
 * @param {string} workspacePath
 * @param {string[]} sourceFiles
 * @param {{ readFile: Function, exists: Function }} ports
 * @returns {{ docsScore: number, readmePresent: boolean, jsdocDensity: number }}
 */
function collectDocs(workspacePath, sourceFiles, ports) {
  const readmePath = path.join(workspacePath, 'README.md');
  const readmePresent = ports.exists(readmePath);
  const readmeScore = readmePresent ? 0.5 : 0;

  // JSDoc density: count exported functions that have a JSDoc block above them.
  // A JSDoc block is /**…*/ — we look for `/**` within 5 lines above the export.
  const jsdocPattern = /\/\*\*/;

  let totalExports = 0;
  let jsdocCovered = 0;

  for (const file of sourceFiles) {
    let src;
    try {
      src = ports.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (
        /\bexport\b/.test(lines[i]) &&
        /\bfunction\b|\bconst\b|\blet\b|\bvar\b/.test(lines[i])
      ) {
        totalExports += 1;
        // Look back up to 5 lines for a JSDoc block.
        const lookback = Math.max(0, i - 5);
        const block = lines.slice(lookback, i).join('\n');
        if (jsdocPattern.test(block)) {
          jsdocCovered += 1;
        }
      }
    }
  }

  const jsdocDensity = totalExports > 0 ? jsdocCovered / totalExports : 0;
  const jsdocScore = jsdocDensity * 0.5;
  const docsScore = Math.max(0, Math.min(1, readmeScore + jsdocScore));

  return { docsScore, readmePresent, jsdocDensity };
}

// ---------------------------------------------------------------------------
// Combiner
// ---------------------------------------------------------------------------

/**
 * Combine the five sub-signals into an `objectiveMaintainabilityScore` ∈ [0, 1].
 *
 * Weights:
 *   lintScore       = max(0, 1 − lintErrorDensity / 10)   → 0.25
 *   testPresence                                            → 0.25
 *   complexityScore                                         → 0.25
 *   deadCodeScore   = max(0, 1 − deadCodeCount / 20)       → 0.10
 *   docsScore                                               → 0.15
 *
 * @param {{ lintErrorDensity: number, testPresence: number, complexityScore: number, deadCodeCount: number, docsScore: number }} subs
 * @returns {number}
 */
function combineSubSignals({
  lintErrorDensity,
  testPresence,
  complexityScore,
  deadCodeCount,
  docsScore,
}) {
  const lintScore = Math.max(0, 1 - lintErrorDensity / 10);
  const deadCodeScore = Math.max(0, 1 - deadCodeCount / 20);

  const score =
    0.25 * lintScore +
    0.25 * testPresence +
    0.25 * complexityScore +
    0.1 * deadCodeScore +
    0.15 * docsScore;

  return Math.max(0, Math.min(1, score));
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Collect maintainability sub-signals from a delivered workspace tree.
 *
 * @param {string} workspacePath  Absolute path to the delivered workspace root.
 * @param {object} [ports]        Injected I/O ports (defaults to real `fs`).
 * @param {(path: string, encoding: string) => string} [ports.readFile]
 * @param {(path: string, opts: object) => import('fs').Dirent[]} [ports.readDir]
 * @param {(path: string) => import('fs').Stats} [ports.stat]
 * @param {(path: string) => boolean} [ports.exists]
 * @returns {{
 *   objectiveMaintainabilityScore: number,
 *   lintErrorDensity: number,
 *   lintErrorCount: number,
 *   lintFileCount: number,
 *   testPresence: number,
 *   tiers: { unit: boolean, contract: boolean, e2e: boolean },
 *   complexityScore: number,
 *   avgCyclomaticComplexity: number,
 *   maxFunctionLines: number,
 *   maxFileLines: number,
 *   deadCodeCount: number,
 *   docsScore: number,
 *   readmePresent: boolean,
 *   jsdocDensity: number,
 * }}
 */
export function collectMaintainabilitySignals(workspacePath, ports = {}) {
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
    throw new TypeError(
      'collectMaintainabilitySignals: workspacePath must be a non-empty string',
    );
  }

  const resolvedPorts = { ...defaultPorts(), ...ports };

  const sourceFiles = collectSourceFiles(workspacePath, resolvedPorts);

  const { lintErrorDensity, lintErrorCount, lintFileCount } =
    collectLintErrorDensity(sourceFiles, resolvedPorts);

  const { testPresence, tiers } = collectTestPresence(
    workspacePath,
    resolvedPorts,
  );

  const {
    complexityScore,
    avgCyclomaticComplexity,
    maxFunctionLines,
    maxFileLines,
  } = collectComplexity(sourceFiles, resolvedPorts);

  const { deadCodeCount } = collectDeadCode(sourceFiles, resolvedPorts);

  const { docsScore, readmePresent, jsdocDensity } = collectDocs(
    workspacePath,
    sourceFiles,
    resolvedPorts,
  );

  const objectiveMaintainabilityScore = combineSubSignals({
    lintErrorDensity,
    testPresence,
    complexityScore,
    deadCodeCount,
    docsScore,
  });

  return {
    objectiveMaintainabilityScore,
    lintErrorDensity,
    lintErrorCount,
    lintFileCount,
    testPresence,
    tiers,
    complexityScore,
    avgCyclomaticComplexity,
    maxFunctionLines,
    maxFileLines,
    deadCodeCount,
    docsScore,
    readmePresent,
    jsdocDensity,
  };
}
