/**
 * Unit tests for bench/scenarios/maintainability-adapter.js (Story #39).
 *
 * All I/O is performed through injected ports — no real disk access, no real
 * process spawning. Tests are deterministic, isolated, and parallelizable.
 *
 * Coverage:
 *   - Exported function contract (throws on bad args).
 *   - Each sub-signal in isolation via fixture workspaces.
 *   - Combined objectiveMaintainabilityScore from a clean and a messy fixture.
 *   - Shape of the returned object (for computeMaintainability compatibility).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectMaintainabilitySignals } from '../../../bench/scenarios/maintainability-adapter.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal injected-port set from an in-memory file tree.
 *
 * `tree` is a flat map of absolute paths → file content (string).
 * Directories are inferred from the paths — any path prefix that is not
 * itself a key in the tree is treated as a directory.
 *
 * @param {Record<string, string>} tree  path → content
 * @returns {{ readFile: Function, readDir: Function, stat: Function, exists: Function }}
 */
function makePorts(tree) {
  /**
   * Return children (files + dirs) of `dir` as Dirent-shaped objects.
   * @param {string} dir
   */
  function listDir(dir) {
    const dirWithSep = dir.endsWith('/') ? dir : `${dir}/`;
    const seen = new Set();
    const entries = [];

    for (const p of Object.keys(tree)) {
      if (!p.startsWith(dirWithSep)) continue;
      const rest = p.slice(dirWithSep.length);
      const firstSeg = rest.split('/')[0];
      if (!firstSeg || seen.has(firstSeg)) continue;
      seen.add(firstSeg);
      const fullPath = `${dirWithSep}${firstSeg}`;
      const isFile = Object.hasOwn(tree, fullPath);
      entries.push({
        name: firstSeg,
        isFile: () => isFile,
        isDirectory: () => !isFile,
      });
    }
    return entries;
  }

  return {
    readFile(p, _enc) {
      if (!Object.hasOwn(tree, p)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return tree[p];
    },
    readDir(dir, _opts) {
      return listDir(dir);
    },
    stat(p) {
      const content = tree[p];
      if (content === undefined) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return { isFile: () => true, size: content.length };
    },
    exists(p) {
      return Object.hasOwn(tree, p);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT = '/workspace';

/** A "clean" fixture: README, JSDoc, a unit test, clean source, no dead code. */
function makeCleanTree() {
  return {
    [`${ROOT}/README.md`]: '# My Project\n\nThis is a description.\n',
    [`${ROOT}/src/index.js`]: [
      '/**',
      ' * Entry point.',
      ' */',
      'export function greet(name) {',
      // The source fixture uses a template literal; write it as string concat
      // to avoid the noTemplateCurlyInString lint rule on this test file.
      '  return "Hello, " + name + "!";',
      '}',
    ].join('\n'),
    [`${ROOT}/tests/unit/greet.test.js`]: [
      'import { greet } from "../../src/index.js";',
      'import assert from "node:assert/strict";',
      'assert.equal(greet("World"), "Hello, World!");',
    ].join('\n'),
  };
}

/** A "messy" fixture: no README, no JSDoc, no tests, console.log, TODO, high complexity. */
function makeMessyTree() {
  const branchHeavyCode = [
    'export function compute(x, y, z) {',
    '  // TODO: refactor this',
    '  console.log("computing");',
    '  if (x > 0) {',
    '    if (y > 0) {',
    '      if (z > 0) {',
    '        for (let i = 0; i < x; i++) {',
    '          while (y-- > 0) {',
    '            if (z && y || x) {',
    '              switch (x) {',
    '                case 1: break;',
    '                case 2: break;',
    '              }',
    '            }',
    '          }',
    '        }',
    '      }',
    '    }',
    '  }',
    '  return x + y + z;',
    '}',
    '',
    'export function helper(a) {',
    '  return a ?? 0;',
    '}',
  ].join('\n');

  return {
    [`${ROOT}/src/messy.js`]: branchHeavyCode,
  };
}

// ---------------------------------------------------------------------------
// Contract tests
// ---------------------------------------------------------------------------

describe('collectMaintainabilitySignals — contract', () => {
  it('throws TypeError when workspacePath is empty', () => {
    assert.throws(
      () => collectMaintainabilitySignals('', makePorts({})),
      TypeError,
    );
  });

  it('throws TypeError when workspacePath is not a string', () => {
    assert.throws(
      () => collectMaintainabilitySignals(null, makePorts({})),
      TypeError,
    );
  });

  it('returns an object with all required sub-signal keys', () => {
    const ports = makePorts(makeCleanTree());
    const result = collectMaintainabilitySignals(ROOT, ports);

    const requiredKeys = [
      'objectiveMaintainabilityScore',
      'lintErrorDensity',
      'lintErrorCount',
      'lintFileCount',
      'testPresence',
      'tiers',
      'complexityScore',
      'avgCyclomaticComplexity',
      'maxFunctionLines',
      'maxFileLines',
      'deadCodeCount',
      'docsScore',
      'readmePresent',
      'jsdocDensity',
    ];

    for (const key of requiredKeys) {
      assert.ok(Object.hasOwn(result, key), `missing key: ${key}`);
    }
  });

  it('objectiveMaintainabilityScore is in [0, 1]', () => {
    const ports = makePorts(makeCleanTree());
    const { objectiveMaintainabilityScore } = collectMaintainabilitySignals(
      ROOT,
      ports,
    );
    assert.ok(
      objectiveMaintainabilityScore >= 0 && objectiveMaintainabilityScore <= 1,
      `expected [0,1], got ${objectiveMaintainabilityScore}`,
    );
  });

  it('tiers object has unit, contract, e2e boolean properties', () => {
    const ports = makePorts(makeCleanTree());
    const { tiers } = collectMaintainabilitySignals(ROOT, ports);
    assert.equal(typeof tiers.unit, 'boolean');
    assert.equal(typeof tiers.contract, 'boolean');
    assert.equal(typeof tiers.e2e, 'boolean');
  });
});

// ---------------------------------------------------------------------------
// Sub-signal tests
// ---------------------------------------------------------------------------

describe('lintErrorDensity', () => {
  it('is 0 for a clean file with no lint patterns', () => {
    const ports = makePorts(makeCleanTree());
    const { lintErrorDensity } = collectMaintainabilitySignals(ROOT, ports);
    assert.equal(lintErrorDensity, 0);
  });

  it('is > 0 for a file with console.log and TODO', () => {
    const ports = makePorts(makeMessyTree());
    const { lintErrorDensity } = collectMaintainabilitySignals(ROOT, ports);
    assert.ok(lintErrorDensity > 0, `expected > 0, got ${lintErrorDensity}`);
  });

  it('counts var declarations as lint errors', () => {
    const tree = {
      [`${ROOT}/src/legacy.js`]: 'export var x = 1;\nvar y = 2;\n',
    };
    const ports = makePorts(tree);
    const { lintErrorCount } = collectMaintainabilitySignals(ROOT, ports);
    assert.ok(
      lintErrorCount >= 2,
      `expected ≥ 2 errors for two var lines, got ${lintErrorCount}`,
    );
  });
});

describe('testPresence — tier-aware', () => {
  it('detects unit tests (*.test.js files)', () => {
    const tree = {
      [`${ROOT}/src/foo.js`]: 'export function foo() {}',
      [`${ROOT}/src/foo.test.js`]: 'import { foo } from "./foo.js";',
    };
    const ports = makePorts(tree);
    const { tiers, testPresence } = collectMaintainabilitySignals(ROOT, ports);
    assert.equal(tiers.unit, true, 'unit tier should be detected');
    assert.ok(testPresence > 0);
  });

  it('detects contract tests (files under a "contract" directory)', () => {
    const tree = {
      [`${ROOT}/src/foo.js`]: 'export function foo() {}',
      [`${ROOT}/tests/contract/foo.test.js`]:
        'import { foo } from "../../src/foo.js";',
    };
    const ports = makePorts(tree);
    const { tiers } = collectMaintainabilitySignals(ROOT, ports);
    assert.equal(tiers.contract, true, 'contract tier should be detected');
  });

  it('detects e2e tests (*.feature files)', () => {
    const tree = {
      [`${ROOT}/src/foo.js`]: 'export function foo() {}',
      [`${ROOT}/tests/features/foo.feature`]: 'Feature: foo\n  Scenario: bar\n',
    };
    const ports = makePorts(tree);
    const { tiers } = collectMaintainabilitySignals(ROOT, ports);
    assert.equal(
      tiers.e2e,
      true,
      'e2e tier should be detected via .feature file',
    );
  });

  it('scores 1/3 for unit-only, 2/3 for unit+contract, 1.0 for all three tiers', () => {
    const unitOnly = {
      [`${ROOT}/src/foo.js`]: 'export function foo() {}',
      [`${ROOT}/tests/foo.test.js`]: 'import { foo } from "../src/foo.js";',
    };
    const unitContract = {
      ...unitOnly,
      [`${ROOT}/tests/contract/foo.test.js`]: '',
    };
    const allTiers = {
      ...unitContract,
      [`${ROOT}/tests/features/foo.feature`]: 'Feature: x',
    };

    const r1 = collectMaintainabilitySignals(ROOT, makePorts(unitOnly));
    const r2 = collectMaintainabilitySignals(ROOT, makePorts(unitContract));
    const r3 = collectMaintainabilitySignals(ROOT, makePorts(allTiers));

    assert.ok(
      Math.abs(r1.testPresence - 1 / 3) < 1e-9,
      `expected 1/3, got ${r1.testPresence}`,
    );
    assert.ok(
      Math.abs(r2.testPresence - 2 / 3) < 1e-9,
      `expected 2/3, got ${r2.testPresence}`,
    );
    assert.ok(
      Math.abs(r3.testPresence - 1) < 1e-9,
      `expected 1, got ${r3.testPresence}`,
    );
  });

  it('returns 0 for a workspace with no test files', () => {
    const tree = {
      [`${ROOT}/src/foo.js`]: 'export function foo() {}',
    };
    const ports = makePorts(tree);
    const { testPresence } = collectMaintainabilitySignals(ROOT, ports);
    assert.equal(testPresence, 0);
  });
});

describe('complexityScore', () => {
  it('is higher (closer to 1) for a simple function than a branch-heavy one', () => {
    const simpleTree = {
      [`${ROOT}/src/simple.js`]: 'export function add(a, b) { return a + b; }',
    };
    const complexTree = makeMessyTree();

    const simpleResult = collectMaintainabilitySignals(
      ROOT,
      makePorts(simpleTree),
    );
    const complexResult = collectMaintainabilitySignals(
      ROOT,
      makePorts(complexTree),
    );

    assert.ok(
      simpleResult.complexityScore > complexResult.complexityScore,
      `simple (${simpleResult.complexityScore}) should beat complex (${complexResult.complexityScore})`,
    );
  });

  it('is 0 for an empty workspace (no source files)', () => {
    const ports = makePorts({});
    const { complexityScore } = collectMaintainabilitySignals(ROOT, ports);
    assert.equal(complexityScore, 0);
  });
});

describe('deadCodeCount', () => {
  it('counts 0 dead exports when all exports are referenced across files', () => {
    const tree = {
      [`${ROOT}/src/util.js`]: 'export function add(a, b) { return a + b; }',
      [`${ROOT}/src/main.js`]:
        'import { add } from "./util.js";\nexport function run() { return add(1, 2); }',
    };
    const ports = makePorts(tree);
    const { deadCodeCount } = collectMaintainabilitySignals(ROOT, ports);
    // `add` is referenced in main.js; `run` may be unreferenced but is the
    // top-level public export. The count should be ≤ 1 (only `run` is candidate).
    assert.ok(deadCodeCount <= 1, `expected ≤ 1, got ${deadCodeCount}`);
  });

  it('counts unreferenced exports', () => {
    const tree = {
      [`${ROOT}/src/orphan.js`]: [
        'export function unusedA() { return 1; }',
        'export function unusedB() { return 2; }',
      ].join('\n'),
    };
    const ports = makePorts(tree);
    const { deadCodeCount } = collectMaintainabilitySignals(ROOT, ports);
    // Both exports are unreferenced — no other file imports them.
    assert.ok(deadCodeCount >= 2, `expected ≥ 2, got ${deadCodeCount}`);
  });
});

describe('docsScore', () => {
  it('is > 0.4 for a workspace with README and JSDoc on exports', () => {
    const ports = makePorts(makeCleanTree());
    const { docsScore, readmePresent, jsdocDensity } =
      collectMaintainabilitySignals(ROOT, ports);
    assert.equal(readmePresent, true, 'README should be detected');
    assert.ok(
      jsdocDensity > 0,
      `jsdocDensity should be > 0, got ${jsdocDensity}`,
    );
    assert.ok(docsScore > 0.4, `expected docsScore > 0.4, got ${docsScore}`);
  });

  it('is 0.5 (README only) when source files have no JSDoc', () => {
    const tree = {
      [`${ROOT}/README.md`]: '# Docs',
      [`${ROOT}/src/nodoc.js`]: 'export function foo() { return 1; }',
    };
    const ports = makePorts(tree);
    const { docsScore, readmePresent, jsdocDensity } =
      collectMaintainabilitySignals(ROOT, ports);
    assert.equal(readmePresent, true);
    assert.equal(jsdocDensity, 0);
    // docsScore = 0.5 (readme) + 0 (no JSDoc) = 0.5
    assert.ok(
      Math.abs(docsScore - 0.5) < 1e-9,
      `expected 0.5, got ${docsScore}`,
    );
  });

  it('is 0 when there is no README and no JSDoc', () => {
    const tree = {
      [`${ROOT}/src/bare.js`]: 'export function foo() { return 1; }',
    };
    const ports = makePorts(tree);
    const { docsScore, readmePresent, jsdocDensity } =
      collectMaintainabilitySignals(ROOT, ports);
    assert.equal(readmePresent, false);
    assert.equal(jsdocDensity, 0);
    assert.equal(docsScore, 0);
  });
});

// ---------------------------------------------------------------------------
// Integration: shape compatible with computeMaintainability
// ---------------------------------------------------------------------------

describe('objectiveMaintainabilityScore — integration with computeMaintainability', () => {
  it('clean workspace scores higher than messy workspace', () => {
    const cleanResult = collectMaintainabilitySignals(
      ROOT,
      makePorts(makeCleanTree()),
    );
    const messyResult = collectMaintainabilitySignals(
      ROOT,
      makePorts(makeMessyTree()),
    );

    assert.ok(
      cleanResult.objectiveMaintainabilityScore >
        messyResult.objectiveMaintainabilityScore,
      `clean (${cleanResult.objectiveMaintainabilityScore}) should beat messy (${messyResult.objectiveMaintainabilityScore})`,
    );
  });

  it('returned shape satisfies computeMaintainability input contract', async () => {
    const { computeMaintainability } = await import(
      '../../../bench/score/dimensions.js'
    );
    const ports = makePorts(makeCleanTree());
    const subs = collectMaintainabilitySignals(ROOT, ports);

    // Pass the spine directly as objectiveMaintainabilityScore and no judge.
    const dim = computeMaintainability({
      objectiveMaintainabilityScore: subs.objectiveMaintainabilityScore,
      maintainabilityJudgeScore: null,
      lintWarnings: subs.lintErrorCount,
      complexityScore: subs.complexityScore,
      maintainabilityIndex: null,
    });

    assert.equal(typeof dim.score, 'number');
    assert.ok(
      dim.score >= 0 && dim.score <= 1,
      `score must be in [0,1], got ${dim.score}`,
    );
    // When judge is null and objectiveMaintainabilityScore is the spine,
    // the returned score must equal the spine.
    assert.ok(
      Math.abs(dim.score - subs.objectiveMaintainabilityScore) < 1e-9,
      `dimension score (${dim.score}) must equal spine (${subs.objectiveMaintainabilityScore}) when no judge`,
    );
  });

  it('is deterministic — calling twice with same fixture yields same result', () => {
    const ports = makePorts(makeCleanTree());
    const a = collectMaintainabilitySignals(ROOT, ports);
    const b = collectMaintainabilitySignals(ROOT, ports);
    assert.deepEqual(a, b, 'results must be identical across two calls');
  });
});
