// شاشة الكاشير: نص للطاولات والأصناف، ونص للفاتورة
import { $, $$, esc, money, fmtTime, fmtDateTime, localDate, minutesSince, toast, icon, ask, confirmBox, beep, unlockAudio, audioReady } from './common.js';
import { printReceipt, printKitchen } from './print.js';
import { renderInvoices, renderDay, renderReports, renderMenu, renderSettings } from './pages.js';

const COLORS = ['#BF4C03', '#2E7A4C', '#9C2F5E', '#1F5F8B', '#8A6A00', '#5B3FA0', '#0F7470', '#A23B2A'];
const TOKEN_KEY = 'alarabi.token';

export const S = {
  token: (() => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } })(),
  settings: {}, tables: [], menu: { categories: [], items: [] },
  invoices: new Map(), orders: [], calls: [], day: null, site: '', addresses: [],
  view: 'pos', tab: 'tables', cat: null, q: '',
  sel: { kind: 'takeaway', invoiceId: null },
  line: null,
};

// ───── الاتصال بالسيرفر ─────

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-token': S.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { lock(); throw new Error(data.error || 'سجّل دخول من جديد'); }
  if (!res.ok) throw new Error(data.error || 'صار خطأ، جرّب كمان مرة');
  return data;
}

// تعديلات الفاتورة بتمشي ورا بعض، عشان كبستين ورا بعض ما يعملوا طلبين خارجيين
let chain = Promise.resolve();
export function act(fn) {
  const run = chain.then(fn).catch((e) => { toast(e.message, 'err'); });
  chain = run;
  return run;
}

const socket = io({ autoConnect: false });

// ───── الدخول ─────

let pin = '';
function renderLogin() {
  $('#keypad').innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok']
    .map((k) => k === 'del'
      ? `<button type="button" class="k-alt" data-k="del" aria-label="امسح">⌫</button>`
      : k === 'ok'
        ? `<button type="button" class="k-alt" data-k="ok">دخول</button>`
        : `<button type="button" data-k="${k}">${k}</button>`).join('');
  drawPin();
}
function drawPin() {
  $('#pinDots').innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
}
async function submitPin() {
  if (pin.length < 4) return;
  try {
    const { token } = await api('/login', { method: 'POST', body: { pin } });
    S.token = token;
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* */ }
    pin = '';
    drawPin();
    $('#loginErr').textContent = '';
    await start();
  } catch (e) {
    pin = '';
    drawPin();
    $('#loginErr').textContent = e.message;
    const card = $('.login-card');
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
  }
}
function pressKey(k) {
  if (k === 'del') pin = pin.slice(0, -1);
  else if (k === 'ok') return submitPin();
  else if (pin.length < 8) pin += k;
  drawPin();
}
$('#keypad').addEventListener('click', (e) => {
  const b = e.target.closest('[data-k]');
  if (b) pressKey(b.dataset.k);
});

export function lock() {
  if (S.token) api('/logout', { method: 'POST' }).catch(() => {});
  S.token = '';
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* */ }
  socket.disconnect();
  $('#app').hidden = true;
  $('#login').hidden = false;
  renderLogin();
}

// ───── التشغيل ─────

async function start() {
  const st = await api('/state');
  load(st);
  $('#login').hidden = true;
  $('#app').hidden = false;
  if (!socket.connected) socket.connect();
  renderAll();
}

function load(st) {
  S.settings = st.settings;
  S.tables = st.tables;
  S.menu = st.menu;
  S.invoices = new Map(st.invoices.map((i) => [i.id, i]));
  S.orders = st.orders;
  S.calls = st.calls;
  S.day = st.day;
  S.site = st.site;
  S.addresses = st.addresses;
  if (!S.cat || !S.menu.categories.some((c) => c.id === S.cat)) S.cat = S.menu.categories[0]?.id ?? null;
}

socket.on('connect', () => {
  setLive('on');
  socket.emit('cashier', S.token, (ok) => { if (!ok) lock(); });
  // بعد انقطاع: نجيب آخر حالة
  api('/state').then((st) => { load(st); renderAll(); }).catch(() => {});
});
socket.on('disconnect', () => setLive('off'));
socket.on('invoice', (inv) => { applyInvoice(inv); renderPos(); });
socket.on('orders', (list) => {
  const fresh = list.filter((o) => !S.orders.some((x) => x.id === o.id));
  S.orders = list;
  if (fresh.length) {
    ring('order');
    toast(`طلب جديد من طاولة ${fresh.map((o) => o.table).join('، ')}`);
  }
  renderPos();
});
socket.on('calls', (list) => {
  const fresh = list.filter((c) => !S.calls.some((x) => x.id === c.id));
  S.calls = list;
  if (fresh.length) {
    ring('call');
    fresh.forEach((c) => toast(`طاولة ${c.table}: ${c.kind === 'bill' ? 'بدهم الحساب' : 'بنادوا الجرسون'}`));
  }
  renderPos();
});
socket.on('menu', (m) => { S.menu = m; renderPos(); if (S.view === 'menu') renderView(); });
socket.on('settings', (x) => { S.settings = x.settings; S.tables = x.tables; S.site = x.site; renderPos(); renderTop(); });
socket.on('day', (d) => { S.day = d; renderToday(); if (S.view === 'day') renderView(); });

function setLive(state) {
  const el = $('#live');
  el.className = `live ${state}`;
  el.title = state === 'on' ? 'متصل' : 'الاتصال مقطوع، عم نحاول نرجع';
}

export function applyInvoice(inv) {
  if (!inv) return;
  if (inv.deleted || inv.status !== 'open') S.invoices.delete(inv.id);
  else S.invoices.set(inv.id, inv);
  if (S.sel.kind === 'takeaway' && S.sel.invoiceId === inv.id && !S.invoices.has(inv.id)) S.sel = { kind: 'takeaway', invoiceId: null };
}

// ───── المساعدات ─────

export const cur = () => S.settings.currency || '₪';
const catColor = (id) => COLORS[Math.max(0, S.menu.categories.findIndex((c) => c.id === id)) % COLORS.length];
export { catColor };
const openList = () => [...S.invoices.values()];
// القسم متوفّر اليوم؟ (لحد 4 الفجر بنحسبه على اليوم اللي قبله، مثل السيرفر)
const catToday = (c) => !c?.days || c.days.includes(new Date(Date.now() - 4 * 3600e3).getDay());
const DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const tableInvoice = (no) => openList().find((i) => i.kind === 'table' && i.table === no) || null;

function current() {
  if (S.sel.kind === 'table') return tableInvoice(S.sel.table);
  return S.sel.invoiceId ? S.invoices.get(S.sel.invoiceId) || null : null;
}

function selectTable(no) {
  S.sel = { kind: 'table', table: no };
  S.line = null;
  S.tab = 'items';
  renderPos();
}
function selectTakeaway(id = null) {
  S.sel = { kind: 'takeaway', invoiceId: id };
  S.line = null;
  if (!id) S.tab = 'items';
  renderPos();
}

// ───── الرسم ─────

const NAV = [
  ['pos', 'grid', 'البيع'],
  ['invoices', 'receipt', 'الفواتير'],
  ['day', 'wallet', 'اليوم'],
  ['reports', 'chart', 'التقارير'],
  ['menu', 'menu', 'القائمة'],
  ['settings', 'gear', 'الإعدادات'],
];

function renderAll() {
  renderTop();
  renderPos();
  if (S.view !== 'pos') renderView();
}

function renderTop() {
  $('#brandName').textContent = S.settings.name || 'مطعم العربي';
  document.title = `الكاشير — ${S.settings.name || 'مطعم العربي'}`;
  $('#nav').innerHTML = NAV.map(([v, ic, label]) => `
    <button type="button" data-view="${v}" ${S.view === v ? 'aria-current="page"' : ''} title="${label}">${icon(ic)}<span>${label}</span></button>`).join('');
  $('#lockBtn').innerHTML = icon('lock');
  renderSoundBtn();
  renderToday();
  tickClock();
}

function renderToday() {
  if (!S.day) return;
  $('#today').innerHTML = `مبيعات اليوم <b class="num">${money(S.day.total)} ${esc(cur())}</b>`;
}

function tickClock() {
  const d = new Date();
  const h = d.getHours();
  $('#clock').textContent = `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function go(view) {
  S.view = view;
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
  renderTop();
  if (view === 'pos') renderPos();
  else renderView();
}

function renderView() {
  const el = $(`.view[data-view="${S.view}"]`);
  const ctx = { S, api, act, go, el, applyInvoice, selectTable, selectTakeaway, catColor, cur, refreshDay, voidBill, printBill, renderTop };
  ({ invoices: renderInvoices, day: renderDay, reports: renderReports, menu: renderMenu, settings: renderSettings })[S.view]?.(ctx);
}

async function refreshDay() {
  S.day = await api('/day');
  renderToday();
}

function renderPos() {
  renderNavBadge();
  if (S.view !== 'pos') return;
  renderTabs();
  renderCatalog();
  renderBill();
}

function renderNavBadge() {
  const n = S.orders.length + S.calls.length;
  const b = $('#nav [data-view="pos"]');
  if (b) b.dataset.badge = S.view !== 'pos' && n ? n : '';
}

// ───── التبويبات ─────

function renderTabs() {
  const takeaways = openList().filter((i) => i.kind === 'takeaway').length;
  const waiting = S.orders.length + S.calls.length;
  const tabs = [
    ['tables', 'table', 'الطاولات', ''],
    ['items', 'grid', 'الأصناف', ''],
    ['takeaway', 'bag', 'طلبات خارجية', takeaways ? `<span class="badge" style="background:var(--ink-3)">${takeaways}</span>` : ''],
    ['orders', 'phone', 'طلبات الجوال', waiting ? `<span class="badge hot">${waiting}</span>` : ''],
  ];
  $('#tabs').innerHTML = tabs.map(([k, ic, label, extra]) => `
    <button class="tab" type="button" role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${icon(ic)}${label}${extra}</button>`).join('');
}

function renderCatalog() {
  const body = $('#tabBody');
  if (S.tab === 'tables') body.innerHTML = tablesHtml();
  else if (S.tab === 'items') {
    const keep = document.activeElement?.id === 'itemSearch';
    body.innerHTML = itemsHtml();
    if (keep) { const i = $('#itemSearch'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  } else if (S.tab === 'takeaway') body.innerHTML = takeawayHtml();
  else body.innerHTML = ordersHtml();
}

function tablesHtml() {
  const zones = [];
  for (const t of S.tables) {
    let z = zones.find((x) => x.name === t.zone);
    if (!z) zones.push(z = { name: t.zone, list: [] });
    z.list.push(t);
  }
  return `<div class="zones">${zones.map((z) => {
    const busy = z.list.filter((t) => tableInvoice(t.no)).length;
    return `
    <section class="zone">
      <h3>${esc(z.name)} <small>${busy ? `${busy} مشغولة من ${z.list.length}` : `${z.list.length} طاولة`}</small></h3>
      <div class="tgrid">${z.list.map((t) => tableTile(t.no)).join('')}</div>
    </section>`;
  }).join('')}</div>`;
}

function tableTile(no) {
  const inv = tableInvoice(no);
  const order = S.orders.some((o) => o.table === no);
  const call = S.calls.find((c) => c.table === no);
  const sel = S.sel.kind === 'table' && S.sel.table === no;
  const flag = order ? '<span class="flag order">طلب جديد</span>'
    : call ? `<span class="flag call">${call.kind === 'bill' ? 'الحساب' : 'نداء'}</span>` : '';
  return `
    <button type="button" class="tile-t ${inv ? 'busy' : ''} ${order ? 'has-order' : ''} ${sel ? 'sel' : ''}" data-table="${no}" aria-label="طاولة ${no}${inv ? '، مشغولة' : ''}">
      <span class="no num">${no}</span>${flag}
      ${inv ? `<span class="bot"><span class="since">${icon('clock')}${minutesSince(inv.createdAt)}</span><span class="amt num">${money(inv.total)} ${esc(cur())}</span></span>` : ''}
    </button>`;
}

function itemsHtml() {
  const inv = current();
  const counts = new Map();
  for (const l of inv?.lines || []) if (l.itemId) counts.set(l.itemId, (counts.get(l.itemId) || 0) + l.qty);
  const q = S.q.trim();
  const list = q
    ? S.menu.items.filter((i) => i.name.includes(q))
    : S.menu.items.filter((i) => i.categoryId === S.cat);
  return `
    <div class="items-pane">
      <div class="cats">
        ${S.menu.categories.map((c) => `
          <button type="button" class="cat" style="--c:${catColor(c.id)}" data-cat="${c.id}" aria-pressed="${!q && S.cat === c.id}">
            ${esc(c.name)}<small>${c.days ? `${c.days.map((d) => DAY_NAMES[d]).join(' و')} بس` : `${S.menu.items.filter((i) => i.categoryId === c.id).length} صنف`}</small>
          </button>`).join('')}
      </div>
      <div class="items-main">
        <div class="search">${icon('search')}<input class="input" id="itemSearch" type="search" placeholder="دوّر على صنف (F2)" value="${esc(S.q)}" autocomplete="off" aria-label="بحث بالأصناف"></div>
        <div class="igrid">
          ${list.map((i) => `
            <button type="button" class="tile-i ${i.available ? '' : 'off'} ${catToday(S.menu.categories.find((c) => c.id === i.categoryId)) ? '' : 'notday'}" style="--c:${catColor(i.categoryId)}" data-item="${i.id}">
              <span class="nm">${esc(i.name)}</span>
              <span class="pr num">${money(i.price)} ${esc(cur())}</span>
              ${counts.get(i.id) ? `<span class="in num">${money(counts.get(i.id))}</span>` : ''}
            </button>`).join('') || `<div class="empty" style="grid-column:1/-1">${q ? 'ما في صنف بهالاسم' : 'القسم فاضي، ضيف أصناف من شاشة القائمة'}</div>`}
        </div>
      </div>
    </div>`;
}

function takeawayHtml() {
  const list = openList().filter((i) => i.kind === 'takeaway');
  const selId = S.sel.kind === 'takeaway' ? S.sel.invoiceId : -1;
  return `
    <div class="list-pane">
      <div class="ta-grid">
        <button type="button" class="tile-ta new ${S.sel.kind === 'takeaway' && !S.sel.invoiceId ? 'sel' : ''}" data-takeaway="new">${icon('plus')}طلب خارجي جديد</button>
        ${list.map((i) => `
          <button type="button" class="tile-ta ${selId === i.id ? 'sel' : ''}" data-takeaway="${i.id}">
            <b>طلب خارجي <span class="num">#${i.no}</span></b>
            <span class="muted">${esc(i.label) || fmtTime(i.createdAt)}</span>
            <span class="amt num">${money(i.total)} ${esc(cur())}</span>
          </button>`).join('')}
      </div>
      ${list.length ? '' : '<p class="empty">الطلب الخارجي: زبون بياخد أكله وبيمشي (مش طاولة).<br>اكبس "طلب خارجي جديد"، اختار الأصناف، وبالدفع بتطلع فاتورة الزبون بس (بدون تذكرة مطبخ).</p>'}
    </div>`;
}

function orderCard(o, { showTable = true } = {}) {
  return `
    <article class="ocard">
      <header>${icon('phone')}<b>${showTable ? `طاولة ${o.table} · ` : ''}طلب من الجوال</b><span class="muted tnum">${fmtTime(o.createdAt)}</span>
        <span class="grow"></span><b class="num">${money(o.total)} ${esc(cur())}</b></header>
      <ul>${o.lines.map((l) => `<li><span class="q tnum">${l.qty} ×</span><span>${esc(l.name)}${l.note ? ` <small>— ${esc(l.note)}</small>` : ''}</span></li>`).join('')}</ul>
      ${o.note ? `<div class="onote">ملاحظة: ${esc(o.note)}</div>` : ''}
      <div class="row">
        <button class="btn btn-sm btn-danger" type="button" data-reject="${o.id}">ارفض</button>
        ${showTable ? `<button class="btn btn-sm" type="button" data-open-table="${o.table}">افتح الطاولة</button>` : ''}
        <button class="btn btn-sm btn-ok" type="button" data-accept="${o.id}">${icon('check')}اقبل وضيفه للفاتورة</button>
      </div>
    </article>`;
}

function callCard(c) {
  return `
    <div class="ccard">${icon(c.kind === 'bill' ? 'receipt' : 'bell')}
      <span class="grow">طاولة ${c.table}: ${c.kind === 'bill' ? 'بدهم الحساب' : 'بنادوا الجرسون'}<small class="tnum">${fmtTime(c.createdAt)}</small></span>
      <button class="btn btn-sm" type="button" data-call-done="${c.id}">${icon('check')}تمام</button>
    </div>`;
}

function ordersHtml() {
  if (!S.orders.length && !S.calls.length) {
    return `<p class="empty">ما في طلبات من الجوال هلأ.<br>لما زبون يطلب من الـ QR على طاولته، بيوصل هون مع صوت.</p>`;
  }
  return `<div class="list-pane">${S.calls.map(callCard).join('')}${S.orders.map((o) => orderCard(o)).join('')}</div>`;
}

// ───── الفاتورة ─────

function placeChip() {
  if (S.sel.kind === 'table') return `<span class="chip num">${S.sel.table}</span>طاولة`;
  const inv = current();
  return `<span class="chip">${icon('bag').replace('<svg', '<svg style="width:20px;height:20px;vertical-align:-3px"')}</span>${inv ? `طلب خارجي <span class="num">#${inv.no}</span>` : 'طلب خارجي جديد'}`;
}

function renderBill() {
  const inv = current();
  const lines = inv?.lines || [];
  if (S.line && !lines.some((l) => l.id === S.line)) S.line = null;
  const tableOrders = S.sel.kind === 'table' ? S.orders.filter((o) => o.table === S.sel.table) : [];
  const tableCalls = S.sel.kind === 'table' ? S.calls.filter((c) => c.table === S.sel.table) : [];
  const has = lines.length > 0;
  const sub = inv && inv.discount > 0
    ? `المجموع <b class="num">${money(inv.subtotal, { fixed: true })}</b> · خصم <b class="num">${money(inv.discount, { fixed: true })}</b>${inv.discountPct ? ` (<span class="num">${money(inv.discountPct)}%</span>)` : ''}`
    : `${lines.length ? `${lines.length} ${lines.length === 1 ? 'صنف' : 'أصناف'}` : 'فاضية'}`;

  $('#bill').innerHTML = `
    <div class="bill-head">
      <span class="place">${placeChip()}</span>
      ${inv ? `<span class="meta">فاتورة <b class="num">${inv.no}</b> · <span class="tnum">${fmtTime(inv.createdAt)}</span>${inv.label ? ` · ${esc(inv.label)}` : ''}</span>` : ''}
      <span class="acts">
        ${inv && inv.kind === 'takeaway' ? `<button class="icon-btn" type="button" data-bill="label" title="اسم أو رقم الزبون">${icon('edit')}</button>` : ''}
        ${inv ? `<button class="icon-btn" type="button" data-bill="move" title="انقل لطاولة">${icon('move')}</button>` : ''}
        ${inv ? `<button class="icon-btn" type="button" data-bill="void" title="إلغاء الفاتورة" style="color:var(--danger)">${icon('trash')}</button>` : ''}
      </span>
    </div>
    <div class="display" id="display">
      <span class="lbl">المطلوب</span>
      <span class="sub">${sub}</span>
      <span class="total num">${money(inv?.total || 0, { fixed: true })}<small>${esc(cur())}</small></span>
    </div>
    ${tableOrders.length || tableCalls.length ? `<div class="incoming">${tableCalls.map(callCard).join('')}${tableOrders.map((o) => orderCard(o, { showTable: false })).join('')}</div>` : ''}
    <div class="tools">
      <button class="btn qbtn" type="button" data-bill="inc" title="زيادة (+)" ${S.line ? '' : 'disabled'}>+</button>
      <button class="btn qbtn" type="button" data-bill="dec" title="تنقيص (-)" ${S.line ? '' : 'disabled'}>−</button>
      <button class="btn" type="button" data-bill="qty" ${S.line ? '' : 'disabled'}>الكمية</button>
      <button class="btn" type="button" data-bill="note" ${S.line ? '' : 'disabled'}>${icon('note')}ملاحظة</button>
      <button class="btn btn-danger" type="button" data-bill="del" title="Delete" ${S.line ? '' : 'disabled'}>${icon('trash')}حذف</button>
      <span class="sep"></span>
      <button class="btn" type="button" data-bill="discount" ${has ? '' : 'disabled'}>${icon('tag')}خصم</button>
    </div>
    <div class="lines">
      ${has ? `
      <table>
        <thead><tr><th class="i">م</th><th>الصنف</th><th class="q">الكمية</th><th class="n">السعر</th><th class="n">المجموع</th></tr></thead>
        <tbody>
          ${lines.map((l, i) => `
            <tr data-line="${l.id}" class="${S.line === l.id ? 'sel' : ''}">
              <td class="i num">${i + 1}</td>
              <td><span class="nm">${esc(l.name)}</span>${l.source === 'customer' ? `<span class="src" title="من جوال الزبون">${icon('phone')}جوال</span>` : ''}${l.sent ? '<span class="snt" title="انطبع للمطبخ">✓ مطبخ</span>' : ''}
                ${l.note ? `<span class="nt">— ${esc(l.note)}</span>` : ''}</td>
              <td class="q num"><b>${money(l.qty)}</b></td>
              <td class="n num">${money(l.price)}</td>
              <td class="n num tot">${money(l.price * l.qty, { fixed: true })}</td>
            </tr>`).join('')}
        </tbody>
      </table>` : `
      <div class="bill-empty">${icon('receipt')}
        <b>${S.sel.kind === 'table' ? `طاولة ${S.sel.table} فاضية` : 'طلب خارجي جديد'}</b>
        <span>اكبس على الأصناف لتنضاف هون</span>
      </div>`}
    </div>
    <div class="foot ${S.sel.kind === 'takeaway' ? 'two' : ''}">
      <button class="btn" type="button" data-bill="print" ${has ? '' : 'disabled'}>${icon('printer')}طباعة<kbd>F8</kbd></button>
      ${S.sel.kind === 'takeaway' ? '' : `<button class="btn" type="button" data-bill="kitchen" ${has ? '' : 'disabled'}>${icon('pot')}للمطبخ<kbd>F7</kbd></button>`}
      <button class="btn btn-brand pay" type="button" data-bill="pay" ${has ? '' : 'disabled'}>${icon('cash')}دفع وإغلاق<kbd>F9</kbd></button>
    </div>`;
  const row = S.line && $(`#bill tr[data-line="${S.line}"]`);
  row?.scrollIntoView({ block: 'nearest' });
}

function bump() {
  const d = $('#display');
  d?.classList.remove('bump');
  void d?.offsetWidth;
  d?.classList.add('bump');
}

// ───── أفعال الفاتورة ─────

function addItem(itemId) {
  const item = S.menu.items.find((i) => i.id === itemId);
  if (item && !item.available) toast(`${item.name} معلّم إنه خلص، انضاف على كل حال`);
  const cat = item && S.menu.categories.find((c) => c.id === item.categoryId);
  if (cat && !catToday(cat)) toast(`${cat.name} قسم ${cat.days.map((d) => DAY_NAMES[d]).join(' و')}، انضاف على كل حال`);
  return act(async () => {
    const inv = current();
    const body = inv ? { invoiceId: inv.id, itemId }
      : S.sel.kind === 'table' ? { kind: 'table', table: S.sel.table, itemId }
        : { kind: 'takeaway', itemId };
    const out = await api('/invoices/add', { method: 'POST', body });
    applyInvoice(out);
    if (S.sel.kind === 'takeaway') S.sel.invoiceId = out.id;
    S.line = out.lines.filter((l) => l.itemId === itemId && !l.sent).pop()?.id ?? S.line;
    renderBill();
    renderTabs();
    if (S.tab === 'items') {
      renderCatalog();
      $(`.tile-i[data-item="${itemId}"]`)?.classList.add('flash');
    }
    bump();
  });
}

const selLine = () => current()?.lines.find((l) => l.id === S.line);

function patchLine(body) {
  const l = selLine();
  if (!l) return;
  return act(async () => {
    const out = await api(`/lines/${l.id}`, { method: 'PATCH', body });
    applyInvoice(out);
    renderPos();
    bump();
  });
}

async function billAction(a) {
  const inv = current();
  const l = selLine();
  if (a === 'inc' && l) return patchLine({ qty: l.qty + 1 });
  if (a === 'dec' && l) return patchLine({ qty: l.qty - 1 });
  if (a === 'del' && l) return patchLine({ qty: 0 });
  if (a === 'qty' && l) {
    const v = await ask({ title: `كمية ${l.name}`, fields: [{ name: 'qty', label: 'الكمية', num: true, value: l.qty }], confirm: 'تمام',
      validate: (x) => (Number(x.qty) >= 0 && Number(x.qty) <= 999 ? '' : 'اكتب رقم من 0 لـ 999') });
    if (v) patchLine({ qty: Number(v.qty) });
    return;
  }
  if (a === 'note' && l) {
    const v = await ask({ title: `ملاحظة على ${l.name}`, fields: [{ name: 'note', label: 'الملاحظة', value: l.note, placeholder: 'مثلاً: بدون بصل، زيادة ثومية' }], confirm: 'حفظ' });
    if (v) patchLine({ note: v.note });
    return;
  }
  if (!inv) return;
  if (a === 'discount') return discount(inv);
  if (a === 'print') return printBill(inv);
  if (a === 'kitchen') return kitchen(inv);
  if (a === 'pay') return payDialog(inv);
  if (a === 'move') return move(inv);
  if (a === 'void') return voidBill(inv);
  if (a === 'label') {
    const v = await ask({ title: 'زبون الطلب الخارجي', fields: [{ name: 'label', label: 'الاسم أو رقم الجوال', value: inv.label, max: 40 }], confirm: 'حفظ' });
    if (v) act(async () => { applyInvoice(await api(`/invoices/${inv.id}`, { method: 'PATCH', body: { label: v.label } })); renderPos(); });
  }
}

async function discount(inv) {
  const v = await ask({
    title: 'خصم على الفاتورة',
    fields: [
      { name: 'type', label: 'نوع الخصم', type: 'select', value: inv.discountPct ? 'pct' : 'amount', options: [{ value: 'pct', label: 'نسبة %' }, { value: 'amount', label: `مبلغ (${cur()})` }] },
      { name: 'value', label: 'القيمة', num: true, value: inv.discountPct || inv.discount || '', hint: 'اكتب 0 لتشيل الخصم' },
    ],
    confirm: 'طبّق الخصم',
    validate: (x) => {
      const n = Number(x.value || 0);
      if (!Number.isFinite(n) || n < 0) return 'اكتب رقم صحيح';
      if (x.type === 'pct' && n > 100) return 'النسبة لازم تكون أقل من 100';
      if (x.type === 'amount' && n > inv.subtotal) return 'الخصم أكبر من المجموع';
      return '';
    },
  });
  if (!v) return;
  const n = Number(v.value || 0);
  act(async () => {
    const body = v.type === 'pct' && n > 0 ? { discountPct: n } : { discount: v.type === 'pct' ? 0 : n, discountPct: null };
    applyInvoice(await api(`/invoices/${inv.id}`, { method: 'PATCH', body }));
    renderPos();
    bump();
  });
}

function printBill(inv, opts) {
  return act(async () => {
    await printReceipt(inv, S.settings, opts);
    applyInvoice(await api(`/invoices/${inv.id}/printed`, { method: 'POST' }));
    if (S.view === 'pos') renderBill();
  });
}

function kitchen(inv) {
  return act(async () => {
    const { lines, invoice } = await api(`/invoices/${inv.id}/kitchen`, { method: 'POST' });
    applyInvoice(invoice);
    renderBill();
    if (!lines.length) {
      const again = await confirmBox('كل الأصناف انبعتت للمطبخ', 'ما في أصناف جديدة. بدك تطبع تذكرة المطبخ كاملة كمان مرة؟', 'اطبع كاملة', false);
      if (!again) return;
      const r = await api(`/invoices/${inv.id}/kitchen`, { method: 'POST', body: { all: true } });
      await printKitchen(r.invoice, r.lines, S.settings, { all: true });
      return;
    }
    await printKitchen(invoice, lines, S.settings);
  });
}

async function move(inv) {
  const opts = S.tables
    .filter((t) => !(inv.kind === 'table' && t.no === inv.table))
    .map((t) => ({ value: t.no, label: `طاولة ${t.no} · ${t.zone}${tableInvoice(t.no) ? ' (عليها فاتورة، بتندمج)' : ''}` }));
  const v = await ask({ title: `انقل فاتورة ${inv.no}`, fields: [{ name: 'table', label: 'لأي طاولة؟', type: 'select', options: opts }], confirm: 'انقل' });
  if (!v) return;
  act(async () => {
    const out = await api(`/invoices/${inv.id}/move`, { method: 'POST', body: { table: Number(v.table) } });
    applyInvoice(out);
    if (out.id !== inv.id) S.invoices.delete(inv.id);
    S.sel = { kind: 'table', table: out.table };
    S.line = null;
    renderPos();
    toast(`انتقلت لطاولة ${out.table}`, 'ok');
  });
}

async function voidBill(inv, { after } = {}) {
  const paid = inv.status === 'paid';
  const v = await ask({
    title: `إلغاء فاتورة ${inv.no}`,
    body: `<p style="margin:0">${paid ? 'هاي الفاتورة مدفوعة. إلغاؤها بيطرح مبلغها من مبيعات اليوم.' : 'الفاتورة بتنلغى وبتضل بسجل الفواتير كملغية.'}</p>`,
    fields: [{ name: 'reason', label: paid ? 'سبب الإلغاء (لازم)' : 'السبب (اختياري)', max: 120 }],
    confirm: 'ألغِ الفاتورة',
    danger: true,
    validate: (x) => (paid && !x.reason.trim() ? 'اكتب سبب الإلغاء' : ''),
  });
  if (!v) return;
  return act(async () => {
    const out = await api(`/invoices/${inv.id}/void`, { method: 'POST', body: { reason: v.reason } });
    applyInvoice({ ...out, id: inv.id, deleted: true });
    if (S.sel.kind === 'takeaway' && S.sel.invoiceId === inv.id) S.sel = { kind: 'takeaway', invoiceId: null };
    S.line = null;
    toast('انلغت الفاتورة', 'ok');
    renderPos();
    after?.();
  });
}

// ───── الدفع ─────

function quickAmounts(total) {
  const out = new Set();
  for (const step of [5, 10, 20, 50, 100, 200]) {
    const v = Math.ceil(total / step) * step;
    if (v > total) out.add(v);
  }
  return [...out].sort((a, b) => a - b).slice(0, 3);
}

function payDialog(inv) {
  const d = document.createElement('dialog');
  d.className = 'dlg pay-dlg';
  let method = 'cash';
  let app = null;
  const apps = S.settings.payApps || [];
  const c = esc(cur());
  const appIcon = (name) => (/جوال|pay/i.test(name) ? 'phone' : /محفظ|wallet/i.test(name) ? 'wallet' : 'card');
  d.innerHTML = `
    <form method="dialog">
      <div class="dlg-head"><h2>دفع ${inv.kind === 'table' ? `طاولة ${inv.table}` : 'طلب خارجي'} · فاتورة <span class="num">${inv.no}</span></h2>
        <button class="icon-btn" type="button" data-close aria-label="إغلاق">${icon('x')}</button></div>
      <div class="dlg-body">
        <div class="pay-total"><span>المطلوب</span><b class="num">${money(inv.total, { fixed: true })} ${c}</b></div>
        <div class="pay-methods" role="group" aria-label="طريقة الدفع">
          <button type="button" data-m="cash" aria-pressed="true">${icon('cash')}نقدي</button>
          ${apps.map((a) => `<button type="button" data-m="app" data-app="${esc(a)}" aria-pressed="false">${icon(appIcon(a))}${esc(a)}</button>`).join('')}
        </div>
        <div class="cash-part">
          <label class="field"><span>المبلغ اللي دفعه الزبون</span>
            <input class="input big num" name="received" inputmode="decimal" dir="ltr" placeholder="${money(inv.total, { fixed: true })}" autocomplete="off"></label>
          <div class="quick" style="margin-top:8px">
            <button class="btn" type="button" data-q="${inv.total}">بالضبط</button>
            ${quickAmounts(inv.total).map((v) => `<button class="btn num" type="button" data-q="${v}">${v}</button>`).join('')}
          </div>
          <div class="change" style="margin-top:10px"><span>الباقي للزبون</span><b class="num">0.00 ${c}</b></div>
        </div>
        <div class="app-part" hidden>
          <label class="field"><span>اسم اللي حوّل</span>
            <input class="input" name="payer" maxlength="60" autocomplete="off" placeholder="مثل ما طالع بإشعار الحوالة"></label>
          <label class="field"><span>رقم الحوالة أو آخر أرقام (اختياري)</span>
            <input class="input num" name="ref" maxlength="40" autocomplete="off" dir="ltr"></label>
        </div>
        <p class="dlg-err" role="alert"></p>
      </div>
      <div class="dlg-foot">
        <button class="btn" type="button" data-close>رجوع</button>
        <button class="btn btn-brand btn-lg" type="submit">${icon('check')}${S.settings.printOnPay ? 'ادفع واطبع' : 'ادفع'}</button>
      </div>
    </form>`;
  document.body.append(d);
  const input = $('input[name="received"]', d);
  const payer = $('input[name="payer"]', d);
  const err = (m) => { $('.dlg-err', d).textContent = m; };
  const update = () => {
    const raw = input.value.trim();
    const rec = raw === '' ? inv.total : Number(raw);
    const ch = $('.change', d);
    if (!Number.isFinite(rec)) { ch.className = 'change short'; ch.lastElementChild.textContent = 'رقم غلط'; return; }
    const diff = Math.round((rec - inv.total) * 100) / 100;
    ch.className = `change ${diff < 0 ? 'short' : ''}`;
    ch.firstElementChild.textContent = diff < 0 ? 'ناقص' : 'الباقي للزبون';
    ch.lastElementChild.textContent = `${money(Math.abs(diff), { fixed: true })} ${cur()}`;
  };
  input.addEventListener('input', update);
  d.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) return d.close();
    const q = e.target.closest('[data-q]');
    if (q) { input.value = q.dataset.q; update(); input.focus(); }
    const m = e.target.closest('[data-m]');
    if (m) {
      method = m.dataset.m;
      app = m.dataset.app || null;
      $$('[data-m]', d).forEach((b) => b.setAttribute('aria-pressed', String(b === m)));
      $('.cash-part', d).hidden = method !== 'cash';
      $('.app-part', d).hidden = method !== 'app';
      err('');
      (method === 'cash' ? input : payer).focus();
    }
  });
  $('form', d).addEventListener('submit', (e) => {
    e.preventDefault();
    let body;
    if (method === 'app') {
      if (!payer.value.trim()) { err(`اكتب اسم اللي حوّل على ${app}`); payer.focus(); return; }
      body = { method, app, payer: payer.value.trim(), ref: $('input[name="ref"]', d).value.trim() };
    } else {
      const raw = input.value.trim();
      const received = raw !== '' ? Number(raw) : undefined;
      if (received !== undefined && (!Number.isFinite(received) || received < inv.total)) { err('المبلغ المدفوع أقل من المطلوب'); return; }
      body = { method, received };
    }
    d.close();
    act(async () => {
      const paid = await api(`/invoices/${inv.id}/pay`, { method: 'POST', body });
      applyInvoice(paid);
      const change = paid.method === 'cash' && paid.received > paid.total ? paid.received - paid.total : 0;
      toast(paid.method === 'app' ? `انسكّرت · حوالة ${paid.payApp} باسم ${paid.payer}`
        : change ? `انسكّرت · الباقي ${money(change, { fixed: true })} ${cur()}` : 'انسكّرت الفاتورة', 'ok');
      if (S.settings.printOnPay) {
        await printReceipt(paid, S.settings);
        api(`/invoices/${paid.id}/printed`, { method: 'POST' }).catch(() => {});
      }
      const wasTable = inv.kind === 'table';
      S.sel = { kind: 'takeaway', invoiceId: null };
      S.line = null;
      S.tab = wasTable ? 'tables' : 'items';
      renderPos();
    });
  });
  d.addEventListener('close', () => d.remove());
  d.showModal();
  input.focus();
}

// ───── الطلبات والنداءات ─────

function acceptOrder(id) {
  return act(async () => {
    const o = S.orders.find((x) => x.id === id);
    const inv = await api(`/orders/${id}/accept`, { method: 'POST' });
    applyInvoice(inv);
    S.orders = S.orders.filter((x) => x.id !== id);
    if (o) { S.sel = { kind: 'table', table: o.table }; S.line = null; }
    toast(`انضاف طلب طاولة ${inv.table} للفاتورة`, 'ok');
    renderPos();
    // تذكرة المطبخ بتطلع لحالها مع القبول (بتتسكّر من الإعدادات)
    if (S.settings.kitchenOnAccept !== false) {
      const k = await api(`/invoices/${inv.id}/kitchen`, { method: 'POST' });
      applyInvoice(k.invoice);
      renderPos();
      if (k.lines.length) await printKitchen(k.invoice, k.lines, S.settings);
    }
  });
}

// ───── صوت التنبيه: بيرن عالي، وبيرجع يرن كل 8 ثواني لحد ما تتعامل مع الطلب أو النداء ─────

const SOUND_KEY = 'alarabi.sound';
let soundOn = (() => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } })();

function ring(kind) { if (soundOn) beep(kind); }

function renderSoundBtn() {
  const b = $('#soundBtn');
  if (!b) return;
  const blocked = soundOn && !audioReady();
  b.innerHTML = icon(soundOn ? 'bell' : 'bellOff');
  b.classList.toggle('off', !soundOn);
  b.classList.toggle('warn', blocked);
  b.title = !soundOn ? 'الصوت مسكّر، اكبس لتشغيله' : blocked ? 'اكبس هون ليشتغل صوت التنبيه' : 'صوت التنبيه شغّال، اكبس لتسكيره';
  b.setAttribute('aria-label', b.title);
}

setInterval(() => {
  if (S.token && (S.orders.length || S.calls.length)) ring(S.orders.length ? 'order' : 'call');
  renderSoundBtn();
}, 8e3);
document.addEventListener('pointerdown', () => { if (soundOn && !audioReady()) { unlockAudio(); setTimeout(renderSoundBtn, 200); } });

async function rejectOrder(id) {
  const ok = await confirmBox('رفض الطلب', 'الزبون رح يشوف إن طلبه انرفض ويحكي مع الجرسون. متأكد؟', 'ارفض');
  if (!ok) return;
  act(async () => {
    await api(`/orders/${id}/reject`, { method: 'POST' });
    S.orders = S.orders.filter((x) => x.id !== id);
    renderPos();
  });
}

// ───── الأحداث ─────

document.addEventListener('click', (e) => {
  const t = e.target;
  const nav = t.closest('#nav [data-view]');
  if (nav) return go(nav.dataset.view);
  if (t.closest('#lockBtn')) return lock();
  if (t.closest('#soundBtn')) {
    soundOn = !soundOn || !audioReady() ? true : false;
    try { localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off'); } catch { /* */ }
    if (soundOn) { unlockAudio(); setTimeout(() => beep('order'), 150); }
    renderSoundBtn();
    toast(soundOn ? 'صوت التنبيه شغّال' : 'صوت التنبيه مسكّر');
    return;
  }
  const tab = t.closest('[data-tab]');
  if (tab) { S.tab = tab.dataset.tab; renderTabs(); renderCatalog(); return; }
  const tb = t.closest('[data-table]');
  if (tb) return selectTable(Number(tb.dataset.table));
  const cat = t.closest('[data-cat]');
  if (cat) { S.cat = Number(cat.dataset.cat); S.q = ''; renderCatalog(); return; }
  const it = t.closest('[data-item]');
  if (it) return addItem(Number(it.dataset.item));
  const ta = t.closest('[data-takeaway]');
  if (ta) return selectTakeaway(ta.dataset.takeaway === 'new' ? null : Number(ta.dataset.takeaway));
  const ln = t.closest('#bill [data-line]');
  if (ln) { S.line = Number(ln.dataset.line); renderBill(); return; }
  const b = t.closest('#bill [data-bill]');
  if (b && !b.disabled) return billAction(b.dataset.bill);
  const acc = t.closest('[data-accept]');
  if (acc) return acceptOrder(Number(acc.dataset.accept));
  const rej = t.closest('[data-reject]');
  if (rej) return rejectOrder(Number(rej.dataset.reject));
  const ot = t.closest('[data-open-table]');
  if (ot) return selectTable(Number(ot.dataset.openTable));
  const cd = t.closest('[data-call-done]');
  if (cd) {
    const id = Number(cd.dataset.callDone);
    act(async () => { await api(`/calls/${id}/done`, { method: 'POST' }); S.calls = S.calls.filter((c) => c.id !== id); renderPos(); });
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'itemSearch') {
    S.q = e.target.value;
    renderCatalog();
  }
});

document.addEventListener('keydown', (e) => {
  if ($('#app').hidden) {
    if (/^\d$/.test(e.key)) pressKey(e.key);
    else if (e.key === 'Backspace') pressKey('del');
    else if (e.key === 'Enter') pressKey('ok');
    return;
  }
  if (document.querySelector('dialog[open]') || S.view !== 'pos') return;
  const typing = e.target instanceof Element && e.target.matches('input, textarea, select');
  const keys = { F7: 'kitchen', F8: 'print', F9: 'pay' };
  if (keys[e.key]) {
    e.preventDefault();
    const btn = $(`#bill [data-bill="${keys[e.key]}"]`);
    if (btn && !btn.disabled) billAction(keys[e.key]);
    return;
  }
  if (e.key === 'F2') {
    e.preventDefault();
    S.tab = 'items';
    renderTabs();
    renderCatalog();
    $('#itemSearch')?.focus();
    return;
  }
  if (e.key === 'Escape' && e.target.id === 'itemSearch') { S.q = ''; e.target.value = ''; renderCatalog(); return; }
  if (typing) {
    if (e.key === 'Enter' && e.target.id === 'itemSearch') {
      const first = $('.tile-i');
      if (first) { addItem(Number(first.dataset.item)); }
    }
    return;
  }
  if (!S.line) return;
  if (e.key === '+' || e.key === '=') { e.preventDefault(); billAction('inc'); }
  else if (e.key === '-') { e.preventDefault(); billAction('dec'); }
  else if (e.key === 'Delete') { e.preventDefault(); billAction('del'); }
});

setInterval(() => {
  tickClock();
  if (S.view === 'pos' && S.tab === 'tables' && !document.querySelector('dialog[open]')) renderCatalog();
}, 30e3);

// البداية: إذا في جلسة محفوظة بندخل على طول
renderLogin();
if (S.token) start().catch(() => lock());
else $('#login').hidden = false;
