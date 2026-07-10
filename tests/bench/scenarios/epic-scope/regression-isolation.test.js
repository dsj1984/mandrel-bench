/**
 * Discrimination test — `epic-scope` touch-2 `regression-isolation` oracle
 * (Epic #86, Story #96).
 *
 * The second-touch regression oracle asserts that the project-sharing change
 * request PRESERVED per-user isolation (did not regress to unscoped,
 * cross-user id-addressed resource access). It drives the oracle's public
 * contract — `evaluate(deliveredTreePath)` — over hand-crafted CLEAN and
 * VULNERABLE sample source trees on the real filesystem.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  evaluate,
  evaluateSources,
} from '../../../../bench/scenarios/epic-scope/traps-touch2/regression-isolation.js';

let workDirs = [];

function makeTree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'epic-scope-reg-iso-'));
  workDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

afterEach(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
  workDirs = [];
});

describe('regression-isolation oracle: evaluate(deliveredTreePath)', () => {
  it('scores a CLEAN sample (per-user isolation preserved) as clean', () => {
    const dir = makeTree({
      'projects.js': `
        export function getProject(db, id, req) {
          // ownership scoping preserved through the sharing change.
          const row = db.get('SELECT * FROM projects WHERE id = ? AND owner_id = ?', id, req.user.id);
          return row ?? null;
        }
      `,
    });
    const result = evaluate(dir);
    assert.equal(result.defectPresent, false, result.evidence.join('; '));
    assert.equal(result.score, 1);
    assert.ok(Array.isArray(result.evidence) && result.evidence.length > 0);
  });

  it('scores a VULNERABLE sample (isolation regressed to an unscoped lookup) as defective', () => {
    const dir = makeTree({
      'projects.js': `
        export function getProject(db, id) {
          // regression: any user can read any project by id.
          return db.get('SELECT * FROM projects WHERE id = ?', id);
        }
      `,
    });
    const result = evaluate(dir);
    assert.equal(result.defectPresent, true, result.evidence.join('; '));
    assert.equal(result.score, 0);
    assert.match(result.evidence.join(' '), /DETECTED/);
  });

  it('evaluateSources: an ownership check anywhere keeps the tree clean', () => {
    const result = evaluateSources([
      `if (project.owner_id !== req.user.id) return res.status(404).end();`,
      `const t = tasks.findById(taskId);`,
    ]);
    assert.equal(result.defectPresent, false);
    assert.equal(result.score, 1);
  });

  it('rejects a non-string deliveredTreePath', () => {
    assert.throws(() => evaluate(''), TypeError);
  });
});
