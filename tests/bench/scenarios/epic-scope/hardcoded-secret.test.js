/**
 * Discrimination test — `epic-scope` scenario's `hardcoded-secret`
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
} from '../../../../bench/scenarios/epic-scope/traps/hardcoded-secret.js';

let workDirs = [];

function makeTree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'epic-scope-secret-'));
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

describe('hardcoded-secret trap-oracle: evaluate(deliveredTreePath)', () => {
  it('scores a hand-crafted CLEAN sample tree as clean (env-sourced signing key)', () => {
    const dir = makeTree({
      'auth.js': `
        import jwt from 'jsonwebtoken';

        const signingKey = process.env.TOKEN_SIGNING_KEY;

        export function issueToken(user) {
          return jwt.sign({ sub: user.id }, signingKey);
        }
      `,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, false, result.evidence.join('; '));
    assert.equal(result.score, 1);
    assert.ok(Array.isArray(result.evidence) && result.evidence.length > 0);
  });

  it('scores a hand-crafted VULNERABLE sample tree as defective (inlined secret literal)', () => {
    const dir = makeTree({
      'auth.js': `
        import jwt from 'jsonwebtoken';

        const jwtSecret = 'supersecretkey123456';

        export function issueToken(user) {
          return jwt.sign({ sub: user.id }, jwtSecret);
        }
      `,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, true, result.evidence.join('; '));
    assert.equal(result.score, 0);
    assert.match(result.evidence.join(' '), /DETECTED/);
  });

  it('scores a VULNERABLE sample passing the literal inline to jwt.sign as defective', () => {
    const dir = makeTree({
      'auth.js': `
        import jwt from 'jsonwebtoken';
        export function issueToken(user) {
          return jwt.sign({ sub: user.id }, 'hardcoded-literal-key');
        }
      `,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, true, result.evidence.join('; '));
    assert.equal(result.score, 0);
  });

  it('an inlined-looking literal is clean when an env-sourced read dominates elsewhere', () => {
    // An env-sourced key read anywhere in the tree is the dominant positive,
    // even if a stray literal-looking assignment exists elsewhere (e.g. a
    // fixture constant used only in a comment or an unrelated string).
    const dir = makeTree({
      'auth.js': `
        const signingKey = process.env.TOKEN_SIGNING_KEY;
        export function issueToken(payload) { return sign(payload, signingKey); }
      `,
      'fixtures.js': `
        // test fixture only, never used at runtime:
        const secret = 'fixture-secret-value';
      `,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, false);
    assert.equal(result.score, 1);
  });

  it('skips node_modules, dot-dirs, and the CLAUDE.md overlay artifact', () => {
    const dir = makeTree({
      'node_modules/some-pkg/index.js': `const secret = 'literal-value-here';`,
      '.agents/scripts/whatever.js': `const apiKey = 'literal-value-here';`,
      'CLAUDE.md': `const jwtSecret = 'literal-value-here';`,
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
