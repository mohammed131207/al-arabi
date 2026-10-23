// البيانات الأولية: بتنحط مرة وحدة أول ما ينفتح البرنامج على جهاز جديد
// القائمة هون مبدئية، الأسعار والأصناف الحقيقية بتتعدّل من شاشة "القائمة"
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, run, tx, getSetting, setSetting } from './db.js';

export const DEFAULT_SETTINGS = {
  name: 'مطعم العربي',
  phone: '',
  address: '',
  currency: '₪',
  receiptFooter: 'صحتين وعافية، نوّرتونا',
  paper: 80,              // عرض ورق الطابعة: 80 أو 58 ملم
  receiptLogo: true,
  receiptLogoMm: 30,      // طول الشعار بالفاتورة
  printOnPay: true,       // اطبع الفاتورة لحالها لما يندفع الحساب
  kitchenOnAccept: true,  // اطبع تذكرة المطبخ لحالها لما الكاشير يقبل طلب الجوال
  acceptOrders: true,     // الزباين بيقدروا يطلبوا من جوالاتهم
  publicUrl: '',          // رابط الموقع للـ QR (فاضي = عنوان الجهاز على الشبكة)
  payApps: ['بنك', 'محفظة', 'جوال باي'], // وين بيحوّلوا الزباين لما يدفعوا بتطبيق
  nextInvoiceNo: 1,
  zones: [
    { name: 'الصالة', count: 12 },
    { name: 'الجلسة الخارجية', count: 6 },
  ],
};

// [القسم، صورته، أيامه، [الصنف، السعر، الوصف، الصورة]]  — الصور بمجلد seed-photos
const MENU = [
  ['شاورما', 'cat-shawarma', null, [
    ['ساندويش شاورما دجاج', 12, 'بخبز الصاج مع ثومية ومخلل', 'wrap-chicken'],
    ['ساندويش شاورما لحمة', 15, 'لحمة متبّلة مع طحينة وبصل وبقدونس', 'wrap-meat'],
    ['سوبر شاورما دجاج', 18, 'دبل شاورما مع بطاطا جوّا الساندويش', 'wrap-super'],
    ['شاورما عربي دجاج', 22, 'مقطّعة مع بطاطا وثومية ومخلل', 'arabi-chicken'],
    ['شاورما عربي لحمة', 28, 'مقطّعة مع بطاطا وطحينة', 'arabi-meat'],
    ['صحن شاورما دجاج', 30, 'شاورما مع بطاطا وثومية ومخلل وخبز', 'plate-chicken'],
    ['صحن شاورما لحمة', 38, 'شاورما لحمة مع حمص وسلطة وبطاطا وخبز', 'plate-meat'],
    ['شاورما بالكيلو دجاج', 80, 'كيلو شاورما مع خبز وثومية ومخلل', 'kilo'],
  ]],
  ['وجبات', 'cat-meals', null, [
    ['وجبة بروستد 4 قطع', 30, 'مع بطاطا وثومية وكولسلو', 'broast-4'],
    ['وجبة بروستد 8 قطع', 55, 'للعيلة: مع بطاطا كبير وثومية', 'broast-8'],
    ['وجبة زنجر', 25, 'ساندويش زنجر حار مع بطاطا', 'zinger'],
    ['وجبة كرسبي', 28, 'قطع دجاج مقرمشة مع صوص وبطاطا', 'crispy'],
    ['وجبة أطفال', 18, 'ناجتس مع بطاطا وعصير', 'kids'],
  ]],
  ['مقبلات وإضافات', 'cat-sides', null, [
    ['بطاطا صغير', 6, '', 'fries-small'],
    ['بطاطا كبير', 10, '', 'fries-big'],
    ['بطاطا بالجبنة', 14, 'بطاطا مع صوص جبنة سايح', 'cheese-fries'],
    ['حمص', 10, 'حمص بطحينة وزيت زيتون', 'hummus'],
    ['سلطة خضراء', 8, '', 'salad'],
    ['ثومية إضافية', 2, '', 'toum'],
    ['مخلل', 3, '', 'pickles'],
    ['خبز إضافي', 1, '', 'bread'],
  ]],
  ['الضاني', 'cat-lamb', [4], [
    ['صحن ضاني', 45, 'لحمة ضاني على رز', 'lamb-plate'],
    ['فراشيح ضاني', 30, '', 'lamb-farasheeh'],
    ['بيتا ضاني', 20, 'لحمة ضاني بخبز البيتا', 'lamb-pita'],
  ]],
  ['مشروبات', 'cat-drinks', null, [
    ['كولا', 4, '', 'cola'],
    ['سبرايت', 4, '', 'sprite'],
    ['فانتا', 4, '', 'fanta'],
    ['مي صغيرة', 2, '', 'water'],
    ['لبن عيران', 4, '', 'ayran'],
    ['عصير برتقال طبيعي', 10, '', 'orange'],
    ['ليمون ونعنع', 10, '', 'lemon-mint'],
  ]],
];

const PHOTOS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'seed-photos');
function photo(key) {
  try { return key ? fs.readFileSync(path.join(PHOTOS, `${key}.jpg`)) : null; } catch { return null; }
}

export function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pin), salt, 32).toString('hex') };
}

export function seed() {
  tx(() => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      if (getSetting(k) === null) setSetting(k, v);
    }
    if (getSetting('pin') === null) setSetting('pin', hashPin('1234'));

    if (!get('SELECT id FROM categories LIMIT 1')) {
      MENU.forEach(([cat, catPhoto, days, items], ci) => {
        const img = photo(catPhoto);
        const { lastInsertRowid: catId } = run('INSERT INTO categories (name, sort, days, image, image_type, image_v) VALUES (?, ?, ?, ?, ?, ?)',
          cat, ci, days ? JSON.stringify(days) : null, img, img ? 'image/jpeg' : null, img ? 1 : 0);
        items.forEach(([name, price, note, key], ii) => {
          const pic = photo(key);
          run('INSERT INTO items (category_id, name, price, note, sort, image, image_type, image_v) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            catId, name, price, note, ii, pic, pic ? 'image/jpeg' : null, pic ? 1 : 0);
        });
      });
    }
  });
}
