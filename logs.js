// ===========================================================================
// SHARED ERROR/LOG RING BUFFER
// ---------------------------------------------------------------------------
// Dung chung cho index.js (bot chinh), ai-personas.js (AI bots), va
// gemini-bridge.js (tien trinh Python Gemini). Muc dich: gom TAT CA log loi
// vao MOT cho duy nhat de xem/copy trong /admin/ai (card "System error logs"),
// khong can vao rieng tung noi hay tail log Render.
// Rat nhe: chi la 1 mang trong RAM, gioi han MAX_LOGS phan tu, khong ghi file,
// khong ton tai nguyen dang ke.
// ===========================================================================

const MAX_LOGS = 200;
const buffer = [];

function push(entry) {
  const item = {
    ts: new Date().toISOString(),
    source: entry.source || 'app',
    level: entry.level || 'error',
    message: String(entry.message || '').slice(0, 800),
  };
  buffer.push(item);
  if (buffer.length > MAX_LOGS) buffer.shift();
  return item;
}

function getAll() {
  // Moi nhat truoc, de user copy phan tren cung la loi gan nhat.
  return buffer.slice().reverse();
}

function clear() {
  buffer.length = 0;
}

// Boc mot logger { info, warn, error } de moi lan goi .warn/.error
// deu duoc luu lai vao ring buffer chung, van giu nguyen hanh vi console cu.
function wrapLogger(baseLogger, source) {
  const base = baseLogger || console;
  return {
    info: (...args) => {
      (base.info || base.log || console.log).call(base, ...args);
    },
    warn: (...args) => {
      (base.warn || console.warn).call(base, ...args);
      push({ source, level: 'warn', message: args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ') });
    },
    error: (...args) => {
      (base.error || console.error).call(base, ...args);
      push({ source, level: 'error', message: args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ') });
    },
  };
}

// Dinh dang toan bo log thanh 1 khoi text de copy-paste thang cho AI/ nguoi debug.
function formatForCopy(entries) {
  const list = entries || getAll();
  if (!list.length) return 'Khong co loi nao duoc ghi nhan.';
  return list
    .map((e) => `[${e.ts}] (${e.source}/${e.level}) ${e.message}`)
    .join('\n');
}

module.exports = { push, getAll, clear, wrapLogger, formatForCopy, MAX_LOGS };
