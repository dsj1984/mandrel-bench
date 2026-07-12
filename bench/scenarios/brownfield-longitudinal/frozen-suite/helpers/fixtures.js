import { randomUUID } from 'node:crypto';

import { api } from './http.js';

export function uniqueEmail(prefix = 'user') {
  return `${prefix}-${randomUUID()}@example.test`;
}

async function expectStatus(res, status, label) {
  if (res.status !== status) {
    throw new Error(
      `${label} failed: expected ${status}, got ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return res.body;
}

export async function registerAndLogin(baseUrl, overrides = {}) {
  const email = overrides.email ?? uniqueEmail();
  const password = overrides.password ?? 'correct-horse-battery-staple';
  const name = overrides.name ?? 'Test User';
  const reg = await api(baseUrl, 'POST', '/auth/register', {
    body: { name, email, password },
  });
  const user = await expectStatus(reg, 201, 'register');
  const login = await api(baseUrl, 'POST', '/auth/login', {
    body: { email, password },
  });
  const session = await expectStatus(login, 200, 'login');
  return { user, token: session.token, email, password };
}

export async function createCustomer(baseUrl, token, overrides = {}) {
  const res = await api(baseUrl, 'POST', '/customers', {
    token,
    body: {
      name: overrides.name ?? 'Acme Pty Ltd',
      email: overrides.email ?? uniqueEmail('billing'),
    },
  });
  return expectStatus(res, 201, 'create customer');
}

export async function createDraftOrder(baseUrl, token, customerId, overrides = {}) {
  const res = await api(baseUrl, 'POST', '/orders', {
    token,
    body: { customerId, ...overrides },
  });
  return expectStatus(res, 201, 'create order');
}

export async function addOrderItem(baseUrl, token, orderId, overrides = {}) {
  const res = await api(baseUrl, 'POST', `/orders/${orderId}/items`, {
    token,
    body: {
      description: overrides.description ?? 'Widget',
      quantity: overrides.quantity ?? 2,
      unitPriceCents: overrides.unitPriceCents ?? 1250,
    },
  });
  return expectStatus(res, 201, 'add order item');
}

export async function createIssuedOrder(baseUrl, token, customerId, overrides = {}) {
  const order = await createDraftOrder(baseUrl, token, customerId);
  const items = overrides.items ?? [{}];
  for (const item of items) {
    await addOrderItem(baseUrl, token, order.id, item);
  }
  const issued = await api(baseUrl, 'POST', `/orders/${order.id}/issue`, {
    token,
  });
  return expectStatus(issued, 200, 'issue order');
}
