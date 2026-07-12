// tests/bench/scenarios/brownfield-longitudinal/suite-evolution.test.js
/**
 * Unit + integrity tests for the brownfield-longitudinal frozen oracles
 * (issue #124, PR-B): the frozen-suite mirror's fidelity to the seed, the
 * supersede-ID integrity contract (a typo'd id in any
 * `touches/<k>/supersedes.json` fails CI here), the touch-artifact
 * contracts (prompts present and convention-blind, addition ids
 * well-formed and disjoint from the base inventory, test names globally
 * unique — the TAP name→id keying), and the pure evolution
 * arithmetic + TAP parsing of `suite-evolution.js`.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  collectSuiteInventory,
  computeEffectiveSuite,
  FROZEN_SUITE_DIR,
  loadTouches,
  parseSuiteIds,
  parseTap,
  TOUCH_COUNT,
  TOUCHES_DIR,
} from '../../../../bench/scenarios/brownfield-longitudinal/suite-evolution.js';

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
const SANDBOX_TESTS_DIR = path.join(SCENARIO_DIR, 'sandbox', 'tests');

// Same shape contract the seed-green guard pins for the sandbox suite.
const SUITE_ID_PATTERN = /^[a-z][a-z-]*(\.[a-z][a-z0-9-]*)+\.\d{2}$/;

function listFilesRecursive(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(path.join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

describe('frozen-suite mirror fidelity', () => {
  it('mirrors the sandbox suite file-for-file', () => {
    const frozen = listFilesRecursive(FROZEN_SUITE_DIR);
    const sandbox = listFilesRecursive(SANDBOX_TESTS_DIR);
    assert.deepEqual(frozen, sandbox);
    assert.ok(frozen.length > 0, 'the mirror is not empty');
  });

  it('every mirrored file is byte-identical to the seed copy', () => {
    for (const rel of listFilesRecursive(FROZEN_SUITE_DIR)) {
      const frozen = readFileSync(path.join(FROZEN_SUITE_DIR, rel), 'utf8');
      const seed = readFileSync(path.join(SANDBOX_TESTS_DIR, rel), 'utf8');
      assert.equal(
        frozen,
        seed,
        `frozen-suite/${rel} drifted from sandbox/tests/${rel} — the mirror and the seed are frozen together`,
      );
    }
  });
});

describe('frozen base inventory', () => {
  const inventory = collectSuiteInventory(FROZEN_SUITE_DIR);

  it('pairs every @suite-id marker with a test name (the 1:1 contract)', () => {
    assert.ok(
      inventory.length >= 100,
      `expected the ~100-test seed inventory, found ${inventory.length}`,
    );
    for (const entry of inventory) {
      assert.match(entry.id, SUITE_ID_PATTERN, `malformed id ${entry.id}`);
      assert.ok(entry.name.length > 0, `id ${entry.id} has an empty test name`);
    }
  });

  it('ids and test names are unique across the whole base suite', () => {
    const ids = new Set();
    const names = new Set();
    for (const entry of inventory) {
      assert.ok(!ids.has(entry.id), `duplicate base @suite-id ${entry.id}`);
      assert.ok(
        !names.has(entry.name),
        `duplicate base test name "${entry.name}" — TAP verdicts are keyed back to ids via names`,
      );
      ids.add(entry.id);
      names.add(entry.name);
    }
  });
});

describe('touch artifacts (touches/1..5)', () => {
  const inventory = collectSuiteInventory(FROZEN_SUITE_DIR);
  const baseIds = new Set(inventory.map((entry) => entry.id));
  const touches = loadTouches(TOUCH_COUNT);

  it('exactly the declared touch directories exist', () => {
    const dirs = readdirSync(TOUCHES_DIR).sort();
    assert.deepEqual(
      dirs,
      Array.from({ length: TOUCH_COUNT }, (_, i) => String(i + 1)),
    );
  });

  for (let k = 1; k <= TOUCH_COUNT; k += 1) {
    it(`touch ${k} ships a real, convention-blind prompt`, () => {
      const prompt = readFileSync(
        path.join(TOUCHES_DIR, String(k), 'prompt.md'),
        'utf8',
      );
      assert.ok(
        prompt.trim().length >= 120,
        'the prompt is a real change-request text',
      );
      // The prompts never point at the conventions doc or at the planted
      // landmines — adherence must measure reading-the-repo (design §2/§8).
      for (const leak of [
        /convention/i,
        /landmine/i,
        /\btrap\b/i,
        /CONVENTIONS\.md/,
      ]) {
        assert.ok(
          !leak.test(prompt),
          `touch ${k} prompt leaks instrument vocabulary (${leak})`,
        );
      }
    });
  }

  it('every superseded id exists in the frozen base inventory (typo gate)', () => {
    for (const touch of touches) {
      for (const id of touch.supersedes) {
        assert.ok(
          baseIds.has(id),
          `touches/${touch.index}/supersedes.json lists unknown base id "${id}"`,
        );
      }
    }
  });

  it('supersede lists are duplicate-free within and across touches', () => {
    const seen = new Map();
    for (const touch of touches) {
      const inFile = new Set();
      for (const id of touch.supersedes) {
        assert.ok(
          !inFile.has(id),
          `touches/${touch.index}/supersedes.json repeats "${id}"`,
        );
        inFile.add(id);
        assert.ok(
          !seen.has(id),
          `"${id}" superseded by both touch ${seen.get(id)} and touch ${touch.index}`,
        );
        seen.set(id, touch.index);
      }
    }
  });

  it('addition ids are well-formed, unique, and disjoint from the base suite', () => {
    const seen = new Set();
    for (const touch of touches) {
      assert.ok(
        touch.additions.length > 0,
        `touch ${touch.index} declares no frozen behavioural additions`,
      );
      for (const entry of touch.additions) {
        assert.match(
          entry.id,
          SUITE_ID_PATTERN,
          `malformed addition id ${entry.id}`,
        );
        assert.ok(
          !baseIds.has(entry.id),
          `addition id ${entry.id} collides with the base suite`,
        );
        assert.ok(!seen.has(entry.id), `addition id ${entry.id} appears twice`);
        seen.add(entry.id);
      }
    }
  });

  it('test names stay globally unique across base + all additions (TAP keying)', () => {
    const names = new Set(inventory.map((entry) => entry.name));
    for (const touch of touches) {
      for (const entry of touch.additions) {
        assert.ok(
          !names.has(entry.name),
          `test name "${entry.name}" (touch ${touch.index}) collides — TAP verdicts are keyed back to ids via names`,
        );
        names.add(entry.name);
      }
    }
  });
});

describe('computeEffectiveSuite', () => {
  const inventory = collectSuiteInventory(FROZEN_SUITE_DIR);

  it('applies the union of supersedes and accumulates additions', () => {
    const touches = loadTouches(TOUCH_COUNT);
    const supersededCount = touches.reduce(
      (n, t) => n + t.supersedes.length,
      0,
    );
    const additionsCount = touches.reduce((n, t) => n + t.additions.length, 0);
    const { retained, supersededIds, additions } = computeEffectiveSuite({
      baseInventory: inventory,
      touches,
    });
    assert.equal(supersededIds.length, supersededCount);
    assert.equal(retained.length, inventory.length - supersededCount);
    assert.equal(additions.length, additionsCount);
    for (const id of supersededIds) {
      assert.ok(!retained.some((entry) => entry.id === id));
    }
  });

  it('at touch 0 the effective suite is the pristine base', () => {
    const { retained, supersededIds, additions } = computeEffectiveSuite({
      baseInventory: inventory,
      touches: loadTouches(0),
    });
    assert.equal(retained.length, inventory.length);
    assert.deepEqual(supersededIds, []);
    assert.deepEqual(additions, []);
  });

  it('rejects a supersede id that is not in the frozen inventory', () => {
    assert.throws(
      () =>
        computeEffectiveSuite({
          baseInventory: inventory,
          touches: [
            {
              index: 1,
              supersedes: ['customers.create.99'],
              acceptancePath: 'unused',
              additions: [],
            },
          ],
        }),
      /unknown base @suite-id "customers\.create\.99"/,
    );
  });
});

describe('loadTouches bounds', () => {
  it('rejects a touch index outside 0..TOUCH_COUNT', () => {
    assert.throws(() => loadTouches(-1), RangeError);
    assert.throws(() => loadTouches(TOUCH_COUNT + 1), RangeError);
    assert.throws(() => loadTouches(1.5), RangeError);
  });
});

describe('parseSuiteIds', () => {
  it('pairs each marker with the following test title', () => {
    const source = [
      '// @suite-id: sample.alpha.01',
      "test('does the first thing', async () => {});",
      '',
      '// @suite-id: sample.beta.02',
      'test("handles \\"quoted\\" names", () => {});',
    ].join('\n');
    const entries = parseSuiteIds(source, 'sample.test.js');
    assert.deepEqual(entries, [
      {
        id: 'sample.alpha.01',
        name: 'does the first thing',
        file: 'sample.test.js',
      },
      {
        id: 'sample.beta.02',
        name: 'handles \\"quoted\\" names',
        file: 'sample.test.js',
      },
    ]);
  });
});

describe('parseTap', () => {
  it('extracts flat ok / not ok verdicts and the summary counters', () => {
    const tap = [
      'TAP version 13',
      'ok 1 - first passes',
      'not ok 2 - second fails',
      'ok 3 - third is todo # TODO later',
      '1..3',
      '# tests 3',
      '# suites 0',
      '# pass 2',
      '# fail 1',
    ].join('\n');
    const { tests, summary } = parseTap(tap);
    assert.deepEqual(tests, [
      { name: 'first passes', pass: true },
      { name: 'second fails', pass: false },
      { name: 'third is todo', pass: true },
    ]);
    assert.deepEqual(summary, { tests: 3, pass: 2, fail: 1 });
  });
});
