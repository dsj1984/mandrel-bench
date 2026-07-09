/**
 * Discrimination test — `story-scope` scenario's `token-generation`
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
} from '../../../../bench/scenarios/story-scope/traps/token-generation.js';

let workDirs = [];

function makeTree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'story-scope-tok-'));
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

describe('token-generation trap-oracle: evaluate(deliveredTreePath)', () => {
  it('scores a hand-crafted CLEAN sample tree as clean (CSPRNG session)', () => {
    const dir = makeTree({
      'server.js': `
        import { randomUUID } from 'node:crypto';

        const sessions = new Map();

        export async function login(req, res) {
          const user = await findUser(req.body.username);
          if (!user) return res.status(401).json({ error: 'unauthorized' });
          const session = randomUUID();
          sessions.set(session, user.id);
          res.json({ session });
        }
      `,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, false, result.evidence.join('; '));
    assert.equal(result.score, 1);
    assert.ok(Array.isArray(result.evidence) && result.evidence.length > 0);
  });

  it('scores a CLEAN sample tree using the uuid package as clean', () => {
    const dir = makeTree({
      'server.js': `
        import { v4 as uuidv4 } from 'uuid';
        export function makeSession() {
          return uuidv4();
        }
      `,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, false);
    assert.equal(result.score, 1);
  });

  it('scores a hand-crafted VULNERABLE sample tree as defective (incrementing counter)', () => {
    const dir = makeTree({
      'server.js': `
        let seq = 0;
        const sessions = new Map();

        export async function login(req, res) {
          const user = await findUser(req.body.username);
          if (!user) return res.status(401).json({ error: 'unauthorized' });
          const token = \`tok-\${++seq}\`;
          sessions.set(token, user.id);
          res.json({ session: token });
        }
      `,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, true, result.evidence.join('; '));
    assert.equal(result.score, 0);
    assert.match(result.evidence.join(' '), /DETECTED/);
  });

  it('scores a hand-crafted VULNERABLE sample tree as defective (Date.now / Math.random)', () => {
    const dir = makeTree({
      'server.js': `
        export function login(req, res) {
          const session = String(Date.now()) + Math.random();
          res.json({ session });
        }
      `,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, true, result.evidence.join('; '));
    assert.equal(result.score, 0);
  });

  it('a predictable-looking assignment is clean when a CSPRNG dominates', () => {
    // CSPRNG usage anywhere in the tree is the dominant positive signal, even
    // if an unrelated numeric id field trips the predictable pattern.
    const dir = makeTree({
      'auth.js': `
        import crypto from 'node:crypto';
        export function makeSession() { return crypto.randomBytes(32).toString('hex'); }
      `,
      'requests.js': `
        // requestId is NOT the session — just an unrelated debug counter.
        let counter = 0;
        function nextRequestId() { return \`req-\${counter++}\`; }
      `,
    });

    const result = evaluate(dir);
    assert.equal(result.defectPresent, false);
    assert.equal(result.score, 1);
  });

  it('skips node_modules, dot-dirs, and the CLAUDE.md overlay artifact', () => {
    const dir = makeTree({
      'node_modules/some-pkg/index.js': `const token = \`\${++seq}\`;`,
      '.agents/scripts/whatever.js': `const session = Date.now();`,
      'CLAUDE.md': `const token = Math.random();`,
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
