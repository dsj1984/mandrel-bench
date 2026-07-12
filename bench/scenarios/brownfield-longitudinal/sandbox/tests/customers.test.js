import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { startApp } from './helpers/boot.js';
import { createCustomer, registerAndLogin } from './helpers/fixtures.js';
import { api } from './helpers/http.js';

let app;
let admin;
let member;

before(async () => {
  app = await startApp();
  admin = await registerAndLogin(app.baseUrl, { name: 'Admin' });
  member = await registerAndLogin(app.baseUrl, { name: 'Member' });
});

after(async () => {
  await app.stop();
});

// @suite-id: customers.create.01
test('creating a customer returns 201 with the stored record', async () => {
  const res = await api(app.baseUrl, 'POST', '/customers', {
    token: member.token,
    body: { name: 'Globex Corporation', email: 'ap@globex.test' },
  });
  assert.equal(res.status, 201);
  assert.match(res.body.id, /^cus_/);
  assert.equal(res.body.name, 'Globex Corporation');
  assert.equal(res.body.email, 'ap@globex.test');
  assert.ok(res.body.createdAt);
  assert.ok(res.body.updatedAt);
});

// @suite-id: customers.create.02
test('creating a customer without a token is rejected with 401', async () => {
  const res = await api(app.baseUrl, 'POST', '/customers', {
    body: { name: 'No Auth Ltd', email: 'noauth@example.test' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'E_UNAUTHENTICATED');
});

// @suite-id: customers.get.03
test('fetching a customer by id returns the record', async () => {
  const created = await createCustomer(app.baseUrl, member.token, {
    name: 'Initech LLC',
  });
  const res = await api(app.baseUrl, 'GET', `/customers/${created.id}`, {
    token: member.token,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, created.id);
  assert.equal(res.body.name, 'Initech LLC');
});

// @suite-id: customers.get.04
test('fetching an unknown customer returns 404 E_NOT_FOUND', async () => {
  const res = await api(app.baseUrl, 'GET', '/customers/cus_does_not_exist', {
    token: member.token,
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'E_NOT_FOUND');
});

// @suite-id: customers.update.05
test('patching a customer name updates the record and updatedAt', async () => {
  const created = await createCustomer(app.baseUrl, member.token);
  const res = await api(app.baseUrl, 'PATCH', `/customers/${created.id}`, {
    token: member.token,
    body: { name: 'Renamed Holdings' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Renamed Holdings');
  assert.equal(res.body.email, created.email);
});

// @suite-id: customers.update.06
test('patching a customer email updates only the email', async () => {
  const created = await createCustomer(app.baseUrl, member.token);
  const res = await api(app.baseUrl, 'PATCH', `/customers/${created.id}`, {
    token: member.token,
    body: { email: 'new-billing@example.test' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'new-billing@example.test');
  assert.equal(res.body.name, created.name);
});

// @suite-id: customers.update.07
test('patching an unknown customer returns 404', async () => {
  const res = await api(app.baseUrl, 'PATCH', '/customers/cus_missing', {
    token: member.token,
    body: { name: 'Ghost' },
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'E_NOT_FOUND');
});

// @suite-id: customers.update.08
test('patching a customer with an empty body is rejected with 422', async () => {
  const created = await createCustomer(app.baseUrl, member.token);
  const res = await api(app.baseUrl, 'PATCH', `/customers/${created.id}`, {
    token: member.token,
    body: {},
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'E_VALIDATION');
});

// @suite-id: customers.delete.09
test('an admin can delete a customer', async () => {
  const created = await createCustomer(app.baseUrl, member.token);
  const del = await api(app.baseUrl, 'DELETE', `/customers/${created.id}`, {
    token: admin.token,
  });
  assert.equal(del.status, 204);
  const gone = await api(app.baseUrl, 'GET', `/customers/${created.id}`, {
    token: member.token,
  });
  assert.equal(gone.status, 404);
});

// @suite-id: customers.delete.10
test('a member cannot delete a customer (403 E_FORBIDDEN)', async () => {
  const created = await createCustomer(app.baseUrl, member.token);
  const del = await api(app.baseUrl, 'DELETE', `/customers/${created.id}`, {
    token: member.token,
  });
  assert.equal(del.status, 403);
  assert.equal(del.body.error.code, 'E_FORBIDDEN');
  const still = await api(app.baseUrl, 'GET', `/customers/${created.id}`, {
    token: member.token,
  });
  assert.equal(still.status, 200);
});

// @suite-id: customers.delete.11
test('deleting an unknown customer returns 404 even as admin', async () => {
  const res = await api(app.baseUrl, 'DELETE', '/customers/cus_missing', {
    token: admin.token,
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'E_NOT_FOUND');
});
