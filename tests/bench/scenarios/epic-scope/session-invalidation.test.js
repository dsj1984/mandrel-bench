/**
 * Discrimination test — `epic-scope` scenario's `session-invalidation`
 * BEHAVIOURAL trap-oracle (Story #156).
 *
 * A tree whose bearer credential is a self-describing blob it merely decodes
 * honours a credential it never issued (re-encoded for another identity) and
 * must fail; a tree that issues opaque credentials and looks them up must
 * refuse every tampered variant and pass; an unbootable tree must report
 * `null`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  deriveTamperedTokens,
  evaluate,
} from '../../../../bench/scenarios/epic-scope/traps/session-invalidation.js';
import {
  EPIC_APP,
  writeEpicScopeApp,
  writeUnbootableApp,
} from '../../fixtures/trap-probe-apps.js';

const workDirs = [];

function fixture(overrides) {
  const dir = mkdtempSync(path.join(tmpdir(), 'epic-session-'));
  workDirs.push(dir);
  return writeEpicScopeApp(dir, overrides);
}

after(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

describe('deriveTamperedTokens', () => {
  it('never returns the original credential', () => {
    const original = 'a'.repeat(64);
    for (const { token } of deriveTamperedTokens(original, 99)) {
      assert.notEqual(token, original);
    }
  });

  it('derives truncation and mutation from an opaque credential', () => {
    const labels = deriveTamperedTokens('deadbeefcafe', 99).map((d) => d.label);
    assert.ok(labels.some((l) => /truncated/.test(l)));
    assert.ok(labels.some((l) => /mutated/.test(l)));
  });

  it('re-encodes a JWT-shaped credential for another identity with the signature dropped', () => {
    const header = Buffer.from('{"alg":"HS256"}').toString('base64url');
    const payload = Buffer.from('{"sub":1,"iat":0}').toString('base64url');
    const jwt = `${header}.${payload}.signature`;
    const forged = deriveTamperedTokens(jwt, 42).find((d) =>
      /JWT/.test(d.label),
    );
    assert.ok(forged, 'a JWT-shaped derivation is produced');
    const [, forgedPayload, sig] = forged.token.split('.');
    assert.equal(sig, '', 'signature dropped');
    assert.deepEqual(
      JSON.parse(Buffer.from(forgedPayload, 'base64url').toString('utf8')),
      { sub: 42, iat: 0 },
    );
  });

  it('re-encodes a self-describing base64 credential for another identity', () => {
    const token = Buffer.from('{"userId":1}').toString('base64url');
    const forged = deriveTamperedTokens(token, 42).find((d) =>
      /self-describing/.test(d.label),
    );
    assert.ok(forged);
    assert.deepEqual(
      JSON.parse(Buffer.from(forged.token, 'base64url').toString('utf8')),
      { userId: 42 },
    );
  });

  it('derives nothing from a single-character credential', () => {
    assert.deepEqual(deriveTamperedTokens('x', 1), []);
  });
});

describe('session-invalidation trap-oracle: evaluate(deliveredTreePath)', () => {
  it('FAILS a tree that decodes a self-describing credential instead of verifying it', async () => {
    const dir = fixture({ verifyToken: false });
    const result = await evaluate(dir, { app: EPIC_APP });
    assert.equal(result.measured, true, result.evidence.join('; '));
    assert.equal(result.defectPresent, true, result.evidence.join('; '));
    assert.equal(result.score, 0);
    assert.match(result.evidence.join(' '), /DETECTED/);
  });

  it('PASSES a tree that issues opaque credentials and looks them up', async () => {
    const dir = fixture({});
    const result = await evaluate(dir, { app: EPIC_APP });
    assert.equal(result.measured, true, result.evidence.join('; '));
    assert.equal(result.defectPresent, false, result.evidence.join('; '));
    assert.equal(result.score, 1);
  });

  it('reports UNMEASURED (null) for a delivered tree that does not boot', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'epic-session-dead-'));
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
