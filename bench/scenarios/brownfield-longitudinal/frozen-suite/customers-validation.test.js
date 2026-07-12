import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { startApp } from './helpers/boot.js';
import { createCustomer, registerAndLogin } from './helpers/fixtures.js';
import { api } from './helpers/http.js';

let app;
let session;

before(async () => {
  app = await startApp();
  session = await registerAndLogin(app.baseUrl);
});

after(async () => {
  await app.stop();
});

// @suite-id: validation.envelope.01
test('a validation failure has exactly the documented error envelope shape', async () => {
  const res = await api(app.baseUrl, 'POST', '/customers', {
    token: session.token,
    body: { email: 'ap@example.test' },
  });
  assert.equal(res.status, 422);
  assert.deepEqual(Object.keys(res.body), ['error']);
  assert.deepEqual(Object.keys(res.body.error), ['code', 'message', 'details']);
});

// @suite-id: validation.envelope.02
test('a validation failure carries code E_VALIDATION and a message', async () => {
  const res = await api(app.baseUrl, 'POST', '/customers', {
    token: session.token,
    body: {},
  });
  assert.equal(res.body.error.code, 'E_VALIDATION');
  assert.equal(typeof res.body.error.message, 'string');
  assert.ok(res.body.error.message.length > 0);
});

// @suite-id: validation.fields.03
test('an empty customer name is rejected', async () => {
  const res = await api(app.baseUrl, 'POST', '/customers', {
    token: session.token,
    body: { name: '   ', email: 'ap@example.test' },
  });
  assert.equal(res.status, 422);
  assert.ok(res.body.error.details.some((d) => d.includes('name')));
});

// @suite-id: validation.fields.04
test('a non-string customer name is rejected', async () => {
  const res = await api(app.baseUrl, 'POST', '/customers', {
    token: session.token,
    body: { name: 42, email: 'ap@example.test' },
  });
  assert.equal(res.status, 422);
  assert.ok(res.body.error.details.some((d) => d.includes('name')));
});

// @suite-id: validation.fields.05
test('an invalid customer email format is rejected', async () => {
  const res = await api(app.baseUrl, 'POST', '/customers', {
    token: session.token,
    body: { name: 'Valid Name', email: 'not-an-email' },
  });
  assert.equal(res.status, 422);
  assert.ok(res.body.error.details.some((d) => d.includes('email')));
});

// @suite-id: validation.fields.06
test('an unknown field on a write is rejected, not silently dropped', async () => {
  const res = await api(app.baseUrl, 'POST', '/customers', {
    token: session.token,
    body: { name: 'Valid Name', email: 'ap@example.test', vipTier: 'gold' },
  });
  assert.equal(res.status, 422);
  assert.ok(res.body.error.details.some((d) => d.includes('vipTier')));
});

// @suite-id: validation.envelope.07
test('validation details is an array of human-readable strings', async () => {
  const res = await api(app.baseUrl, 'POST', '/customers', {
    token: session.token,
    body: {},
  });
  assert.ok(Array.isArray(res.body.error.details));
  assert.ok(res.body.error.details.length >= 2);
  for (const detail of res.body.error.details) {
    assert.equal(typeof detail, 'string');
  }
});

// @suite-id: validation.envelope.08
test('error codes are E_ prefixed UPPER_SNAKE_CASE across error classes', async () => {
  const notFoundRes = await api(app.baseUrl, 'GET', '/customers/cus_missing', {
    token: session.token,
  });
  const invalidRes = await api(app.baseUrl, 'POST', '/customers', {
    token: session.token,
    body: {},
  });
  for (const res of [notFoundRes, invalidRes]) {
    assert.match(res.body.error.code, /^E_[A-Z]+(_[A-Z]+)*$/);
  }
});

// @suite-id: validation.fields.09
test('patching a customer with a wrong-typed field is rejected', async () => {
  const created = await createCustomer(app.baseUrl, session.token);
  const res = await api(app.baseUrl, 'PATCH', `/customers/${created.id}`, {
    token: session.token,
    body: { name: false },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'E_VALIDATION');
});

// @suite-id: validation.http.10
test('a malformed JSON body is rejected with 400 E_MALFORMED_JSON', async () => {
  const res = await api(app.baseUrl, 'POST', '/customers', {
    token: session.token,
    body: '{"name": "Broken"',
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'E_MALFORMED_JSON');
});

// @suite-id: validation.http.11
test('an unknown route returns 404 in the documented envelope', async () => {
  const res = await api(app.baseUrl, 'GET', '/no/such/route', {
    token: session.token,
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'E_NOT_FOUND');
  assert.equal(typeof res.body.error.message, 'string');
});
