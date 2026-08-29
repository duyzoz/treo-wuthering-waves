function healthScore(health = {}) {
  let score = 100;
  if (!health.discordReady && !health.officialBotReady) score -= 35;
  if (health.officialBotReady === false && health.discordReady === false) score -= 10;
  const ram = Number(health.container?.memory?.bytes || 0) / Math.max(1, Number(health.container?.memory?.limitBytes || 1));
  const cpu = Number(health.container?.cpu || 0);
  if (ram >= 0.85) score -= 20;
  if (ram >= 0.95) score -= 20;
  if (cpu >= 0.08) score -= 15;
  if (Number(health.rateLimitCount || 0) > 0) score -= Math.min(15, Number(health.rateLimitCount));
  if (Number(health.errorCount || 0) > 0) score -= Math.min(25, Number(health.errorCount) * 5);
  const level = score >= 85 ? 'EXCELLENT' : score >= 65 ? 'DEGRADED' : 'CRITICAL';
  return { score: Math.max(0, score), level };
}

function trend(current, previous, epsilon = 0.01) {
  const a = Number(current); const b = Number(previous);
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) <= epsilon) return '→';
  return a > b ? '↑' : '↓';
}

function budgetHud(resource = {}) {
  const limits = resource.limits || {};
  const used = { requests: Number(resource.requests || 0), discordUpdates: Number(resource.discordUpdates || 0), io: Number(resource.io || 0) };
  return Object.entries(used).map(([key, value]) => `${key} ${value}/${Number(limits[key] || 0)}`).join(' · ');
}

function isMaintenanceWindowActive(now = new Date(), start = process.env.MAINTENANCE_START || '', end = process.env.MAINTENANCE_END || '') {
  if (!start || !end) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: process.env.NIGHT_SAVER_TZ || 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const minutes = Number(parts.find((p) => p.type === 'hour')?.value || 0) * 60 + Number(parts.find((p) => p.type === 'minute')?.value || 0);
  const parse = (value) => { const m = /^(\d\d?):(\d\d)$/.exec(value); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const from = parse(start); const to = parse(end);
  if (from === null || to === null || from === to) return false;
  return from > to ? minutes >= from || minutes < to : minutes >= from && minutes < to;
}

module.exports = { healthScore, trend, budgetHud, isMaintenanceWindowActive };
