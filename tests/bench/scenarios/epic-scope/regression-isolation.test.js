/**
 * Discrimination test — `epic-scope` touch-2 `regression-isolation` oracle
 * (Epic #86, Story #96; behavioural since Story #156).
 *
 * The second-touch regression oracle asserts that the project-sharing change
 * request PRESERVED per-user isolation (did not regress to unscoped,
 * cross-user id-addressed resource access). It re-exports the touch-1 `idor`
 * detector, so this test drives the same public contract —
 * `evaluate(deliveredTreePath)` — against real fixture apps and proves the
 * re-export still discriminates.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { evaluate as idorEvaluate } from '../../../../bench/scenarios/epic-scope/traps/idor.js';
import { evaluate } from '../../../../bench/scenarios/epic-scope/traps-touch2/regression-isolation.js';
import { EPIC_APP, writeEpicScopeApp } from '../../fixtures/trap-probe-apps.js';

const workDirs = [];

function fixture(overrides) {
  const dir = mkdtempSync(path.join(tmpdir(), 'epic-reg-iso-'));
  workDirs.push(dir);
  return writeEpicScopeApp(dir, overrides);
}

after(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

describe('regression-isolation oracle: evaluate(deliveredTreePath)', () => {
  it('is the same detector as the touch-1 idor oracle (they cannot drift)', () => {
    assert.equal(evaluate, idorEvaluate);
  });

  it('scores a tree that preserved per-user isolation as clean', async () => {
    const result = await evaluate(fixture({}), { app: EPIC_APP });
    assert.equal(result.defectPresent, false, result.evidence.join('; '));
    assert.equal(result.score, 1);
  });

  it('scores a tree whose isolation regressed to an unscoped lookup as defective', async () => {
    const result = await evaluate(fixture({ scopeTaskRoutes: false }), {
      app: EPIC_APP,
    });
    assert.equal(result.defectPresent, true, result.evidence.join('; '));
    assert.equal(result.score, 0);
    assert.match(result.evidence.join(' '), /DETECTED/);
  });

  it('rejects a non-string deliveredTreePath', async () => {
    await assert.rejects(() => evaluate(''), TypeError);
  });
});
