import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { startApp } from './helpers/boot.js';
import {
  addOrderItem,
  createCustomer,
  createDraftOrder,
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

// @suite-id: items.add.01
test('adding an item returns 201 with the stored item', async () => {
  const order = await createDraftOrder(app.baseUrl, session.token, customer.id);
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/items`, {
    token: session.token,
    body: { description: 'Line rental', quantity: 4, unitPriceCents: 2500 },
  });
  assert.equal(res.status, 201);
  assert.match(res.body.id, /^itm_/);
  assert.equal(res.body.orderId, order.id);
  assert.equal(res.body.description, 'Line rental');
  assert.equal(res.body.quantity, 4);
  assert.equal(res.body.unitPriceCents, 2500);
});

// @suite-id: items.add.02
test('adding items keeps the order total at the sum of quantity times unit price', async () => {
  const order = await createDraftOrder(app.baseUrl, session.token, customer.id);
  await addOrderItem(app.baseUrl, session.token, order.id, {
    quantity: 2,
    unitPriceCents: 1000,
  });
  await addOrderItem(app.baseUrl, session.token, order.id, {
    quantity: 3,
    unitPriceCents: 333,
  });
  const res = await api(app.baseUrl, 'GET', `/orders/${order.id}`, {
    token: session.token,
  });
  assert.equal(res.body.totalCents, 2 * 1000 + 3 * 333);
});

// @suite-id: items.add.03
test('an item quantity below 1 is rejected with 422', async () => {
  const order = await createDraftOrder(app.baseUrl, session.token, customer.id);
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/items`, {
    token: session.token,
    body: { description: 'Zero qty', quantity: 0, unitPriceCents: 100 },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'E_VALIDATION');
});

// @suite-id: items.add.04
test('a fractional unitPriceCents is rejected — money is integer cents', async () => {
  const order = await createDraftOrder(app.baseUrl, session.token, customer.id);
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/items`, {
    token: session.token,
    body: { description: 'Float price', quantity: 1, unitPriceCents: 19.99 },
  });
  assert.equal(res.status, 422);
  assert.ok(res.body.error.details.some((d) => d.includes('unitPriceCents')));
});

// @suite-id: items.add.05
test('a negative unitPriceCents is rejected with 422', async () => {
  const order = await createDraftOrder(app.baseUrl, session.token, customer.id);
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/items`, {
    token: session.token,
    body: { description: 'Negative', quantity: 1, unitPriceCents: -50 },
  });
  assert.equal(res.status, 422);
});

// @suite-id: items.add.06
test('an item without a description is rejected with 422', async () => {
  const order = await createDraftOrder(app.baseUrl, session.token, customer.id);
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/items`, {
    token: session.token,
    body: { quantity: 1, unitPriceCents: 100 },
  });
  assert.equal(res.status, 422);
  assert.ok(res.body.error.details.some((d) => d.includes('description')));
});

// @suite-id: items.list.07
test('listing items returns them in insertion order', async () => {
  const order = await createDraftOrder(app.baseUrl, session.token, customer.id);
  await addOrderItem(app.baseUrl, session.token, order.id, {
    description: 'First',
  });
  await addOrderItem(app.baseUrl, session.token, order.id, {
    description: 'Second',
  });
  const res = await api(app.baseUrl, 'GET', `/orders/${order.id}/items`, {
    token: session.token,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.map((item) => item.description),
    ['First', 'Second'],
  );
});

// @suite-id: items.remove.08
test('removing an item returns 204 and the order total is recalculated', async () => {
  const order = await createDraftOrder(app.baseUrl, session.token, customer.id);
  const keep = await addOrderItem(app.baseUrl, session.token, order.id, {
    quantity: 1,
    unitPriceCents: 700,
  });
  const drop = await addOrderItem(app.baseUrl, session.token, order.id, {
    quantity: 1,
    unitPriceCents: 300,
  });
  const del = await api(
    app.baseUrl,
    'DELETE',
    `/orders/${order.id}/items/${drop.id}`,
    { token: session.token },
  );
  assert.equal(del.status, 204);
  const fetched = await api(app.baseUrl, 'GET', `/orders/${order.id}`, {
    token: session.token,
  });
  assert.equal(fetched.body.totalCents, 700);
  assert.deepEqual(
    fetched.body.items.map((item) => item.id),
    [keep.id],
  );
});

// @suite-id: items.remove.09
test('removing an unknown item returns 404', async () => {
  const order = await createDraftOrder(app.baseUrl, session.token, customer.id);
  const res = await api(
    app.baseUrl,
    'DELETE',
    `/orders/${order.id}/items/itm_missing`,
    { token: session.token },
  );
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'E_NOT_FOUND');
});

// @suite-id: items.add.10
test('adding an item to an unknown order returns 404', async () => {
  const res = await api(app.baseUrl, 'POST', '/orders/ord_missing/items', {
    token: session.token,
    body: { description: 'Orphan', quantity: 1, unitPriceCents: 100 },
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'E_NOT_FOUND');
});
