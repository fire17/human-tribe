// Voice in (dictation) and voice out (read consent aloud). Both optional; text always works.
//
// PRIVACY NOTE: in most browsers SpeechRecognition is cloud-based (audio goes to the browser
// vendor). Newer Chromium exposes on-device recognition (processLocally). We use on-device when
// the browser says it is available, otherwise the UI asks for an explicit acknowledgment first.

const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;

export const support = {
  stt: !!SR,
  tts: typeof globalThis.speechSynthesis !== 'undefined' && typeof globalThis.SpeechSynthesisUtterance !== 'undefined',
};

// Spec (W3C Web Speech API draft): static available({langs, processLocally}) ->
// "unavailable" | "downloadable" | "downloading" | "available"; static install(options) -> boolean.
export const local = { status: 'unknown' };

// 'local' | 'cloud' | 'none'
export async function sttMode(lang = 'he-IL') {
  if (!SR) return 'none';
  try {
    if (typeof SR.available === 'function') {
      const st = await SR.available({ langs: [lang], processLocally: true });
      local.status = st;
      if (st === 'available') return 'local';
    } else if (typeof SR.availableOnDevice === 'function') {
      const st = await SR.availableOnDevice(lang);
      if (st === 'available' || st === true) return 'local';
    }
  } catch { /* fall through */ }
  return 'cloud';
}

// Ask the browser to download its on-device Hebrew model (user-initiated; the download is the
// browser's own, not this app's). Returns true when on-device recognition is ready.
export async function installLocal(lang = 'he-IL') {
  if (!SR || typeof SR.install !== 'function') return false;
  try { return !!(await SR.install({ langs: [lang], processLocally: true })); } catch { return false; }
}

let active = null;

export function isListening() { return !!active; }

export function startDictation({ lang = 'he-IL', local = false, onFinal, onInterim, onEnd, onError }) {
  if (!SR) throw new Error('no SpeechRecognition');
  stopDictation();
  const rec = new SR();
  rec.lang = lang;
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  if (local) { try { rec.processLocally = true; } catch { /* older engine */ } }
  rec.onresult = ev => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) onFinal && onFinal(r[0].transcript.trim());
      else interim += r[0].transcript;
    }
    onInterim && onInterim(interim);
  };
  rec.onerror = ev => { onError && onError(ev.error || 'error'); };
  rec.onend = () => { if (active === rec) active = null; onEnd && onEnd(); };
  active = rec;
  rec.start();
  return rec;
}

export function stopDictation() {
  if (active) { const r = active; active = null; try { r.stop(); } catch { /* already stopped */ } }
}

// ---------- read aloud ----------
let voicesReady = null;
function voices() {
  if (!support.tts) return Promise.resolve([]);
  if (voicesReady) return voicesReady;
  voicesReady = new Promise(resolve => {
    const v = speechSynthesis.getVoices();
    if (v.length) return resolve(v);
    const t = setTimeout(() => resolve(speechSynthesis.getVoices()), 1500);
    speechSynthesis.addEventListener('voiceschanged', () => { clearTimeout(t); resolve(speechSynthesis.getVoices()); }, { once: true });
  });
  return voicesReady;
}

export async function hebrewVoice() {
  const v = await voices();
  const he = v.filter(x => /^(he|iw)\b/i.test(x.lang || ''));
  return he.find(x => x.localService) || he[0] || null;
}

let speaking = false;
export function isSpeaking() { return speaking; }

// Speaks paragraph by paragraph (long single utterances get cut off in some engines).
export async function speak(paragraphs, { onEnd } = {}) {
  if (!support.tts) throw new Error('no speechSynthesis');
  stopSpeaking();
  const voice = await hebrewVoice();
  const parts = paragraphs.map(p => String(p).trim()).filter(Boolean);
  speaking = true;
  let i = 0;
  const next = () => {
    if (!speaking || i >= parts.length) { speaking = false; onEnd && onEnd(); return; }
    const u = new SpeechSynthesisUtterance(parts[i++]);
    u.lang = 'he-IL';
    if (voice) u.voice = voice;
    u.rate = 0.92;
    u.onend = next;
    u.onerror = () => { speaking = false; onEnd && onEnd(); };
    speechSynthesis.speak(u);
  };
  next();
  return { voice: voice ? voice.name : null };
}

export function stopSpeaking() {
  speaking = false;
  if (support.tts) try { speechSynthesis.cancel(); } catch { /* noop */ }
}
