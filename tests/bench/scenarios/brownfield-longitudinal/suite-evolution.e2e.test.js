// tests/bench/scenarios/brownfield-longitudinal/suite-evolution.e2e.test.js
/**
 * End-to-end guard for the evolved frozen suite (issue #124, PR-B): runs
 * `runEvolvedSuite` for real against the frozen Ledgerline SEED as the
 * "delivered tree" (the runner copies it to a scratch dir; the tracked
 * seed is never executed in place).
 *
 *   - At touch 0 the pristine base suite must be green: regression rate 0,
 *     nothing superseded, nothing missing.
 *   - At touch 5 (full chain) every retained base test still passes on the
 *     seed (the supersede lists retire exactly the tests a legitimate
 *     touch breaks — the seed itself regresses nothing), the superseded
 *     tests are excluded from the verdict arithmetic, and EVERY touch acceptance file
 *     parses and runs: each addition reports pass or fail, never
 *     "missing". The additions probe not-yet-built behaviour, so on the
 *     seed they fail — that is the expected shape, and it is exactly what
 *     proves a typo'd import or a crashed acceptance file cannot slip
 *     through CI.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadTouches,
  runEvolvedSuite,
  TOUCH_COUNT,
} from '../../../../bench/scenarios/brownfield-longitudinal/suite-evolution.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'bench',
  'scenarios',
  'brownfield-longitudinal',
  'sandbox',
);

describe('runEvolvedSuite against the frozen seed', () => {
  it('touch 0: the pristine base suite is green with regression rate 0', () => {
    const report = runEvolvedSuite({
      deliveredTreePath: SANDBOX_DIR,
      touchIndex: 0,
    });
    assert.equal(report.touchIndex, 0);
    assert.equal(report.base.retainedTotal, report.base.total);
    assert.equal(report.base.retainedPassed, report.base.total);
    assert.deepEqual(report.base.retainedFailed, []);
    assert.deepEqual(report.base.missing, []);
    assert.deepEqual(report.base.supersededIds, []);
    assert.equal(report.base.regressionRate, 0);
    assert.equal(report.additions.total, 0);
    // The seed's in-tree suite IS the mirror — no drift against itself.
    assert.deepEqual(report.sandboxSuiteDrift, { missing: [], modified: [] });
  });

  it('touch 5: retained base green, superseded excluded from the verdict, every addition runs', () => {
    const touches = loadTouches(TOUCH_COUNT);
    const supersededCount = touches.reduce(
      (n, t) => n + t.supersedes.length,
      0,
    );
    const additionsCount = touches.reduce((n, t) => n + t.additions.length, 0);

    const report = runEvolvedSuite({
      deliveredTreePath: SANDBOX_DIR,
      touchIndex: TOUCH_COUNT,
    });

    // Retained base tests still pass on the seed: the supersede lists must
    // retire ONLY tests whose behaviour a touch legitimately changes — the
    // untouched seed regresses nothing.
    assert.equal(
      report.base.retainedTotal,
      report.base.total - supersededCount,
    );
    assert.deepEqual(report.base.retainedFailed, []);
    assert.deepEqual(report.base.missing, []);
    assert.equal(report.base.regressionRate, 0);
    assert.equal(report.base.supersededIds.length, supersededCount);
    for (const entry of report.results) {
      if (report.base.supersededIds.includes(entry.id)) {
        assert.equal(entry.status, 'superseded');
      }
    }

    // Every touch acceptance file parsed and ran: each addition reports a
    // real verdict. On the seed (features not built yet) they fail — but a
    // load error / typo'd helper import would surface as "missing" here.
    assert.equal(report.additions.total, additionsCount);
    assert.deepEqual(
      report.additions.missing,
      [],
      'every frozen addition must execute against the stub tree',
    );
    assert.equal(
      report.additions.passed + report.additions.failed.length,
      additionsCount,
    );
    for (const touch of touches) {
      assert.equal(
        report.additions.byTouch[touch.index].total,
        touch.additions.length,
        `touch ${touch.index} additions all keyed into the report`,
      );
    }
  });
});
