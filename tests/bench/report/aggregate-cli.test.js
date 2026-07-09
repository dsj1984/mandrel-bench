// tests/bench/report/aggregate-cli.test.js
//
// Unit tier (pure logic + injected I/O, no real disk, no run) for the standalone
// aggregate entrypoint (Epic #84, Story #90). Exercises
// bench/report/aggregate-cli.js against the Story's binding acceptance item:
//   "bench/report/aggregate-cli.js exists as a standalone entrypoint that merges
//    downloaded scorecard artifacts into results/ (append-only NDJSON) and
//    renders the cohort report + results.html from an existing results tree
//    without invoking any run."
//
// Everything is driven through an in-memory filesystem double so the whole CLI —
// artifact discovery, append-only merge (idempotent by runId), and the
// report/dashboard render — runs with no real disk and, crucially, never imports
// or invokes bench/run.js's run loop.

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  findArtifactStores,
  main,
  mergeScorecards,
  parseAggregateCliArgs,
  readArtifactScorecards,
  renderResultsTree,
  sanitizeStamp,
} from '../../../bench/report/aggregate-cli.js';
import { readStore } from '../../../bench/report/persist.js';

const MODEL = { id: 'claude-opus-4-8' };
const ENV = { node: 'v24.16.0', os: 'linux' };

function card(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: 'hw-m-r1',
    timestamp: '2026-07-09T19:42:11.000Z',
    model: MODEL,
    frameworkVersion: '1.70.0',
    benchmarkVersion: '0.5.0',
    env: ENV,
    scenario: 'hello-world',
    arm: 'mandrel',
    dimensions: {
      quality: { score: 1, frozenSuitePassRate: 1 },
      planningFidelity: { score: 0.9 },
      autonomy: { score: 1, hitlStops: 0, blockedEvents: 0, manualRescues: 0 },
      efficiency: {
        wallClockMs: 600000,
        totalTokens: 180000,
        dispatches: 2,
        costUsd: 1.2,
      },
      overheadRatio: { tokenRatio: 4.2 },
    },
    ...overrides,
  };
}

/**
 * A tiny in-memory filesystem double backing a mutable `path → contents` map,
 * shared by every injected port so an append is visible to the following read.
 */
function memFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  const addDirs = (p) => {
    let d = path.dirname(p);
    while (d && d !== '.' && d !== path.dirname(d) && !dirs.has(d)) {
      dirs.add(d);
      d = path.dirname(d);
    }
  };
  for (const p of files.keys()) addDirs(p);

  const api = {
    files,
    dirs,
    existsImpl: (p) => files.has(p) || dirs.has(p),
    readFileImpl: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p);
    },
    readdirImpl: (p) => {
      const prefix = p.endsWith('/') ? p : `${p}/`;
      const names = new Set();
      for (const f of [...files.keys(), ...dirs]) {
        if (f.startsWith(prefix)) {
          const first = f.slice(prefix.length).split('/')[0];
          if (first) names.add(first);
        }
      }
      return [...names];
    },
    statImpl: (p) => ({ isDirectory: () => dirs.has(p) }),
    appendFileImpl: (p, data) => {
      files.set(p, (files.get(p) ?? '') + data);
      addDirs(p);
    },
    writeFileImpl: (p, data) => {
      files.set(p, data);
      addDirs(p);
    },
    mkdirImpl: (p) => {
      dirs.add(p);
      addDirs(p);
    },
  };
  return api;
}

/** Assemble the merged deps bag main()/renderResultsTree expect. */
function depsFor(fs, extra = {}) {
  return {
    existsImpl: fs.existsImpl,
    readdirImpl: fs.readdirImpl,
    statImpl: fs.statImpl,
    readFileImpl: fs.readFileImpl,
    writeFileImpl: fs.writeFileImpl,
    mkdirImpl: fs.mkdirImpl,
    persistDeps: {
      existsImpl: fs.existsImpl,
      readFileImpl: fs.readFileImpl,
      appendFileImpl: fs.appendFileImpl,
      mkdirImpl: fs.mkdirImpl,
    },
    aggregateDeps: {
      existsImpl: fs.existsImpl,
      readdirImpl: fs.readdirImpl,
      statImpl: fs.statImpl,
      readFileImpl: fs.readFileImpl,
    },
    ...extra,
  };
}

const silentLogger = { info() {}, warn() {}, error() {} };

describe('aggregate-cli — arg parsing', () => {
  it('parses artifacts-dir, results-dir, stamp, and --no-merge', () => {
    const args = parseAggregateCliArgs([
      '--artifacts-dir',
      '/dl',
      '--results-dir',
      '/results',
      '--stamp',
      'run-42',
      '--no-merge',
    ]);
    assert.equal(args.artifactsDir, '/dl');
    assert.equal(args.resultsDir, '/results');
    assert.equal(args.stamp, 'run-42');
    assert.equal(args.noMerge, true);
  });

  it('sanitizes a stamp into the filesystem-safe pattern', () => {
    assert.equal(
      sanitizeStamp('2026-07-09T19:42:11.000Z'),
      '2026-07-09T19-42-11.000Z',
    );
    assert.equal(sanitizeStamp('run/42 x'), 'run-42-x');
  });
});

describe('aggregate-cli — artifact discovery', () => {
  it('recursively finds every scorecards.ndjson under the artifacts root', () => {
    const fs = memFs({
      '/dl/scorecards-a/results/m/1.70.0/scorecards.ndjson': `${JSON.stringify(card({ runId: 'a' }))}\n`,
      '/dl/scorecards-b/results/m/1.70.0/scorecards.ndjson': `${JSON.stringify(card({ runId: 'b' }))}\n`,
      '/dl/scorecards-a/results/m/1.70.0/reports/report-x.md': 'ignored',
    });
    const stores = findArtifactStores({ artifactsDir: '/dl' }, fs);
    assert.equal(stores.length, 2);
    assert.ok(stores.every((s) => s.endsWith('scorecards.ndjson')));
  });

  it('reads every scorecard record out of the discovered stores', () => {
    const fs = memFs({
      '/dl/a/scorecards.ndjson': `${JSON.stringify(card({ runId: 'a' }))}\n${JSON.stringify(card({ runId: 'b' }))}\n`,
    });
    const records = readArtifactScorecards({ artifactsDir: '/dl' }, fs);
    assert.deepEqual(
      records.map((r) => r.runId),
      ['a', 'b'],
    );
  });

  it('a non-existent artifacts root yields no records (not a crash)', () => {
    const fs = memFs({});
    assert.deepEqual(readArtifactScorecards({ artifactsDir: '/nope' }, fs), []);
  });
});

describe('aggregate-cli — append-only merge (idempotent by runId)', () => {
  it('routes records to their cohort store and appends them', () => {
    const fs = memFs({});
    const result = mergeScorecards(
      {
        records: [card({ runId: 'a' }), card({ runId: 'b', arm: 'control' })],
        resultsDir: '/results',
      },
      { persistDeps: depsFor(fs).persistDeps },
    );
    assert.equal(result.appended, 2);
    assert.equal(result.skippedDuplicates, 0);

    const storePath = path.join(
      '/results',
      'claude-opus-4-8',
      '1.70.0',
      'scorecards.ndjson',
    );
    const persisted = readStore({ storePath }, depsFor(fs).persistDeps);
    assert.deepEqual(
      persisted.map((r) => r.runId),
      ['a', 'b'],
    );
  });

  it('skips a record whose runId already exists in the cohort store', () => {
    const storePath = path.join(
      '/results',
      'claude-opus-4-8',
      '1.70.0',
      'scorecards.ndjson',
    );
    const fs = memFs({
      [storePath]: `${JSON.stringify(card({ runId: 'a' }))}\n`,
    });
    const result = mergeScorecards(
      {
        records: [card({ runId: 'a' }), card({ runId: 'c' })],
        resultsDir: '/results',
      },
      { persistDeps: depsFor(fs).persistDeps },
    );
    assert.equal(result.appended, 1, 'only the new record is appended');
    assert.equal(result.skippedDuplicates, 1, 'the duplicate is skipped');

    const persisted = readStore({ storePath }, depsFor(fs).persistDeps);
    assert.deepEqual(
      persisted.map((r) => r.runId),
      ['a', 'c'],
      'the store is not double-written',
    );
  });

  it('dedups records that repeat a runId within the same batch', () => {
    const fs = memFs({});
    const result = mergeScorecards(
      {
        records: [card({ runId: 'dup' }), card({ runId: 'dup' })],
        resultsDir: '/results',
      },
      { persistDeps: depsFor(fs).persistDeps },
    );
    assert.equal(result.appended, 1);
    assert.equal(result.skippedDuplicates, 1);
  });
});

describe('aggregate-cli — render from an existing tree', () => {
  it('renders a per-cohort report and the results.html dashboard', () => {
    const storePath = path.join(
      '/results',
      'claude-opus-4-8',
      '1.70.0',
      'scorecards.ndjson',
    );
    const fs = memFs({
      [storePath]: `${JSON.stringify(card({ runId: 'a' }))}\n${JSON.stringify(card({ runId: 'b', arm: 'control' }))}\n`,
    });
    const rendered = renderResultsTree(
      { resultsDir: '/results', stamp: 'run-1' },
      depsFor(fs),
    );
    assert.equal(rendered.cohorts.length, 1);
    assert.match(
      rendered.cohorts[0].reportPath,
      /reports[/\\]report-run-1\.md$/,
    );
    assert.ok(
      fs.files.has(rendered.cohorts[0].reportPath),
      'the report was written',
    );
    assert.equal(rendered.dashboardPath, path.join('/results', 'results.html'));
    assert.ok(fs.files.has(rendered.dashboardPath), 'results.html was written');
    assert.ok(
      fs.files.get(rendered.dashboardPath).length > 0,
      'the dashboard is non-empty',
    );
  });
});

describe('aggregate-cli — main() end to end (merge + render, no run)', () => {
  it('merges downloaded artifacts and renders, printing a JSON summary', async () => {
    const artifactStore =
      '/dl/scorecards-hello-world-mandrel/results/claude-opus-4-8/1.70.0/scorecards.ndjson';
    const fs = memFs({
      [artifactStore]: `${JSON.stringify(card({ runId: 'a' }))}\n${JSON.stringify(card({ runId: 'b', arm: 'control' }))}\n`,
    });
    let output = '';
    const code = await main(
      ['--artifacts-dir', '/dl', '--results-dir', '/results'],
      {},
      depsFor(fs, {
        logger: silentLogger,
        write: (s) => {
          output += s;
        },
        now: () => '2026-07-09T00:00:00.000Z',
      }),
    );
    assert.equal(code, 0);

    const summary = JSON.parse(output);
    assert.equal(summary.merged, 2, 'both artifact records were merged');
    assert.equal(summary.corpusSize, 2, 'the corpus reflects the merged tree');
    assert.equal(summary.dashboardPath, path.join('/results', 'results.html'));

    // The merged store is on disk in the results tree, and the dashboard was
    // rendered from it — with no run ever invoked.
    const mergedStore = path.join(
      '/results',
      'claude-opus-4-8',
      '1.70.0',
      'scorecards.ndjson',
    );
    assert.ok(
      fs.files.has(mergedStore),
      'results tree carries the merged store',
    );
    assert.ok(fs.files.has(path.join('/results', 'results.html')));
  });

  it('is idempotent — a second run over the same artifacts merges nothing new', async () => {
    const artifactStore =
      '/dl/cell/results/claude-opus-4-8/1.70.0/scorecards.ndjson';
    const fs = memFs({
      [artifactStore]: `${JSON.stringify(card({ runId: 'a' }))}\n`,
    });
    const run = () =>
      main(
        ['--artifacts-dir', '/dl', '--results-dir', '/results'],
        {},
        depsFor(fs, { logger: silentLogger, write: () => {}, now: () => 'x' }),
      );
    await run();
    let secondOutput = '';
    await main(
      ['--artifacts-dir', '/dl', '--results-dir', '/results'],
      {},
      depsFor(fs, {
        logger: silentLogger,
        write: (s) => {
          secondOutput += s;
        },
        now: () => 'x',
      }),
    );
    const summary = JSON.parse(secondOutput);
    assert.equal(summary.merged, 0, 'the second run appends nothing');
    assert.equal(
      summary.skippedDuplicates,
      1,
      'the record is recognized as a duplicate',
    );
  });

  it('exits 1 and logs a FATAL line when a port throws', async () => {
    // M8: the main() catch branch must convert any thrown port error into a
    // clean exit code 1 with a FATAL log line — never a bare crash that leaves
    // the aggregate job's failure unattributable.
    const errors = [];
    const recordingLogger = {
      info() {},
      warn() {},
      error: (m) => errors.push(String(m)),
    };
    const fs = memFs({});
    let output = '';
    const code = await main(
      ['--artifacts-dir', '/dl', '--results-dir', '/results'],
      {},
      depsFor(fs, {
        logger: recordingLogger,
        write: (s) => {
          output += s;
        },
        now: () => 'x',
        // Force the merge path to blow up: the artifacts root "exists" but
        // reading it throws, so readArtifactScorecards propagates into main's
        // try/catch.
        existsImpl: () => true,
        readdirImpl: () => {
          throw new Error('disk gone');
        },
      }),
    );
    assert.equal(code, 1, 'a thrown port must yield exit code 1');
    assert.equal(output, '', 'no JSON summary is printed on the FATAL path');
    assert.ok(
      errors.some((m) => m.includes('[aggregate-cli] FATAL')),
      'the FATAL log line must be emitted',
    );
    assert.ok(
      errors.some((m) => m.includes('disk gone')),
      'the FATAL line must carry the underlying error message',
    );
  });

  it('--no-merge renders the existing tree without touching artifacts', async () => {
    const storePath = path.join(
      '/results',
      'claude-opus-4-8',
      '1.70.0',
      'scorecards.ndjson',
    );
    const fs = memFs({
      [storePath]: `${JSON.stringify(card({ runId: 'a' }))}\n`,
    });
    let output = '';
    const code = await main(
      ['--results-dir', '/results', '--no-merge'],
      {},
      depsFor(fs, {
        logger: silentLogger,
        write: (s) => {
          output += s;
        },
        now: () => 'x',
      }),
    );
    assert.equal(code, 0);
    const summary = JSON.parse(output);
    assert.equal(summary.merged, 0);
    assert.ok(fs.files.has(path.join('/results', 'results.html')));
  });
});
