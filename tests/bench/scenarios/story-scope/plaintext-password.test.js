/**
 * Discrimination test — `story-scope` scenario's `plaintext-password`
 * trap-oracle (Epic #66, Story #75).
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
} from '../../../../bench/scenarios/story-scope/traps/plaintext-password.js';

let workDirs = [];

function makeTree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'story-scope-pw-'));
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

describe('plaintext-password trap-oracle: evaluate(deliveredTreePath)', () => {
  it('scores a hand-crafted CLEAN sample tree as clean (hashed storage)', () => {
    const dir = makeTree({
      'server.js': `
        import { scryptSync, randomBytes } from 'node:crypto';

        function hashPassword(password) {
          const salt = randomBytes(16).toString('hex');
          const hash = scryptSync(password, salt, 64).toString('hex');
          return \`\${salt}:\${hash}\`;
        }

        function verifyPassword(password, stored) {
          const [salt, hash] = stored.split(':');
          const candidate = scryptSync(password, salt, 64).toString('hex');
          return candidate === hash;
        }

        export async function signup(req, res) {
          const { username, password } = req.body;
          const passwordHash = hashPassword(password);
          await db.users.insert({ username, passwordHash });
          res.status(201).json({ id: 1, username });
        }
      `,
      'package.json': JSON.stringify({ name: 'clean-app' }),
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, false, result.evidence.join('; '));
    assert.equal(result.score, 1);
    assert.ok(Array.isArray(result.evidence) && result.evidence.length > 0);
  });

  it('scores a hand-crafted VULNERABLE sample tree as defective (plaintext storage)', () => {
    const dir = makeTree({
      'server.js': `
        export async function signup(req, res) {
          const { username, password } = req.body;
          const user = { username, password: req.body.password };
          await db.users.insert(user);
          res.status(201).json({ id: 1, username });
        }

        export async function login(req, res) {
          const { username, password } = req.body;
          const user = await db.users.findOne({ username });
          if (!user || user.password === password) {
            return res.status(401).json({ error: 'unauthorized' });
          }
          res.json({ session: 'tok' });
        }
      `,
      'package.json': JSON.stringify({ name: 'vulnerable-app' }),
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, true, result.evidence.join('; '));
    assert.equal(result.score, 0);
    assert.match(result.evidence.join(' '), /DETECTED/);
  });

  it('a vulnerable-looking comparison is clean when hashing dominates', () => {
    // Hashing anywhere in the tree is the dominant positive signal, even if
    // an unrelated file trips a plaintext-looking pattern.
    const dir = makeTree({
      'auth.js': `
        import bcrypt from 'bcrypt';
        export async function hash(pw) { return bcrypt.hash(pw, 10); }
      `,
      'legacy-note.js': `
        // NOTE: user.password === password is what the OLD system did; unused now.
      `,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, false);
    assert.equal(result.score, 1);
  });

  it('skips node_modules, dot-dirs, and the CLAUDE.md overlay artifact', () => {
    const dir = makeTree({
      'node_modules/some-pkg/index.js': `user.password === password`,
      '.agents/scripts/whatever.js': `user.password === password`,
      'CLAUDE.md': `user.password === password`,
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
