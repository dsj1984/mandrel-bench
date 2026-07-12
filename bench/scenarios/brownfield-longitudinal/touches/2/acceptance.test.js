// Frozen behavioural additions for touch 2 (role management) — issue #124
// PR-B. The immediate-effect probes (04, 05) are the landmine L1 detectors:
// the seed's auth middleware trusts the role EMBEDDED in an already-issued
// token, so an implementation that only updates the users row keeps stale
// tokens authorised (or unauthorised) until they expire — these probes
// exercise a pre-change token immediately after the role change.
//
// Chain-stability notes: user registration keeps its seed shape on every
// later touch; the customer fixture used by the promotion probe goes
// through POST /customers, which touch 3 aliases and touch 4 keeps
// accepting single-`name` writes on. GET /users may be a plain array or a
// paginated envelope — both are accepted so touch-5's default-page-size
// bump cannot destabilise this suite.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { startApp } from './helpers/boot.js';
import { createCustomer, registerAndLogin } from './helpers/fixtures.js';
import { api } from './helpers/http.js';

let app;
let rootAdmin; // first registration — the seed makes the first user admin

function usersOf(body) {
  return Array.isArray(body) ? body : (body?.items ?? []);
}

async function setRole(actorToken, userId, role) {
  return api(app.baseUrl, 'PATCH', `/users/${userId}/role`, {
    token: actorToken,
    body: { role },
  });
}

before(async () => {
  app = await startApp();
  rootAdmin = await registerAndLogin(app.baseUrl, { name: 'Root Admin' });
});

after(async () => {
  await app.stop();
});

// @suite-id: roles.list.01
test('an admin can list users with id, name, email and role', async () => {
  const res = await api(app.baseUrl, 'GET', '/users', { token: rootAdmin.token });
  assert.equal(res.status, 200);
  const users = usersOf(res.body);
  const self = users.find((u) => u.id === rootAdmin.user.id);
  assert.ok(self, 'the requesting admin appears in the list');
  assert.equal(self.role, 'admin');
  assert.equal(typeof self.name, 'string');
  assert.equal(typeof self.email, 'string');
});

// @suite-id: roles.list.02
test('a member cannot list users (403 E_FORBIDDEN)', async () => {
  const member = await registerAndLogin(app.baseUrl, { name: 'Nosy Member' });
  const res = await api(app.baseUrl, 'GET', '/users', { token: member.token });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'E_FORBIDDEN');
});

// @suite-id: roles.change.03
test('an admin can change a member role to admin', async () => {
  const member = await registerAndLogin(app.baseUrl, { name: 'Rising Star' });
  const res = await setRole(rootAdmin.token, member.user.id, 'admin');
  assert.equal(res.status, 200);
  const listed = await api(app.baseUrl, 'GET', '/users', {
    token: rootAdmin.token,
  });
  const updated = usersOf(listed.body).find((u) => u.id === member.user.id);
  assert.equal(updated.role, 'admin');
});

// @suite-id: roles.revocation.04
test('a promotion takes effect immediately for an already-issued token', async () => {
  const member = await registerAndLogin(app.baseUrl, { name: 'Promoted Member' });
  const customer = await createCustomer(app.baseUrl, rootAdmin.token, {
    name: 'Promotion Probe Ltd',
  });
  // With their pre-promotion token, customer deletion is member-forbidden.
  const denied = await api(app.baseUrl, 'DELETE', `/customers/${customer.id}`, {
    token: member.token,
  });
  assert.equal(denied.status, 403);
  const promoted = await setRole(rootAdmin.token, member.user.id, 'admin');
  assert.equal(promoted.status, 200);
  // The SAME token — issued while still a member — is admin immediately.
  const allowed = await api(app.baseUrl, 'DELETE', `/customers/${customer.id}`, {
    token: member.token,
  });
  assert.equal(allowed.status, 204);
});

// @suite-id: roles.revocation.05
test('a demotion revokes admin access immediately for an already-issued token', async () => {
  const second = await registerAndLogin(app.baseUrl, { name: 'Temporary Admin' });
  assert.equal((await setRole(rootAdmin.token, second.user.id, 'admin')).status, 200);
  // Confirm the pre-demotion token holds admin access to the report.
  const beforeDemotion = await api(app.baseUrl, 'GET', '/reports/receivables', {
    token: second.token,
  });
  assert.equal(beforeDemotion.status, 200);
  assert.equal((await setRole(rootAdmin.token, second.user.id, 'member')).status, 200);
  // The SAME token — issued as admin — is member immediately.
  const afterDemotion = await api(app.baseUrl, 'GET', '/reports/receivables', {
    token: second.token,
  });
  assert.equal(afterDemotion.status, 403);
  assert.equal(afterDemotion.body.error.code, 'E_FORBIDDEN');
});

// @suite-id: roles.change.06
test('a member cannot change roles (403 E_FORBIDDEN)', async () => {
  const member = await registerAndLogin(app.baseUrl, { name: 'Ambitious Member' });
  const res = await setRole(member.token, member.user.id, 'admin');
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'E_FORBIDDEN');
});

// @suite-id: roles.validation.07
test('an unrecognised role value is rejected with 422 E_VALIDATION', async () => {
  const member = await registerAndLogin(app.baseUrl, { name: 'Odd Role Member' });
  const res = await setRole(rootAdmin.token, member.user.id, 'superuser');
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'E_VALIDATION');
});

// @suite-id: roles.guard.08
test('the last remaining admin cannot be demoted', async () => {
  // Earlier probes promoted users (03, 04) — demote every other admin first
  // so rootAdmin is provably the last one standing.
  const listed = await api(app.baseUrl, 'GET', '/users', {
    token: rootAdmin.token,
  });
  const otherAdmins = usersOf(listed.body).filter(
    (u) => u.role === 'admin' && u.id !== rootAdmin.user.id,
  );
  for (const admin of otherAdmins) {
    const demoted = await setRole(rootAdmin.token, admin.id, 'member');
    assert.equal(demoted.status, 200);
  }
  const res = await setRole(rootAdmin.token, rootAdmin.user.id, 'member');
  assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
  assert.match(res.body.error.code, /^E_[A-Z]+(_[A-Z]+)*$/);
});

// @suite-id: roles.errors.09
test('changing the role of an unknown user returns 404 E_NOT_FOUND', async () => {
  const res = await setRole(rootAdmin.token, 'usr_missing', 'member');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'E_NOT_FOUND');
});
