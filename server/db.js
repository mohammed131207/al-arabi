// قاعدة البيانات: ملف SQLite واحد بمجلد data (مدمج بـ Node، بدون تنزيل اشي)
// على الاستضافة: نسخة محلية من قاعدة Turso على النت (TURSO_DATABASE_URL)، فالبيانات ما بتضيع لما السيرفر يعيد التشغيل
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
fs.mkdirSync(BACKUP_DIR, { recursive: true });

export const HOSTED = Boolean(process.env.TURSO_DATABASE_URL);
export const DB_FILE = path.join(DATA_DIR, HOSTED ? 'turso-replica.db' : 'al-arabi.db');
export const db = await openDb();

async function openDb() {
  // DB_DRIVER=libsql بيجرّب مكتبة Turso على ملف محلي بدون نت
  if (HOSTED || process.env.DB_DRIVER === 'libsql') {
    const { default: Libsql } = await import('libsql');
    if (!HOSTED) return new Libsql(DB_FILE);
    const conn = new Libsql(DB_FILE, { syncUrl: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
    conn.sync();
    return conn;
  }
  return new DatabaseSync(DB_FILE);
}

for (const p of ['journal_mode = WAL', 'foreign_keys = ON', 'busy_timeout = 3000']) {
  try { db.exec(`PRAGMA ${p}`); } catch { /* نسخة Turso بتدير هالإعدادات لحالها */ }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS categories (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL,
    sort    INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS items (
    id          INTEGER PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    name        TEXT NOT NULL,
    price       REAL NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    sort        INTEGER NOT NULL DEFAULT 0,
    available   INTEGER NOT NULL DEFAULT 1,
    deleted     INTEGER NOT NULL DEFAULT 0
  );

  -- يوم العمل: بيبدأ لحاله وبيسكّر بزر "إغلاق اليوم" (حتى لو المطعم سهران بعد نص الليل)
  CREATE TABLE IF NOT EXISTS days (
    id        INTEGER PRIMARY KEY,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    report    TEXT
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id           INTEGER PRIMARY KEY,
    no           INTEGER NOT NULL UNIQUE,
    kind         TEXT NOT NULL,              -- table | takeaway
    table_no     INTEGER,
    label        TEXT NOT NULL DEFAULT '',   -- اسم أو رقم زبون السفري
    status       TEXT NOT NULL DEFAULT 'open', -- open | paid | void
    subtotal     REAL NOT NULL DEFAULT 0,
    discount     REAL NOT NULL DEFAULT 0,
    discount_pct REAL,
    total        REAL NOT NULL DEFAULT 0,
    method       TEXT,                       -- cash | card
    received     REAL,
    note         TEXT NOT NULL DEFAULT '',
    void_reason  TEXT,
    created_at   TEXT NOT NULL,
    paid_at      TEXT,
    day_id       INTEGER REFERENCES days(id),
    prints       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS invoices_status ON invoices(status);
  CREATE INDEX IF NOT EXISTS invoices_day ON invoices(day_id);
  CREATE INDEX IF NOT EXISTS invoices_paid ON invoices(paid_at);

  CREATE TABLE IF NOT EXISTS lines (
    id         INTEGER PRIMARY KEY,
    invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    item_id    INTEGER,
    name       TEXT NOT NULL,
    price      REAL NOT NULL,
    qty        REAL NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    source     TEXT NOT NULL DEFAULT 'cashier', -- cashier | customer
    sent       INTEGER NOT NULL DEFAULT 0,       -- انطبع للمطبخ
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS lines_invoice ON lines(invoice_id);

  -- طلبات الزباين من جوالاتهم: بتستنى الكاشير يقبلها لتدخل فاتورة الطاولة
  CREATE TABLE IF NOT EXISTS orders (
    id         INTEGER PRIMARY KEY,
    table_no   INTEGER NOT NULL,
    lines      TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    total      REAL NOT NULL,
    status     TEXT NOT NULL DEFAULT 'new', -- new | accepted | rejected
    device     TEXT,
    invoice_id INTEGER,
    created_at TEXT NOT NULL,
    handled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS orders_status ON orders(status);

  CREATE TABLE IF NOT EXISTS calls (
    id         INTEGER PRIMARY KEY,
    table_no   INTEGER NOT NULL,
    kind       TEXT NOT NULL, -- waiter | bill
    created_at TEXT NOT NULL,
    done_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id         INTEGER PRIMARY KEY,
    day_id     INTEGER REFERENCES days(id),
    amount     REAL NOT NULL,
    note       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );

  -- مين قاعد على أي طاولة (جوال الزبون)، عشان اللي بعده يعرف إنها مشغولة حتى لو لسا ما طلبوا
  CREATE TABLE IF NOT EXISTS seats (
    table_no INTEGER NOT NULL,
    device   TEXT NOT NULL,
    at       TEXT NOT NULL,
    PRIMARY KEY (table_no, device)
  );
`);

// إضافات على الجداول بعد أول نسخة (الصور)
for (const table of ['items', 'categories']) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes('image')) db.exec(`ALTER TABLE ${table} ADD COLUMN image BLOB`);
  if (!cols.includes('image_type')) db.exec(`ALTER TABLE ${table} ADD COLUMN image_type TEXT`);
  if (!cols.includes('image_v')) db.exec(`ALTER TABLE ${table} ADD COLUMN image_v INTEGER NOT NULL DEFAULT 0`);
  // أيام القسم: null = كل يوم، أو مصفوفة أيام [4] = الخميس بس (0 الأحد … 6 السبت)
  if (table === 'categories' && !cols.includes('days')) db.exec('ALTER TABLE categories ADD COLUMN days TEXT');
}

// الدفع بتطبيق: على أي تطبيق انحوّل (بنك، محفظة، جوال باي)، اسم اللي حوّل، ورقم الحوالة
{
  const cols = db.prepare('PRAGMA table_info(invoices)').all().map((c) => c.name);
  for (const c of ['pay_app', 'payer', 'pay_ref']) if (!cols.includes(c)) db.exec(`ALTER TABLE invoices ADD COLUMN ${c} TEXT`);
}

export const all = (sql, ...p) => db.prepare(sql).all(...p);
export const get = (sql, ...p) => {
  const row = db.prepare(sql).get(...p);
  if (row && '_metadata' in row) delete row._metadata; // مكتبة Turso بتزيد هالحقل
  return row;
};
export const run = (sql, ...p) => db.prepare(sql).run(...p);

export function tx(fn) {
  if (typeof db.transaction === 'function') return db.transaction(fn)(); // مكتبة Turso
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

export const now = () => new Date().toISOString();

// نسخة كاملة بملف SQLite عادي، جدول جدول (لما VACUUM INTO مش مدعوم بنسخة Turso)
export function exportCopy(file) {
  const out = new DatabaseSync(file);
  const objs = all("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%' ORDER BY type = 'index'");
  for (const o of objs) {
    out.exec(o.sql);
    if (o.type !== 'table') continue;
    const rows = all(`SELECT * FROM "${o.name}"`);
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    const ins = out.prepare(`INSERT INTO "${o.name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
    out.exec('BEGIN');
    // مكتبة Turso بترجّع الصور ArrayBuffer
    for (const r of rows) ins.run(...cols.map((c) => (r[c] instanceof ArrayBuffer ? new Uint8Array(r[c]) : r[c] ?? null)));
    out.exec('COMMIT');
  }
  out.close();
}
