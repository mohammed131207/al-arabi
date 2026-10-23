// منيو الزبون: بيفتحه من QR الطاولة، بيتفرّج بالصور، بيختار، وبيبعت الطلب للكاشير
import { $, $$, esc, money, fmtTime, toast, icon } from './common.js';

const store = {
  get(k, f = null) { try { const v = localStorage.getItem(k); return v === null ? f : JSON.parse(v); } catch { return f; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } },
};

const device = store.get('alarabi.device') || (() => {
  const id = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  store.set('alarabi.device', id);
  return id;
})();

const M = { settings: {}, categories: [], items: [], popular: [], tables: 0, table: null, cart: new Map(), orders: [], q: '' };
const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

// يوم الشغل: لحد 4 الفجر بنحسبه على اليوم اللي قبله (مثل السيرفر)
const catToday = (c) => !c?.days || c.days.includes(new Date(Date.now() - 4 * 3600e3).getDay());
const daysText = (days) => days.map((d) => DAYS[d]).join(' و');
const itemCat = (i) => M.categories.find((c) => c.id === i.categoryId);
const cur = () => esc(M.settings.currency || '₪');
const canOrder = () => M.settings.acceptOrders !== false && Boolean(M.table);
const orderable = (i) => canOrder() && catToday(itemCat(i));
const bg = (src) => (src ? `style="background-image:url('${esc(src)}')"` : '');

// رقم الطاولة: من رابط الـ QR، أو آخر رقم خلال 4 ساعات
function readTable() {
  const fromUrl = Number(new URLSearchParams(location.search).get('t'));
  if (Number.isInteger(fromUrl) && fromUrl > 0) {
    store.set('alarabi.table', { no: fromUrl, at: Date.now() });
    return fromUrl;
  }
  const saved = store.get('alarabi.table');
  return saved && Date.now() - saved.at < 4 * 3600e3 ? saved.no : null;
}

// السلة: صنف ← {الكمية، ملاحظة}
function loadCart() {
  const saved = store.get('alarabi.cart', []);
  M.cart = new Map(saved
    .map(([id, v]) => [id, typeof v === 'number' ? { qty: v, note: '' } : v])
    .filter(([id, v]) => v?.qty > 0 && M.items.some((i) => i.id === id)));
}
const saveCart = () => store.set('alarabi.cart', [...M.cart]);
const qtyOf = (id) => M.cart.get(id)?.qty || 0;
function setQty(id, q, note) {
  const prev = M.cart.get(id);
  if (q > 0) M.cart.set(id, { qty: Math.min(q, 50), note: note ?? prev?.note ?? '' });
  else M.cart.delete(id);
  saveCart();
}

// ───── التنقّل: الرئيسية أو قسم (#c3) ─────

const currentCat = () => { const m = location.hash.match(/^#c(\d+)$/); return m ? Number(m[1]) : null; };
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

function render() {
  $('#shopName').textContent = M.settings.name || 'مطعم العربي';
  document.title = `منيو ${M.settings.name || 'مطعم العربي'}`;
  const catId = currentCat();
  const back = $('#backBtn');
  back.hidden = !catId;
  back.innerHTML = icon('back');
  const tb = $('#tableBtn');
  tb.hidden = !M.table;
  tb.innerHTML = `<b class="num">${M.table}</b><small>الطاولة</small>`;
  const cat = catId && M.categories.find((c) => c.id === catId);
  $('#view').innerHTML = cat ? categoryHtml(cat) : homeHtml();
  renderCart();
}

function itemCard(i) {
  const open = catToday(itemCat(i));
  return `
    <div class="m-item ${open ? '' : 'closed'}" role="button" tabindex="0" data-open="${i.id}">
      <span class="tx">
        <b>${esc(i.name)}</b>
        ${i.note ? `<span class="desc">${esc(i.note)}</span>` : ''}
        <span class="pr num">${money(i.price)} <small>${cur()}</small></span>
        ${open ? '' : `<span class="tag">بس يوم ${esc(daysText(itemCat(i).days))}</span>`}
      </span>
      <span class="im ${i.image ? '' : 'noim'}" ${bg(i.image)}>${i.image ? '' : icon('image')}</span>
      <span class="ctl" data-ctl="${i.id}">${ctl(i)}</span>
    </div>`;
}

function ctl(i) {
  if (!orderable(i)) return '';
  const q = qtyOf(i.id);
  if (!q) return `<button class="add" type="button" data-add="${i.id}" aria-label="ضيف ${esc(i.name)}">${icon('plus')}</button>`;
  return `<span class="step"><button type="button" data-dec="${i.id}" aria-label="نقّص">${icon('minus')}</button><b class="num">${q}</b><button type="button" data-add="${i.id}" aria-label="زيد">${icon('plus')}</button></span>`;
}

function topBlocks() {
  const list = M.orders.filter((o) => o.table === M.table).slice(0, 3);
  const STATUS = {
    new: ['وصل طلبك للكاشير', 'عم يستنى تأكيد'],
    accepted: ['انقبل طلبك', 'عم يتجهّز'],
    rejected: ['ما انقبل الطلب', 'احكي مع الجرسون لو سمحت'],
  };
  return `
    ${M.settings.acceptOrders === false ? '<div class="m-banner">الطلب من الجوال موقّف هلأ، اطلب من الجرسون مباشرة.</div>' : ''}
    ${list.length ? `<section class="m-orders" aria-live="polite">${list.map((o) => `
      <div class="m-order ${o.status}"><span class="dot"></span>
        <div><b>${STATUS[o.status][0]}</b><small>${STATUS[o.status][1]} · <span class="tnum">${fmtTime(o.createdAt)}</span> · ${o.lines.reduce((a, l) => a + l.qty, 0)} أصناف</small></div>
        <span class="amt num">${money(o.total)} ${cur()}</span></div>`).join('')}</section>` : ''}
    ${M.table ? `<div class="m-actions">
      <button class="m-act" type="button" data-call="waiter">${icon('bell')}نادِ الجرسون</button>
      <button class="m-act" type="button" data-call="bill">${icon('receipt')}بدنا الحساب</button></div>` : ''}`;
}

function homeHtml() {
  const cats = M.categories.filter((c) => M.items.some((i) => i.categoryId === c.id));
  const byId = new Map(M.items.map((i) => [i.id, i]));
  let pop = M.popular.map((id) => byId.get(id)).filter((i) => i && catToday(itemCat(i)));
  if (pop.length < 4) {
    for (const c of cats) {
      if (!catToday(c)) continue;
      const first = M.items.find((i) => i.categoryId === c.id && i.image && !pop.includes(i));
      if (first) pop.push(first);
    }
  }
  return `
    <div class="m-pad">
      <label class="m-search">${icon('search')}<input id="q" type="search" placeholder="دوّر بالمنيو…" value="${esc(M.q)}" autocomplete="off" aria-label="بحث بالمنيو"></label>
      ${topBlocks()}
      <div id="homeBody">${M.q.trim() ? searchHtml() : `
        <div class="m-h"><h2>الأقسام</h2></div>
        <div class="m-cats">${cats.map((c, k) => {
          const today = catToday(c);
          const rib = c.days ? `<span class="rib ${today ? 'live' : ''}">${today ? 'متوفّر اليوم' : `كل ${esc(daysText(c.days))}`}</span>` : '';
          const n = M.items.filter((i) => i.categoryId === c.id).length;
          return `
            <button class="m-cat ${cats.length % 2 && k === cats.length - 1 ? 'wide' : ''}" type="button" data-cat="${c.id}">
              <span class="im" ${bg(c.image)}></span>
              <span class="tx"><b>${esc(c.name)}<small>${n} ${n === 1 ? 'صنف' : 'أصناف'}</small></b>${icon('back')}</span>
              ${rib}
            </button>`;
        }).join('')}</div>
        ${pop.length ? `
          <div class="m-h"><h2>${M.popular.length >= 4 ? 'الأكثر طلباً' : 'جرّب من عنا'}</h2><small>${M.popular.length >= 4 ? 'آخر شهر' : ''}</small></div>
          <div class="m-pop">${pop.slice(0, 8).map((i) => `
            <div class="m-pcard" role="button" tabindex="0" data-open="${i.id}">
              <div class="im" ${bg(i.image)}></div>
              <div class="tx"><b>${esc(i.name)}</b><span class="pr num">${money(i.price)} ${cur()}</span></div>
            </div>`).join('')}</div>` : ''}`}
      </div>
    </div>`;
}

function searchHtml() {
  const q = M.q.trim();
  const found = M.items.filter((i) => i.name.includes(q) || i.note?.includes(q));
  return found.length ? `<div class="m-list">${found.map(itemCard).join('')}</div>` : '<p class="m-empty">ما لقينا صنف بهالاسم</p>';
}

function categoryHtml(cat) {
  const items = M.items.filter((i) => i.categoryId === cat.id);
  const today = catToday(cat);
  return `
    <div class="m-pad">
      <div class="m-title"><h2>${esc(cat.name)}</h2>
        <p>${items.length} ${items.length === 1 ? 'صنف' : 'أصناف'}${cat.days ? ` · كل ${esc(daysText(cat.days))}` : ''}</p></div>
      ${today ? '' : `<div class="m-banner">قسم ${esc(cat.name)} بيتوفّر يوم ${esc(daysText(cat.days))} بس. تفرّج هلأ واطلب منه ${esc(daysText(cat.days))}!</div>`}
      <div class="m-list">${items.map(itemCard).join('')}</div>
    </div>`;
}

function cartTotals() {
  let n = 0; let t = 0;
  for (const [id, v] of M.cart) {
    const it = M.items.find((i) => i.id === id);
    if (!it) continue;
    n += v.qty; t += v.qty * it.price;
  }
  return { n, t };
}

function renderCart() {
  const { n, t } = cartTotals();
  const bar = $('#cartBar');
  bar.hidden = !n || !canOrder();
  bar.innerHTML = `<span class="n num">${n}</span>شوف طلبك وابعته<span class="t num">${money(t)} ${cur()}</span>`;
}

function refreshItem(id) {
  const it = M.items.find((i) => i.id === id);
  $$(`[data-ctl="${id}"]`).forEach((el) => { el.innerHTML = ctl(it); });
  renderCart();
}

// ───── تفاصيل الصنف ─────

function openItem(id) {
  const it = M.items.find((i) => i.id === id);
  if (!it) return;
  const d = $('#itemDlg');
  const can = orderable(it);
  const existing = M.cart.get(id);
  let q = existing?.qty || 1;
  const cat = itemCat(it);
  const draw = () => {
    d.innerHTML = `
      <div class="hero" ${bg(it.image)}><button class="icon-btn" type="button" data-close aria-label="إغلاق">${icon('x')}</button></div>
      <div class="body">
        <h2>${esc(it.name)}</h2>
        ${it.note ? `<p class="desc">${esc(it.note)}</p>` : ''}
        <span class="pr num">${money(it.price)} ${cur()}</span>
        ${can ? `
          <label class="field"><span>ملاحظة (اختياري)</span><input class="input" id="itemNote" maxlength="80" placeholder="مثلاً: بدون مخلل، زيادة ثومية" value="${esc(existing?.note || '')}"></label>
          <div class="buy">
            <span class="step"><button type="button" data-q="-1" aria-label="نقّص">${icon('minus')}</button><b class="num">${q}</b><button type="button" data-q="1" aria-label="زيد">${icon('plus')}</button></span>
            <button class="btn btn-brand btn-lg" type="button" id="addToCart">${existing ? 'حدّث السلة' : 'ضيف للسلة'} · <span class="num">${money(it.price * q)} ${cur()}</span></button>
          </div>`
        : !catToday(cat) ? `<div class="m-banner">بيتوفّر يوم ${esc(daysText(cat.days))} بس</div>`
          : !M.table ? '<div class="m-banner">عشان تطلب، امسح كود الطاولة أو اكتب رقمها.</div>' : ''}
      </div>`;
  };
  draw();
  d.onclick = (e) => {
    if (e.target === d || e.target.closest('[data-close]')) return d.close();
    const b = e.target.closest('[data-q]');
    if (b) {
      const note = $('#itemNote', d)?.value;
      q = Math.max(1, Math.min(50, q + Number(b.dataset.q)));
      draw();
      if (note !== undefined) $('#itemNote', d).value = note;
    }
    if (e.target.closest('#addToCart')) {
      setQty(id, q, $('#itemNote', d).value.trim().slice(0, 80));
      d.close();
      refreshItem(id);
      toast(`انضاف ${it.name} للسلة`, 'ok');
    }
  };
  d.showModal();
}

// ───── السلة ─────

function openCart() {
  const d = $('#cartDlg');
  const lines = [...M.cart].map(([id, v]) => ({ it: M.items.find((i) => i.id === id), ...v })).filter((x) => x.it);
  const { t } = cartTotals();
  $('[data-close]', d).innerHTML = icon('x');
  $('#cartTitle').textContent = `طلبك لطاولة ${M.table}`;
  $('#cartBody').innerHTML = `
    ${lines.map(({ it, qty, note }) => `
      <div class="cart-line">
        <span class="im" ${bg(it.image)}></span>
        <span class="nm">${esc(it.name)}</span>
        <span class="step"><button type="button" data-dec="${it.id}" aria-label="نقّص">${icon('minus')}</button><b class="num">${qty}</b><button type="button" data-add="${it.id}" aria-label="زيد">${icon('plus')}</button></span>
        <span class="sub"><span class="num">${money(it.price * qty)} ${cur()}</span>${note ? ` · ${esc(note)}` : ''}</span>
      </div>`).join('')}
    <label class="field"><span>ملاحظة للطلب كله (اختياري)</span>
      <textarea class="textarea" id="orderNote" maxlength="160" placeholder="مثلاً: الأكل مع بعض، الثومية لحال">${esc(store.get('alarabi.note', ''))}</textarea></label>
    <div class="cart-sum"><span>المجموع</span><span class="num">${money(t)} ${cur()}</span></div>
    <p class="dlg-err" id="cartErr" role="alert"></p>`;
  $('#cartFoot').innerHTML = `<button class="btn btn-brand btn-lg btn-block" type="button" id="sendOrder">${icon('check')}ابعت الطلب للكاشير</button>`;
  if (!d.open) d.showModal();
}

let sending = false;
async function sendOrder() {
  if (sending) return;
  sending = true;
  const btn = $('#sendOrder');
  btn.disabled = true;
  btn.textContent = 'عم نبعت…';
  try {
    const res = await fetch('/api/public/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        table: M.table, device,
        note: $('#orderNote').value,
        lines: [...M.cart].map(([itemId, v]) => ({ itemId, qty: v.qty, note: v.note })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'ما وصل الطلب، جرّب كمان مرة');
    M.orders = [data, ...M.orders.filter((o) => o.id !== data.id)];
    M.cart.clear();
    saveCart();
    store.set('alarabi.note', '');
    $('#cartDlg').close();
    if (currentCat()) location.hash = '';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('وصل طلبك للكاشير، صحتين', 'ok');
  } catch (e) {
    $('#cartErr').textContent = e.message;
    btn.disabled = false;
    btn.innerHTML = `${icon('check')}ابعت الطلب للكاشير`;
  } finally {
    sending = false;
  }
}

// ───── الأحداث ─────

document.addEventListener('click', async (e) => {
  const add = e.target.closest('[data-add]');
  const dec = e.target.closest('[data-dec]');
  if (add || dec) {
    e.stopPropagation();
    const id = Number((add || dec).dataset.add || (add || dec).dataset.dec);
    setQty(id, qtyOf(id) + (add ? 1 : -1));
    refreshItem(id);
    if ($('#cartDlg').open) {
      if (!M.cart.size) $('#cartDlg').close();
      else { store.set('alarabi.note', $('#orderNote').value); openCart(); }
    }
    return;
  }
  const open = e.target.closest('[data-open]');
  if (open) return openItem(Number(open.dataset.open));
  const cat = e.target.closest('[data-cat]');
  if (cat) { location.hash = `c${cat.dataset.cat}`; return; }
  if (e.target.closest('#backBtn')) { if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back(); else location.hash = ''; return; }
  if (e.target.closest('#cartBar')) return openCart();
  if (e.target.closest('#sendOrder')) return sendOrder();
  if (e.target.closest('#cartDlg [data-close]')) return $('#cartDlg').close();
  if (e.target.closest('#tableBtn')) return showGate();
  if (e.target.closest('#justLook')) { $('#gate').hidden = true; return render(); }
  const call = e.target.closest('[data-call]');
  if (call && !call.classList.contains('sent')) {
    try {
      const res = await fetch('/api/public/calls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ table: M.table, kind: call.dataset.call }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'ما وصل');
      call.classList.add('sent');
      call.innerHTML = `${icon('check')}${call.dataset.call === 'bill' ? 'وصل طلب الحساب' : 'الجرسون جاي'}`;
      setTimeout(() => { call.classList.remove('sent'); render(); }, 60e3);
    } catch (er) { toast(er.message, 'err'); }
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[data-open]')) { e.preventDefault(); openItem(Number(e.target.dataset.open)); }
});

document.addEventListener('input', (e) => {
  if (e.target.id !== 'q') return;
  M.q = e.target.value;
  const body = $('#homeBody');
  if (!body) return;
  if (M.q.trim()) body.innerHTML = searchHtml();
  else render();
});

function showGate() {
  $('#gate').hidden = false;
  $('#gateErr').textContent = '';
  const i = $('#gateInput');
  i.value = M.table || '';
  setTimeout(() => i.focus(), 50);
}

$('#gateForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = Number($('#gateInput').value.replace(/\D/g, ''));
  if (!(n >= 1 && n <= M.tables)) {
    $('#gateErr').textContent = M.tables ? `اكتب رقم من 1 لـ ${M.tables}` : 'اكتب رقم الطاولة';
    return;
  }
  M.table = n;
  store.set('alarabi.table', { no: n, at: Date.now() });
  history.replaceState(null, '', `?t=${n}${location.hash}`);
  $('#gate').hidden = true;
  render();
});

// ───── البداية والتحديث المباشر ─────

async function load() {
  const res = await fetch('/api/public/menu');
  const data = await res.json();
  M.settings = data.settings;
  M.categories = data.categories;
  M.items = data.items;
  M.popular = data.popular || [];
  M.tables = data.tables;
}

async function loadOrders() {
  try {
    const res = await fetch(`/api/public/devices/${encodeURIComponent(device)}/orders`);
    if (res.ok) M.orders = await res.json();
  } catch { /* */ }
}

const socket = io();
socket.on('connect', () => { socket.emit('device', device); loadOrders().then(() => { if (!document.querySelector('dialog[open]') && !M.q) render(); }); });
socket.on('order', (o) => {
  M.orders = [o, ...M.orders.filter((x) => x.id !== o.id)];
  if (!document.querySelector('dialog[open]') && !M.q) render();
  if (o.status === 'accepted') toast('انقبل طلبك، عم يتجهّز', 'ok');
  if (o.status === 'rejected') toast('ما انقبل الطلب، احكي مع الجرسون', 'err');
});
socket.on('menu', (m) => {
  M.settings = m.settings;
  M.categories = m.categories;
  M.items = m.items;
  for (const id of M.cart.keys()) if (!M.items.some((i) => i.id === id)) M.cart.delete(id);
  saveCart();
  if (!document.querySelector('dialog[open]') && !M.q) render();
});

(async () => {
  try {
    await load();
  } catch {
    $('#view').innerHTML = '<p class="m-empty">ما قدرنا نفتح المنيو. تأكد إنك على واي فاي المطعم وحدّث الصفحة.</p>';
    return;
  }
  M.table = readTable();
  if (M.table && M.table > M.tables) M.table = null;
  loadCart();
  await loadOrders();
  render();
  if (!M.table) showGate();
})();
