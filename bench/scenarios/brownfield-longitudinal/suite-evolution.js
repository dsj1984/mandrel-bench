/**
 * suite-evolution.js — frozen-oracle suite evolution for the
 * `brownfield-longitudinal` rung (issue #124, PR-B; design §4).
 *
 * The Ledgerline seed's behavioural suite exists TWICE:
 *
 *   - `sandbox/tests/` — the in-sandbox copy overlaid into every cell's
 *     workspace. Agents may (legitimately) edit it as behaviour evolves
 *     across the touch chain.
 *   - `frozen-suite/` — this directory's byte-for-byte mirror of the seed's
 *     `tests/` (helpers included). It is NEVER overlaid into a sandbox;
 *     scoring always runs THIS copy against a delivered tree, so an agent
 *     editing (or deleting) its in-sandbox suite cannot move its own score.
 *
 * A verbatim mirror was chosen over a shared single copy deliberately: the
 * seed and its oracle are frozen TOGETHER (any edit to either is a
 * `benchmarkVersion` bump by policy), and the mirror-fidelity unit test
 * (`tests/bench/scenarios/brownfield-longitudinal/suite-evolution.test.js`)
 * pins byte equality, so the duplication cannot drift. Sharing one physical
 * copy would force the sandbox overlay and the scoring path to reach into
 * each other's trees — a coupling with no upside for two files frozen in
 * lock-step.
 *
 * **Suite evolution.** Each touch `k` under `touches/<k>/` carries:
 *
 *   - `prompt.md`        — the change-request text (PR-C wires it into
 *                          scenario.json; kept a plain artifact here),
 *   - `acceptance.test.js` — frozen behavioural ADDITIONS for that touch
 *                          (HTTP probes, node:test, same helpers as the
 *                          base suite; each test carries `// @suite-id:`),
 *   - `supersedes.json`  — base `@suite-id`s the touch's LEGITIMATE
 *                          behaviour change retires.
 *
 * The effective suite at touch `k` is
 *
 *     (base − ∪ supersedes(1..k)) ∪ additions(1..k)
 *
 * keyed on `@suite-id`s. `runEvolvedSuite` materialises the delivered tree
 * into a scratch directory (mirroring the seed-green guard: never run in
 * place — a run must not litter the delivered tree with WAL files or
 * `data/`), replaces its `tests/` with the frozen mirror plus the
 * accumulated touch additions, and runs `node --test` exactly the way the
 * seed's own `npm test` does. Superseded base tests still EXECUTE but are
 * excluded from the verdict arithmetic — their pass/fail is ignored and
 * they are reported as `status: 'superseded'`. (Filtering them out of
 * discovery with `--test-skip-pattern` was tried and rejected: a file
 * whose tests are all skipped still runs its `before` hook, boots the
 * seed's server child, and then never tears it down, hanging the run —
 * running the handful of retired probes is cheap and side-effect-free by
 * comparison.) TAP verdicts are keyed back to `@suite-id`s via test
 * names, which is why the integrity tests pin GLOBAL test-name
 * uniqueness across the base suite and every touch's additions.
 *
 * **Regression rate** = failures among RETAINED base tests ÷ retained
 * count. A retained test that never reports (a crashed file, a failed
 * `before` hook that cancels its subtests, a deleted route hanging the
 * boot) is counted as a failure — a conservative rule, surfaced separately
 * in `base.missing` so a scorecard reader can tell "failed" from "never
 * ran".
 *
 * @module bench/scenarios/brownfield-longitudinal/suite-evolution
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCENARIO_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Where the frozen base-suite mirror lives (relative to the scenario). */
export const FROZEN_SUITE_DIR = path.join(SCENARIO_DIR, 'frozen-suite');

/** Where the per-touch artifacts live (relative to the scenario). */
export const TOUCHES_DIR = path.join(SCENARIO_DIR, 'touches');

/** The declared touch chain length (design §2: touches 1..5). */
export const TOUCH_COUNT = 5;

const SUITE_ID_MARKER_RE =
  /\/\/ @suite-id: (\S+)[^\n]*\n\s*test\(\s*(['"])((?:\\.|(?!\2).)*)\2/g;
const SUITE_TIMEOUT_MS = 300_000;

/**
 * Parse `// @suite-id:` markers out of one test-file source, pairing each
 * marker with the title of the `test('…')` registration that follows it —
 * the name is what TAP reports, so it keys verdicts back to ids.
 *
 * @param {string} source — test-file text.
 * @param {string} file — file name, threaded into the result for evidence.
 * @returns {Array<{ id: string, name: string, file: string }>}
 */
export function parseSuiteIds(source, file) {
  const entries = [];
  SUITE_ID_MARKER_RE.lastIndex = 0;
  for (const match of source.matchAll(SUITE_ID_MARKER_RE)) {
    entries.push({ id: match[1], name: match[3], file });
  }
  return entries;
}

/**
 * Collect the `@suite-id` → test-name inventory of every `*.test.js`
 * directly under `dir` (helpers are not test files and carry no markers).
 *
 * @param {string} dir — absolute path to a suite directory.
 * @param {Pick<typeof fs, 'readdirSync'|'readFileSync'>} [fsImpl]
 * @returns {Array<{ id: string, name: string, file: string }>}
 */
export function collectSuiteInventory(dir, fsImpl = fs) {
  const inventory = [];
  const files = fsImpl
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .sort();
  for (const file of files) {
    const source = fsImpl.readFileSync(path.join(dir, file), 'utf8');
    inventory.push(...parseSuiteIds(source, file));
  }
  return inventory;
}

/**
 * Load the touch manifest: for touches 1..touchIndex, the parsed
 * `supersedes.json` list and the acceptance-suite inventory.
 *
 * @param {number} touchIndex — how many touches to load (0..TOUCH_COUNT).
 * @param {object} [options]
 * @param {string} [options.touchesDir] — override for tests.
 * @param {Pick<typeof fs, 'readdirSync'|'readFileSync'>} [options.fsImpl]
 * @returns {Array<{
 *   index: number,
 *   supersedes: string[],
 *   acceptancePath: string,
 *   additions: Array<{ id: string, name: string, file: string }>,
 * }>}
 */
export function loadTouches(touchIndex, options = {}) {
  const touchesDir = options.touchesDir ?? TOUCHES_DIR;
  const fsImpl = options.fsImpl ?? fs;
  if (
    !Number.isInteger(touchIndex) ||
    touchIndex < 0 ||
    touchIndex > TOUCH_COUNT
  ) {
    throw new RangeError(
      `touchIndex must be an integer in 0..${TOUCH_COUNT}, got ${touchIndex}`,
    );
  }
  const touches = [];
  for (let k = 1; k <= touchIndex; k += 1) {
    const dir = path.join(touchesDir, String(k));
    const supersedes = JSON.parse(
      fsImpl.readFileSync(path.join(dir, 'supersedes.json'), 'utf8'),
    );
    if (
      !Array.isArray(supersedes) ||
      supersedes.some((s) => typeof s !== 'string')
    ) {
      throw new TypeError(
        `touches/${k}/supersedes.json must be an array of @suite-ids`,
      );
    }
    const acceptancePath = path.join(dir, 'acceptance.test.js');
    const additions = parseSuiteIds(
      fsImpl.readFileSync(acceptancePath, 'utf8'),
      `touch${k}-acceptance.test.js`,
    ).map((entry) => ({ ...entry, touch: k }));
    touches.push({ index: k, supersedes, acceptancePath, additions });
  }
  return touches;
}

/**
 * Pure evolution arithmetic: effective suite at touch `k`.
 *
 * @param {object} args
 * @param {Array<{ id: string, name: string, file: string }>} args.baseInventory
 * @param {ReturnType<typeof loadTouches>} args.touches — touches 1..k.
 * @returns {{
 *   retained: Array<{ id: string, name: string, file: string }>,
 *   supersededIds: string[],
 *   additions: Array<{ id: string, name: string, file: string, touch: number }>,
 * }}
 */
export function computeEffectiveSuite({ baseInventory, touches }) {
  const supersededIds = new Set();
  const additions = [];
  for (const touch of touches) {
    for (const id of touch.supersedes) supersededIds.add(id);
    additions.push(...touch.additions);
  }
  for (const id of supersededIds) {
    if (!baseInventory.some((entry) => entry.id === id)) {
      throw new Error(
        `supersedes lists unknown base @suite-id "${id}" — not in the frozen inventory`,
      );
    }
  }
  const retained = baseInventory.filter(
    (entry) => !supersededIds.has(entry.id),
  );
  return { retained, supersededIds: [...supersededIds].sort(), additions };
}

/**
 * Parse Node's flat TAP output (`--test-reporter=tap`) into per-test
 * verdicts plus the trailing summary counters.
 *
 * @param {string} tap — raw TAP text.
 * @returns {{
 *   tests: Array<{ name: string, pass: boolean }>,
 *   summary: { tests: number|null, pass: number|null, fail: number|null },
 * }}
 */
export function parseTap(tap) {
  const tests = [];
  const lines = String(tap).split('\n');
  for (const line of lines) {
    const match = line.match(
      /^(not )?ok \d+ - (.*?)(?: # (?:SKIP|TODO)\S*.*)?$/,
    );
    if (match) tests.push({ name: match[2], pass: match[1] === undefined });
  }
  const counter = (label) => {
    const m = String(tap).match(new RegExp(`^# ${label} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  return {
    tests,
    summary: {
      tests: counter('tests'),
      pass: counter('pass'),
      fail: counter('fail'),
    },
  };
}

/**
 * Compare the delivered tree's in-sandbox suite against the frozen mirror —
 * purely informational drift/tamper evidence (agents MAY legitimately edit
 * their in-sandbox tests when behaviour legitimately changes; scoring never
 * runs that copy either way).
 *
 * @param {string} deliveredTestsDir — absolute path to `<delivered>/tests`.
 * @param {string} frozenDir — absolute path to the frozen mirror.
 * @param {Pick<typeof fs, 'readdirSync'|'readFileSync'|'existsSync'>} fsImpl
 * @returns {{ missing: string[], modified: string[] }}
 */
function diffDeliveredSuite(deliveredTestsDir, frozenDir, fsImpl) {
  const missing = [];
  const modified = [];
  const frozenFiles = fsImpl
    .readdirSync(frozenDir)
    .filter((f) => f.endsWith('.test.js'))
    .sort();
  for (const file of frozenFiles) {
    const deliveredPath = path.join(deliveredTestsDir, file);
    if (!fsImpl.existsSync(deliveredPath)) {
      missing.push(file);
      continue;
    }
    const frozenText = fsImpl.readFileSync(path.join(frozenDir, file), 'utf8');
    const deliveredText = fsImpl.readFileSync(deliveredPath, 'utf8');
    if (frozenText !== deliveredText) modified.push(file);
  }
  return { missing, modified };
}

/**
 * Run the evolved frozen suite for touch `touchIndex` against a delivered
 * tree, in a scratch sibling (the delivered tree itself is never executed
 * in place).
 *
 * @param {object} args
 * @param {string} args.deliveredTreePath — absolute path to the delivered
 *   Ledgerline tree (the chain baseline after materialisation).
 * @param {number} args.touchIndex — 0..TOUCH_COUNT; 0 = pristine base suite.
 * @param {object} [args.ports]
 * @param {string} [args.ports.frozenSuiteDir] — override for tests.
 * @param {string} [args.ports.touchesDir] — override for tests.
 * @param {typeof execFileSync} [args.ports.execFileSyncImpl] — override for
 *   tests (canned TAP without booting a real server).
 * @param {typeof fs} [args.ports.fsImpl]
 * @returns {{
 *   touchIndex: number,
 *   base: {
 *     total: number,
 *     retainedTotal: number,
 *     retainedPassed: number,
 *     retainedFailed: string[],
 *     missing: string[],
 *     supersededIds: string[],
 *     regressionRate: number,
 *   },
 *   additions: {
 *     total: number,
 *     passed: number,
 *     failed: string[],
 *     missing: string[],
 *     byTouch: Record<string, { total: number, passed: number }>,
 *   },
 *   results: Array<{
 *     id: string, name: string, file: string,
 *     touch: number|null,
 *     status: 'pass'|'fail'|'superseded'|'missing',
 *   }>,
 *   sandboxSuiteDrift: { missing: string[], modified: string[] },
 * }}
 */
export function runEvolvedSuite({ deliveredTreePath, touchIndex, ports = {} }) {
  if (typeof deliveredTreePath !== 'string' || deliveredTreePath.length === 0) {
    throw new TypeError(
      'runEvolvedSuite: deliveredTreePath must be a non-empty string',
    );
  }
  const fsImpl = ports.fsImpl ?? fs;
  const execImpl = ports.execFileSyncImpl ?? execFileSync;
  const frozenSuiteDir = ports.frozenSuiteDir ?? FROZEN_SUITE_DIR;
  const touchesDir = ports.touchesDir ?? TOUCHES_DIR;

  const baseInventory = collectSuiteInventory(frozenSuiteDir, fsImpl);
  const touches = loadTouches(touchIndex, { touchesDir, fsImpl });
  const { retained, supersededIds, additions } = computeEffectiveSuite({
    baseInventory,
    touches,
  });

  const scratch = fsImpl.mkdtempSync(
    path.join(tmpdir(), 'ledgerline-evolved-suite-'),
  );
  let tap = '';
  let sandboxSuiteDrift = { missing: [], modified: [] };
  try {
    fsImpl.cpSync(deliveredTreePath, scratch, { recursive: true });
    const deliveredTestsDir = path.join(scratch, 'tests');
    if (fsImpl.existsSync(deliveredTestsDir)) {
      sandboxSuiteDrift = diffDeliveredSuite(
        deliveredTestsDir,
        frozenSuiteDir,
        fsImpl,
      );
      fsImpl.rmSync(deliveredTestsDir, { recursive: true, force: true });
    } else {
      sandboxSuiteDrift = {
        missing: baseInventory
          .map((entry) => entry.file)
          .filter((file, i, all) => all.indexOf(file) === i),
        modified: [],
      };
    }
    fsImpl.cpSync(frozenSuiteDir, deliveredTestsDir, { recursive: true });
    for (const touch of touches) {
      fsImpl.cpSync(
        touch.acceptancePath,
        path.join(deliveredTestsDir, `touch${touch.index}-acceptance.test.js`),
      );
    }

    // Strip the outer test-runner context (same env hygiene as the
    // seed-green guard) so the child emits plain TAP.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;

    const nodeArgs = ['--test', '--test-reporter=tap', 'tests/*.test.js'];

    try {
      tap = execImpl(process.execPath, nodeArgs, {
        cwd: scratch,
        encoding: 'utf8',
        timeout: SUITE_TIMEOUT_MS,
        env,
      });
    } catch (err) {
      // Test failures exit non-zero; the TAP on stdout is still the verdict.
      tap = `${err?.stdout ?? ''}`;
      if (tap.trim().length === 0) {
        throw new Error(
          `evolved suite produced no TAP output: ${err?.message ?? err}\n${err?.stderr ?? ''}`,
        );
      }
    }
  } finally {
    fsImpl.rmSync(scratch, { recursive: true, force: true });
  }

  const { tests } = parseTap(tap);
  const verdictByName = new Map(tests.map((t) => [t.name, t.pass]));

  const results = [];
  const retainedFailed = [];
  const baseMissing = [];
  let retainedPassed = 0;
  for (const entry of baseInventory) {
    if (supersededIds.includes(entry.id)) {
      results.push({ ...entry, touch: null, status: 'superseded' });
      continue;
    }
    const pass = verdictByName.get(entry.name);
    if (pass === true) {
      retainedPassed += 1;
      results.push({ ...entry, touch: null, status: 'pass' });
    } else if (pass === false) {
      retainedFailed.push(entry.id);
      results.push({ ...entry, touch: null, status: 'fail' });
    } else {
      baseMissing.push(entry.id);
      results.push({ ...entry, touch: null, status: 'missing' });
    }
  }

  const additionsFailed = [];
  const additionsMissing = [];
  const byTouch = {};
  let additionsPassed = 0;
  for (const entry of additions) {
    if (byTouch[entry.touch] === undefined) {
      byTouch[entry.touch] = { total: 0, passed: 0 };
    }
    const bucket = byTouch[entry.touch];
    bucket.total += 1;
    const pass = verdictByName.get(entry.name);
    if (pass === true) {
      additionsPassed += 1;
      bucket.passed += 1;
      results.push({ ...entry, status: 'pass' });
    } else if (pass === false) {
      additionsFailed.push(entry.id);
      results.push({ ...entry, status: 'fail' });
    } else {
      additionsMissing.push(entry.id);
      results.push({ ...entry, status: 'missing' });
    }
  }

  const retainedTotal = retained.length;
  // Conservative rule: a retained test that never reported counts as failed.
  const regressionRate =
    retainedTotal === 0
      ? 0
      : (retainedFailed.length + baseMissing.length) / retainedTotal;

  return {
    touchIndex,
    base: {
      total: baseInventory.length,
      retainedTotal,
      retainedPassed,
      retainedFailed,
      missing: baseMissing,
      supersededIds,
      regressionRate,
    },
    additions: {
      total: additions.length,
      passed: additionsPassed,
      failed: additionsFailed,
      missing: additionsMissing,
      byTouch,
    },
    results,
    sandboxSuiteDrift,
  };
}
