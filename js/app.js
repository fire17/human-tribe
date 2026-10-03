import * as db from './db.js';
import * as M from './model.js';
import * as SP from './speech.js';
import { encryptJSON, decryptJSON } from './crypto.js';
import { html, raw, $, $$, fmtDate } from './dom.js';
import { consentParas, CONSENT_CHOICES, CONSENT_BY, CONSENT_SUMMARY, CONSENT_LANG_NOTE, CONTROLLER, PRIVACY_POINTS } from './texts.js';

const APP_VERSION = '0.3.0';

const S = {
  people: [],
  shelters: [],
  resources: [],
  resMeta: {},
  resRejected: [],
  resError: null,
  draft: null,          // { name } before consent — never stored
  sttMode: 'none',      // local | cloud | none
  mic: null,            // { personId, field }
  interim: '',
  q: '',
  openMatch: new Set(), // need ids whose "who can help" panel is open
  openShelters: new Set(), // unit ids whose card is expanded
  resLoading: true,
  summaryNames: false,
  cardOpts: {},
  online: navigator.onLine,
  swUpdate: null,
  lastBackup: null,     // ts of the last full encrypted backup (meta 'lastBackup')
  installPrompt: null,  // Android beforeinstallprompt event
  rounds: {},           // { [dayKey]: { morning: ts, ... } } — volunteer rounds, no personal data
};

const view = $('#view');
const person = id => S.people.find(p => p.id === id);
const shelter = id => S.shelters.find(s => s.id === id);
const byName = (a, b) => a.name.localeCompare(b.name, 'he', { numeric: true }) || a.createdAt - b.createdAt;
const sortedShelters = () => [...S.shelters].sort(byName);

// ---------------- persistence ----------------
// Typing is saved at once (coalesced within one task), not after a debounce: a tab swiped away
// right after the last word must not lose it. Records whose IndexedDB write has not committed yet
// stay in `dirty`; on pagehide they are also written synchronously to localStorage ('ht-dirty') and
// merged back into IndexedDB on the next boot.
const pending = new Map();
const dirty = { people: new Map(), shelters: new Map() };
const DIRTY_KEY = 'ht-dirty';
function schedule(key, fn, ms = 0) {
  if (pending.has(key)) clearTimeout(pending.get(key).t);
  pending.set(key, { fn, t: setTimeout(() => { pending.delete(key); fn(); }, ms) });
}
function flushAll() {
  for (const [k, v] of pending) { clearTimeout(v.t); pending.delete(k); v.fn(); }
}
let journaled = false; // this session wrote the journal (a leftover one is only cleared by recoverDirty)
function journalDirty() {
  try {
    const recs = { people: [...dirty.people.values()], shelters: [...dirty.shelters.values()] };
    if (recs.people.length || recs.shelters.length) { localStorage.setItem(DIRTY_KEY, JSON.stringify(recs)); journaled = true; }
    else if (journaled) { localStorage.removeItem(DIRTY_KEY); journaled = false; }
  } catch { /* storage blocked: IndexedDB write is still in flight */ }
}
// A deleted person must never come back from a journal.
function scrubJournal(store, id) {
  try {
    const recs = JSON.parse(localStorage.getItem(DIRTY_KEY) || 'null');
    if (!recs || !Array.isArray(recs[store])) return;
    recs[store] = recs[store].filter(r => r && r.id !== id);
    if ((recs.people || []).length || (recs.shelters || []).length) localStorage.setItem(DIRTY_KEY, JSON.stringify(recs));
    else localStorage.removeItem(DIRTY_KEY);
  } catch { /* blocked */ }
}
async function saveRec(store, o) {
  const stamp = o.updatedAt;
  dirty[store].set(o.id, o);
  try {
    await db.put(store, o);
    if (dirty[store].get(o.id) === o && o.updatedAt === stamp) dirty[store].delete(o.id);
  } catch (e) { console.error(e); toast('⚠️ שגיאה בשמירה במכשיר'); }
}
const savePerson = p => saveRec('people', p);
const saveShelter = s => saveRec('shelters', s);
async function recoverDirty() {
  let recs = null;
  try { recs = JSON.parse(localStorage.getItem(DIRTY_KEY) || 'null'); } catch { recs = null; }
  if (!recs) return;
  try {
    for (const store of ['people', 'shelters']) {
      const inc = Array.isArray(recs[store]) ? recs[store].filter(r => r && typeof r.id === 'string') : [];
      if (!inc.length) continue;
      const m = M.mergeRecords(await db.getAll(store), inc);
      await db.putMany(store, m.write);
    }
    localStorage.removeItem(DIRTY_KEY);
  } catch (e) { console.error('recoverDirty', e); }
}
const touch = o => { o.updatedAt = Date.now(); };

// ---------------- ui helpers ----------------
let toastTimer;
function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function ask(message, { ok = 'אישור', cancel = 'ביטול', danger = false } = {}) {
  const dlg = $('#dlg');
  if (!dlg || typeof dlg.showModal !== 'function') return Promise.resolve(window.confirm(message));
  dlg.innerHTML = String(html`
    <form method="dialog" class="dlg-body">
      <p>${message}</p>
      <div class="dlg-actions">
        <button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${ok}</button>
        <button class="btn ghost" value="cancel" ${danger ? raw('autofocus') : ''}>${cancel}</button>
      </div>
    </form>`);
  return new Promise(resolve => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [name, id] = h.split('/');
  return { name: name || 'home', id: id ? decodeURIComponent(id) : null };
}
function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '');

// ---------------- render ----------------
const VIEWS = {
  home: viewHome, new: viewNew, consent: viewConsent, p: viewPerson,
  needs: viewNeeds, shelters: viewShelters, more: viewMore, card: viewCard,
};

// A selector that finds "the same control" after a full re-render, so a tap on a status button does
// not throw keyboard and screen-reader users back to the top of the document.
function focusKey(a) {
  if (!a || a === document.body || !view.contains(a)) return null;
  if (a.id) return `#${CSS.escape(a.id)}`;
  const d = a.dataset || {};
  const attrs = ['action', 'change', 'id', 'need', 'val', 'cat', 'key', 'field', 'person'].filter(k => d[k] != null);
  if (!attrs.length) return null;
  return attrs.map(k => `[data-${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}="${CSS.escape(d[k])}"]`).join('');
}
function render({ keepScroll = false } = {}) {
  flushAll();
  const y = window.scrollY;
  const r = route();
  const fk = keepScroll ? focusKey(document.activeElement) : null;
  let out;
  try { out = (VIEWS[r.name] || viewHome)(r); }
  catch (e) { console.error(e); out = html`<section class="card"><h1>משהו השתבש</h1><p>${e.message}</p><a class="btn" href="#/">חזרה</a></section>`; }
  view.innerHTML = String(out);
  chrome(r);
  for (const el of $$('[data-w]', view)) el.style.width = `${el.dataset.w}%`;
  window.scrollTo(0, keepScroll ? y : 0);
  if (fk) { try { const n = view.querySelector(fk); if (n) n.focus({ preventScroll: true }); } catch { /* selector edge case */ } }
}
const isTyping = () => { const a = document.activeElement; return !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'file'].includes(a.type))); };

function chrome(r) {
  const tab = { home: 'home', new: 'home', consent: 'home', p: 'home', card: 'home', needs: 'needs', shelters: 'shelters', more: 'more' }[r.name] || 'home';
  for (const a of $$('.tabs a')) a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false');
  const b = [];
  if (db.mode === 'memory') b.push(html`<div class="banner warn" role="alert">⚠️ הדפדפן חוסם שמירה במכשיר (אולי חלון פרטי). מה שנרשם יימחק כשסוגרים את הדף — כדאי לייצא גיבוי מ"גיבוי ועוד".</div>`);
  if (S.swUpdate) b.push(html`<div class="banner info">יש גרסה חדשה של האפליקציה. <button class="btn small" data-action="reload">לרענן</button></div>`);
  if (!S.online) b.push(html`<div class="banner quiet">📴 אין חיבור — הכל ממשיך לעבוד ונשמר בטלפון.</div>`);
  if (S.people.length && !['more', 'consent', 'new'].includes(r.name) && (!S.lastBackup || Date.now() - S.lastBackup > 864e5)) {
    b.push(html`<div class="banner warn" data-testid="backup-banner">⚠️ אין גיבוי מאז ${S.lastBackup ? fmtDate(S.lastBackup) : 'אף פעם'}. הטלפון הוא העותק היחיד. <a href="#/more">לגבות עכשיו</a></div>`);
  }
  $('#banner').innerHTML = String(html`${b}`);
}

// ---------------- views ----------------
function viewHome() {
  const ag = M.aggregate(S.people);
  const has = S.people.length > 0;
  return html`
    <section class="hero">
      <h1>האנשים שלנו</h1>
      <p class="lede">רושמים בכבוד ובהסכמה מה כל אחד רוצה ומה חסר לו — כדי לחבר אותו לעזרה הנכונה.</p>
      <a class="btn primary big" href="#/new" data-testid="add-person">＋ להוסיף אדם</a>
    </section>
    ${installCard()}
    ${(() => { const st = S.people.filter(p => M.isStale(p)).length; return st ? html`<p class="banner warn">⏳ ${st === 1 ? 'אדם אחד' : `${st} אנשים`} בלי עדכון יותר מ-${M.STALE_DAYS} יום. בדף של כל אחד: לחדש קשר או למחוק.</p>` : ''; })()}
    ${has ? html`
      <div class="stats" role="list">
        <div role="listitem"><b>${ag.people}</b><span>אנשים</span></div>
        <div role="listitem"><b>${ag.open + ag.inProgress}</b><span>צרכים פעילים</span></div>
        <div role="listitem" class="${ag.urgent ? 'hot' : ''}"><b>${ag.urgent}</b><span>דחופים</span></div>
      </div>
      <label class="search"><span class="sr">חיפוש לפי שם</span>
        <input type="search" data-bind="q" placeholder="🔎 חיפוש לפי שם" value="${S.q}" autocomplete="off"></label>
      <ul class="people" id="people-list">${peopleList()}</ul>` : html`
      <div class="card empty">
        <p class="empty-ico" aria-hidden="true">🛖</p>
        <p><b>עוד אין אף אחד ברשימה.</b></p>
        <p>מתחילים בשם פרטי או בכינוי, מקריאים את ההסבר, ורק אחרי הסכמה שומרים — בטלפון הזה בלבד.</p>
      </div>`}`;
}

// Home-screen install hint: an installed web app keeps its storage far better on iOS (Safari can
// wipe a site's data after 7 days of Safari use without visiting it; WebKit blog 10218, 14403).
function isStandalone() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
function installCard() {
  if (isStandalone()) return '';
  try { if (localStorage.getItem('ht-install-hidden') === '1') return ''; } catch { /* storage blocked */ }
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return html`<section class="card install" data-testid="install-card">
    <h2>📲 להתקין במסך הבית</h2>
    <p class="hint">כך הטלפון שומר את הנתונים טוב יותר, והאפליקציה נפתחת גם בלי חיבור.</p>
    ${ios ? html`<p>ב-Safari: <b>שיתוף</b> ← <b>הוספה למסך הבית</b>.</p>`
      : S.installPrompt ? html`<button type="button" class="btn primary" data-action="install">להתקין</button>`
      : html`<p>בתפריט הדפדפן: <b>התקנת אפליקציה</b> או <b>הוספה למסך הבית</b>.</p>`}
    <button type="button" class="btn ghost" data-action="install-hide">לא עכשיו</button>
  </section>`;
}

function peopleList() {
  const q = S.q.trim();
  const list = [...S.people].sort((a, b) => b.updatedAt - a.updatedAt).filter(p => !q || p.name.includes(q));
  if (!list.length) return html`<li class="muted pad">לא נמצא שם כזה.</li>`;
  return html`${list.map(p => {
    const act = p.needs.filter(M.isActive);
    const urgent = act.some(n => n.urgency === 'urgent');
    const sh = M.shelterOf(S.shelters, p.id);
    // Sensitive categories never show as an icon next to a name (the screen is seen in a public square).
    const icons = [...new Set(act.filter(n => !M.isSensitive(n)).map(n => M.CAT[n.category]?.icon))].join(' ') + (act.some(M.isSensitive) ? ' 🔒' : '');
    return html`<li><a class="person-row" href="#/p/${encodeURIComponent(p.id)}">
      <span class="avatar" aria-hidden="true">${[...p.name][0] || '·'}</span>
      <span class="pr-main"><b class="pr-name">${p.name}</b>
        <span class="pr-sub">${act.length ? `${act.length} צרכים פעילים` : 'אין צרכים פתוחים'} · ${sh ? sh.name : 'בלי סוכה'}</span>
        ${icons ? html`<span class="pr-icons" aria-hidden="true">${icons}</span>` : ''}</span>
      ${urgent ? html`<span class="badge hot">דחוף</span>` : ''}
      ${M.isStale(p) ? html`<span class="badge warn">90+ יום</span>` : ''}
    </a></li>`;
  })}`;
}

function viewNew() {
  return html`
    <section class="card">
      <h1>אדם חדש</h1>
      <form data-form="new" novalidate>
        <label class="field"><span class="label">איך לקרוא לך?</span>
          <input name="name" id="new-name" maxlength="60" autocomplete="off" enterkeyhint="next"
            placeholder="שם פרטי או כינוי" value="${S.draft?.name || ''}" required>
          <small>מה שהאדם רוצה שיקראו לו. בלי שם משפחה ובלי מספר תעודת זהות.</small></label>
        <fieldset class="choices gate"><legend>לפני ההסבר (המתנדב/ת מסמן/ת)</legend>
          <label class="check req"><input type="checkbox" name="adult"><span>האדם נראה מעל גיל 18</span></label>
          <label class="check req"><input type="checkbox" name="capable"><span>האדם נראה כשיר להסכים עכשיו (לא שיכור, לא מבולבל, לא במצוקה חריפה)</span></label>
        </fieldset>
        <p class="note">🔒 עוד לא נשמר כלום. שומרים רק אחרי הסבר והסכמה.</p>
        <p class="form-err" data-err hidden></p>
        <button class="btn primary big" type="submit">המשך — הסבר והסכמה ←</button>
      </form>
    </section>`;
}

function viewConsent(r) {
  const p = r.id ? person(r.id) : null;
  if (r.id && !p) return notFound();
  const name = p ? p.name : S.draft?.name;
  if (!name) { setTimeout(() => go('#/new'), 0); return html``; }
  const c = p ? p.consent : {};
  const outdated = p && !M.consentCurrent(p);
  return html`
    <section class="consent">
      <h1>${p ? 'הסכמה — עדכון' : 'לפני שמתחילים'}</h1>
      ${outdated ? html`<p class="banner warn">נוסח ההסכמה עודכן (גרסה ${M.CONSENT_VERSION}). צריך להקריא שוב ולשאול מחדש — עד אז לא מוסרים כלום על ${p.name}.</p>` : ''}
      <p class="banner quiet" data-testid="lang-note">🌐 ${CONSENT_LANG_NOTE}</p>
      ${CONTROLLER.phone ? '' : html`<p class="hint">⚠️ לפני שימוש בשטח: לקבוע טלפון קבוע לפרויקט ולהוסיף אותו לנוסח (js/texts.js).</p>`}
      <div class="card consent-sum">
        <ul class="sum-points">${CONSENT_SUMMARY.map(t => html`<li>${t}</li>`)}</ul>
        ${SP.support.tts ? html`<button type="button" class="btn ghost speak" data-action="read-consent" aria-pressed="${SP.isSpeaking()}">🔊 להקריא בקול את כל ההסבר</button>`
          : html`<p class="hint">אין הקראה אוטומטית בדפדפן הזה — מקריאים בקול רם את ההסבר המלא.</p>`}
        <details class="consent-text" id="consent-full">
          <summary>ההסבר המלא (חובה להקריא או לתת לקרוא)</summary>
          ${consentParas(name).map(x => html`<h3>${x.h}</h3><p>${x.p}</p>`)}
        </details>
      </div>
      <form data-form="consent" data-id="${p ? p.id : ''}" novalidate>
        <fieldset class="choices card"><legend>מה מסכימים?</legend>
          ${CONSENT_CHOICES.map(ch => html`
            <label class="check ${ch.required ? 'req' : ''}">
              <input type="checkbox" name="${ch.key}" ${(ch.key === 'store' ? !!p : (!outdated && c[ch.key])) ? raw('checked') : ''}>
              <span>${ch.label}${ch.required ? html` <em>(חובה כדי לשמור)</em>` : ''}</span></label>`)}
          <p class="legend2">מי מאשר?</p>
          ${CONSENT_BY.map(b => html`
            <label class="radio"><input type="radio" name="by" value="${b.id}" ${!outdated && c.by === b.id ? raw('checked') : ''}><span>${b.label}</span></label>`)}
        </fieldset>
        <p class="form-err" data-err hidden></p>
        <div class="actions">
          <button class="btn primary big" type="submit">${p ? 'לשמור את ההסכמה' : 'מסכימים — להתחיל'}</button>
          <button class="btn ghost" type="button" data-action="consent-decline" data-id="${p ? p.id : ''}">${p ? 'ביטול' : 'לא עכשיו'}</button>
        </div>
      </form>
    </section>`;
}

function consentChips(p) {
  const c = p.consent || {};
  return html`<div class="chips">
    <span class="chip ${M.shareOk(p) ? 'yes' : 'no'}" title="שיתוף עם גורמי עזרה — שואלים לכל גורם בנפרד">🤝 שיתוף: ${M.shareOk(p) ? 'כן' : 'לא'}</span>
    <span class="chip ${c.card ? 'yes' : 'no'}">🪪 כרטיס: ${c.card ? 'כן' : 'לא'}</span>
    <span class="chip ${c.cloudVoice ? 'yes' : 'no'}">🎙️ תמלול בשרת: ${c.cloudVoice ? 'כן' : 'לא'}</span>
    <span class="chip" title="${c.by === 'self' ? 'אושר על ידי האדם עצמו' : 'הוקרא בקול ואושר בעל פה'}">${c.by === 'self' ? '✍️ אושר בידי האדם' : '🔊 הוקרא ואושר בעל פה'} · ${fmtDate(c.at, { dateStyle: 'short' })}</span>
  </div>`;
}

function micRow(p, field) {
  if (!SP.support.stt) return html`<p class="hint">🎙️ הקלטה קולית לא נתמכת בדפדפן הזה. אפשר להקליד, או ללחוץ על המיקרופון שבמקלדת של הטלפון.</p>`;
  // Cloud transcription without this person's consent: no record button at all, just one quiet line.
  if (S.sttMode !== 'local' && !p.consent?.cloudVoice) {
    return html`<p class="hint mic-off">🎙️ אין הסכמה לתמלול קולי בשרת — מקלידים. <a href="#/consent/${encodeURIComponent(p.id)}">עדכון הסכמה</a></p>
      ${SP.local.status === 'downloadable' ? html`<button type="button" class="btn small" data-action="stt-install">⬇️ להתקין תמלול בתוך הטלפון (בלי שרת)</button>` : ''}`;
  }
  const on = S.mic && S.mic.personId === p.id && S.mic.field === field;
  return html`<div class="mic-row">
      <button type="button" class="btn mic ${on ? 'on' : ''}" data-action="mic" data-id="${p.id}" data-field="${field}" aria-pressed="${on ? 'true' : 'false'}">${on ? '⏹ לעצור הקלטה' : '🎙️ לספר בקול'}</button>
      <span class="mic-mode">${S.sttMode === 'local' ? 'תמלול בתוך הטלפון' : 'תמלול דרך שרת הדפדפן (יש הסכמה)'}</span>
      ${S.sttMode === 'cloud' && SP.local.status === 'downloadable' ? html`<button type="button" class="btn small" data-action="stt-install">⬇️ תמלול בתוך הטלפון</button>` : ''}
    </div>
    <p class="interim" aria-live="polite" data-interim="${p.id}:${field}">${on ? S.interim : ''}</p>`;
}

function sensWarn(fid, value) {
  const hit = M.findSensitiveNumbers(value).length > 0;
  return html`<p class="sens" data-sens-for="${fid}" ${hit ? '' : raw('hidden')}>
    נראה שהוקלד מספר ארוך (תעודת זהות או טלפון?). עדיף לא לשמור מספרים מזהים.
    <button type="button" class="btn small" data-action="mask" data-target="${fid}">להסתיר את המספר</button></p>`;
}

function suggestionsHTML(p) {
  const sugg = M.suggestCategories(`${p.story}\n${p.wishes}`)
    .filter(s => !p.needs.some(n => n.category === s.category && M.isActive(n)));
  if (!sugg.length) return html``;
  return html`<div class="sugg"><span class="sugg-label">עלה בסיפור — להוסיף?</span>
    ${sugg.map(s => html`<button type="button" class="chip-btn" data-action="add-need" data-id="${p.id}" data-cat="${s.category}" title="בגלל: ${s.word}">${M.CAT[s.category].icon} ${M.CAT[s.category].he} ＋</button>`)}</div>`;
}

function textBlock(p, field, { title, hint, rows = 4, placeholder }) {
  const fid = `f-${field}-${p.id}`;
  return html`<section class="card">
    <h2><label for="${fid}">${title}</label></h2>
    ${hint ? html`<p class="hint">${hint}</p>` : ''}
    <textarea id="${fid}" rows="${rows}" data-bind="person.${field}" data-id="${p.id}" placeholder="${placeholder || ''}">${p[field]}</textarea>
    ${sensWarn(fid, p[field])}
    ${micRow(p, field)}
    ${field === 'story' ? html`<div id="sugg-${p.id}">${suggestionsHTML(p)}</div>` : ''}
  </section>`;
}

function viewPerson(r) {
  const p = person(r.id);
  if (!p) return notFound();
  const sh = M.shelterOf(S.shelters, p.id);
  const needs = M.sortNeeds(p.needs);
  const shelterOptions = sortedShelters().filter(s => s === sh || s.occupants.filter(id => person(id)).length < s.capacity);
  return html`
    <section class="card person-head">
      <a class="back" href="#/">→ כל האנשים</a>
      <label class="name-edit"><span class="sr">שם או כינוי</span>
        <input class="name-input" data-bind="person.name" data-id="${p.id}" data-orig="${p.name}" value="${p.name}" maxlength="60"></label>
      ${consentChips(p)}
      <a class="link" href="#/consent/${encodeURIComponent(p.id)}">שינוי הסכמה</a>
    </section>
    ${M.consentCurrent(p) ? '' : html`<p class="banner warn">נוסח ההסכמה עודכן. <a href="#/consent/${encodeURIComponent(p.id)}">להקריא שוב ולשאול מחדש</a> — עד אז לא מוסרים כלום.</p>`}
    ${M.isStale(p) ? html`<div class="banner warn">⏳ אין עדכון יותר מ-${M.STALE_DAYS} יום. לחדש קשר או למחוק?
      <div class="actions"><button type="button" class="btn small" data-action="renew" data-id="${p.id}">חידוש קשר</button>
      <button type="button" class="btn small danger-ghost" data-action="person-del" data-id="${p.id}">למחוק</button></div></div>` : ''}
    <nav class="jump" aria-label="קפיצה בתוך הדף">
      <button type="button" data-action="jump" data-target="f-story-${p.id}">סיפור</button>
      <button type="button" data-action="jump" data-target="f-wishes-${p.id}">משאלות</button>
      <button type="button" data-action="jump" data-target="needs-${p.id}">צרכים</button>
      <button type="button" data-action="jump" data-target="sleep-${p.id}">סוכה</button>
    </nav>

    ${textBlock(p, 'story', { title: 'הסיפור', hint: 'כמה שרוצים לספר, במילים שלך. לא חייבים.', rows: 2, placeholder: 'מה קרה, מה עובר עליך עכשיו…' })}
    ${textBlock(p, 'wishes', { title: 'משאלות וחלומות', hint: 'לא רק מה חסר — גם מה רוצים.', rows: 2, placeholder: 'למשל: לחזור לנגן, לראות את הנכדים…' })}

    <section class="card" id="needs-${p.id}">
      <h2>מה חסר עכשיו</h2>
      <p class="hint">לחיצה מוסיפה צורך. אפשר כמה.</p>
      <div class="cat-grid">
        ${M.CATEGORIES.map(c => {
          const has = p.needs.some(n => n.category === c.id && M.isActive(n));
          return html`<button type="button" class="cat-btn ${has ? 'has' : ''}" data-action="add-need" data-id="${p.id}" data-cat="${c.id}" aria-pressed="${has ? 'true' : 'false'}"><span class="ci" aria-hidden="true">${c.icon}</span><span>${c.he}</span></button>`;
        })}
      </div>
      <div class="needs">${needs.length ? needs.map(n => needCard(p, n)) : html`<p class="muted">עוד לא נרשמו צרכים.</p>`}</div>
    </section>

    <section class="card" id="sleep-${p.id}">
      <h2><label for="sel-shelter-${p.id}">איפה ישנים</label></h2>
      ${S.shelters.length ? html`
        <select id="sel-shelter-${p.id}" data-change="person-shelter" data-id="${p.id}">
          <option value="">— בלי סוכה —</option>
          ${shelterOptions.map(s => html`<option value="${s.id}" ${s === sh ? raw('selected') : ''}>${s.name} (${s.occupants.filter(id => person(id)).length}/${s.capacity})</option>`)}
        </select>` : html`<p class="muted">עוד אין סוכות. <a href="#/shelters">להוסיף סוכות</a></p>`}
      ${sh ? html`<p class="muted small">מיטה ${M.bedLabel(sh, sh.occupants.indexOf(p.id))} · שק הכביסה מסומן כך, בלי שם.</p>` : ''}
      <fieldset class="kit"><legend>ערכת חורף אישית (שלו/שלה, לא של השבט)</legend>
        ${M.KIT_ITEMS.map(i => html`<label class="check inline"><input type="checkbox" data-change="kit" data-id="${p.id}" data-key="${i.id}" ${p.kit?.[i.id] ? raw('checked') : ''}><span>${i.he}</span></label>`)}
      </fieldset>
    </section>

    <section class="card">
      <h2><label for="f-contactNote-${p.id}">איך אפשר למצוא אותי</label></h2>
      <p class="hint">לא חובה. למשל: "ליד הבימה, בערבים". בלי כתובת מדויקת.</p>
      <input id="f-contactNote-${p.id}" data-bind="person.contactNote" data-id="${p.id}" value="${p.contactNote}" maxlength="140">
      ${sensWarn(`f-contactNote-${p.id}`, p.contactNote)}
    </section>

    <section class="card actions-card">
      ${p.consent?.card
        ? html`<a class="btn" href="#/card/${encodeURIComponent(p.id)}">🪪 כרטיס "מה צריך עכשיו"</a>`
        : html`<p class="hint">🪪 כרטיס "מה צריך עכשיו" זמין רק אם האדם הסכים לכך (<a href="#/consent/${encodeURIComponent(p.id)}">הסכמה</a>).</p>`}
      <button type="button" class="btn danger-ghost" data-action="person-del" data-id="${p.id}">🗑️ למחוק את ${p.name} ואת כל המידע</button>
      <p class="muted small">נוצר ${fmtDate(p.createdAt)} · עודכן ${fmtDate(p.updatedAt)}</p>
    </section>`;
}

function needCard(p, n) {
  const c = M.CAT[n.category] || M.CAT.other;
  const fid = `f-note-${n.id}`;
  return html`<article class="need st-${n.status} urg-${n.urgency}" id="need-${n.id}">
    <header>
      <span class="need-ico" aria-hidden="true">${c.icon}</span>
      <h3>${c.he}</h3>
      ${n.urgency === 'urgent' ? html`<span class="badge hot">דחוף</span>` : n.urgency === 'high' ? html`<span class="badge warm">גבוהה</span>` : ''}
      ${M.isSensitive(n) ? html`<span class="badge" title="לא יוצא בסיכום, בקובץ למסירה או בכרטיס כברירת מחדל">🔒 רגיש</span>` : ''}
    </header>
    <div class="seg" role="group" aria-label="מצב">
      ${M.STATUSES.map(s => html`<button type="button" data-action="need-status" data-id="${p.id}" data-need="${n.id}" data-val="${s.id}" aria-pressed="${n.status === s.id ? 'true' : 'false'}">${s.he}</button>`)}
    </div>
    <div class="seg small" role="group" aria-label="דחיפות">
      <span class="seg-label">דחיפות</span>
      ${M.URGENCIES.map(u => html`<button type="button" data-action="need-urgency" data-id="${p.id}" data-need="${n.id}" data-val="${u.id}" aria-pressed="${n.urgency === u.id ? 'true' : 'false'}">${u.he}</button>`)}
    </div>
    <label class="sr" for="${fid}">הערות ל${c.he}</label>
    <textarea id="${fid}" rows="2" data-bind="need.notes" data-id="${p.id}" data-need="${n.id}" placeholder="הערות — רק מה שצריך כדי לעזור">${n.notes}</textarea>
    ${sensWarn(fid, n.notes)}
    <details class="match" data-need="${n.id}" data-match-cat="${n.category}" ${S.openMatch.has(n.id) ? raw('open') : ''}>${matchInner(n.category)}</details>
    <button type="button" class="btn small danger-ghost need-del" data-action="need-del" data-id="${p.id}" data-need="${n.id}" aria-label="להסיר את הצורך ${c.he}">✕ להסיר את הצורך</button>
  </article>`;
}
function matchInner(category) {
  const matches = M.matchResources(S.resources, category);
  const loading = S.resLoading && !S.resources.length;
  return html`<summary>מי יכול לעזור? <b>${loading ? '…' : matches.length}</b></summary>
    ${loading ? html`<p class="muted">טוענים את מאגר מקורות העזרה…</p>`
      : matches.length ? html`${matches.map(resourceCard)}` : html`<p class="muted">עוד אין במאגר מקור עזרה לנושא הזה.</p>`}`;
}

function resourceCard(r) {
  const sample = r.sample || S.resMeta.sample;
  // A do-not-refer row (e.g. an inactive org whose domain now hosts something else) gets no call/site buttons.
  const url = r.do_not_refer ? '' : safeUrl(r.contact?.url), src = safeUrl(r.source_url), arch = safeUrl(r.archive_url);
  const phones = r.do_not_refer ? [] : M.phoneNumbers(r.contact?.phone).slice(0, 4);
  const phoneNote = r.contact?.phone && !(phones.length === 1 && phones[0].text === r.contact.phone.trim());
  const label = M.verificationLabel(r);
  return html`<div class="res ${r.do_not_refer ? 'dnr' : ''}">
    <div class="res-head"><b>${r.name_he}</b>
      ${r.do_not_refer ? html`<span class="badge hot">⛔ ${label}</span>`
        : r.verified ? html`<span class="badge ok">✓ ${label}</span>` : html`<span class="badge warn">${label}</span>`}
      ${r.start_here && !r.do_not_refer ? html`<span class="badge info">⭐ להתחיל כאן</span>` : ''}
      ${sample ? html`<span class="badge sample">דוגמה בדיונית</span>` : ''}</div>
    ${r.offers_he ? html`<p>${r.offers_he}</p>` : ''}
    ${r.eligibility_he ? html`<p class="muted">למי: ${r.eligibility_he}</p>` : ''}
    ${r.area ? html`<p class="muted">אזור: ${r.area}</p>` : ''}
    ${r.contact?.hours ? html`<p class="muted">שעות: ${r.contact.hours}</p>` : ''}
    ${r.notes_he ? html`<details class="res-notes"><summary>הערות מהמחקר</summary><p>${r.notes_he}</p></details>` : ''}
    <div class="res-links">
      ${phones.map(n => html`<a class="btn small" href="tel:${n.dial}">📞 <bdi>${n.text}</bdi></a>`)}
      ${url ? html`<a class="btn small" href="${url}" target="_blank" rel="noopener noreferrer">🌐 אתר</a>` : ''}
    </div>
    ${phoneNote ? html`<p class="muted small">📞 ${r.contact.phone}</p>` : ''}
    ${r.contact?.address ? html`<p class="addr">📍 ${r.contact.address}</p>` : ''}
    <p class="src-line">
      ${src ? html`<a class="src" href="${src}" target="_blank" rel="noopener noreferrer">מקור המידע</a>` : html`<span class="src">אין קישור למקור</span>`}
      ${arch ? html` · <a class="src" href="${arch}" target="_blank" rel="noopener noreferrer">צילום ארכיון${r.snapshot ? ` ${r.snapshot}` : ''}</a>` : ''}
      ${r.verified_date ? html` · <span class="src">נבדק ${r.verified_date}</span>` : ''}
    </p>
  </div>`;
}

function viewNeeds() {
  const ag = M.aggregate(S.people);
  const rows = M.CATEGORIES.map(c => [c, ag.byCategory[c.id]]).sort((a, b) => b[1].active - a[1].active || b[1].resolved - a[1].resolved);
  const max = Math.max(1, ...rows.map(([, b]) => b.active));
  const activeRows = rows.filter(([, b]) => b.active > 0);
  const quiet = rows.filter(([, b]) => b.active === 0);
  return html`
    <section class="hero">
      <h1>צרכים — התמונה הכוללת</h1>
      <p class="lede">מי צריך את אותו הדבר — כדי לפנות פעם אחת לעובדת הסוציאלית, לעורך הדין או לעמותה, בשביל כמה אנשים יחד.</p>
    </section>
    <div class="stats five" role="list">
      <div role="listitem"><b>${ag.open}</b><span>פתוח</span></div>
      <div role="listitem"><b>${ag.inProgress}</b><span>בטיפול</span></div>
      <div role="listitem"><b>${ag.resolved}</b><span>נפתר</span></div>
      <div role="listitem" class="${ag.urgent ? 'hot' : ''}"><b>${ag.urgent}</b><span>דחוף</span></div>
    </div>
    <section class="card">
      <h2>לפי נושא</h2>
      ${activeRows.length ? html`<div class="cat-rows">${activeRows.map(([c, b]) => html`
        <details class="cat-row">
          <summary>
            <span class="ci" aria-hidden="true">${c.icon}</span>
            <span class="cr-label">${c.he}</span>
            <span class="bar" aria-hidden="true"><i data-w="${Math.round((b.active / max) * 100)}"></i></span>
            <b class="cr-n">${b.active}</b>
            ${b.urgent ? html`<span class="badge hot">${b.urgent} דחוף</span>` : ''}
          </summary>
          <ul class="who">${b.people.map(x => html`<li><a href="#/p/${encodeURIComponent(x.personId)}">${x.name}</a>
            <span class="badge ${x.status === 'in_progress' ? 'info' : ''}">${M.STATUS[x.status].he}</span>
            ${x.urgency === 'urgent' || x.urgency === 'high' ? html`<span class="badge ${x.urgency === 'urgent' ? 'hot' : 'warm'}">${M.URGENCY[x.urgency].he}</span>` : ''}
            ${x.shareOk ? '' : html`<span class="badge muted-b" title="לא אישר/ה שיתוף">🔒</span>`}</li>`)}</ul>
          ${(() => { const m = M.matchResources(S.resources, c.id); return m.length
            ? html`<p class="hint">מקורות עזרה במאגר (${m.length}): ${m.slice(0, 4).map(r => r.name_he).join(' · ')}${m.length > 4 ? ` · ועוד ${m.length - 4} — בכרטיס של כל אדם, תחת "מי יכול לעזור?"` : ''}</p>`
            : html`<p class="hint">אין עדיין מקור עזרה במאגר לנושא הזה.</p>`; })()}
        </details>`)}</div>` : html`<p class="muted">עוד אין צרכים פעילים.</p>`}
      ${quiet.length && activeRows.length ? html`<p class="muted small">בלי צרכים פעילים: ${quiet.map(([c]) => c.he).join(' · ')}</p>` : ''}
    </section>
    <section class="card">
      <h2>סיכום לתיאום</h2>
      <p class="hint">להעתיק ולשלוח לעובדת הסוציאלית או לעמותה. בלי שמות כברירת מחדל, בלי נושאים רגישים, ומספר קטן מ-3 מוצג כ"פחות מ-3".</p>
      <label class="check"><input type="checkbox" data-change="summary-names" ${S.summaryNames ? raw('checked') : ''}>
        <span>לכלול שמות — רק של מי שהסכים לשיתוף, ורק אחרי שכל אחד אישר עכשיו את הגורם שמקבל</span></label>
      <pre class="summary" id="summary">${M.summaryText(S.people, { includeNames: S.summaryNames })}</pre>
      <button type="button" class="btn" data-action="copy-summary">📋 להעתיק את הסיכום</button>
    </section>`;
}

function viewShelters() {
  const d = M.shelterDay(S.shelters, S.people);
  const kit = M.kitStatus(S.people);
  const now = new Date();
  const today = new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
  const rounds = S.rounds[M.dayKey()] || {};
  const isShabbat = now.getDay() === 6, isFriday = now.getDay() === 5;
  return html`
    <section class="hero">
      <h1>סוכות</h1>
      <p class="lede">שניים בכל סוכה, סדין נקי כל יום.</p>
    </section>
    <section class="card plan">
      <p class="banner warn">⚠️ אין עדיין היתר. לפי חוק העזר העירוני אסור להקים בכיכר "כל דבר" בלי היתר בכתב מראש העירייה. יחידה עוברת ל"הוקמה" רק עם היתר בכתב, או בחצר פרטית עם הסכמת הבעלים בכתב.</p>
      <h2>שלושה מסלולים במקביל</h2>
      <ol class="tracks">
        <li><b>ערכת חורף אישית</b> לכל אדם, בבעלותו. בלי היתר. <span class="muted">(${kit.full}/${kit.total} עם ערכה מלאה${kit.partial ? ` · ${kit.partial} חלקית` : ''})</span></li>
        <li><b>חיבור למיטות קיימות:</b> גגוני לשובע והיחידה העירונית לדרי רחוב (במסך "צרכים" ← מחסה).</li>
        <li><b>פיילוט סוכות</b> של 2–3 יחידות, רק עם היתר בכתב או חצר פרטית.</li>
      </ol>
      <p class="muted small">פירוט, עלויות ומקורות: shelter/PLAN.md בתיקיית הפרויקט.</p>
    </section>
    <section class="card today">
      <h2>היום · ${today}</h2>
      <div class="stats" role="list">
        <div role="listitem" class="${d.occupied && d.changed === d.occupied ? 'good' : ''}"><b>${d.changed}/${d.occupied}</b><span>סדינים הוחלפו</span></div>
        <div role="listitem" class="${d.bedsPending ? 'warmb' : ''}"><b>${d.bedsPending}</b><span>סטים עוד להחליף</span></div>
        <div role="listitem"><b>${d.free}</b><span>מקומות פנויים</span></div>
      </div>
      ${(() => { const occ = sortedShelters().filter(s => s.occupants.some(id => person(id))); return occ.length ? html`
      <h3>הלילה — סדינים</h3>
      <ul class="tonight" data-testid="tonight">${occ.map(s => { const n = s.occupants.filter(id => person(id)).length; const ok = !!(s.sheets && s.sheets[M.dayKey()]); return html`<li>
        <label class="check tn ${ok ? 'on' : ''}"><input type="checkbox" data-change="sheet" data-id="${s.id}" ${ok ? raw('checked') : ''}>
          <span><b>${s.name}</b> · ${n}/${s.capacity} · ${ok ? '✅ סדינים הוחלפו' : 'סדינים להחליף'}</span></label></li>`; })}</ul>` : ''; })()}
      <h3>סבב יומי</h3>
      ${isShabbat ? html`<p class="hint">שבת: רק ביקור בוקר, בלי כביסה. הסט הרזרבי הושאר ביום שישי.</p>` : ''}
      ${isFriday ? html`<p class="hint">יום שישי: מכבסים כפול ומשאירים סט רזרבי ליד כל יחידה לשבת.</p>` : ''}
      <ul class="rounds">${M.ROUNDS.filter(x => !(isShabbat && x.id === 'laundry')).map(x => html`<li>
        <label class="check"><input type="checkbox" data-change="round" data-key="${x.id}" ${rounds[x.id] ? raw('checked') : ''}>
          <span><b>${x.he}</b> <span class="muted small">${x.time}</span><br><span class="small">${x.what}</span></span></label></li>`)}</ul>
      <p class="muted small">מתנדבים תמיד בזוגות. לא נכנסים ליחידה בלי רשות. לא מצלמים פנים.</p>
    </section>
    ${S.shelters.length ? html`<div class="shelters">${sortedShelters().map(shelterCard)}</div>` : html`
      <section class="card empty">
        <p class="empty-ico" aria-hidden="true">🛖</p>
        <p>עוד אין סוכות ברשימה.</p>
        <button type="button" class="btn primary" data-action="seed-shelters">ליצור 10 יחידות U1–U10 (מיטות A/B)</button>
        <p class="muted small">היחידות נוצרות במצב "מתוכננת". זו רשימת עבודה, לא הקמה.</p>
      </section>`}
    <section class="card">
      <h2>להוסיף יחידה</h2>
      <form data-form="shelter-add" class="row-form" novalidate>
        <label class="field"><span class="label">קוד</span><input name="name" maxlength="40" placeholder="${M.nextUnitName(S.shelters)}"></label>
        <label class="field narrow"><span class="label">מקומות</span><input name="capacity" type="number" min="1" max="8" value="2" inputmode="numeric"></label>
        <button class="btn" type="submit">＋ להוסיף</button>
      </form>
    </section>
    <section class="card">
      <details class="proto"><summary><b>☔ פרוטוקול גשם</b></summary><ol>
        <li>כל בוקר: תחזית השירות המטאורולוגי (ims.gov.il).</li>
        <li>24 שעות לפני גשם: מהדקים ברזנטים ומשקולות, מרימים מזרנים ושקי שינה מהרצפה, חפצים בשקיות אטומות, סט יבש רזרבי לכל מיטה.</li>
        <li>סערה, רוח חזקה או הצפה: מעבירים אנשים מראש למקום מקורה (גגון של לשובע, או לפי 106). מפרקים ברזנט שהופך למפרש.</li>
        <li>אחרי הגשם: מייבשים, מחליפים מצעים רטובים גם מחוץ לסבב, בודקים עובש.</li>
      </ol></details>
      <details class="proto"><summary><b>🔥 בטיחות</b></summary><ul>
        <li>בתוך יחידה אסור: נרות, גזייה, כירה, פחמים, תנור גז או נפט (שריפה ופחמן חד-חמצני).</li>
        <li>לא מעשנים בתוך יחידה. 2 מ' לפחות בין יחידות. מעבר הולכי הרגל נשאר פתוח.</li>
        <li>לא מתחברים לחשמל מעמודי הרחוב. מטף ושמיכת כיבוי בעמדה המרכזית.</li>
        <li>חירום: מד"א 101 · כבאות 102 · משטרה 100 · מוקד העירייה 106.</li>
      </ul></details>
      <p class="muted small">כללי השבט, לא ציטוט חוק. נכתבים מחדש יחד עם הדיירים בפגישה הראשונה.</p>
    </section>`;
}

function shelterCard(s) {
  const key = M.dayKey();
  const occ = s.occupants.map(person).filter(Boolean);
  const assigned = new Set(S.shelters.flatMap(x => x.occupants));
  const free = S.people.filter(p => !assigned.has(p.id));
  const done = !!(s.sheets && s.sheets[key]);
  const week = M.lastDays(7);
  const dayLetter = d => new Intl.DateTimeFormat('he-IL', { weekday: 'narrow' }).format(d);
  return html`<details class="shelter ${done ? 'done' : ''} ${occ.length ? '' : 'vacant'}" id="sh-${s.id}" data-shelter="${s.id}" ${S.openShelters.has(s.id) ? raw('open') : ''}>
    <summary class="sh-sum"><b>${s.name}</b> <span class="cap">${occ.length}/${s.capacity}</span>
      <span class="sh-state">${occ.length ? (done ? '✅ סדינים היום' : '🧺 סדינים להחליף') : 'פנויה'} · ${M.SHELTER_STAGES.find(k => k.id === (s.stage || 'planned'))?.he || ''}</span></summary>
    <header>
      <label class="sh-name"><span class="sr">שם הסוכה</span><input data-bind="shelter.name" data-id="${s.id}" data-orig="${s.name}" value="${s.name}" maxlength="40"></label>
      <button type="button" class="icon-btn" data-action="shelter-del" data-id="${s.id}" aria-label="למחוק את ${s.name}">✕</button>
    </header>
    <label class="sr" for="loc-${s.id}">מיקום</label>
    <input id="loc-${s.id}" class="loc" data-bind="shelter.location" data-id="${s.id}" value="${s.location || ''}" placeholder="מיקום (למשל: הצד המזרחי של הכיכר)" maxlength="80">
    <div class="sh-meta">
      <label class="sr" for="kind-${s.id}">סוג היחידה</label>
      <select id="kind-${s.id}" data-change="shelter-kind" data-id="${s.id}">
        ${M.SHELTER_KINDS.map(k => html`<option value="${k.id}" ${(s.kind || '') === k.id ? raw('selected') : ''}>${k.he}</option>`)}
      </select>
      <label class="sr" for="stage-${s.id}">מצב היחידה</label>
      <select id="stage-${s.id}" data-change="shelter-stage" data-id="${s.id}" class="stage-${s.stage || 'planned'}">
        ${M.SHELTER_STAGES.map(k => html`<option value="${k.id}" ${(s.stage || 'planned') === k.id ? raw('selected') : ''}>${k.he}</option>`)}
      </select>
    </div>
    <ul class="occupants">
      ${occ.map(p => html`<li class="occ"><span class="bed" title="מיטה / שק כביסה">${M.bedLabel(s, s.occupants.indexOf(p.id))}</span><a href="#/p/${encodeURIComponent(p.id)}">${p.name}</a>
        <button type="button" class="icon-btn small" data-action="occupant-remove" data-id="${s.id}" data-person="${p.id}" aria-label="להוציא את ${p.name} מהסוכה">✕</button></li>`)}
      ${!occ.length ? html`<li class="muted">פנויה</li>` : ''}
    </ul>
    ${occ.length < s.capacity && free.length ? html`
      <label class="sr" for="add-occ-${s.id}">לשבץ אדם</label>
      <select id="add-occ-${s.id}" data-change="occupant-add" data-id="${s.id}">
        <option value="">＋ לשבץ אדם…</option>
        ${free.map(p => html`<option value="${p.id}">${p.name}</option>`)}
      </select>` : ''}
    ${occ.length ? html`
    <label class="sheet-check">
      <input type="checkbox" data-change="sheet" data-id="${s.id}" ${done ? raw('checked') : ''}>
      <span>🧺 סדינים נקיים הוחלפו היום${done && s.sheets[key].at ? html` <small>(${fmtDate(s.sheets[key].at, { timeStyle: 'short' })})</small>` : ''}</span>
    </label>` : ''}
    <div class="week" aria-label="החלפת סדינים — 7 ימים אחרונים">
      ${week.map(w => html`<span class="day ${s.sheets && s.sheets[w.key] ? 'on' : ''} ${w.key === key ? 'today' : ''}" title="${w.key}"><i></i>${dayLetter(w.date)}</span>`)}
    </div>
  </details>`;
}

function viewMore() {
  const consented = S.people.filter(M.shareOk).length;
  const verified = S.resources.filter(r => r.verified).length;
  const canShareFiles = !!(navigator.canShare && typeof File !== 'undefined');
  return html`
    <section class="hero"><h1>גיבוי ועוד</h1>
      <p class="lede">${S.lastBackup ? `גיבוי מלא אחרון: ${fmtDate(S.lastBackup)}` : (S.people.length ? '⚠️ עוד לא נשמר גיבוי מלא. הטלפון הוא העותק היחיד.' : 'אין עדיין נתונים לגבות.')}</p></section>

    <section class="card">
      <h2>⬇️ גיבוי וייצוא (תמיד מוצפן)</h2>
      <form data-form="export" novalidate>
        <fieldset class="choices"><legend>מה לייצא?</legend>
          <label class="radio"><input type="radio" name="scope" value="all" checked>
            <span><b>גיבוי מלא</b> של הכל — רק לטלפון או למחשב שלך. כדאי פעם ביום.</span></label>
          <label class="radio"><input type="radio" name="scope" value="consented">
            <span><b>למסירה לגורם</b> (עובדת סוציאלית, עמותה): רק מי שהסכים לשיתוף (${consented} מתוך ${S.people.length}), רק שם וצרכים לא רגישים — בלי סיפור, משאלות, מקום שינה או הערות.</span></label>
        </fieldset>
        <label class="field"><span class="label">למי מוסרים? (רק במסירה לגורם)</span>
          <input name="recipient" maxlength="80" autocomplete="off" placeholder="למשל: היחידה לדרי רחוב"></label>
        <label class="field"><span class="label">סיסמה להצפנה (חובה)</span>
          <input name="pass" type="password" autocomplete="new-password" minlength="8" placeholder="לפחות 8 תווים"></label>
        <label class="field"><span class="label">שוב את הסיסמה</span>
          <input name="pass2" type="password" autocomplete="new-password"></label>
        <p class="hint">הקובץ מוצפן (AES-GCM) ואי אפשר לקרוא אותו בלי הסיסמה. את הסיסמה מוסרים בנפרד — לא באותה הודעה עם הקובץ. אין דרך לשחזר סיסמה שנשכחה.</p>
        <p class="form-err" data-err hidden></p>
        <div class="actions">
          <button class="btn primary" type="submit">⬇️ לשמור קובץ</button>
          ${canShareFiles ? html`<button class="btn" type="button" data-action="share-file">📤 לשתף קובץ</button>` : ''}
        </div>
      </form>
    </section>

    <section class="card">
      <h2>⬆️ ייבוא קובץ</h2>
      <form data-form="import" novalidate>
        <label class="field"><span class="label">קובץ JSON של השבט האנושי</span><input name="file" type="file" accept="application/json,.json"></label>
        <label class="field"><span class="label">סיסמה (אם הקובץ מוצפן)</span><input name="pass" type="password" autocomplete="current-password"></label>
        <fieldset class="choices"><legend>איך לייבא?</legend>
          <label class="radio"><input type="radio" name="mode" value="merge" checked><span>למזג — הגרסה החדשה יותר של כל רשומה נשמרת</span></label>
          <label class="radio"><input type="radio" name="mode" value="replace"><span>להחליף הכל בתוכן הקובץ</span></label>
        </fieldset>
        <p class="form-err" data-err hidden></p>
        <button class="btn" type="submit">⬆️ לייבא</button>
      </form>
    </section>

    <section class="card">
      <h2>🔒 איך שומרים על הפרטיות</h2>
      <ul class="points">${PRIVACY_POINTS.map(t => html`<li>${t}</li>`)}</ul>
      <p class="muted small">אחסון: ${db.mode === 'idb' ? 'בטלפון הזה (IndexedDB)' : 'זיכרון זמני בלבד — יימחק בסגירה'} · <span id="storage-est"></span></p>
      ${navigator.storage?.persist ? html`<button type="button" class="btn small" data-action="persist">לבקש מהדפדפן לא למחוק את הנתונים</button>` : ''}
    </section>

    <section class="card">
      <h2>📚 מקורות עזרה</h2>
      ${S.resLoading && !S.resources.length ? html`<p class="muted">טוענים את המאגר…</p>` : html`
      <p>במאגר: ${S.resources.length} מקורות · ${verified} אומתו · ${S.resources.length - verified} לא אומתו.</p>`}
      ${(() => { const by = {}; for (const r of S.resources) { const l = M.verificationLabel(r); by[l] = (by[l] || 0) + 1; }
        return html`<ul class="points">${Object.entries(by).map(([l, n]) => html`<li>${l}: ${n}</li>`)}</ul>`; })()}
      ${S.resMeta.note_he ? html`<p class="hint">${S.resMeta.note_he}</p>` : ''}
      ${S.resMeta.updated ? html`<p class="muted small">עדכון אחרון של המאגר: ${S.resMeta.updated}</p>` : ''}
      ${(() => { const dnr = S.resources.filter(r => r.do_not_refer); return dnr.length ? html`
        <h3>⛔ לא להפנות</h3>${dnr.map(resourceCard)}` : ''; })()}
      ${S.resMeta.sample ? html`<p class="banner warn">כרגע זה מאגר דוגמה בדיוני בלבד. הוא יוחלף ברשימה אמיתית שכל פרט בה מגובה במקור.</p>` : ''}
      ${S.resError ? html`<p class="form-err">לא נטען: ${S.resError}</p>` : ''}
      ${S.resRejected.length ? html`<p class="form-err">נדחו ${S.resRejected.length} רשומות פגומות (${S.resRejected.map(x => x.id || '?').join(', ')}).</p>` : ''}
    </section>

    <section class="card">
      <h2>🧰 ספריית כלים קהילתית</h2>
      <p class="muted">הרעיון המקורי של השבט האנושי (2024): השאלת כלי עבודה בין שכנים. שמור לו מקום — עוד לא פעיל.</p>
    </section>

    <section class="card danger-zone">
      <h2>מחיקת הכל</h2>
      <p class="hint">מוחק מהטלפון את כל האנשים, הצרכים והסוכות. אין דרך לשחזר בלי קובץ גיבוי.</p>
      <button type="button" class="btn danger" data-action="wipe">🗑️ למחוק את כל הנתונים מהטלפון</button>
    </section>
    <p class="muted small center">השבט האנושי · גרסה ${APP_VERSION} · אף אחד לא נשאר בחוץ</p>`;
}

function cardNeeds(p, o) {
  return M.sortNeeds(p.needs.filter(M.isActive).filter(n => o.sensitive || !M.isSensitive(n)));
}
function viewCard(r) {
  const p = person(r.id);
  if (!p) return notFound();
  if (!p.consent?.card) return html`<section class="card"><h1>אין הסכמה לכרטיס</h1>
    <p>הכרטיס נוצר רק אם ${p.name} הסכים לכך.</p>
    <a class="btn" href="#/consent/${encodeURIComponent(p.id)}">לעדכן הסכמה</a> <a class="btn ghost" href="#/p/${encodeURIComponent(p.id)}">חזרה</a></section>`;
  const o = S.cardOpts[p.id] || (S.cardOpts[p.id] = { name: true, wishes: true, notes: false, contact: false, sensitive: false });
  const act = cardNeeds(p, o);
  const hiddenSens = !o.sensitive && p.needs.some(n => M.isActive(n) && M.isSensitive(n));
  const opt = (k, label) => html`<label class="check inline"><input type="checkbox" data-change="cardopt" data-id="${p.id}" data-key="${k}" ${o[k] ? raw('checked') : ''}><span>${label}</span></label>`;
  return html`
    <section class="card no-print">
      <a class="back" href="#/p/${encodeURIComponent(p.id)}">→ חזרה ל${p.name}</a>
      <h2>מה יופיע בכרטיס?</h2>
      <p class="hint">רק מה שמסומן. כדאי להראות לאדם את הכרטיס לפני שמדפיסים או משתפים.</p>
      <div class="opts">${opt('name', 'השם')}${opt('wishes', 'המשאלות')}${opt('notes', 'הערות לצרכים')}${opt('contact', 'איפה למצוא')}${opt('sensitive', 'נושאים רגישים (בריאות, נפש, התמכרות, משפטי)')}</div>
      ${hiddenSens ? html`<p class="hint">🔒 יש נושאים רגישים שלא מופיעים בכרטיס. מוסיפים רק אם האדם ביקש.</p>` : ''}
      <div class="actions">
        <button type="button" class="btn primary" data-action="print">🖨️ הדפסה</button>
        <button type="button" class="btn" data-action="share-card" data-id="${p.id}">📤 שיתוף כטקסט</button>
      </div>
    </section>
    <article class="need-card" id="print-card">
      <header class="nc-head"><img src="icons/logo.svg" alt="" width="44" height="44"><span>השבט האנושי</span></header>
      <h1>מה צריך עכשיו</h1>
      ${o.name ? html`<p class="nc-name">${p.name}</p>` : ''}
      ${o.wishes && p.wishes.trim() ? html`<section><h2>משאלות</h2><p class="pre">${p.wishes}</p></section>` : ''}
      <section><h2>מה חסר עכשיו</h2>
        ${act.length ? html`<ul class="nc-needs">${act.map(n => html`<li><span aria-hidden="true">${M.CAT[n.category].icon}</span> <b>${M.CAT[n.category].he}</b>${n.urgency === 'urgent' ? html` <span class="badge hot">דחוף</span>` : ''}${o.notes && n.notes.trim() ? html`<div class="nc-note">${n.notes}</div>` : ''}</li>`)}</ul>`
          : html`<p>כרגע אין צרכים פתוחים.</p>`}
      </section>
      ${o.contact && p.contactNote.trim() ? html`<section><h2>איפה למצוא</h2><p>${p.contactNote}</p></section>` : ''}
      <footer>הכרטיס נוצר בהסכמה · ${fmtDate(Date.now(), { dateStyle: 'long' })}<br>אפשר לבקש למחוק אותו בכל רגע.</footer>
    </article>`;
}

function cardText(p) {
  const o = S.cardOpts[p.id] || { name: true, wishes: true, notes: false, contact: false, sensitive: false };
  const act = cardNeeds(p, o);
  const lines = ['מה צריך עכשיו — השבט האנושי'];
  if (o.name) lines.push(p.name);
  if (o.wishes && p.wishes.trim()) lines.push('', 'משאלות:', p.wishes.trim());
  lines.push('', 'מה חסר עכשיו:');
  for (const n of act) lines.push(`• ${M.CAT[n.category].he}${n.urgency === 'urgent' ? ' (דחוף)' : ''}${o.notes && n.notes.trim() ? ` — ${n.notes.trim()}` : ''}`);
  if (!act.length) lines.push('כרגע אין צרכים פתוחים.');
  if (o.contact && p.contactNote.trim()) lines.push('', `איפה למצוא: ${p.contactNote.trim()}`);
  lines.push('', 'נוצר בהסכמה.');
  return lines.join('\n');
}

function notFound() {
  return html`<section class="card"><h1>לא נמצא</h1><p>אולי נמחק.</p><a class="btn" href="#/">לרשימה</a></section>`;
}

// ---------------- actions ----------------
async function addNeed(pid, cat) {
  const p = person(pid);
  if (!p) return;
  const existing = p.needs.find(n => n.category === cat && M.isActive(n));
  if (existing) { flash(existing.id, true); toast(`${M.CAT[cat].he} כבר ברשימה — הנה הוא`); return; }
  const n = M.makeNeed(cat);
  p.needs.push(n);
  touch(p);
  await savePerson(p);
  render({ keepScroll: true });
  flash(n.id); // no scroll: people tap several categories in a row
  toast(`${M.CAT[cat].icon} נוסף: ${M.CAT[cat].he}`);
}
function flash(needId, scroll = false) {
  const el = document.getElementById(`need-${needId}`);
  if (!el) return;
  if (scroll) el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

async function deletePerson(pid) {
  const p = person(pid);
  if (!p) return;
  if (!(await ask(`למחוק את ${p.name} ואת כל המידע? אי אפשר לבטל.`, { ok: 'למחוק', danger: true }))) return;
  if (S.mic?.personId === pid) { SP.stopDictation(); S.mic = null; }
  for (const k of [...pending.keys()]) if (k.includes(pid)) { clearTimeout(pending.get(k).t); pending.delete(k); }
  dirty.people.delete(pid); journalDirty(); scrubJournal('people', pid);
  for (const s of S.shelters) if (s.occupants.includes(pid)) { s.occupants = s.occupants.filter(id => id !== pid); touch(s); await saveShelter(s); }
  await db.del('people', pid);
  S.people = S.people.filter(x => x.id !== pid);
  delete S.cardOpts[pid];
  toast('נמחק מהטלפון');
  go('#/');
}

async function toggleMic(pid, field) {
  if (S.mic) {
    const same = S.mic.personId === pid && S.mic.field === field;
    SP.stopDictation(); S.mic = null; S.interim = '';
    render({ keepScroll: true });
    if (same) return;
  }
  // Cloud transcription sends this person's voice to the browser vendor: only with their own consent.
  if (S.sttMode !== 'local' && !person(pid)?.consent?.cloudVoice) {
    toast('אין הסכמה לתמלול דרך שרת — אפשר להקליד, או לעדכן את ההסכמה', 4200);
    return;
  }
  S.mic = { personId: pid, field };
  S.interim = '';
  try {
    SP.startDictation({
      local: S.sttMode === 'local',
      onFinal: txt => appendDictation(pid, field, txt),
      onInterim: t => { S.interim = t; const el = document.querySelector(`[data-interim="${pid}:${field}"]`); if (el) el.textContent = t; },
      onEnd: () => { if (S.mic) { S.mic = null; S.interim = ''; render({ keepScroll: true }); } },
      onError: err => toast(micError(err)),
    });
  } catch (e) {
    console.error(e); S.mic = null; toast('לא הצלחנו להפעיל הקלטה. אפשר להקליד.');
  }
  render({ keepScroll: true });
}
function micError(err) {
  return ({
    'not-allowed': 'אין הרשאה למיקרופון. אפשר לאשר בהגדרות הדפדפן, או להקליד.',
    'service-not-allowed': 'הדפדפן לא מאפשר תמלול כאן. אפשר להקליד.',
    'no-speech': 'לא נשמע דיבור. אפשר לנסות שוב.',
    'audio-capture': 'לא נמצא מיקרופון.',
    'network': 'אין חיבור לשירות התמלול. אפשר להקליד.',
    'language-not-supported': 'עברית לא נתמכת בתמלול בדפדפן הזה. אפשר להקליד.',
    'aborted': 'ההקלטה נעצרה.',
  })[err] || `שגיאת הקלטה (${err}). אפשר להקליד.`;
}
function appendDictation(pid, field, txt) {
  const p = person(pid);
  if (!p || !txt) return;
  p[field] = p[field] ? `${p[field].replace(/\s+$/, '')} ${txt}` : txt;
  touch(p);
  schedule(`p:${pid}`, () => savePerson(p));
  const ta = document.getElementById(`f-${field}-${pid}`);
  if (ta) { ta.value = p[field]; checkSens(ta); }
  refreshSuggestions(p);
}
function refreshSuggestions(p) {
  const el = document.getElementById(`sugg-${p.id}`);
  if (el) el.innerHTML = String(suggestionsHTML(p));
}
function checkSens(el) {
  const w = document.querySelector(`[data-sens-for="${el.id}"]`);
  if (w) w.hidden = M.findSensitiveNumbers(el.value).length === 0;
}

async function readConsent(btn) {
  if (SP.isSpeaking()) { SP.stopSpeaking(); btn.setAttribute('aria-pressed', 'false'); btn.textContent = '🔊 להקריא בקול את כל ההסבר'; return; }
  const v = await SP.hebrewVoice();
  if (!v) { toast('אין קול עברי מותקן בטלפון — אפשר להקריא בעצמך בקול רם.'); return; }
  const r = route();
  const name = r.id ? person(r.id)?.name : S.draft?.name;
  const paras = consentParas(name).map(x => `${x.h}. ${x.p}`).concat(CONSENT_CHOICES.map(c => c.spoken));
  const full = document.getElementById('consent-full'); if (full) full.open = true;
  btn.setAttribute('aria-pressed', 'true');
  btn.textContent = '⏹ לעצור הקראה';
  await SP.speak(paras, { onEnd: () => { btn.setAttribute('aria-pressed', 'false'); btn.textContent = '🔊 להקריא בקול את כל ההסבר'; } });
}

function formErr(form, msg) {
  const el = form.querySelector('[data-err]');
  if (!el) return toast(msg);
  el.textContent = msg;
  el.hidden = !msg;
  if (msg) el.scrollIntoView({ block: 'center' });
}

async function submitConsent(form) {
  const f = new FormData(form);
  const store = f.get('store') === 'on';
  const by = f.get('by');
  const pid = form.dataset.id;
  if (!store) {
    if (pid) {
      const p = person(pid);
      if (await ask(`בלי הסכמה לשמירה, נמחק את ${p.name} ואת כל המידע מהטלפון. למחוק?`, { ok: 'למחוק', danger: true })) {
        dirty.people.delete(pid); journalDirty(); scrubJournal('people', pid);
        await db.del('people', pid);
        for (const s of S.shelters) if (s.occupants.includes(pid)) { s.occupants = s.occupants.filter(id => id !== pid); touch(s); await saveShelter(s); }
        S.people = S.people.filter(x => x.id !== pid);
        toast('נמחק מהטלפון');
        go('#/');
      }
      return;
    }
    return formErr(form, 'בלי הסכמה לשמירה לא שומרים כלום. אפשר ללחוץ "לא עכשיו".');
  }
  if (!by) return formErr(form, 'צריך לסמן מי מאשר.');
  const consent = { store: true, shareWithOrgs: f.get('shareWithOrgs') === 'on', card: f.get('card') === 'on',
    cloudVoice: f.get('cloudVoice') === 'on', publicStory: f.get('publicStory') === 'on', by };
  SP.stopSpeaking();
  if (pid) {
    const p = person(pid);
    p.consent = { ...consent, version: M.CONSENT_VERSION, at: Date.now() };
    touch(p);
    await savePerson(p);
    toast('ההסכמה עודכנה');
    go(`#/p/${encodeURIComponent(pid)}`);
  } else {
    const p = M.makePerson(S.draft.name, consent);
    S.people.push(p);
    S.draft = null;
    await savePerson(p);
    requestPersist();
    toast(`נשמר: ${p.name} — רק בטלפון הזה`, 1500);
    go(`#/p/${encodeURIComponent(p.id)}`);
  }
}

// Ask the browser not to evict our storage. Silent, once per device, after the first real record.
async function requestPersist() {
  try {
    if (!navigator.storage?.persist || (await db.getMeta('persistAsked', false))) return;
    const ok = await navigator.storage.persist();
    await db.setMeta('persistAsked', true);
    await db.setMeta('persisted', ok);
  } catch { /* not supported */ }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Every export is encrypted: it always holds personal data. A hand-over (scope 'consented') names its
// recipient, is confirmed for that recipient, carries only name + non-sensitive needs, and is logged
// on each person (disclosures[]: to whom, when, which fields — DESIGN §11.1 "יומן גילוי").
async function prepareExport(form) {
  const f = new FormData(form);
  const scope = f.get('scope') === 'consented' ? 'consented' : 'all';
  const pass = String(f.get('pass') || ''), pass2 = String(f.get('pass2') || '');
  const recipient = String(f.get('recipient') || '').trim();
  if (!pass) throw new Error('כל ייצוא חייב סיסמה — הקובץ מכיל מידע אישי.');
  if (pass.length < 8) throw new Error('סיסמה של 8 תווים לפחות.');
  if (pass !== pass2) throw new Error('הסיסמאות לא זהות.');
  if (scope === 'consented' && !recipient) throw new Error('צריך לכתוב למי מוסרים את הקובץ.');
  const data = M.buildExport(S.people, S.shelters, scope, new Date(), { recipient });
  if (!data.people.length && !data.shelters.length) throw new Error(scope === 'consented' ? 'אין אנשים שהסכימו לשיתוף (בנוסח ההסכמה הנוכחי).' : 'אין מה לייצא.');
  if (scope === 'consented') {
    const names = data.people.map(x => x.name).join(', ');
    if (!(await ask(`למסור ל"${recipient}" את הצרכים (בלי נושאים רגישים) של: ${names}? רק אם כל אחד מהם אישר עכשיו את הגורם הזה.`, { ok: 'כן, כולם אישרו', cancel: 'ביטול' }))) return null;
    const at = Date.now(), fields = ['name', ...M.SHARE_NEED_FIELDS.map(k => `needs.${k}`)];
    for (const x of data.people) {
      const pp = person(x.id); if (!pp) continue;
      pp.disclosures = [...(pp.disclosures || []), { to: recipient, at, fields }];
      touch(pp); await savePerson(pp);
    }
  }
  const out = await encryptJSON(data, pass);
  const name = `human-tribe-${scope === 'all' ? 'backup' : 'share'}-${M.dayKey()}-encrypted.json`;
  const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
  return { blob, name, scope, people: data.people.length };
}
async function markBackup(ex) {
  if (ex.scope !== 'all') return;
  S.lastBackup = Date.now();
  await db.setMeta('lastBackup', S.lastBackup);
}

async function doImport(form) {
  const f = form.querySelector('input[type=file]').files[0];
  if (!f) throw new Error('צריך לבחור קובץ.');
  let obj;
  try { obj = JSON.parse(await f.text()); } catch { throw new Error('זה לא קובץ JSON תקין.'); }
  if (obj && obj.encrypted) {
    const pass = form.querySelector('input[name=pass]').value;
    if (!pass) throw new Error('הקובץ מוצפן — צריך סיסמה.');
    obj = await decryptJSON(obj, pass);
  }
  const err = M.validateImport(obj);
  if (err) throw new Error(err);
  const incoming = obj.people.map(M.normalizePerson);
  const mode = new FormData(form).get('mode');
  if (mode === 'replace') {
    if (S.people.length && !(await ask(`בטלפון יש ${S.people.length} אנשים. ההחלפה תמחק אותם ותשים במקומם את ${incoming.length} האנשים מהקובץ${obj.partial ? ' (קובץ מסירה חלקי: בלי סיפורים ובלי סוכות)' : ''}. כדאי קודם לשמור גיבוי מלא. להחליף בכל זאת?`, { ok: 'להחליף', cancel: 'קודם גיבוי', danger: true }))) return null;
    for (const [k, v] of pending) { clearTimeout(v.t); pending.delete(k); }
    await db.replaceAll(incoming, obj.shelters);
    dirty.people.clear(); dirty.shelters.clear(); journaled = true; journalDirty();
  } else {
    const mp = M.mergeRecords(S.people, incoming);
    const ms = M.mergeRecords(S.shelters, obj.shelters);
    await db.putMany('people', mp.write);
    await db.putMany('shelters', ms.write);
  }
  [S.people, S.shelters] = await Promise.all([db.getAll('people'), db.getAll('shelters')]);
  S.people = S.people.map(M.normalizePerson);
  return { people: incoming.length, shelters: obj.shelters.length, mode };
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* noop */ }
    ta.remove(); return ok;
  }
}

// ---------------- events ----------------
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action, id = el.dataset.id;
  try {
    switch (a) {
      case 'add-need': return addNeed(id, el.dataset.cat);
      case 'need-status': case 'need-urgency': {
        const p = person(id), n = p?.needs.find(x => x.id === el.dataset.need);
        if (!n) return;
        if (a === 'need-status') { n.status = el.dataset.val; if (n.status === 'resolved') n.resolvedAt = Date.now(); }
        else n.urgency = el.dataset.val;
        n.updatedAt = Date.now(); touch(p);
        await savePerson(p);
        return render({ keepScroll: true });
      }
      case 'need-del': {
        const p = person(id), n = p?.needs.find(x => x.id === el.dataset.need);
        if (!n || !(await ask(`להסיר את הצורך "${M.CAT[n.category].he}"?`, { ok: 'להסיר', danger: true }))) return;
        p.needs = p.needs.filter(x => x.id !== n.id); touch(p);
        await savePerson(p);
        return render({ keepScroll: true });
      }
      case 'mic': return toggleMic(id, el.dataset.field);
      case 'mask': {
        const t = document.getElementById(el.dataset.target);
        if (t) { t.value = M.maskSensitiveNumbers(t.value); t.dispatchEvent(new Event('input', { bubbles: true })); }
        return;
      }
      case 'person-del': return deletePerson(id);
      case 'read-consent': return readConsent(el);
      case 'consent-decline': {
        SP.stopSpeaking();
        if (id) return go(`#/p/${encodeURIComponent(id)}`);
        S.draft = null; toast('בסדר גמור. לא נשמר כלום.'); return go('#/');
      }
      case 'seed-shelters': {
        const list = Array.from({ length: 10 }, (_, i) => M.makeShelter(`U${i + 1}`, 2));
        await db.putMany('shelters', list);
        S.shelters.push(...list);
        toast('נוצרו 10 יחידות U1–U10 (מתוכננות)');
        return render({ keepScroll: true });
      }
      case 'shelter-del': {
        const s = shelter(id);
        if (!s || !(await ask(`למחוק את ${s.name}?${s.occupants.length ? ' האנשים בה יישארו ברשימה, בלי סוכה.' : ''}`, { ok: 'למחוק', danger: true }))) return;
        dirty.shelters.delete(id); journalDirty(); scrubJournal('shelters', id);
        await db.del('shelters', id);
        S.shelters = S.shelters.filter(x => x.id !== id);
        return render({ keepScroll: true });
      }
      case 'occupant-remove': {
        const s = shelter(id); if (!s) return;
        s.occupants = s.occupants.filter(x => x !== el.dataset.person); touch(s);
        await saveShelter(s);
        return render({ keepScroll: true });
      }
      case 'copy-summary': {
        if (S.summaryNames && !(await ask('הסיכום כולל שמות. להעתיק רק אם כל אחד מהאנשים ששמם מופיע אישר עכשיו את הגורם שיקבל אותו.', { ok: 'כולם אישרו — להעתיק', cancel: 'ביטול' }))) return;
        const ok = await copyText($('#summary').textContent);
        return toast(ok ? 'הסיכום הועתק' : 'לא הצלחנו להעתיק — אפשר לסמן ולהעתיק ידנית');
      }
      case 'print': return window.print();
      case 'share-card': {
        const p = person(id); const text = cardText(p);
        if (navigator.share) { try { await navigator.share({ title: 'מה צריך עכשיו', text }); } catch { /* user cancelled */ } return; }
        return toast((await copyText(text)) ? 'הטקסט הועתק' : 'לא הצלחנו להעתיק');
      }
      case 'share-file': {
        const form = el.closest('form');
        formErr(form, '');
        const ex = await prepareExport(form);
        if (!ex) return;
        const file = new File([ex.blob], ex.name, { type: 'application/json' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], title: ex.name }); await markBackup(ex); } catch { /* cancelled */ }
        } else { downloadBlob(ex.blob, ex.name); await markBackup(ex); toast('השיתוף לא נתמך — הקובץ נשמר במקום'); }
        chrome(route());
        return;
      }
      case 'persist': {
        const ok = await navigator.storage.persist();
        return toast(ok ? 'הדפדפן אישר: הנתונים לא יימחקו אוטומטית' : 'הדפדפן לא אישר — כדאי לייצא גיבוי מדי פעם');
      }
      case 'wipe': {
        if (!(await ask('למחוק את כל הנתונים מהטלפון? אי אפשר לבטל.', { ok: 'כן, למחוק הכל', danger: true }))) return;
        if (!(await ask('בטוח? כל האנשים, הצרכים והסוכות יימחקו.', { ok: 'למחוק סופית', danger: true }))) return;
        SP.stopDictation(); S.mic = null;
        for (const [k, v] of pending) { clearTimeout(v.t); pending.delete(k); }
        dirty.people.clear(); dirty.shelters.clear();
        try { localStorage.removeItem(DIRTY_KEY); } catch { /* blocked */ }
        journaled = false;
        await db.clearAll();
        S.people = []; S.shelters = []; S.cardOpts = {}; S.rounds = {}; S.lastBackup = null;
        toast('כל הנתונים נמחקו מהטלפון');
        return go('#/');
      }
      case 'reload': return location.reload();
      case 'install': {
        const ev = S.installPrompt; if (!ev) return;
        S.installPrompt = null; ev.prompt();
        try { await ev.userChoice; } catch { /* dismissed */ }
        return render({ keepScroll: true });
      }
      case 'install-hide': {
        try { localStorage.setItem('ht-install-hidden', '1'); } catch { /* per-viewer convenience only */ }
        return render({ keepScroll: true });
      }
      case 'renew': {
        const p = person(id); if (!p) return;
        touch(p); await savePerson(p); toast('הקשר חודש');
        return render({ keepScroll: true });
      }
      case 'jump': {
        const t = document.getElementById(el.dataset.target);
        if (t) t.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        return;
      }
      case 'stt-install': {
        toast('מורידים תמלול עברי לטלפון…');
        const ok = await SP.installLocal();
        S.sttMode = await SP.sttMode();
        toast(ok && S.sttMode === 'local' ? 'מעכשיו התמלול נעשה בתוך הטלפון' : 'לא הצלחנו להתקין — אפשר להקליד או להשתמש בתמלול הרגיל');
        return render({ keepScroll: true });
      }
    }
  } catch (err) {
    console.error(err);
    const form = el.closest('form');
    if (form) formErr(form, err.message); else toast(err.message);
  }
});

document.addEventListener('submit', async e => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  formErr(form, '');
  try {
    switch (form.dataset.form) {
      case 'new': {
        const name = form.elements.namedItem('name').value.trim();
        if (!name) return formErr(form, 'צריך שם פרטי או כינוי.');
        if (M.findSensitiveNumbers(name).length || /\d{5,}/.test(name)) return formErr(form, 'בלי מספרים מזהים בשם, בבקשה.');
        // DESIGN §4.1: no consent from someone who looks under 18 or cannot consent right now. Nothing is saved.
        if (!form.elements.namedItem('adult').checked || !form.elements.namedItem('capable').checked) {
          S.draft = null;
          return formErr(form, 'לא ממשיכים עכשיו, ולא נשמר כלום. אפשר לומר: "בוא נדבר על זה מחר. אני כאן." מי שנראה מתחת לגיל 18 — מעבירים לאדם אחראי (עמותת עלם לנוער, 03-7686666).');
        }
        S.draft = { name };
        return go('#/consent');
      }
      case 'consent': return submitConsent(form);
      case 'shelter-add': {
        const name = form.elements.namedItem('name').value.trim() || M.nextUnitName(S.shelters);
        const s = M.makeShelter(name, form.elements.namedItem('capacity').value);
        await saveShelter(s);
        S.shelters.push(s);
        S.openShelters.add(s.id);
        toast(`${s.name} נוספה`);
        return render({ keepScroll: true });
      }
      case 'export': {
        const ex = await prepareExport(form);
        if (!ex) return;
        downloadBlob(ex.blob, ex.name);
        await markBackup(ex);
        chrome(route());
        return toast(`נשמר קובץ מוצפן: ${ex.people} אנשים${ex.scope === 'all' ? ' (גיבוי מלא)' : ' (למסירה)'}`);
      }
      case 'import': {
        const r = await doImport(form);
        if (!r) return;
        toast(`יובאו ${r.people} אנשים ו-${r.shelters} סוכות`);
        return go('#/');
      }
    }
  } catch (err) {
    console.error(err);
    formErr(form, err.message);
  }
});

document.addEventListener('input', e => {
  const el = e.target.closest('[data-bind]');
  if (!el) return;
  const [kind, key] = el.dataset.bind.split('.');
  if (kind === 'q') { S.q = el.value; const l = $('#people-list'); if (l) l.innerHTML = String(peopleList()); return; }
  if (kind === 'person') {
    const p = person(el.dataset.id); if (!p) return;
    if (key === 'name' && !el.value.trim()) return; // reverted on change
    p[key] = key === 'name' ? el.value.trim() : el.value;
    touch(p);
    schedule(`p:${p.id}`, () => savePerson(p));
    if (key === 'story' || key === 'wishes') refreshSuggestions(p);
    if (el.id) checkSens(el);
    return;
  }
  if (kind === 'need') {
    const p = person(el.dataset.id), n = p?.needs.find(x => x.id === el.dataset.need); if (!n) return;
    n[key] = el.value; n.updatedAt = Date.now(); touch(p);
    schedule(`p:${p.id}`, () => savePerson(p));
    if (el.id) checkSens(el);
    return;
  }
  if (kind === 'shelter') {
    const s = shelter(el.dataset.id); if (!s) return;
    if (key === 'name' && !el.value.trim()) return;
    s[key] = key === 'name' ? el.value.trim() : el.value; touch(s);
    schedule(`s:${s.id}`, () => saveShelter(s));
  }
});

document.addEventListener('change', async e => {
  const el = e.target;
  if (el.dataset?.bind && el.dataset.orig != null && !el.value.trim()) { el.value = el.dataset.orig; return; }
  const c = el.dataset?.change;
  if (!c) return;
  const id = el.dataset.id;
  if (c === 'sheet') {
    const s = shelter(id); if (!s) return;
    s.sheets = s.sheets || {};
    const k = M.dayKey();
    if (el.checked) s.sheets[k] = { at: Date.now() }; else delete s.sheets[k];
    touch(s); await saveShelter(s);
    return render({ keepScroll: true });
  }
  if (c === 'occupant-add') {
    const s = shelter(id); const pid = el.value; if (!s || !pid) return;
    for (const o of S.shelters) if (o.occupants.includes(pid)) { o.occupants = o.occupants.filter(x => x !== pid); touch(o); await saveShelter(o); }
    if (s.occupants.length >= s.capacity) { toast('הסוכה מלאה'); return render({ keepScroll: true }); }
    s.occupants.push(pid); touch(s); await saveShelter(s);
    return render({ keepScroll: true });
  }
  if (c === 'person-shelter') {
    const target = el.value ? shelter(el.value) : null;
    for (const o of S.shelters) if (o.occupants.includes(id) && o !== target) { o.occupants = o.occupants.filter(x => x !== id); touch(o); await saveShelter(o); }
    if (target && !target.occupants.includes(id)) {
      if (target.occupants.filter(x => person(x)).length >= target.capacity) { toast('הסוכה מלאה'); return render({ keepScroll: true }); }
      target.occupants.push(id); touch(target); await saveShelter(target);
    }
    toast(target ? `שיבוץ: ${target.name}` : 'בלי סוכה');
    return render({ keepScroll: true });
  }
  if (c === 'shelter-kind' || c === 'shelter-stage') {
    const s = shelter(id); if (!s) return;
    s[c === 'shelter-kind' ? 'kind' : 'stage'] = el.value; touch(s); await saveShelter(s);
    return render({ keepScroll: true });
  }
  if (c === 'round') {
    const k = M.dayKey();
    const day = { ...(S.rounds[k] || {}) };
    if (el.checked) day[el.dataset.key] = Date.now(); else delete day[el.dataset.key];
    // Keep two weeks of rounds only.
    const keep = new Set(M.lastDays(14).map(x => x.key));
    S.rounds = Object.fromEntries(Object.entries({ ...S.rounds, [k]: day }).filter(([d]) => keep.has(d)));
    await db.setMeta('rounds', S.rounds);
    return;
  }
  if (c === 'kit') {
    const p = person(id); if (!p) return;
    p.kit = { ...(p.kit || {}), [el.dataset.key]: el.checked }; touch(p); await savePerson(p);
    return;
  }
  if (c === 'summary-names') {
    S.summaryNames = el.checked;
    $('#summary').textContent = M.summaryText(S.people, { includeNames: S.summaryNames });
    return;
  }
  if (c === 'cardopt') {
    S.cardOpts[id][el.dataset.key] = el.checked;
    return render({ keepScroll: true });
  }
});

document.addEventListener('toggle', e => {
  const d = e.target;
  if (!d.matches) return;
  if (d.matches('details.match')) { if (d.open) S.openMatch.add(d.dataset.need); else S.openMatch.delete(d.dataset.need); }
  if (d.matches('details.shelter')) { if (d.open) S.openShelters.add(d.dataset.shelter); else S.openShelters.delete(d.dataset.shelter); }
}, true);

window.addEventListener('hashchange', () => {
  if (S.mic) { SP.stopDictation(); S.mic = null; S.interim = ''; }
  SP.stopSpeaking();
  render();
  view.focus({ preventScroll: true });
});
window.addEventListener('online', () => { S.online = true; chrome(route()); });
window.addEventListener('offline', () => { S.online = false; chrome(route()); });
// Last chance before the tab goes away: start the IDB writes AND journal the uncommitted records
// synchronously (localStorage), so nothing typed in the last moment is lost.
function lastChance() { flushAll(); journalDirty(); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') lastChance(); });
window.addEventListener('pagehide', lastChance);
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installPrompt = e; if (route().name === 'home' && !isTyping()) render({ keepScroll: true }); });

// ---------------- boot ----------------
async function loadResources() {
  try {
    const res = await fetch('data/resources.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { resources, rejected, meta } = M.normalizeResources(await res.json());
    S.resources = resources; S.resRejected = rejected; S.resMeta = meta; S.resError = null;
    if (rejected.length) console.warn('resources rejected', rejected);
  } catch (e) {
    console.warn('resources', e);
    S.resError = e.message;
  } finally {
    S.resLoading = false;
  }
}
// After resources arrive: re-render, unless someone is typing (that would close the keyboard) —
// then only the "who can help" panels are refreshed in place.
function afterResources() {
  if (!isTyping()) return render({ keepScroll: true });
  for (const d of $$('details.match[data-match-cat]', view)) d.innerHTML = String(matchInner(d.dataset.matchCat));
}

function registerSW() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) { S.swUpdate = true; chrome(route()); }
      });
    });
  }).catch(e => console.warn('sw', e));
}

async function storageEstimate() {
  try {
    const el = $('#storage-est');
    if (!el || !navigator.storage?.estimate) return;
    const { usage } = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
    el.textContent = `בשימוש: ${(usage / 1024).toFixed(0)}KB${persisted ? ' · מוגן ממחיקה אוטומטית' : ''}`;
  } catch { /* noop */ }
}
new MutationObserver(() => { if ($('#storage-est')) storageEstimate(); }).observe(view, { childList: true });

async function boot() {
  await db.open();
  await recoverDirty();
  [S.people, S.shelters] = await Promise.all([db.getAll('people'), db.getAll('shelters')]);
  S.people = S.people.map(M.normalizePerson);
  S.rounds = (await db.getMeta('rounds', {})) || {};
  S.lastBackup = await db.getMeta('lastBackup', null);
  // First paint never waits on the network (weak street reception can hang a fetch for 30 s+).
  render();
  registerSW();
  // Until the browser answers, sttMode stays 'none' = treated like cloud (needs the person's consent).
  SP.sttMode().then(m => {
    const changed = m !== S.sttMode; S.sttMode = m;
    if (changed && route().name === 'p' && !isTyping()) render({ keepScroll: true });
  }).catch(() => {});
  loadResources().then(afterResources);
  // Test/diagnostic hook (no data leaves the page): lets automated checks read app state.
  window.__ht = { S, M, db, version: APP_VERSION, prepareExport, decryptJSON, encryptJSON };
}
boot();
