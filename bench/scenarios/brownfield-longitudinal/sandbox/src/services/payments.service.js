import { nowIso } from '../lib/clock.js';
import { ApiError } from '../lib/errors.js';
import { newId } from '../lib/id.js';
import { setOrderStatus } from '../repositories/orders.repo.js';
import {
  insertPayment,
  listPaymentsByOrder,
  paidTotalCents,
} from '../repositories/payments.repo.js';
import { getOrderOrThrow } from './orders.service.js';

export function recordPayment(orderId, { amountCents, method }) {
  const order = getOrderOrThrow(orderId);
  if (order.status !== 'issued') {
    throw new ApiError(
      409,
      'E_INVALID_STATUS',
      'payments can only be recorded against an issued order',
    );
  }
  const alreadyPaid = paidTotalCents(orderId);
  const balance = order.totalCents - alreadyPaid;
  if (amountCents > balance) {
    throw new ApiError(
      422,
      'E_OVERPAYMENT',
      `payment exceeds the outstanding balance of ${balance} cents`,
    );
  }
  const payment = {
    id: newId('pay'),
    orderId,
    amountCents,
    method,
    receivedAt: nowIso(),
  };
  insertPayment(payment);
  if (alreadyPaid + amountCents === order.totalCents) {
    setOrderStatus(orderId, 'paid');
  }
  return payment;
}

export function listPayments(orderId) {
  getOrderOrThrow(orderId);
  return listPaymentsByOrder(orderId);
}
