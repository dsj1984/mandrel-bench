import { getDb } from '../lib/db.js';

function toItem(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    description: row.description,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    createdAt: row.created_at,
  };
}

export function insertOrderItem({
  id,
  orderId,
  description,
  quantity,
  unitPriceCents,
  createdAt,
}) {
  getDb()
    .prepare(
      `INSERT INTO order_items (id, order_id, description, quantity, unit_price_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, orderId, description, quantity, unitPriceCents, createdAt);
}

export function findOrderItemById(id) {
  const row = getDb()
    .prepare('SELECT * FROM order_items WHERE id = ?')
    .get(id);
  return row ? toItem(row) : null;
}

export function listItemsByOrder(orderId) {
  return getDb()
    .prepare(
      'SELECT * FROM order_items WHERE order_id = ? ORDER BY created_at, rowid',
    )
    .all(orderId)
    .map(toItem);
}

export function removeOrderItem(id) {
  const result = getDb()
    .prepare('DELETE FROM order_items WHERE id = ?')
    .run(id);
  return result.changes > 0;
}

export function itemsTotalCents(orderId) {
  return getDb()
    .prepare(
      `SELECT COALESCE(SUM(quantity * unit_price_cents), 0) AS total
       FROM order_items WHERE order_id = ?`,
    )
    .get(orderId).total;
}
