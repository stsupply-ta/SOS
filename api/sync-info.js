// api/sync-info.js
module.exports = (req, res) => {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  const urls = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        urls.push(`http://${iface.address}:3000`);
      }
    }
  }
  res.json({ urls });
};
