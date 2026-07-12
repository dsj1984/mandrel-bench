import { getDb } from '../lib/db.js';

function toUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    role: row.role,
    createdAt: row.created_at,
  };
}

export function insertUser({
  id,
  name,
  email,
  passwordHash,
  passwordSalt,
  role,
  createdAt,
}) {
  getDb()
    .prepare(
      `INSERT INTO users (id, name, email, password_hash, password_salt, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, name, email, passwordHash, passwordSalt, role, createdAt);
}

export function findUserByEmail(email) {
  const row = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);
  return row ? toUser(row) : null;
}

export function findUserById(id) {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  return row ? toUser(row) : null;
}

export function countUsers() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}
