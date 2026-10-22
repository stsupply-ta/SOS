// api/sync.js
const { getAdmin } = require('./_initFirebase');

/* Timestamp ISO → epoch ms (0 bila tidak valid) */
function ts(v) {
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

/* Gabungkan dua daftar objek berdasarkan `id`; updatedAt terbaru menang */
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

/* Gabungkan data masuk dengan data yang sudah tersimpan di server */
function mergeApp(incoming, current) {
  if (!current) return incoming;
  const incomingNewer = ts(incoming.updatedAt) >= ts(current.updatedAt);
  const base = incomingNewer ? incoming : current;
  const other = incomingNewer ? current : incoming;
  const merged = Object.assign({}, base);
  merged.orders = mergeById(base.orders, other.orders);
  merged.leads = mergeById(base.leads, other.leads);
  return merged;
}


module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // body di‑harapkan { APP: { … } }
  const payload = req.body || {};
  const incoming = payload.APP || payload.data || payload;

  if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.orders)) {
    return res.status(400).json({ error: 'Payload tidak valid' });
  }

  try {
    const ref = getAdmin().database().ref('appState');
    const snap = await ref.once('value');
    const current = snap.val();
    const currentApp = current && current.APP ? current.APP : null;

    // Gabungkan dengan data server supaya order dari perangkat lain tidak hilang
    const merged = mergeApp(incoming, currentApp);
    merged.updatedAt = new Date().toISOString();

    await ref.set({ APP: merged });

    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, updatedAt: merged.updatedAt, data: { APP: merged } });
  } catch (e) {
    console.error('Firebase write error:', e);
    res.status(500).json({ error: e.message });
  }
};
