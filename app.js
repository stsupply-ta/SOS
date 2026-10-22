/* --------------------------------------------------------------
   app.js — Lapisan Sinkronisasi Multi-Perangkat (ST-SOS)
   --------------------------------------------------------------
   Dimuat SETELAH script inline di index.html
   (<script src="app.js"></script> di baris terakhir <body>).

   TUJUAN
   - Tarik data terbaru dari server (Vercel API → Firebase RTDB),
     terapkan ke UI + localStorage.
   - Kirim perubahan ke server setiap kali data disimpan.
   - Sinkron otomatis antar perangkat (polling + saat tab aktif).

   CATATAN PENTING
   - index.html SUDAH mendefinisikan `save()` yang menulis ke key
     localStorage `sos_data_v3` (const KEY). Berkas ini TIDAK boleh
     mendefinisikan ulang `save()` — itulah penyebab utama data
     antar perangkat tidak sinkron.
   - `APP` dan `KEY` adalah binding global dari index.html
     (`let APP` / `const KEY` pada script klasik) sehingga bisa
     diakses langsung dari sini.
   -------------------------------------------------------------- */

/* ==== 1. KONFIGURASI ================================================ */
const API_BASE = '/api';                 // relatif ke root domain
const SYNC_POLL_MS = 15000;              // interval polling otomatis (15 detik)
const PUSH_DEBOUNCE_MS = 1200;           // gabung beberapa simpan beruntun jadi 1 push
const SYNC_CONFIG_KEY = 'sos_sync_url';  // URL endpoint custom (opsional)
const SYNC_TIME_KEY = 'sos_last_sync';   // penanda waktu sinkron terakhir

let syncTimer = null;      // handle interval polling
let pushTimer = null;      // handle debounce push
let pullRunning = false;   // cegah request pull bertumpuk
let pullAgain = false;     // antrean pull ulang
let syncState = 'idle';    // idle | syncing | ok | error | offline
let lastSyncAt = null;     // Date sinkron terakhir

/* ==== 2. UTILITAS =================================================== */

/* Key localStorage yang dipakai index.html (fallback bila index.html gagal dimuat) */
function storageKey() {
  return (typeof KEY !== 'undefined' && KEY) ? KEY : 'sos_data_v3';
}

/* Ubah timestamp ISO → epoch ms (0 bila tidak valid) */
function ts(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

/* Simpan APP ke localStorage (offline-first) */
function persistLocal() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(APP));
  } catch (e) {
    console.warn('⚠️ Gagal menyimpan ke localStorage', e);
  }
}

/* Tampilkan notifikasi kecil (fallback bila toast() tidak ada) */
function syncToast(msg, type) {
  if (typeof toast === 'function') { toast(msg, type || 'ok'); return; }
  console.log('[' + (type || 'ok') + '] ' + msg);
}

/* ==== 3. ENDPOINT =================================================== */

/* Tentukan endpoint push/pull sesuai lingkungan:
   - Custom URL  → dipakai apa adanya (Google Apps Script / server lain)
   - Server lokal (server.js port 3000) → hanya tersedia /api/data (GET+POST)
   - Vercel      → pull /api/data (Firebase), push /api/sync (Firebase) */
function syncEndpoints() {
  const custom = (localStorage.getItem(SYNC_CONFIG_KEY) || '').trim();
  if (custom) {
    const base = custom.replace(/\/+$/, '');
    return { pull: base, push: base, mode: 'custom' };
  }
  const isLocalServer = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(location.origin)
    && location.port === '3000';
  if (isLocalServer) {
    return { pull: API_BASE + '/data', push: API_BASE + '/data', mode: 'local' };
  }
  return { pull: API_BASE + '/data', push: API_BASE + '/sync', mode: 'cloud' };
}

/* Ambil objek aplikasi dari berbagai bentuk respons server:
   {APP:{…}} | {data:{APP:{…}}} | {data:{…}} | {…} */
function extractApp(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload.APP,
    payload.data && payload.data.APP,
    payload.data,
    payload.result,
    payload
  ];
  for (const c of candidates) {
    if (c && typeof c === 'object' &&
        (Array.isArray(c.orders) || Array.isArray(c.leads) || c.pricing)) {
      return c;
    }
  }
  return null;
}

/* ==== 4. MERGE PER-ITEM (anti tabrakan antar perangkat) ============= */

/* Gabungkan dua daftar objek berdasarkan `id`; yang lebih baru (updatedAt) menang */
function mergeById(a, b) {
  const map = new Map();
  (Array.isArray(a) ? a : []).forEach(x => map.set(x && x.id ? x.id : JSON.stringify(x), x));
  (Array.isArray(b) ? b : []).forEach(x => {
    if (!x) return;
    const k = x.id ? x.id : JSON.stringify(x);
    const cur = map.get(k);
    if (!cur || ts(x.updatedAt) >= ts(cur.updatedAt)) map.set(k, x);
  });
  return Array.from(map.values());
}

/* Gabungkan data lokal & server:
   - orders/leads digabung per-id (order yang dibuat di perangkat lain
     tidak hilang; status terbaru dari perangkat mana pun yang dipakai)
   - pricing & data lain mengikuti versi yang lebih baru */
function mergeApp(local, remote) {
  const base = ts(remote.updatedAt) >= ts(local.updatedAt) ? remote : local;
  const other = base === remote ? local : remote;
  const merged = Object.assign({}, base);
  merged.orders = mergeById(base.orders, other.orders);
  merged.leads = mergeById(base.leads, other.leads);
  merged.updatedAt = new Date(Math.max(ts(base.updatedAt), ts(other.updatedAt))).toISOString();
  return merged;
}

/* Bandingkan isi data (tanpa updatedAt) untuk mendeteksi perubahan nyata */
function dataChanged(a, b) {
  const pick = o => JSON.stringify({
    orders: o.orders || [], leads: o.leads || [], pricing: o.pricing || {}
  });
  return pick(a) !== pick(b);
}

/* Buat URL API absolut (aman untuk browser & saat dipanggil via Node/test) */
function apiUrl(path) {
  const origin = (typeof location !== 'undefined' && location.origin && location.origin !== 'null')
    ? location.origin : '';
  return origin + path;
}

/* Susun body push sesuai tipe server:
   - 'local'  → server.js membaca payload.data
   - 'cloud'  → api/sync.js membaca payload.APP
   - 'custom' → kirim keduanya agar aman untuk endpoint apa pun */
function buildPushBody(ep) {
  if (ep.mode === 'local') return { data: APP };
  if (ep.mode === 'custom') return { APP: APP, data: APP };
  return { APP: APP };
}

/* ==== 5. PUSH — kirim data ke server ================================ */
async function doPush() {
  const ep = syncEndpoints();
  updateSyncStatus('syncing');
  try {
    const resp = await fetch(apiUrl(ep.push), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPushBody(ep))
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();

    // Server bisa mengirim balik hasil merge → terapkan bila ada data baru
    const remote = extractApp(json);
    if (remote) {
      const merged = mergeApp(APP, remote);
      if (dataChanged(merged, APP)) {
        APP = merged;
        persistLocal();
        reRenderAll();
      }
    }
    markSynced();
    updateSyncStatus('ok');
    return { ok: true };
  } catch (err) {
    console.warn('❌ Push gagal:', err);
    updateSyncStatus(navigator.onLine ? 'error' : 'offline');
    return { ok: false, error: err };
  }
}

/* Push dengan debounce — dipakai index.html setiap kali save() dipanggil */
function syncPush() {
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  return new Promise(resolve => {
    pushTimer = setTimeout(async () => {
      pushTimer = null;
      resolve(await doPush());
    }, PUSH_DEBOUNCE_MS);
  });
}

/* ==== 6. PULL — ambil data terbaru dari server ====================== */
async function syncPull() {
  if (pullRunning) { pullAgain = true; return { ok: true, queued: true }; }
  pullRunning = true;
  updateSyncStatus('syncing');
  try {
    const ep = syncEndpoints();
    const resp = await fetch(apiUrl(ep.pull), { headers: { 'Cache-Control': 'no-cache' } });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();

    const remote = extractApp(json);
    if (remote) {
      const merged = mergeApp(APP, remote);
      const changed = dataChanged(merged, APP);
      APP = merged;
      persistLocal();
      if (changed) reRenderAll();
      markSynced();
      updateSyncStatus('ok');
      return { ok: true, changed: changed };
    }
    // Server masih kosong (belum pernah ada data tersimpan).
    // Perangkat ini yang pertama kali punya data -> kirim ke server (seed).
    if (hasLocalContent()) {
      const seeded = await doPush();
      if (seeded.ok) {
        markSynced();
        updateSyncStatus('ok');
        return { ok: true, seeded: true };
      }
    }
    markSynced();
    updateSyncStatus('ok');
    return { ok: true, empty: true };
  } catch (err) {
    console.warn('❌ Pull gagal:', err);
    updateSyncStatus(navigator.onLine ? 'error' : 'offline');
    return { ok: false, error: err };
  } finally {
    pullRunning = false;
    if (pullAgain) { pullAgain = false; setTimeout(syncPull, 50); }
  }
}

/* Apakah perangkat ini punya data yang perlu dikirim ke server? */
function hasLocalContent() {
  if (!APP || typeof APP !== 'object') return false;
  const orders = Array.isArray(APP.orders) ? APP.orders.length : 0;
  const leads = Array.isArray(APP.leads) ? APP.leads.length : 0;
  return orders > 0 || leads > 0;
}

/* Catat waktu sinkron terakhir */
function markSynced() {
  lastSyncAt = new Date();
  try { localStorage.setItem(SYNC_TIME_KEY, lastSyncAt.toISOString()); } catch (e) { /* abaikan */ }
}

/* ==== 7. Terapkan data & render ulang UI ============================ */
function reRenderAll() {
  try {
    if (typeof updateMetrics === 'function') updateMetrics();

    const active = document.querySelector('.page.active');
    const page = active ? active.id.replace('page-', '') : 'home';

    if (page === 'orders' && typeof renderOrders === 'function') {
      renderOrders();
    } else if (page === 'production' && typeof renderProdPage === 'function') {
      // Pertahankan order yang sedang dipilih di halaman produksi
      const sel = document.getElementById('prod-order-select');
      const picked = sel ? sel.value : '';
      renderProdPage();
      if (picked && sel) sel.value = picked;
    } else if (page === 'pricing' && typeof renderPricing === 'function') {
      renderPricing();
    } else if (page === 'leads' && typeof renderLeads === 'function') {
      renderLeads();
    } else if (typeof renderHome === 'function') {
      renderHome();
    }
  } catch (e) {
    console.warn('⚠️ Render ulang gagal', e);
  }
}

/* ==== 8. INDIKATOR STATUS SINKRONISASI ============================= */
function updateSyncStatus(state) {
  syncState = state;
  const map = {
    syncing: ['#f59e0b', 'Sinkron…', 'badge badge-prod', '🟡 Menyinkronkan'],
    ok:      ['#16a34a', 'Sinkron',   'badge badge-ok',    '🟢 Terhubung'],
    error:   ['#dc2626', 'Gagal',     'badge badge-danger','🔴 Gagal sinkron'],
    offline: ['#94a3b8', 'Offline',   'badge badge-gray',  '⚪ Offline'],
    idle:    ['#16a34a', 'Sinkron',   'badge badge-ok',    '🟢 Terhubung']
  };
  const info = map[state] || map.idle;
  const color = info[0], label = info[1], badgeClass = info[2], badgeText = info[3];

  const dot = document.getElementById('topbar-sync-dot');
  const txt = document.getElementById('topbar-sync-text');
  if (dot) dot.style.background = color;
  if (txt) txt.textContent = label;

  const badge = document.getElementById('modal-sync-badge');
  if (badge) { badge.textContent = badgeText; badge.className = badgeClass; }

  const title = document.getElementById('modal-sync-title');
  if (title) {
    title.textContent = (state === 'ok' || state === 'idle') ? 'Server Sinkronisasi Aktif'
      : state === 'syncing' ? 'Menyinkronkan Data…'
      : state === 'offline' ? 'Mode Offline' : 'Koneksi Bermasalah';
  }

  const desc = document.getElementById('modal-sync-desc');
  if (desc) {
    desc.textContent = state === 'offline'
      ? 'Anda sedang offline. Data tetap tersimpan di perangkat dan dikirim otomatis saat koneksi kembali.'
      : state === 'error'
      ? 'Tidak bisa menghubungi server sinkronisasi. Data aman di perangkat ini — coba lagi nanti.'
      : 'Data tersimpan di server dan otomatis sinkron antar semua perangkat (PC, HP, Tablet).';
  }
}

/* ==== 9. MODAL SINKRONISASI ========================================= */
function renderSyncModal() {
  const ep = syncEndpoints();
  const urlInput = document.getElementById('sync-custom-url');
  if (urlInput && document.activeElement !== urlInput) {
    urlInput.value = localStorage.getItem(SYNC_CONFIG_KEY) || '';
  }

  const timeEl = document.getElementById('modal-sync-time');
  if (timeEl) {
    const saved = localStorage.getItem(SYNC_TIME_KEY);
    const t = lastSyncAt || (saved ? new Date(saved) : null);
    timeEl.textContent = 'Terakhir sinkron: ' + (t ? t.toLocaleString('id-ID') : '—');
  }

  // Tampilkan URL yang bisa dibuka perangkat lain
  const box = document.getElementById('sync-network-urls');
  if (!box) return;

  const row = (u, note) =>
    '<div class="form-control text-mono" style="background:var(--surface);font-weight:700;color:var(--accent);display:flex;justify-content:space-between;align-items:center;gap:8px">' +
    '<span>' + u + (note ? ' <em style="font-style:normal;color:var(--ink3);font-weight:500">(' + note + ')</em>' : '') + '</span>' +
    '<button class="btn btn-ghost btn-sm" onclick="copySyncUrl(\'' + u + '\')">📋 Salin Link</button></div>';

  if (ep.mode === 'local') {
    fetch('/api/sync-info').then(r => r.json()).then(info => {
      const urls = (info && info.networkUrls && info.networkUrls.length) ? info.networkUrls : [location.origin];
      box.innerHTML = urls.map((u, i) => row(u, i === 0 ? 'server lokal' : 'Wi-Fi')).join('');
    }).catch(() => { box.innerHTML = '<div class="text-sm">URL server lokal tidak terdeteksi.</div>'; });
  } else {
    box.innerHTML = row(location.origin + location.pathname, 'server online');
  }
  updateSyncStatus(syncState);
}

/* Salin link (default: URL halaman ini) */
function copySyncUrl(url) {
  const target = url || (location.origin + location.pathname);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(target)
      .then(() => syncToast('✅ Link disalin: ' + target))
      .catch(() => syncToast('Gagal menyalin. Salin manual: ' + target, 'warn'));
  } else {
    syncToast('Salin manual: ' + target, 'warn');
  }
}

/* Simpan URL endpoint sync custom */
function saveCustomSyncConfig() {
  const el = document.getElementById('sync-custom-url');
  const url = ((el && el.value) || '').trim();
  if (url && !/^https?:\/\//i.test(url)) {
    syncToast('❌ URL harus diawali http:// atau https://', 'err');
    return;
  }
  if (url) localStorage.setItem(SYNC_CONFIG_KEY, url);
  else localStorage.removeItem(SYNC_CONFIG_KEY);
  syncToast('✅ Pengaturan sinkronisasi disimpan');
  triggerManualSync();
}

/* Kembalikan ke sinkron bawaan (Vercel / server lokal) */
function resetSyncConfig() {
  localStorage.removeItem(SYNC_CONFIG_KEY);
  const el = document.getElementById('sync-custom-url');
  if (el) el.value = '';
  syncToast('✅ Kembali ke sinkron bawaan');
  triggerManualSync();
}

/* ==== 10. BACKUP & RESTORE ========================================== */
function exportDataBackup() {
  try {
    const blob = new Blob([JSON.stringify(APP, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sos-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    syncToast('✅ Backup JSON diunduh');
  } catch (e) {
    syncToast('❌ Gagal membuat backup: ' + e.message, 'err');
  }
}

async function importDataBackup(ev) {
  const input = ev && ev.target;
  const file = input && input.files && input.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const app = extractApp(parsed);
    if (!app) {
      syncToast('❌ Format file tidak valid', 'err');
      if (input) input.value = '';
      return;
    }
    APP = app;
    persistLocal();
    reRenderAll();
    await doPush();
    syncToast('✅ Data berhasil dipulihkan & disinkronkan');
  } catch (e) {
    syncToast('❌ Gagal membaca file: ' + e.message, 'err');
  }
  if (input) input.value = '';
}

/* ==== 11. SINKRON MANUAL ============================================ */
async function triggerManualSync() {
  updateSyncStatus('syncing');
  const push = await doPush();
  const pull = await syncPull();
  if (push.ok && pull.ok) syncToast('✅ Sinkronisasi selesai');
  else syncToast('⚠️ Sinkronisasi gagal — cek koneksi server', 'err');
  renderSyncModal();
}

/* ==== 12. INISIALISASI ============================================== */
function initSync() {
  const saved = localStorage.getItem(SYNC_TIME_KEY);
  lastSyncAt = saved ? new Date(saved) : null;
  updateSyncStatus('idle');

  // Tarik data terbaru (index.html sudah merender UI lebih dulu)
  syncPull();

  // Polling berkala — hanya saat tab terlihat & online
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && navigator.onLine) syncPull();
  }, SYNC_POLL_MS);

  // Segera sinkron saat tab kembali aktif / perangkat online lagi
  window.addEventListener('focus', () => { if (navigator.onLine) syncPull(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine) syncPull();
  });
  window.addEventListener('online', () => { updateSyncStatus('idle'); syncPull(); });
  window.addEventListener('offline', () => updateSyncStatus('offline'));

  // Sinkron antar tab di perangkat yang sama
  window.addEventListener('storage', e => {
    if (e.key !== storageKey() || !e.newValue) return;
    try {
      const incoming = JSON.parse(e.newValue);
      if (incoming && dataChanged(incoming, APP)) {
        APP = incoming;
        reRenderAll();
        syncToast('ℹ️ Data diperbarui dari tab lain');
      }
    } catch (err) { /* abaikan */ }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(initSync, 0);
});
