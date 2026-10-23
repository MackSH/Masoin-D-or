'use strict';
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const START_BALANCE = 100000; // en centimes : 1 000 jetons

function open(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'casino.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      username     TEXT UNIQUE COLLATE NOCASE,
      pass_hash    TEXT,
      display_name TEXT NOT NULL,
      is_guest     INTEGER NOT NULL DEFAULT 0,
      balance      INTEGER NOT NULL DEFAULT ${START_BALANCE} CHECK (balance >= 0),
      wagered      INTEGER NOT NULL DEFAULT 0,
      won          INTEGER NOT NULL DEFAULT 0,
      played       INTEGER NOT NULL DEFAULT 0,
      best         INTEGER NOT NULL DEFAULT 0,
      sound        INTEGER NOT NULL DEFAULT 1,
      favs         TEXT NOT NULL DEFAULT '["slots"]',
      bets         TEXT NOT NULL DEFAULT '{}',
      created_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,          -- game | deposit | reset
      game       TEXT NOT NULL,
      stake      INTEGER NOT NULL DEFAULT 0,
      payout     INTEGER NOT NULL DEFAULT 0,
      net        INTEGER NOT NULL DEFAULT 0,
      details    TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tx_user ON transactions(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS tx_game ON transactions(game, id DESC);
    CREATE TABLE IF NOT EXISTS active_rounds (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game       TEXT NOT NULL,
      stake      INTEGER NOT NULL,
      state      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, game)
    );
  `);
  return db;
}

module.exports = { open, START_BALANCE };
