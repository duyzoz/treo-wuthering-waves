function parseClock(value, fallback) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
  return match ? Number(match[1]) * 60 + Number(match[2]) : fallback;
}

function isNightSaverActive(now = new Date(), start = process.env.NIGHT_SAVER_START || '23:00', end = process.env.NIGHT_SAVER_END || '07:00') {
  if (String(process.env.NIGHT_SAVER_ENABLED || 'true') === 'false') return false;
  const timeZone = process.env.NIGHT_SAVER_TZ || 'Asia/Ho_Chi_Minh';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  const current = hour * 60 + minute;
  const from = parseClock(start, 23 * 60);
  const to = parseClock(end, 7 * 60);
  return from === to ? false : (from > to ? current >= from || current < to : current >= from && current < to);
}

function createAnomalyGuard({ cooldownMs = 30 * 60 * 1000, memoryRatio = 0.85, cpuLimit = 0.08, repeatCount = 2 } = {}) {
  let lastAlertAt = 0;
  function evaluate(health = {}, events = [], now = Date.now()) {
    const recent = events.filter((event) => now - event.ts <= 30 * 60 * 1000);
    const ramRatio = Number(health.container?.memory?.bytes || 0) / Math.max(1, Number(health.container?.memory?.limitBytes || 1));
    const cpu = Number(health.container?.cpu || 0);
    const reconnects = recent.filter((e) => e.code === 'DISCORD_OFFLINE').length;
    const rateLimits = recent.filter((e) => e.code === 'RATE_LIMIT').length;
    const reasons = [];
    if (ramRatio >= memoryRatio) reasons.push(`RAM ${(ramRatio * 100).toFixed(1)}%`);
    if (cpu >= cpuLimit) reasons.push(`CPU ${cpu.toFixed(4)}`);
    if (reconnects >= repeatCount) reasons.push(`reconnect x${reconnects}`);
    if (rateLimits >= repeatCount) reasons.push(`rate-limit x${rateLimits}`);
    if (!reasons.length || now - lastAlertAt < cooldownMs) return null;
    lastAlertAt = now;
    return { code: 'ANOMALY_GUARD', severity: ramRatio >= 0.95 || reconnects >= 4 ? 'CRITICAL' : 'WARN', reasons, ts: now };
  }
  return { evaluate, snapshot: () => ({ lastAlertAt }) };
}

function buildIncidentDigest(events = [], now = Date.now(), windowMs = 30 * 60 * 1000) {
  const recent = events.filter((event) => now - event.ts <= windowMs);
  const critical = recent.some((e) => e.code === 'ANOMALY_GUARD' && e.severity === 'CRITICAL');
  const warning = recent.some((e) => ['RATE_LIMIT', 'DISCORD_OFFLINE', 'MEMORY_HIGH', 'ANOMALY_GUARD'].includes(e.code));
  const level = critical ? 'CRITICAL' : warning ? 'WARN' : 'OK';
  const icon = level === 'CRITICAL' ? '🔴' : level === 'WARN' ? '🟠' : '🟢';
  return { level, icon, count: recent.length, text: `${icon} **${level}** · ${recent.length} event trong 30 phút`, events: recent.slice(-10) };
}

module.exports = { isNightSaverActive, createAnomalyGuard, buildIncidentDigest };
