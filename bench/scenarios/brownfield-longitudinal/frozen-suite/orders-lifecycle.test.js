import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { startApp } from './helpers/boot.js';
import {
  addOrderItem,
  createCustomer,
  createDraftOrder,
  createIssuedOrder,
  registerAndLogin,
} from './helpers/fixtures.js';
import { api } from './helpers/http.js';

let app;
let session;
let customer;

before(async () => {
  app = await startApp();
  session = await registerAndLogin(app.baseUrl);
  customer = await createCustomer(app.baseUrl, session.token);
});

after(async () => {
  await app.stop();
});

// @suite-id: lifecycle.issue.01
test('issuing a draft order with items transitions it to issued and stamps issuedAt', async () => {
  const order = await createDraftOrder(app.baseUrl, session.token, customer.id);
  await addOrderItem(app.baseUrl, session.token, order.id);
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/issue`, {
    token: session.token,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'issued');
  assert.ok(res.body.issuedAt);
});

// @suite-id: lifecycle.issue.02
test('issuing an order with no items is rejected with 422 E_EMPTY_ORDER', async () => {
  const order = await createDraftOrder(app.baseUrl, session.token, customer.id);
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/issue`, {
    token: session.token,
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'E_EMPTY_ORDER');
});

// @suite-id: lifecycle.issue.03
test('issuing an already-issued order is rejected with 409 E_INVALID_STATUS', async () => {
  const order = await createIssuedOrder(app.baseUrl, session.token, customer.id);
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/issue`, {
    token: session.token,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'E_INVALID_STATUS');
});

// @suite-id: lifecycle.void.04
test('a draft order can be voided', async () => {
  const order = await createDraftOrder(app.baseUrl, session.token, customer.id);
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/void`, {
    token: session.token,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'void');
});

// @suite-id: lifecycle.void.05
test('an issued order can be voided', async () => {
  const order = await createIssuedOrder(app.baseUrl, session.token, customer.id);
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/void`, {
    token: session.token,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'void');
});

// @suite-id: lifecycle.void.06
test('a paid order cannot be voided (409 E_INVALID_STATUS)', async () => {
  const order = await createIssuedOrder(app.baseUrl, session.token, customer.id);
  await api(app.baseUrl, 'POST', `/orders/${order.id}/payments`, {
    token: session.token,
    body: { amountCents: order.totalCents, method: 'bank_transfer' },
  });
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/void`, {
    token: session.token,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'E_INVALID_STATUS');
});

// @suite-id: lifecycle.items.07
test('items cannot be added to an issued order (409)', async () => {
  const order = await createIssuedOrder(app.baseUrl, session.token, customer.id);
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/items`, {
    token: session.token,
    body: { description: 'Late addition', quantity: 1, unitPriceCents: 500 },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'E_INVALID_STATUS');
});

// @suite-id: lifecycle.payments.08
test('payments cannot be recorded against a draft order (409)', async () => {
  const order = await createDraftOrder(app.baseUrl, session.token, customer.id);
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/payments`, {
    token: session.token,
    body: { amountCents: 100, method: 'card' },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'E_INVALID_STATUS');
});

// @suite-id: lifecycle.payments.09
test('a payment settling the full balance transitions the order to paid', async () => {
  const order = await createIssuedOrder(app.baseUrl, session.token, customer.id);
  const pay = await api(app.baseUrl, 'POST', `/orders/${order.id}/payments`, {
    token: session.token,
    body: { amountCents: order.totalCents, method: 'bank_transfer' },
  });
  assert.equal(pay.status, 201);
  const fetched = await api(app.baseUrl, 'GET', `/orders/${order.id}`, {
    token: session.token,
  });
  assert.equal(fetched.body.status, 'paid');
});

// @suite-id: lifecycle.items.10
test('items cannot be removed from an issued order (409)', async () => {
  const draft = await createDraftOrder(app.baseUrl, session.token, customer.id);
  const item = await addOrderItem(app.baseUrl, session.token, draft.id);
  await api(app.baseUrl, 'POST', `/orders/${draft.id}/issue`, {
    token: session.token,
  });
  const res = await api(
    app.baseUrl,
    'DELETE',
    `/orders/${draft.id}/items/${item.id}`,
    { token: session.token },
  );
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'E_INVALID_STATUS');
});
