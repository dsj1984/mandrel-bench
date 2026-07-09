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
  discoverTrapModules,
  runTrapOracles,
} from '../../../bench/scenarios/trap-runner.js';

const SCENARIO_DIR = '/repo/bench/scenarios/epic-scope';
const TRAPS_DIR = path.join(SCENARIO_DIR, 'traps');
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
