import { nowIso } from '../lib/clock.js';
import { ApiError, notFound } from '../lib/errors.js';
import { newId } from '../lib/id.js';
import { buildPage } from '../lib/pagination.js';
import { findCustomerById } from '../repositories/customers.repo.js';
import { itemsTotalCents, listItemsByOrder } from '../repositories/order-items.repo.js';
import {
  countOrders,
  findOrderById,
  insertOrder,
  listOrders,
  setOrderStatus,
  setOrderTotal,
} from '../repositories/orders.repo.js';
import { paidTotalCents } from '../repositories/payments.repo.js';

export const ORDER_STATUSES = ['draft', 'issued', 'paid', 'void'];

export function createOrder({ customerId, notes }, createdBy) {
  const customer = findCustomerById(customerId);
  if (!customer) throw notFound('customer');
  const order = {
    id: newId('ord'),
    customerId,
    customerName: customer.name,
    status: 'draft',
    totalCents: 0,
    notes: notes ?? null,
    createdBy,
    createdAt: nowIso(),
  };
  insertOrder(order);
  return { ...order, issuedAt: null };
}

export function getOrderOrThrow(id) {
  const order = findOrderById(id);
  if (!order) throw notFound('order');
  return order;
}

export function getOrderDetail(id) {
  const order = getOrderOrThrow(id);
  return {
    ...order,
    items: listItemsByOrder(id),
    paidCents: paidTotalCents(id),
  };
}

export function listOrdersPage({ status, customerId, page, pageSize, offset }) {
  if (status !== undefined && !ORDER_STATUSES.includes(status)) {
    throw new ApiError(
      422,
      'E_VALIDATION',
      `status must be one of: ${ORDER_STATUSES.join(', ')}`,
    );
  }
  const items = listOrders({ status, customerId, limit: pageSize, offset });
  return buildPage(items, countOrders({ status, customerId }), page, pageSize);
}

export function issueOrder(id) {
  const order = getOrderOrThrow(id);
  if (order.status !== 'draft') {
    throw new ApiError(409, 'E_INVALID_STATUS', 'only a draft order can be issued');
  }
  if (listItemsByOrder(id).length === 0) {
    throw new ApiError(422, 'E_EMPTY_ORDER', 'an order needs at least one item before it can be issued');
  }
  setOrderStatus(id, 'issued', { issuedAt: nowIso() });
  return getOrderOrThrow(id);
}

export function voidOrder(id) {
  const order = getOrderOrThrow(id);
  if (order.status !== 'draft' && order.status !== 'issued') {
    throw new ApiError(409, 'E_INVALID_STATUS', `a ${order.status} order cannot be voided`);
  }
  setOrderStatus(id, 'void');
  return getOrderOrThrow(id);
}

export function recalcOrderTotal(id) {
  setOrderTotal(id, itemsTotalCents(id));
}
