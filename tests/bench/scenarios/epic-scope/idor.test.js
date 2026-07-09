/**
 * Discrimination test — `epic-scope` scenario's `idor` trap-oracle
 * (Epic #66, Story #78).
 *
 * Builds hand-crafted CLEAN and VULNERABLE sample source trees on the real
 * filesystem (a temp dir per test) and drives the oracle's public contract —
 * `evaluate(deliveredTreePath)` — exactly as `bench/scenarios/trap-runner.js`
 * calls it, proving the detector discriminates on the delivered tree, not on
 * injected fixtures.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  evaluate,
  evaluateSources,
} from '../../../../bench/scenarios/epic-scope/traps/idor.js';

let workDirs = [];

function makeTree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'epic-scope-idor-'));
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

describe('idor trap-oracle: evaluate(deliveredTreePath)', () => {
  it('scores a hand-crafted CLEAN sample tree as clean (ownership check on lookup)', () => {
    const dir = makeTree({
      'projects.js': `
        export async function getProject(req, res) {
          const project = projects.findById(req.params.id);
          if (!project || project.ownerId !== req.user.id) {
            return res.status(404).json({ error: 'not found' });
          }
          res.json(project);
        }
      `,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, false, result.evidence.join('; '));
    assert.equal(result.score, 1);
    assert.ok(Array.isArray(result.evidence) && result.evidence.length > 0);
  });

  it('scores a CLEAN sample using an owner-scoped SQL filter as clean', () => {
    const dir = makeTree({
      'db.js': `
        export function getProject(id, ownerId) {
          return db
            .prepare('SELECT * FROM projects WHERE id = ? AND owner_id = ?')
            .get(id, ownerId);
        }
      `,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, false);
    assert.equal(result.score, 1);
  });

  it('scores a hand-crafted VULNERABLE sample tree as defective (unscoped lookup)', () => {
    const dir = makeTree({
      'projects.js': `
        export async function getProject(req, res) {
          const project = projects.findById(req.params.id);
          res.json(project);
        }

        export async function deleteProject(req, res) {
          projects.findById(req.params.projectId);
          projects.delete(req.params.projectId);
          res.status(204).end();
        }
      `,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, true, result.evidence.join('; '));
    assert.equal(result.score, 0);
    assert.match(result.evidence.join(' '), /DETECTED/);
  });

  it('scores a hand-crafted VULNERABLE sample using a bare-id SQL lookup as defective', () => {
    const dir = makeTree({
      'db.js': `
        export function getTask(id) {
          return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
        }
      `,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, true, result.evidence.join('; '));
    assert.equal(result.score, 0);
  });

  it('an unscoped-looking lookup is clean when an ownership check dominates', () => {
    // An ownership check anywhere in the tree is the dominant positive, even
    // if a stray unscoped-looking lookup exists elsewhere (e.g. an internal
    // helper never reached from a route).
    const dir = makeTree({
      'auth-guard.js': `
        export function assertOwner(resource, req) {
          return resource.ownerId === req.user.id;
        }
      `,
      'maintenance.js': `
        // internal maintenance helper, not reachable from any route
        function debugLookup(req) { return tasks.findById(req.params.taskId); }
      `,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, false);
    assert.equal(result.score, 1);
  });

  it('skips node_modules, dot-dirs, and the CLAUDE.md overlay artifact', () => {
    const dir = makeTree({
      'node_modules/some-pkg/index.js': `projects.findById(req.params.id)`,
      '.agents/scripts/whatever.js': `tasks.findById(req.params.taskId)`,
      'CLAUDE.md': `projects.findById(req.params.id)`,
      'server.js': `export function noop() {}`,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, false);
    assert.equal(result.score, 1);
  });

  it('rejects a non-string deliveredTreePath', () => {
    assert.throws(() => evaluate(''), TypeError);
    assert.throws(() => evaluate(undefined), TypeError);
  });

  it('evaluateSources: empty/whitespace-only sources are clean, not thrown', () => {
    const result = evaluateSources(['', '   ', 'const x = 1;']);
    assert.equal(result.defectPresent, false);
    assert.equal(result.score, 1);
  });
});
