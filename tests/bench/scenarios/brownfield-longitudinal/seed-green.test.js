// tests/bench/scenarios/brownfield-longitudinal/seed-green.test.js
/**
 * Seed-green guard for the brownfield-longitudinal Ledgerline seed
 * (issue #124, PR-A).
 *
 * The seed app under `bench/scenarios/brownfield-longitudinal/sandbox/` is
 * FROZEN instrument content: once merged, an edit is by definition a
 * `benchmarkVersion` bump. This repo-CI test keeps the frozen seed honest
 * against environment drift — a Node upgrade (the seed leans on `node:sqlite`
 * and `node:test`) must not silently rot it:
 *
 *   1. The sandbox is copied to a scratch directory (never run in place — a
 *      run must not leave WAL files or `data/` litter inside the tracked
 *      seed) and its own suite is run exactly the way a benchmark cell would
 *      run it (`node --test 'tests/*.test.js'`, the seed package.json `test`
 *      script). The suite must pass green.
 *   2. Every test in the seed suite carries a unique, well-formed
 *      `// @suite-id:` marker — these ids are PR-B's supersession keys, so
 *      the 1:1 test↔id contract is asserted here (TAP-reported test count ==
 *      marker count) before any oracle depends on it.
 *
 * The seed is also deliberately NOT a loadable scenario yet: it ships no
 * `scenario.json`, and `loadScenario` resolves scenarios strictly by reading
 * `bench/scenarios/<id>/scenario.json` — that file arrives with the
 * chain-semantics PRs (PR-B/PR-C). Asserted below so the not-yet-runnable
 * contract is explicit.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'bench',
  'scenarios',
  'brownfield-longitudinal',
);
const SANDBOX_DIR = path.join(SCENARIO_DIR, 'sandbox');
const SUITE_ID_PATTERN = /^[a-z][a-z-]*(\.[a-z][a-z0-9-]*)+\.\d{2}$/;

function collectSuiteIds() {
  const ids = [];
  const testsDir = path.join(SANDBOX_DIR, 'tests');
  const files = readdirSync(testsDir).filter((f) => f.endsWith('.test.js'));
  for (const file of files) {
    const source = readFileSync(path.join(testsDir, file), 'utf8');
    for (const match of source.matchAll(/\/\/ @suite-id: (\S+)/g)) {
      ids.push({ id: match[1], file });
    }
  }
  return ids;
}

test('the seed suite carries unique, well-formed @suite-id markers (PR-B supersession keys)', () => {
  const ids = collectSuiteIds();
  assert.ok(
    ids.length >= 100,
    `expected a ~100-test seed suite, found ${ids.length} @suite-id markers`,
  );
  const seen = new Set();
  for (const { id, file } of ids) {
    assert.match(
      id,
      SUITE_ID_PATTERN,
      `@suite-id "${id}" in ${file} is not a dotted lower-case id ending in a 2-digit sequence`,
    );
    assert.ok(!seen.has(id), `duplicate @suite-id "${id}" (in ${file})`);
    seen.add(id);
  }
});

test('the seed is not yet a loadable scenario — no scenario.json until PR-B/PR-C', () => {
  assert.ok(existsSync(SANDBOX_DIR), 'the sandbox seed layer exists');
  assert.equal(
    existsSync(path.join(SCENARIO_DIR, 'scenario.json')),
    false,
    'scenario.json must not exist yet: loadScenario picks scenarios up strictly via bench/scenarios/<id>/scenario.json',
  );
});

test('the frozen Ledgerline seed boots and its ~100-test suite passes green', () => {
  const ids = collectSuiteIds();
  const scratch = mkdtempSync(path.join(tmpdir(), 'ledgerline-seed-green-'));
  try {
    cpSync(SANDBOX_DIR, scratch, { recursive: true });
    // Strip the outer test-runner context so the child emits plain TAP —
    // inheriting NODE_TEST_CONTEXT would switch its reporter to the
    // parent-runner wire format.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    let stdout;
    try {
      // Run the suite exactly as the seed's own `npm test` does, letting
      // node expand the glob (no shell), from a scratch copy of the seed.
      stdout = execFileSync(
        process.execPath,
        ['--test', '--test-reporter=tap', 'tests/*.test.js'],
        { cwd: scratch, encoding: 'utf8', timeout: 120_000, env },
      );
    } catch (err) {
      assert.fail(
        `seed suite exited non-zero:\n${err.stdout ?? ''}\n${err.stderr ?? ''}`,
      );
    }
    const passCount = Number(stdout.match(/^# pass (\d+)$/m)?.[1]);
    const failCount = Number(stdout.match(/^# fail (\d+)$/m)?.[1]);
    const testCount = Number(stdout.match(/^# tests (\d+)$/m)?.[1]);
    assert.equal(failCount, 0, 'no seed test may fail');
    assert.equal(passCount, testCount, 'every discovered test passes');
    assert.equal(
      testCount,
      ids.length,
      'every seed test carries exactly one @suite-id marker (1:1 contract)',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
