// Frozen behavioural additions for touch 1 (credit notes) — issue #124 PR-B.
// Copied into the evolved frozen suite as touch1-acceptance.test.js and run
// against the delivered tree; helpers resolve from the frozen mirror.
//
// Chain-stability notes: probes must keep passing on every LATER touch's
// tree too — the receivables probes read `body.items` (present before and
// after touch 5's pagination) and never assert page-size defaults; the
// customer fixture goes through POST /customers, which touch 3 keeps as a
// deprecated alias and touch 4 keeps accepting single-`name` writes on.

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
let customer;
let order; // issued; default fixture total 2 × 1250 = 2500 cents

function receivablesRow(body, customerId) {
  return body.items.find((row) => row.customerId === customerId) ?? null;
}

before(async () => {
  app = await startApp();
  admin = await registerAndLogin(app.baseUrl, { name: 'Credit Admin' });
  customer = await createCustomer(app.baseUrl, admin.token, {
    name: 'Creditworthy Pty',
  });
  order = await createIssuedOrder(app.baseUrl, admin.token, customer.id);
});

after(async () => {
  await app.stop();
});

// @suite-id: credit-notes.create.01
test('issuing a credit note against an issued order returns the created note', async () => {
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/credit-notes`, {
    token: admin.token,
    body: { amountCents: 300, reason: 'damaged goods' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.amountCents, 300);
  assert.ok(Number.isInteger(res.body.amountCents));
  assert.equal(res.body.reason, 'damaged goods');
});

// @suite-id: credit-notes.list.02
test('listing credit notes returns the issued notes as a JSON array', async () => {
  const res = await api(app.baseUrl, 'GET', `/orders/${order.id}/credit-notes`, {
    token: admin.token,
  });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  assert.ok(res.body.some((note) => note.amountCents === 300));
});

// @suite-id: credit-notes.create.03
test('issuing a credit note without a token is rejected with the 401 envelope', async () => {
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/credit-notes`, {
    body: { amountCents: 100, reason: 'no auth' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'E_UNAUTHENTICATED');
});

// @suite-id: credit-notes.validation.04
test('a fractional amountCents is rejected with 422 E_VALIDATION', async () => {
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/credit-notes`, {
    token: admin.token,
    body: { amountCents: 10.5, reason: 'not integer cents' },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'E_VALIDATION');
});

// @suite-id: credit-notes.validation.05
test('an unknown field on a credit note write is rejected, not dropped', async () => {
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/credit-notes`, {
    token: admin.token,
    body: { amountCents: 100, reason: 'ok', approvedBy: 'nobody' },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'E_VALIDATION');
});

// @suite-id: credit-notes.limits.06
test('an order cannot be credited beyond its outstanding amount', async () => {
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/credit-notes`, {
    token: admin.token,
    body: { amountCents: 1_000_000, reason: 'too much' },
  });
  assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
  assert.match(res.body.error.code, /^E_[A-Z]+(_[A-Z]+)*$/);
});

// @suite-id: credit-notes.limits.07
test('a draft order cannot be credited', async () => {
  const draft = await createDraftOrder(app.baseUrl, admin.token, customer.id);
  const res = await api(app.baseUrl, 'POST', `/orders/${draft.id}/credit-notes`, {
    token: admin.token,
    body: { amountCents: 100, reason: 'not issued yet' },
  });
  assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
  assert.match(res.body.error.code, /^E_[A-Z]+(_[A-Z]+)*$/);
});

// @suite-id: credit-notes.report.08
test('a credit note reduces the outstanding amount in the receivables report', async () => {
  const res = await api(app.baseUrl, 'GET', '/reports/receivables', {
    token: admin.token,
  });
  assert.equal(res.status, 200);
  const row = receivablesRow(res.body, customer.id);
  assert.ok(row, 'the credited customer still has an outstanding row');
  assert.equal(row.outstandingCents, order.totalCents - 300);
});

// @suite-id: credit-notes.report.09
test('a fully credited order drops out of the receivables report', async () => {
  const other = await createCustomer(app.baseUrl, admin.token, {
    name: 'Fully Credited GmbH',
  });
  const credited = await createIssuedOrder(app.baseUrl, admin.token, other.id);
  const credit = await api(
    app.baseUrl,
    'POST',
    `/orders/${credited.id}/credit-notes`,
    {
      token: admin.token,
      body: { amountCents: credited.totalCents, reason: 'order cancelled' },
    },
  );
  assert.equal(credit.status, 201);
  const res = await api(app.baseUrl, 'GET', '/reports/receivables', {
    token: admin.token,
  });
  assert.equal(receivablesRow(res.body, other.id), null);
});

// @suite-id: credit-notes.errors.10
test('crediting an unknown order returns 404 E_NOT_FOUND', async () => {
  const res = await api(app.baseUrl, 'POST', '/orders/ord_missing/credit-notes', {
    token: admin.token,
    body: { amountCents: 100, reason: 'ghost order' },
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'E_NOT_FOUND');
});
