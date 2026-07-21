/**
 * Discrimination test — `epic-scope` scenario's `cascade-delete` BEHAVIOURAL
 * trap-oracle (Story #156).
 *
 * A tree that deletes the project row and leaves its task rows behind — where
 * an unscoped id lookup finds them again through a different project's route —
 * must fail; a tree that genuinely cascades must pass; an unbootable tree must
 * report `null`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  evaluate,
  taskItemsOf,
} from '../../../../bench/scenarios/epic-scope/traps/cascade-delete.js';
import {
  EPIC_APP,
  writeEpicScopeApp,
  writeUnbootableApp,
} from '../../fixtures/trap-probe-apps.js';

const workDirs = [];

function fixture(overrides) {
  const dir = mkdtempSync(path.join(tmpdir(), 'epic-cascade-'));
  workDirs.push(dir);
  return writeEpicScopeApp(dir, overrides);
}

after(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

describe('taskItemsOf', () => {
  it('accepts both the paged envelope and a bare array, and rejects anything else', () => {
    assert.deepEqual(taskItemsOf({ items: [1] }), [1]);
    assert.deepEqual(taskItemsOf([2]), [2]);
    assert.equal(taskItemsOf({ total: 0 }), null);
    assert.equal(taskItemsOf(null), null);
  });
});

describe('cascade-delete trap-oracle: evaluate(deliveredTreePath)', () => {
  it('FAILS a tree that orphans a deleted project’s tasks and still resolves them', async () => {
    const dir = fixture({ cascade: false, scopeTaskRoutes: false });
    const result = await evaluate(dir, { app: EPIC_APP });
    assert.equal(result.measured, true, result.evidence.join('; '));
    assert.equal(result.defectPresent, true, result.evidence.join('; '));
    assert.equal(result.score, 0);
    assert.match(result.evidence.join(' '), /DETECTED/);
  });

  it('PASSES a tree that genuinely cascades the delete', async () => {
    const dir = fixture({});
    const result = await evaluate(dir, { app: EPIC_APP });
    assert.equal(result.measured, true, result.evidence.join('; '));
    assert.equal(result.defectPresent, false, result.evidence.join('; '));
    assert.equal(result.score, 1);
  });

  it('reports UNMEASURED (null) for a delivered tree that does not boot', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'epic-cascade-dead-'));
    workDirs.push(dir);
    writeUnbootableApp(dir);
    const result = await evaluate(dir, {
      app: EPIC_APP,
      readinessTimeoutMs: 1500,
    });
    assert.equal(result.score, null);
    assert.equal(result.defectPresent, null);
    assert.equal(result.measured, false);
  });

  it('rejects a non-string deliveredTreePath', async () => {
    await assert.rejects(() => evaluate(''), TypeError);
  });
});
