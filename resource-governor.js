function dayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function createResourceGovernor({ maxRequestsPerDay = 400, maxDiscordUpdatesPerDay = 300, maxIoPerDay = 1200, warnAt = 0.8 } = {}) {
  let state = { day: dayKey(), requests: 0, discordUpdates: 0, io: 0, mode: 'normal' };
  function refresh(now = Date.now()) {
    const day = dayKey(now);
    if (state.day !== day) state = { day, requests: 0, discordUpdates: 0, io: 0, mode: 'normal' };
    return state;
  }
  function consume(type, count = 1, now = Date.now()) {
    refresh(now);
    const key = type === 'discordUpdate' ? 'discordUpdates' : type === 'request' ? 'requests' : 'io';
    const limit = type === 'request' ? maxRequestsPerDay : type === 'discordUpdate' ? maxDiscordUpdatesPerDay : maxIoPerDay;
    if (!Number.isFinite(state[key]) || state[key] + count > limit) { state.mode = 'health-only'; return false; }
    state[key] += count;
    const ratios = [state.requests / maxRequestsPerDay, state.discordUpdates / maxDiscordUpdatesPerDay, state.io / maxIoPerDay];
    if (Math.max(...ratios) >= 1) state.mode = 'health-only';
    else if (Math.max(...ratios) >= warnAt) state.mode = 'conserve';
    return true;
  }
  function snapshot(now = Date.now()) {
    refresh(now);
    return { ...state, limits: { requests: maxRequestsPerDay, discordUpdates: maxDiscordUpdatesPerDay, io: maxIoPerDay } };
  }
  function can(type, count = 1, now = Date.now()) { const s = snapshot(now); const key = type === 'discordUpdate' ? 'discordUpdates' : type; const limit = s.limits[key]; return s.mode !== 'health-only' && s[key] + count <= limit; }
  return { consume, can, snapshot };
}

function nextAdaptiveDelay({ baseMs = 5 * 60 * 1000, maxMs = 30 * 60 * 1000, health = {}, rateLimited = false, consecutiveHealthy = 0 } = {}) {
  const memory = Number(health.container?.memory?.bytes || 0) / Math.max(1, Number(health.container?.memory?.limitBytes || 1));
  const cpu = Number(health.container?.cpu || 0);
  const degraded = rateLimited || memory >= 0.85 || cpu >= 0.08 || Number(health.rateLimitCount || 0) > 0;
  if (degraded) return Math.min(maxMs, Math.max(baseMs, baseMs * 3));
  if (consecutiveHealthy >= 3) return Math.max(baseMs, 10 * 60 * 1000);
  return baseMs;
}

module.exports = { createResourceGovernor, nextAdaptiveDelay };
