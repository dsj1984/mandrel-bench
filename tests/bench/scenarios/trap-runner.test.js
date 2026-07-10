// tests/bench/scenarios/trap-runner.test.js
/**
 * Unit tests for bench/scenarios/trap-runner.js — Epic #66, Story #74.
 *
 * Verifies the shared per-class trap-oracle runner:
 *   - discovers traps/<class>.js modules under a scenario dir (derives the
 *     class name from the filename, sorted for determinism),
 *   - executes each oracle's evaluate(deliveredTreePath),
 *   - aggregates { classes[], cleanRate } (cleanRate = mean of per-class
 *     scores),
 *   - a scenario with no traps/ directory yields an empty classes[] and a
 *     null cleanRate rather than throwing.
 *
 * Every filesystem/import effect is INJECTED — no real scenario directories
 * or dynamic import() calls.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_TRAPS_SUBDIR,
  discoverTrapModules,
  runTrapOracles,
  TOUCH2_TRAPS_SUBDIR,
} from '../../../bench/scenarios/trap-runner.js';

const SCENARIO_DIR = '/repo/bench/scenarios/epic-scope';
const TRAPS_DIR = path.join(SCENARIO_DIR, 'traps');
const TRAPS_TOUCH2_DIR = path.join(SCENARIO_DIR, 'traps-touch2');
const DELIVERED_TREE = '/ws-mandrel';

/** Minimal Dirent-shaped fake — only what discoverTrapModules reads. */
function fileEntry(name) {
  return { name, isFile: () => true, isDirectory: () => false };
}
function dirEntry(name) {
  return { name, isFile: () => false, isDirectory: () => true };
}

test('discoverTrapModules: lists traps/<class>.js modules, sorted by class name', () => {
  const modules = discoverTrapModules(SCENARIO_DIR, {
    readdirFn: (dir) => {
      assert.equal(dir, TRAPS_DIR);
      return [
        fileEntry('idor.js'),
        fileEntry('hardcoded-secret.js'),
        fileEntry('plaintext-password.js'),
        dirEntry('fixtures'), // non-file entries are ignored
        fileEntry('README.md'), // non-.js files are ignored
      ];
    },
  });
  assert.deepEqual(
    modules.map((m) => m.class),
    ['hardcoded-secret', 'idor', 'plaintext-password'],
  );
  assert.equal(
    modules.find((m) => m.class === 'idor').modulePath,
    path.join(TRAPS_DIR, 'idor.js'),
  );
});

test('discoverTrapModules: a missing traps/ directory yields an empty list, not an error', () => {
  const modules = discoverTrapModules(SCENARIO_DIR, {
    readdirFn: () => {
      throw new Error('ENOENT: no such directory');
    },
  });
  assert.deepEqual(modules, []);
});

test('discoverTrapModules: rejects a missing scenarioDir', () => {
  assert.throws(() => discoverTrapModules(''), /non-empty scenarioDir/);
});

test('runTrapOracles: executes every discovered oracle against the delivered tree and aggregates cleanRate as the mean of per-class scores', async () => {
  const seenArgs = [];
  const verdicts = {
    [path.join(TRAPS_DIR, 'idor.js')]: {
      score: 1,
      defectPresent: false,
      evidence: ['no cross-user resource access detected'],
    },
    [path.join(TRAPS_DIR, 'plaintext-password.js')]: {
      score: 0,
      defectPresent: true,
      evidence: ['plaintext password persisted'],
    },
  };

  const result = await runTrapOracles(
    { scenarioDir: SCENARIO_DIR, deliveredTreePath: DELIVERED_TREE },
    {
      readdirFn: () => [
        fileEntry('idor.js'),
        fileEntry('plaintext-password.js'),
      ],
      importImpl: async (modulePath) => ({
        evaluate: async (deliveredTreePath) => {
          seenArgs.push({ modulePath, deliveredTreePath });
          return verdicts[modulePath];
        },
      }),
    },
  );

  // Every discovered oracle received the SAME delivered-tree path.
  assert.deepEqual(
    seenArgs.map((a) => a.deliveredTreePath),
    [DELIVERED_TREE, DELIVERED_TREE],
  );

  assert.deepEqual(result, {
    classes: [
      {
        class: 'idor',
        score: 1,
        defectPresent: false,
        evidence: ['no cross-user resource access detected'],
      },
      {
        class: 'plaintext-password',
        score: 0,
        defectPresent: true,
        evidence: ['plaintext password persisted'],
      },
    ],
    // mean(1, 0) = 0.5
    cleanRate: 0.5,
  });
});

test('runTrapOracles: a scenario with no declared trap classes yields an empty classes[] and a null cleanRate', async () => {
  const result = await runTrapOracles(
    { scenarioDir: SCENARIO_DIR, deliveredTreePath: DELIVERED_TREE },
    {
      readdirFn: () => {
        throw new Error('ENOENT');
      },
    },
  );
  assert.deepEqual(result, { classes: [], cleanRate: null });
});

test('runTrapOracles: an oracle verdict may declare its own `class`, overriding the filename-derived default', async () => {
  const result = await runTrapOracles(
    { scenarioDir: SCENARIO_DIR, deliveredTreePath: DELIVERED_TREE },
    {
      readdirFn: () => [fileEntry('token-generation.js')],
      importImpl: async () => ({
        evaluate: async () => ({
          class: 'token-generation-weakness',
          score: 1,
          defectPresent: false,
        }),
      }),
    },
  );
  assert.equal(result.classes[0].class, 'token-generation-weakness');
});

test('runTrapOracles: an oracle without an evidence array omits the field rather than coercing it', async () => {
  const result = await runTrapOracles(
    { scenarioDir: SCENARIO_DIR, deliveredTreePath: DELIVERED_TREE },
    {
      readdirFn: () => [fileEntry('missing-input-validation.js')],
      importImpl: async () => ({
        evaluate: async () => ({ score: 1, defectPresent: false }),
      }),
    },
  );
  assert.deepEqual(result.classes[0], {
    class: 'missing-input-validation',
    score: 1,
    defectPresent: false,
  });
  assert.ok(!('evidence' in result.classes[0]));
});

test('runTrapOracles: a module missing evaluate() throws a clear error', async () => {
  await assert.rejects(
    runTrapOracles(
      { scenarioDir: SCENARIO_DIR, deliveredTreePath: DELIVERED_TREE },
      {
        readdirFn: () => [fileEntry('bad.js')],
        importImpl: async () => ({}),
      },
    ),
    /does not export evaluate/,
  );
});

test('runTrapOracles: rejects a missing scenarioDir or deliveredTreePath', async () => {
  await assert.rejects(
    runTrapOracles({ deliveredTreePath: DELIVERED_TREE }),
    /non-empty scenarioDir/,
  );
  await assert.rejects(
    runTrapOracles({ scenarioDir: SCENARIO_DIR }),
    /non-empty deliveredTreePath/,
  );
});

// ---------------------------------------------------------------------------
// Phase-scoped discovery (Epic #86, Story #96) — the F2 CRITICAL grounding
// point: touch-1 scans traps/ ONLY, touch-2 scans traps-touch2/ ONLY, and the
// touch-1 cleanRate is provably unaffected by the presence of touch-2 oracles.
// ---------------------------------------------------------------------------

/**
 * A readdir fake that serves DISTINCT entry lists per trap subdirectory, so a
 * scan of the wrong dir would surface the wrong oracles. Anything else throws
 * ENOENT (the "no such dir" state discoverTrapModules treats as empty).
 */
function twoDirReaddir({ traps, touch2 }) {
  return (dir) => {
    if (dir === TRAPS_DIR) return traps.map(fileEntry);
    if (dir === TRAPS_TOUCH2_DIR) return touch2.map(fileEntry);
    throw new Error(`ENOENT: ${dir}`);
  };
}

test('DEFAULT_TRAPS_SUBDIR / TOUCH2_TRAPS_SUBDIR are the disjoint touch-1 / touch-2 conventions', () => {
  assert.equal(DEFAULT_TRAPS_SUBDIR, 'traps');
  assert.equal(TOUCH2_TRAPS_SUBDIR, 'traps-touch2');
  assert.notEqual(DEFAULT_TRAPS_SUBDIR, TOUCH2_TRAPS_SUBDIR);
});

test('discoverTrapModules: the default (touch-1) scan reads traps/ ONLY and never traps-touch2/', () => {
  const seenDirs = [];
  const modules = discoverTrapModules(SCENARIO_DIR, {
    readdirFn: (dir) => {
      seenDirs.push(dir);
      return twoDirReaddir({
        traps: ['idor.js', 'plaintext-password.js'],
        touch2: ['regression-isolation.js'],
      })(dir);
    },
  });
  assert.deepEqual(seenDirs, [TRAPS_DIR]);
  assert.deepEqual(
    modules.map((m) => m.class),
    ['idor', 'plaintext-password'],
  );
  // The touch-2 oracle is NEVER discovered by the touch-1 scan.
  assert.ok(!modules.some((m) => m.class === 'regression-isolation'));
});

test('discoverTrapModules: the touch-2 scan reads traps-touch2/ ONLY and never traps/', () => {
  const seenDirs = [];
  const modules = discoverTrapModules(SCENARIO_DIR, {
    subdir: TOUCH2_TRAPS_SUBDIR,
    readdirFn: (dir) => {
      seenDirs.push(dir);
      return twoDirReaddir({
        traps: ['idor.js', 'plaintext-password.js'],
        touch2: ['regression-isolation.js'],
      })(dir);
    },
  });
  assert.deepEqual(seenDirs, [TRAPS_TOUCH2_DIR]);
  assert.deepEqual(
    modules.map((m) => m.class),
    ['regression-isolation'],
  );
  // No touch-1 oracle leaks into the touch-2 scan.
  assert.ok(!modules.some((m) => m.class === 'idor'));
});

test('runTrapOracles: the touch-1 scan and its cleanRate are PROVABLY unaffected by the presence of traps-touch2/', async () => {
  const readdirWithTouch2 = twoDirReaddir({
    traps: ['idor.js', 'plaintext-password.js'],
    touch2: ['regression-isolation.js'],
  });
  const readdirWithoutTouch2 = twoDirReaddir({
    traps: ['idor.js', 'plaintext-password.js'],
    touch2: [],
  });
  const verdicts = {
    [path.join(TRAPS_DIR, 'idor.js')]: { score: 1, defectPresent: false },
    [path.join(TRAPS_DIR, 'plaintext-password.js')]: {
      score: 0,
      defectPresent: true,
    },
    // If this ever ran during a touch-1 scan it would corrupt the cleanRate.
    [path.join(TRAPS_TOUCH2_DIR, 'regression-isolation.js')]: {
      score: 1,
      defectPresent: false,
    },
  };
  const importImpl = async (modulePath) => ({
    evaluate: async () => verdicts[modulePath],
  });

  const withTouch2 = await runTrapOracles(
    { scenarioDir: SCENARIO_DIR, deliveredTreePath: DELIVERED_TREE },
    { readdirFn: readdirWithTouch2, importImpl },
  );
  const withoutTouch2 = await runTrapOracles(
    { scenarioDir: SCENARIO_DIR, deliveredTreePath: DELIVERED_TREE },
    { readdirFn: readdirWithoutTouch2, importImpl },
  );

  // Identical classes and cleanRate whether or not traps-touch2/ exists — the
  // touch-1 scan never globs it (mean(1, 0) = 0.5, no regression oracle folded in).
  assert.deepEqual(
    withTouch2.classes.map((c) => c.class),
    ['idor', 'plaintext-password'],
  );
  assert.equal(withTouch2.cleanRate, 0.5);
  assert.deepEqual(withTouch2, withoutTouch2);
});

test('runTrapOracles: trapsSubdir "traps-touch2" scans ONLY the touch-2 regression oracles', async () => {
  const seenArgs = [];
  const result = await runTrapOracles(
    {
      scenarioDir: SCENARIO_DIR,
      deliveredTreePath: DELIVERED_TREE,
      trapsSubdir: TOUCH2_TRAPS_SUBDIR,
    },
    {
      readdirFn: twoDirReaddir({
        traps: ['idor.js'],
        touch2: ['regression-hashing.js', 'regression-isolation.js'],
      }),
      importImpl: async (modulePath) => ({
        evaluate: async (tree) => {
          seenArgs.push({ modulePath, tree });
          return { score: 1, defectPresent: false };
        },
      }),
    },
  );
  assert.deepEqual(
    result.classes.map((c) => c.class),
    ['regression-hashing', 'regression-isolation'],
  );
  assert.equal(result.cleanRate, 1);
  // Only touch-2 module paths were imported; no traps/ oracle was touched.
  assert.ok(seenArgs.every((a) => a.modulePath.includes('traps-touch2')));
});
