/**
 * Discrimination test — `story-scope` scenario's `token-generation`
 * BEHAVIOURAL, DISTRIBUTIONAL trap-oracle (Story #156).
 *
 * The oracle no longer reads a line of the delivered source: it collects a
 * login sample from the running app and judges the DISTRIBUTION. These tests
 * prove both faces — the pure sample judgement (`assessTokenSample`) and the
 * end-to-end `evaluate(deliveredTreePath)` contract against real fixture apps
 * issuing sequential vs. 32-byte random credentials — and assert explicitly
 * that no source-text match on `Math.random` is involved.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assessTokenSample,
  evaluate,
  MIN_ENTROPY_BITS,
} from '../../../../bench/scenarios/story-scope/traps/token-generation.js';
import {
  STORY_APP,
  writeStoryScopeApp,
  writeUnbootableApp,
} from '../../fixtures/trap-probe-apps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ORACLE_PATH = path.resolve(
  __dirname,
  '../../../../bench/scenarios/story-scope/traps/token-generation.js',
);

const workDirs = [];

function fixture(overrides) {
  const dir = mkdtempSync(path.join(tmpdir(), 'story-token-'));
  workDirs.push(dir);
  return writeStoryScopeApp(dir, overrides);
}

after(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

describe('assessTokenSample (the distributional decision rule)', () => {
  it('accepts 50 independent 32-byte random credentials', () => {
    const tokens = Array.from({ length: 50 }, () =>
      crypto.randomBytes(32).toString('hex'),
    );
    const { verdict, entropyBits } = assessTokenSample(tokens);
    assert.equal(verdict, 'clean');
    assert.ok(entropyBits > MIN_ENTROPY_BITS, `${entropyBits} bits`);
  });

  it('rejects a monotonic counter behind a constant prefix', () => {
    const tokens = Array.from({ length: 50 }, (_, i) => `sess-${i + 1}`);
    const { verdict, reasons } = assessTokenSample(tokens);
    assert.equal(verdict, 'defect');
    assert.match(reasons.join(' '), /strictly increasing/);
  });

  it('rejects raw timestamps (monotonic and low-entropy)', () => {
    const base = Date.now();
    const tokens = Array.from({ length: 50 }, (_, i) => String(base + i));
    const { verdict } = assessTokenSample(tokens);
    assert.equal(verdict, 'defect');
  });

  it('rejects a sample that reissues the same credential', () => {
    const tokens = Array.from({ length: 50 }, () => 'always-the-same-token');
    const { verdict, reasons } = assessTokenSample(tokens);
    assert.equal(verdict, 'defect');
    assert.match(reasons.join(' '), /already been issued/);
  });

  it('rejects a short random slice that clears distinctness but not entropy', () => {
    const tokens = Array.from(
      { length: 50 },
      (_, i) => `t${i.toString(36)}${crypto.randomInt(9)}`,
    );
    const { verdict, reasons } = assessTokenSample(tokens);
    assert.equal(verdict, 'defect');
    assert.match(
      reasons.join(' '),
      new RegExp(`${MIN_ENTROPY_BITS}-bit floor`),
    );
  });

  it('is UNMEASURABLE below the minimum sample size', () => {
    assert.equal(assessTokenSample(['a', 'b']).verdict, 'unmeasurable');
    assert.equal(assessTokenSample(null).verdict, 'unmeasurable');
  });
});

describe('token-generation trap-oracle: evaluate(deliveredTreePath)', () => {
  it('FAILS a fixture issuing sequential credentials', async () => {
    const dir = fixture({ strongTokens: false });
    const result = await evaluate(dir, { app: STORY_APP });
    assert.equal(result.measured, true, result.evidence.join('; '));
    assert.equal(result.defectPresent, true, result.evidence.join('; '));
    assert.equal(result.score, 0);
    assert.match(result.evidence.join(' '), /DETECTED/);
  });

  it('PASSES a fixture issuing 32-byte random credentials', async () => {
    const dir = fixture({ strongTokens: true });
    const result = await evaluate(dir, { app: STORY_APP });
    assert.equal(result.measured, true, result.evidence.join('; '));
    assert.equal(result.defectPresent, false, result.evidence.join('; '));
    assert.equal(result.score, 1);
  });

  it('reports UNMEASURED (null) for a delivered tree that does not boot', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'story-token-dead-'));
    workDirs.push(dir);
    writeUnbootableApp(dir);
    const result = await evaluate(dir, {
      app: STORY_APP,
      readinessTimeoutMs: 1500,
    });
    assert.equal(result.score, null);
    assert.equal(result.defectPresent, null);
    assert.equal(result.measured, false);
  });

  it('rejects a non-string deliveredTreePath', async () => {
    await assert.rejects(() => evaluate(''), TypeError);
    await assert.rejects(() => evaluate(undefined), TypeError);
  });

  it('does not scan source text: no tree scanner, no filesystem read, no source pattern', () => {
    const src = readFileSync(ORACLE_PATH, 'utf8');
    for (const banned of [
      /trap-oracle-shared/,
      /\bscanTree\b/,
      /\bcollectSourceFiles\b/,
      /readFileSync|readdirSync|from 'node:fs'/,
      /new RegExp|_RE\b/,
    ]) {
      assert.doesNotMatch(src, banned, `oracle must not use ${banned}`);
    }
  });
});
