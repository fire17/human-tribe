// Pure data logic — no DOM, no network. Node-testable (tests/model.test.mjs).

export const CATEGORIES = [
  { id: 'shelter',   he: 'מחסה',               icon: '🛖' },
  { id: 'food',      he: 'אוכל',               icon: '🍲' },
  { id: 'clothes',   he: 'בגדים',              icon: '🧥' },
  { id: 'health',    he: 'בריאות',             icon: '🩺' },
  { id: 'mental',    he: 'בריאות נפש',         icon: '🌿' },
  { id: 'addiction', he: 'התמכרות',            icon: '🔄' },
  { id: 'documents', he: 'מסמכים/ת״ז',         icon: '🪪' },
  { id: 'benefits',  he: 'ביטוח לאומי/קצבאות', icon: '🏛️' },
  { id: 'debts',     he: 'חובות',              icon: '💳' },
  { id: 'legal',     he: 'ייעוץ משפטי',        icon: '⚖️' },
  { id: 'work',      he: 'עבודה',              icon: '🛠️' },
  { id: 'family',    he: 'קשר משפחתי',         icon: '💞' },
  { id: 'other',     he: 'אחר',                icon: '✳️' },
];
export const CAT = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

export const STATUSES = [
  { id: 'open',        he: 'פתוח' },
  { id: 'in_progress', he: 'בטיפול' },
  { id: 'resolved',    he: 'נפתר' },
];
export const STATUS = Object.fromEntries(STATUSES.map(s => [s.id, s]));

export const URGENCIES = [
  { id: 'low',    he: 'נמוכה', rank: 0 },
  { id: 'normal', he: 'רגילה', rank: 1 },
  { id: 'high',   he: 'גבוהה', rank: 2 },
  { id: 'urgent', he: 'דחוף',  rank: 3 },
];
export const URGENCY = Object.fromEntries(URGENCIES.map(u => [u.id, u]));

// v2 (2026-10-03): controller + purpose + legal reporting limit in the text, per-recipient sharing,
// separate consent for cloud voice transcription and for public use of the story. People recorded
// under v1 are asked again before anything about them is shared.
export const CONSENT_VERSION = 2;
export const consentCurrent = p => (p?.consent?.version || 0) >= CONSENT_VERSION;
export const shareOk = p => !!p?.consent?.shareWithOrgs && consentCurrent(p);

// Special-sensitivity categories (Privacy Protection Law §7 / DESIGN §5.5, §7.1 L3): never in an
// external summary, a share export or a default card, and never as an icon next to a name.
export const SENSITIVE = new Set(['health', 'mental', 'addiction', 'legal']);
export const isSensitive = n => SENSITIVE.has(n?.category);
// Small-group rule: with ~20 known people a count of 1 or 2 points at a person.
export const K_MIN = 3;
export const kCount = n => (n > 0 && n < K_MIN ? 'פחות מ-3' : String(n));

// Retention (DESIGN §11.2): no contact for 90 days -> ask the volunteer to renew or delete.
export const STALE_DAYS = 90;
export const isStale = (p, now = Date.now()) => now - (p.updatedAt || 0) > STALE_DAYS * 864e5;

// ---------- ids / dates ----------
export function newId(prefix = 'id') {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    try { return `${prefix}_${c.randomUUID()}`; } catch { /* insecure context */ }
  }
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  return `${prefix}_${Array.from(b, x => x.toString(16).padStart(2, '0')).join('')}`;
}

// Local calendar day (Israel time on the phone), never UTC.
export function dayKey(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
export function lastDays(n, from = new Date()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() - i);
    out.push({ key: dayKey(d), date: d });
  }
  return out;
}

// ---------- factories ----------
export function makePerson(name, consent, now = Date.now()) {
  return {
    id: newId('p'),
    name: String(name || '').trim().slice(0, 60),
    createdAt: now,
    updatedAt: now,
    consent: { ...consent, version: CONSENT_VERSION, at: now },
    story: '',
    wishes: '',
    contactNote: '',
    needs: [],
  };
}
export function makeNeed(category, now = Date.now()) {
  return { id: newId('n'), category: CAT[category] ? category : 'other', status: 'open', urgency: 'normal', notes: '', createdAt: now, updatedAt: now };
}
export function makeShelter(name, capacity = 2, now = Date.now()) {
  return { id: newId('s'), name: String(name || '').trim().slice(0, 40), location: '', capacity: Math.max(1, Math.min(8, Number(capacity) || 2)), occupants: [], sheets: {}, kind: '', stage: 'planned', createdAt: now, updatedAt: now };
}

// ---------- shelter plan structure (shelter/PLAN.md) ----------
// Units are numbered U1..U10, beds A/B; laundry bags carry the bed label (U3-A), never a name.
export const SHELTER_KINDS = [
  { id: '',       he: 'סוג: לא נבחר' },
  { id: 'tent',   he: 'אוהל + ברזנט (זולה)' },
  { id: 'sukkah', he: 'סוכה 2×2 (טובה)' },
  { id: 'indoor', he: 'מקורה / חצר פרטית' },
];
export const SHELTER_STAGES = [
  { id: 'planned', he: 'מתוכננת' },
  { id: 'up',      he: 'הוקמה' },
  { id: 'removed', he: 'פורקה' },
];
export const BED_LETTERS = 'ABCDEFGH';
export function bedLabel(s, index) {
  const code = String(s.name || '').trim().split(/\s+/)[0] || 'U';
  return `${code}-${BED_LETTERS[index] || index + 1}`;
}
export function nextUnitName(shelters) {
  let n = 0;
  for (const s of shelters) { const m = /^U(\d+)/.exec(s.name || ''); if (m) n = Math.max(n, Number(m[1])); }
  return `U${n + 1}`;
}
// Daily rounds from the plan's "סבב יומי" table. Stored per local day in the meta store.
export const ROUNDS = [
  { id: 'morning', he: 'סבב בוקר', time: '08:00–09:30', what: 'איסוף מצעים לשקים ממוספרים, אוורור, בדיקת נזילות ומשקולות' },
  { id: 'laundry', he: 'כביסה',    time: '10:00–13:00', what: 'כביסה חמה, ייבוש מלא, קיפול לשקים ממוספרים' },
  { id: 'evening', he: 'סבב ערב',  time: '17:00–19:00', what: 'החזרת סטים נקיים, תה חם, בדיקת תחזית ובטיחות' },
  { id: 'night',   he: "צ'ק-אין לילה", time: '21:00', what: 'בטלפון או בוואטסאפ. לא שוהים בשטח' },
];
// Personal winter kit (plan track א): owned by the person, no permit needed.
export const KIT_ITEMS = [
  { id: 'bag',     he: 'שק שינה' },
  { id: 'mattress', he: 'מזרן' },
  { id: 'tarp',    he: 'ברזנט' },
];
export function kitStatus(people) {
  let full = 0, partial = 0;
  for (const p of people) {
    const k = p.kit || {};
    const have = KIT_ITEMS.filter(i => k[i.id]).length;
    if (have === KIT_ITEMS.length) full++; else if (have) partial++;
  }
  return { full, partial, none: people.length - full - partial, total: people.length };
}

// ---------- needs ordering ----------
const STATUS_RANK = { open: 0, in_progress: 1, resolved: 2 };
export function sortNeeds(needs) {
  return [...needs].sort((a, b) =>
    (STATUS_RANK[a.status] - STATUS_RANK[b.status]) ||
    ((URGENCY[b.urgency]?.rank ?? 1) - (URGENCY[a.urgency]?.rank ?? 1)) ||
    (a.createdAt - b.createdAt));
}
export const isActive = n => n.status !== 'resolved';

// ---------- keyword suggestions (suggest only, never auto-add) ----------
// Substring matching on purpose: Hebrew clitics (ו ה ב כ ל מ ש) glue onto words,
// so word boundaries would miss "למסמכים". Tokens are chosen long enough to avoid
// collisions like "חוב" inside "רחוב" or "מים" inside "ימים".
export const KEYWORDS = {
  shelter:   ['מחסה', 'לישון', 'איפה לישון', 'קר לי', 'קר בלילה', 'חורף', 'גשם', 'דירה', 'מקלט', 'מיטה', 'אוהל', 'סוכה', 'שכירות', 'הוסטל'],
  food:      ['אוכל', 'רעב', 'רעבה', 'לאכול', 'ארוחה', 'מזון', 'בית תמחוי'],
  clothes:   ['בגדים', 'בגד ', 'מעיל', 'נעליים', 'גרביים', 'שמיכה', 'שק שינה', 'כביסה', 'סדין'],
  health:    ['רופא', 'רופאה', 'תרופה', 'תרופות', 'כואב', 'כאבים', 'פצע', 'בית חולים', 'מרפאה', 'סוכרת', 'לחץ דם', 'שיניים', 'משקפיים', 'קופת חולים', 'חולה'],
  mental:    ['דיכאון', 'חרדה', 'פסיכיאטר', 'פסיכולוג', 'נפשי', 'טראומה', 'בדידות', 'בודד', 'סיוטים', 'פוסט טראומה'],
  addiction: ['סמים', 'אלכוהול', 'גמילה', 'מכור ל', 'מכורה', 'התמכרות', 'מתדון', 'הימורים', 'שותה הרבה'],
  documents: ['תעודת זהות', 'תעודת', 'הזהות', 'ת"ז', 'ת״ז', 'תעודה', 'דרכון', 'מסמך', 'מסמכים', 'רישיון', 'משרד הפנים', 'כתובת למכתבים'],
  benefits:  ['ביטוח לאומי', 'ביטוח הלאומי', 'קצבה', 'קצבת', 'נכות', 'הבטחת הכנסה', 'אבטלה', 'גמלה', 'גמלת', 'פנסיה', 'מימוש זכויות'],
  debts:     ['חובות', 'חוב של', 'יש לי חוב', 'הוצאה לפועל', 'הוצאה-לפועל', 'עיקול', 'הלוואה', 'קנסות', 'פשיטת רגל', 'חדלות פירעון'],
  legal:     ['עורך דין', 'עורכת דין', 'עו"ד', 'עו״ד', 'בית משפט', 'משפטי', 'תיק פלילי', 'משטרה', 'מעצר', 'סיוע משפטי', 'זכויות'],
  work:      ['עבודה', 'לעבוד', 'משרה', 'פרנסה', 'תעסוקה', 'מקצוע', 'קורס', 'הכשרה'],
  family:    ['משפחה', 'אמא שלי', 'אבא שלי', 'הילדים', 'הילד שלי', 'הבת שלי', 'הבן שלי', 'אחותי', 'האח שלי', 'נכדים', 'קשר עם'],
};
export function suggestCategories(text) {
  const t = String(text || '');
  if (!t.trim()) return [];
  const hits = [];
  for (const [cat, words] of Object.entries(KEYWORDS)) {
    const w = words.find(k => t.includes(k));
    if (w) hits.push({ category: cat, word: w.trim() });
  }
  return hits;
}

// ---------- minimal disclosure: flag ID / phone-like numbers ----------
// 9+ digits in a row (allowing spaces/dashes) = likely ת"ז or phone. We warn, never block.
const LONG_NUM = /\d(?:[\s-]?\d){8,}/g;
export function findSensitiveNumbers(text) {
  return String(text || '').match(LONG_NUM) || [];
}
export function maskSensitiveNumbers(text) {
  return String(text || '').replace(LONG_NUM, m => m.replace(/\d/g, '•'));
}

// ---------- resources ----------
export const RESOURCE_FIELDS = ['id', 'name_he', 'category', 'offers_he', 'eligibility_he', 'contact', 'area', 'source_url', 'verified'];

export function validateResource(r) {
  const errs = [];
  if (!r || typeof r !== 'object') return ['not an object'];
  if (typeof r.id !== 'string' || !r.id) errs.push('id');
  if (typeof r.name_he !== 'string' || !r.name_he) errs.push('name_he');
  if (!Array.isArray(r.category) || !r.category.length) errs.push('category[]');
  else if (r.category.some(c => !CAT[c])) errs.push('category: unknown id');
  if (typeof r.offers_he !== 'string') errs.push('offers_he');
  if (typeof r.eligibility_he !== 'string') errs.push('eligibility_he');
  if (!r.contact || typeof r.contact !== 'object') errs.push('contact');
  else for (const k of ['phone', 'url', 'address']) if (r.contact[k] != null && typeof r.contact[k] !== 'string') errs.push(`contact.${k}`);
  if (typeof r.area !== 'string') errs.push('area');
  if (typeof r.source_url !== 'string') errs.push('source_url');
  if (typeof r.verified !== 'boolean') errs.push('verified');
  if (r.verified === true && !/^https?:\/\//.test(r.source_url || '')) errs.push('verified without source_url');
  return errs;
}

// Accepts a bare array or { resources: [...] }. Drops invalid rows (reported, never silently).
export function normalizeResources(json) {
  const list = Array.isArray(json) ? json : (json && Array.isArray(json.resources) ? json.resources : []);
  const meta = Array.isArray(json) ? {} : { ...(json || {}) };
  delete meta.resources;
  const ok = [], rejected = [];
  for (const r of list) {
    const errs = validateResource(r);
    if (errs.length) rejected.push({ id: r && r.id, errs });
    else ok.push({ ...r, category: [...new Set(r.category)] });
  }
  return { resources: ok, rejected, meta };
}

function areaScore(r, area) {
  const a = r.area || '';
  if (area && a.includes(area)) return 3;
  if (a.includes('תל אביב')) return 2;
  if (a.includes('ארצי')) return 1;
  return 0;
}
// Rows the research marked "do not refer" (e.g. an inactive NGO) are never offered as a match.
export const isReferable = r => !r.do_not_refer;
const isPrimary = (r, category) => Array.isArray(r.primary) ? r.primary.includes(category) : true;
// Ranking: verified first, then the research's "where to start" rows, then rows whose main field
// IS this category (not just a side tag), then area (Tel Aviv before national), then name.
export function matchResources(resources, category, { area = 'תל אביב' } = {}) {
  return resources
    .filter(r => isReferable(r) && r.category.includes(category))
    .sort((a, b) =>
      (Number(b.verified) - Number(a.verified)) ||
      (Number(!!b.start_here) - Number(!!a.start_here)) ||
      (Number(isPrimary(b, category)) - Number(isPrimary(a, category))) ||
      (areaScore(b, area) - areaScore(a, area)) ||
      a.name_he.localeCompare(b.name_he, 'he'));
}
// Phone fields from the research are free text ("050-… — תיאום הגעה; משרד 03-…"). Pull out each
// dialable number separately so a tel: link never glues two numbers together.
export function phoneNumbers(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\*?\d[\d-]*\d\*?|\*\d+/g)) {
    const tok = m[0], digits = tok.replace(/\D/g, '');
    if (digits.length < 3) continue;                                  // street numbers like "16"
    if (!tok.includes('*') && /^(19|20)\d\d$/.test(tok)) continue;  // years like "2021"
    const dial = (tok.endsWith('*') ? '*' + tok.slice(0, -1) : tok).replace(/[^\d*+#]/g, ''); // "9106*" = *9106 written RTL
    if (!out.some(x => x.dial === dial)) out.push({ text: tok, dial });
  }
  return out;
}
// Short label for the verification badge: the research lane's own status words.
export function verificationLabel(r) {
  if (r.do_not_refer) return 'לא להפנות';
  if (r.verification_status) return r.verification_status;
  return r.verified ? 'אומת' : 'לא אומת';
}

// ---------- aggregate ----------
export function aggregate(people) {
  const byCategory = Object.fromEntries(CATEGORIES.map(c => [c.id, { open: 0, in_progress: 0, resolved: 0, urgent: 0, active: 0, people: [] }]));
  let needs = 0, open = 0, inProgress = 0, resolved = 0, urgent = 0;
  for (const p of people) {
    for (const n of p.needs || []) {
      const b = byCategory[n.category] || byCategory.other;
      needs++;
      b[n.status] = (b[n.status] || 0) + 1;
      if (n.status === 'open') open++;
      else if (n.status === 'in_progress') inProgress++;
      else resolved++;
      if (isActive(n)) {
        b.active++;
        if (n.urgency === 'urgent') { b.urgent++; urgent++; }
        b.people.push({ personId: p.id, name: p.name, needId: n.id, status: n.status, urgency: n.urgency, shareOk: shareOk(p) });
      }
    }
  }
  for (const b of Object.values(byCategory)) {
    b.people.sort((x, y) => (URGENCY[y.urgency]?.rank ?? 1) - (URGENCY[x.urgency]?.rank ?? 1));
  }
  return { people: people.length, needs, open, inProgress, resolved, urgent, byCategory };
}

// Text summary for coordinating with social workers / NGOs (leaves the phone, so minimal disclosure):
// - special-sensitivity categories never appear (DESIGN §5.5 / §7.1 L3: only a person passes those on);
// - every count under 3 is shown as "פחות מ-3" (about 20 people know each other around the square);
// - names only with includeNames, only of people whose current consent allows sharing, and never on a
//   row with fewer than 3 people.
export function summaryText(people, { includeNames = false, date = new Date(), place = 'כיכר הבימה, תל אביב' } = {}) {
  const ag = aggregate(people);
  const fmt = new Intl.DateTimeFormat('he-IL', { dateStyle: 'long' }).format(date);
  const rows = CATEGORIES.filter(c => !SENSITIVE.has(c.id)).map(c => [c, ag.byCategory[c.id]])
    .filter(([, b]) => b.active > 0).sort((a, b) => b[1].active - a[1].active);
  const active = rows.reduce((t, [, b]) => t + b.active, 0);
  const urgent = rows.reduce((t, [, b]) => t + b.urgent, 0);
  const lines = [
    `סיכום צרכים — השבט האנושי (${place})`,
    `תאריך: ${fmt}`,
    `אנשים ברשימה: ${kCount(ag.people)} · צרכים פעילים: ${kCount(active)}${urgent ? ` (מהם דחופים: ${kCount(urgent)})` : ''}`,
    '',
  ];
  for (const [c, b] of rows) {
    let line = `• ${c.he}: ${kCount(b.active)}` + (b.urgent ? ` (דחוף: ${kCount(b.urgent)})` : '') + (b.in_progress ? ` · בטיפול: ${kCount(b.in_progress)}` : '');
    if (includeNames && b.active >= K_MIN) {
      const names = [...new Set(b.people.filter(x => x.shareOk).map(x => x.name))];
      if (names.length) line += ` — ${names.join(', ')}`;
      if (b.people.length > names.length) line += ' (ועוד אנשים בלי שם)';
    }
    lines.push(line);
  }
  if (!rows.length) lines.push('אין כרגע צרכים פעילים שמתאימים לסיכום חיצוני.');
  lines.push('',
    'נושאים רגישים (בריאות, בריאות נפש, התמכרות, משפטי) לא נכללים בסיכום חיצוני — רק בשיחה אישית בהסכמה.',
    'מספר קטן מ-3 מוצג כ"פחות מ-3". שמות מופיעים רק באישור האדם, לגורם הזה.',
    'הופק מהאפליקציה של השבט האנושי.');
  return lines.join('\n');
}

// ---------- shelters ----------
export function shelterDay(shelters, people, key = dayKey()) {
  const alive = new Set(people.map(p => p.id));
  let occupied = 0, changed = 0, beds = 0, bedsPending = 0, free = 0;
  for (const s of shelters) {
    const occ = (s.occupants || []).filter(id => alive.has(id));
    free += Math.max(0, s.capacity - occ.length);
    if (!occ.length) continue;
    occupied++;
    beds += occ.length;
    if (s.sheets && s.sheets[key]) changed++;
    else bedsPending += occ.length;
  }
  return { total: shelters.length, occupied, changed, beds, bedsPending, free };
}
export function shelterOf(shelters, personId) {
  return shelters.find(s => (s.occupants || []).includes(personId)) || null;
}

// ---------- export / import ----------
export const EXPORT_APP = 'human-tribe';
export const EXPORT_FORMAT = 1;

// scope 'all'       = full encrypted backup to the volunteer's own phone (everything).
// scope 'consented' = hand-over to a social worker / NGO. Only what the consent covers ("נעביר את
//   הצרכים"): name + the non-sensitive needs (category, status, urgency, dates). No story, wishes,
//   contact note ("where to find me"), need notes, kit, and no shelters (unit + location = where the
//   person sleeps, DESIGN §7.2 rule 2). Marked partial so an import never overwrites a full record.
export const SHARE_NEED_FIELDS = ['id', 'category', 'status', 'urgency', 'createdAt', 'updatedAt'];
export function shareRecord(p) {
  return {
    id: p.id,
    name: p.name,
    consent: { ...p.consent },
    needs: (p.needs || []).filter(n => !isSensitive(n)).map(n => Object.fromEntries(SHARE_NEED_FIELDS.map(k => [k, n[k]]))),
    updatedAt: p.updatedAt,
    partial: true,
  };
}
export function buildExport(people, shelters, scope = 'consented', now = new Date(), { recipient = '' } = {}) {
  const base = { app: EXPORT_APP, format: EXPORT_FORMAT, scope, exportedAt: now.toISOString() };
  if (scope === 'all') {
    return { ...base, people: people.map(p => JSON.parse(JSON.stringify(p))), shelters: shelters.map(s => JSON.parse(JSON.stringify(s))) };
  }
  return { ...base, partial: true, recipient: String(recipient || '').slice(0, 80), people: people.filter(shareOk).map(shareRecord), shelters: [] };
}

export function validateImport(obj) {
  if (!obj || obj.app !== EXPORT_APP) return 'זה לא קובץ של השבט האנושי';
  if (obj.format !== EXPORT_FORMAT) return `גרסת קובץ לא מוכרת (${obj.format})`;
  if (!Array.isArray(obj.people) || !Array.isArray(obj.shelters)) return 'הקובץ פגום';
  for (const p of obj.people) if (!p || typeof p.id !== 'string' || typeof p.name !== 'string' || !Array.isArray(p.needs)) return 'רשומת אדם פגומה בקובץ';
  for (const s of obj.shelters) if (!s || typeof s.id !== 'string' || !Array.isArray(s.occupants)) return 'רשומת סוכה פגומה בקובץ';
  return null;
}

// Fill fields a partial (share) record leaves out, so every screen can rely on them.
export function normalizePerson(p) {
  return {
    story: '', wishes: '', contactNote: '', createdAt: p.updatedAt || Date.now(), updatedAt: p.createdAt || Date.now(),
    ...p,
    consent: { ...(p.consent || {}) },
    needs: (p.needs || []).map(n => ({ notes: '', status: 'open', urgency: 'normal', ...n })),
  };
}

// Merge by id; the newer updatedAt wins. Returns the records to write.
// A partial record (from a share export) never replaces a full local one: its needs are merged one by
// one (newer need wins on status/urgency, the local notes stay), everything else stays local.
export function mergeRecords(existing, incoming) {
  const byId = new Map(existing.map(x => [x.id, x]));
  const out = [];
  let added = 0, updated = 0, kept = 0;
  for (const r of incoming) {
    const cur = byId.get(r.id);
    if (!cur) { out.push(r); added++; }
    else if (r.partial && !cur.partial) {
      const needs = (cur.needs || []).map(n => ({ ...n }));
      let changed = false;
      for (const inc of r.needs || []) {
        const local = needs.find(n => n.id === inc.id);
        if (!local) { needs.push({ notes: '', ...inc }); changed = true; }
        else if ((inc.updatedAt || 0) > (local.updatedAt || 0)) { Object.assign(local, { status: inc.status, urgency: inc.urgency, updatedAt: inc.updatedAt }); changed = true; }
      }
      if (changed) { out.push({ ...cur, needs, updatedAt: Math.max(cur.updatedAt || 0, r.updatedAt || 0) }); updated++; }
      else kept++;
    }
    else if ((r.updatedAt || 0) > (cur.updatedAt || 0)) { out.push(r); updated++; }
    else kept++;
  }
  return { write: out, added, updated, kept };
}
