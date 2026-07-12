// Frozen behavioural additions for touch 3 (customers → clients rename) —
// issue #124 PR-B. These are the alias+new-name REPLACEMENTS for the
// superseded customers.* route assertions and pagination.customers.*
// suite: the legitimate rename retires exact-path assertions on
// /customers (an implementation may serve the alias via re-registered
// handlers, an internal rewrite, or a redirect the http helper follows),
// and this suite re-pins the equivalent behaviour on /clients plus the
// data-equivalence contract between the two paths.
//
// Chain-stability notes: no probe asserts a single `name` response field
// (touch 4 splits it into firstName/lastName) — round-trip equivalence is
// asserted by comparing WHOLE bodies across the two paths and via the
// email field, which survives every later touch. No probe asserts a
// default page size (touch 5 bumps it): pagination probes always pass
// explicit page/pageSize.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { startApp } from './helpers/boot.js';
import { registerAndLogin, uniqueEmail } from './helpers/fixtures.js';
import { api } from './helpers/http.js';

let app;
let admin;

async function createClient(body) {
  const res = await api(app.baseUrl, 'POST', '/clients', {
    token: admin.token,
    body,
  });
  assert.equal(res.status, 201, `create client failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

before(async () => {
  app = await startApp();
  admin = await registerAndLogin(app.baseUrl, { name: 'Rename Admin' });
});

after(async () => {
  await app.stop();
});

// @suite-id: clients.create.01
test('creating a client via /clients returns 201 with an id', async () => {
  const created = await createClient({
    name: 'Clientside AB',
    email: uniqueEmail('clients'),
  });
  assert.equal(typeof created.id, 'string');
  assert.ok(created.id.length > 0);
});

// @suite-id: clients.alias.02
test('a client reads identically through /clients and the /customers alias', async () => {
  const created = await createClient({
    name: 'Alias Equivalence NV',
    email: uniqueEmail('alias'),
  });
  const viaClients = await api(app.baseUrl, 'GET', `/clients/${created.id}`, {
    token: admin.token,
  });
  const viaCustomers = await api(app.baseUrl, 'GET', `/customers/${created.id}`, {
    token: admin.token,
  });
  assert.equal(viaClients.status, 200);
  assert.equal(viaCustomers.status, 200);
  assert.deepEqual(viaCustomers.body, viaClients.body);
});

// @suite-id: clients.alias.03
test('creating through the deprecated /customers alias is visible via /clients', async () => {
  const legacy = await api(app.baseUrl, 'POST', '/customers', {
    token: admin.token,
    body: { name: 'Legacy Integration Co', email: uniqueEmail('legacy') },
  });
  assert.equal(legacy.status, 201);
  const res = await api(app.baseUrl, 'GET', `/clients/${legacy.body.id}`, {
    token: admin.token,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.email, legacy.body.email);
});

// @suite-id: clients.update.04
test('patching a client via /clients updates the record', async () => {
  const created = await createClient({
    name: 'Patchable Plc',
    email: uniqueEmail('patch'),
  });
  const newEmail = uniqueEmail('patched');
  const res = await api(app.baseUrl, 'PATCH', `/clients/${created.id}`, {
    token: admin.token,
    body: { email: newEmail },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.email, newEmail);
});

// @suite-id: clients.delete.05
test('deleting a client via /clients removes it from both paths', async () => {
  const created = await createClient({
    name: 'Ephemeral Ltd',
    email: uniqueEmail('gone'),
  });
  const del = await api(app.baseUrl, 'DELETE', `/clients/${created.id}`, {
    token: admin.token,
  });
  assert.equal(del.status, 204);
  for (const prefix of ['/clients', '/customers']) {
    const res = await api(app.baseUrl, 'GET', `${prefix}/${created.id}`, {
      token: admin.token,
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'E_NOT_FOUND');
  }
});

// @suite-id: clients.list.06
test('the /clients list is paginated and respects explicit page and pageSize', async () => {
  for (let i = 0; i < 12; i += 1) {
    await createClient({
      name: `Paged Client ${String(i).padStart(2, '0')}`,
      email: uniqueEmail('paged'),
    });
  }
  const res = await api(app.baseUrl, 'GET', '/clients?pageSize=10&page=2', {
    token: admin.token,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.pageSize, 10);
  assert.equal(res.body.page, 2);
  assert.ok(Array.isArray(res.body.items));
  assert.ok(res.body.items.length >= 2);
  assert.ok(res.body.total >= 12);
});

// @suite-id: clients.errors.07
test('an unknown client id returns 404 in the documented envelope', async () => {
  const res = await api(app.baseUrl, 'GET', '/clients/cus_does_not_exist', {
    token: admin.token,
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'E_NOT_FOUND');
});

// @suite-id: clients.validation.08
test('creating a client with an empty body is rejected with 422 E_VALIDATION', async () => {
  const res = await api(app.baseUrl, 'POST', '/clients', {
    token: admin.token,
    body: {},
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'E_VALIDATION');
});

// @suite-id: clients.auth.09
test('listing clients without a token is rejected with the 401 envelope', async () => {
  const res = await api(app.baseUrl, 'GET', '/clients');
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'E_UNAUTHENTICATED');
});
