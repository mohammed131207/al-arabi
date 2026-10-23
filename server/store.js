// منطق البرنامج كله: الفواتير، طلبات الزباين، النداءات، المصاريف، الأيام والتقارير
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, tx, getSetting, setSetting, now, db, BACKUP_DIR, exportCopy } from './db.js';
import { DEFAULT_SETTINGS, hashPin } from './seed.js';

export class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (msg, status) => { throw new UserError(msg, status); };

export const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const clean = (s, max = 200) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const num = (v, msg) => {
  const n = Number(v);
  if (!Number.isFinite(n)) fail(msg);
  return n;
};

// ───── الإعدادات ─────

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'nextInvoiceNo');

export function settings() {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = getSetting(k, DEFAULT_SETTINGS[k]);
  return out;
}

export function publicSettings() {
  const s = settings();
  return { name: s.name, phone: s.phone, address: s.address, currency: s.currency, acceptOrders: s.acceptOrders };
}

export function updateSettings(patch) {
  const s = settings();
  for (const k of SETTING_KEYS) {
    if (!(k in patch)) continue;
    let v = patch[k];
    if (k === 'payApps') {
      if (!Array.isArray(v)) fail('قائمة التطبيقات غلط');
      v = [...new Set(v.map((x) => clean(x, 30)).filter(Boolean))];
      if (v.length > 10) fail('أكثر إشي 10 تطبيقات');
    } else if (k === 'zones') {
      if (!Array.isArray(v) || !v.length) fail('لازم يكون في منطقة وحدة على الأقل');
      v = v.map((z) => ({ name: clean(z.name, 40) || 'الصالة', count: Math.max(0, Math.min(200, Math.round(num(z.count, 'عدد الطاولات مش رقم')))) }));
      if (v.reduce((a, z) => a + z.count, 0) < 1) fail('لازم يكون في طاولة وحدة على الأقل');
      const max = v.reduce((a, z) => a + z.count, 0);
      const busy = get("SELECT MAX(table_no) AS m FROM invoices WHERE status = 'open' AND kind = 'table'")?.m;
      if (busy && busy > max) fail(`طاولة ${busy} لسا عليها فاتورة مفتوحة، سكّرها قبل ما تقلّل الطاولات`);
    } else if (k === 'paper') {
      v = Number(v) === 58 ? 58 : 80;
    } else if (k === 'receiptLogoMm') {
      v = Math.max(12, Math.min(60, Math.round(num(v, 'طول الشعار مش رقم'))));
    } else if (typeof DEFAULT_SETTINGS[k] === 'boolean') {
      v = Boolean(v);
    } else {
      v = clean(v, k === 'receiptFooter' || k === 'address' ? 160 : 80);
    }
    if (k === 'name' && !v) fail('اكتب اسم المطعم');
    if (k === 'currency' && !v) v = '₪';
    setSetting(k, v);
  }
  return { ...s, ...settings() };
}

export function tables() {
  const out = [];
  let no = 1;
  for (const z of getSetting('zones', DEFAULT_SETTINGS.zones)) {
    for (let i = 0; i < z.count; i++) out.push({ no: no++, zone: z.name });
  }
  return out;
}

const tableExists = (n) => Number.isInteger(n) && n >= 1 && n <= tables().length;

// ───── الدخول ─────

export function login(pin) {
  const saved = getSetting('pin');
  const { hash } = hashPin(String(pin ?? ''), saved.salt);
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(saved.hash))) return null;
  const token = crypto.randomBytes(24).toString('hex');
  run('INSERT INTO sessions (token, created_at) VALUES (?, ?)', token, now());
  return token;
}

export const validToken = (t) => Boolean(t && get('SELECT 1 AS ok FROM sessions WHERE token = ?', String(t)));
export const logout = (t) => run('DELETE FROM sessions WHERE token = ?', String(t));

export function changePin(oldPin, newPin) {
  if (!/^\d{4,8}$/.test(String(newPin ?? ''))) fail('الرمز الجديد لازم يكون من 4 لـ 8 أرقام');
  const saved = getSetting('pin');
  if (hashPin(String(oldPin ?? ''), saved.salt).hash !== saved.hash) fail('الرمز الحالي غلط');
  setSetting('pin', hashPin(newPin));
}

// ───── القائمة ─────

const imgUrl = (kind, id, v) => (v ? `/img/${kind}/${id}?v=${v}` : null);

// يوم الشغل: لحد الساعة 4 الفجر بنحسبه على اليوم اللي قبله (سهرة الخميس بتضل خميس)
export const workWeekday = () => new Date(Date.now() - 4 * 3600e3).getDay();
const parseDays = (d) => { try { const a = JSON.parse(d); return Array.isArray(a) && a.length && a.length < 7 ? a : null; } catch { return null; } };

export function menu({ forCustomer = false } = {}) {
  const wd = workWeekday();
  const categories = all('SELECT id, name, sort, image_v, days FROM categories WHERE deleted = 0 ORDER BY sort, id')
    .map(({ image_v: v, days, ...c }) => {
      const d = parseDays(days);
      return { ...c, image: imgUrl('category', c.id, v), days: d, today: !d || d.includes(wd) };
    });
  const items = all(`SELECT id, category_id AS categoryId, name, price, note, sort, available, image_v FROM items
                     WHERE deleted = 0 ${forCustomer ? 'AND available = 1' : ''} ORDER BY sort, id`)
    .map(({ image_v: v, ...i }) => ({ ...i, available: Boolean(i.available), image: imgUrl('item', i.id, v) }));
  return { categories, items };
}

// الأكثر طلباً آخر 30 يوم (لمنيو الزبون)
export function popular(limit = 8) {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  return all(`SELECT l.item_id AS id, SUM(l.qty) AS n FROM lines l JOIN invoices i ON i.id = l.invoice_id
              WHERE i.status = 'paid' AND i.paid_at > ? AND l.item_id IS NOT NULL
              GROUP BY l.item_id ORDER BY n DESC LIMIT ?`, since, limit).map((r) => r.id);
}

// ───── الصور (محفوظة جوّا قاعدة البيانات، فالنسخة الاحتياطية فيها كل اشي) ─────

const IMG_TABLE = { item: 'items', category: 'categories' };

export function getImage(kind, id) {
  const t = IMG_TABLE[kind];
  if (!t) return null;
  const row = get(`SELECT image, image_type FROM ${t} WHERE id = ?`, id);
  return row?.image ? { data: Buffer.from(row.image), type: row.image_type || 'image/jpeg' } : null;
}

export function setImage(kind, id, data, type) {
  const t = IMG_TABLE[kind];
  if (!t || !get(`SELECT id FROM ${t} WHERE id = ? AND deleted = 0`, id)) fail('مش موجود', 404);
  if (!/^image\/(jpeg|png|webp)$/.test(type)) fail('الصورة لازم تكون JPG أو PNG أو WEBP');
  if (!data?.length) fail('الصورة فاضية');
  if (data.length > 3 * 1024 * 1024) fail('الصورة كبيرة كتير (أكثر من 3 ميغا)');
  run(`UPDATE ${t} SET image = ?, image_type = ?, image_v = image_v + 1 WHERE id = ?`, data, type, id);
}

export function clearImage(kind, id) {
  const t = IMG_TABLE[kind];
  if (!t) fail('مش موجود', 404);
  run(`UPDATE ${t} SET image = NULL, image_type = NULL, image_v = 0 WHERE id = ?`, id);
}

export function saveCategory(id, body) {
  const name = clean(body.name, 40);
  if (!name) fail('اكتب اسم القسم');
  let days = null;
  if (Array.isArray(body.days)) {
    const d = [...new Set(body.days.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
    if (!d.length) fail('اختار يوم واحد على الأقل');
    days = d.length === 7 ? null : JSON.stringify(d);
  }
  if (id) {
    if (!get('SELECT id FROM categories WHERE id = ? AND deleted = 0', id)) fail('القسم مش موجود', 404);
    if ('days' in body) run('UPDATE categories SET name = ?, days = ? WHERE id = ?', name, days, id);
    else run('UPDATE categories SET name = ? WHERE id = ?', name, id);
    return id;
  }
  const sort = (get('SELECT MAX(sort) AS m FROM categories')?.m ?? -1) + 1;
  return Number(run('INSERT INTO categories (name, sort, days) VALUES (?, ?, ?)', name, sort, days).lastInsertRowid);
}

export function deleteCategory(id) {
  if (get('SELECT id FROM items WHERE category_id = ? AND deleted = 0 LIMIT 1', id)) fail('فرّغ القسم من الأصناف أول، أو انقلهم لقسم تاني');
  run('UPDATE categories SET deleted = 1 WHERE id = ?', id);
}

export function moveCategory(id, dir) {
  const cats = all('SELECT id FROM categories WHERE deleted = 0 ORDER BY sort, id').map((c) => c.id);
  const i = cats.indexOf(id);
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= cats.length) return;
  [cats[i], cats[j]] = [cats[j], cats[i]];
  tx(() => cats.forEach((cid, k) => run('UPDATE categories SET sort = ? WHERE id = ?', k, cid)));
}

export function saveItem(id, body) {
  const name = clean(body.name, 60);
  if (!name) fail('اكتب اسم الصنف');
  const price = r2(num(body.price, 'السعر لازم يكون رقم'));
  if (price < 0) fail('السعر ما بصير يكون بالسالب');
  const categoryId = Number(body.categoryId);
  if (!get('SELECT id FROM categories WHERE id = ? AND deleted = 0', categoryId)) fail('اختار القسم');
  const note = clean(body.note, 120);
  const available = body.available === undefined ? 1 : (body.available ? 1 : 0);
  if (id) {
    if (!get('SELECT id FROM items WHERE id = ? AND deleted = 0', id)) fail('الصنف مش موجود', 404);
    run('UPDATE items SET name = ?, price = ?, category_id = ?, note = ?, available = ? WHERE id = ?', name, price, categoryId, note, available, id);
    return id;
  }
  const sort = (get('SELECT MAX(sort) AS m FROM items WHERE category_id = ?', categoryId)?.m ?? -1) + 1;
  return Number(run('INSERT INTO items (category_id, name, price, note, sort, available) VALUES (?, ?, ?, ?, ?, ?)', categoryId, name, price, note, sort, available).lastInsertRowid);
}

export const setAvailable = (id, on) => run('UPDATE items SET available = ? WHERE id = ?', on ? 1 : 0, id);
export const deleteItem = (id) => run('UPDATE items SET deleted = 1 WHERE id = ?', id);

// ───── الفواتير ─────

function invoiceRow(id) {
  return get('SELECT * FROM invoices WHERE id = ?', id);
}

export function invoice(id) {
  const i = invoiceRow(id);
  if (!i) return null;
  const lines = all('SELECT id, item_id AS itemId, name, price, qty, note, source, sent FROM lines WHERE invoice_id = ? ORDER BY id', id)
    .map((l) => ({ ...l, sent: Boolean(l.sent) }));
  return {
    id: i.id, no: i.no, kind: i.kind, table: i.table_no, label: i.label, status: i.status,
    subtotal: i.subtotal, discount: i.discount, discountPct: i.discount_pct, total: i.total,
    method: i.method === 'card' ? 'app' : i.method, received: i.received, payApp: i.pay_app, payer: i.payer, payRef: i.pay_ref,
    note: i.note, voidReason: i.void_reason,
    createdAt: i.created_at, paidAt: i.paid_at, dayId: i.day_id, prints: i.prints, lines,
  };
}

export const openInvoices = () => all("SELECT id FROM invoices WHERE status = 'open' ORDER BY id").map((r) => invoice(r.id));

function mustOpen(id) {
  const i = invoiceRow(id);
  if (!i) fail('الفاتورة مش موجودة', 404);
  if (i.status !== 'open') fail(i.status === 'paid' ? 'هاي الفاتورة مدفوعة ومسكّرة' : 'هاي الفاتورة ملغية');
  return i;
}

function recalc(id) {
  const i = invoiceRow(id);
  const subtotal = r2(get('SELECT COALESCE(SUM(price * qty), 0) AS s FROM lines WHERE invoice_id = ?', id).s);
  let discount = i.discount_pct != null ? r2(subtotal * i.discount_pct / 100) : Math.min(i.discount, subtotal);
  discount = r2(Math.max(0, discount));
  run('UPDATE invoices SET subtotal = ?, discount = ?, total = ? WHERE id = ?', subtotal, discount, r2(subtotal - discount), id);
}

function nextNo() {
  const no = getSetting('nextInvoiceNo', 1);
  const used = get('SELECT MAX(no) AS m FROM invoices')?.m ?? 0;
  const n = Math.max(no, used + 1);
  setSetting('nextInvoiceNo', n + 1);
  return n;
}

function createInvoice({ kind, table, label = '' }) {
  if (kind === 'table') {
    if (!tableExists(table)) fail('رقم الطاولة مش موجود');
    const open = get("SELECT id FROM invoices WHERE status = 'open' AND kind = 'table' AND table_no = ?", table);
    if (open) return open.id;
  }
  const no = nextNo();
  const { lastInsertRowid } = run('INSERT INTO invoices (no, kind, table_no, label, created_at) VALUES (?, ?, ?, ?, ?)',
    no, kind === 'table' ? 'table' : 'takeaway', kind === 'table' ? table : null, clean(label, 40), now());
  return Number(lastInsertRowid);
}

// الفاتورة الفاضية اللي ما انطبعت بتنمسح، ورقمها برجع إذا كان آخر رقم
function dropIfEmpty(id) {
  const i = invoiceRow(id);
  if (!i || i.status !== 'open' || i.prints > 0) return false;
  if (get('SELECT id FROM lines WHERE invoice_id = ? LIMIT 1', id)) return false;
  run('DELETE FROM invoices WHERE id = ?', id);
  if (getSetting('nextInvoiceNo') === i.no + 1) setSetting('nextInvoiceNo', i.no);
  return true;
}

function insertLine(invoiceId, { itemId, name, price, qty, note = '', source = 'cashier' }) {
  const same = get(`SELECT id, qty FROM lines WHERE invoice_id = ? AND item_id IS ? AND price = ? AND note = ? AND sent = 0`,
    invoiceId, itemId ?? null, price, note);
  if (same) run('UPDATE lines SET qty = ? WHERE id = ?', r2(same.qty + qty), same.id);
  else run('INSERT INTO lines (invoice_id, item_id, name, price, qty, note, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    invoiceId, itemId ?? null, name, price, qty, note, source, now());
}

export function addItem({ invoiceId, table, kind, label, itemId, qty = 1 }) {
  return tx(() => {
    const item = get('SELECT id, name, price FROM items WHERE id = ? AND deleted = 0', Number(itemId));
    if (!item) fail('الصنف مش موجود');
    qty = r2(num(qty, 'الكمية مش رقم'));
    if (qty <= 0 || qty > 999) fail('الكمية مش منطقية');
    const id = invoiceId ? mustOpen(Number(invoiceId)).id : createInvoice({ kind: kind || 'table', table: Number(table), label });
    insertLine(id, { itemId: item.id, name: item.name, price: item.price, qty });
    recalc(id);
    return id;
  });
}

export function updateLine(lineId, body) {
  return tx(() => {
    const l = get('SELECT * FROM lines WHERE id = ?', lineId);
    if (!l) fail('السطر مش موجود', 404);
    mustOpen(l.invoice_id);
    const qty = body.qty !== undefined ? r2(num(body.qty, 'الكمية مش رقم')) : l.qty;
    if (qty > 999) fail('الكمية كبيرة كتير');
    if (qty <= 0) {
      run('DELETE FROM lines WHERE id = ?', lineId);
    } else {
      const price = body.price !== undefined ? r2(num(body.price, 'السعر مش رقم')) : l.price;
      if (price < 0) fail('السعر ما بصير يكون بالسالب');
      const note = body.note !== undefined ? clean(body.note, 80) : l.note;
      run('UPDATE lines SET qty = ?, price = ?, note = ? WHERE id = ?', qty, price, note, lineId);
    }
    recalc(l.invoice_id);
    return dropIfEmpty(l.invoice_id) ? { invoiceId: l.invoice_id, deleted: true } : { invoiceId: l.invoice_id };
  });
}

export function deleteLine(lineId) {
  return updateLine(lineId, { qty: 0 });
}

export function updateInvoice(id, body) {
  return tx(() => {
    const i = mustOpen(id);
    if ('discountPct' in body || 'discount' in body) {
      if (body.discountPct != null && body.discountPct !== '') {
        const pct = num(body.discountPct, 'نسبة الخصم مش رقم');
        if (pct < 0 || pct > 100) fail('نسبة الخصم لازم تكون بين 0 و 100');
        run('UPDATE invoices SET discount_pct = ? WHERE id = ?', pct || null, id);
      } else {
        const amount = r2(num(body.discount || 0, 'قيمة الخصم مش رقم'));
        if (amount < 0) fail('الخصم ما بصير يكون بالسالب');
        if (amount > i.subtotal) fail('الخصم أكبر من المجموع');
        run('UPDATE invoices SET discount = ?, discount_pct = NULL WHERE id = ?', amount, id);
      }
    }
    if ('note' in body) run('UPDATE invoices SET note = ? WHERE id = ?', clean(body.note, 120), id);
    if ('label' in body) run('UPDATE invoices SET label = ? WHERE id = ?', clean(body.label, 40), id);
    recalc(id);
    return id;
  });
}

// نقل فاتورة لطاولة تانية. إذا الطاولة عليها فاتورة، الصنفين بيندمجوا بفاتورتها
export function moveInvoice(id, toTable) {
  return tx(() => {
    const i = mustOpen(id);
    toTable = Number(toTable);
    if (!tableExists(toTable)) fail('رقم الطاولة مش موجود');
    if (i.kind === 'table' && i.table_no === toTable) return id;
    const target = get("SELECT id, no FROM invoices WHERE status = 'open' AND kind = 'table' AND table_no = ? AND id != ?", toTable, id);
    if (!target) {
      run("UPDATE invoices SET kind = 'table', table_no = ? WHERE id = ?", toTable, id);
      return id;
    }
    for (const l of all('SELECT * FROM lines WHERE invoice_id = ? ORDER BY id', id)) {
      run('INSERT INTO lines (invoice_id, item_id, name, price, qty, note, source, sent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        target.id, l.item_id, l.name, l.price, l.qty, l.note, l.source, l.sent, l.created_at);
    }
    run('DELETE FROM lines WHERE invoice_id = ?', id);
    recalc(id);
    if (!dropIfEmpty(id)) run("UPDATE invoices SET status = 'void', void_reason = ? WHERE id = ?", `اندمجت بفاتورة ${target.no}`, id);
    recalc(target.id);
    return target.id;
  });
}

// الدفع: نقدي (مع المبلغ المدفوع)، أو تطبيق (على أي تطبيق انحوّل واسم اللي حوّل)
export function pay(id, { method = 'cash', received, app, payer, ref } = {}) {
  return tx(() => {
    const i = mustOpen(id);
    if (!get('SELECT id FROM lines WHERE invoice_id = ? LIMIT 1', id)) fail('الفاتورة فاضية');
    method = method === 'app' || method === 'card' ? 'app' : 'cash';
    let rec = received === undefined || received === null || received === '' ? i.total : r2(num(received, 'المبلغ المدفوع مش رقم'));
    let payApp = null; let payerName = null; let payRef = null;
    if (method === 'app') {
      payApp = clean(app, 30);
      if (!payApp || !getSetting('payApps', DEFAULT_SETTINGS.payApps).includes(payApp)) fail('اختار على أي تطبيق انحوّل المبلغ');
      payerName = clean(payer, 60);
      if (!payerName) fail('اكتب اسم اللي حوّل');
      payRef = clean(ref, 40) || null;
      rec = i.total;
    } else if (rec < i.total) fail('المبلغ المدفوع أقل من المطلوب');
    run("UPDATE invoices SET status = 'paid', method = ?, received = ?, pay_app = ?, payer = ?, pay_ref = ?, paid_at = ?, day_id = ? WHERE id = ?",
      method, rec, payApp, payerName, payRef, now(), currentDay().id, id);
    // نداءات "بدنا الحساب" لهالطاولة خلصت
    if (i.kind === 'table') run('UPDATE calls SET done_at = ? WHERE table_no = ? AND done_at IS NULL', now(), i.table_no);
    // دفعوا وقاموا: الطاولة صارت فاضية للي بعدهم
    if (i.kind === 'table') run('DELETE FROM seats WHERE table_no = ?', i.table_no);
    return id;
  });
}

export function voidInvoice(id, reason) {
  return tx(() => {
    const i = invoiceRow(id);
    if (!i) fail('الفاتورة مش موجودة', 404);
    if (i.status === 'void') fail('الفاتورة ملغية من قبل');
    reason = clean(reason, 120);
    if (i.status === 'paid') {
      if (i.day_id !== currentDay().id) fail('هاي الفاتورة من يوم مسكّر، ما بتنلغى');
      if (!reason) fail('اكتب سبب إلغاء الفاتورة المدفوعة');
    }
    if (i.status === 'open' && dropIfEmpty(id)) return { deleted: true };
    run("UPDATE invoices SET status = 'void', void_reason = ?, day_id = COALESCE(day_id, ?) WHERE id = ?", reason || 'إلغاء', currentDay().id, id);
    return { deleted: false };
  });
}

// أسطر المطبخ اللي لسا ما انطبعت (أو كل الأسطر إذا all)
export function kitchenLines(id, { all: everything = false } = {}) {
  return tx(() => {
    const i = invoiceRow(id);
    if (!i) fail('الفاتورة مش موجودة', 404);
    const lines = all(`SELECT id, name, qty, note FROM lines WHERE invoice_id = ? ${everything ? '' : 'AND sent = 0'} ORDER BY id`, id);
    if (lines.length) run(`UPDATE lines SET sent = 1 WHERE invoice_id = ?`, id);
    return lines;
  });
}

export const markPrinted = (id) => run('UPDATE invoices SET prints = prints + 1 WHERE id = ?', id);

export function listInvoices({ from, to, status, q, limit = 300 }) {
  const where = [];
  const p = [];
  if (status && status !== 'all') { where.push('status = ?'); p.push(status); }
  if (from) { where.push('COALESCE(paid_at, created_at) >= ?'); p.push(from); }
  if (to) { where.push('COALESCE(paid_at, created_at) < ?'); p.push(to); }
  if (q) {
    const n = Number(q);
    if (Number.isInteger(n)) { where.push('(no = ? OR table_no = ?)'); p.push(n, n); }
    else { where.push('(label LIKE ? OR payer LIKE ? OR pay_ref LIKE ?)'); const t = `%${clean(q, 40)}%`; p.push(t, t, t); }
  }
  return all(`SELECT id, no, kind, table_no AS "table", label, status, total, discount, CASE method WHEN 'card' THEN 'app' ELSE method END AS method,
              pay_app AS payApp, payer, pay_ref AS payRef, created_at AS createdAt, paid_at AS paidAt, void_reason AS voidReason
              FROM invoices ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, ...p, Math.min(1000, limit));
}

// ───── طلبات الزباين ─────

const parseOrder = (o) => o && ({
  id: o.id, table: o.table_no, lines: JSON.parse(o.lines), note: o.note, total: o.total,
  status: o.status, invoiceId: o.invoice_id, createdAt: o.created_at, handledAt: o.handled_at,
});

export const DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const dayNames = (days) => days.map((d) => `يوم ${DAY_NAMES[d]}`).join(' و');

export const pendingOrders = () => all("SELECT * FROM orders WHERE status = 'new' ORDER BY id").map(parseOrder);
export const order = (id) => parseOrder(get('SELECT * FROM orders WHERE id = ?', id));

export function createOrder({ table, lines, note, device }) {
  if (!getSetting('acceptOrders', true)) fail('الطلب من الجوال موقّف هلأ، اطلب من الجرسون');
  table = Number(table);
  if (!tableExists(table)) fail('رقم الطاولة مش موجود');
  if (!Array.isArray(lines) || !lines.length) fail('السلة فاضية');
  if (lines.length > 40) fail('الطلب كبير كتير، قسّمه على طلبين');
  const waiting = get("SELECT COUNT(*) AS n FROM orders WHERE table_no = ? AND status = 'new'", table).n;
  if (waiting >= 5) fail('في طلبات لسا ما وصلت للكاشير، استنى شوي');
  const out = [];
  for (const l of lines) {
    const item = get(`SELECT i.id, i.name, i.price, i.available, c.name AS cat, c.days FROM items i
                      JOIN categories c ON c.id = i.category_id WHERE i.id = ? AND i.deleted = 0`, Number(l.itemId));
    if (!item) fail('في صنف بالسلة انشال من القائمة، حدّث الصفحة');
    if (!item.available) fail(`${item.name} خلص هلأ`);
    const days = parseDays(item.days);
    if (days && !days.includes(workWeekday())) fail(`${item.name} من قسم ${item.cat}، بيتوفّر ${dayNames(days)} بس`);
    const qty = Math.round(Number(l.qty));
    if (!(qty >= 1 && qty <= 50)) fail('الكمية مش منطقية');
    out.push({ itemId: item.id, name: item.name, price: item.price, qty, note: clean(l.note, 80) });
  }
  const total = r2(out.reduce((a, l) => a + l.price * l.qty, 0));
  const { lastInsertRowid } = run('INSERT INTO orders (table_no, lines, note, total, device, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    table, JSON.stringify(out), clean(note, 160), total, clean(device, 64) || null, now());
  return order(Number(lastInsertRowid));
}

export function acceptOrder(id) {
  return tx(() => {
    const o = order(id);
    if (!o) fail('الطلب مش موجود', 404);
    if (o.status !== 'new') fail('الطلب انتعامل معه من قبل');
    const invoiceId = createInvoice({ kind: 'table', table: o.table });
    for (const l of o.lines) {
      insertLine(invoiceId, { itemId: l.itemId, name: l.name, price: l.price, qty: l.qty, note: l.note, source: 'customer' });
    }
    if (o.note) {
      const inv = invoiceRow(invoiceId);
      run('UPDATE invoices SET note = ? WHERE id = ?', clean([inv.note, o.note].filter(Boolean).join(' · '), 120), invoiceId);
    }
    recalc(invoiceId);
    run("UPDATE orders SET status = 'accepted', invoice_id = ?, handled_at = ? WHERE id = ?", invoiceId, now(), id);
    return { order: order(id), invoiceId };
  });
}

export function rejectOrder(id) {
  const o = order(id);
  if (!o) fail('الطلب مش موجود', 404);
  if (o.status !== 'new') fail('الطلب انتعامل معه من قبل');
  run("UPDATE orders SET status = 'rejected', handled_at = ? WHERE id = ?", now(), id);
  return order(id);
}

// الطاولة مشغولة إذا عليها فاتورة مفتوحة أو طلب لسا ما انقبل. mine: هالجوال طالب عليها من قبل
// الجوال بيضل "قاعد" على الطاولة طول ما المنيو مفتوح (بيبعت كل 5 دقايق)، وبينحسب قاعد 45 دقيقة بعد آخر مرة
const SEAT_TTL = 45 * 60e3;
const seatSince = () => new Date(Date.now() - SEAT_TTL).toISOString();

export function tableStatus(no, device) {
  no = Number(no);
  if (!tableExists(no)) return { exists: false };
  device = clean(device, 64);
  const others = get('SELECT device FROM seats WHERE table_no = ? AND device != ? AND at > ? LIMIT 1', no, device, seatSince());
  const busy = Boolean(get("SELECT id FROM invoices WHERE status = 'open' AND kind = 'table' AND table_no = ? LIMIT 1", no)
    || get("SELECT id FROM orders WHERE status = 'new' AND table_no = ? LIMIT 1", no)
    || others);
  const since = new Date(Date.now() - 12 * 3600e3).toISOString();
  const mine = Boolean(device && (get('SELECT device FROM seats WHERE table_no = ? AND device = ? AND at > ?', no, device, seatSince())
    || get("SELECT id FROM orders WHERE table_no = ? AND device = ? AND status != 'rejected' AND created_at > ? LIMIT 1", no, device, since)));
  return { exists: true, busy, mine };
}

// الجوال قعد على هالطاولة (وبيقوم عن أي طاولة تانية)
export function sit(no, device) {
  no = Number(no);
  device = clean(device, 64);
  if (!tableExists(no) || !device) fail('رقم الطاولة مش موجود');
  tx(() => {
    run('DELETE FROM seats WHERE device = ? AND table_no != ?', device, no);
    run('INSERT INTO seats (table_no, device, at) VALUES (?, ?, ?) ON CONFLICT(table_no, device) DO UPDATE SET at = excluded.at', no, device, now());
    run('DELETE FROM seats WHERE at < ?', new Date(Date.now() - 24 * 3600e3).toISOString());
  });
}

export function deviceOrders(device) {
  const since = new Date(Date.now() - 12 * 3600e3).toISOString();
  return all('SELECT * FROM orders WHERE device = ? AND created_at > ? ORDER BY id DESC LIMIT 10', clean(device, 64), since).map(parseOrder);
}

// ───── النداءات ─────

export const pendingCalls = () => all('SELECT id, table_no AS "table", kind, created_at AS createdAt FROM calls WHERE done_at IS NULL ORDER BY id');

export function createCall(table, kind) {
  table = Number(table);
  if (!tableExists(table)) fail('رقم الطاولة مش موجود');
  kind = kind === 'bill' ? 'bill' : 'waiter';
  const open = get('SELECT id FROM calls WHERE table_no = ? AND kind = ? AND done_at IS NULL', table, kind);
  if (!open) run('INSERT INTO calls (table_no, kind, created_at) VALUES (?, ?, ?)', table, kind, now());
}

export const doneCall = (id) => run('UPDATE calls SET done_at = ? WHERE id = ? AND done_at IS NULL', now(), id);

// ───── اليوم والمصاريف والتقارير ─────

export function currentDay() {
  let d = get('SELECT * FROM days WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1');
  if (!d) {
    run('INSERT INTO days (opened_at) VALUES (?)', now());
    d = get('SELECT * FROM days WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1');
  }
  return d;
}

export function addExpense(amount, note) {
  amount = r2(num(amount, 'المبلغ مش رقم'));
  if (amount <= 0) fail('اكتب مبلغ المصروف');
  note = clean(note, 80);
  if (!note) fail('اكتب على شو المصروف');
  run('INSERT INTO expenses (day_id, amount, note, created_at) VALUES (?, ?, ?, ?)', currentDay().id, amount, note, now());
}

export function deleteExpense(id) {
  const e = get('SELECT * FROM expenses WHERE id = ?', id);
  if (!e) fail('المصروف مش موجود', 404);
  if (e.day_id !== currentDay().id) fail('هاد المصروف من يوم مسكّر');
  run('DELETE FROM expenses WHERE id = ?', id);
}

export const dayExpenses = (dayId) => all('SELECT id, amount, note, created_at AS createdAt FROM expenses WHERE day_id = ? ORDER BY id', dayId);

// الملخص لأي مجموعة فواتير: شرط SQL على جدول الفواتير (i) ومصاريفها
function summarize(invWhere, invParams, expWhere, expParams) {
  const s = get(`SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total, COALESCE(SUM(subtotal), 0) AS gross,
                 COALESCE(SUM(discount), 0) AS discounts,
                 COALESCE(SUM(CASE WHEN method = 'cash' THEN total END), 0) AS cash,
                 COALESCE(SUM(CASE WHEN method IN ('app', 'card') THEN total END), 0) AS app,
                 MIN(no) AS firstNo, MAX(no) AS lastNo
                 FROM invoices i WHERE status = 'paid' AND ${invWhere}`, ...invParams);
  const v = get(`SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total FROM invoices i WHERE status = 'void' AND ${invWhere}`, ...invParams);
  const items = all(`SELECT l.name, SUM(l.qty) AS qty, SUM(l.qty * l.price) AS amount
                     FROM lines l JOIN invoices i ON i.id = l.invoice_id
                     WHERE i.status = 'paid' AND ${invWhere}
                     GROUP BY COALESCE(l.item_id, l.name), l.name ORDER BY amount DESC`, ...invParams)
    .map((x) => ({ name: x.name, qty: r2(x.qty), amount: r2(x.amount) }));
  const expenses = r2(get(`SELECT COALESCE(SUM(amount), 0) AS t FROM expenses e WHERE ${expWhere}`, ...expParams).t);
  // الحوالات: كم حوالة ومجموعها على كل تطبيق، والقائمة كاملة عشان المطابقة مع البنك والمحفظة
  const cashCount = get(`SELECT COUNT(*) AS n FROM invoices i WHERE status = 'paid' AND method = 'cash' AND ${invWhere}`, ...invParams).n;
  const byApp = all(`SELECT COALESCE(pay_app, 'تطبيق') AS app, COUNT(*) AS count, SUM(total) AS total
                     FROM invoices i WHERE status = 'paid' AND method IN ('app', 'card') AND ${invWhere}
                     GROUP BY COALESCE(pay_app, 'تطبيق') ORDER BY total DESC`, ...invParams)
    .map((x) => ({ ...x, total: r2(x.total) }));
  const transfers = all(`SELECT no, total, COALESCE(pay_app, 'تطبيق') AS app, payer, pay_ref AS ref, paid_at AS at
                         FROM invoices i WHERE status = 'paid' AND method IN ('app', 'card') AND ${invWhere}
                         ORDER BY paid_at LIMIT 2000`, ...invParams);
  const total = r2(s.total);
  return {
    count: s.count, total, gross: r2(s.gross), discounts: r2(s.discounts), cash: r2(s.cash), cashCount, app: r2(s.app), byApp, transfers,
    average: s.count ? r2(total / s.count) : 0, firstNo: s.firstNo, lastNo: s.lastNo,
    voids: { count: v.count, total: r2(v.total) }, items, expenses, net: r2(total - expenses),
  };
}

export function dayReport(dayId = currentDay().id) {
  const d = get('SELECT * FROM days WHERE id = ?', dayId);
  if (!d) fail('اليوم مش موجود', 404);
  if (d.report) return JSON.parse(d.report);
  const open = get("SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS t FROM invoices WHERE status = 'open'");
  return {
    dayId: d.id, openedAt: d.opened_at, closedAt: d.closed_at,
    ...summarize('i.day_id = ?', [dayId], 'e.day_id = ?', [dayId]),
    expenseList: dayExpenses(dayId),
    open: { count: open.n, total: r2(open.t) },
  };
}

export function closeDay() {
  const d = currentDay();
  const report = { ...dayReport(d.id), closedAt: now() };
  tx(() => {
    run('UPDATE days SET closed_at = ?, report = ? WHERE id = ?', report.closedAt, JSON.stringify(report), d.id);
    run('INSERT INTO days (opened_at) VALUES (?)', now());
  });
  const file = backup(`day-${d.id}`);
  return { report, backup: path.basename(file) };
}

export function days(limit = 60) {
  return all('SELECT id, opened_at AS openedAt, closed_at AS closedAt, report FROM days ORDER BY id DESC LIMIT ?', limit)
    .map((d) => {
      const r = d.report ? JSON.parse(d.report) : dayReport(d.id);
      return { id: d.id, openedAt: d.openedAt, closedAt: d.closedAt, count: r.count, total: r.total, expenses: r.expenses, net: r.net };
    });
}

export function rangeReport(from, to) {
  const r = summarize('i.paid_at >= ? AND i.paid_at < ?', [from, to], 'e.created_at >= ? AND e.created_at < ?', [from, to]);
  const byDay = all(`SELECT date(paid_at, 'localtime') AS day, COUNT(*) AS count, SUM(total) AS total
                     FROM invoices WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?
                     GROUP BY day ORDER BY day`, from, to).map((x) => ({ ...x, total: r2(x.total) }));
  return { from, to, ...r, byDay };
}

export function backup(tag = 'manual') {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const file = path.join(BACKUP_DIR, `al-arabi-${stamp}-${tag}.db`);
  try {
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  } catch {
    fs.rmSync(file, { force: true });
    exportCopy(file);
  }
  return file;
}
