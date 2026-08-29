const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  version: 1,
  presence: { enabled: true, minRotateMinutes: 10, maxRotateMinutes: 20 },
  channels: { log: '', welcome: '', goodbye: '' },
  features: { monitor: true, welcome: true, goodbye: true, officialBot: true },
};

function validateConfig(input = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    ...input,
    presence: { ...DEFAULT_CONFIG.presence, ...(input.presence || {}) },
    channels: { ...DEFAULT_CONFIG.channels, ...(input.channels || {}) },
    features: { ...DEFAULT_CONFIG.features, ...(input.features || {}) },
  };
  if (config.presence.minRotateMinutes < 10 || config.presence.maxRotateMinutes < config.presence.minRotateMinutes) throw new Error('Khoảng rotate presence không hợp lệ');
  for (const key of ['log', 'welcome', 'goodbye']) if (config.channels[key] && !/^\d{15,22}$/.test(String(config.channels[key]))) throw new Error(`Channel ID ${key} không hợp lệ`);
  return config;
}

function createRemoteConfig(filePath, { maxAudit = 20, maxHistory = 10 } = {}) {
  let state = { config: validateConfig(DEFAULT_CONFIG), audit: [], history: [] };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(filePath, 'utf8')) };
    state.config = validateConfig(state.config);
    state.history = Array.isArray(state.history) ? state.history.map(validateConfig).slice(-maxHistory) : [];
  } catch (_) {}
  function persist() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`);
      fs.renameSync(tmp, filePath);
    } catch (_) {}
  }
  function update(patch, actor = 'system') {
    const previous = state.config;
    const next = validateConfig({ ...previous, ...patch, version: previous.version + 1 });
    state.history.push(previous);
    state.history = state.history.slice(-maxHistory);
    state.audit.push({ ts: Date.now(), actor, action: 'update', from: previous.version, to: next.version });
    state.audit = state.audit.slice(-maxAudit);
    state.config = next;
    persist();
    return next;
  }
  function rollback(actor = 'system') {
    const previous = state.history.pop();
    if (!previous) return state.config;
    const next = validateConfig({ ...previous, version: state.config.version + 1 });
    state.audit.push({ ts: Date.now(), actor, action: 'rollback', from: state.config.version, to: next.version });
    state.audit = state.audit.slice(-maxAudit);
    state.config = next;
    persist();
    return next;
  }
  return { get: () => state.config, update, rollback, audit: () => state.audit.slice(), history: () => state.history.slice() };
}

module.exports = { createRemoteConfig, validateConfig, DEFAULT_CONFIG };
