// سيرفر مطعم العربي: بيشتغل على لابتوب الكاشير، والزباين بيوصلوله من شبكة المطعم
import express from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { seed } from './seed.js';
import { get as dbGet, BACKUP_DIR, DB_FILE, HOSTED } from './db.js';
import * as S from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3030;

seed();
S.currentDay();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.disable('x-powered-by');
if (process.env.RENDER) app.set('trust proxy', 1); // ورا بروكسي Render: عنوان الزبون الحقيقي لعدّاد محاولات الرمز

// رابط الموقع على النت (Render بيعطيه لحاله)
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use(express.json({ limit: '200kb' }));

// ───── عناوين الجهاز على الشبكة (للـ QR) ─────

export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const virtual = /vmware|virtualbox|vethernet|hyper-v|loopback|docker|wsl/i.test(name);
      out.push({ name, address: a.address, virtual });
    }
  }
  const rank = (a) => (a.virtual ? 2 : 0) + (a.address.startsWith('192.168.') ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b));
}

const siteUrl = () => S.settings().publicUrl || PUBLIC_URL || `http://${lanAddresses()[0]?.address || 'localhost'}:${PORT}`;

// ───── البث المباشر ─────

const emitInvoice = (id) => {
  const inv = S.invoice(id);
  io.to('cashier').emit('invoice', inv || { id, deleted: true });
  return inv;
};
const emitOrders = () => io.to('cashier').emit('orders', S.pendingOrders());
const emitCalls = () => io.to('cashier').emit('calls', S.pendingCalls());
const emitMenu = () => {
  io.to('cashier').emit('menu', S.menu());
  io.to('public').emit('menu', { ...S.menu({ forCustomer: true }), settings: S.publicSettings() });
};
const emitStats = () => io.to('cashier').emit('day', S.dayReport());
const emitOrderStatus = (o) => o && io.to(`device:${o.device}`).emit('order', o);

// ───── الحماية ─────

const fails = new Map();
function pinGuard(req, res, next) {
  const key = req.ip;
  const f = fails.get(key);
  if (f && f.until > Date.now()) return res.status(429).json({ error: `محاولات كتير، جرّب بعد ${Math.ceil((f.until - Date.now()) / 1000)} ثانية` });
  next();
}

const tokenOf = (req) => req.get('x-token') || '';
function auth(req, res, next) {
  if (!S.validToken(tokenOf(req))) return res.status(401).json({ error: 'سجّل دخول من جديد' });
  next();
}

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e) {
    if (e instanceof S.UserError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'صار خطأ بالبرنامج، جرّب كمان مرة' });
  }
};
const id = (req, k = 'id') => Number(req.params[k]);

// ───── للزباين ─────

const pub = express.Router();

pub.get('/menu', wrap(() => ({ ...S.menu({ forCustomer: true }), popular: S.popular(), settings: S.publicSettings(), tables: S.tables().length })));

pub.post('/orders', wrap((req) => {
  const o = S.createOrder(req.body || {});
  emitOrders();
  return o;
}));

pub.get('/devices/:device/orders', wrap((req) => S.deviceOrders(req.params.device)));

pub.post('/calls', wrap((req) => {
  S.createCall(req.body?.table, req.body?.kind);
  emitCalls();
}));

app.use('/api/public', pub);

// ───── للكاشير ─────

const api = express.Router();

api.post('/login', pinGuard, wrap((req) => {
  const token = S.login(req.body?.pin);
  if (!token) {
    const f = fails.get(req.ip) || { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= 5) { f.until = Date.now() + 30e3; f.n = 0; }
    fails.set(req.ip, f);
    throw new S.UserError('الرمز غلط', 401);
  }
  fails.delete(req.ip);
  return { token };
}));

api.use(auth);

api.post('/logout', wrap((req) => S.logout(tokenOf(req))));

api.get('/state', wrap(() => ({
  settings: S.settings(),
  tables: S.tables(),
  menu: S.menu(),
  invoices: S.openInvoices(),
  orders: S.pendingOrders(),
  calls: S.pendingCalls(),
  day: S.dayReport(),
  site: siteUrl(),
  addresses: lanAddresses().map((a) => a.address),
})));

// الفواتير
api.post('/invoices/add', wrap((req) => {
  const invId = S.addItem(req.body || {});
  return emitInvoice(invId);
}));
api.get('/invoices', wrap((req) => S.listInvoices(req.query)));
api.get('/invoices/:id', wrap((req) => S.invoice(id(req)) || (() => { throw new S.UserError('الفاتورة مش موجودة', 404); })()));
api.patch('/invoices/:id', wrap((req) => emitInvoice(S.updateInvoice(id(req), req.body || {}))));
api.post('/invoices/:id/move', wrap((req) => {
  const target = S.moveInvoice(id(req), req.body?.table);
  if (target !== id(req)) emitInvoice(id(req));
  return emitInvoice(target);
}));
api.post('/invoices/:id/pay', wrap((req) => {
  const inv = emitInvoice(S.pay(id(req), req.body || {}));
  emitCalls();
  emitStats();
  return inv;
}));
api.post('/invoices/:id/void', wrap((req) => {
  S.voidInvoice(id(req), req.body?.reason);
  emitStats();
  return emitInvoice(id(req)) || { id: id(req), deleted: true };
}));
api.post('/invoices/:id/printed', wrap((req) => { S.markPrinted(id(req)); return emitInvoice(id(req)); }));
api.post('/invoices/:id/kitchen', wrap((req) => {
  const lines = S.kitchenLines(id(req), { all: Boolean(req.body?.all) });
  return { lines, invoice: emitInvoice(id(req)) };
}));
api.patch('/lines/:id', wrap((req) => {
  const r = S.updateLine(id(req), req.body || {});
  return emitInvoice(r.invoiceId) || { id: r.invoiceId, deleted: true };
}));
api.delete('/lines/:id', wrap((req) => {
  const r = S.deleteLine(id(req));
  return emitInvoice(r.invoiceId) || { id: r.invoiceId, deleted: true };
}));

// طلبات الزباين والنداءات
api.post('/orders/:id/accept', wrap((req) => {
  const { order, invoiceId } = S.acceptOrder(id(req));
  emitOrders();
  emitOrderStatus({ ...order, ...rawDevice(order.id) });
  return emitInvoice(invoiceId);
}));
api.post('/orders/:id/reject', wrap((req) => {
  const o = S.rejectOrder(id(req));
  emitOrders();
  emitOrderStatus({ ...o, ...rawDevice(o.id) });
  return o;
}));
api.post('/calls/:id/done', wrap((req) => { S.doneCall(id(req)); emitCalls(); }));

// القائمة
api.post('/categories', wrap((req) => { const newId = S.saveCategory(null, req.body || {}); emitMenu(); return { ...S.menu(), id: newId }; }));
api.put('/categories/:id', wrap((req) => { S.saveCategory(id(req), req.body || {}); emitMenu(); return { ...S.menu(), id: id(req) }; }));
api.post('/categories/:id/move', wrap((req) => { S.moveCategory(id(req), Number(req.body?.dir)); emitMenu(); return S.menu(); }));
api.delete('/categories/:id', wrap((req) => { S.deleteCategory(id(req)); emitMenu(); return S.menu(); }));
api.post('/items', wrap((req) => { const newId = S.saveItem(null, req.body || {}); emitMenu(); return { ...S.menu(), id: newId }; }));
api.put('/items/:id', wrap((req) => { S.saveItem(id(req), req.body || {}); emitMenu(); return { ...S.menu(), id: id(req) }; }));
api.post('/items/:id/available', wrap((req) => { S.setAvailable(id(req), req.body?.available); emitMenu(); return S.menu(); }));
api.delete('/items/:id', wrap((req) => { S.deleteItem(id(req)); emitMenu(); return S.menu(); }));

// صور الأصناف والأقسام: الصورة نفسها بجسم الطلب (بعد ما المتصفح يصغّرها)
const rawImage = express.raw({ type: 'image/*', limit: '3mb' });
for (const kind of ['item', 'category']) {
  const base = kind === 'item' ? '/items' : '/categories';
  api.put(`${base}/:id/image`, rawImage, wrap((req) => { S.setImage(kind, id(req), req.body, req.get('content-type')); emitMenu(); return S.menu(); }));
  api.delete(`${base}/:id/image`, wrap((req) => { S.clearImage(kind, id(req)); emitMenu(); return S.menu(); }));
}

// الإعدادات
api.put('/settings', wrap((req) => {
  const s = S.updateSettings(req.body || {});
  io.to('cashier').emit('settings', { settings: s, tables: S.tables(), site: siteUrl() });
  emitMenu();
  return { settings: s, tables: S.tables(), site: siteUrl() };
}));
api.post('/pin', wrap((req) => S.changePin(req.body?.old, req.body?.pin)));

// اليوم والمصاريف والتقارير
api.get('/day', wrap(() => S.dayReport()));
api.get('/days', wrap(() => S.days()));
api.get('/days/:id', wrap((req) => S.dayReport(id(req))));
api.post('/day/close', wrap(() => {
  const r = S.closeDay();
  emitStats();
  return r;
}));
api.post('/expenses', wrap((req) => { S.addExpense(req.body?.amount, req.body?.note); emitStats(); return S.dayReport(); }));
api.delete('/expenses/:id', wrap((req) => { S.deleteExpense(id(req)); emitStats(); return S.dayReport(); }));
api.get('/reports', wrap((req) => {
  const { from, to } = req.query;
  if (!from || !to) throw new S.UserError('اختار الفترة');
  return S.rangeReport(String(from), String(to));
}));
api.get('/backup', (req, res) => {
  try {
    const file = S.backup('download');
    res.download(file, path.basename(file));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'ما زبطت النسخة الاحتياطية' });
  }
});

app.use('/api', api);

// جهاز الطلب محفوظ بالقاعدة بس مش راجع بـ order() (خصوصية)، فبنجيبه هون للبث بس
function rawDevice(orderId) {
  return { device: dbGet('SELECT device FROM orders WHERE id = ?', orderId)?.device };
}

// ───── الصفحات ─────

app.get('/img/:kind/:id', (req, res) => {
  const img = S.getImage(req.params.kind, Number(req.params.id));
  if (!img) return res.status(404).end();
  res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.type(img.type).send(img.data);
});

app.use('/vendor/qrcode.js', express.static(path.join(ROOT, 'node_modules/qrcode-generator/qrcode.js')));
app.use('/vendor/fonts/plex', express.static(path.join(ROOT, 'node_modules/@fontsource/ibm-plex-sans-arabic/files'), { maxAge: '30d' }));
app.use('/vendor/fonts/lalezar', express.static(path.join(ROOT, 'node_modules/@fontsource/lalezar/files'), { maxAge: '30d' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
app.get('/cashier', (req, res) => res.sendFile(path.join(ROOT, 'public/cashier.html')));

// ───── السوكت ─────

io.on('connection', (socket) => {
  socket.join('public');
  socket.on('cashier', (token, ack) => {
    const ok = S.validToken(token);
    if (ok) socket.join('cashier');
    if (typeof ack === 'function') ack(ok);
  });
  socket.on('device', (device) => {
    if (typeof device === 'string' && device.length <= 64) socket.join(`device:${device}`);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`
  المنفذ ${PORT} مستعمل: يمكن البرنامج شغّال من قبل بنافذة تانية. سكّرها وجرّب كمان مرة.
`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  const lan = lanAddresses();
  console.log('');
  console.log(`  ${S.settings().name} — البرنامج شغّال`);
  console.log(`  شاشة الكاشير:   http://localhost:${PORT}/cashier`);
  for (const a of lan) console.log(`  منيو الزباين:   http://${a.address}:${PORT}/   (${a.name})`);
  console.log(`  البيانات:       ${HOSTED ? `Turso (${process.env.TURSO_DATABASE_URL})` : DB_FILE}`);
  if (PUBLIC_URL) console.log(`  على النت:       ${PUBLIC_URL}`);
  console.log('');
});

// Render المجاني بينيّم السيرفر بعد 15 دقيقة بدون زيارات، فبنزوره كل 10 دقايق عشان يضل صاحي
if (PUBLIC_URL && process.env.KEEP_AWAKE !== '0') {
  setInterval(() => { fetch(`${PUBLIC_URL}/healthz`).catch(() => {}); }, 10 * 60e3).unref();
}

// نسخة احتياطية بعد دقيقة من كل تشغيل، وتنظيف النسخ الأقدم من 60 يوم (على الاستضافة البيانات أصلاً محفوظة بـ Turso)
if (!HOSTED) setTimeout(() => {
  try {
    S.backup('auto');
    const old = Date.now() - 60 * 864e5;
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      const p = path.join(BACKUP_DIR, f);
      if (fs.statSync(p).mtimeMs < old) fs.unlinkSync(p);
    }
  } catch (e) { console.error('النسخة الاحتياطية:', e.message); }
}, 60e3);
