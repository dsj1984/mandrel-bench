import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { runMigrations } from '../db/migrate.js';
import { logger } from './logger.js';

let db = null;

export function openDb({ dbPath } = {}) {
  if (db) return db;
  const resolved = path.resolve(
    dbPath ?? process.env.LEDGERLINE_DB_PATH ?? path.join('data', 'ledgerline.db'),
  );
  mkdirSync(path.dirname(resolved), { recursive: true });
  db = new DatabaseSync(resolved);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  const applied = runMigrations(db);
  logger.info('database ready', {
    dbPath: resolved,
    migrationsApplied: applied.length,
  });
  return db;
}

export function getDb() {
  if (!db) throw new Error('database is not open — call openDb() first');
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
