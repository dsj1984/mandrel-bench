// Frozen behavioural additions for touch 5 (receivables at scale) — issue
// #124 PR-B. The default-page-size consistency probes (01–03) are the
// landmine L2 detectors: the seed carries the default `20` TWICE — as
// `DEFAULT_PAGE_SIZE` in src/lib/pagination.js AND as an inlined literal
// default in src/repositories/orders.repo.js — so a change that edits only
// one copy leaves the API's paginated surfaces disagreeing about the
// default. The probes pin the bumped default (25) on every list surface:
// clients, the deprecated customers alias, orders, and the newly paginated
// report.
//
// The base suite retires nothing here: the only base tests that pinned the
// old default-20 behaviour (pagination.customers.01/03) were already
// superseded by touch 3's rename, and every other retained probe passes
// explicit page/pageSize.
//
// The latency probe uses an HTTP-built fixture (the frozen suite only
// speaks HTTP — it never reaches into the delivered schema) and a
// deliberately generous ceiling: it exists to catch pathological
// per-row-query regressions, not to micro-benchmark.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { startApp } from './helpers/boot.js';
import { registerAndLogin, uniqueEmail } from './helpers/fixtures.js';
import { api } from './helpers/http.js';

const CLIENT_COUNT = 30;
const REPORT_LATENCY_CEILING_MS = 2000;

let app;
let admin;

async function must(promise, status, label) {
  const res = await promise;
  assert.equal(res.status, status, `${label}: ${JSON.stringify(res.body)}`);
  return res.body;
}

before(async () => {
  app = await startApp();
  admin = await registerAndLogin(app.baseUrl, { name: 'Scale Admin' });
  for (let i = 0; i < CLIENT_COUNT; i += 1) {
    const client = await must(
      api(app.baseUrl, 'POST', '/customers', {
        token: admin.token,
        body: {
          name: `Receivable Client ${String(i).padStart(2, '0')}`,
          email: uniqueEmail('scale'),
        },
      }),
      201,
      'create client',
    );
    const order = await must(
      api(app.baseUrl, 'POST', '/orders', {
        token: admin.token,
        body: { customerId: client.id },
      }),
      201,
      'create order',
    );
    await must(
      api(app.baseUrl, 'POST', `/orders/${order.id}/items`, {
        token: admin.token,
        body: { description: 'Widget', quantity: 1 + (i % 3), unitPriceCents: 1250 },
      }),
      201,
      'add item',
    );
    await must(
      api(app.baseUrl, 'POST', `/orders/${order.id}/issue`, { token: admin.token }),
      200,
      'issue order',
    );
  }
});

after(async () => {
  await app.stop();
});

// @suite-id: receivables.default.01
test('the client list defaults to a page size of 25', async () => {
  const res = await api(app.baseUrl, 'GET', '/clients', { token: admin.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.pageSize, 25);
  assert.equal(res.body.items.length, 25);
});

// @suite-id: receivables.default.02
test('the deprecated customers alias shares the same default page size of 25', async () => {
  const res = await api(app.baseUrl, 'GET', '/customers', { token: admin.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.pageSize, 25);
  assert.equal(res.body.items.length, 25);
});

// @suite-id: receivables.default.03
test('the order list defaults to a page size of 25', async () => {
  const res = await api(app.baseUrl, 'GET', '/orders', { token: admin.token });
  assert.equal(res.status, 200);
  assert.equal(res.body.pageSize, 25);
  assert.equal(res.body.items.length, 25);
});

// @suite-id: receivables.paging.04
test('the receivables report is paginated with the standard envelope and default', async () => {
  const res = await api(app.baseUrl, 'GET', '/reports/receivables', {
    token: admin.token,
  });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.equal(res.body.total, CLIENT_COUNT);
  assert.equal(res.body.page, 1);
  assert.equal(res.body.pageSize, 25);
  assert.equal(res.body.items.length, 25);
});

// @suite-id: receivables.paging.05
test('report page 2 returns the remainder with no overlap with page 1', async () => {
  const page1 = await api(app.baseUrl, 'GET', '/reports/receivables?page=1', {
    token: admin.token,
  });
  const page2 = await api(app.baseUrl, 'GET', '/reports/receivables?page=2', {
    token: admin.token,
  });
  assert.equal(page2.status, 200);
  assert.equal(page2.body.items.length, CLIENT_COUNT - 25);
  const page1Ids = new Set(page1.body.items.map((row) => row.customerId));
  for (const row of page2.body.items) {
    assert.ok(!page1Ids.has(row.customerId), 'no row appears on both pages');
  }
});

// @suite-id: receivables.paging.06
test('an out-of-range report pageSize is rejected with 422 E_VALIDATION', async () => {
  const res = await api(app.baseUrl, 'GET', '/reports/receivables?pageSize=101', {
    token: admin.token,
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'E_VALIDATION');
});

// @suite-id: receivables.totals.07
test('totalOutstandingCents is the grand total across all pages, on every page', async () => {
  const page1 = await api(app.baseUrl, 'GET', '/reports/receivables?page=1', {
    token: admin.token,
  });
  const page2 = await api(app.baseUrl, 'GET', '/reports/receivables?page=2', {
    token: admin.token,
  });
  const pagedSum = [...page1.body.items, ...page2.body.items].reduce(
    (sum, row) => sum + row.outstandingCents,
    0,
  );
  assert.ok(Number.isInteger(page1.body.totalOutstandingCents));
  assert.equal(page1.body.totalOutstandingCents, pagedSum);
  assert.equal(page2.body.totalOutstandingCents, page1.body.totalOutstandingCents);
});

// @suite-id: receivables.perf.08
test('the receivables report responds inside the latency ceiling', async () => {
  const startedAt = process.hrtime.bigint();
  const res = await api(app.baseUrl, 'GET', '/reports/receivables', {
    token: admin.token,
  });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.equal(res.status, 200);
  assert.ok(
    elapsedMs < REPORT_LATENCY_CEILING_MS,
    `report took ${Math.round(elapsedMs)}ms (ceiling ${REPORT_LATENCY_CEILING_MS}ms)`,
  );
});
