import { getDb } from '../lib/db.js';

function toCustomer(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertCustomer({ id, name, email, createdAt, updatedAt }) {
  getDb()
    .prepare(
      `INSERT INTO customers (id, name, email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, name, email, createdAt, updatedAt);
}

export function findCustomerById(id) {
  const row = getDb().prepare('SELECT * FROM customers WHERE id = ?').get(id);
  return row ? toCustomer(row) : null;
}

export function listCustomers({ limit, offset }) {
  return getDb()
    .prepare(
      'SELECT * FROM customers ORDER BY created_at, id LIMIT ? OFFSET ?',
    )
    .all(limit, offset)
    .map(toCustomer);
}

export function countCustomers() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM customers').get().n;
}

export function updateCustomer(id, { name, email }, updatedAt) {
  getDb()
    .prepare(
      `UPDATE customers
       SET name = COALESCE(?, name),
           email = COALESCE(?, email),
           updated_at = ?
       WHERE id = ?`,
    )
    .run(name ?? null, email ?? null, updatedAt, id);
}

export function removeCustomer(id) {
  const result = getDb().prepare('DELETE FROM customers WHERE id = ?').run(id);
  return result.changes > 0;
}
