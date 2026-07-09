// tests/bench/report/aggregate.test.js
//
// Unit tier (pure walk + injected I/O, no real disk) for the cross-cohort
// aggregator (Epic #2, Story #17). Exercises bench/report/aggregate.js against
// the Story's binding acceptance item:
//   "An aggregator (a thin FS shell over readStore) reads every per-cohort
//    scorecards.ndjson under results/ into one corpus; a results/ tree with no
//    stores yields an empty (but valid, non-crashing) dashboard."

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  aggregateScorecards,
  findCohortStores,
  STORE_FILENAME,
} from '../../../bench/report/aggregate.js';

/**
 * In-memory filesystem double over a `<dir>` → `[entries]` + `<file>` → contents
 * map. Directories are any path that appears as a key in `tree`; files are keys
 * in `files`.
 */
function fakeFs({ tree = {}, files = {} } = {}) {
  const dirSet = new Set(Object.keys(tree));
  return {
    existsImpl: (p) => dirSet.has(p) || Object.hasOwn(files, p),
    readdirImpl: (p) => tree[p] ?? [],
    statImpl: (p) => ({ isDirectory: () => dirSet.has(p) }),
    readFileImpl: (p) => files[p] ?? '',
  };
}

const ROOT = '/results';

function card(model, version, runId) {
  return JSON.stringify({
    schemaVersion: 1,
    runId,
    timestamp: '2026-06-16T19:42:11.000Z',
    model: { id: model },
    frameworkVersion: version,
    benchmarkVersion: '0.5.0',
    env: { node: 'v24.16.0', os: 'darwin' },
    scenario: 'hello-world',
    arm: 'mandrel',
    dimensions: {
      quality: { score: 1, frozenSuitePassRate: 1 },
      planningFidelity: { score: 0.9 },
      autonomy: { score: 1, hitlStops: 0, blockedEvents: 0, manualRescues: 0 },
      efficiency: { wallClockMs: 1, totalTokens: 1, dispatches: 0 },
      overheadRatio: { tokenRatio: 0 },
    },
  });
}

describe('findCohortStores', () => {
  it('finds every per-cohort store, two levels deep, in sorted order', () => {
    const m1v1 = path.join(ROOT, 'claude-opus-4-8', '1.70.0');
    const m1v2 = path.join(ROOT, 'claude-opus-4-8', '1.71.0');
    const m2v1 = path.join(ROOT, 'claude-sonnet-4-5', '1.70.0');
    const deps = fakeFs({
      tree: {
        [ROOT]: ['claude-sonnet-4-5', 'claude-opus-4-8', 'results.html'],
        [path.join(ROOT, 'claude-opus-4-8')]: ['1.71.0', '1.70.0'],
        [path.join(ROOT, 'claude-sonnet-4-5')]: ['1.70.0'],
        [m1v1]: [],
        [m1v2]: [],
        [m2v1]: [],
      },
      files: {
        [path.join(m1v1, STORE_FILENAME)]: '',
        [path.join(m1v2, STORE_FILENAME)]: '',
        [path.join(m2v1, STORE_FILENAME)]: '',
      },
    });
    const stores = findCohortStores({ resultsDir: ROOT }, deps);
    assert.deepEqual(stores, [
      path.join(m1v1, STORE_FILENAME),
      path.join(m1v2, STORE_FILENAME),
      path.join(m2v1, STORE_FILENAME),
    ]);
  });

  it('skips non-directory entries at the model level (e.g. results.html, README)', () => {
    const deps = fakeFs({
      tree: { [ROOT]: ['results.html', 'README.md'] },
      files: {
        [path.join(ROOT, 'results.html')]: '<html>',
        [path.join(ROOT, 'README.md')]: '# readme',
      },
    });
    assert.deepEqual(findCohortStores({ resultsDir: ROOT }, deps), []);
  });

  it('returns [] for a non-existent results root', () => {
    const deps = fakeFs({});
    assert.deepEqual(findCohortStores({ resultsDir: '/nope' }, deps), []);
  });
});

describe('aggregateScorecards', () => {
  it('reads every cohort store into one flat corpus', () => {
    const v1 = path.join(ROOT, 'claude-opus-4-8', '1.70.0');
    const v2 = path.join(ROOT, 'claude-opus-4-8', '1.71.0');
    const deps = fakeFs({
      tree: {
        [ROOT]: ['claude-opus-4-8'],
        [path.join(ROOT, 'claude-opus-4-8')]: ['1.70.0', '1.71.0'],
        [v1]: [],
        [v2]: [],
      },
      files: {
        [path.join(v1, STORE_FILENAME)]:
          `${card('claude-opus-4-8', '1.70.0', 'a')}\n${card('claude-opus-4-8', '1.70.0', 'b')}\n`,
        [path.join(v2, STORE_FILENAME)]:
          `${card('claude-opus-4-8', '1.71.0', 'c')}\n`,
      },
    });
    const corpus = aggregateScorecards({ resultsDir: ROOT }, deps);
    assert.equal(corpus.length, 3);
    assert.deepEqual(
      corpus.map((c) => c.runId),
      ['a', 'b', 'c'],
    );
    assert.equal(corpus[2].frameworkVersion, '1.71.0');
  });

  it('yields an empty corpus for an empty / absent tree (no crash)', () => {
    assert.deepEqual(
      aggregateScorecards({ resultsDir: '/nope' }, fakeFs({})),
      [],
    );
    const emptyTree = fakeFs({ tree: { [ROOT]: [] } });
    assert.deepEqual(aggregateScorecards({ resultsDir: ROOT }, emptyTree), []);
  });
});
