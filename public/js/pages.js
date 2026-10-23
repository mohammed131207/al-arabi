// صفحات الكاشير غير البيع: الفواتير، اليوم والمصاريف، التقارير، القائمة، الإعدادات
import { $, $$, esc, money, fmtTime, fmtDate, fmtDateTime, localDate, toast, icon, ask, confirmBox } from './common.js';
import { printReceipt, printDayReport, printTableQrs } from './print.js';

const dayStart = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
const iso = (date) => date.toISOString();

export function qrSvg(text) {
  /* global qrcode */
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

const STATUS = { paid: 'مدفوعة', open: 'مفتوحة', void: 'ملغية' };

// ───── طرق الدفع والحوالات ─────

const payLabel = (i) => (i.method === 'cash' ? 'نقدي' : i.method === 'app' ? (i.payApp || 'تطبيق') : '—');
const invoicesText = (n) => (n === 1 ? 'فاتورة وحدة' : n === 2 ? 'فاتورتين' : n <= 10 ? `${n} فواتير` : `${n} فاتورة`);
export const transfersText = (n) => (n === 1 ? 'حوالة وحدة' : n === 2 ? 'حوالتين' : n <= 10 ? `${n} حوالات` : `${n} حوالة`);
const byAppOf = (r) => r.byApp || (r.card ? [{ app: 'تطبيق', count: 0, total: r.card }] : []);

// بطاقة لكل طريقة دفع: نقدي، وكل تطبيق مع عدد الحوالات اللي وصلت عليه
function payCards(r, S) {
  const by = new Map(byAppOf(r).map((a) => [a.app, a]));
  const apps = [...new Set([...(S.settings.payApps || []), ...by.keys()])];
  return `
    <div class="cards pay-cards">
      <div class="stat"><span>${icon('cash')}نقدي</span><b class="num">${money(r.cash, { fixed: true })}</b><small>${r.cashCount ? invoicesText(r.cashCount) : 'ما في'}</small></div>
      ${apps.map((a) => {
        const x = by.get(a) || { count: 0, total: 0 };
        return `<div class="stat ${x.count ? 'got' : ''}"><span>${icon('wallet')}${esc(a)}</span><b class="num">${money(x.total, { fixed: true })}</b>
          <small>${x.count ? `وصلك ${transfersText(x.count)}` : 'ما وصل حوالات'}</small></div>`;
      }).join('')}
    </div>`;
}

// جدول الحوالات مع فلتر حسب التطبيق (للمطابقة مع البنك والمحفظة)
function transfersPanel(r, state, { withDate = false } = {}) {
  const list = (r.transfers || []).filter((t) => !state.app || t.app === state.app);
  const apps = [...new Set((r.transfers || []).map((t) => t.app))];
  const sum = list.reduce((a, t) => a + t.total, 0);
  return `
    <section class="panel" style="margin-top:14px" id="trPanel">
      <div class="row" style="margin-bottom:10px"><h2 style="margin:0" class="grow">الحوالات</h2>
        ${apps.length > 1 ? `<div class="seg" id="trFilter"><button type="button" data-tr="" aria-pressed="${!state.app}">الكل</button>${apps.map((a) => `<button type="button" data-tr="${esc(a)}" aria-pressed="${state.app === a}">${esc(a)}</button>`).join('')}</div>` : ''}</div>
      ${list.length ? `<table class="data">
        <thead><tr><th>الوقت</th><th>على</th><th>اسم اللي حوّل</th><th>رقم الحوالة</th><th>فاتورة</th><th class="n">المبلغ</th></tr></thead>
        <tbody>${list.map((t) => `<tr>
          <td class="tnum">${withDate ? fmtDateTime(t.at) : fmtTime(t.at)}</td>
          <td><span class="pill viaapp">${esc(t.app)}</span></td>
          <td><b>${esc(t.payer || '—')}</b></td>
          <td class="num">${esc(t.ref || '')}</td>
          <td class="num">${t.no}</td>
          <td class="n num"><b>${money(t.total, { fixed: true })}</b></td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="5" style="padding-top:12px"><b>${state.app ? `مجموع ${esc(state.app)}` : 'مجموع الحوالات'} · ${transfersText(list.length)}</b></td>
          <td class="n num" style="padding-top:12px"><b>${money(sum, { fixed: true })}</b></td></tr></tfoot>
      </table>` : '<p class="muted" style="margin:0">ما وصل حوالات بهالفترة.</p>'}
    </section>`;
}
const place = (i) => (i.kind === 'table' ? `طاولة ${i.table}` : `طلب خارجي${i.label ? ` · ${esc(i.label)}` : ''}`);

// ───── الفواتير ─────

const IV = { date: localDate(), status: 'all', q: '', sel: null, list: [], preview: null };

export async function renderInvoices(ctx) {
  const { el, api } = ctx;
  el.innerHTML = `
    <div class="page-head">
      <h1>الفواتير</h1><span class="grow"></span>
      <input class="input" type="date" id="ivDate" value="${IV.date}" style="width:auto" aria-label="اليوم">
      <div class="seg" id="ivStatus">${['all', 'paid', 'open', 'void'].map((s) => `<button type="button" data-s="${s}" aria-pressed="${IV.status === s}">${s === 'all' ? 'الكل' : STATUS[s]}</button>`).join('')}</div>
      <input class="input" type="search" id="ivQ" value="${esc(IV.q)}" placeholder="رقم فاتورة أو طاولة" style="width:200px" aria-label="بحث">
    </div>
    <div class="inv-layout">
      <div class="panel" id="ivList"><p class="muted">عم نجيب الفواتير…</p></div>
      <aside class="panel inv-preview" id="ivPreview"><p class="muted" style="margin:0">اختار فاتورة لتشوف تفاصيلها، تطبع نسخة، أو تلغيها.</p></aside>
    </div>`;

  const load = async () => {
    const from = dayStart(IV.date);
    const params = new URLSearchParams({ status: IV.status });
    if (IV.q.trim()) params.set('q', IV.q.trim());
    else { params.set('from', iso(from)); params.set('to', iso(addDays(from, 1))); }
    try {
      IV.list = await api(`/invoices?${params}`);
    } catch (e) { toast(e.message, 'err'); IV.list = []; }
    drawList();
  };

  const drawList = () => {
    const sum = IV.list.filter((i) => i.status === 'paid').reduce((a, i) => a + i.total, 0);
    $('#ivList').innerHTML = IV.list.length ? `
      <table class="data">
        <thead><tr><th>رقم</th><th>المكان</th><th>الحالة</th><th>الوقت</th><th>الدفع</th><th class="n">المبلغ</th></tr></thead>
        <tbody>${IV.list.map((i) => `
          <tr class="click ${IV.sel === i.id ? 'sel' : ''}" data-iv="${i.id}">
            <td class="num"><b>${i.no}</b></td><td>${place(i)}</td>
            <td><span class="pill ${i.status}">${STATUS[i.status]}</span></td>
            <td class="tnum">${IV.q ? `${fmtDate(i.paidAt || i.createdAt)} ` : ''}${fmtTime(i.paidAt || i.createdAt)}</td>
            <td>${payLabel(i)}${i.payer ? `<br><small class="muted">${esc(i.payer)}</small>` : ''}</td>
            <td class="n num">${money(i.total, { fixed: true })}</td>
          </tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="5" style="padding-top:12px"><b>مجموع المدفوعة</b></td><td class="n num" style="padding-top:12px"><b>${money(sum, { fixed: true })} ${esc(ctx.cur())}</b></td></tr></tfoot>
      </table>` : '<p class="empty">ما في فواتير بهاليوم.</p>';
  };

  const preview = async (id) => {
    IV.sel = id;
    drawList();
    let inv;
    try { inv = await api(`/invoices/${id}`); } catch (e) { return toast(e.message, 'err'); }
    IV.preview = inv;
    const today = inv.status !== 'paid' || inv.dayId === ctx.S.day?.dayId;
    $('#ivPreview').innerHTML = `
      <div class="row" style="margin-bottom:10px"><h2 style="margin:0">فاتورة <span class="num">${inv.no}</span></h2><span class="pill ${inv.status}">${STATUS[inv.status]}</span></div>
      <p class="muted" style="margin:0 0 10px">${place(inv)} · <span class="tnum">${fmtDateTime(inv.paidAt || inv.createdAt)}</span>${inv.voidReason ? `<br>سبب الإلغاء: ${esc(inv.voidReason)}` : ''}</p>
      <div class="lines"><table>
        <thead><tr><th>الصنف</th><th class="q">الكمية</th><th class="n">المجموع</th></tr></thead>
        <tbody>${inv.lines.map((l) => `<tr><td>${esc(l.name)}${l.note ? `<span class="nt">— ${esc(l.note)}</span>` : ''}</td><td class="q num">${money(l.qty)}</td><td class="n num">${money(l.qty * l.price, { fixed: true })}</td></tr>`).join('')}</tbody>
      </table></div>
      <div style="display:grid;gap:4px;margin:12px 0">
        ${inv.discount ? `<div class="row"><span class="grow">خصم</span><b class="num">${money(inv.discount, { fixed: true })}</b></div>` : ''}
        <div class="row"><span class="grow">الإجمالي</span><b class="num" style="font-size:20px">${money(inv.total, { fixed: true })} ${esc(ctx.cur())}</b></div>
        ${inv.status === 'paid' ? `<div class="row"><span class="grow">الدفع</span><b>${inv.method === 'app' ? `حوالة ${esc(inv.payApp || 'تطبيق')}` : 'نقدي'}</b></div>` : ''}
        ${inv.payer ? `<div class="row"><span class="grow">باسم</span><b>${esc(inv.payer)}</b></div>` : ''}
        ${inv.payRef ? `<div class="row"><span class="grow">رقم الحوالة</span><b class="num">${esc(inv.payRef)}</b></div>` : ''}
      </div>
      <div class="row">
        ${inv.status === 'open' ? `<button class="btn btn-brand" type="button" data-iv-open>افتحها بشاشة البيع</button>` : ''}
        ${inv.status !== 'void' && inv.lines.length ? `<button class="btn" type="button" data-iv-print>${icon('printer')}${inv.status === 'paid' ? 'اطبع نسخة' : 'اطبع'}</button>` : ''}
        ${inv.status !== 'void' && today ? `<button class="btn btn-danger" type="button" data-iv-void>${icon('trash')}إلغاء</button>` : ''}
      </div>`;
  };

  el.onclick = (e) => {
    const s = e.target.closest('#ivStatus [data-s]');
    if (s) { IV.status = s.dataset.s; $$('#ivStatus [data-s]').forEach((b) => b.setAttribute('aria-pressed', String(b === s))); return load(); }
    const row = e.target.closest('[data-iv]');
    if (row) return preview(Number(row.dataset.iv));
    const inv = IV.preview;
    if (!inv) return;
    if (e.target.closest('[data-iv-print]')) {
      printReceipt(inv, ctx.S.settings, { copy: inv.status === 'paid' }).catch((er) => toast(er.message, 'err'));
      api(`/invoices/${inv.id}/printed`, { method: 'POST' }).catch(() => {});
    }
    if (e.target.closest('[data-iv-void]')) ctx.voidBill(inv, { after: () => { load(); preview(inv.id).catch(() => {}); ctx.refreshDay(); } });
    if (e.target.closest('[data-iv-open]')) {
      ctx.go('pos');
      if (inv.kind === 'table') ctx.selectTable(inv.table);
      else ctx.selectTakeaway(inv.id);
    }
  };
  $('#ivDate').onchange = (e) => { IV.date = e.target.value || localDate(); IV.q = ''; $('#ivQ').value = ''; load(); };
  let t;
  $('#ivQ').oninput = (e) => { IV.q = e.target.value; clearTimeout(t); t = setTimeout(load, 250); };
  await load();
  if (IV.sel && IV.list.some((i) => i.id === IV.sel)) preview(IV.sel);
}

// ───── اليوم: المبيعات والمصاريف والإغلاق ─────

const DY = { app: '' };

export async function renderDay(ctx) {
  const { el, api, S } = ctx;
  try { S.day = await api('/day'); } catch (e) { toast(e.message, 'err'); }
  const r = S.day;
  if (!r) return;
  const c = esc(ctx.cur());
  const max = Math.max(1, ...r.items.map((i) => i.amount));
  el.innerHTML = `
    <div class="page-head">
      <h1>اليوم</h1>
      <span class="muted">من <span class="tnum">${fmtDateTime(r.openedAt)}</span></span>
      <span class="grow"></span>
      <button class="btn" type="button" id="dayPrint">${icon('printer')}اطبع تقرير لهلأ</button>
      <button class="btn btn-char" type="button" id="dayClose">${icon('lock')}إغلاق اليوم</button>
    </div>
    <div class="cards">
      <div class="stat hero"><span>صافي المبيعات</span><b class="num">${money(r.total, { fixed: true })} ${c}</b></div>
      <div class="stat"><span>عدد الفواتير</span><b class="num">${r.count}</b></div>
      <div class="stat"><span>المصاريف</span><b class="num">${money(r.expenses, { fixed: true })}</b></div>
      <div class="stat"><span>النقدي بالدرج</span><b class="num">${money(r.cash - r.expenses, { fixed: true })}</b><small>النقدي ناقص المصاريف</small></div>
    </div>
    <h2 class="sec-h">طرق الدفع</h2>
    ${payCards(r, S)}
    <div class="cols">
      <section class="panel">
        <h2>المصاريف</h2>
        <form class="row" id="expForm" style="margin-bottom:12px">
          <input class="input num" name="amount" inputmode="decimal" dir="ltr" placeholder="المبلغ" style="width:110px" aria-label="المبلغ" required>
          <input class="input grow" name="note" placeholder="على شو؟ (غاز، خضرة، خبز…)" maxlength="80" aria-label="على شو" required style="width:auto">
          <button class="btn btn-brand" type="submit">${icon('plus')}ضيف</button>
        </form>
        ${r.expenseList.length ? `<table class="data"><tbody>${r.expenseList.map((x) => `
          <tr><td class="tnum" style="width:80px">${fmtTime(x.createdAt)}</td><td>${esc(x.note)}</td><td class="n num"><b>${money(x.amount, { fixed: true })}</b></td>
          <td style="width:44px"><button class="icon-btn" type="button" data-exp-del="${x.id}" aria-label="احذف">${icon('trash')}</button></td></tr>`).join('')}</tbody></table>`
          : '<p class="muted" style="margin:0">ما في مصاريف اليوم.</p>'}
      </section>
      <section class="panel">
        <h2>شو انباع اليوم</h2>
        ${r.items.length ? `<div class="bars">${r.items.slice(0, 15).map((i) => `
          <div class="bar" style="grid-template-columns: 140px minmax(0,1fr) 110px"><span>${esc(i.name)} <span class="muted tnum">· ${money(i.qty)}</span></span><i style="width:${(i.amount / max) * 100}%"></i><span class="n num">${money(i.amount, { fixed: true })}</span></div>`).join('')}</div>`
          : '<p class="muted" style="margin:0">لسا ما في مبيعات.</p>'}
      </section>
    </div>
    <section class="panel" style="margin-top:14px">
      <h2>تفاصيل</h2>
      <div class="cards" style="margin:0">
        <div class="stat"><span>قبل الخصم</span><b class="num">${money(r.gross, { fixed: true })}</b></div>
        <div class="stat"><span>الخصومات</span><b class="num">${money(r.discounts, { fixed: true })}</b></div>
        <div class="stat"><span>متوسط الفاتورة</span><b class="num">${money(r.average, { fixed: true })}</b></div>
        <div class="stat"><span>فواتير ملغية</span><b class="tnum">${r.voids.count} <small class="muted" style="font-size:14px;font-weight:500">${r.voids.count ? `بقيمة ${money(r.voids.total)}` : ''}</small></b></div>
        <div class="stat"><span>فواتير لسا مفتوحة</span><b class="tnum">${r.open.count} <small class="muted" style="font-size:14px;font-weight:500">${r.open.count ? `بقيمة ${money(r.open.total)}` : ''}</small></b></div>
      </div>
    </section>
    ${transfersPanel(r, DY)}`;

  $('#expForm').onsubmit = (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    ctx.act(async () => { S.day = await api('/expenses', { method: 'POST', body: f }); renderDay(ctx); ctx.renderTop(); });
  };
  el.onclick = async (e) => {
    const del = e.target.closest('[data-exp-del]');
    if (del) return ctx.act(async () => { S.day = await api(`/expenses/${del.dataset.expDel}`, { method: 'DELETE' }); renderDay(ctx); });
    const tr = e.target.closest('[data-tr]');
    if (tr) { DY.app = tr.dataset.tr; $('#trPanel').outerHTML = transfersPanel(S.day, DY); return; }
    if (e.target.closest('#dayPrint')) return printDayReport(S.day, S.settings);
    if (e.target.closest('#dayClose')) {
      const warn = r.open.count ? `<br><b style="color:var(--danger)">في ${r.open.count} فواتير لسا مفتوحة.</b> بتضل مفتوحة وبتنحسب على اليوم الجاي لما تندفع.` : '';
      const ok = await confirmBox('إغلاق اليوم', `بنطبع تقرير اليوم وبنبلّش يوم جديد بعدّاد صفر.${warn}`, 'سكّر اليوم واطبع', false);
      if (!ok) return;
      ctx.act(async () => {
        const { report } = await api('/day/close', { method: 'POST' });
        await printDayReport(report, S.settings);
        toast('انسكّر اليوم وانحفظت نسخة احتياطية', 'ok');
        await ctx.refreshDay();
        renderDay(ctx);
      });
    }
  };
}

// ───── التقارير ─────

const RP = { range: 'month', from: localDate(addDays(new Date(), -6)), to: localDate(), app: '' };

function rangeDates() {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (RP.range === 'week') return [addDays(today, -6), addDays(today, 1)];
  if (RP.range === 'month') return [new Date(today.getFullYear(), today.getMonth(), 1), addDays(today, 1)];
  if (RP.range === 'last') return [new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 1)];
  return [dayStart(RP.from), addDays(dayStart(RP.to), 1)];
}

export async function renderReports(ctx) {
  const { el, api, S } = ctx;
  const [from, to] = rangeDates();
  let r; let days = [];
  try {
    [r, days] = await Promise.all([api(`/reports?from=${encodeURIComponent(iso(from))}&to=${encodeURIComponent(iso(to))}`), api('/days')]);
  } catch (e) { return toast(e.message, 'err'); }
  const c = esc(ctx.cur());
  const maxDay = Math.max(1, ...r.byDay.map((d) => d.total));
  const maxItem = Math.max(1, ...r.items.map((i) => i.amount));
  el.innerHTML = `
    <div class="page-head">
      <h1>التقارير</h1><span class="grow"></span>
      <div class="seg" id="rpRange">${[['week', 'آخر 7 أيام'], ['month', 'هالشهر'], ['last', 'الشهر الماضي'], ['custom', 'فترة']].map(([k, l]) => `<button type="button" data-r="${k}" aria-pressed="${RP.range === k}">${l}</button>`).join('')}</div>
      ${RP.range === 'custom' ? `<input class="input" type="date" id="rpFrom" value="${RP.from}" style="width:auto" aria-label="من"><span>←</span><input class="input" type="date" id="rpTo" value="${RP.to}" style="width:auto" aria-label="لـ">` : ''}
    </div>
    <p class="muted" style="margin:-6px 0 14px">من <span class="num">${fmtDate(iso(from))}</span> لـ <span class="num">${fmtDate(iso(addDays(to, -1)))}</span></p>
    <div class="cards">
      <div class="stat hero"><span>صافي المبيعات</span><b class="num">${money(r.total, { fixed: true })} ${c}</b></div>
      <div class="stat"><span>الفواتير</span><b class="num">${r.count}</b></div>
      <div class="stat"><span>متوسط الفاتورة</span><b class="num">${money(r.average, { fixed: true })}</b></div>
      <div class="stat"><span>الخصومات</span><b class="num">${money(r.discounts, { fixed: true })}</b></div>
      <div class="stat"><span>المصاريف</span><b class="num">${money(r.expenses, { fixed: true })}</b></div>
      <div class="stat"><span>المبيعات ناقص المصاريف</span><b class="num">${money(r.net, { fixed: true })}</b></div>
    </div>
    <h2 class="sec-h">طرق الدفع</h2>
    ${payCards(r, S)}
    <div class="cols">
      <section class="panel">
        <h2>يوم بيوم</h2>
        ${r.byDay.length ? `<div class="bars">${r.byDay.map((d) => `
          <div class="bar"><span class="num">${fmtDate(d.day + 'T12:00:00')}</span><i style="width:${(d.total / maxDay) * 100}%"></i><span class="n num">${money(d.total)}</span></div>`).join('')}</div>`
          : '<p class="muted" style="margin:0">ما في مبيعات بهالفترة.</p>'}
      </section>
      <section class="panel">
        <h2>الأصناف</h2>
        ${r.items.length ? `<table class="data"><thead><tr><th>الصنف</th><th class="n">الكمية</th><th class="n">المبلغ</th><th style="width:30%"></th></tr></thead><tbody>
          ${r.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="n num">${money(i.qty)}</td><td class="n num">${money(i.amount, { fixed: true })}</td><td><div class="bar" style="display:block"><i style="width:${(i.amount / maxItem) * 100}%"></i></div></td></tr>`).join('')}
        </tbody></table>` : '<p class="muted" style="margin:0">ما في أصناف انباعت بهالفترة.</p>'}
      </section>
    </div>
    <section class="panel" style="margin-top:14px">
      <h2>الأيام المسكّرة</h2>
      ${days.length ? `<table class="data"><thead><tr><th>بلّش</th><th>سكّر</th><th class="n">الفواتير</th><th class="n">المبيعات</th><th class="n">المصاريف</th><th></th></tr></thead><tbody>
        ${days.map((d) => `<tr><td class="tnum">${fmtDateTime(d.openedAt)}</td><td class="tnum">${d.closedAt ? fmtDateTime(d.closedAt) : '<span class="pill open">اليوم الحالي</span>'}</td>
          <td class="n num">${d.count}</td><td class="n num"><b>${money(d.total, { fixed: true })}</b></td><td class="n num">${money(d.expenses, { fixed: true })}</td>
          <td style="width:60px"><button class="icon-btn" type="button" data-day-print="${d.id}" title="اطبع تقرير هاليوم" aria-label="اطبع">${icon('printer')}</button></td></tr>`).join('')}
      </tbody></table>` : ''}
    </section>
    ${transfersPanel(r, RP, { withDate: true })}`;

  el.onclick = async (e) => {
    const b = e.target.closest('#rpRange [data-r]');
    if (b) { RP.range = b.dataset.r; return renderReports(ctx); }
    const tr = e.target.closest('[data-tr]');
    if (tr) { RP.app = tr.dataset.tr; $('#trPanel').outerHTML = transfersPanel(r, RP, { withDate: true }); return; }
    const p = e.target.closest('[data-day-print]');
    if (p) ctx.act(async () => printDayReport(await api(`/days/${p.dataset.dayPrint}`), S.settings));
  };
  const f = $('#rpFrom'); const t = $('#rpTo');
  if (f) f.onchange = () => { RP.from = f.value || RP.from; renderReports(ctx); };
  if (t) t.onchange = () => { RP.to = t.value || RP.to; renderReports(ctx); };
}

// ───── القائمة ─────

const MN = { cat: null };

export const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5]; // السبت أول الأسبوع
export const daysLabel = (days) => (days ? days.map((d) => DAYS[d]).join(' و') + ' بس' : 'كل يوم');

// الصورة بتتصغّر بالمتصفح (أطول ضلع 1000) قبل ما تنرفع، فبتضل خفيفة على الجوالات
async function shrink(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
}

// نافذة تعديل صنف أو قسم: الاسم والحقول والصورة (والأيام للقسم)
function editor(ctx, { kind, rec }) {
  const { S, api, cur } = ctx;
  const isItem = kind === 'item';
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    d.style.width = 'min(520px, calc(100vw - 24px))';
    let file = null;
    let removePhoto = false;
    const days = new Set(rec?.days ?? [0, 1, 2, 3, 4, 5, 6]);
    d.innerHTML = `
      <form>
        <div class="dlg-head"><h2>${isItem ? (rec ? `تعديل ${esc(rec.name)}` : 'صنف جديد') : (rec ? `قسم ${esc(rec.name)}` : 'قسم جديد')}</h2>
          <button class="icon-btn" type="button" data-close aria-label="إغلاق">${icon('x')}</button></div>
        <div class="dlg-body">
          <div class="photo-pick">
            <div class="ph" id="ph">${rec?.image ? `<img src="${esc(rec.image)}" alt="">` : `<span>${icon('image')}ما في صورة</span>`}</div>
            <div class="row" style="flex-direction:column;align-items:stretch">
              <label class="btn btn-sm">${icon('image')}اختار صورة<input type="file" accept="image/*" id="phFile" hidden></label>
              <button class="btn btn-sm btn-ghost" type="button" id="phDel" ${rec?.image ? '' : 'hidden'}>شيل الصورة</button>
              <small class="muted">صورة الصحن بتطلع للزبون بمنيو الجوال</small>
            </div>
          </div>
          <label class="field"><span>${isItem ? 'اسم الصنف' : 'اسم القسم'}</span><input class="input" name="name" value="${esc(rec?.name || '')}" maxlength="${isItem ? 60 : 40}" autocomplete="off"></label>
          ${isItem ? `
            <div class="row" style="align-items:flex-start">
              <label class="field grow"><span>السعر (${esc(cur())})</span><input class="input num" name="price" inputmode="decimal" dir="ltr" value="${rec?.price ?? ''}" autocomplete="off"></label>
              <label class="field grow"><span>القسم</span><select class="select" name="categoryId">${S.menu.categories.map((c) => `<option value="${c.id}" ${c.id === (rec?.categoryId ?? MN.cat) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
            </div>
            <label class="field"><span>وصف قصير (بيطلع بمنيو الجوال)</span><input class="input" name="note" value="${esc(rec?.note || '')}" maxlength="120" placeholder="اختياري" autocomplete="off"></label>`
          : `
            <div class="field"><span>الأيام اللي بيطلع فيها القسم</span>
              <div class="days" id="days">${WEEK_ORDER.map((n) => `<button type="button" data-day="${n}" aria-pressed="${days.has(n)}">${DAYS[n]}</button>`).join('')}</div>
              <small>مثلاً قسم الضاني: الخميس بس. باقي الأيام بيطلع للزبون "بس يوم الخميس" وما بيقدر يطلب منه.</small>
            </div>`}
          <p class="dlg-err" role="alert"></p>
        </div>
        <div class="dlg-foot">
          <button class="btn" type="button" data-close>إلغاء</button>
          <button class="btn btn-brand" type="submit">${rec ? 'حفظ' : 'ضيف'}</button>
        </div>
      </form>`;
    document.body.append(d);
    const err = (m) => { $('.dlg-err', d).textContent = m; };
    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return d.close();
      const day = e.target.closest('[data-day]');
      if (day) {
        const n = Number(day.dataset.day);
        if (days.has(n)) days.delete(n); else days.add(n);
        day.setAttribute('aria-pressed', String(days.has(n)));
      }
      if (e.target.closest('#phDel')) {
        file = null; removePhoto = true;
        $('#ph', d).innerHTML = `<span>${icon('image')}ما في صورة</span>`;
        $('#phDel', d).hidden = true;
      }
    });
    $('#phFile', d).addEventListener('change', async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try {
        file = await shrink(f);
        removePhoto = false;
        $('#ph', d).innerHTML = `<img src="${URL.createObjectURL(file)}" alt="">`;
        $('#phDel', d).hidden = false;
        err('');
      } catch { err('ما قدرنا نفتح هالصورة، جرّب صورة JPG أو PNG'); }
    });
    $('form', d).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      if (!f.name.trim()) return err(isItem ? 'اكتب اسم الصنف' : 'اكتب اسم القسم');
      let body;
      if (isItem) {
        if (f.price === '' || !(Number(f.price) >= 0)) return err('اكتب السعر رقم');
        body = { name: f.name, price: Number(f.price), categoryId: Number(f.categoryId), note: f.note, available: rec ? rec.available : true };
      } else {
        if (!days.size) return err('اختار يوم واحد على الأقل');
        body = { name: f.name, days: [...days] };
      }
      const base = isItem ? '/items' : '/categories';
      const btn = $('button[type=submit]', d);
      btn.disabled = true;
      try {
        let out = await api(rec ? `${base}/${rec.id}` : base, { method: rec ? 'PUT' : 'POST', body });
        if (file) {
          const res = await fetch(`/api${base}/${out.id}/image`, { method: 'PUT', headers: { 'content-type': 'image/jpeg', 'x-token': S.token }, body: file });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || 'ما انرفعت الصورة');
          out = { ...data, id: out.id };
        } else if (removePhoto && rec?.image) {
          out = { ...(await api(`${base}/${out.id}/image`, { method: 'DELETE' })), id: out.id };
        }
        d.close();
        resolve(out);
      } catch (er) {
        err(er.message);
        btn.disabled = false;
      }
    });
    d.addEventListener('close', () => { resolve(null); d.remove(); });
    d.showModal();
    $('input[name=name]', d).focus();
  });
}

export function renderMenu(ctx) {
  const { el, api, S, catColor } = ctx;
  const cats = S.menu.categories;
  if (!cats.some((c) => c.id === MN.cat)) MN.cat = cats[0]?.id ?? null;
  const cat = cats.find((x) => x.id === MN.cat);
  const items = S.menu.items.filter((i) => i.categoryId === MN.cat);
  const c = esc(ctx.cur());
  const thumb = (src, cls = '') => `<span class="thumb ${cls}">${src ? `<img src="${esc(src)}" alt="" loading="lazy">` : icon('image')}</span>`;
  el.innerHTML = `
    <div class="page-head"><h1>القائمة</h1><span class="muted">الأصناف والأسعار والصور هون هي اللي بتطلع للكاشير وبمنيو الجوال</span></div>
    <div class="menu-layout">
      <section class="panel">
        <div class="row" style="margin-bottom:10px"><h2 style="margin:0" class="grow">الأقسام</h2>
          <button class="btn btn-sm" type="button" data-m="add-cat">${icon('plus')}قسم</button></div>
        <div class="cat-list">${cats.map((x, i) => `
          <div class="cat-row ${x.id === MN.cat ? 'sel' : ''}" style="--c:${catColor(x.id)}">
            ${thumb(x.image, 'sm')}
            <button class="nm" type="button" data-m="cat" data-id="${x.id}">${esc(x.name)} <span class="muted num">(${S.menu.items.filter((it) => it.categoryId === x.id).length})</span>
              ${x.days ? `<small class="days-tag">${esc(daysLabel(x.days))}</small>` : ''}</button>
            <button class="icon-btn" type="button" data-m="up" data-id="${x.id}" ${i === 0 ? 'disabled' : ''} aria-label="لفوق">${icon('up')}</button>
            <button class="icon-btn" type="button" data-m="down" data-id="${x.id}" ${i === cats.length - 1 ? 'disabled' : ''} aria-label="لتحت">${icon('down')}</button>
            <button class="icon-btn" type="button" data-m="edit-cat" data-id="${x.id}" aria-label="عدّل القسم">${icon('edit')}</button>
          </div>`).join('')}</div>
      </section>
      <section class="panel">
        <div class="row" style="margin-bottom:10px">
          <h2 style="margin:0" class="grow">${esc(cat?.name || 'الأصناف')} ${cat?.days ? `<small class="days-tag">${esc(daysLabel(cat.days))}</small>` : ''}</h2>
          ${cat ? `<button class="btn btn-sm btn-danger" type="button" data-m="del-cat" data-id="${cat.id}">${icon('trash')}احذف القسم</button>
                   <button class="btn btn-brand btn-sm" type="button" data-m="add-item">${icon('plus')}صنف جديد</button>` : ''}</div>
        ${items.length ? `<table class="data">
          <thead><tr><th style="width:70px"></th><th>الصنف</th><th class="n">السعر</th><th>متوفّر</th><th style="width:96px"></th></tr></thead>
          <tbody>${items.map((i) => `
            <tr><td>${thumb(i.image)}</td>
              <td><b>${esc(i.name)}</b>${i.note ? `<br><small class="muted">${esc(i.note)}</small>` : ''}</td>
              <td class="n num"><b>${money(i.price)}</b> ${c}</td>
              <td><label class="switch"><input type="checkbox" data-avail="${i.id}" ${i.available ? 'checked' : ''}><span>${i.available ? 'موجود' : 'خلص'}</span></label></td>
              <td style="white-space:nowrap"><button class="icon-btn" type="button" data-m="edit" data-id="${i.id}" aria-label="عدّل">${icon('edit')}</button>
                  <button class="icon-btn" type="button" data-m="del-item" data-id="${i.id}" aria-label="احذف">${icon('trash')}</button></td></tr>`).join('')}
          </tbody></table>` : '<p class="empty">القسم فاضي. اكبس "صنف جديد".</p>'}
      </section>
    </div>`;

  const save = (fn) => ctx.act(async () => { const out = await fn(); if (out) { S.menu = { categories: out.categories, items: out.items }; renderMenu(ctx); } return out; });

  el.onclick = async (e) => {
    const b = e.target.closest('[data-m]');
    if (!b || b.disabled) return;
    const id = Number(b.dataset.id);
    const m = b.dataset.m;
    if (m === 'cat') { MN.cat = id; return renderMenu(ctx); }
    if (m === 'up' || m === 'down') return save(() => api(`/categories/${id}/move`, { method: 'POST', body: { dir: m === 'up' ? -1 : 1 } }));
    if (m === 'add-cat' || m === 'edit-cat') {
      const out = await editor(ctx, { kind: 'category', rec: cats.find((x) => x.id === id) });
      if (out) { if (m === 'add-cat') MN.cat = out.id; save(async () => out); }
      return;
    }
    if (m === 'del-cat') {
      if (await confirmBox('حذف قسم', `بدك تحذف قسم "${esc(cat.name)}"؟ لازم يكون فاضي.`, 'احذف')) save(() => api(`/categories/${id}`, { method: 'DELETE' }));
      return;
    }
    const it = S.menu.items.find((x) => x.id === id);
    if (m === 'add-item' || m === 'edit') {
      const out = await editor(ctx, { kind: 'item', rec: m === 'edit' ? it : null });
      if (out) save(async () => out);
      return;
    }
    if (m === 'del-item' && await confirmBox('حذف صنف', `بدك تحذف "${esc(it.name)}" من القائمة؟ الفواتير القديمة ما بتتأثر.`, 'احذف')) {
      save(() => api(`/items/${id}`, { method: 'DELETE' }));
    }
  };
  el.onchange = (e) => {
    const a = e.target.closest('[data-avail]');
    if (a) save(() => api(`/items/${a.dataset.avail}/available`, { method: 'POST', body: { available: a.checked } }));
  };
}

// ───── الإعدادات ─────

export function renderSettings(ctx) {
  const { el, api, S } = ctx;
  const s = S.settings;
  const zones = s.zones.map((z) => ({ ...z }));
  const menuUrl = `${S.site}/`;
  el.innerHTML = `
    <div class="page-head"><h1>الإعدادات</h1></div>
    <div class="cols">
      <section class="panel">
        <h2>معلومات المطعم</h2>
        <form class="form-grid" id="fInfo">
          <label class="field"><span>اسم المطعم</span><input class="input" name="name" value="${esc(s.name)}" maxlength="80"></label>
          <label class="field"><span>رقم التلفون</span><input class="input num" name="phone" value="${esc(s.phone)}" maxlength="40" dir="ltr"></label>
          <label class="field" style="grid-column:1/-1"><span>العنوان</span><input class="input" name="address" value="${esc(s.address)}" maxlength="160"></label>
          <label class="field" style="grid-column:1/-1"><span>الجملة آخر الفاتورة</span><input class="input" name="receiptFooter" value="${esc(s.receiptFooter)}" maxlength="160"></label>
          <label class="field"><span>رمز العملة</span><input class="input" name="currency" value="${esc(s.currency)}" maxlength="6" style="width:100px"></label>
          <div class="row" style="grid-column:1/-1;justify-content:flex-end"><button class="btn btn-brand" type="submit">حفظ</button></div>
        </form>
      </section>

      <section class="panel">
        <h2>الطباعة</h2>
        <form class="form-grid" id="fPrint">
          <div class="field"><span>عرض ورق الطابعة</span>
            <div class="seg" id="paperSeg">${[80, 58].map((p) => `<button type="button" data-paper="${p}" aria-pressed="${s.paper === p}"><span class="num">${p}</span> ملم</button>`).join('')}</div></div>
          <label class="field"><span>طول الشعار بالفاتورة (ملم)</span><input class="input num" name="receiptLogoMm" value="${s.receiptLogoMm}" inputmode="numeric" style="width:100px" dir="ltr"></label>
          <label class="switch" style="grid-column:1/-1"><input type="checkbox" name="receiptLogo" ${s.receiptLogo ? 'checked' : ''}>اطبع الشعار براس الفاتورة</label>
          <label class="switch" style="grid-column:1/-1"><input type="checkbox" name="printOnPay" ${s.printOnPay ? 'checked' : ''}>اطبع الفاتورة لحالها لما يندفع الحساب</label>
          <div class="row" style="grid-column:1/-1;justify-content:flex-end">
            <button class="btn" type="button" id="testPrint">${icon('printer')}فاتورة تجربة</button>
            <button class="btn btn-brand" type="submit">حفظ</button></div>
        </form>
        <p class="muted" style="margin:12px 0 0;font-size:13px">عشان الطباعة تطلع على طول بدون نافذة: شغّل البرنامج من ملف "تشغيل الكاشير" وخلّي طابعة الفواتير هي الطابعة الافتراضية بالويندوز.</p>
      </section>

      <section class="panel">
        <h2>الطاولات</h2>
        <div id="zones" style="display:grid;gap:8px"></div>
        <div class="row" style="margin-top:10px">
          <button class="btn btn-sm" type="button" id="addZone">${icon('plus')}منطقة</button><span class="grow"></span>
          <span class="muted" id="zoneSum"></span>
          <button class="btn btn-brand" type="button" id="saveZones">حفظ</button>
        </div>
      </section>

      <section class="panel">
        <h2>الطلب من الجوال</h2>
        <label class="switch" style="margin-bottom:12px"><input type="checkbox" id="acceptOrders" ${s.acceptOrders ? 'checked' : ''}>الزباين بيقدروا يطلبوا من جوالاتهم</label>
        <div class="qr-box">
          <div class="qr">${qrSvg(menuUrl)}</div>
          <div style="display:grid;gap:6px;flex:1;min-width:200px">
            <span class="muted" style="font-size:13px">رابط المنيو (لازم الجوال يكون على واي فاي المطعم)</span>
            <a class="link num" href="${esc(menuUrl)}" target="_blank" rel="noopener">${esc(menuUrl)}</a>
            <button class="btn btn-brand" type="button" id="printQrs">${icon('qr')}اطبع QR لكل الطاولات</button>
          </div>
        </div>
        <form id="fUrl" style="margin-top:12px;display:grid;gap:6px">
          <label class="field"><span>رابط الموقع للـ QR</span>
            <input class="input num" name="publicUrl" value="${esc(s.publicUrl)}" placeholder="${esc(S.addresses[0] ? `http://${S.addresses[0]}:${location.port || 80}` : '')}" dir="ltr">
            <small>خلّيه فاضي ليتعبّى لحاله من عنوان الجهاز${S.addresses.length ? ` (${S.addresses.map(esc).join('، ')})` : ''}. ثبّت عنوان اللابتوب من الراوتر عشان ما تتغيّر الكروت.</small></label>
          <div class="row" style="justify-content:flex-end"><button class="btn btn-sm" type="submit">حفظ الرابط</button></div>
        </form>
      </section>

      <section class="panel">
        <h2>الدفع بالتطبيقات</h2>
        <p class="muted" style="margin:0 0 10px">لما الزبون يدفع بتطبيق، الكاشير بيختار على أي واحد حوّل وبيكتب اسمه، وبالتقارير بيطلع كم حوالة وصلت على كل واحد.</p>
        <div id="apps" style="display:grid;gap:8px"></div>
        <div class="row" style="margin-top:10px">
          <button class="btn btn-sm" type="button" id="addApp">${icon('plus')}تطبيق</button><span class="grow"></span>
          <button class="btn btn-brand" type="button" id="saveApps">حفظ</button>
        </div>
      </section>

      <section class="panel">
        <h2>رمز الكاشير</h2>
        <form class="form-grid" id="fPin">
          <label class="field"><span>الرمز الحالي</span><input class="input num" name="old" type="password" inputmode="numeric" autocomplete="off" dir="ltr"></label>
          <label class="field"><span>الرمز الجديد (4 لـ 8 أرقام)</span><input class="input num" name="pin" type="password" inputmode="numeric" autocomplete="new-password" dir="ltr"></label>
          <div class="row" style="grid-column:1/-1;justify-content:flex-end"><button class="btn btn-brand" type="submit">غيّر الرمز</button></div>
        </form>
      </section>

      <section class="panel">
        <h2>نسخة احتياطية</h2>
        <p class="muted" style="margin:0 0 12px">البرنامج بيحفظ نسخة لحاله مع كل إغلاق يوم بمجلد <span class="num">data/backups</span>. وبتقدر تنزّل نسخة هلأ وتحطها على فلاشة.</p>
        <button class="btn" type="button" id="backup">${icon('download')}نزّل نسخة احتياطية</button>
      </section>
    </div>`;

  const saveSettings = (body, msg = 'انحفظ') => ctx.act(async () => {
    const out = await api('/settings', { method: 'PUT', body });
    S.settings = out.settings; S.tables = out.tables; S.site = out.site;
    ctx.renderTop();
    toast(msg, 'ok');
    renderSettings(ctx);
  });

  const drawZonesSum = () => {
    let from = 1;
    $('#zoneSum').textContent = zones.map((z) => {
      const n = Number(z.count) || 0;
      const r = `${z.name}: ${n ? `${from}–${from + n - 1}` : '—'}`;
      from += n;
      return r;
    }).join(' · ');
  };
  const drawZones = () => {
    $('#zones').innerHTML = zones.map((z, i) => `
      <div class="zone-row">
        <input class="input" data-zn="${i}" value="${esc(z.name)}" maxlength="40" aria-label="اسم المنطقة">
        <input class="input num" data-zc="${i}" value="${z.count}" inputmode="numeric" dir="ltr" aria-label="عدد الطاولات">
        <button class="icon-btn" type="button" data-zdel="${i}" ${zones.length < 2 ? 'disabled' : ''} aria-label="احذف المنطقة">${icon('trash')}</button>
      </div>`).join('');
    drawZonesSum();
  };
  drawZones();

  const apps = [...(s.payApps || [])];
  const drawApps = () => {
    $('#apps').innerHTML = apps.map((a, i) => `
      <div class="row" style="flex-wrap:nowrap">
        <input class="input" data-app="${i}" value="${esc(a)}" maxlength="30" placeholder="مثلاً: بنك فلسطين" aria-label="اسم التطبيق">
        <button class="icon-btn" type="button" data-app-del="${i}" aria-label="احذف">${icon('trash')}</button>
      </div>`).join('') || '<p class="muted" style="margin:0">ما في تطبيقات، الدفع نقدي بس.</p>';
  };
  drawApps();
  $('#apps').oninput = (e) => { const i = e.target.dataset.app; if (i !== undefined) apps[i] = e.target.value; };
  $('#apps').onclick = (e) => { const d = e.target.closest('[data-app-del]'); if (d) { apps.splice(Number(d.dataset.appDel), 1); drawApps(); } };
  $('#addApp').onclick = () => { apps.push(''); drawApps(); $(`[data-app="${apps.length - 1}"]`)?.focus(); };
  $('#saveApps').onclick = () => saveSettings({ payApps: apps.map((a) => a.trim()).filter(Boolean) }, 'انحفظت التطبيقات');

  $('#fInfo').onsubmit = (e) => { e.preventDefault(); saveSettings(Object.fromEntries(new FormData(e.target))); };
  let paper = s.paper;
  $('#paperSeg').onclick = (e) => {
    const b = e.target.closest('[data-paper]');
    if (!b) return;
    paper = Number(b.dataset.paper);
    $$('#paperSeg [data-paper]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  };
  $('#fPrint').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    saveSettings({ paper, receiptLogoMm: Number(f.receiptLogoMm.value), receiptLogo: f.receiptLogo.checked, printOnPay: f.printOnPay.checked });
  };
  $('#testPrint').onclick = () => {
    const f = $('#fPrint');
    const demo = {
      no: 0, kind: 'table', table: 1, label: '', status: 'paid', method: 'cash', received: 50,
      subtotal: 42, discount: 0, total: 42, createdAt: new Date().toISOString(), paidAt: new Date().toISOString(), note: '',
      lines: [
        { name: 'شاورما عربي دجاج', qty: 1, price: 22, note: 'بدون مخلل' },
        { name: 'بطاطا كبير', qty: 1, price: 10, note: '' },
        { name: 'كولا', qty: 2, price: 4, note: '' },
        { name: 'ثومية إضافية', qty: 1, price: 2, note: '' },
      ],
    };
    printReceipt(demo, { ...S.settings, paper, receiptLogoMm: Number(f.receiptLogoMm.value) || 30, receiptLogo: f.receiptLogo.checked });
  };
  $('#zones').oninput = (e) => {
    const n = e.target.dataset.zn; const c = e.target.dataset.zc;
    if (n !== undefined) zones[n].name = e.target.value;
    if (c !== undefined) zones[c].count = e.target.value.replace(/\D/g, '');
    drawZonesSum();
  };
  $('#zones').onclick = (e) => {
    const d = e.target.closest('[data-zdel]');
    if (d && !d.disabled) { zones.splice(Number(d.dataset.zdel), 1); drawZones(); }
  };
  $('#addZone').onclick = () => { zones.push({ name: 'منطقة جديدة', count: 4 }); drawZones(); };
  $('#saveZones').onclick = () => saveSettings({ zones: zones.map((z) => ({ name: z.name, count: Number(z.count) || 0 })) }, 'انحفظت الطاولات');
  $('#acceptOrders').onchange = (e) => saveSettings({ acceptOrders: e.target.checked }, e.target.checked ? 'الطلب من الجوال شغّال' : 'الطلب من الجوال موقّف');
  $('#fUrl').onsubmit = (e) => { e.preventDefault(); saveSettings({ publicUrl: e.target.publicUrl.value.trim().replace(/\/+$/, '') }); };
  $('#printQrs').onclick = () => printTableQrs(S.tables.map((t) => ({ no: t.no, svg: qrSvg(`${S.site}/?t=${t.no}`) })), S.settings);
  $('#fPin').onsubmit = (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    ctx.act(async () => { await api('/pin', { method: 'POST', body: f }); toast('تغيّر الرمز', 'ok'); e.target.reset(); });
  };
  $('#backup').onclick = async () => {
    try {
      const res = await fetch('/api/backup', { headers: { 'x-token': S.token } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'ما زبطت النسخة');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `al-arabi-backup-${localDate()}.db`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (er) { toast(er.message, 'err'); }
  };
}
