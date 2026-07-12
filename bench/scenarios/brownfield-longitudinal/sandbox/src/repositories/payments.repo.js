import { getDb } from '../lib/db.js';

function toPayment(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    amountCents: row.amount_cents,
    method: row.method,
    receivedAt: row.received_at,
  };
}

export function insertPayment({ id, orderId, amountCents, method, receivedAt }) {
  getDb()
    .prepare(
      `INSERT INTO payments (id, order_id, amount_cents, method, received_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, orderId, amountCents, method, receivedAt);
}

export function listPaymentsByOrder(orderId) {
  return getDb()
    .prepare(
      'SELECT * FROM payments WHERE order_id = ? ORDER BY received_at, rowid',
    )
    .all(orderId)
    .map(toPayment);
}

export function paidTotalCents(orderId) {
  return getDb()
    .prepare(
      'SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments WHERE order_id = ?',
    )
    .get(orderId).total;
}
