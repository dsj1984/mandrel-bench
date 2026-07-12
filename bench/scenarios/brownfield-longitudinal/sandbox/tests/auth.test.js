import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { startApp } from './helpers/boot.js';
import { registerAndLogin, uniqueEmail } from './helpers/fixtures.js';
import { api } from './helpers/http.js';

let app;

before(async () => {
  app = await startApp();
});

after(async () => {
  await app.stop();
});

// @suite-id: auth.register.01
test('the first registered user is created with the admin role', async () => {
  const res = await api(app.baseUrl, 'POST', '/auth/register', {
    body: { name: 'Ada Admin', email: 'ada@example.test', password: 'password-one' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.role, 'admin');
  assert.equal(res.body.name, 'Ada Admin');
  assert.equal(res.body.email, 'ada@example.test');
  assert.match(res.body.id, /^usr_/);
  assert.ok(res.body.createdAt);
});

// @suite-id: auth.register.02
test('subsequent registered users get the member role', async () => {
  const res = await api(app.baseUrl, 'POST', '/auth/register', {
    body: { name: 'Mel Member', email: 'mel@example.test', password: 'password-two' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.role, 'member');
});

// @suite-id: auth.register.03
test('registering a duplicate email is rejected with 409 E_CONFLICT', async () => {
  const res = await api(app.baseUrl, 'POST', '/auth/register', {
    body: { name: 'Ada Again', email: 'ada@example.test', password: 'password-three' },
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'E_CONFLICT');
});

// @suite-id: auth.register.04
test('registering with an invalid email is rejected with 422 E_VALIDATION', async () => {
  const res = await api(app.baseUrl, 'POST', '/auth/register', {
    body: { name: 'Bad Email', email: 'not-an-email', password: 'password-four' },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'E_VALIDATION');
});

// @suite-id: auth.register.05
test('registering with a short password is rejected with 422', async () => {
  const res = await api(app.baseUrl, 'POST', '/auth/register', {
    body: { name: 'Short', email: uniqueEmail(), password: 'short' },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'E_VALIDATION');
});

// @suite-id: auth.register.06
test('registering with missing fields reports each missing field', async () => {
  const res = await api(app.baseUrl, 'POST', '/auth/register', { body: {} });
  assert.equal(res.status, 422);
  assert.ok(res.body.error.details.some((d) => d.includes('name')));
  assert.ok(res.body.error.details.some((d) => d.includes('email')));
  assert.ok(res.body.error.details.some((d) => d.includes('password')));
});

// @suite-id: auth.register.07
test('registering with an unrecognized field is rejected', async () => {
  const res = await api(app.baseUrl, 'POST', '/auth/register', {
    body: {
      name: 'Sneaky',
      email: uniqueEmail(),
      password: 'password-seven',
      role: 'admin',
    },
  });
  assert.equal(res.status, 422);
  assert.ok(res.body.error.details.some((d) => d.includes('role')));
});

// @suite-id: auth.login.08
test('login with valid credentials returns a bearer token', async () => {
  const res = await api(app.baseUrl, 'POST', '/auth/login', {
    body: { email: 'ada@example.test', password: 'password-one' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ['token']);
  assert.equal(typeof res.body.token, 'string');
  assert.ok(res.body.token.length > 20);
});

// @suite-id: auth.login.09
test('login with the wrong password is rejected with 401 E_UNAUTHENTICATED', async () => {
  const res = await api(app.baseUrl, 'POST', '/auth/login', {
    body: { email: 'ada@example.test', password: 'wrong-password' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'E_UNAUTHENTICATED');
});

// @suite-id: auth.login.10
test('login with an unknown email is rejected with 401', async () => {
  const res = await api(app.baseUrl, 'POST', '/auth/login', {
    body: { email: 'nobody@example.test', password: 'password-one' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'E_UNAUTHENTICATED');
});

// @suite-id: auth.me.11
test('GET /auth/me returns the profile without credential material', async () => {
  const { user, token } = await registerAndLogin(app.baseUrl);
  const res = await api(app.baseUrl, 'GET', '/auth/me', { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, user.id);
  assert.equal(res.body.email, user.email);
  assert.equal(res.body.passwordHash, undefined);
  assert.equal(res.body.passwordSalt, undefined);
});

// @suite-id: auth.me.12
test('GET /auth/me without a token is rejected with 401', async () => {
  const res = await api(app.baseUrl, 'GET', '/auth/me');
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'E_UNAUTHENTICATED');
});

// @suite-id: auth.me.13
test('GET /auth/me with a garbage token is rejected with 401', async () => {
  const res = await api(app.baseUrl, 'GET', '/auth/me', {
    token: 'not.a-real-token',
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'E_UNAUTHENTICATED');
});
