/**
 * Discrimination test — `epic-scope` scenario's `missing-input-validation`
 * trap-oracle (Epic #66, Story #78).
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
} from '../../../../bench/scenarios/epic-scope/traps/missing-input-validation.js';

let workDirs = [];

function makeTree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'epic-scope-miv-'));
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

describe('missing-input-validation trap-oracle: evaluate(deliveredTreePath)', () => {
  it('scores a hand-crafted CLEAN sample tree as clean (type/emptiness guard + 400)', () => {
    const dir = makeTree({
      'tasks.js': `
        export async function createTask(req, res) {
          if (typeof req.body.title !== 'string' || req.body.title.length === 0) {
            return res.status(400).json({ error: 'invalid' });
          }
          const task = db
            .prepare('INSERT INTO tasks (title) VALUES (?)')
            .run(req.body.title);
          res.status(201).json({ id: task.lastInsertRowid, title: req.body.title });
        }
      `,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, false, result.evidence.join('; '));
    assert.equal(result.score, 1);
    assert.ok(Array.isArray(result.evidence) && result.evidence.length > 0);
  });

  it('scores a hand-crafted VULNERABLE sample tree as defective (raw body straight to persistence, no guard anywhere)', () => {
    const dir = makeTree({
      'tasks.js': `
        export async function createTask(req, res) {
          const task = db
            .prepare('INSERT INTO tasks (title) VALUES (?)')
            .run(req.body.title);
          res.status(201).json({ id: task.lastInsertRowid, title: req.body.title });
        }
      `,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, true, result.evidence.join('; '));
    assert.equal(result.score, 0);
    assert.match(result.evidence.join(' '), /DETECTED/);
  });

  it('a raw-write shape is clean when a validation guard dominates elsewhere', () => {
    // A validation-guard shape anywhere in the tree is the dominant
    // positive, even if a stray write call elsewhere also references
    // req.body directly in its arguments.
    const dir = makeTree({
      'auth.js': `
        export function register(req, res) {
          if (!req.body.username) {
            return res.status(400).json({ error: 'invalid' });
          }
          res.status(201).json({ id: 1 });
        }
      `,
      'tasks.js': `
        export function createTask(req, res) {
          const task = db.prepare('INSERT INTO tasks (title) VALUES (?)').run(req.body.title);
          res.status(201).json(task);
        }
      `,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, false);
    assert.equal(result.score, 1);
  });

  it('a raw-write shape with no persistence call is clean (no defect shape detected)', () => {
    const dir = makeTree({
      'noop.js': `export function noop() { return req.body.title; }`,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, false);
    assert.equal(result.score, 1);
  });

  it('skips node_modules, dot-dirs, and the CLAUDE.md overlay artifact', () => {
    const dir = makeTree({
      'node_modules/some-pkg/index.js': `db.run(req.body.title)`,
      '.agents/scripts/whatever.js': `db.insert(req.body.title)`,
      'CLAUDE.md': `db.create(req.body.title)`,
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
