import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { startApp } from './helpers/boot.js';
import {
  createCustomer,
  createDraftOrder,
  registerAndLogin,
} from './helpers/fixtures.js';
import { api } from './helpers/http.js';

const CUSTOMER_COUNT = 25;

let app;
let session;

before(async () => {
  app = await startApp();
  session = await registerAndLogin(app.baseUrl);
  for (let i = 0; i < CUSTOMER_COUNT; i += 1) {
    await createCustomer(app.baseUrl, session.token, {
      name: `Customer ${String(i).padStart(2, '0')}`,
    });
  }
});

after(async () => {
  await app.stop();
});

// @suite-id: pagination.customers.01
test('listing customers defaults to a page size of 20', async () => {
  const res = await api(app.baseUrl, 'GET', '/customers', {
    token: session.token,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.pageSize, 20);
  assert.equal(res.body.items.length, 20);
  assert.equal(res.body.page, 1);
});

// @suite-id: pagination.customers.02
test('the list total counts every customer, not just the page', async () => {
  const res = await api(app.baseUrl, 'GET', '/customers', {
    token: session.token,
  });
  assert.equal(res.body.total, CUSTOMER_COUNT);
});

// @suite-id: pagination.customers.03
test('page 2 returns the remainder with no overlap with page 1', async () => {
  const page1 = await api(app.baseUrl, 'GET', '/customers?page=1', {
    token: session.token,
  });
  const page2 = await api(app.baseUrl, 'GET', '/customers?page=2', {
    token: session.token,
  });
  assert.equal(page2.body.items.length, CUSTOMER_COUNT - 20);
  const page1Ids = new Set(page1.body.items.map((c) => c.id));
  for (const customer of page2.body.items) {
    assert.ok(!page1Ids.has(customer.id));
  }
});

// @suite-id: pagination.customers.04
test('an explicit pageSize is respected', async () => {
  const res = await api(app.baseUrl, 'GET', '/customers?pageSize=10&page=2', {
    token: session.token,
  });
  assert.equal(res.body.items.length, 10);
  assert.equal(res.body.pageSize, 10);
  assert.equal(res.body.page, 2);
});

// @suite-id: pagination.customers.05
test('a pageSize above 100 is rejected with 422', async () => {
  const res = await api(app.baseUrl, 'GET', '/customers?pageSize=101', {
    token: session.token,
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'E_VALIDATION');
});

// @suite-id: pagination.customers.06
test('a page of 0 is rejected with 422', async () => {
  const res = await api(app.baseUrl, 'GET', '/customers?page=0', {
    token: session.token,
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'E_VALIDATION');
});

// @suite-id: pagination.customers.07
test('a non-numeric pageSize is rejected with 422', async () => {
  const res = await api(app.baseUrl, 'GET', '/customers?pageSize=lots', {
    token: session.token,
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'E_VALIDATION');
});

// @suite-id: pagination.orders.08
test('order listing respects explicit page and pageSize', async () => {
  const customer = await createCustomer(app.baseUrl, session.token, {
    name: 'Order Pagination Co',
  });
  for (let i = 0; i < 3; i += 1) {
    await createDraftOrder(app.baseUrl, session.token, customer.id);
  }
  const res = await api(
    app.baseUrl,
    'GET',
    `/orders?customerId=${customer.id}&pageSize=2&page=2`,
    { token: session.token },
  );
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.total, 3);
  assert.equal(res.body.page, 2);
  assert.equal(res.body.pageSize, 2);
});

// @suite-id: pagination.orders.09
test('the order list total reflects the active filters', async () => {
  const customer = await createCustomer(app.baseUrl, session.token, {
    name: 'Filtered Totals Inc',
  });
  await createDraftOrder(app.baseUrl, session.token, customer.id);
  const res = await api(
    app.baseUrl,
    'GET',
    `/orders?customerId=${customer.id}&status=draft`,
    { token: session.token },
  );
  assert.equal(res.body.total, 1);
});

// @suite-id: pagination.customers.10
test('a page beyond the data returns an empty items array with the true total', async () => {
  const res = await api(app.baseUrl, 'GET', '/customers?page=50', {
    token: session.token,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.items, []);
  assert.ok(res.body.total >= CUSTOMER_COUNT);
});
