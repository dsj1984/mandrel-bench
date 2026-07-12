import { getDb } from '../lib/db.js';

function toOrder(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    status: row.status,
    totalCents: row.total_cents,
    notes: row.notes ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    issuedAt: row.issued_at ?? null,
  };
}

export function insertOrder({
  id,
  customerId,
  customerName,
  status,
  totalCents,
  notes,
  createdBy,
  createdAt,
}) {
  getDb()
    .prepare(
      `INSERT INTO orders (id, customer_id, customer_name, status, total_cents, notes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, customerId, customerName, status, totalCents, notes, createdBy, createdAt);
}

export function findOrderById(id) {
  const row = getDb().prepare('SELECT * FROM orders WHERE id = ?').get(id);
  return row ? toOrder(row) : null;
}

function buildFilters({ status, customerId }) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (customerId) {
    clauses.push('customer_id = ?');
    params.push(customerId);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

export function listOrders({
  status = null,
  customerId = null,
  limit = 20,
  offset = 0,
} = {}) {
  const { where, params } = buildFilters({ status, customerId });
  return getDb()
    .prepare(
      `SELECT * FROM orders${where} ORDER BY created_at, id LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset)
    .map(toOrder);
}

export function countOrders({ status = null, customerId = null } = {}) {
  const { where, params } = buildFilters({ status, customerId });
  return getDb()
    .prepare(`SELECT COUNT(*) AS n FROM orders${where}`)
    .get(...params).n;
}

export function setOrderStatus(id, status, { issuedAt = null } = {}) {
  getDb()
    .prepare(
      'UPDATE orders SET status = ?, issued_at = COALESCE(?, issued_at) WHERE id = ?',
    )
    .run(status, issuedAt, id);
}

export function setOrderTotal(id, totalCents) {
  getDb()
    .prepare('UPDATE orders SET total_cents = ? WHERE id = ?')
    .run(totalCents, id);
}

export function listReceivables() {
  return getDb()
    .prepare(
      `SELECT o.customer_id AS customerId,
              o.customer_name AS customerName,
              COUNT(*) AS orderCount,
              SUM(o.total_cents - COALESCE(p.paid_cents, 0)) AS outstandingCents
       FROM orders o
       LEFT JOIN (
         SELECT order_id, SUM(amount_cents) AS paid_cents
         FROM payments
         GROUP BY order_id
       ) p ON p.order_id = o.id
       WHERE o.status = 'issued'
       GROUP BY o.customer_id, o.customer_name
       ORDER BY o.customer_name, o.customer_id`,
    )
    .all();
}
