import { nowIso } from '../lib/clock.js';
import { ApiError, notFound } from '../lib/errors.js';
import { newId } from '../lib/id.js';
import {
  findOrderItemById,
  insertOrderItem,
  listItemsByOrder,
  removeOrderItem,
} from '../repositories/order-items.repo.js';
import { getOrderOrThrow, recalcOrderTotal } from './orders.service.js';

function assertDraft(order, action) {
  if (order.status !== 'draft') {
    throw new ApiError(409, 'E_INVALID_STATUS', `items can only be ${action} on a draft order`);
  }
}

export function addItem(orderId, { description, quantity, unitPriceCents }) {
  const order = getOrderOrThrow(orderId);
  assertDraft(order, 'added');
  const item = {
    id: newId('itm'),
    orderId,
    description,
    quantity,
    unitPriceCents,
    createdAt: nowIso(),
  };
  insertOrderItem(item);
  recalcOrderTotal(orderId);
  return item;
}

export function listItems(orderId) {
  getOrderOrThrow(orderId);
  return listItemsByOrder(orderId);
}

export function removeItem(orderId, itemId) {
  const order = getOrderOrThrow(orderId);
  assertDraft(order, 'removed');
  const item = findOrderItemById(itemId);
  if (!item || item.orderId !== orderId) throw notFound('order item');
  removeOrderItem(itemId);
  recalcOrderTotal(orderId);
}
