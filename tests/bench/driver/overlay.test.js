// tests/bench/driver/overlay.test.js
/**
 * Unit tests for bench/driver/overlay.js — Story #3.
 *
 * Verifies the framework-under-test overlay:
 *   - the mandrel arm copies the framework tree + node_modules into the clone,
 *   - a clean minimal package.json is written into the clone,
 *   - .agentrc.json is rewritten to target the sandbox repo (projectNumber dropped),
 *   - the control arm is NOT overlaid (bare baseline),
 *   - missing source paths are skipped, not fatal.
 *
 * Every filesystem effect is INJECTED — no real 144 MB copy, no real disk.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  buildTargetPackageJson,
  DEFAULT_OVERLAY_PATHS,
  overlayFrameworkUnderTest,
  rewriteAgentrc,
} from '../../../bench/driver/overlay.js';

const SOURCE = '/repo';
const WS = '/tmp/ephemeral-root/mandrel-bench-sandbox-abc';
const SANDBOX = { owner: 'dsj1984', repo: 'mandrel-bench-sandbox' };

const AGENTRC_SRC = JSON.stringify({
  $schema: './.agents/schemas/agentrc.schema.json',
  project: { baseBranch: 'main' },
  github: { owner: 'dsj1984', repo: 'mandrel-bench', projectNumber: 7 },
  delivery: { ci: { skipForStoryPushes: true } },
});

/**
 * Recording fakes. Every source path "exists" unless listed in `missing`.
 */
function fakes(opts = {}) {
  const cpCalls = [];
  const writes = {};
  const missing = new Set(opts.missing ?? []);
  const deps = {
    cpFn: (src, dest, o) => cpCalls.push({ src, dest, opts: o }),
    writeFileFn: (p, data) => {
      writes[p] = data;
    },
    readFileFn: (p) => {
      if (p.endsWith('.agentrc.json')) return AGENTRC_SRC;
      throw new Error(`unexpected read: ${p}`);
    },
    existsFn: (p) => !missing.has(p),
    logger: { info() {}, warn() {} },
  };
  return { deps, cpCalls, writes };
}

test('rewriteAgentrc: repoints github and drops projectNumber, preserves the rest', () => {
  const cfg = rewriteAgentrc(AGENTRC_SRC, SANDBOX);
  assert.equal(cfg.github.owner, 'dsj1984');
  assert.equal(cfg.github.repo, 'mandrel-bench-sandbox');
  assert.equal(cfg.github.projectNumber, undefined);
  assert.equal(cfg.delivery.ci.skipForStoryPushes, true);
  assert.equal(cfg.project.baseBranch, 'main');
});

test('rewriteAgentrc: rejects bad input', () => {
  assert.throws(() => rewriteAgentrc('', SANDBOX), /non-empty agentrc/);
  assert.throws(
    () => rewriteAgentrc(AGENTRC_SRC, { owner: 'x' }),
    /sandbox \{ owner, repo \}/,
  );
});

test('buildTargetPackageJson: clean minimal ESM consumer, no scripts/deps', () => {
  const pkg = buildTargetPackageJson();
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true);
  assert.equal(pkg.scripts, undefined);
  assert.equal(pkg.dependencies, undefined);
});

test('overlay (mandrel): copies the framework tree + node_modules and writes config', () => {
  const { deps, cpCalls, writes } = fakes();
  const res = overlayFrameworkUnderTest(
    { workspacePath: WS, arm: 'mandrel', sandbox: SANDBOX, sourceRoot: SOURCE },
    deps,
  );

  assert.equal(res.overlaid, true);
  assert.deepEqual(res.copied, [...DEFAULT_OVERLAY_PATHS]);

  // Each overlay path copied src→dest with symlink-preserving recursive copy.
  for (const rel of DEFAULT_OVERLAY_PATHS) {
    const call = cpCalls.find((c) => c.src === path.join(SOURCE, rel));
    assert.ok(call, `expected a copy of ${rel}`);
    assert.equal(call.dest, path.join(WS, rel));
    assert.equal(call.opts.recursive, true);
    assert.equal(call.opts.verbatimSymlinks, true);
  }

  // Clean minimal package.json written into the clone.
  const pkg = JSON.parse(writes[path.join(WS, 'package.json')]);
  assert.equal(pkg.name, 'mandrel-bench-target');
  assert.equal(pkg.type, 'module');

  // .agentrc.json rewritten to the sandbox repo.
  const agentrc = JSON.parse(writes[path.join(WS, '.agentrc.json')]);
  assert.equal(agentrc.github.repo, 'mandrel-bench-sandbox');
  assert.equal(agentrc.github.projectNumber, undefined);
});

test('overlay (control): is a no-op — bare baseline, nothing copied', () => {
  const { deps, cpCalls, writes } = fakes();
  const res = overlayFrameworkUnderTest(
    { workspacePath: WS, arm: 'control', sandbox: SANDBOX, sourceRoot: SOURCE },
    deps,
  );
  assert.equal(res.overlaid, false);
  assert.deepEqual(res.copied, []);
  assert.equal(cpCalls.length, 0);
  assert.deepEqual(writes, {});
});

test('overlay (mandrel): a missing source path is skipped, not fatal', () => {
  const { deps, cpCalls } = fakes({
    missing: [path.join(SOURCE, 'node_modules')],
  });
  const res = overlayFrameworkUnderTest(
    { workspacePath: WS, arm: 'mandrel', sandbox: SANDBOX, sourceRoot: SOURCE },
    deps,
  );
  assert.ok(!res.copied.includes('node_modules'));
  assert.ok(!cpCalls.some((c) => c.src.endsWith('node_modules')));
  // The remaining paths still copied.
  assert.ok(res.copied.includes('.agents'));
});

test('overlay: rejects a bad arm and a missing workspacePath/sandbox', () => {
  const { deps } = fakes();
  assert.throws(
    () =>
      overlayFrameworkUnderTest(
        { workspacePath: WS, arm: 'nope', sandbox: SANDBOX },
        deps,
      ),
    /must be "mandrel" or "control"/,
  );
  assert.throws(
    () => overlayFrameworkUnderTest({ arm: 'mandrel', sandbox: SANDBOX }, deps),
    /non-empty workspacePath/,
  );
  assert.throws(
    () =>
      overlayFrameworkUnderTest({ workspacePath: WS, arm: 'mandrel' }, deps),
    /requires sandbox \{ owner, repo \}/,
  );
});
