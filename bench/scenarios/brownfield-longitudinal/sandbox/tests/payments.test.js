import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { startApp } from './helpers/boot.js';
import {
  createCustomer,
  createIssuedOrder,
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

// The default issued-order fixture totals 2500 cents (2 x 1250).

// @suite-id: payments.record.01
test('recording a payment returns 201 with the stored payment', async () => {
  const order = await createIssuedOrder(app.baseUrl, session.token, customer.id);
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/payments`, {
    token: session.token,
    body: { amountCents: 1000, method: 'card' },
  });
  assert.equal(res.status, 201);
  assert.match(res.body.id, /^pay_/);
  assert.equal(res.body.orderId, order.id);
  assert.equal(res.body.amountCents, 1000);
  assert.equal(res.body.method, 'card');
  assert.ok(res.body.receivedAt);
});

// @suite-id: payments.record.02
test('a partial payment leaves the order issued and shows in paidCents', async () => {
  const order = await createIssuedOrder(app.baseUrl, session.token, customer.id);
  await api(app.baseUrl, 'POST', `/orders/${order.id}/payments`, {
    token: session.token,
    body: { amountCents: 500, method: 'cash' },
  });
  const fetched = await api(app.baseUrl, 'GET', `/orders/${order.id}`, {
    token: session.token,
  });
  assert.equal(fetched.body.status, 'issued');
  assert.equal(fetched.body.paidCents, 500);
});

// @suite-id: payments.record.03
test('a payment exceeding the outstanding balance is rejected with 422 E_OVERPAYMENT', async () => {
  const order = await createIssuedOrder(app.baseUrl, session.token, customer.id);
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/payments`, {
    token: session.token,
    body: { amountCents: order.totalCents + 1, method: 'bank_transfer' },
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'E_OVERPAYMENT');
});

// @suite-id: payments.record.04
test('a payment matching the balance exactly settles the order', async () => {
  const order = await createIssuedOrder(app.baseUrl, session.token, customer.id);
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/payments`, {
    token: session.token,
    body: { amountCents: order.totalCents, method: 'bank_transfer' },
  });
  assert.equal(res.status, 201);
  const fetched = await api(app.baseUrl, 'GET', `/orders/${order.id}`, {
    token: session.token,
  });
  assert.equal(fetched.body.status, 'paid');
  assert.equal(fetched.body.paidCents, order.totalCents);
});

// @suite-id: payments.record.05
test('multiple partial payments accumulate to settle the order', async () => {
  const order = await createIssuedOrder(app.baseUrl, session.token, customer.id);
  await api(app.baseUrl, 'POST', `/orders/${order.id}/payments`, {
    token: session.token,
    body: { amountCents: 1500, method: 'card' },
  });
  const second = await api(app.baseUrl, 'POST', `/orders/${order.id}/payments`, {
    token: session.token,
    body: { amountCents: 1000, method: 'cash' },
  });
  assert.equal(second.status, 201);
  const fetched = await api(app.baseUrl, 'GET', `/orders/${order.id}`, {
    token: session.token,
  });
  assert.equal(fetched.body.status, 'paid');
});

// @suite-id: payments.record.06
test('a zero or negative payment amount is rejected with 422', async () => {
  const order = await createIssuedOrder(app.baseUrl, session.token, customer.id);
  for (const amountCents of [0, -100]) {
    const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/payments`, {
      token: session.token,
      body: { amountCents, method: 'card' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'E_VALIDATION');
  }
});

// @suite-id: payments.record.07
test('a fractional payment amount is rejected — money is integer cents', async () => {
  const order = await createIssuedOrder(app.baseUrl, session.token, customer.id);
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/payments`, {
    token: session.token,
    body: { amountCents: 10.5, method: 'card' },
  });
  assert.equal(res.status, 422);
  assert.ok(res.body.error.details.some((d) => d.includes('amountCents')));
});

// @suite-id: payments.record.08
test('an unrecognized payment method is rejected with 422', async () => {
  const order = await createIssuedOrder(app.baseUrl, session.token, customer.id);
  const res = await api(app.baseUrl, 'POST', `/orders/${order.id}/payments`, {
    token: session.token,
    body: { amountCents: 100, method: 'barter' },
  });
  assert.equal(res.status, 422);
  assert.ok(res.body.error.details.some((d) => d.includes('method')));
});

// @suite-id: payments.list.09
test('listing payments returns the recorded payments for the order', async () => {
  const order = await createIssuedOrder(app.baseUrl, session.token, customer.id);
  await api(app.baseUrl, 'POST', `/orders/${order.id}/payments`, {
    token: session.token,
    body: { amountCents: 400, method: 'cash' },
  });
  await api(app.baseUrl, 'POST', `/orders/${order.id}/payments`, {
    token: session.token,
    body: { amountCents: 600, method: 'card' },
  });
  const res = await api(app.baseUrl, 'GET', `/orders/${order.id}/payments`, {
    token: session.token,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  assert.deepEqual(
    res.body.map((payment) => payment.amountCents),
    [400, 600],
  );
});

// @suite-id: payments.record.10
test('recording a payment against an unknown order returns 404', async () => {
  const res = await api(app.baseUrl, 'POST', '/orders/ord_missing/payments', {
    token: session.token,
    body: { amountCents: 100, method: 'card' },
  });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'E_NOT_FOUND');
});
