const fs = require('fs');
const path = require('path');

function createSafeCleanup({ rootDir = path.join(process.cwd(), 'data', 'tmp'), maxAgeMs = 24 * 60 * 60 * 1000, maxFilesPerRun = 20, maxBytesPerRun = 5 * 1024 * 1024 } = {}) {
  let running = false;
  let lastRunAt = 0;
  let lastResult = { removed: 0, bytes: 0, skipped: 0, at: null };

  function isSafeRoot() {
    return path.basename(rootDir) === 'tmp' && path.basename(path.dirname(rootDir)) === 'data';
  }
  function run(now = Date.now()) {
    if (running || !isSafeRoot() || now - lastRunAt < 60 * 60 * 1000) return { ...lastResult, skipped: lastResult.skipped + 1 };
    running = true; lastRunAt = now;
    let removed = 0; let bytes = 0; let skipped = 0;
    try {
      fs.mkdirSync(rootDir, { recursive: true });
      for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
        if (removed >= maxFilesPerRun || bytes >= maxBytesPerRun || !entry.isFile()) { skipped += 1; continue; }
        if (!/\.(tmp|temp|cache)$/i.test(entry.name) && !entry.name.startsWith('.runtime-')) { skipped += 1; continue; }
        const filePath = path.join(rootDir, entry.name);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs < maxAgeMs) { skipped += 1; continue; }
        if (bytes + stat.size > maxBytesPerRun) { skipped += 1; continue; }
        fs.rmSync(filePath, { force: true }); removed += 1; bytes += stat.size;
      }
    } catch (_) { skipped += 1; }
    finally { running = false; lastResult = { removed, bytes, skipped, at: new Date(now).toISOString() }; }
    return { ...lastResult };
  }
  return { run, snapshot: () => ({ ...lastResult, rootDir, maxAgeMs, maxFilesPerRun, maxBytesPerRun }) };
}

module.exports = { createSafeCleanup };
