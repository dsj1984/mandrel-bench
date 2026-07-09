// tests/bench/feedback/derive-cli.test.js
//
// Unit tier (pure logic + injected I/O, no real disk, no run) for the standalone
// finding-derivation entrypoint (Epic #85, Story #91). Exercises
// bench/feedback/derive-cli.js against the Story's binding acceptance item:
//   "bench/feedback/derive-cli.js is a standalone entrypoint that reads a
//    results tree and writes (a) a machine-readable finding-envelope JSON into
//    the results tree beside the cohort report and (b) a markdown findings
//    section for embedding in the results-PR body — the seam the Epic #84 CI
//    aggregate job calls."
//
// Everything is driven through an in-memory filesystem double so the whole CLI —
// corpus aggregation, cohort resolution, derivation, and the two writes — runs
// with no real disk and never imports or invokes bench/run.js's run loop.

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  cohortLinks,
  main,
  parseDeriveCliArgs,
  resolveTargetCohort,
} from '../../../bench/feedback/derive-cli.js';

const MODEL = { id: 'claude-opus-4-8[1m]' };
const ENV = { node: 'v24.16.0', os: 'darwin' };
const MODEL_SLUG = 'claude-opus-4-8-1m';

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
    routingMismatch: false,
    dimensions: {
      quality: { score: 1, frozenSuitePassRate: 1 },
      planningFidelity: { score: 0.9 },
      autonomy: {
        score: 1,
        hitlStops: 0,
        blockedEvents: 0,
        manualRescues: 0,
        guardrail: { threshold: 0.99, met: true },
      },
      maintainability: { score: 0.9 },
      security: { score: 1 },
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

/** In-memory filesystem double (mirrors the aggregate-cli test's memFs). */
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
  return {
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
    writeFileImpl(p, data) {
      files.set(p, data);
      addDirs(p);
    },
    mkdirImpl(p) {
      dirs.add(p);
      addDirs(p);
    },
  };
}

function depsFor(fs, extra = {}) {
  return {
    logger: { info() {}, warn() {}, error() {} },
    writeFileImpl: fs.writeFileImpl,
    mkdirImpl: fs.mkdirImpl,
    aggregateDeps: {
      existsImpl: fs.existsImpl,
      readdirImpl: fs.readdirImpl,
      statImpl: fs.statImpl,
      readFileImpl: fs.readFileImpl,
    },
    now: () => '2026-07-09T00:00:00.000Z',
    ...extra,
  };
}

/** NDJSON store text for a set of cards. */
function store(cards) {
  return `${cards.map((c) => JSON.stringify(c)).join('\n')}\n`;
}

const STORE_PATH = `/results/${MODEL_SLUG}/1.70.0/scorecards.ndjson`;
const REPORTS_DIR = `/results/${MODEL_SLUG}/1.70.0/reports`;

describe('derive-cli — arg parsing', () => {
  it('parses every option', () => {
    const args = parseDeriveCliArgs([
      '--results-dir',
      '/r',
      '--stamp',
      'run-42',
      '--model',
      'm',
      '--framework-version',
      '1.70.0',
      '--benchmark-version',
      '0.5.0',
      '--envelope-out',
      '/e.json',
      '--pr-body-out',
      '/b.md',
      '--method',
      'ci',
    ]);
    assert.equal(args.resultsDir, '/r');
    assert.equal(args.stamp, 'run-42');
    assert.equal(args.model, 'm');
    assert.equal(args.frameworkVersion, '1.70.0');
    assert.equal(args.benchmarkVersion, '0.5.0');
    assert.equal(args.envelopeOut, '/e.json');
    assert.equal(args.prBodyOut, '/b.md');
    assert.equal(args.method, 'ci');
  });
});

describe('resolveTargetCohort', () => {
  it('auto-selects the sole cohort in a single-cohort tree', () => {
    const res = resolveTargetCohort({
      corpus: [card()],
      model: null,
      frameworkVersion: null,
      benchmarkVersion: null,
    });
    assert.equal(res.triple.frameworkVersion, '1.70.0');
  });

  it('errors (ambiguous) when >1 cohort and no pin', () => {
    const res = resolveTargetCohort({
      corpus: [card(), card({ frameworkVersion: '1.69.0' })],
      model: null,
      frameworkVersion: null,
      benchmarkVersion: null,
    });
    assert.ok(res.error);
    assert.match(res.error, /pin --model/);
  });

  it('narrows to one cohort when pinned', () => {
    const res = resolveTargetCohort({
      corpus: [card(), card({ frameworkVersion: '1.69.0' })],
      model: null,
      frameworkVersion: '1.69.0',
      benchmarkVersion: null,
    });
    assert.equal(res.triple.frameworkVersion, '1.69.0');
  });

  it('errors on an empty tree', () => {
    const res = resolveTargetCohort({
      corpus: [],
      model: null,
      frameworkVersion: null,
      benchmarkVersion: null,
    });
    assert.match(res.error, /no scorecards/);
  });
});

describe('cohortLinks', () => {
  it('builds results-relative report + scorecard links', () => {
    const links = cohortLinks({
      triple: { model: MODEL.id, frameworkVersion: '1.70.0' },
      stamp: 'run-42',
    });
    assert.equal(links.report, `${MODEL_SLUG}/1.70.0/reports/report-run-42.md`);
    assert.equal(links.scorecards, `${MODEL_SLUG}/1.70.0/scorecards.ndjson`);
  });
});

describe('derive-cli — main writes the envelope + PR-body beside the report', () => {
  it('writes a machine-readable envelope JSON and a Markdown findings section', async () => {
    // A hello-world cohort with heavy mandrel ceremony and no quality gain →
    // a real overhead-floor standing-cost finding.
    const cards = [];
    for (let i = 0; i < 4; i += 1) {
      cards.push(
        card({
          runId: `m${i}`,
          arm: 'mandrel',
          dimensions: {
            ...card().dimensions,
            efficiency: {
              wallClockMs: 600000,
              totalTokens: 180000 + i * 10,
              dispatches: 2,
              costUsd: 1.2,
            },
          },
        }),
      );
      cards.push(
        card({
          runId: `c${i}`,
          arm: 'control',
          dimensions: {
            ...card().dimensions,
            planningFidelity: { score: null },
            efficiency: {
              wallClockMs: 300000,
              totalTokens: 40000 + i * 10,
              dispatches: 0,
              costUsd: 0.3,
            },
          },
        }),
      );
    }
    const fs = memFs({ [STORE_PATH]: store(cards) });
    const out = [];
    const code = await main(
      ['--results-dir', '/results', '--stamp', 'run-42'],
      {},
      depsFor(fs, { write: (s) => out.push(s) }),
    );
    assert.equal(code, 0);

    const envelopePath = `${REPORTS_DIR}/findings-run-42.json`;
    const prBodyPath = `${REPORTS_DIR}/findings-run-42.md`;
    assert.ok(
      fs.files.has(envelopePath),
      'envelope JSON must be written beside the report',
    );
    assert.ok(
      fs.files.has(prBodyPath),
      'PR-body markdown must be written beside the report',
    );

    const envelope = JSON.parse(fs.files.get(envelopePath));
    assert.equal(envelope.schemaVersion, 1);
    assert.deepEqual(envelope.cohort, {
      model: MODEL.id,
      frameworkVersion: '1.70.0',
      benchmarkVersion: '0.5.0',
    });
    assert.ok(envelope.findings.length > 0, 'expected at least one finding');
    assert.ok(
      envelope.findings.every(
        (f) =>
          f.links.report === `${MODEL_SLUG}/1.70.0/reports/report-run-42.md`,
      ),
      'each finding carries the results-relative report link',
    );

    const md = fs.files.get(prBodyPath);
    assert.match(md, /## Benchmark findings/);

    const summary = JSON.parse(out.join(''));
    assert.equal(summary.envelopePath, envelopePath);
    assert.equal(summary.findingCount, envelope.findings.length);
  });

  it('exits non-zero when the cohort selection is ambiguous', async () => {
    const cards = [
      card({ runId: 'a' }),
      card({ runId: 'b', frameworkVersion: '1.69.0' }),
    ];
    // Two cohorts land in different version dirs.
    const fs = memFs({
      [STORE_PATH]: store([cards[0]]),
      [`/results/${MODEL_SLUG}/1.69.0/scorecards.ndjson`]: store([cards[1]]),
    });
    const code = await main(['--results-dir', '/results'], {}, depsFor(fs));
    assert.equal(code, 1);
  });

  it('a MULTI-cohort tree + explicit pins selects the right cohort (not ambiguous)', async () => {
    // Two distinct cohorts on the same tree — exactly the steady state that
    // fails ambiguous WITHOUT pins (see the ambiguous test above). Pinning the
    // full run-under-test triple must select that cohort's records and exit 0.
    const targetCards = [
      card({ runId: 't-m', arm: 'mandrel', frameworkVersion: '1.71.0' }),
      card({ runId: 't-c', arm: 'control', frameworkVersion: '1.71.0' }),
    ];
    const otherCards = [
      card({ runId: 'o-m', arm: 'mandrel', frameworkVersion: '1.70.0' }),
      card({ runId: 'o-c', arm: 'control', frameworkVersion: '1.70.0' }),
    ];
    const fs = memFs({
      [`/results/${MODEL_SLUG}/1.71.0/scorecards.ndjson`]: store(targetCards),
      [`/results/${MODEL_SLUG}/1.70.0/scorecards.ndjson`]: store(otherCards),
    });
    const out = [];
    const code = await main(
      [
        '--results-dir',
        '/results',
        '--stamp',
        'run-71',
        '--model',
        MODEL.id,
        '--framework-version',
        '1.71.0',
        '--benchmark-version',
        '0.5.0',
      ],
      {},
      depsFor(fs, { write: (s) => out.push(s) }),
    );
    assert.equal(code, 0, 'explicit pins must resolve, never exit ambiguous');

    const summary = JSON.parse(out.join(''));
    assert.deepEqual(summary.cohort, {
      model: MODEL.id,
      frameworkVersion: '1.71.0',
      benchmarkVersion: '0.5.0',
    });
    // The envelope must be written into the PINNED cohort's version dir, and its
    // findings must carry the pinned cohort triple (never the other cohort's).
    const envelopePath = `/results/${MODEL_SLUG}/1.71.0/reports/findings-run-71.json`;
    assert.ok(
      fs.files.has(envelopePath),
      'envelope must land under the pinned cohort version dir',
    );
    const envelope = JSON.parse(fs.files.get(envelopePath));
    assert.deepEqual(envelope.cohort, {
      model: MODEL.id,
      frameworkVersion: '1.71.0',
      benchmarkVersion: '0.5.0',
    });
    assert.ok(
      envelope.findings.every((f) => f.cohort.frameworkVersion === '1.71.0'),
      'every finding must carry the pinned cohort triple',
    );
  });

  it('exits 1 with a [derive-cli] FATAL log when aggregation THROWS (catch branch)', async () => {
    // Distinct from the resolved.error path: here aggregateScorecards itself
    // throws (a disk read blows up) and the try/catch FATAL branch must convert
    // it to exit 1 + a `[derive-cli] FATAL` log, never an unhandled rejection.
    const fs = memFs({ [STORE_PATH]: store([card()]) });
    const deps = depsFor(fs);
    deps.aggregateDeps.readFileImpl = () => {
      throw new Error('disk exploded mid-walk');
    };
    const errors = [];
    deps.logger = { info() {}, warn() {}, error: (m) => errors.push(m) };
    const code = await main(['--results-dir', '/results'], {}, deps);
    assert.equal(code, 1);
    assert.ok(
      errors.some((m) => /\[derive-cli\] FATAL/.test(m)),
      'the catch branch must log a [derive-cli] FATAL line',
    );
    assert.ok(
      errors.some((m) => /disk exploded mid-walk/.test(m)),
      'the FATAL log must carry the underlying error message',
    );
  });

  it('honors explicit --envelope-out / --pr-body-out paths', async () => {
    const fs = memFs({ [STORE_PATH]: store([card({ arm: 'mandrel' })]) });
    const code = await main(
      [
        '--results-dir',
        '/results',
        '--stamp',
        'run-9',
        '--envelope-out',
        '/out/env.json',
        '--pr-body-out',
        '/out/body.md',
      ],
      {},
      depsFor(fs),
    );
    assert.equal(code, 0);
    assert.ok(fs.files.has('/out/env.json'));
    assert.ok(fs.files.has('/out/body.md'));
  });
});
