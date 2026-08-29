const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function checksum(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function createConfigBackup(filePath, { maxBackups = 5 } = {}) {
  function read() { try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; } }
  function write(value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`);
    fs.renameSync(tmp, filePath);
  }
  function backup(value = read()) {
    if (!value) return null;
    const record = { createdAt: new Date().toISOString(), checksum: checksum(value), config: value };
    const backups = list();
    writeBackups([record, ...backups].slice(0, maxBackups));
    return record;
  }
  function list() { try { const data = JSON.parse(fs.readFileSync(`${filePath}.backups.json`, 'utf8')); return Array.isArray(data) ? data : []; } catch (_) { return []; } }
  function writeBackups(value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const target = `${filePath}.backups.json`;
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`);
    fs.renameSync(tmp, target);
  }
  function rollback(index = 0) {
    const record = list()[index];
    if (!record || checksum(record.config) !== record.checksum) throw new Error('Backup checksum không hợp lệ');
    const current = read();
    if (current) backup(current);
    write(record.config);
    return record.config;
  }
  return { read, backup, list, rollback, checksum };
}
module.exports = { createConfigBackup, checksum };
