// الطباعة على طابعة الفواتير الحرارية (80 أو 58 ملم) وعلى ورق A4 لكروت الـ QR
import { esc, money, fmtDate, fmtTime, fmtDateTime } from './common.js';

const RECEIPT_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fff; color: #000; }
  body { font-family: 'Plex Arabic', Tahoma, sans-serif; font-weight: 600; font-size: 12.5px; line-height: 1.45; }
  .r { padding: 3mm var(--px) 6mm; }
  .num { font-variant-numeric: tabular-nums; direction: ltr; unicode-bidi: isolate; }
  .tnum { font-variant-numeric: tabular-nums; }
  .logo { display: block; margin: 0 auto 2mm; width: auto; }
  .c { text-align: center; }
  .info { text-align: center; font-size: 11.5px; font-weight: 500; }
  .title { margin: 2.5mm 0 1.5mm; text-align: center; font-size: 15px; font-weight: 700; letter-spacing: .2px; }
  .title.pre { border: 1.5px solid #000; border-radius: 2mm; padding: .6mm 0; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 0 3mm; font-size: 11.5px; }
  .meta span:nth-child(even) { text-align: left; }
  hr { border: 0; border-top: 1.5px dashed #000; margin: 2mm 0; }
  hr.solid { border-top-style: solid; }
  table { width: 100%; border-collapse: collapse; }
  th { font-size: 11px; font-weight: 700; text-align: right; padding: 0 0 1mm; border-bottom: 1.5px solid #000; }
  td { padding: 1mm 0 0; vertical-align: top; }
  th.n, td.n { text-align: left; white-space: nowrap; padding-inline-start: 1.5mm; }
  td.q { text-align: center; white-space: nowrap; }
  th.q { text-align: center; }
  .ln { font-size: 10.5px; font-weight: 500; }
  .tot { display: flex; justify-content: space-between; gap: 3mm; }
  .grand { font-size: 18px; font-weight: 700; margin: 1mm 0; }
  .foot { text-align: center; margin-top: 3mm; font-size: 12px; }
  .small { font-size: 10.5px; font-weight: 500; }
  .big { font-size: 26px; font-weight: 700; text-align: center; line-height: 1.2; }
  .k td { font-size: 15px; font-weight: 700; padding-top: 1.5mm; }
  .k .ln { font-size: 14px; font-weight: 700; }
`;

const mmToPx = 96 / 25.4;
// ?preview-print بالرابط: الفاتورة بتطلع على الشاشة بدل الطابعة (للتجربة بدون طابعة)
const PREVIEW = new URLSearchParams(location.search).has('preview-print');

// بنطبع من إطار مخفي، فشاشة الكاشير ما بتتأثر، وبنحدد طول الورقة على قد المحتوى
async function printDoc(html, { paper = 80, css = RECEIPT_CSS, page } = {}) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  const width = page ? 210 : paper;
  frame.style.cssText = `position:fixed;inset-inline-start:-10000px;top:0;width:${width}mm;height:10px;border:0;opacity:0;pointer-events:none;`;
  document.body.append(frame);
  const doc = frame.contentDocument;
  // المنطقة اللي بتطبعها الطابعة فعلياً: 72 ملم من ورق 80، و48 من ورق 58
  const px = paper === 58 ? 5 : 4;
  doc.open();
  doc.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
    <link rel="stylesheet" href="/css/fonts.css"><style>:root{--px:${px}mm}${css}</style></head><body>${html}</body></html>`);
  doc.close();
  await new Promise((r) => (doc.readyState === 'complete' ? r() : frame.addEventListener('load', r, { once: true })));
  await Promise.all([...doc.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
  try { await doc.fonts.ready; } catch { /* */ }
  const style = doc.createElement('style');
  if (page) {
    style.textContent = `@page { size: A4; margin: 10mm; }`;
  } else {
    const h = Math.ceil(doc.documentElement.scrollHeight / mmToPx) + 2;
    style.textContent = `@page { size: ${paper}mm ${Math.max(h, 40)}mm; margin: 0; }`;
  }
  doc.head.append(style);
  if (PREVIEW) {
    // أكثر من ورقة ورا بعض (فاتورة + مطبخ) بتطلع جنب بعض
    const shown = document.querySelectorAll('iframe[title="معاينة الطباعة"]').length;
    frame.style.cssText = `position:fixed;z-index:200;top:20px;left:calc(50% - ${shown * (width + 20)}mm);transform:translateX(-50%);width:${width}mm;height:${Math.min(doc.documentElement.scrollHeight + 4, innerHeight - 40)}px;border:0;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.45);`;
    frame.title = 'معاينة الطباعة';
    setTimeout(() => document.addEventListener('click', () => frame.remove(), { once: true }), 300);
    return;
  }
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => frame.remove(), 1500);
}

function header(s) {
  const logo = s.receiptLogo ? `<img class="logo" src="/img/logo-print.png" style="height:${s.receiptLogoMm || 30}mm" alt="">` : `<div class="big">${esc(s.name)}</div>`;
  const info = [s.address, s.phone && `<span class="num">${esc(s.phone)}</span>`].filter(Boolean);
  return `${logo}${info.length ? `<div class="info">${info.map((x) => (x.startsWith('<') ? x : esc(x))).join(' · ')}</div>` : ''}`;
}

const place = (inv) => (inv.kind === 'table' ? `طاولة ${inv.table}` : `طلب خارجي${inv.label ? ` · ${esc(inv.label)}` : ''}`);

export function printReceipt(inv, s, { copy = false } = {}) {
  const cur = esc(s.currency);
  const paid = inv.status === 'paid';
  const change = paid && inv.method === 'cash' && inv.received > inv.total ? inv.received - inv.total : 0;
  const html = `
    <div class="r">
      ${header(s)}
      <div class="title ${paid ? '' : 'pre'}">${paid ? 'فاتورة' : 'فاتورة مبدئية'}${copy ? ' · نسخة' : ''}</div>
      <div class="meta">
        <span>رقم: <b class="num">${inv.no}</b></span><span>${place(inv)}</span>
        <span class="num">${fmtDate(inv.paidAt || inv.createdAt)}</span><span class="tnum">${fmtTime(inv.paidAt || new Date().toISOString())}</span>
      </div>
      <hr>
      <table>
        <thead><tr><th>الصنف</th><th class="q">الكمية</th><th class="n">السعر</th><th class="n">المجموع</th></tr></thead>
        <tbody>
          ${inv.lines.map((l) => `<tr>
            <td>${esc(l.name)}</td>
            <td class="q num">${money(l.qty)}</td>
            <td class="n num">${money(l.price)}</td>
            <td class="n num">${money(l.price * l.qty, { fixed: true })}</td></tr>`).join('')}
        </tbody>
      </table>
      <hr class="solid">
      ${inv.discount > 0 ? `
        <div class="tot"><span>المجموع</span><span class="num">${money(inv.subtotal, { fixed: true })}</span></div>
        <div class="tot"><span>خصم${inv.discountPct ? ` <span class="num">${money(inv.discountPct)}%</span>` : ''}</span><span class="num">- ${money(inv.discount, { fixed: true })}</span></div>` : ''}
      <div class="tot grand"><span>الإجمالي</span><span class="num">${money(inv.total, { fixed: true })} ${cur}</span></div>
      ${paid ? `
        <div class="tot small"><span>الدفع</span><span>${inv.method === 'cash' ? 'نقدي' : `حوالة ${esc(inv.payApp || 'تطبيق')}`}</span></div>
        ${inv.payer ? `<div class="tot small"><span>باسم</span><span>${esc(inv.payer)}</span></div>` : ''}
        ${inv.payRef ? `<div class="tot small"><span>رقم الحوالة</span><span class="num">${esc(inv.payRef)}</span></div>` : ''}
        ${inv.method === 'cash' && inv.received ? `<div class="tot small"><span>المدفوع</span><span class="num">${money(inv.received, { fixed: true })}</span></div>` : ''}
        ${change ? `<div class="tot small"><span>الباقي</span><span class="num">${money(change, { fixed: true })}</span></div>` : ''}` : ''}
      <hr>
      ${s.receiptFooter ? `<div class="foot">${esc(s.receiptFooter)}</div>` : ''}
    </div>`;
  return printDoc(html, { paper: s.paper });
}

export function printKitchen(inv, lines, s, { all = false } = {}) {
  const html = `
    <div class="r k">
      <div class="title">المطبخ${all ? ' · كامل' : ''}</div>
      <div class="big">${inv.kind === 'takeaway' ? `خارجي <span class="num">${inv.no}</span>` : place(inv)}</div>
      ${inv.kind === 'takeaway' && inv.label ? `<div class="c">${esc(inv.label)}</div>` : ''}
      <div class="meta"><span>فاتورة <b class="num">${inv.no}</b></span><span class="tnum">${fmtTime(new Date().toISOString())}</span></div>
      <hr>
      <table><tbody>
        ${lines.map((l) => `<tr><td class="q tnum" style="width:12mm">${money(l.qty)} ×</td><td>${esc(l.name)}${l.note ? `<div class="ln">— ${esc(l.note)}</div>` : ''}</td></tr>`).join('')}
      </tbody></table>
      ${inv.note ? `<hr><div>ملاحظة: ${esc(inv.note)}</div>` : ''}
      <hr>
    </div>`;
  return printDoc(html, { paper: s.paper });
}

const countText = (n, one, two, few) => (n === 1 ? `${one} وحدة` : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${one}`);

export function printDayReport(r, s) {
  const cur = esc(s.currency);
  const row = (k, v, cls = '') => `<div class="tot ${cls}"><span>${k}</span><span class="num">${v}</span></div>`;
  const html = `
    <div class="r">
      ${header(s)}
      <div class="title pre">تقرير إغلاق اليوم</div>
      <div class="small c tnum">${fmtDateTime(r.openedAt)} — ${fmtDateTime(r.closedAt || new Date().toISOString())}</div>
      <hr>
      ${row('عدد الفواتير', r.count)}
      ${r.firstNo ? row('من فاتورة لفاتورة', `${r.firstNo} - ${r.lastNo}`) : ''}
      ${row('المبيعات قبل الخصم', money(r.gross, { fixed: true }))}
      ${row('الخصومات', money(r.discounts, { fixed: true }))}
      ${row('صافي المبيعات', `${money(r.total, { fixed: true })} ${cur}`, 'grand')}
      ${row(r.cashCount ? `نقدي (${countText(r.cashCount, 'فاتورة', 'فاتورتين', 'فواتير')})` : 'نقدي', money(r.cash, { fixed: true }))}
      ${(r.byApp || (r.card ? [{ app: 'تطبيق', count: 0, total: r.card }] : [])).map((a) => row(a.count ? `${esc(a.app)} (${countText(a.count, 'حوالة', 'حوالتين', 'حوالات')})` : esc(a.app), money(a.total, { fixed: true }))).join('')}
      ${r.voids.count ? row(`فواتير ملغية (${r.voids.count})`, money(r.voids.total, { fixed: true })) : ''}
      <hr>
      ${row('المصاريف', money(r.expenses, { fixed: true }))}
      ${(r.expenseList || []).map((e) => `<div class="tot small"><span>— ${esc(e.note)}</span><span class="num">${money(e.amount, { fixed: true })}</span></div>`).join('')}
      ${row('النقدي بالدرج', `${money(r.cash - r.expenses, { fixed: true })} ${cur}`, 'grand')}
      ${r.transfers?.length ? `
        <hr>
        <div class="title" style="margin:0 0 1mm;font-size:13px">الحوالات</div>
        <table>
          <thead><tr><th>الاسم</th><th class="q">على</th><th class="n">المبلغ</th></tr></thead>
          <tbody>${r.transfers.map((t) => `<tr><td>${esc(t.payer || '—')}${t.ref ? `<div class="ln num">#${esc(t.ref)}</div>` : ''}</td><td class="q">${esc(t.app)}</td><td class="n num">${money(t.total, { fixed: true })}</td></tr>`).join('')}</tbody>
        </table>` : ''}
      <hr>
      <table>
        <thead><tr><th>الصنف</th><th class="q">الكمية</th><th class="n">المبلغ</th></tr></thead>
        <tbody>${r.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="q num">${money(i.qty)}</td><td class="n num">${money(i.amount, { fixed: true })}</td></tr>`).join('')}</tbody>
      </table>
      <hr>
      <div class="foot small tnum">طُبع ${fmtDateTime(new Date().toISOString())}</div>
    </div>`;
  return printDoc(html, { paper: s.paper });
}

const QR_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Plex Arabic', Tahoma, sans-serif; color: #1E1510; }
  .sheet { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6mm; }
  .card { border: 1.5px dashed #BF4C03; border-radius: 5mm; padding: 5mm 4mm 4mm; text-align: center; break-inside: avoid; height: 88mm; display: grid; align-content: space-between; justify-items: center; }
  .card img.logo { height: 20mm; }
  .card .qr { width: 36mm; height: 36mm; }
  .card .qr svg, .card .qr img { width: 100%; height: 100%; display: block; }
  .card p { margin: 0; font-weight: 600; font-size: 12px; }
  .card .t { font-family: 'Lalezar', sans-serif; font-size: 22px; line-height: 1; color: #BF4C03; }
`;

export function printTableQrs(list, s) {
  const html = `<div class="sheet">${list.map((t) => `
    <div class="card">
      <img class="logo" src="/img/logo.png" alt="">
      <div class="qr">${t.svg}</div>
      <p>امسح الكود واطلب من مكانك</p>
      <div class="t">طاولة ${t.no}</div>
    </div>`).join('')}</div>`;
  return printDoc(html, { css: QR_CSS, page: true });
}
