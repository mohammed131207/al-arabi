// أدوات مشتركة بين شاشة الكاشير ومنيو الزباين

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 12 → "12" ، 12.5 → "12.50" ، fixed → دايماً منزلتين (شاشة المجموع والفاتورة)
export function money(n, { fixed = false } = {}) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const s = fixed || !Number.isInteger(v) ? v.toFixed(2) : String(v);
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const pad = (n) => String(n).padStart(2, '0');
export function fmtTime(iso) {
  const d = new Date(iso);
  const h = d.getHours();
  // الأرقام معزولة عشان "ص/م" تطلع بعدها صح بالعربي
  return `⁦${h % 12 || 12}:${pad(d.getMinutes())}⁩ ${h < 12 ? 'ص' : 'م'}`;
}
export function fmtDate(iso) {
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
export const fmtDateTime = (iso) => `⁦${fmtDate(iso)}⁩ · ${fmtTime(iso)}`;
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function minutesSince(iso) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  if (m < 60) return `${m} د`;
  return `${Math.floor(m / 60)} س ${m % 60 ? `${m % 60} د` : ''}`.trim();
}

export function toast(msg, kind = '') {
  let box = $('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); document.body.append(box); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 4500 : 2600);
}

// أيقونات خطّية بسيطة
const P = {
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  printer: 'M7 9V3h10v6M7 18H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M7 14h10v7H7z',
  pot: 'M4 10h16M6 10v7a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-7M2 10h2M20 10h2M9 6c0-1 1-1 1-2M14 6c0-1 1-1 1-2',
  cash: 'M3 7h18v10H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 10v.01M18 14v.01',
  note: 'M5 4h10l4 4v12H5zM15 4v4h4M8 12h8M8 16h5',
  tag: 'M3 12V4h8l9 9-8 8zM7.5 8.5h.01',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5L19 7',
  move: 'M5 12h14M15 8l4 4-4 4M9 8l-4 4 4 4',
  bag: 'M5 8h14l-1 13H6zM9 8V6a3 3 0 0 1 6 0v2',
  table: 'M3 9h18M5 9v11M19 9v11M7 9l1-4h8l1 4',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  menu: 'M4 6h16M4 12h16M4 18h10',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  wallet: 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l12-4v4M16 13h.01',
  phone: 'M7 2h10v20H7zM11 18h2',
  waiter: 'M12 4a2 2 0 1 0 0 .01M8 21v-7l-2-3 3-4h6l3 4-2 3v7',
  card: 'M3 6h18v12H3zM3 10h18M7 15h3',
  download: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  bellOff: 'M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l2 2H8M10 20a2 2 0 0 0 4 0M3 3l18 18',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01',
  back: 'M9 6l6 6-6 6',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
};
export const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${P[name] || ''}"/></svg>`;

// نافذة بسيطة بحقول: بترجع القيم أو null إذا انلغت
export function ask({ title, fields = [], confirm = 'حفظ', danger = false, body = '', validate }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = `
      <form method="dialog">
        <div class="dlg-head"><h2>${esc(title)}</h2><button class="icon-btn" type="button" data-close aria-label="إغلاق">${icon('x')}</button></div>
        <div class="dlg-body">
          ${body}
          ${fields.map((f) => `
            <label class="field"><span>${esc(f.label)}</span>
              ${f.type === 'select'
                ? `<select class="select" name="${f.name}">${f.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`
                : f.type === 'textarea'
                  ? `<textarea class="textarea" name="${f.name}" maxlength="${f.max || 160}" placeholder="${esc(f.placeholder || '')}">${esc(f.value ?? '')}</textarea>`
                  : `<input class="input ${f.num ? 'num' : ''}" name="${f.name}" type="${f.num ? 'text' : (f.type || 'text')}" ${f.num ? 'inputmode="decimal" dir="ltr"' : ''} value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}" maxlength="${f.max || 80}" autocomplete="off">`}
              ${f.hint ? `<small>${esc(f.hint)}</small>` : ''}
            </label>`).join('')}
          <p class="dlg-err" role="alert"></p>
        </div>
        <div class="dlg-foot">
          <button class="btn" type="button" data-close>إلغاء</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-brand'}" value="ok" type="submit">${esc(confirm)}</button>
        </div>
      </form>`;
    document.body.append(d);
    const form = d.querySelector('form');
    d.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) d.close('cancel'); });
    form.addEventListener('submit', (e) => {
      const values = Object.fromEntries(new FormData(form));
      const err = validate?.(values);
      if (err) { e.preventDefault(); d.querySelector('.dlg-err').textContent = err; return; }
      d.returnValue = 'ok';
      d._values = values;
    });
    d.addEventListener('close', () => { resolve(d.returnValue === 'ok' ? d._values : null); d.remove(); });
    d.showModal();
    const first = d.querySelector('input, select, textarea');
    if (first) { first.focus(); first.select?.(); }
  });
}

export const confirmBox = (title, body, confirm = 'تأكيد', danger = true) =>
  ask({ title, body: `<p style="margin:0">${body}</p>`, confirm, danger }).then((v) => v !== null);

// صوت تنبيه عالي بدون ملفات، بيتسمع بزحمة المطعم: جرس حاد بنغمتين (طلب جديد) أو أربع نغمات (نداء)
let ac;
let out;
function audio() {
  if (!ac) {
    ac = new AudioContext();
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 6;
    out = ac.createGain();
    out.gain.value = 1;
    out.connect(comp).connect(ac.destination);
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}
// المتصفح ما بيسمح بالصوت قبل أول كبسة بالصفحة
export const audioReady = () => Boolean(ac) && ac.state === 'running';
export function unlockAudio() { try { audio(); } catch { /* */ } }

export function beep(kind = 'order') {
  try {
    const a = audio();
    const tones = kind === 'call' ? [988, 740, 988, 740] : [1319, 988, 1319, 988, 1319, 988];
    tones.forEach((f, i) => {
      const t = a.currentTime + i * 0.2;
      for (const [type, mult, vol] of [['square', 1, 0.5], ['sawtooth', 2, 0.18]]) {
        const o = a.createOscillator();
        const g = a.createGain();
        o.type = type;
        o.frequency.value = f * mult;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
        g.gain.setValueAtTime(vol, t + 0.15);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + 0.2);
      }
    });
  } catch { /* المتصفح منع الصوت */ }
}
