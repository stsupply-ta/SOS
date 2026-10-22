// api/data.js
const { getAdmin } = require('./_initFirebase');

module.exports = async (req, res) => {
  try {
    const snap = await getAdmin().database().ref('appState').once('value');
    const data = snap.val() || null;   // null bila belum pernah di‑save
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      success: true,
      data,
      updatedAt: data && data.APP ? data.APP.updatedAt : null
    });
  } catch (e) {
    console.error('Firebase read error:', e);
    res.status(500).json({ error: e.message });
  }
};
