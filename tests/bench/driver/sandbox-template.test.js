// tests/bench/driver/sandbox-template.test.js
/**
 * Unit tests for the sandbox-template materialization path in
 * bench/driver/sandbox.js — Story #71 (self-contained sandbox: ephemeral
 * per-cell repos from an in-repo template).
 *
 * Verifies:
 *   - `materializeSandboxTemplate` copies the baseline template into the
 *     target working tree,
 *   - the optional per-scenario seed layer (`bench/scenarios/<id>/sandbox/`)
 *     is layered on top when present, and skipped cleanly when absent,
 *   - a missing template root is a hard error (never a silent empty sandbox),
 *   - the greenfield gate `package.json` is seeded when the materialized tree
 *     declares none, and NEVER when a seed layer already ships one
 *     (Story #153),
 *   - `defaultSandboxTemplateRoot` / `defaultScenarioSandboxDir` resolve the
 *     conventional in-repo paths.
 *
 * Every filesystem effect is INJECTED — no real copy, no real disk.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  defaultSandboxTemplateRoot,
  defaultScenarioSandboxDir,
  materializeSandboxTemplate,
} from '../../../bench/driver/sandbox.js';

test('materializeSandboxTemplate: copies the baseline template into the target dir', () => {
  const cpCalls = [];
  const mkdirCalls = [];
  const res = materializeSandboxTemplate(
    { templateRoot: '/repo/bench/sandbox-template', targetDir: '/ws/seed' },
    {
      existsFn: (p) => p === '/repo/bench/sandbox-template',
      mkdirFn: (p) => mkdirCalls.push(p),
      cpFn: (src, dest) => cpCalls.push({ src, dest }),
      writeFileFn: () => {},
      logger: { info() {}, warn() {} },
    },
  );

  assert.deepEqual(res, {
    targetDir: '/ws/seed',
    templateRoot: '/repo/bench/sandbox-template',
    scenarioSandboxDir: null,
    gatePackageJsonSeeded: true,
  });
  assert.deepEqual(mkdirCalls, ['/ws/seed']);
  assert.equal(cpCalls.length, 1);
  assert.deepEqual(cpCalls[0], {
    src: '/repo/bench/sandbox-template',
    dest: '/ws/seed',
  });
});

test('materializeSandboxTemplate: layers the per-scenario seed dir on top when present', () => {
  const cpCalls = [];
  const scenarioDir = '/repo/bench/scenarios/hello-world/sandbox';
  const res = materializeSandboxTemplate(
    {
      templateRoot: '/repo/bench/sandbox-template',
      scenarioSandboxDir: scenarioDir,
      targetDir: '/ws/seed',
    },
    {
      existsFn: (p) =>
        p === '/repo/bench/sandbox-template' || p === scenarioDir,
      mkdirFn: () => {},
      cpFn: (src, dest) => cpCalls.push({ src, dest }),
      writeFileFn: () => {},
      logger: { info() {}, warn() {} },
    },
  );

  assert.equal(res.scenarioSandboxDir, scenarioDir);
  // Baseline copied FIRST, scenario layer copied SECOND (so it can override).
  assert.equal(cpCalls.length, 2);
  assert.equal(cpCalls[0].src, '/repo/bench/sandbox-template');
  assert.equal(cpCalls[1].src, scenarioDir);
  assert.equal(cpCalls[1].dest, '/ws/seed');
});

test('materializeSandboxTemplate: a scenario with no seed dir is not an error — layer is skipped', () => {
  const cpCalls = [];
  const scenarioDir = '/repo/bench/scenarios/story-scope/sandbox';
  const res = materializeSandboxTemplate(
    {
      templateRoot: '/repo/bench/sandbox-template',
      scenarioSandboxDir: scenarioDir,
      targetDir: '/ws/seed',
    },
    {
      existsFn: (p) => p === '/repo/bench/sandbox-template', // scenarioDir absent
      mkdirFn: () => {},
      cpFn: (src, dest) => cpCalls.push({ src, dest }),
      writeFileFn: () => {},
      logger: { info() {}, warn() {} },
    },
  );

  assert.equal(res.scenarioSandboxDir, null);
  assert.equal(cpCalls.length, 1);
});

test('materializeSandboxTemplate: a seed layer that ships its own package.json is never clobbered (Story #153)', () => {
  const writes = [];
  const scenarioDir = '/repo/bench/scenarios/brownfield-longitudinal/sandbox';
  const res = materializeSandboxTemplate(
    {
      templateRoot: '/repo/bench/sandbox-template',
      scenarioSandboxDir: scenarioDir,
      targetDir: '/ws/seed',
    },
    {
      // The layered seed left a package.json behind in the target tree.
      existsFn: (p) =>
        p === '/repo/bench/sandbox-template' ||
        p === scenarioDir ||
        p === path.join('/ws/seed', 'package.json'),
      mkdirFn: () => {},
      cpFn: () => {},
      writeFileFn: (p, data) => writes.push({ p, data }),
      logger: { info() {}, warn() {} },
    },
  );

  assert.equal(res.gatePackageJsonSeeded, false);
  assert.deepEqual(writes, []);
});

test('materializeSandboxTemplate: a missing template root is a hard error', () => {
  assert.throws(
    () =>
      materializeSandboxTemplate(
        { templateRoot: '/nope', targetDir: '/ws/seed' },
        { existsFn: () => false, mkdirFn: () => {}, cpFn: () => {} },
      ),
    /template root does not exist/,
  );
});

test('materializeSandboxTemplate: requires templateRoot and targetDir', () => {
  assert.throws(
    () => materializeSandboxTemplate({ targetDir: '/ws' }, {}),
    /requires templateRoot/,
  );
  assert.throws(
    () => materializeSandboxTemplate({ templateRoot: '/t' }, {}),
    /requires targetDir/,
  );
});

test('defaultSandboxTemplateRoot: resolves to bench/sandbox-template beside bench/driver', () => {
  const root = defaultSandboxTemplateRoot();
  assert.equal(path.basename(root), 'sandbox-template');
  assert.equal(path.basename(path.dirname(root)), 'bench');
});

test('defaultScenarioSandboxDir: resolves to bench/scenarios/<id>/sandbox', () => {
  const dir = defaultScenarioSandboxDir('hello-world');
  assert.match(
    dir,
    new RegExp(`${path.sep}scenarios${path.sep}hello-world${path.sep}sandbox$`),
  );
});
