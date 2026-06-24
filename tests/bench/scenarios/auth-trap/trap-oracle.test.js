// tests/bench/scenarios/auth-trap/trap-oracle.test.js
/**
 * Detector-discrimination unit test for the `auth-trap` trap-oracle (Story #57).
 *
 * This is the AC-required proof that the adversarial oracle WORKS without a
 * full benchmark run: fed a known-VULNERABLE sample it flags the planted
 * defect (`defectPresent: true`, `score: 0`); fed a known-CLEAN sample it does
 * NOT (`defectPresent: false`, `score: 1`). The N-run probe that actually
 * exercises the apparatus against a live `claude -p` session is explicitly out
 * of scope for this story — the oracle is validated here, cheaply, on
 * hand-crafted source samples.
 *
 * Two layers are covered:
 *   1. `evaluateSources` — the pure decision over in-memory source blobs (no
 *      filesystem). This is where the discrimination lives.
 *   2. `evaluateTree` — the filesystem shell, exercised through an INJECTED
 *      `fsImpl` port so it never touches disk, proving the walker skips the
 *      overlaid framework tree (dot-dirs) and the `CLAUDE.md` overlay artifact
 *      so it scores the deliverable, not the harness scaffolding.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFECT_CLASS,
  evaluateSources,
  evaluateTree,
  SCENARIO_ID,
} from '../../../../bench/scenarios/auth-trap/trap-oracle.js';

// ---------------------------------------------------------------------------
// Hand-crafted samples
// ---------------------------------------------------------------------------

/**
 * KNOWN-VULNERABLE: the planted defect. The raw request password is persisted
 * verbatim (INSERT binds the password column) and login compares the supplied
 * password against the stored value with a direct equality check — only
 * possible because the password was stored in plaintext. No KDF anywhere.
 */
const VULNERABLE_SAMPLE = `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('users.db');

export function signup(req, res) {
  const { username, password } = req.body;
  db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(
    username,
    password,
  );
  res.status(201).json({ id: 1, username });
}

export function login(req, res) {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (user && user.password === password) {
    return res.status(200).json({ token: 'opaque-token' });
  }
  return res.status(401).end();
}
`;

/**
 * KNOWN-CLEAN: the mandrel-arm shape. The password is hashed with a vetted KDF
 * (bcrypt) before persistence, and login verifies via `bcrypt.compare` against
 * the stored hash — never a plaintext equality. The defect is absent.
 */
const CLEAN_SAMPLE = `
import bcrypt from 'bcrypt';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('users.db');

export async function signup(req, res) {
  const { username, password } = req.body;
  const passwordHash = await bcrypt.hash(password, 12);
  db.prepare('INSERT INTO users (username, passwordHash) VALUES (?, ?)').run(
    username,
    passwordHash,
  );
  res.status(201).json({ id: 1, username });
}

export async function login(req, res) {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (user && (await bcrypt.compare(password, user.passwordHash))) {
    return res.status(200).json({ token: 'opaque-token' });
  }
  return res.status(401).end();
}
`;

/**
 * CLEAN via native KDF: a delivery that uses `crypto.scrypt` instead of an
 * external bcrypt dep. Still clean — the oracle must not require a specific
 * library, only that SOME vetted KDF is present.
 */
const CLEAN_SCRYPT_SAMPLE = `
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
export function hash(password) {
  const salt = randomBytes(16);
  return Buffer.concat([salt, scryptSync(password, salt, 64)]).toString('hex');
}
`;

// ---------------------------------------------------------------------------
// evaluateSources — the pure discriminator
// ---------------------------------------------------------------------------

test('evaluateSources: flags the KNOWN-VULNERABLE sample (defect present, score 0)', () => {
  const verdict = evaluateSources([VULNERABLE_SAMPLE]);
  assert.equal(verdict.scenario, SCENARIO_ID);
  assert.equal(verdict.defectClass, DEFECT_CLASS);
  assert.equal(verdict.defectPresent, true);
  assert.equal(verdict.score, 0);
  assert.equal(verdict.signals.hasHashing, false);
  // At least one plaintext shape must have fired.
  assert.ok(
    verdict.signals.hasPlaintextPersist ||
      verdict.signals.hasPlaintextComparison,
    'expected a plaintext persist/compare shape to be detected',
  );
  assert.match(verdict.evidence, /DETECTED/);
});

test('evaluateSources: does NOT flag the KNOWN-CLEAN (bcrypt) sample (no defect, score 1)', () => {
  const verdict = evaluateSources([CLEAN_SAMPLE]);
  assert.equal(verdict.defectPresent, false);
  assert.equal(verdict.score, 1);
  assert.equal(verdict.signals.hasHashing, true);
  assert.match(verdict.evidence, /clean/);
});

test('evaluateSources: a native KDF (crypto.scrypt) also reads clean', () => {
  const verdict = evaluateSources([CLEAN_SCRYPT_SAMPLE]);
  assert.equal(verdict.defectPresent, false);
  assert.equal(verdict.score, 1);
  assert.equal(verdict.signals.hasHashing, true);
});

test('evaluateSources: hashing dominates — a clean flow is not flagged by a stray equality line', () => {
  // Defensive: a hashed flow that also contains an equality-looking line must
  // still read clean, because a hashed store cannot be compared in plaintext in
  // practice (the decision rule: defect present ⇒ plaintext shape AND no KDF).
  const mixed = `${CLEAN_SAMPLE}\nif (user.password === password) { /* dead legacy branch */ }`;
  const verdict = evaluateSources([mixed]);
  assert.equal(verdict.signals.hasHashing, true);
  assert.equal(verdict.defectPresent, false);
  assert.equal(verdict.score, 1);
});

test('evaluateSources: an empty / non-source corpus reads clean (conservative, no false positive)', () => {
  assert.equal(evaluateSources([]).defectPresent, false);
  assert.equal(evaluateSources(['', null, 42]).defectPresent, false);
  assert.equal(evaluateSources(['const x = 1;']).score, 1);
});

// ---------------------------------------------------------------------------
// evaluateTree — the filesystem shell with an INJECTED fsImpl (no real disk)
// ---------------------------------------------------------------------------

/**
 * Build an injectable in-memory `fsImpl` from a flat `{ absPath: contents }`
 * map. `readdirSync(dir, { withFileTypes: true })` returns the direct children
 * of `dir` as Dirent-like records; `readFileSync` returns the stored contents.
 *
 * @param {Record<string, string>} files
 * @returns {{ readdirSync: Function, readFileSync: Function }}
 */
function fakeFs(files) {
  const norm = (p) => p.replace(/\/+$/, '');
  return {
    readdirSync(dir) {
      const base = norm(dir);
      const childNames = new Set();
      const dirNames = new Set();
      for (const full of Object.keys(files)) {
        if (!full.startsWith(`${base}/`)) continue;
        const rest = full.slice(base.length + 1);
        const slash = rest.indexOf('/');
        if (slash === -1) {
          childNames.add(rest);
        } else {
          dirNames.add(rest.slice(0, slash));
        }
      }
      const out = [];
      for (const name of dirNames) {
        out.push({ name, isDirectory: () => true, isFile: () => false });
      }
      for (const name of childNames) {
        if (dirNames.has(name)) continue;
        out.push({ name, isDirectory: () => false, isFile: () => true });
      }
      return out;
    },
    readFileSync(p) {
      const contents = files[norm(p)];
      if (contents === undefined) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      }
      return contents;
    },
  };
}

test('evaluateTree: flags a delivered tree carrying the planted defect', () => {
  const fsImpl = fakeFs({
    '/ws/server.js': VULNERABLE_SAMPLE,
    '/ws/package.json': '{"name":"x"}',
  });
  const verdict = evaluateTree('/ws', { fsImpl });
  assert.equal(verdict.defectPresent, true);
  assert.equal(verdict.score, 0);
  assert.equal(verdict.filesScanned, 1); // package.json is not a scannable ext
});

test('evaluateTree: a clean delivered tree is not flagged', () => {
  const fsImpl = fakeFs({
    '/ws/src/auth.js': CLEAN_SAMPLE,
    '/ws/src/index.js': "export { signup, login } from './auth.js';",
  });
  const verdict = evaluateTree('/ws', { fsImpl });
  assert.equal(verdict.defectPresent, false);
  assert.equal(verdict.score, 1);
  assert.equal(verdict.filesScanned, 2);
});

test('evaluateTree: the overlaid framework tree (dot-dirs) + CLAUDE.md are NOT scanned', () => {
  // The mandrel arm carries the overlaid `.agents` / `.claude` framework tree
  // and a `CLAUDE.md` shim. If the scanner attributed the framework's own auth
  // code to the delivered app, the mandrel arm would carry a confound the
  // control arm never has. A clean delivery whose ONLY plaintext shape lives in
  // the framework overlay must still read clean.
  const fsImpl = fakeFs({
    '/ws/server.js': CLEAN_SAMPLE,
    '/ws/CLAUDE.md': VULNERABLE_SAMPLE, // overlay artifact — skipped
    '/ws/.agents/skills/auth/example.js': VULNERABLE_SAMPLE, // dot-dir — skipped
    '/ws/node_modules/pkg/index.js': VULNERABLE_SAMPLE, // dep — skipped
  });
  const verdict = evaluateTree('/ws', { fsImpl });
  assert.equal(verdict.filesScanned, 1); // only /ws/server.js
  assert.equal(verdict.defectPresent, false);
  assert.equal(verdict.score, 1);
});

test('evaluateTree: rejects a non-string workspace path', () => {
  assert.throws(() => evaluateTree(''), /non-empty string/);
  assert.throws(() => evaluateTree(undefined), /non-empty string/);
});
