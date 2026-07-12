// Frozen behavioural additions for touch 4 (client name split) — issue
// #124 PR-B. The current-name report probe (06) is the landmine L3
// detector: the seed's receivables query reads the DENORMALISED
// `orders.customer_name` snapshot instead of joining the customers table,
// so an implementation that only renames fields at the route layer keeps
// showing the stale name after a client is renamed — the probe renames a
// client between two report reads. Probe 07 replaces the superseded
// persistence.customers.02 (which asserted the retired single-`name`
// response field across a restart).
//
// Chain-stability notes: probes never assert a report page-size default
// (touch 5 bumps it) and read report rows via `body.items`, which is
// present before and after touch 5's pagination.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { startApp } from './helpers/boot.js';
import { registerAndLogin, uniqueEmail } from './helpers/fixtures.js';
import { api } from './helpers/http.js';

let app;
let admin;

async function createClientRaw(body) {
  return api(app.baseUrl, 'POST', '/clients', { token: admin.token, body });
}

async function issueOrderFor(clientId) {
  const order = await api(app.baseUrl, 'POST', '/orders', {
    token: admin.token,
    body: { customerId: clientId },
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  const item = await api(app.baseUrl, 'POST', `/orders/${order.body.id}/items`, {
    token: admin.token,
    body: { description: 'Widget', quantity: 2, unitPriceCents: 1250 },
  });
  assert.equal(item.status, 201, JSON.stringify(item.body));
  const issued = await api(app.baseUrl, 'POST', `/orders/${order.body.id}/issue`, {
    token: admin.token,
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  return issued.body;
}

before(async () => {
  app = await startApp();
  admin = await registerAndLogin(app.baseUrl, { name: 'Namesplit Admin' });
});

after(async () => {
  await app.stop();
});

// @suite-id: namesplit.create.01
test('creating a client with firstName and lastName echoes both fields', async () => {
  const res = await createClientRaw({
    firstName: 'Grace',
    lastName: 'Hopper',
    email: uniqueEmail('split'),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.firstName, 'Grace');
  assert.equal(res.body.lastName, 'Hopper');
});

// @suite-id: namesplit.compat.02
test('a legacy single-name write is split on the last space', async () => {
  const res = await createClientRaw({
    name: 'Ada King Lovelace',
    email: uniqueEmail('compat'),
  });
  assert.equal(res.status, 201);
  const fetched = await api(app.baseUrl, 'GET', `/clients/${res.body.id}`, {
    token: admin.token,
  });
  assert.equal(fetched.body.firstName, 'Ada King');
  assert.equal(fetched.body.lastName, 'Lovelace');
});

// @suite-id: namesplit.compat.03
test('a single-word legacy name becomes the last name', async () => {
  const res = await createClientRaw({
    name: 'Teller',
    email: uniqueEmail('mononym'),
  });
  assert.equal(res.status, 201);
  const fetched = await api(app.baseUrl, 'GET', `/clients/${res.body.id}`, {
    token: admin.token,
  });
  assert.equal(fetched.body.lastName, 'Teller');
});

// @suite-id: namesplit.update.04
test('patching only the lastName leaves the firstName unchanged', async () => {
  const created = await createClientRaw({
    firstName: 'Barbara',
    lastName: 'Liskov',
    email: uniqueEmail('patch'),
  });
  assert.equal(created.status, 201);
  const res = await api(app.baseUrl, 'PATCH', `/clients/${created.body.id}`, {
    token: admin.token,
    body: { lastName: 'Liskov-Zilles' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.firstName, 'Barbara');
  assert.equal(res.body.lastName, 'Liskov-Zilles');
});

// @suite-id: namesplit.validation.05
test('a first name without a last name is rejected with 422 E_VALIDATION', async () => {
  const res = await createClientRaw({
    firstName: 'Orphaned',
    email: uniqueEmail('invalid'),
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'E_VALIDATION');
});

// @suite-id: namesplit.report.06
test('the receivables report shows the client name current at read time, not a stale snapshot', async () => {
  const created = await createClientRaw({
    firstName: 'Stale',
    lastName: 'Snapshot',
    email: uniqueEmail('report'),
  });
  assert.equal(created.status, 201);
  await issueOrderFor(created.body.id);
  const beforeRename = await api(app.baseUrl, 'GET', '/reports/receivables', {
    token: admin.token,
  });
  const rowBefore = beforeRename.body.items.find(
    (row) => row.customerId === created.body.id,
  );
  assert.ok(rowBefore, 'the client has an outstanding row');
  assert.equal(rowBefore.customerName, 'Stale Snapshot');
  const renamed = await api(app.baseUrl, 'PATCH', `/clients/${created.body.id}`, {
    token: admin.token,
    body: { firstName: 'Fresh', lastName: 'Current' },
  });
  assert.equal(renamed.status, 200);
  const afterRename = await api(app.baseUrl, 'GET', '/reports/receivables', {
    token: admin.token,
  });
  const rowAfter = afterRename.body.items.find(
    (row) => row.customerId === created.body.id,
  );
  assert.ok(rowAfter, 'the renamed client still has an outstanding row');
  assert.equal(rowAfter.customerName, 'Fresh Current');
});

// @suite-id: namesplit.persistence.07
test('split names survive a server restart', async () => {
  const created = await createClientRaw({
    firstName: 'Durable',
    lastName: 'Names',
    email: uniqueEmail('persist'),
  });
  assert.equal(created.status, 201);
  app = await app.restart();
  const login = await api(app.baseUrl, 'POST', '/auth/login', {
    body: { email: admin.email, password: admin.password },
  });
  assert.equal(login.status, 200);
  const res = await api(app.baseUrl, 'GET', `/clients/${created.body.id}`, {
    token: login.body.token,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.firstName, 'Durable');
  assert.equal(res.body.lastName, 'Names');
});
