// SQLite access (Node's built-in node:sqlite, no npm dependencies).
// One file per shop deployment; backed up continuously off-machine.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Open (and migrate) a database. Use ':memory:' in tests. */
export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db, { backupBefore: file !== ':memory:' ? file : null });
  return db;
}

/**
 * Apply every migrations/NNN_*.sql not yet applied, each in its own transaction.
 * With backupBefore, a complete copy of the database is written next to it
 * before the first pending migration runs (the newest 5 copies are kept).
 */
export function migrate(db, { backupBefore = null } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const pending = files.filter((f) => !done.has(f));
  if (backupBefore && pending.length && done.size) backupDatabase(db, backupBefore, `pre-${pending[0].replace(/\.sql$/, '')}`);
  for (const f of files) {
    if (done.has(f)) continue;
    tx(db, () => {
      db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(f);
    });
  }
  return files;
}

/** Run fn inside a write transaction; roll back on any error. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Write a complete, consistent copy of the database (VACUUM INTO is safe while
 * the database is in use). Keeps the newest `keep` copies.
 * @returns {string} path of the copy
 */
export function backupDatabase(db, file, label = 'manual', { keep = 5 } = {}) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(dir, `${base}.${label}.${stamp}.bak`);
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.`) && f.endsWith('.bak')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - keep))) fs.rmSync(path.join(dir, f));
  return out;
}
