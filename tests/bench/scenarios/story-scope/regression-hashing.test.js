/**
 * Discrimination test — `story-scope` touch-2 `regression-hashing` oracle
 * (Epic #86, Story #96).
 *
 * The second-touch regression oracle asserts that the password-change change
 * request PRESERVED password hashing (did not regress to plaintext). Like the
 * touch-1 discrimination tests it drives the oracle's public contract —
 * `evaluate(deliveredTreePath)` — over hand-crafted CLEAN and VULNERABLE sample
 * source trees on the real filesystem, proving the detector discriminates on
 * the delivered tree, not on injected fixtures.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  evaluate,
  evaluateSources,
} from '../../../../bench/scenarios/story-scope/traps-touch2/regression-hashing.js';

let workDirs = [];

function makeTree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'story-scope-reg-hash-'));
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

describe('regression-hashing oracle: evaluate(deliveredTreePath)', () => {
  it('scores a CLEAN sample (hashing preserved through the password change) as clean', () => {
    const dir = makeTree({
      'auth.js': `
        import { scryptSync, randomBytes } from 'node:crypto';
        export function hashPassword(pw) {
          const salt = randomBytes(16).toString('hex');
          return salt + ':' + scryptSync(pw, salt, 64).toString('hex');
        }
        export async function changePassword(userId, newPassword) {
          const record = { password: hashPassword(newPassword) };
          await store.update(userId, record);
        }
      `,
    });
    const result = evaluate(dir);
    assert.equal(result.defectPresent, false, result.evidence.join('; '));
    assert.equal(result.score, 1);
    assert.ok(Array.isArray(result.evidence) && result.evidence.length > 0);
  });

  it('scores a VULNERABLE sample (password change regressed to plaintext) as defective', () => {
    const dir = makeTree({
      'auth.js': `
        export async function changePassword(userId, newPassword) {
          // regression: the new password is persisted verbatim.
          await store.update(userId, { password: newPassword });
        }
        export function login(user, password) {
          return user.password === password;
        }
      `,
    });
    const result = evaluate(dir);
    assert.equal(result.defectPresent, true, result.evidence.join('; '));
    assert.equal(result.score, 0);
    assert.match(result.evidence.join(' '), /DETECTED/);
  });

  it('evaluateSources: a hashed flow is clean even if a stray equality line trips a pattern', () => {
    const result = evaluateSources([
      `import { pbkdf2Sync } from 'node:crypto'; const h = pbkdf2Sync(pw, salt, 1, 32, 'sha256');`,
      `if (record.password === password) { /* unreachable in a hashed flow */ }`,
    ]);
    assert.equal(result.defectPresent, false);
    assert.equal(result.score, 1);
  });

  it('rejects a non-string deliveredTreePath', () => {
    assert.throws(() => evaluate(''), TypeError);
  });
});
