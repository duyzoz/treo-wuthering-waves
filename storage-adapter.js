const fs = require('fs');
const path = require('path');

function createStorageAdapter({ filePath, remoteUrl = '', remoteToken = '' } = {}) {
  async function read() {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
    if (!remoteUrl) return null;
    try {
      const response = await fetch(remoteUrl, { headers: remoteToken ? { Authorization: `Bearer ${remoteToken}` } : {} });
      return response.ok ? response.json() : null;
    } catch (_) { return null; }
  }
  async function write(value) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`);
      fs.renameSync(tmp, filePath);
    } catch (_) {}
    if (!remoteUrl) return true;
    try {
      const response = await fetch(remoteUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(remoteToken ? { Authorization: `Bearer ${remoteToken}` } : {}) }, body: JSON.stringify(value) });
      return response.ok;
    } catch (_) { return false; }
  }
  return { read, write };
}

module.exports = { createStorageAdapter };
