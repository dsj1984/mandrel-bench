// tests/bench/feedback/file.test.js
//
// Unit tier (pure logic + injected ports, no real disk, NO live GitHub call) for
// the fingerprint-deduplicated issue filer (Epic #85, Story #92). Every `gh`
// invocation is driven through a MOCKED port that records its argv and returns
// canned JSON — no test in this file ever spawns a real `gh` process or touches
// the network. The suite pins each binding acceptance item:
//   - LIST + CLIENT-SIDE fingerprint-marker match (never GitHub issue search),
//   - comment-on-hit / create-on-miss (with both labels),
//   - idempotency per (fingerprint × cohort) — a recorded cohort is a no-op,
//   - --dry-run makes NO gh calls,
//   - a missing cross-repo write scope degrades loudly and exits 0.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cohortMarker,
  defaultGhPort,
  fileFindings,
  fingerprintMarker,
  hasFeedbackToken,
  isScopeError,
  main,
  parseCreatedIssueNumber,
  parseFileCliArgs,
  renderCohortComment,
  renderFindingBody,
  threadHasMarker,
} from '../../../bench/feedback/file.js';

const COHORT = {
  model: 'claude-opus-4-8[1m]',
  frameworkVersion: '1.71.0',
  benchmarkVersion: '0.5.0',
};

const OTHER_COHORT = {
  model: 'claude-opus-4-8[1m]',
  frameworkVersion: '1.70.0',
  benchmarkVersion: '0.5.0',
};

function finding(overrides = {}) {
  return {
    fingerprint: '0123456789abcdef',
    class: 'regression',
    scenario: 'hello-world',
    subject: 'quality',
    summary: '`quality` regressed on `hello-world` vs framework 1.70.0.',
    cohort: { ...COHORT },
    evidence: {
      method: 'iqr',
      baselineCenter: 1,
      candidateCenter: 0.8,
      shift: -0.2,
      noiseFloor: 0.05,
      shiftIsReal: true,
    },
    links: {
      report: 'claude-opus-4-8-1m/1.71.0/reports/report-x.md',
      scorecards: 'claude-opus-4-8-1m/1.71.0/scorecards.ndjson',
    },
    ...overrides,
  };
}

function envelope(findings = [finding()]) {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-09T00:00:00.000Z',
    cohort: { ...COHORT },
    previousComparableCohort: { ...OTHER_COHORT },
    method: 'iqr',
    counts: {},
    findings,
  };
}

/**
 * A recording mock gh port. Dispatches on the gh subcommand and returns canned
 * JSON; records every argv into `.calls`. A `failOn(args)` predicate lets a test
 * make a chosen call throw a permission-shaped error.
 */
function makeGh({ list = [], threads = {}, failOn = null } = {}) {
  const gh = (args) => {
    gh.calls.push(args);
    if (failOn?.(args)) {
      const err = new Error('gh: command failed');
      err.stderr = 'HTTP 403: Resource not accessible by integration';
      throw err;
    }
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
      return 'https://github.com/dsj1984/mandrel/issues/123\n';
    }
    if (a === 'issue' && b === 'comment') return '';
    return '';
  };
  gh.calls = [];
  return gh;
}

const silentLogger = () => ({ info() {}, warn() {}, error() {} });

describe('fileFindings — LIST + client-side fingerprint match', () => {
  it('lists open bench-feedback issues and never uses GitHub issue search', () => {
    const gh = makeGh({ list: [] });
    fileFindings({ envelope: envelope() }, { gh, logger: silentLogger() });

    const listed = gh.calls.find((a) => a[0] === 'issue' && a[1] === 'list');
    assert.ok(listed, 'expected a `gh issue list` call');
    assert.ok(
      listed.includes('--label') &&
        listed.includes('bench-feedback') &&
        listed.includes('--state') &&
        listed.includes('open'),
      'list must filter open bench-feedback issues',
    );
    // The load-bearing anti-regression: NO call is a search.
    assert.ok(
      !gh.calls.some((a) => a[0] === 'search'),
      'the filer must LIST + match client-side, never search',
    );
  });

  it('matches the fingerprint marker in the issue body client-side (a hit)', () => {
    const fp = finding().fingerprint;
    const gh = makeGh({
      list: [
        { number: 7, title: 'unrelated', body: 'no marker here' },
        {
          number: 42,
          title: 'the finding',
          body: `preamble ${fingerprintMarker(fp)} trailer`,
        },
      ],
      threads: { 42: { body: `${fingerprintMarker(fp)}`, comments: [] } },
    });

    const result = fileFindings(
      { envelope: envelope() },
      { gh, logger: silentLogger() },
    );

    // Hit on #42 (not #7): a recurrence comment, no new issue.
    assert.equal(result.actions[0].action, 'commented');
    assert.equal(result.actions[0].issue, 42);
    assert.ok(
      !gh.calls.some((a) => a[0] === 'issue' && a[1] === 'create'),
      'a hit must not create a new issue',
    );
    // It fetched the thread of the MATCHED issue only.
    const viewed = gh.calls.filter((a) => a[0] === 'issue' && a[1] === 'view');
    assert.equal(viewed.length, 1);
    assert.equal(viewed[0][2], '42');
  });
});

describe('fileFindings — create-on-miss', () => {
  it('files a new issue with both labels and both markers when no fingerprint hit', () => {
    const gh = makeGh({ list: [{ number: 7, title: 'x', body: 'unrelated' }] });

    const result = fileFindings(
      { envelope: envelope() },
      { gh, logger: silentLogger() },
    );

    const create = gh.calls.find((a) => a[0] === 'issue' && a[1] === 'create');
    assert.ok(create, 'a miss must create a new issue');
    // Both labels present.
    const labelArgs = create.filter((_, i) => create[i - 1] === '--label');
    assert.ok(labelArgs.includes('bench-feedback'));
    assert.ok(labelArgs.includes('meta::framework-gap'));
    // Body carries both the fingerprint and cohort markers.
    const bodyIdx = create.indexOf('--body') + 1;
    const body = create[bodyIdx];
    assert.ok(body.includes(fingerprintMarker(finding().fingerprint)));
    assert.ok(body.includes(cohortMarker(COHORT)));
    // Body carries the cohort triple + noise-band evidence.
    assert.ok(body.includes('1.71.0'));
    assert.ok(body.includes('noiseFloor'));
    assert.ok(body.includes('report-x.md'));
    assert.equal(result.actions[0].action, 'created');
    // M1: a create reports the NUMBER of the issue it just created (parsed from
    // the `gh issue create` URL), not the dead always-null `hit?.number`.
    assert.equal(result.actions[0].issue, 123);
  });

  it('parseCreatedIssueNumber extracts the issue number from a create URL', () => {
    assert.equal(
      parseCreatedIssueNumber('https://github.com/dsj1984/mandrel/issues/123'),
      123,
    );
    assert.equal(
      parseCreatedIssueNumber('https://github.com/dsj1984/mandrel/issues/7\n'),
      7,
    );
    assert.equal(parseCreatedIssueNumber('no url here'), null);
    assert.equal(parseCreatedIssueNumber(undefined), null);
  });
});

describe('fileFindings — idempotency per (fingerprint × cohort)', () => {
  it('no-ops when the hit thread already carries this cohort marker (body)', () => {
    const fp = finding().fingerprint;
    const gh = makeGh({
      list: [{ number: 42, title: 't', body: fingerprintMarker(fp) }],
      threads: {
        42: {
          body: `${fingerprintMarker(fp)}\n${cohortMarker(COHORT)}`,
          comments: [],
        },
      },
    });

    const result = fileFindings(
      { envelope: envelope() },
      { gh, logger: silentLogger() },
    );

    assert.equal(result.actions[0].action, 'noop');
    assert.ok(
      !gh.calls.some(
        (a) => a[0] === 'issue' && (a[1] === 'comment' || a[1] === 'create'),
      ),
      're-running against a recorded cohort must write nothing',
    );
  });

  it('no-ops when a prior comment already carries this cohort marker', () => {
    const fp = finding().fingerprint;
    const gh = makeGh({
      list: [{ number: 42, title: 't', body: fingerprintMarker(fp) }],
      threads: {
        42: {
          body: fingerprintMarker(fp),
          comments: [{ body: `recurrence\n${cohortMarker(COHORT)}` }],
        },
      },
    });

    const result = fileFindings(
      { envelope: envelope() },
      { gh, logger: silentLogger() },
    );
    assert.equal(result.actions[0].action, 'noop');
  });

  it('comments when the thread carries the fingerprint but a DIFFERENT cohort', () => {
    const fp = finding().fingerprint;
    const gh = makeGh({
      list: [{ number: 42, title: 't', body: fingerprintMarker(fp) }],
      threads: {
        42: {
          body: `${fingerprintMarker(fp)}\n${cohortMarker(OTHER_COHORT)}`,
          comments: [],
        },
      },
    });

    const result = fileFindings(
      { envelope: envelope() },
      { gh, logger: silentLogger() },
    );
    assert.equal(result.actions[0].action, 'commented');
    const comment = gh.calls.find(
      (a) => a[0] === 'issue' && a[1] === 'comment',
    );
    const body = comment[comment.indexOf('--body') + 1];
    assert.ok(body.includes(cohortMarker(COHORT)));
  });
});

describe('fileFindings — dry-run makes NO gh calls', () => {
  it('prints intended actions and never calls the gh port', () => {
    // A gh port that throws if invoked at all — proves zero calls.
    const gh = () => {
      throw new Error('dry-run must not call gh');
    };
    const infos = [];
    const logger = { info: (m) => infos.push(m), warn() {}, error() {} };

    const result = fileFindings(
      { envelope: envelope(), dryRun: true },
      { gh, logger },
    );

    assert.equal(result.dryRun, true);
    assert.equal(result.actions[0].action, 'planned');
    assert.ok(infos.some((m) => m.includes('(dry-run)')));
  });
});

describe('fileFindings — degradation on missing cross-repo write scope', () => {
  it('logs a loud non-fatal warning naming the scope and returns degraded', () => {
    const gh = makeGh({
      list: [{ number: 7, title: 'x', body: 'unrelated' }],
      failOn: (a) => a[0] === 'issue' && a[1] === 'create',
    });
    const warns = [];
    const logger = { info() {}, warn: (m) => warns.push(m), error() {} };

    const result = fileFindings({ envelope: envelope() }, { gh, logger });

    assert.equal(result.degraded, true);
    assert.ok(warns.length >= 1, 'a degradation must be logged loudly');
    assert.ok(
      warns.some((m) => /scope|permission|DEGRADED/i.test(m)),
      'the warning must name the missing scope',
    );
  });

  it('isScopeError classifies a 403 / permission stderr as a scope failure', () => {
    const err = new Error('boom');
    err.stderr = 'HTTP 403: Resource not accessible by integration';
    assert.equal(isScopeError(err), true);
    assert.equal(isScopeError(new Error('some unrelated network blip')), false);
  });
});

describe('fileFindings — degradation at LIST time / absent token (M7)', () => {
  it('hasFeedbackToken detects an absent/empty token vs a configured one', () => {
    assert.equal(hasFeedbackToken({}), false);
    assert.equal(hasFeedbackToken({ FEEDBACK_GITHUB_TOKEN: '   ' }), false);
    assert.equal(hasFeedbackToken({ GH_TOKEN: '' }), false);
    assert.equal(hasFeedbackToken({ FEEDBACK_GITHUB_TOKEN: 'ghp_x' }), true);
    assert.equal(hasFeedbackToken({ GH_TOKEN: 'gho_y' }), true);
    assert.equal(hasFeedbackToken({ GITHUB_TOKEN: 'ghp_z' }), true);
  });

  it('isScopeError now also classifies a 401 unauthenticated failure', () => {
    const err = new Error('boom');
    err.stderr = 'HTTP 401: Bad credentials';
    assert.equal(isScopeError(err), true);
    assert.equal(
      isScopeError(new Error('gh: To authenticate, run gh auth login')),
      true,
    );
  });

  it('absent/empty FEEDBACK token degrades loudly (default port), zero gh calls', () => {
    // No gh injected → the DEFAULT port would be used; the absent-token precheck
    // must fire BEFORE any gh call, so nothing is ever spawned.
    const warns = [];
    const logger = { info() {}, warn: (m) => warns.push(m), error() {} };
    const result = fileFindings({ envelope: envelope() }, { logger, env: {} });
    assert.equal(result.degraded, true);
    assert.deepEqual(result.actions, [], 'zero writes on an absent token');
    assert.ok(
      warns.some((m) => /DEGRADED/.test(m) && /token/i.test(m)),
      'the absent-token degradation must be logged loudly',
    );
  });

  it('an underscoped/unauthenticated token surfaces at LIST → degrade, zero writes', () => {
    // The LIST is the first cross-repo call. gh returns a 401 there (exactly
    // what an empty FEEDBACK_GITHUB_TOKEN yields). The filer must degrade, not
    // throw, and make ZERO writes (no create / comment).
    const gh = makeGh({
      list: [],
      failOn: (a) => a[0] === 'issue' && a[1] === 'list',
    });
    const warns = [];
    const logger = { info() {}, warn: (m) => warns.push(m), error() {} };

    const result = fileFindings({ envelope: envelope() }, { gh, logger });

    assert.equal(result.degraded, true);
    assert.deepEqual(result.actions, []);
    // Only the LIST was attempted; no write (create / comment) was made.
    assert.ok(
      !gh.calls.some(
        (a) => a[0] === 'issue' && (a[1] === 'create' || a[1] === 'comment'),
      ),
      'a LIST-time degradation must make zero writes',
    );
    assert.ok(warns.some((m) => /DEGRADED/.test(m)));
  });

  it('main exits 0 on an absent token (a misconfigured secret never red-Xes a merge)', async () => {
    const out = [];
    const code = await main(
      ['--envelope', '/env.json'],
      {}, // no token in env
      {
        readFileImpl: () => JSON.stringify(envelope()),
        logger: silentLogger(),
        write: (s) => out.push(s),
      },
    );
    assert.equal(code, 0);
    assert.equal(JSON.parse(out.join('')).degraded, true);
  });
});

describe('defaultGhPort — explicit FEEDBACK token binding (M8)', () => {
  it('binds GH_TOKEN to FEEDBACK_GITHUB_TOKEN and NEVER the destructive BENCH PAT', () => {
    const prevFeedback = process.env.FEEDBACK_GITHUB_TOKEN;
    const prevBench = process.env.BENCH_GITHUB_TOKEN;
    process.env.FEEDBACK_GITHUB_TOKEN = 'ghp_feedback';
    process.env.BENCH_GITHUB_TOKEN = 'ghp_destructive';
    try {
      let capturedEnv;
      const execFileFn = (cmd, args, opts) => {
        assert.equal(cmd, 'gh');
        assert.deepEqual(args, ['issue', 'list']);
        capturedEnv = opts.env;
        return '[]';
      };
      const out = defaultGhPort(['issue', 'list'], { execFileFn });
      assert.equal(out, '[]');
      // The filer authenticates with the FEEDBACK credential, never the
      // destructive sandbox PAT — even when both are exported.
      assert.equal(capturedEnv.GH_TOKEN, 'ghp_feedback');
      assert.notEqual(capturedEnv.GH_TOKEN, 'ghp_destructive');
    } finally {
      if (prevFeedback === undefined) delete process.env.FEEDBACK_GITHUB_TOKEN;
      else process.env.FEEDBACK_GITHUB_TOKEN = prevFeedback;
      if (prevBench === undefined) delete process.env.BENCH_GITHUB_TOKEN;
      else process.env.BENCH_GITHUB_TOKEN = prevBench;
    }
  });
});

describe('threadHasMarker', () => {
  it('finds a marker in the body or any comment, else false', () => {
    const m = cohortMarker(COHORT);
    assert.equal(threadHasMarker({ body: `x ${m} y`, comments: [] }, m), true);
    assert.equal(
      threadHasMarker({ body: 'x', comments: [{ body: m }] }, m),
      true,
    );
    assert.equal(threadHasMarker({ body: 'x', comments: [] }, m), false);
  });
});

describe('render helpers', () => {
  it('renderFindingBody is deterministic and carries markers + evidence', () => {
    const a = renderFindingBody(finding(), envelope());
    const b = renderFindingBody(finding(), envelope());
    assert.equal(a, b);
    assert.ok(a.includes(fingerprintMarker(finding().fingerprint)));
    assert.ok(a.includes(cohortMarker(COHORT)));
    assert.ok(a.includes('noiseFloor'));
  });

  it('renderCohortComment leads with the cohort marker and cohort numbers', () => {
    const c = renderCohortComment(finding(), envelope());
    assert.ok(c.startsWith(cohortMarker(COHORT)));
    assert.ok(c.includes('1.71.0'));
  });
});

describe('parseFileCliArgs', () => {
  it('parses envelope, repo, dry-run, and limit with sane defaults', () => {
    const parsed = parseFileCliArgs([
      '--envelope',
      '/tmp/findings.json',
      '--dry-run',
      '--limit',
      '25',
    ]);
    assert.equal(parsed.envelope, '/tmp/findings.json');
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.limit, 25);
    assert.equal(parsed.repo, 'dsj1984/mandrel');
    assert.equal(parsed.label, 'bench-feedback');
  });
});

describe('main — CLI entry (no live GitHub call)', () => {
  it('dry-run exits 0 and never invokes gh', async () => {
    const out = [];
    const gh = () => {
      throw new Error('main dry-run must not call gh');
    };
    const code = await main(
      ['--envelope', '/x/findings.json', '--dry-run'],
      {},
      {
        gh,
        logger: silentLogger(),
        write: (s) => out.push(s),
        readFileImpl: () => JSON.stringify(envelope()),
      },
    );
    assert.equal(code, 0);
    const summary = JSON.parse(out.join(''));
    assert.equal(summary.dryRun, true);
  });

  it('a missing write scope is non-fatal — main exits 0', async () => {
    const gh = makeGh({
      list: [{ number: 7, title: 'x', body: 'unrelated' }],
      failOn: (a) => a[0] === 'issue' && a[1] === 'create',
    });
    const out = [];
    const code = await main(
      ['--envelope', '/x/findings.json'],
      {},
      {
        gh,
        logger: silentLogger(),
        write: (s) => out.push(s),
        readFileImpl: () => JSON.stringify(envelope()),
      },
    );
    assert.equal(code, 0);
    assert.equal(JSON.parse(out.join('')).degraded, true);
  });

  it('missing --envelope exits 1', async () => {
    const code = await main([], {}, { logger: silentLogger(), write() {} });
    assert.equal(code, 1);
  });

  it('--help prints usage and exits 0', async () => {
    const out = [];
    const code = await main(['--help'], {}, { write: (s) => out.push(s) });
    assert.equal(code, 0);
    assert.ok(out.join('').includes('Usage: node bench/feedback/file.js'));
  });
});
