/**
 * Discrimination test — `epic-scope` scenario's `pagination-bounds`
 * BEHAVIOURAL trap-oracle (Story #156).
 *
 * Two faces: the pure per-response decision rule (`judgeHostileResponse`) and
 * the end-to-end `evaluate(deliveredTreePath)` contract against real fixture
 * apps that do — and do not — bound hostile `?page` / `?pageSize` values.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  evaluate,
  HOSTILE_QUERIES,
  judgeHostileResponse,
  MAX_SANE_PAGE_SIZE,
} from '../../../../bench/scenarios/epic-scope/traps/pagination-bounds.js';
import {
  EPIC_APP,
  writeEpicScopeApp,
  writeUnbootableApp,
} from '../../fixtures/trap-probe-apps.js';

const workDirs = [];

function fixture(overrides) {
  const dir = mkdtempSync(path.join(tmpdir(), 'epic-paging-'));
  workDirs.push(dir);
  return writeEpicScopeApp(dir, overrides);
}

after(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

describe('judgeHostileResponse (the per-response decision rule)', () => {
  const ok = {
    status: 200,
    body: { items: [], total: 0, page: 1, pageSize: 10 },
  };

  it('accepts a well-formed bounded envelope', () => {
    assert.deepEqual(judgeHostileResponse('?page=0', ok), []);
  });

  it('accepts an outright rejection — rejecting IS a valid bound', () => {
    assert.deepEqual(
      judgeHostileResponse('?page=0', { status: 400, body: { error: 'bad' } }),
      [],
    );
  });

  it('fails a 5xx', () => {
    const reasons = judgeHostileResponse('?page=abc', {
      status: 500,
      body: null,
    });
    assert.match(reasons.join(' '), /threw/);
  });

  it('fails a 2xx with no items array', () => {
    const reasons = judgeHostileResponse('?page=0', {
      status: 200,
      body: { total: 0 },
    });
    assert.match(reasons.join(' '), /no `items` array/);
  });

  it('fails a NaN/null echo of page or pageSize', () => {
    const reasons = judgeHostileResponse('?page=abc&pageSize=abc', {
      status: 200,
      body: { items: [], total: 0, page: null, pageSize: null },
    });
    assert.match(reasons.join(' '), /non-numeric `page`/);
    assert.match(reasons.join(' '), /non-numeric `pageSize`/);
  });

  it('fails an absurd page size honoured verbatim', () => {
    const reasons = judgeHostileResponse('?pageSize=100000', {
      status: 200,
      body: { items: [], total: 0, page: 1, pageSize: MAX_SANE_PAGE_SIZE + 1 },
    });
    assert.match(reasons.join(' '), /honoured verbatim/);
  });

  it('fails a non-positive page size echoed back', () => {
    const reasons = judgeHostileResponse('?pageSize=0', {
      status: 200,
      body: { items: [], total: 0, page: 1, pageSize: 0 },
    });
    assert.match(reasons.join(' '), /non-positive page size/);
  });

  it('fails more items than the reported total', () => {
    const reasons = judgeHostileResponse('?pageSize=100000', {
      status: 200,
      body: { items: [1, 2, 3], total: 1, page: 1, pageSize: 10 },
    });
    assert.match(reasons.join(' '), /for a reported total/);
  });
});

describe('pagination-bounds trap-oracle: evaluate(deliveredTreePath)', () => {
  it('probes every hostile query the class declares', () => {
    assert.ok(HOSTILE_QUERIES.length >= 5);
    assert.ok(HOSTILE_QUERIES.includes('?pageSize=100000'));
  });

  it('FAILS a tree that passes hostile paging parameters straight through', async () => {
    const dir = fixture({ boundPagination: false });
    const result = await evaluate(dir, { app: EPIC_APP });
    assert.equal(result.measured, true, result.evidence.join('; '));
    assert.equal(result.defectPresent, true, result.evidence.join('; '));
    assert.equal(result.score, 0);
    assert.match(result.evidence.join(' '), /DETECTED/);
  });

  it('PASSES a tree that rejects or clamps every hostile paging parameter', async () => {
    const dir = fixture({});
    const result = await evaluate(dir, { app: EPIC_APP });
    assert.equal(result.measured, true, result.evidence.join('; '));
    assert.equal(result.defectPresent, false, result.evidence.join('; '));
    assert.equal(result.score, 1);
  });

  it('reports UNMEASURED (null) for a delivered tree that does not boot', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'epic-paging-dead-'));
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
