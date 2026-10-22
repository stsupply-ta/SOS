// api/_initFirebase.js
// Helper inisialisasi Firebase Admin SDK.
// Berkas ini BUKAN route (diawali "_") - hanya dipakai oleh api/sync.js & api/data.js.
//
// CATATAN: file ini sengaja ditulis TANPA karakter backslash di dalam string
// literal (memakai String.fromCharCode) - supaya tidak pernah salah saat file
// diedit atau ditransfer antar sistem.
const admin = require('firebase-admin');

const BS = String.fromCharCode(92);   // backslash
const NL = String.fromCharCode(10);   // newline

const REQUIRED_ENV = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_DB_URL',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_KEY'
];

/* ------------------------------------------------------------------
   Normalisasi private key service account.
   Menangani berbagai cara orang menempelkan key ke Vercel:
   - dibungkus tanda kutip  "-----BEGIN ... -----"
   - newline ditulis literal sebagai  \n  atau  \r\n
   - newline asli (sudah ter-escape berkali-kali)
   - body PEM terlanjur diratakan jadi satu baris panjang
   - hanya isi base64-nya saja (header/footer BEGIN/END hilang)
   ------------------------------------------------------------------ */
function normalizePrivateKey(raw) {
  let key = String(raw || '').trim();

  // 1. buang tanda kutip pembungkus
  key = key.replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim();

  // 2. ubah escape literal (\r\n, \n, \r) menjadi newline asli (berulang)
  for (let i = 0; i < 4; i++) {
    const before = key;
    key = key.split(BS + 'r' + BS + 'n').join(NL)
             .split(BS + 'n').join(NL)
             .split(BS + 'r').join(NL);
    if (key === before) break;
  }

  // 3. rapikan tiap baris & buang baris kosong
  key = key.split(NL).map(l => l.trim()).filter(l => l.length > 0).join(NL);

  // 4. body PEM menyatu jadi satu baris -> bungkus ulang ke 64 karakter
  const m = key.match(/-----BEGIN ([A-Z0-9 ]+)-----([^]*?)-----END ([A-Z0-9 ]+)-----/);
  if (m) {
    const type = (m[1] || m[3] || 'PRIVATE KEY').trim();
    const body = m[2].replace(/[^A-Za-z0-9+/=]/g, '');
    const wrapped = (body.match(/.{1,64}/g) || []).join(NL);
    return ['-----BEGIN ' + type + '-----', wrapped, '-----END ' + type + '-----'].join(NL);
  }

  // 5. TIDAK ada header/footer -> kemungkinan hanya body base64-nya.
  //    Bungkus ulang menjadi PEM PRIVATE KEY yang valid.
  const bare = key.replace(/[^A-Za-z0-9+/=]/g, '');
  if (bare.length > 200) {
    const padded = bare + '='.repeat((4 - (bare.length % 4)) % 4);
    const wrapped = (padded.match(/.{1,64}/g) || []).join(NL);
    return ['-----BEGIN PRIVATE KEY-----', wrapped, '-----END PRIVATE KEY-----'].join(NL);
  }

  return key;
}

/* Validasi key secara lokal agar pesan error lebih jelas & cepat */
function validatePrivateKey(pem) {
  const crypto = require('crypto');
  const candidates = [pem, pem.replace(/PRIVATE KEY/g, 'RSA PRIVATE KEY')];
  let lastErr = null;
  for (const c of candidates) {
    try {
      crypto.createPrivateKey(c);
      return { ok: true, key: c };
    } catch (e) {
      lastErr = e;
    }
  }
  return { ok: false, error: lastErr };
}

/* Ringkasan bentuk key (tanpa membocorkan isi rahasia) untuk diagnostik */
function describeKey(raw) {
  const s = String(raw || '');
  const other = {};
  let dashes = 0;
  const isSpace = c => {
    const n = c.charCodeAt(0);
    return n === 9 || n === 10 || n === 13 || n === 32;
  };
  for (const ch of s) {
    if (ch === '-') { dashes++; continue; }
    const n = ch.charCodeAt(0);
    const alnum = (n >= 65 && n <= 90) || (n >= 97 && n <= 122) || (n >= 48 && n <= 57);
    if (alnum || ch === '+' || ch === '/' || ch === '=' || ch === '_' || isSpace(ch)) continue;
    other[ch] = (other[ch] || 0) + 1;
  }
  return {
    length: s.length,
    hasBegin: /-----BEGIN [A-Z0-9 ]+-----/.test(s),
    hasEnd: /-----END [A-Z0-9 ]+-----/.test(s),
    realNewlines: s.split(NL).length - 1,
    escapedNewlines: s.split(BS + 'n').length - 1,
    looksLikeJson: s.trim().startsWith('{'),
    dashCount: dashes,
    otherChars: Object.keys(other)
      .map(c => 'U+' + c.charCodeAt(0).toString(16).toUpperCase() + 'x' + other[c]).join(','),
    firstCodes: s.slice(0, 8).split('').map(c => c.charCodeAt(0)).join(',')
  };
}

/* Kumpulkan kredensial dari environment, tolerant terhadap format varied */
function resolveCredentials() {
  const rawKey = process.env.FIREBASE_KEY || '';
  let projectId = process.env.FIREBASE_PROJECT_ID || '';
  let clientEmail = process.env.FIREBASE_CLIENT_EMAIL || '';
  let databaseURL = process.env.FIREBASE_DB_URL || process.env.FIREBASE_DATABASE_URL || '';
  let privateKey = rawKey;

  // Kalau FIREBASE_KEY berisi JSON service account, ambil field di dalamnya
  if (rawKey.trim().startsWith('{')) {
    try {
      const sa = JSON.parse(rawKey);
      if (sa.private_key) privateKey = sa.private_key;
      if (!projectId && sa.project_id) projectId = sa.project_id;
      if (!clientEmail && sa.client_email) clientEmail = sa.client_email;
      if (!databaseURL && sa.database_url) databaseURL = sa.database_url;
    } catch (e) {
      // bukan JSON -> lanjut ke normalisasi biasa
    }
  }

  // Turunkan database URL bila env var-nya kosong
  if (!databaseURL && projectId) {
    databaseURL = 'https://' + projectId + '-default-rtdb.firebaseio.com';
  }

  return {
    projectId: projectId,
    clientEmail: clientEmail,
    privateKey: normalizePrivateKey(privateKey),
    databaseURL: databaseURL
  };
}

let initError = null;

/* Inisialisasi (sekali saja) & kembalikan instance admin */
function getAdmin() {
  if (admin.apps.length) return admin;
  if (initError) throw initError;

  const creds = resolveCredentials();
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);

  if (!creds.projectId || !creds.clientEmail || !creds.privateKey) {
    initError = new Error(
      'Environment variable Firebase belum lengkap: ' +
      (missing.length ? missing.join(', ') : 'nilai tidak terbaca') +
      '. Set di Vercel Dashboard -> Settings -> Environment Variables (Environment: Production).'
    );
    throw initError;
  }

  // Validasi private key lebih dulu supaya pesan error lebih informatif
  const check = validatePrivateKey(creds.privateKey);
  if (!check.ok) {
    const d0 = describeKey(process.env.FIREBASE_KEY || '');
    initError = new Error(
      'FIREBASE_KEY bukan private key yang valid: ' + (check.error && check.error.message) +
      ' | diagnosa nilai mentah -> panjang=' + d0.length +
      ', adaBEGIN=' + d0.hasBegin + ', adaEND=' + d0.hasEnd +
      ', newline asli=' + d0.realNewlines + ', escape=' + d0.escapedNewlines +
      ', formatJSON=' + d0.looksLikeJson +
      ', jumlahTandaHubung=' + d0.dashCount + ', karakterLain=' + d0.otherChars +
      ', kode8Awal=' + d0.firstCodes +
      '. Salin ulang private key dari file JSON service account (field "private_key") ' +
      'lengkap dengan header -----BEGIN PRIVATE KEY----- dan -----END PRIVATE KEY-----.'
    );
    throw initError;
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: creds.projectId,
        clientEmail: creds.clientEmail,
        privateKey: check.key
      }),
      databaseURL: creds.databaseURL
    });
  } catch (e) {
    const d = describeKey(creds.privateKey);
    initError = new Error(
      'FIREBASE_KEY ditolak oleh Firebase: ' + e.message +
      ' | diagnosa private key -> panjang=' + d.length +
      ', adaBEGIN=' + d.hasBegin + ', adaEND=' + d.hasEnd +
      ', newline asli=' + d.realNewlines + ', escape=' + d.escapedNewlines +
      '. Pastikan private key service account disalin LENGKAP dari "-----BEGIN PRIVATE KEY-----" ' +
      'sampai "-----END PRIVATE KEY-----" dan newline ditulis sebagai ' + BS + 'n.'
    );
    throw initError;
  }

  return admin;
}

module.exports = { getAdmin, normalizePrivateKey, describeKey, resolveCredentials, validatePrivateKey };

