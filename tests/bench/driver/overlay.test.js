// tests/bench/driver/overlay.test.js
/**
 * Unit tests for bench/driver/overlay.js — Story #3; gate un-stubbing
 * generalized in Epic #66, Story #74.
 *
 * Verifies the framework-under-test overlay:
 *   - the mandrel arm copies the framework tree + node_modules into the clone,
 *   - a package.json with REAL lint/typecheck/test gates is written into the
 *     clone for EVERY scenario (arm-agnostic — Story #74 inverted the former
 *     single-scenario special case),
 *   - .agentrc.json is rewritten to target the sandbox repo (projectNumber dropped),
 *   - the control arm is NOT overlaid (bare baseline) but writeGatePackageJson
 *     writes the SAME gate package.json directly into its workspace,
 *   - missing source paths are skipped, not fatal.
 *
 * Every filesystem effect is INJECTED — no real 144 MB copy, no real disk.
 */

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
  STATIC_CLAUDEMD_FIXTURE_PATH,
  seedStaticClaudeMd,
  writeGatePackageJson,
} from '../../../bench/driver/overlay.js';

const SOURCE = '/repo';
const WS = '/tmp/ephemeral-root/bench-sbx-test-ws-abc';
const SANDBOX = { owner: 'dsj1984', repo: 'bench-sbx-test-ws' };

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
  assert.equal(cfg.github.repo, 'bench-sbx-test-ws');
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

test('buildTargetPackageJson: clean minimal ESM consumer with REAL un-stubbed gate scripts (Story #74 — arm- and scenario-agnostic)', () => {
  const pkg = buildTargetPackageJson();
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies, undefined);
  // Every scenario now gets real gates so Mandrel's close-validation
  // enforcement genuinely fires on the mandrel arm, and the control arm's
  // delivered tree is measured against the identical gate contract.
  assert.notEqual(pkg.scripts.typecheck, 'node --version');
  assert.match(pkg.scripts.typecheck, /^node -e "/);
  assert.match(pkg.scripts.typecheck, /--check/);
  assert.equal(pkg.scripts.test, 'node --test');
  assert.notEqual(pkg.scripts.lint, 'node --version');
  assert.match(pkg.scripts.lint, /biome|--check/);
});

test('buildTargetPackageJson: is arm/scenario-agnostic — takes no options and is stable across calls', () => {
  const a = buildTargetPackageJson();
  const b = buildTargetPackageJson();
  assert.deepEqual(a, b);
});

test('buildTargetPackageJson: the node --check sweep is a syntactically valid program', () => {
  // The gate is shipped as an inline `node -e "<program>"`. Recover the program
  // text and prove it parses, so a clean delivery does not fail the gate on a
  // harness typo rather than on the delivered code.
  const pkg = buildTargetPackageJson();
  const program = pkg.scripts.typecheck
    .replace(/^node -e "/, '')
    .replace(/"$/, '')
    .replace(/\\"/g, '"');
  assert.doesNotThrow(() => new Function(program));
});

test('buildTargetPackageJson: the emitted lint script actually EXECUTES the correct branch (Epic #66 audit remediation — inverted ternary + `|| true` masking bug)', async (t) => {
  // Regex-matching the script string (as the tests above do) does not catch a
  // flipped `process.exit()` polarity or a `|| true` that swallows a real
  // failure — both bugs shipped silently because nothing ever ran the
  // compound shell command. These sub-tests actually execute it.
  const pkg = buildTargetPackageJson();
  const lintScript = pkg.scripts.lint;

  await t.test(
    'no biome config: runs the node --check sweep and exits 0 on clean code',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'overlay-lint-clean-'));
      try {
        writeFileSync(path.join(dir, 'index.js'), 'export const ok = 1;\n');
        const stdout = execSync(lintScript, { cwd: dir, encoding: 'utf8' });
        assert.match(
          stdout,
          /node --check passed for \d+ file\(s\)/,
          'the node --check sweep branch ran (not the biome branch) when no biome config is present',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    'no biome config: a genuine syntax error propagates as a nonzero exit (no silent swallow)',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'overlay-lint-broken-'));
      try {
        // No `export` — this dir has no package.json declaring `type: module`,
        // so a bare "(;\n" is parsed as a CommonJS script and is a genuine
        // syntax error under `node --check`.
        writeFileSync(path.join(dir, 'index.js'), 'const broken = (;\n');
        assert.throws(
          () => execSync(lintScript, { cwd: dir, encoding: 'utf8' }),
          /status|Command failed/,
          'a real parse failure must propagate as a nonzero exit, not be masked',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    'biome config present: takes the biome branch (not the node --check sweep), and a real biome failure propagates',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'overlay-lint-biome-'));
      try {
        writeFileSync(path.join(dir, 'biome.json'), '{}\n');
        // A clean file that WOULD pass the node --check sweep, so a nonzero
        // exit here can only come from the biome branch actually running —
        // proving the ternary polarity picks the biome branch when the config
        // exists (not the sweep) and that a real biome failure is no longer
        // masked by a trailing `|| true`. A fake `biome` binary is installed
        // into a local node_modules/.bin so npx resolves it deterministically,
        // with no dependency on the registry or a real biome install.
        writeFileSync(path.join(dir, 'index.js'), 'const ok = 1;\n');
        mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
        const fakeBiome = path.join(dir, 'node_modules', '.bin', 'biome');
        writeFileSync(fakeBiome, '#!/bin/sh\nexit 7\n');
        execSync(`chmod +x ${JSON.stringify(fakeBiome)}`);
        let caught;
        try {
          execSync(lintScript, { cwd: dir, encoding: 'utf8' });
        } catch (err) {
          caught = err;
        }
        assert.ok(
          caught,
          'the biome branch must run (and its failure must propagate) when a biome config exists',
        );
        assert.equal(
          caught.status,
          7,
          "the fake biome binary's own exit code propagates through, unmasked",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

test('the old Story #57 single-scenario special-case exports are gone', async () => {
  const mod = await import('../../../bench/driver/overlay.js');
  assert.equal('TRAP_SCENARIO_ID' in mod, false);
  assert.equal('TRAP_NODE_CHECK_SWEEP' in mod, false);
});

test('overlay (mandrel): writes the un-stubbed gates into the clone for every scenario', () => {
  const { deps, writes } = fakes();
  overlayFrameworkUnderTest(
    { workspacePath: WS, arm: 'mandrel', sandbox: SANDBOX, sourceRoot: SOURCE },
    deps,
  );
  const pkg = JSON.parse(writes[path.join(WS, 'package.json')]);
  assert.equal(pkg.scripts.test, 'node --test');
  assert.notEqual(pkg.scripts.typecheck, 'node --version');
  assert.match(pkg.scripts.typecheck, /--check/);
});

test('writeGatePackageJson (control): writes the SAME gate package.json directly, with no overlay', () => {
  const { deps, writes } = fakes();
  const res = writeGatePackageJson({ workspacePath: WS }, deps);
  assert.equal(res.workspacePath, WS);
  const pkg = JSON.parse(writes[path.join(WS, 'package.json')]);
  assert.deepEqual(pkg, buildTargetPackageJson());
  assert.equal(res.pkg.scripts.test, 'node --test');
});

test('writeGatePackageJson: rejects a missing workspacePath', () => {
  assert.throws(() => writeGatePackageJson({}), /non-empty workspacePath/);
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

  // Clean minimal package.json written into the clone, carrying the REAL
  // un-stubbed gate scripts so close-validation enforcement genuinely fires.
  const pkg = JSON.parse(writes[path.join(WS, 'package.json')]);
  assert.equal(pkg.name, 'mandrel-bench-target');
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.scripts, buildTargetPackageJson().scripts);

  // .agentrc.json rewritten to the sandbox repo.
  const agentrc = JSON.parse(writes[path.join(WS, '.agentrc.json')]);
  assert.equal(agentrc.github.repo, 'bench-sbx-test-ws');
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
    /must be a known benchmark arm/,
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

// ---------------------------------------------------------------------------
// Ticket #123, arm 3 (control-claudemd): the static generic CLAUDE.md seed.
// ---------------------------------------------------------------------------

test('seedStaticClaudeMd: writes the shared fixture verbatim as <workspace>/CLAUDE.md (injected fs)', () => {
  const writes = [];
  const result = seedStaticClaudeMd(
    { workspacePath: WS },
    {
      fixturePath: '/fixtures/control-claudemd.md',
      readFileFn: (p, enc) => {
        assert.equal(p, '/fixtures/control-claudemd.md');
        assert.equal(enc, 'utf8');
        return '# Project Conventions\ngeneric guidance\n';
      },
      writeFileFn: (p, data) => writes.push({ p, data }),
    },
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].p, path.join(WS, 'CLAUDE.md'));
  assert.equal(writes[0].data, '# Project Conventions\ngeneric guidance\n');
  assert.equal(result.claudeMdPath, path.join(WS, 'CLAUDE.md'));
  assert.equal(
    result.bytes,
    Buffer.byteLength('# Project Conventions\ngeneric guidance\n'),
  );
  assert.throws(() => seedStaticClaudeMd({}), /workspacePath/);
});

test('the committed control-claudemd fixture is generic, ~2KB, and carries conventions + security hygiene with NO scenario answers', () => {
  const content = readFileSync(STATIC_CLAUDEMD_FIXTURE_PATH, 'utf8');
  const bytes = Buffer.byteLength(content);
  // "~2KB": small enough to be a cheap static seed, big enough to be real
  // guidance — never an empty stub and never a scenario-answer dump.
  assert.ok(bytes >= 1024 && bytes <= 4096, `fixture is ${bytes} bytes`);
  // Generic engineering conventions + error handling + testing + security.
  assert.match(content, /conventions/i);
  assert.match(content, /error/i);
  assert.match(content, /test/i);
  assert.match(content, /Never hardcode secrets/i);
  assert.match(content, /password/i);
  assert.match(content, /authorization/i);
  // No scenario-specific answers and no trap answers: the fixture must not
  // name the scenario corpus's concrete surfaces or the trap-class ids.
  for (const banned of [
    /\/auth\/register/,
    /\/auth\/login/,
    /\/projects\b/,
    /\/notes\b/,
    /task management/i,
    /hello-world/i,
    /plaintext-password/,
    /hardcoded-secret/,
    /missing-input-validation/,
    /\bidor\b/i,
  ]) {
    assert.doesNotMatch(content, banned);
  }
});
