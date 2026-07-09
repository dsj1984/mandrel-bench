// tests/bench/feedback/feedback-e2e.test.js
//
// Exit-criterion proof for Epic #85's Phase-4 feedback loop (Story #93).
// Unit/contract tier — NO live GitHub. It drives the WHOLE pipe end to end:
//
//   synthetic corpus → deriveFindings (real envelope, real fingerprints)
//                     → fileFindings (real filer) against a MOCKED gh port
//
// and proves the loop produces BOTH terminal actions in one pass: at least one
// freshly FILED issue (a fingerprint miss) and at least one COMMENT update (a
// fingerprint hit under a not-yet-recorded cohort). Nothing is stubbed between
// derive and file — the fingerprints the filer matches on are the ones derive
// actually computed, so this guards the real seam the two upstream Stories left
// open, not a hand-rolled envelope.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveFindings } from '../../../bench/feedback/derive.js';
import {
  fileFindings,
  fingerprintMarker,
} from '../../../bench/feedback/file.js';

const MODEL = { id: 'claude-opus-4-8[1m]' };
const ENV = { node: 'v24.16.0', os: 'darwin' };
const LINKS = {
  report: 'claude-opus-4-8-1m/1.70.0/reports/report-x.md',
  scorecards: 'claude-opus-4-8-1m/1.70.0/scorecards.ndjson',
};

const TARGET = {
  model: MODEL.id,
  frameworkVersion: '1.70.0',
  benchmarkVersion: '0.5.0',
};

/** A fully-shaped scorecard; the four finding classes read these fields. */
function card({
  scenario = 'story-scope',
  arm = 'mandrel',
  runId = `${scenario}-${arm}-r1`,
  frameworkVersion = '1.70.0',
  benchmarkVersion = '0.5.0',
  quality = 1,
  tokenRatio = 4,
  totalTokens = 180000,
} = {}) {
  return {
    schemaVersion: 1,
    runId,
    timestamp: '2026-06-16T19:42:11.000Z',
    model: MODEL,
    frameworkVersion,
    benchmarkVersion,
    env: ENV,
    scenario,
    arm,
    routingVerdict: arm === 'control' ? null : 'story',
    routingMismatch: false,
    dimensions: {
      quality: { score: quality, frozenSuitePassRate: quality },
      planningFidelity: { score: arm === 'control' ? null : 0.9 },
      autonomy: {
        score: 1,
        hitlStops: 0,
        blockedEvents: 0,
        manualRescues: 0,
        guardrail: { threshold: 0.99, met: true },
      },
      maintainability: { score: 0.9 },
      security: { score: 1 },
      overheadRatio: { tokenRatio },
      efficiency: {
        wallClockMs: 600000,
        totalTokens,
        dispatches: 2,
        costUsd: 1.4,
      },
    },
  };
}

/** N mandrel+control cards for one scenario with tiny per-run jitter. */
function cell({
  scenario,
  frameworkVersion = '1.70.0',
  n = 4,
  mandrel = {},
  control = {},
}) {
  const cards = [];
  for (let i = 0; i < n; i += 1) {
    const jitter = i % 2 === 0 ? 0.001 : -0.001;
    cards.push(
      card({
        scenario,
        arm: 'mandrel',
        runId: `${scenario}-m-${frameworkVersion}-${i}`,
        frameworkVersion,
        quality: (mandrel.quality ?? 1) + jitter,
        tokenRatio: (mandrel.tokenRatio ?? 4) + jitter,
        totalTokens: (mandrel.totalTokens ?? 180000) + i * 10,
      }),
    );
    cards.push(
      card({
        scenario,
        arm: 'control',
        runId: `${scenario}-c-${frameworkVersion}-${i}`,
        frameworkVersion,
        quality: (control.quality ?? 1) + jitter,
        tokenRatio: (control.tokenRatio ?? 0.1) + jitter,
        totalTokens: (control.totalTokens ?? 40000) + i * 10,
      }),
    );
  }
  return cards;
}

/**
 * A synthetic corpus that derives at least two DISTINCT findings for TARGET:
 *   - a quality REGRESSION on hello-world vs the prior comparable cohort (1.69),
 *   - a standing-cost OVERHEAD-RATIO on story-scope (mandrel ratio ≫ control).
 * Two scenarios ⇒ two distinct fingerprints ⇒ a hit AND a miss can co-occur.
 */
function syntheticCorpus() {
  return [
    ...cell({
      scenario: 'hello-world',
      frameworkVersion: '1.69.0',
      mandrel: { quality: 1.0 },
      control: { quality: 1.0 },
    }),
    ...cell({
      scenario: 'hello-world',
      frameworkVersion: '1.70.0',
      mandrel: { quality: 0.5 },
      control: { quality: 1.0 },
    }),
    ...cell({
      scenario: 'story-scope',
      frameworkVersion: '1.70.0',
      mandrel: { tokenRatio: 4 },
      control: { tokenRatio: 0.1 },
    }),
  ];
}

/**
 * A recording mock gh port. Dispatches on the gh subcommand and returns canned
 * JSON; records every argv into `.calls`. A `search` call is a hard failure —
 * the filer must LIST + match client-side.
 */
function makeGh({ list = [], threads = {} } = {}) {
  const gh = (args) => {
    gh.calls.push(args);
    const [a, b] = args;
    if (a === 'search') {
      throw new Error('the filer must never use GitHub issue search');
    }
    if (a === 'issue' && b === 'list') return JSON.stringify(list);
    if (a === 'issue' && b === 'view') {
      const number = Number(args[2]);
      return JSON.stringify(threads[number] ?? { body: '', comments: [] });
    }
    if (a === 'issue' && b === 'create') {
      return 'https://github.com/dsj1984/mandrel/issues/501\n';
    }
    if (a === 'issue' && b === 'comment') return '';
    return '';
  };
  gh.calls = [];
  return gh;
}

const silentLogger = () => ({ info() {}, warn() {}, error() {} });

describe('feedback loop — end-to-end (derive → envelope → filer, mocked gh)', () => {
  it('files at least one issue and updates at least one comment in a single pass', () => {
    // 1. Derive a REAL envelope from the synthetic corpus.
    const envelope = deriveFindings({
      corpus: syntheticCorpus(),
      cohort: TARGET,
      links: LINKS,
    });
    assert.ok(
      envelope.findings.length >= 2,
      `fixture must derive ≥2 findings (got ${envelope.findings.length})`,
    );

    // 2. Seed the mock repo so the FIRST finding's fingerprint is already on an
    //    open bench-feedback issue (→ a hit → comment) while the rest are misses
    //    (→ created). The issue thread carries the fingerprint but NOT this
    //    cohort's marker, so the recurrence comment fires.
    const hitFinding = envelope.findings[0];
    const hitIssueNumber = 314;
    const gh = makeGh({
      list: [
        {
          number: hitIssueNumber,
          title: 'prior sighting',
          body: `earlier cohort ${fingerprintMarker(hitFinding.fingerprint)} trailer`,
        },
      ],
      threads: {
        [hitIssueNumber]: {
          body: fingerprintMarker(hitFinding.fingerprint),
          comments: [],
        },
      },
    });

    // 3. Run the REAL filer end to end.
    const result = fileFindings({ envelope }, { gh, logger: silentLogger() });

    // 4. Both terminal actions occurred — the Epic's exit-criterion proof.
    const created = result.actions.filter((a) => a.action === 'created');
    const commented = result.actions.filter((a) => a.action === 'commented');
    assert.ok(created.length >= 1, 'expected ≥1 freshly filed issue (a miss)');
    assert.ok(commented.length >= 1, 'expected ≥1 comment update (a hit)');
    assert.equal(result.degraded, false, 'the happy path must not degrade');

    // 5. The hit was routed as a comment onto the matched issue, and the miss(es)
    //    opened fresh labeled issues — proven against the recorded gh argv.
    assert.equal(commented[0].issue, hitIssueNumber);
    const createCall = gh.calls.find(
      (a) => a[0] === 'issue' && a[1] === 'create',
    );
    assert.ok(createCall, 'a miss must call `gh issue create`');
    assert.ok(
      createCall.includes('bench-feedback') &&
        createCall.includes('meta::framework-gap'),
      'a filed issue must carry both routing labels',
    );
    const commentCall = gh.calls.find(
      (a) => a[0] === 'issue' && a[1] === 'comment',
    );
    assert.ok(commentCall, 'a hit must call `gh issue comment`');
    assert.equal(
      String(commentCall[2]),
      String(hitIssueNumber),
      'the recurrence comment must land on the matched issue',
    );

    // 6. No call was ever a GitHub issue SEARCH (the pre-mortem regression).
    assert.ok(
      !gh.calls.some((a) => a[0] === 'search'),
      'the filer must LIST + match client-side, never search',
    );
  });
});
