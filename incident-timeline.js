const fs = require('fs');
const path = require('path');

function createIncidentTimeline(filePath, { maxEvents = 200, maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  let events = [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(data)) events = data;
  } catch (_) {}

  function prune(now = Date.now()) {
    events = events.filter((event) => now - event.ts <= maxAgeMs).slice(-maxEvents);
  }
  function persist() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(events)}\n`);
      fs.renameSync(tmp, filePath);
    } catch (_) {}
  }
  function record(code, message, meta = {}) {
    const event = { ts: Date.now(), code: String(code).slice(0, 32), message: String(message).slice(0, 240), ...meta };
    prune(event.ts);
    events.push(event);
    events = events.slice(-maxEvents);
    persist();
    return event;
  }
  function recent(limit = 50) {
    prune();
    return events.slice(-Math.min(maxEvents, Math.max(1, limit)));
  }
  prune();
  return { record, recent, count: () => recent(maxEvents).length };
}

module.exports = { createIncidentTimeline };
