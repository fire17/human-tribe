// Optional passphrase encryption for export files. WebCrypto only, no libraries.
// PBKDF2-SHA256 (600k iterations, per OWASP Password Storage Cheat Sheet) -> AES-GCM 256.

const ITERATIONS = 600000;
const te = new TextEncoder();
const td = new TextDecoder();

function subtle() {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw new Error('הצפנה זמינה רק בחיבור מאובטח (https או localhost)');
  return s;
}

export function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt, iterations) {
  const base = await subtle().importKey('raw', te.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJSON(obj, passphrase, { app = 'human-tribe', format = 1, iterations = ITERATIONS } = {}) {
  if (!passphrase) throw new Error('חסרה סיסמה');
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj))));
  return {
    app, format, encrypted: true,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64encode(salt) },
    cipher: { name: 'AES-GCM', iv: b64encode(iv) },
    data: b64encode(ct),
  };
}

export async function decryptJSON(env, passphrase) {
  if (!env || !env.encrypted) throw new Error('הקובץ לא מוצפן');
  if (env.kdf?.name !== 'PBKDF2' || env.cipher?.name !== 'AES-GCM') throw new Error('שיטת הצפנה לא מוכרת');
  const key = await deriveKey(passphrase, b64decode(env.kdf.salt), env.kdf.iterations);
  let pt;
  try {
    pt = await subtle().decrypt({ name: 'AES-GCM', iv: b64decode(env.cipher.iv) }, key, b64decode(env.data));
  } catch {
    throw new Error('סיסמה שגויה או קובץ פגום');
  }
  return JSON.parse(td.decode(pt));
}
