import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { startApp } from './helpers/boot.js';
import {
  createCustomer,
  createDraftOrder,
  createIssuedOrder,
  registerAndLogin,
} from './helpers/fixtures.js';
import { api } from './helpers/http.js';

let app;
let admin;
let member;

function rowFor(body, customerId) {
  return body.items.find((row) => row.customerId === customerId) ?? null;
}

before(async () => {
  app = await startApp();
  admin = await registerAndLogin(app.baseUrl, { name: 'Report Admin' });
  member = await registerAndLogin(app.baseUrl, { name: 'Report Member' });
});

after(async () => {
  await app.stop();
});

// @suite-id: reports.receivables.01
test('the receivables report is admin-only (403 for a member)', async () => {
  const res = await api(app.baseUrl, 'GET', '/reports/receivables', {
    token: member.token,
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'E_FORBIDDEN');
});

// @suite-id: reports.receivables.02
test('the receivables report requires authentication', async () => {
  const res = await api(app.baseUrl, 'GET', '/reports/receivables');
  assert.equal(res.status, 401);
});

// @suite-id: reports.receivables.03
test('with no issued orders the report is empty with a zero total', async () => {
  const res = await api(app.baseUrl, 'GET', '/reports/receivables', {
    token: admin.token,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items, []);
  assert.equal(res.body.totalOutstandingCents, 0);
});

// @suite-id: reports.receivables.04
test('an issued order appears with its full amount outstanding', async () => {
  const customer = await createCustomer(app.baseUrl, admin.token, {
    name: 'Outstanding Ltd',
  });
  const order = await createIssuedOrder(app.baseUrl, admin.token, customer.id);
  const res = await api(app.baseUrl, 'GET', '/reports/receivables', {
    token: admin.token,
  });
  const row = rowFor(res.body, customer.id);
  assert.ok(row);
  assert.equal(row.customerName, 'Outstanding Ltd');
  assert.equal(row.orderCount, 1);
  assert.equal(row.outstandingCents, order.totalCents);
});

// @suite-id: reports.receivables.05
test('a partial payment reduces the outstanding amount', async () => {
  const customer = await createCustomer(app.baseUrl, admin.token, {
    name: 'Partial Payers Pty',
  });
  const order = await createIssuedOrder(app.baseUrl, admin.token, customer.id);
  await api(app.baseUrl, 'POST', `/orders/${order.id}/payments`, {
    token: admin.token,
    body: { amountCents: 1000, method: 'card' },
  });
  const res = await api(app.baseUrl, 'GET', '/reports/receivables', {
    token: admin.token,
  });
  const row = rowFor(res.body, customer.id);
  assert.equal(row.outstandingCents, order.totalCents - 1000);
});

// @suite-id: reports.receivables.06
test('a fully paid order drops out of the report', async () => {
  const customer = await createCustomer(app.baseUrl, admin.token, {
    name: 'Settled & Co',
  });
  const order = await createIssuedOrder(app.baseUrl, admin.token, customer.id);
  await api(app.baseUrl, 'POST', `/orders/${order.id}/payments`, {
    token: admin.token,
    body: { amountCents: order.totalCents, method: 'bank_transfer' },
  });
  const res = await api(app.baseUrl, 'GET', '/reports/receivables', {
    token: admin.token,
  });
  assert.equal(rowFor(res.body, customer.id), null);
});

// @suite-id: reports.receivables.07
test('draft and void orders never appear in receivables', async () => {
  const customer = await createCustomer(app.baseUrl, admin.token, {
    name: 'Never Issued GmbH',
  });
  await createDraftOrder(app.baseUrl, admin.token, customer.id);
  const voided = await createIssuedOrder(app.baseUrl, admin.token, customer.id);
  await api(app.baseUrl, 'POST', `/orders/${voided.id}/void`, {
    token: admin.token,
  });
  const res = await api(app.baseUrl, 'GET', '/reports/receivables', {
    token: admin.token,
  });
  assert.equal(rowFor(res.body, customer.id), null);
});

// @suite-id: reports.receivables.08
test('multiple issued orders for one customer are grouped into one row', async () => {
  const customer = await createCustomer(app.baseUrl, admin.token, {
    name: 'Bulk Buyer BV',
  });
  const first = await createIssuedOrder(app.baseUrl, admin.token, customer.id);
  const second = await createIssuedOrder(app.baseUrl, admin.token, customer.id, {
    items: [{ quantity: 1, unitPriceCents: 9900 }],
  });
  const res = await api(app.baseUrl, 'GET', '/reports/receivables', {
    token: admin.token,
  });
  const row = rowFor(res.body, customer.id);
  assert.equal(row.orderCount, 2);
  assert.equal(row.outstandingCents, first.totalCents + second.totalCents);
});

// @suite-id: reports.receivables.09
test('report amounts are integer cents and the total is the sum of the rows', async () => {
  const res = await api(app.baseUrl, 'GET', '/reports/receivables', {
    token: admin.token,
  });
  let sum = 0;
  for (const row of res.body.items) {
    assert.ok(Number.isInteger(row.outstandingCents));
    sum += row.outstandingCents;
  }
  assert.ok(Number.isInteger(res.body.totalOutstandingCents));
  assert.equal(res.body.totalOutstandingCents, sum);
});
