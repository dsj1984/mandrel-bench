// tests/bench/driver/sandbox.test.js
/**
 * Unit tests for bench/driver/sandbox.js — Story #4216.
 *
 * Verifies the ephemeral sandbox lifecycle:
 *   - provision clones the configured repo into a fresh temp workspace,
 *   - the control arm strips the materialized `.agents/` bundle,
 *   - teardown removes ONLY the ephemeral workspace,
 *   - the path-containment guard refuses to delete anything outside the
 *     ephemeral root (the strict-scoping safety contract),
 *   - withSandbox guarantees teardown even when the body throws.
 *
 * Every filesystem and git effect is INJECTED — no real clone, no real rm.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildTargetPackageJson } from '../../../bench/driver/overlay.js';
import {
  assertInsideRoot,
  createEphemeralRepo,
  defaultGhInvoke,
  defaultSandboxTemplateRoot,
  destroyEphemeralRepo,
  materializeSandboxTemplate,
  provisionSandbox,
  resetSandboxBaseline,
  SANDBOX_DIR_PREFIX,
  sandboxRepoName,
  sanitizeGitHubTokenEnv,
  seedFromTemplate,
  teardownSandbox,
  withRetry,
  withSandbox,
} from '../../../bench/driver/sandbox.js';

const ROOT = path.resolve('/tmp/ephemeral-root');

/**
 * Build an injected dep bundle with recording fakes. By default the workspace
 * is created under ROOT and every path "exists".
 */
function fakes(opts = {}) {
  const execCalls = [];
  const rmCalls = [];
  const existing = new Set(opts.existing ?? []);
  const created =
    opts.workspacePath ?? path.join(ROOT, `${SANDBOX_DIR_PREFIX}abc123`);

  const deps = {
    execFileFn: (cmd, args) => {
      execCalls.push({ cmd, args });
      if (opts.cloneThrows) {
        throw new Error('fatal: clone failed');
      }
      return '';
    },
    mkdtempFn: (prefixArg) => {
      // Real mkdtemp appends random chars; our fake returns a fixed path but
      // asserts the caller passed the expected <root>/<prefix> argument.
      assert.ok(prefixArg.startsWith(path.join(ROOT, SANDBOX_DIR_PREFIX)));
      return created;
    },
    existsFn: (p) => existing.has(path.resolve(p)),
    rmFn: (p, o) => {
      rmCalls.push({ path: path.resolve(p), opts: o });
    },
    statFn: () => ({ isDirectory: () => !opts.notADir }),
    logger: { info() {}, warn() {} },
  };
  return { deps, execCalls, rmCalls, created };
}

// ---------------------------------------------------------------------------
// assertInsideRoot — the load-bearing safety primitive
// ---------------------------------------------------------------------------

test('assertInsideRoot: accepts a proper descendant', () => {
  const ok = assertInsideRoot(ROOT, path.join(ROOT, 'ws-1'), 'ws');
  assert.equal(ok, path.join(ROOT, 'ws-1'));
});

test('assertInsideRoot: rejects the root itself', () => {
  assert.throws(() => assertInsideRoot(ROOT, ROOT, 'ws'), /resolves outside/);
});

test('assertInsideRoot: rejects ../ traversal escapes', () => {
  assert.throws(
    () => assertInsideRoot(ROOT, path.join(ROOT, '..', 'evil'), 'ws'),
    /resolves outside/,
  );
});

test('assertInsideRoot: rejects an absolute re-root to a real path', () => {
  assert.throws(
    () => assertInsideRoot(ROOT, '/Users/someone/real-repo', 'ws'),
    /resolves outside/,
  );
  assert.throws(() => assertInsideRoot(ROOT, '/', 'ws'), /resolves outside/);
});

test('assertInsideRoot: rejects empty root / target', () => {
  assert.throws(() => assertInsideRoot('', '/tmp/x', 'ws'), /non-empty root/);
  assert.throws(() => assertInsideRoot(ROOT, '', 'ws'), /non-empty target/);
});

// ---------------------------------------------------------------------------
// provisionSandbox
// ---------------------------------------------------------------------------

test('provisionSandbox: clones into a fresh temp workspace under the root', () => {
  const { deps, execCalls, created } = fakes();
  const handle = provisionSandbox(
    { repoUrl: 'https://github.com/acme/sandbox.git', ephemeralRoot: ROOT },
    deps,
  );

  assert.equal(handle.workspacePath, created);
  assert.equal(handle.ephemeralRoot, ROOT);
  assert.equal(handle.arm, 'mandrel');
  assert.equal(handle.agentsStripped, false);

  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].cmd, 'git');
  assert.deepEqual(execCalls[0].args, [
    'clone',
    '--depth',
    '1',
    '--',
    'https://github.com/acme/sandbox.git',
    created,
  ]);
});

test('provisionSandbox: passes --branch when a ref is supplied', () => {
  const { deps, execCalls } = fakes();
  provisionSandbox(
    { repoUrl: 'u', ref: 'release/v2', ephemeralRoot: ROOT, depth: 3 },
    deps,
  );
  assert.deepEqual(execCalls[0].args.slice(0, 6), [
    'clone',
    '--depth',
    '3',
    '--branch',
    'release/v2',
    '--',
  ]);
});

test('provisionSandbox: control arm strips a present .agents/ bundle', () => {
  const created = path.join(ROOT, `${SANDBOX_DIR_PREFIX}ctrl`);
  const { deps, rmCalls } = fakes({
    workspacePath: created,
    existing: [path.join(created, '.agents')],
  });
  const handle = provisionSandbox(
    { repoUrl: 'u', arm: 'control', ephemeralRoot: ROOT },
    deps,
  );
  assert.equal(handle.arm, 'control');
  assert.equal(handle.agentsStripped, true);
  assert.equal(rmCalls.length, 1);
  assert.equal(rmCalls[0].path, path.join(created, '.agents'));
  assert.equal(rmCalls[0].opts.recursive, true);
});

test('provisionSandbox: control arm with no .agents/ present is a no-op strip', () => {
  const { deps, rmCalls } = fakes({ existing: [] });
  const handle = provisionSandbox(
    { repoUrl: 'u', arm: 'control', ephemeralRoot: ROOT },
    deps,
  );
  assert.equal(handle.agentsStripped, false);
  assert.equal(rmCalls.length, 0);
});

test('provisionSandbox: a failed clone cleans up the partial workspace and rethrows', () => {
  const created = path.join(ROOT, `${SANDBOX_DIR_PREFIX}fail`);
  const { deps, rmCalls } = fakes({
    workspacePath: created,
    cloneThrows: true,
    existing: [created], // the partial dir exists and must be swept
  });
  assert.throws(
    () => provisionSandbox({ repoUrl: 'u', ephemeralRoot: ROOT }, deps),
    /git clone failed/,
  );
  // Cleanup must target only the (contained) partial workspace.
  assert.equal(rmCalls.length, 1);
  assert.equal(rmCalls[0].path, created);
});

test('provisionSandbox: carries repoFullName/baselineSha and sets ephemeral: true when supplied (Story #71)', () => {
  const { deps, created } = fakes();
  const handle = provisionSandbox(
    {
      repoUrl: 'https://github.com/acme/bench-sbx-c1-hw-mandrel-a1b2.git',
      ephemeralRoot: ROOT,
      repoFullName: 'acme/bench-sbx-c1-hw-mandrel-a1b2',
      baselineSha: 'deadbeef',
    },
    deps,
  );
  assert.equal(handle.workspacePath, created);
  assert.equal(handle.repoFullName, 'acme/bench-sbx-c1-hw-mandrel-a1b2');
  assert.equal(handle.baselineSha, 'deadbeef');
  assert.equal(handle.ephemeral, true);
});

test('provisionSandbox: ephemeral defaults to false and repoFullName/baselineSha to null on the legacy standing-repo path', () => {
  const { deps } = fakes();
  const handle = provisionSandbox(
    { repoUrl: 'https://github.com/acme/sandbox.git', ephemeralRoot: ROOT },
    deps,
  );
  assert.equal(handle.ephemeral, false);
  assert.equal(handle.repoFullName, null);
  assert.equal(handle.baselineSha, null);
});

test('provisionSandbox: rejects empty repoUrl and bad arm', () => {
  const { deps } = fakes();
  assert.throws(
    () => provisionSandbox({ repoUrl: '', ephemeralRoot: ROOT }, deps),
    /non-empty repoUrl/,
  );
  assert.throws(
    () =>
      provisionSandbox(
        { repoUrl: 'u', arm: 'nope', ephemeralRoot: ROOT },
        deps,
      ),
    /must be a known benchmark arm/,
  );
});

// ---------------------------------------------------------------------------
// resetSandboxBaseline — clean, repeatable runs
// ---------------------------------------------------------------------------

test('resetSandboxBaseline: resolves the baseline sha then force-PATCHes main', () => {
  const ghCalls = [];
  const ghFn = (args) => {
    ghCalls.push(args);
    if (args.some((a) => a.endsWith('git/ref/heads/bench-baseline'))) {
      return JSON.stringify({ object: { sha: 'deadbeef123' } });
    }
    return '';
  };
  const res = resetSandboxBaseline(
    { owner: 'dsj1984', repo: 'bench-sbx-c1-hw-mandrel-a1b2' },
    { ghFn, logger: { info() {}, warn() {} } },
  );

  assert.deepEqual(res, { reset: true, sha: 'deadbeef123' });
  assert.equal(ghCalls.length, 2);
  // 1. Resolve the baseline ref's sha.
  assert.deepEqual(ghCalls[0], [
    'api',
    'repos/dsj1984/bench-sbx-c1-hw-mandrel-a1b2/git/ref/heads/bench-baseline',
  ]);
  // 2. Force-update main to that sha.
  assert.deepEqual(ghCalls[1], [
    'api',
    '-X',
    'PATCH',
    'repos/dsj1984/bench-sbx-c1-hw-mandrel-a1b2/git/refs/heads/main',
    '-f',
    'sha=deadbeef123',
    '-F',
    'force=true',
  ]);
});

test('resetSandboxBaseline: honors a custom baselineRef', () => {
  const ghCalls = [];
  const ghFn = (args) => {
    ghCalls.push(args);
    return JSON.stringify({ object: { sha: 'cafe01' } });
  };
  resetSandboxBaseline(
    { owner: 'o', repo: 'r', baselineRef: 'pristine' },
    { ghFn },
  );
  assert.deepEqual(ghCalls[0], ['api', 'repos/o/r/git/ref/heads/pristine']);
  assert.equal(ghCalls[1].includes('sha=cafe01'), true);
});

test('resetSandboxBaseline: with a supplied sha, force-resets straight to it — skips the branch-resolve API call (Story #71)', () => {
  const ghCalls = [];
  const ghFn = (args) => {
    ghCalls.push(args);
    return '';
  };
  const res = resetSandboxBaseline(
    { owner: 'dsj1984', repo: 'bench-sbx-c1-hw-mandrel-a1b2', sha: 'cafef00d' },
    { ghFn, logger: { info() {}, warn() {} } },
  );
  assert.deepEqual(res, { reset: true, sha: 'cafef00d' });
  // Exactly ONE call: the force-PATCH. No branch-resolve GET.
  assert.equal(ghCalls.length, 1);
  assert.deepEqual(ghCalls[0], [
    'api',
    '-X',
    'PATCH',
    'repos/dsj1984/bench-sbx-c1-hw-mandrel-a1b2/git/refs/heads/main',
    '-f',
    'sha=cafef00d',
    '-F',
    'force=true',
  ]);
});

test('resetSandboxBaseline: an empty sha falls back to resolving baselineRef', () => {
  const ghCalls = [];
  const ghFn = (args) => {
    ghCalls.push(args);
    if (args.some((a) => a.endsWith('git/ref/heads/bench-baseline'))) {
      return JSON.stringify({ object: { sha: 'resolved-sha' } });
    }
    return '';
  };
  const res = resetSandboxBaseline(
    { owner: 'o', repo: 'r', sha: '' },
    { ghFn },
  );
  assert.equal(res.sha, 'resolved-sha');
  assert.equal(ghCalls.length, 2);
});

test('resetSandboxBaseline: rejects a missing owner/repo with a TypeError', () => {
  assert.throws(
    () => resetSandboxBaseline({ repo: 'r' }, { ghFn: () => '' }),
    /non-empty owner/,
  );
  assert.throws(
    () => resetSandboxBaseline({ owner: 'o' }, { ghFn: () => '' }),
    /non-empty repo/,
  );
});

// ---------------------------------------------------------------------------
// gh token sanitization — a malformed ambient token must not break the reset
// ---------------------------------------------------------------------------

test('sanitizeGitHubTokenEnv: strips a trailing CRLF \\r from the token', () => {
  const cleaned = sanitizeGitHubTokenEnv({
    PATH: '/usr/bin',
    GITHUB_TOKEN: 'ghp_abc123\r',
  });
  assert.equal(cleaned.GITHUB_TOKEN, 'ghp_abc123');
  // Unrelated vars pass through untouched.
  assert.equal(cleaned.PATH, '/usr/bin');
});

test('sanitizeGitHubTokenEnv: strips whitespace from GH_TOKEN and GITHUB_TOKEN', () => {
  const cleaned = sanitizeGitHubTokenEnv({
    GH_TOKEN: ' gho_x\n',
    GITHUB_TOKEN: 'ghp_y \t',
  });
  assert.equal(cleaned.GH_TOKEN, 'gho_x');
  assert.equal(cleaned.GITHUB_TOKEN, 'ghp_y');
});

test('sanitizeGitHubTokenEnv: leaves an unset / empty token untouched (keyring auth)', () => {
  const cleaned = sanitizeGitHubTokenEnv({ PATH: '/bin', GITHUB_TOKEN: '' });
  assert.equal(cleaned.GITHUB_TOKEN, '');
  assert.equal('GH_TOKEN' in cleaned, false);
});

test('defaultGhInvoke: passes a token-sanitized env to the gh child', () => {
  const prev = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_carriage\r';
  try {
    let capturedEnv;
    const execFileFn = (cmd, args, opts) => {
      assert.equal(cmd, 'gh');
      assert.equal(args[0], 'api');
      capturedEnv = opts.env;
      return 'ok';
    };
    const out = defaultGhInvoke(
      ['api', 'repos/o/r/git/ref/heads/bench-baseline'],
      { execFileFn },
    );
    assert.equal(out, 'ok');
    // The trailing \r that yields "invalid header field value for
    // Authorization" is gone before gh ever sees the token.
    assert.equal(capturedEnv.GITHUB_TOKEN, 'ghp_carriage');
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev;
  }
});

test('sanitizeGitHubTokenEnv: BENCH_GITHUB_TOKEN wins as GH_TOKEN, overriding an ambient GH_TOKEN/GITHUB_TOKEN (Epic #65 audit remediation, finding #2)', () => {
  const cleaned = sanitizeGitHubTokenEnv({
    PATH: '/usr/bin',
    GH_TOKEN: 'ambient-broad-scope-token',
    GITHUB_TOKEN: 'ambient-broad-scope-token',
    BENCH_GITHUB_TOKEN: 'bench-scoped-token\r',
  });
  assert.equal(cleaned.GH_TOKEN, 'bench-scoped-token');
  // The ambient GITHUB_TOKEN is left as-is (only whitespace-stripped) — the
  // injected GH_TOKEN is what `gh` actually reads (GH_TOKEN takes precedence
  // over GITHUB_TOKEN in gh's own resolution order).
  assert.equal(cleaned.GITHUB_TOKEN, 'ambient-broad-scope-token');
});

test('sanitizeGitHubTokenEnv: no BENCH_GITHUB_TOKEN leaves GH_TOKEN untouched', () => {
  const cleaned = sanitizeGitHubTokenEnv({ PATH: '/bin' });
  assert.equal('GH_TOKEN' in cleaned, false);
});

test('defaultGhInvoke: BENCH_GITHUB_TOKEN in the environment reaches the gh child as GH_TOKEN', () => {
  const prevBench = process.env.BENCH_GITHUB_TOKEN;
  const prevGh = process.env.GH_TOKEN;
  process.env.BENCH_GITHUB_TOKEN = 'bench-scoped-token';
  delete process.env.GH_TOKEN;
  try {
    let capturedEnv;
    const execFileFn = (_cmd, _args, opts) => {
      capturedEnv = opts.env;
      return 'ok';
    };
    defaultGhInvoke(['repo', 'list', 'dsj1984'], { execFileFn });
    assert.equal(capturedEnv.GH_TOKEN, 'bench-scoped-token');
  } finally {
    if (prevBench === undefined) delete process.env.BENCH_GITHUB_TOKEN;
    else process.env.BENCH_GITHUB_TOKEN = prevBench;
    if (prevGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevGh;
  }
});

// ---------------------------------------------------------------------------
// withRetry — idempotent-operation retry wrapper (Epic #65 audit remediation,
// finding #9)
// ---------------------------------------------------------------------------

test('withRetry: returns the result on first success without retrying', () => {
  let calls = 0;
  const result = withRetry(() => {
    calls += 1;
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry: retries once on failure then succeeds', () => {
  let calls = 0;
  const result = withRetry(() => {
    calls += 1;
    if (calls === 1) throw new Error('transient');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('withRetry: exhausts retries and rethrows the last error', () => {
  let calls = 0;
  assert.throws(
    () =>
      withRetry(() => {
        calls += 1;
        throw new Error(`fail ${calls}`);
      }),
    /fail 2/,
  );
  assert.equal(calls, 2);
});

test('destroyEphemeralRepo: retries once on a transient gh failure before succeeding', () => {
  let attempts = 0;
  const res = destroyEphemeralRepo(
    { repoFullName: 'dsj1984/bench-sbx-c1-hw-mandrel-a1b2' },
    {
      ghFn: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('gh: transient network error');
        return '';
      },
      logger: { info() {}, warn() {} },
    },
  );
  assert.equal(res.deleted, true);
  assert.equal(attempts, 2);
});

// ---------------------------------------------------------------------------
// sandboxRepoName — pure repo-name generator (Story #71)
// ---------------------------------------------------------------------------

test('sandboxRepoName: always bench-sbx- prefixed', () => {
  const name = sandboxRepoName({
    cohort: '1.75.0',
    scenario: 'hello-world',
    arm: 'mandrel',
    nonce: 'a1b2c3',
  });
  assert.ok(name.startsWith(SANDBOX_DIR_PREFIX));
  assert.equal(name, 'bench-sbx-1-75-0-hello-world-mandrel-a1b2c3');
});

test('sandboxRepoName: slugifies non-alphanumeric characters', () => {
  const name = sandboxRepoName({
    cohort: 'v1.75.0!',
    scenario: 'crud_db',
    arm: 'control',
    nonce: 'xyz',
  });
  assert.doesNotMatch(name, /[^a-z0-9-]/);
});

test('sandboxRepoName: clamps to <= 100 chars, truncating the middle segment, never the prefix or nonce', () => {
  const nonce = 'a1b2c3d4';
  const name = sandboxRepoName({
    cohort: 'x'.repeat(80),
    scenario: 'y'.repeat(80),
    arm: 'mandrel',
    nonce,
  });
  assert.ok(name.length <= 100, `expected <= 100 chars, got ${name.length}`);
  assert.ok(
    name.startsWith(SANDBOX_DIR_PREFIX),
    'prefix must survive clamping',
  );
  assert.ok(
    name.endsWith(nonce),
    'nonce must survive clamping, never truncated',
  );
});

test('sandboxRepoName: requires a non-empty nonce', () => {
  assert.throws(
    () => sandboxRepoName({ cohort: 'c', scenario: 's', arm: 'mandrel' }),
    /non-empty nonce/,
  );
  assert.throws(() => sandboxRepoName({ nonce: '' }), /non-empty nonce/);
});

test('sandboxRepoName: omits empty cohort/scenario/arm segments cleanly', () => {
  const name = sandboxRepoName({ nonce: 'onlynonce' });
  assert.equal(name, 'bench-sbx-onlynonce');
});

// ---------------------------------------------------------------------------
// createEphemeralRepo / destroyEphemeralRepo — the remote repo lifecycle
// ---------------------------------------------------------------------------

test('createEphemeralRepo: gh repo create <owner>/<name> --private via the injected ghFn', () => {
  const ghCalls = [];
  const res = createEphemeralRepo(
    { owner: 'dsj1984', name: 'bench-sbx-c1-hw-mandrel-a1b2' },
    { ghFn: (args) => ghCalls.push(args), logger: { info() {}, warn() {} } },
  );
  assert.deepEqual(res, {
    repoFullName: 'dsj1984/bench-sbx-c1-hw-mandrel-a1b2',
  });
  assert.deepEqual(ghCalls[0], [
    'repo',
    'create',
    'dsj1984/bench-sbx-c1-hw-mandrel-a1b2',
    '--private',
  ]);
});

test('createEphemeralRepo: refuses a name outside the reserved bench-sbx- prefix', () => {
  assert.throws(
    () =>
      createEphemeralRepo(
        { owner: 'dsj1984', name: 'some-other-repo' },
        { ghFn: () => '' },
      ),
    /reserved bench-sbx- prefix/,
  );
});

test('createEphemeralRepo: requires a non-empty owner', () => {
  assert.throws(
    () => createEphemeralRepo({ name: 'bench-sbx-x' }, { ghFn: () => '' }),
    /non-empty owner/,
  );
});

test('destroyEphemeralRepo: gh repo delete --yes via the injected ghFn', () => {
  const ghCalls = [];
  const res = destroyEphemeralRepo(
    { repoFullName: 'dsj1984/bench-sbx-c1-hw-mandrel-a1b2' },
    { ghFn: (args) => ghCalls.push(args), logger: { info() {}, warn() {} } },
  );
  assert.deepEqual(res, {
    deleted: true,
    repoFullName: 'dsj1984/bench-sbx-c1-hw-mandrel-a1b2',
  });
  assert.deepEqual(ghCalls[0], [
    'repo',
    'delete',
    'dsj1984/bench-sbx-c1-hw-mandrel-a1b2',
    '--yes',
  ]);
});

test('destroyEphemeralRepo: refuses a repo name outside the reserved bench-sbx- prefix', () => {
  assert.throws(
    () =>
      destroyEphemeralRepo(
        { repoFullName: 'dsj1984/some-other-repo' },
        { ghFn: () => '' },
      ),
    /reserved bench-sbx- prefix/,
  );
});

test('destroyEphemeralRepo: best-effort on a gh failure — logs a warning and returns deleted:false rather than throwing', () => {
  const warnings = [];
  const res = destroyEphemeralRepo(
    { repoFullName: 'dsj1984/bench-sbx-c1-hw-mandrel-a1b2' },
    {
      ghFn: () => {
        throw new Error('gh: repo not found');
      },
      logger: { info() {}, warn: (m) => warnings.push(m) },
    },
  );
  assert.equal(res.deleted, false);
  assert.equal(res.repoFullName, 'dsj1984/bench-sbx-c1-hw-mandrel-a1b2');
  assert.match(res.error, /repo not found/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /best-effort/);
});

// ---------------------------------------------------------------------------
// seedFromTemplate — materialize + commit + push the baseline
// ---------------------------------------------------------------------------

test('seedFromTemplate: materializes the template, commits, pushes, and resolves the baseline sha', () => {
  const execCalls = [];
  const materializeCalls = [];
  const res = seedFromTemplate(
    {
      repoFullName: 'dsj1984/bench-sbx-c1-hw-mandrel-a1b2',
      workspacePath: '/ws/seed',
      templateRoot: '/repo/bench/sandbox-template',
    },
    {
      execFileFn: (cmd, args) => {
        execCalls.push({ cmd, args });
        if (args[0] === 'rev-parse') return 'abc123sha\n';
        return '';
      },
      materializeFn: (opts) => {
        materializeCalls.push(opts);
        return { ...opts };
      },
      logger: { info() {}, warn() {} },
    },
  );

  assert.deepEqual(res, {
    repoFullName: 'dsj1984/bench-sbx-c1-hw-mandrel-a1b2',
    baselineSha: 'abc123sha',
    repoUrl: 'https://github.com/dsj1984/bench-sbx-c1-hw-mandrel-a1b2.git',
  });
  assert.equal(materializeCalls.length, 1);
  assert.equal(materializeCalls[0].targetDir, '/ws/seed');
  assert.equal(
    materializeCalls[0].templateRoot,
    '/repo/bench/sandbox-template',
  );

  for (const c of execCalls) assert.equal(c.cmd, 'git');

  // The commit call is prefixed with a pinned, synthetic `-c user.name=…`
  // identity (Epic #65 audit remediation, finding #5) so the seed commit
  // never bakes the operator's ambient git identity into a repo pushed to
  // GitHub; every other call's args[0] is the plain git subcommand.
  const subcommands = execCalls.map((c) =>
    c.args[0] === '-c'
      ? c.args.find((a, i) => i >= 4 && !a.startsWith('-'))
      : c.args[0],
  );
  assert.deepEqual(subcommands, [
    'init',
    'add',
    'commit',
    'remote',
    'push',
    'rev-parse',
  ]);
  const commitCall = execCalls.find((c) => c.args.includes('commit'));
  assert.deepEqual(commitCall.args.slice(0, 4), [
    '-c',
    'user.name=mandrel-bench',
    '-c',
    'user.email=bench@noreply.local',
  ]);
});

test('seedFromTemplate: requires a non-empty repoFullName and workspacePath', () => {
  assert.throws(
    () => seedFromTemplate({ workspacePath: '/ws' }, {}),
    /non-empty repoFullName/,
  );
  assert.throws(
    () => seedFromTemplate({ repoFullName: 'o/r' }, {}),
    /non-empty workspacePath/,
  );
});

// ---------------------------------------------------------------------------
// Full lifecycle ordering: create → seed → run(s) → destroy (Story #71)
// ---------------------------------------------------------------------------

test('lifecycle ordering: create → seed → run → destroy, via one injected ghInvoke fake', () => {
  const order = [];
  const ghFn = (args) => {
    if (args[0] === 'repo' && args[1] === 'create') order.push('create');
    if (args[0] === 'repo' && args[1] === 'delete') order.push('destroy');
    return '';
  };
  const execFileFn = (cmd, args) => {
    if (cmd === 'git' && args[0] === 'clone') {
      order.push('run');
      return '';
    }
    if (cmd === 'git' && args[0] === 'rev-parse') return 'seedsha\n';
    return '';
  };
  const materializeFn = () => {
    order.push('seed');
    return {};
  };

  const created = createEphemeralRepo(
    { owner: 'dsj1984', name: 'bench-sbx-c1-hw-mandrel-a1b2' },
    { ghFn },
  );
  const seeded = seedFromTemplate(
    { repoFullName: created.repoFullName, workspacePath: '/ws/seed' },
    { execFileFn, materializeFn },
  );

  const runHandle = provisionSandbox(
    {
      repoUrl: seeded.repoUrl,
      ephemeralRoot: ROOT,
      repoFullName: seeded.repoFullName,
      baselineSha: seeded.baselineSha,
    },
    {
      execFileFn,
      mkdtempFn: () => path.join(ROOT, `${SANDBOX_DIR_PREFIX}run1`),
      existsFn: () => true,
      rmFn: () => {},
    },
  );
  assert.equal(runHandle.ephemeral, true);
  assert.equal(runHandle.baselineSha, 'seedsha');

  destroyEphemeralRepo({ repoFullName: created.repoFullName }, { ghFn });

  assert.deepEqual(order, ['create', 'seed', 'run', 'destroy']);
});

// ---------------------------------------------------------------------------
// teardownSandbox — strict-scoping safety
// ---------------------------------------------------------------------------

test('teardownSandbox: removes the workspace when it is inside the root', () => {
  const ws = path.join(ROOT, `${SANDBOX_DIR_PREFIX}live`);
  const { deps, rmCalls } = fakes({ existing: [ws] });
  const res = teardownSandbox({ workspacePath: ws, ephemeralRoot: ROOT }, deps);
  assert.equal(res.removed, true);
  assert.equal(res.workspacePath, ws);
  assert.equal(rmCalls.length, 1);
  assert.equal(rmCalls[0].path, ws);
  assert.equal(rmCalls[0].opts.recursive, true);
});

test('teardownSandbox: REFUSES to remove a path outside the ephemeral root', () => {
  const { deps, rmCalls } = fakes({ existing: ['/Users/me/real-mandrel'] });
  assert.throws(
    () =>
      teardownSandbox(
        { workspacePath: '/Users/me/real-mandrel', ephemeralRoot: ROOT },
        deps,
      ),
    /resolves outside the ephemeral sandbox root/,
  );
  // Critically: nothing was deleted.
  assert.equal(rmCalls.length, 0);
});

test('teardownSandbox: REFUSES when workspace equals the root (would nuke the root)', () => {
  const { deps, rmCalls } = fakes({ existing: [ROOT] });
  assert.throws(
    () => teardownSandbox({ workspacePath: ROOT, ephemeralRoot: ROOT }, deps),
    /resolves outside/,
  );
  assert.equal(rmCalls.length, 0);
});

test('teardownSandbox: REFUSES a ../ escape even if the path "exists"', () => {
  const escapePath = path.join(ROOT, '..', '..', 'etc');
  const { deps, rmCalls } = fakes({ existing: [path.resolve(escapePath)] });
  assert.throws(
    () =>
      teardownSandbox({ workspacePath: escapePath, ephemeralRoot: ROOT }, deps),
    /resolves outside/,
  );
  assert.equal(rmCalls.length, 0);
});

test('teardownSandbox: no-op when the workspace is already gone', () => {
  const ws = path.join(ROOT, `${SANDBOX_DIR_PREFIX}gone`);
  const { deps, rmCalls } = fakes({ existing: [] });
  const res = teardownSandbox({ workspacePath: ws, ephemeralRoot: ROOT }, deps);
  assert.equal(res.removed, false);
  assert.equal(rmCalls.length, 0);
});

test('teardownSandbox: refuses to remove a non-directory target', () => {
  const ws = path.join(ROOT, `${SANDBOX_DIR_PREFIX}file`);
  const { deps, rmCalls } = fakes({ existing: [ws], notADir: true });
  assert.throws(
    () => teardownSandbox({ workspacePath: ws, ephemeralRoot: ROOT }, deps),
    /not a directory/,
  );
  assert.equal(rmCalls.length, 0);
});

test('teardownSandbox: rejects a malformed handle', () => {
  assert.throws(() => teardownSandbox(null, {}), /requires a sandbox handle/);
  assert.throws(
    () => teardownSandbox({ ephemeralRoot: ROOT }, {}),
    /requires workspacePath/,
  );
  assert.throws(
    () => teardownSandbox({ workspacePath: '/tmp/x' }, {}),
    /requires ephemeralRoot/,
  );
});

// ---------------------------------------------------------------------------
// withSandbox — teardown is guaranteed
// ---------------------------------------------------------------------------

test('withSandbox: runs the body then tears down', async () => {
  const created = path.join(ROOT, `${SANDBOX_DIR_PREFIX}with`);
  const { deps, rmCalls } = fakes({
    workspacePath: created,
    existing: [created],
  });
  let sawHandle = null;
  const result = await withSandbox(
    { repoUrl: 'u', ephemeralRoot: ROOT },
    (handle) => {
      sawHandle = handle;
      return 'body-result';
    },
    { provision: deps, teardown: deps },
  );
  assert.equal(result, 'body-result');
  assert.equal(sawHandle.workspacePath, created);
  assert.equal(rmCalls.length, 1);
  assert.equal(rmCalls[0].path, created);
});

test('withSandbox: tears down even when the body throws', async () => {
  const created = path.join(ROOT, `${SANDBOX_DIR_PREFIX}boom`);
  const { deps, rmCalls } = fakes({
    workspacePath: created,
    existing: [created],
  });
  await assert.rejects(
    withSandbox(
      { repoUrl: 'u', ephemeralRoot: ROOT },
      () => {
        throw new Error('body exploded');
      },
      { provision: deps, teardown: deps },
    ),
    /body exploded/,
  );
  // Teardown still happened.
  assert.equal(rmCalls.length, 1);
  assert.equal(rmCalls[0].path, created);
});

// ---------------------------------------------------------------------------
// Story #153 — the greenfield baseline carries dependency-free gate scripts.
// ---------------------------------------------------------------------------

test('seedFromTemplate: the materialized greenfield baseline ships typecheck/lint/test scripts that each exit 0 with NO dependency install (Story #153)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bench-seed-gates-'));
  const workspacePath = path.join(root, 'seed');

  try {
    // Drive the REAL materializer through seedFromTemplate over the REAL
    // in-repo baseline template — only the git effects are injected, so the
    // assertion is over the tree a real cell would push as its baseline.
    seedFromTemplate(
      {
        repoFullName: 'dsj1984/bench-sbx-c1-hw-mandrel-a1b2',
        workspacePath,
        templateRoot: defaultSandboxTemplateRoot(),
        scenarioSandboxDir: null,
      },
      {
        execFileFn: (_cmd, args) => (args[0] === 'rev-parse' ? 'sha\n' : ''),
        logger: { info() {}, warn() {} },
      },
    );

    const pkgPath = path.join(workspacePath, 'package.json');
    assert.ok(
      existsSync(pkgPath),
      'greenfield baseline must carry a package.json',
    );
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    for (const script of ['typecheck', 'lint', 'test']) {
      assert.ok(pkg.scripts?.[script], `expected a ${script} script`);
    }

    // Dependency-free: nothing to install, and no dependency declarations to
    // install FROM. The gates must be green on the untouched seeded tree.
    assert.equal(pkg.dependencies, undefined);
    assert.equal(pkg.devDependencies, undefined);
    assert.ok(!existsSync(path.join(workspacePath, 'node_modules')));

    for (const script of ['typecheck', 'lint', 'test']) {
      const res = spawnSync('npm', ['run', '--silent', script], {
        cwd: workspacePath,
        encoding: 'utf8',
      });
      assert.equal(
        res.status,
        0,
        `npm run ${script} must exit 0 in the seeded tree; got ${res.status}\n${res.stdout}\n${res.stderr}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('materializeSandboxTemplate: the seeded gate package.json is byte-identical to the overlay gate file, so the overlay write is a no-op merge (Story #153)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bench-seed-gates-eq-'));
  try {
    const target = path.join(root, 'seed');
    materializeSandboxTemplate({
      templateRoot: defaultSandboxTemplateRoot(),
      targetDir: target,
    });
    const seeded = JSON.parse(
      readFileSync(path.join(target, 'package.json'), 'utf8'),
    );
    assert.deepEqual(seeded, buildTargetPackageJson());
    // …and re-running the overlay's own writer over that tree changes nothing.
    assert.deepEqual(buildTargetPackageJson(seeded), seeded);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
