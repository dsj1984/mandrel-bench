import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';

import { startApp } from './helpers/boot.js';
import {
  createCustomer,
  createIssuedOrder,
  registerAndLogin,
} from './helpers/fixtures.js';
import { api } from './helpers/http.js';

let app;
let account;
let customer;
let order;

before(async () => {
  app = await startApp();
  account = await registerAndLogin(app.baseUrl, { name: 'Persist Admin' });
  customer = await createCustomer(app.baseUrl, account.token, {
    name: 'Durable Goods Inc',
  });
  order = await createIssuedOrder(app.baseUrl, account.token, customer.id);
  await api(app.baseUrl, 'POST', `/orders/${order.id}/payments`, {
    token: account.token,
    body: { amountCents: order.totalCents, method: 'bank_transfer' },
  });
  // The real restart: stop the server process, then boot a fresh process
  // against the same database file. Everything below runs post-restart.
  app = await app.restart();
});

after(async () => {
  await app.stop();
});

// @suite-id: persistence.users.01
test('a registered user can log in after a server restart', async () => {
  const res = await api(app.baseUrl, 'POST', '/auth/login', {
    body: { email: account.email, password: account.password },
  });
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.token, 'string');
  account = { ...account, token: res.body.token };
});

// @suite-id: persistence.customers.02
test('customers survive a server restart', async () => {
  const res = await api(app.baseUrl, 'GET', `/customers/${customer.id}`, {
    token: account.token,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Durable Goods Inc');
});

// @suite-id: persistence.orders.03
test('orders and their items survive a server restart', async () => {
  const res = await api(app.baseUrl, 'GET', `/orders/${order.id}`, {
    token: account.token,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.totalCents, order.totalCents);
  assert.equal(res.body.items.length, 1);
});

// @suite-id: persistence.payments.04
test('payments and the paid status survive a server restart', async () => {
  const detail = await api(app.baseUrl, 'GET', `/orders/${order.id}`, {
    token: account.token,
  });
  assert.equal(detail.body.status, 'paid');
  assert.equal(detail.body.paidCents, order.totalCents);
  const payments = await api(app.baseUrl, 'GET', `/orders/${order.id}/payments`, {
    token: account.token,
  });
  assert.equal(payments.body.length, 1);
});

// @suite-id: persistence.db.05
test('the database file lives at the configured path', () => {
  assert.ok(existsSync(app.dbPath));
});

// @suite-id: persistence.migrations.06
test('a rebooted server is healthy — migrations are idempotent', async () => {
  const res = await api(app.baseUrl, 'GET', '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
});
