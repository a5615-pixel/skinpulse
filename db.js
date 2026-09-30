const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir =
  process.env.DATA_DIR ||
  path.join(__dirname, 'data');

fs.mkdirSync(
  dataDir,
  {
    recursive: true
  }
);

const databasePath =
  path.join(
    dataDir,
    'skinpulse.db'
  );

console.log(
  `Base de dados: ${databasePath}`
);

const db =
  new Database(
    databasePath
  );

db.pragma(
  'journal_mode = WAL'
);

db.pragma(
  'foreign_keys = ON'
);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'EUR',
    status TEXT NOT NULL DEFAULT 'created',
    mollie_payment_id TEXT UNIQUE,
    steam_id TEXT,
    goal TEXT,
    auto_report TEXT,
    final_report TEXT,
    created_at TEXT NOT NULL,
    paid_at TEXT,
    delivered_at TEXT,
    FOREIGN KEY (user_id)
      REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_orders_user_id
    ON orders(user_id);

  CREATE INDEX IF NOT EXISTS idx_orders_status
    ON orders(status);
`);

const migrations = [
  "ALTER TABLE orders ADD COLUMN payment_method TEXT",
  "ALTER TABLE orders ADD COLUMN manual_payment_note TEXT",
  "ALTER TABLE orders ADD COLUMN manual_payment_claimed_at TEXT"
];

for (
  const sql of migrations
) {
  try {
    db.exec(sql);
  } catch (error) {
    if (
      !String(
        error.message
      ).includes(
        'duplicate column name'
      )
    ) {
      throw error;
    }
  }
}

module.exports = db;