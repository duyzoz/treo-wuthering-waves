const fs = require('fs');
const path = require('path');

function createObservability(filePath, { maxAgeMs = 24 * 60 * 60 * 1000, sampleEveryMs = 5 * 60 * 1000 } = {}) {
  let state = {
    version: 1,
    updatedAt: Date.now(),
    reconnects: 0,
    rateLimits: 0,
    samples: [],
  };
  let lastSampleAt = 0;

  function load() {
    try {
      if (!fs.existsSync(filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') state = { ...state, ...parsed, samples: Array.isArray(parsed.samples) ? parsed.samples : [] };
      prune();
    } catch (_) {
      // Corrupt observability data must never stop the bot.
    }
  }

  function prune(now = Date.now()) {
    state.samples = state.samples.filter((sample) => Number(sample.ts) >= now - maxAgeMs);
  }

  function persist() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`);
      fs.renameSync(tmp, filePath);
    } catch (_) {
      // Render filesystem may be read-only/ephemeral; metrics remain in RAM.
    }
  }

  function bump(field) {
    if (Object.prototype.hasOwnProperty.call(state, field)) state[field] += 1;
    state.updatedAt = Date.now();
    persist();
  }

  function sample(metrics = {}) {
    const now = Date.now();
    prune(now);
    if (now - lastSampleAt < sampleEveryMs) return;
    lastSampleAt = now;
    state.samples.push({ ts: now, ...metrics });
    state.updatedAt = now;
    prune(now);
    persist();
  }

  function summary(now = Date.now()) {
    prune(now);
    const values = (key) => state.samples.map((sample) => Number(sample[key])).filter(Number.isFinite);
    const aggregate = (key) => {
      const list = values(key);
      if (!list.length) return { min: null, avg: null, max: null };
      return {
        min: Number(Math.min(...list).toFixed(2)),
        avg: Number((list.reduce((sum, value) => sum + value, 0) / list.length).toFixed(2)),
        max: Number(Math.max(...list).toFixed(2)),
      };
    };
    return {
      window: '24h',
      sampleCount: state.samples.length,
      reconnects: state.reconnects,
      rateLimits: state.rateLimits,
      ramMiB: aggregate('ramMiB'),
      cpu: aggregate('cpu'),
      heapMiB: aggregate('heapMiB'),
    };
  }

  load();
  return {
    sample,
    summary,
    recordReconnect: () => bump('reconnects'),
    recordRateLimit: () => bump('rateLimits'),
    getState: () => ({ ...state, samples: state.samples.slice() }),
  };
}

module.exports = { createObservability };
