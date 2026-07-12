import { nowIso } from '../lib/clock.js';
import { ApiError, notFound } from '../lib/errors.js';
import { newId } from '../lib/id.js';
import { buildPage } from '../lib/pagination.js';
import {
  countCustomers,
  findCustomerById,
  insertCustomer,
  listCustomers,
  removeCustomer,
  updateCustomer,
} from '../repositories/customers.repo.js';

export function createCustomer({ name, email }) {
  const now = nowIso();
  const customer = {
    id: newId('cus'),
    name,
    email,
    createdAt: now,
    updatedAt: now,
  };
  insertCustomer(customer);
  return customer;
}

export function getCustomer(id) {
  const customer = findCustomerById(id);
  if (!customer) throw notFound('customer');
  return customer;
}

export function listCustomersPage({ page, pageSize, offset }) {
  const items = listCustomers({ limit: pageSize, offset });
  return buildPage(items, countCustomers(), page, pageSize);
}

export function patchCustomer(id, { name, email }) {
  getCustomer(id);
  if (name === undefined && email === undefined) {
    throw new ApiError(422, 'E_VALIDATION', 'at least one field is required');
  }
  updateCustomer(id, { name, email }, nowIso());
  return getCustomer(id);
}

export function deleteCustomer(id) {
  getCustomer(id);
  removeCustomer(id);
}
