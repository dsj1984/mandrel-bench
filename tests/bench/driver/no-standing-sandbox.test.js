// tests/bench/driver/no-standing-sandbox.test.js
/**
 * Regression guard for Story #73 (Epic #65 — retire the standing
 * `mandrel-bench-sandbox` repo).
 *
 * Asserts that no `bench/driver/*.js` module reads the retired standing-repo
 * env vars (`BENCH_SANDBOX_REPO_URL`, `BENCH_SANDBOX_REPO`,
 * `BENCH_SANDBOX_BASELINE_REF`) to configure provisioning. The ephemeral
 * per-cell lifecycle (Story #71) collapsed sandbox auth/config to
 * `BENCH_GITHUB_TOKEN` + `BENCH_SANDBOX_OWNER`; any driver module still
 * reading a retired var would mean the standing-repo path silently lives on.
 *
 * The ONE permitted exception is `bench/run.js`'s deprecation-warning shim
 * (`RETIRED_SANDBOX_ENV_VARS` / `retiredSandboxEnvWarnings`), which reads the
 * retired var *names* solely to warn an operator who is still configured for
 * the old path — never to configure provisioning. `bench/run.js` lives at
 * the orchestrator layer, not under `bench/driver/`, and is explicitly out
 * of this guard's scope for that reason.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const DRIVER_DIR = path.join(REPO_ROOT, 'bench', 'driver');

const RETIRED_ENV_VAR_NAMES = [
  'BENCH_SANDBOX_REPO_URL',
  'BENCH_SANDBOX_REPO',
  'BENCH_SANDBOX_BASELINE_REF',
];

function listJsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => path.join(dir, e.name));
}

test('no bench/driver/*.js module reads a retired standing-repo env var', () => {
  const driverFiles = listJsFiles(DRIVER_DIR);
  assert.ok(
    driverFiles.length > 0,
    'expected to find driver modules under bench/driver/',
  );

  const offenders = [];
  for (const file of driverFiles) {
    const src = readFileSync(file, 'utf8');
    for (const name of RETIRED_ENV_VAR_NAMES) {
      // BENCH_SANDBOX_REPO is a prefix of BENCH_SANDBOX_REPO_URL, so match on
      // a non-word boundary to avoid a false positive there while still
      // catching a bare `BENCH_SANDBOX_REPO` reference.
      const re = new RegExp(`\\b${name}\\b(?!_URL)`);
      if (re.test(src)) {
        offenders.push(`${path.relative(REPO_ROOT, file)} references ${name}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `retired standing-repo env var(s) still consumed by driver module(s):\n${offenders.join('\n')}`,
  );
});

test('the retired-env-var names are still known to the run.js deprecation shim (sanity check, not a regression on THIS test)', async () => {
  // Guards against the fixture list above silently drifting from the actual
  // shim in bench/run.js — if a var is renamed there without updating this
  // test, this catches it.
  const { RETIRED_SANDBOX_ENV_VARS } = await import('../../../bench/run.js');
  assert.deepEqual(
    Object.keys(RETIRED_SANDBOX_ENV_VARS).sort(),
    [...RETIRED_ENV_VAR_NAMES].sort(),
  );
});
