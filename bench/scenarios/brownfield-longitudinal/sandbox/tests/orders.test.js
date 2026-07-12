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
  customer = await createCustomer(app.baseUrl, session.token, {
    name: 'Soylent Industries',
  });
});

after(async () => {
  await app.stop();
});

// @suite-id: orders.create.01
test('creating an order returns a draft with a zero total and a customer name snapshot', async () => {
  const res = await api(app.baseUrl, 'POST', '/orders', {
    token: session.token,
    body: { customerId: customer.id },
  });
  assert.equal(res.status, 201);
  assert.match(res.body.id, /^ord_/);
  assert.equal(res.body.status, 'draft');
  assert.equal(res.body.totalCents, 0);
  assert.equal(res.body.customerId, customer.id);
  assert.equal(res.body.customerName, 'Soylent Industries');
  assert.equal(res.body.createdBy, session.user.id);
  assert.equal(res.body.issuedAt, null);
});

// @suite-id: orders.create.02
test('creating an order for an unknown customer returns 404', async () => {
  const res = await api(app.baseUrl, 'POST', '/orders', {
    token: session.token,
    body: { customerId: 'cus_missing' },
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'E_NOT_FOUND');
});

// @suite-id: orders.create.03
test('creating an order without a token is rejected with 401', async () => {
  const res = await api(app.baseUrl, 'POST', '/orders', {
    body: { customerId: customer.id },
  });
  assert.equal(res.status, 401);
});

// @suite-id: orders.create.04
test('order notes round-trip through create and fetch', async () => {
  const created = await createDraftOrder(app.baseUrl, session.token, customer.id, {
    notes: 'Net 30 payment terms',
  });
  assert.equal(created.notes, 'Net 30 payment terms');
  const fetched = await api(app.baseUrl, 'GET', `/orders/${created.id}`, {
    token: session.token,
  });
  assert.equal(fetched.body.notes, 'Net 30 payment terms');
});

// @suite-id: orders.get.05
test('order detail includes an empty items array and zero paidCents for a fresh draft', async () => {
  const created = await createDraftOrder(app.baseUrl, session.token, customer.id);
  const res = await api(app.baseUrl, 'GET', `/orders/${created.id}`, {
    token: session.token,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items, []);
  assert.equal(res.body.paidCents, 0);
});

// @suite-id: orders.get.06
test('fetching an unknown order returns 404 E_NOT_FOUND', async () => {
  const res = await api(app.baseUrl, 'GET', '/orders/ord_missing', {
    token: session.token,
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'E_NOT_FOUND');
});

// @suite-id: orders.list.07
test('listing orders returns the paginated envelope', async () => {
  const res = await api(app.baseUrl, 'GET', '/orders', {
    token: session.token,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    Object.keys(res.body).sort(),
    ['items', 'page', 'pageSize', 'total'],
  );
  assert.ok(Array.isArray(res.body.items));
  assert.ok(res.body.total >= 1);
});

// @suite-id: orders.list.08
test('listing orders filters by status', async () => {
  const res = await api(app.baseUrl, 'GET', '/orders?status=draft', {
    token: session.token,
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.items.length >= 1);
  for (const order of res.body.items) {
    assert.equal(order.status, 'draft');
  }
});

// @suite-id: orders.list.09
test('listing orders filters by customerId', async () => {
  const other = await createCustomer(app.baseUrl, session.token, {
    name: 'Umbrella Supplies',
  });
  await createDraftOrder(app.baseUrl, session.token, other.id);
  const res = await api(app.baseUrl, 'GET', `/orders?customerId=${other.id}`, {
    token: session.token,
  });
  assert.equal(res.body.total, 1);
  assert.equal(res.body.items[0].customerId, other.id);
});

// @suite-id: orders.list.10
test('listing orders with an invalid status filter is rejected with 422', async () => {
  const res = await api(app.baseUrl, 'GET', '/orders?status=bogus', {
    token: session.token,
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'E_VALIDATION');
});

// @suite-id: orders.get.11
test('order detail lists items after they are added', async () => {
  const created = await createDraftOrder(app.baseUrl, session.token, customer.id);
  await addOrderItem(app.baseUrl, session.token, created.id, {
    description: 'Consulting hours',
    quantity: 3,
    unitPriceCents: 15000,
  });
  const res = await api(app.baseUrl, 'GET', `/orders/${created.id}`, {
    token: session.token,
  });
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].description, 'Consulting hours');
  assert.equal(res.body.totalCents, 45000);
});

// @suite-id: orders.create.12
test('creating an order without a customerId is rejected with 422', async () => {
  const res = await api(app.baseUrl, 'POST', '/orders', {
    token: session.token,
    body: {},
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'E_VALIDATION');
});
