// Bộ nhớ vòng log nhẹ cho dashboard status.
// Log chỉ tồn tại trong process hiện tại; log deploy dài hạn vẫn xem ở Render.
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
  return buffer.slice().reverse();
}

function clear() {
  buffer.length = 0;
}

function wrapLogger(baseLogger, source) {
  const base = baseLogger || console;
  return {
    info: (...args) => {
      (base.info || base.log || console.log).call(base, ...args);
    },
    warn: (...args) => {
      (base.warn || console.warn).call(base, ...args);
      push({
        source,
        level: 'warn',
        message: args.map((arg) => (arg instanceof Error ? arg.stack || arg.message : String(arg))).join(' '),
      });
    },
    error: (...args) => {
      (base.error || console.error).call(base, ...args);
      push({
        source,
        level: 'error',
        message: args.map((arg) => (arg instanceof Error ? arg.stack || arg.message : String(arg))).join(' '),
      });
    },
  };
}

function formatForCopy(entries) {
  const list = entries || getAll();
  if (!list.length) return 'Không có lỗi nào được ghi nhận.';
  return list.map((entry) => `[${entry.ts}] (${entry.source}/${entry.level}) ${entry.message}`).join('\n');
}

module.exports = { push, getAll, clear, wrapLogger, formatForCopy, MAX_LOGS };
