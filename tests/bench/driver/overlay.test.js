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
  excludeOverlayFromGit,
  overlayExcludePaths,
  overlayFrameworkUnderTest,
  REWRITTEN_OVERLAY_ARTIFACTS,
  rewriteAgentrc,
  TRAP_NODE_CHECK_SWEEP,
  TRAP_SCENARIO_ID,
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
  const appends = {};
  const mkdirs = [];
  const missing = new Set(opts.missing ?? []);
  // The clone's `.git/info/exclude` starts absent — git-clone seeds an empty
  // working tree and never an exclude file. The append fake models how
  // appendFileSync grows the file, and existsFn flips it to "present" once
  // written so a re-run sees the existing block.
  const excludePath = path.join(WS, '.git', 'info', 'exclude');
  const deps = {
    cpFn: (src, dest, o) => cpCalls.push({ src, dest, opts: o }),
    writeFileFn: (p, data) => {
      writes[p] = data;
    },
    readFileFn: (p) => {
      if (p.endsWith('.agentrc.json')) return AGENTRC_SRC;
      if (p === excludePath) return appends[p] ?? '';
      throw new Error(`unexpected read: ${p}`);
    },
    appendFileFn: (p, data) => {
      appends[p] = (appends[p] ?? '') + data;
    },
    mkdirFn: (p, o) => mkdirs.push({ p, opts: o }),
    existsFn: (p) => {
      if (p === excludePath) return appends[p] !== undefined;
      return !missing.has(p);
    },
    logger: { info() {}, warn() {} },
  };
  return { deps, cpCalls, writes, appends, mkdirs, excludePath };
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

test('rewriteAgentrc: targets the coordinates carried on the EPHEMERAL sandbox handle, not any env-configured standing repo (Story #71)', () => {
  // The ephemeral per-cell repo's owner/repo are whatever createEphemeralRepo
  // + sandboxRepoName produced for THIS cell — a fresh, dynamic name every
  // time, never a fixed standing repo. rewriteAgentrc must be driven purely by
  // the { owner, repo } it is handed, proving there is no hidden fallback to a
  // fixed/env-configured repo.
  const ephemeralHandleCoords = {
    owner: 'dsj1984',
    repo: 'bench-sbx-1-75-0-hello-world-mandrel-a1b2c3',
  };
  const cfg = rewriteAgentrc(AGENTRC_SRC, ephemeralHandleCoords);
  assert.equal(cfg.github.owner, ephemeralHandleCoords.owner);
  assert.equal(cfg.github.repo, ephemeralHandleCoords.repo);

  // A second cell's differently-named ephemeral repo produces a differently
  // rewritten .agentrc.json — coordinates are handle-sourced, not a constant.
  const otherCellCoords = {
    owner: 'dsj1984',
    repo: 'bench-sbx-1-75-0-hello-world-control-d4e5f6',
  };
  const cfg2 = rewriteAgentrc(AGENTRC_SRC, otherCellCoords);
  assert.equal(cfg2.github.repo, otherCellCoords.repo);
  assert.notEqual(cfg.github.repo, cfg2.github.repo);
});

test('buildTargetPackageJson: clean minimal ESM consumer with no-op gate scripts', () => {
  const pkg = buildTargetPackageJson();
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies, undefined);
  // No-op gate scripts so close-validation's hardcoded `npm run typecheck` /
  // `npm run lint` / `npm test` succeed against the clobbered package.json
  // (the overlay overwrites package.json; Quality is scored by the frozen
  // oracle, not these scripts, so the no-ops are correct, not gaming).
  assert.deepEqual(pkg.scripts, {
    typecheck: 'node --version',
    lint: 'node --version',
    test: 'node --version',
  });
});

test('buildTargetPackageJson: no-op shim is unchanged for non-trap scenarios', () => {
  // Story #57 Out of Scope: un-stubbing must be scoped to the one trap
  // scenario; every other scenario keeps the no-op shim.
  for (const scenarioId of [
    undefined,
    'hello-world',
    'crud-db',
    'project-api',
  ]) {
    const pkg = buildTargetPackageJson({ scenarioId });
    assert.deepEqual(
      pkg.scripts,
      {
        typecheck: 'node --version',
        lint: 'node --version',
        test: 'node --version',
      },
      `expected the no-op shim for scenario ${String(scenarioId)}`,
    );
  }
});

test('buildTargetPackageJson: REAL gates fire only for the auth-trap scenario (Story #57)', () => {
  const pkg = buildTargetPackageJson({ scenarioId: TRAP_SCENARIO_ID });
  assert.equal(pkg.type, 'module');
  // The trap scenario un-stubs the gates so Mandrel's close-validation
  // enforcement actually fires: typecheck is a real per-file node --check
  // sweep, test runs node --test, neither is the node --version no-op.
  assert.notEqual(pkg.scripts.typecheck, 'node --version');
  assert.equal(pkg.scripts.typecheck, TRAP_NODE_CHECK_SWEEP);
  assert.match(pkg.scripts.typecheck, /^node -e "/);
  assert.match(pkg.scripts.typecheck, /--check/);
  assert.equal(pkg.scripts.test, 'node --test');
  // Lint is a real static gate too (node --check sweep when no Biome config).
  assert.notEqual(pkg.scripts.lint, 'node --version');
  assert.match(pkg.scripts.lint, /biome|--check/);
});

test('buildTargetPackageJson: the trap node --check sweep is a syntactically valid program', () => {
  // The gate is shipped as an inline `node -e "<program>"`. Recover the program
  // text and prove it parses, so a clean delivery does not fail the gate on a
  // harness typo rather than on the delivered code.
  const program = TRAP_NODE_CHECK_SWEEP.replace(/^node -e "/, '')
    .replace(/"$/, '')
    .replace(/\\"/g, '"');
  assert.doesNotThrow(() => new Function(program));
});

test('overlay (mandrel, trap scenario): writes the un-stubbed gates into the clone', () => {
  const { deps, writes } = fakes();
  overlayFrameworkUnderTest(
    {
      workspacePath: WS,
      arm: 'mandrel',
      sandbox: SANDBOX,
      sourceRoot: SOURCE,
      scenarioId: TRAP_SCENARIO_ID,
    },
    deps,
  );
  const pkg = JSON.parse(writes[path.join(WS, 'package.json')]);
  assert.equal(pkg.scripts.test, 'node --test');
  assert.notEqual(pkg.scripts.typecheck, 'node --version');
  assert.match(pkg.scripts.typecheck, /--check/);
});

test('overlay (mandrel, non-trap scenario): keeps the no-op shim in the clone', () => {
  const { deps, writes } = fakes();
  overlayFrameworkUnderTest(
    {
      workspacePath: WS,
      arm: 'mandrel',
      sandbox: SANDBOX,
      sourceRoot: SOURCE,
      scenarioId: 'hello-world',
    },
    deps,
  );
  const pkg = JSON.parse(writes[path.join(WS, 'package.json')]);
  assert.deepEqual(pkg.scripts, {
    typecheck: 'node --version',
    lint: 'node --version',
    test: 'node --version',
  });
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

  // Clean minimal package.json written into the clone, carrying the no-op
  // gate scripts so close-validation passes against the clobbered file.
  const pkg = JSON.parse(writes[path.join(WS, 'package.json')]);
  assert.equal(pkg.name, 'mandrel-bench-target');
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.scripts, {
    typecheck: 'node --version',
    lint: 'node --version',
    test: 'node --version',
  });

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

// ---------------------------------------------------------------------------
// Story #56 — git-exclude the framework overlay so it never enters the
// deliverable diff.
// ---------------------------------------------------------------------------

/**
 * Simulate which workspace paths git would stage, given a set of root-anchored
 * `.git/info/exclude` patterns (the `/dir` / `/file` shape the overlay writes).
 * A path is excluded when it equals an excluded file pattern or sits under an
 * excluded directory pattern — the same containment git applies. This lets the
 * regression test assert the overlaid paths are ABSENT from a simulated
 * commit's file set without spawning a real `git add`.
 *
 * @param {string[]} workspaceFiles  Repo-relative paths git sees in the tree.
 * @param {string[]} excludePatterns  Root-anchored patterns (`/x`).
 * @returns {string[]} The paths that would actually be staged.
 */
function simulateStagedFiles(workspaceFiles, excludePatterns) {
  const roots = excludePatterns.map((p) => p.replace(/^\//, ''));
  return workspaceFiles.filter((file) => {
    return !roots.some((root) => file === root || file.startsWith(`${root}/`));
  });
}

test('overlayExcludePaths: copied tree + rewritten artifacts, de-duplicated', () => {
  const paths = overlayExcludePaths();
  for (const rel of DEFAULT_OVERLAY_PATHS) assert.ok(paths.includes(rel));
  for (const rel of REWRITTEN_OVERLAY_ARTIFACTS) assert.ok(paths.includes(rel));
  // package.json / .agentrc.json must be present (the rewritten artifacts).
  assert.ok(paths.includes('package.json'));
  assert.ok(paths.includes('.agentrc.json'));
  // No duplicates even if an artifact also appears in the overlay list.
  assert.equal(new Set(paths).size, paths.length);
});

test('excludeOverlayFromGit: writes every overlaid path to .git/info/exclude', () => {
  const { deps, appends, excludePath } = fakes();
  const res = excludeOverlayFromGit({ workspacePath: WS }, deps);

  assert.equal(res.excludeFile, excludePath);
  const written = appends[excludePath];
  assert.ok(written, 'exclude file should have been appended to');

  // Every overlaid path + rewritten artifact is present, root-anchored.
  for (const rel of overlayExcludePaths()) {
    assert.ok(
      written.includes(`/${rel}\n`),
      `expected /${rel} in .git/info/exclude`,
    );
    assert.ok(res.patterns.includes(`/${rel}`));
    assert.ok(res.added.includes(`/${rel}`));
  }
  // Carries the sentinel header so a re-run can detect its own block.
  assert.ok(written.includes('# mandrel-bench: framework overlay'));
});

test('excludeOverlayFromGit: idempotent — a re-run adds nothing', () => {
  const { deps, appends, excludePath } = fakes();
  excludeOverlayFromGit({ workspacePath: WS }, deps);
  const afterFirst = appends[excludePath];

  const res2 = excludeOverlayFromGit({ workspacePath: WS }, deps);
  assert.deepEqual(res2.added, []);
  assert.equal(appends[excludePath], afterFirst, 'no duplicate block appended');
});

test('excludeOverlayFromGit: creates .git/info when the exclude file is absent', () => {
  const { deps, mkdirs } = fakes({
    missing: [path.join(WS, '.git', 'info')],
  });
  excludeOverlayFromGit({ workspacePath: WS }, deps);
  assert.ok(
    mkdirs.some(
      (m) => m.p === path.join(WS, '.git', 'info') && m.opts.recursive,
    ),
    'expected .git/info to be created recursively',
  );
});

test('excludeOverlayFromGit: rejects a missing workspacePath', () => {
  const { deps } = fakes();
  assert.throws(
    () => excludeOverlayFromGit({}, deps),
    /non-empty workspacePath/,
  );
});

test('overlay (mandrel): git-excludes the overlay and a simulated commit carries app code only', () => {
  const { deps, appends, excludePath } = fakes();
  const res = overlayFrameworkUnderTest(
    { workspacePath: WS, arm: 'mandrel', sandbox: SANDBOX, sourceRoot: SOURCE },
    deps,
  );

  // The overlay reports the excluded set on its envelope.
  for (const rel of overlayExcludePaths()) {
    assert.ok(res.excluded.includes(`/${rel}`), `expected /${rel} excluded`);
  }

  const patterns = appends[excludePath]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('/'));

  // A simulated deliverable commit: app code alongside the overlaid tree.
  const workspaceFiles = [
    'src/index.js',
    'src/lib/util.js',
    'README.md',
    '.agents/scripts/single-story-close.js',
    '.claude/commands/deliver.md',
    'CLAUDE.md',
    'node_modules/ajv/package.json',
    'package.json',
    '.agentrc.json',
  ];
  const staged = simulateStagedFiles(workspaceFiles, patterns);

  // Only app code survives — no framework overlay, no rewritten artifacts.
  assert.deepEqual(staged, ['src/index.js', 'src/lib/util.js', 'README.md']);
  assert.ok(!staged.some((f) => f.startsWith('.agents/')));
  assert.ok(!staged.includes('CLAUDE.md'));
  assert.ok(!staged.some((f) => f.startsWith('node_modules/')));
  assert.ok(!staged.includes('package.json'));
  assert.ok(!staged.includes('.agentrc.json'));
});

test('overlay (control): no overlay, no git-exclude written', () => {
  const { deps, appends } = fakes();
  overlayFrameworkUnderTest(
    { workspacePath: WS, arm: 'control', sandbox: SANDBOX, sourceRoot: SOURCE },
    deps,
  );
  assert.deepEqual(appends, {});
});
