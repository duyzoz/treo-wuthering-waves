const express = require('express');
const fs = require('fs');
const path = require('path');
const logs = require('./logs');
const { createPresenceEngine } = require('./presence-engine');
const { createObservability } = require('./observability');
const { createOfficialBot } = require('./official-bot');
const { RestTrafficGovernor } = require('./rest-governor');
const { createIncidentTimeline } = require('./incident-timeline');
const { createRemoteConfig } = require('./remote-config');
const { createStorageAdapter } = require('./storage-adapter');
const { isNightSaverActive, createAnomalyGuard, buildIncidentDigest } = require('./ops-guard');
const { createConfigBackup } = require('./config-backup');
const { createResourceGovernor, nextAdaptiveDelay } = require('./resource-governor');
const { healthScore, trend, budgetHud, isMaintenanceWindowActive } = require('./dashboard-metrics');
const { createSafeCleanup } = require('./safe-cleanup');
const { createGameProfileStore, GAME_PRESETS, normalizeProfile } = require('./game-profiles');
const { panelComponents, gameSelectComponents, customizeModal, previewText } = require('./game-panel');
const { createUserTokenStore } = require('./user-token-store');
const { runQuestsForUser, getOrbBalance } = require('./quest-runner');

const FULL_OFFICIAL_MODE = process.env.FULL_OFFICIAL_MODE === 'true';
const selfbotLib = FULL_OFFICIAL_MODE
  ? { Client: require('discord.js').Client, Options: require('discord.js').Options, RichPresence: null }
  : require('discord.js-selfbot-v13');
const { Client, Options, RichPresence } = selfbotLib;

// ---------------------------------------------------------------------------
// Config từ env — tuỳ chỉnh trên Render mà không cần sửa code
// ---------------------------------------------------------------------------
const CFG = {
  resonatorName:  process.env.RESONATOR_NAME  || 'Hiyuki S6',
  unionLevel:     process.env.UNION_LEVEL      || '80',
  serverRegion:   process.env.SERVER_REGION    || 'Asia',
  appId:          process.env.APP_ID           || '1243763782974443580',
  largeImg:       process.env.LARGE_IMG        || 'https://files.catbox.moe/6tly5b.png',
  smallImg:       process.env.SMALL_IMG        || 'https://i.pinimg.com/736x/19/37/44/1937447c2110ad986866d1495e6c4b30.jpg',
  statusGif:      process.env.STATUS_GIF_URL    || '',
  embedColor:     Number(process.env.EMBED_COLOR || 0x6d5dfc),
};

const RUN_SELF_BOT = !FULL_OFFICIAL_MODE && process.env.ALLOW_DISCORD_RUN !== 'false';
const RUN_DISCORD = RUN_SELF_BOT;
const DISCORD_TOKEN = RUN_SELF_BOT ? (process.env.TOKEN_DISCORD || process.env.TOKEN) : null;

// ---------------------------------------------------------------------------
// Logging với timestamp — dễ debug trên Render
// ---------------------------------------------------------------------------
const recentErrors = [];   // Ring buffer — lưu 15 lỗi gần nhất
const MAX_RECENT_ERRORS = 15;

function log(level, ...args) {
  const ts = new Date().toISOString();
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
  console[level](`[${ts}] ${prefix}`, ...args);

  if (level === 'error') {
    recentErrors.push({ ts, msg: args.join(' ') });
    if (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.shift();
  }
}

const rawLogger = {
  info:  (...a) => log('log',   ...a),
  warn:  (...a) => log('warn',  ...a),
  error: (...a) => log('error', ...a),
};

// Boc logger chinh de moi loi/warn cung duoc gom vao logs.js (buffer dung chung
// voi ai-personas.js va gemini-bridge.js) -> xem/copy tat ca tai /admin/ai.
const logger = logs.wrapLogger(rawLogger, 'main');

// ---------------------------------------------------------------------------
// HTTP server — phải lên trước Discord login để Render không timeout health
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '16kb' }));
const port = Number(process.env.PORT) || 5000;
const TIME_FILE = path.join(__dirname, 'starttime.json');
const OBSERVABILITY_FILE = process.env.OBSERVABILITY_FILE || path.join(__dirname, 'data', 'observability.json');
const observability = createObservability(OBSERVABILITY_FILE, { sampleEveryMs: 5 * 60 * 1000 });
const timeline = createIncidentTimeline(process.env.INCIDENTS_FILE || path.join(__dirname, 'data', 'incidents.json'));
const anomalyGuard = createAnomalyGuard({ cooldownMs: 30 * 60 * 1000 });
const resourceGovernor = createResourceGovernor({ maxRequestsPerDay: Number(process.env.MAX_REQUESTS_PER_DAY) || 400, maxDiscordUpdatesPerDay: Number(process.env.MAX_DISCORD_UPDATES_PER_DAY) || 300, maxIoPerDay: Number(process.env.MAX_IO_PER_DAY) || 1200 });
const remoteConfig = createRemoteConfig(process.env.REMOTE_CONFIG_FILE || path.join(__dirname, 'data', 'remote-config.json'));
const configBackup = createConfigBackup(process.env.REMOTE_CONFIG_FILE || path.join(__dirname, 'data', 'remote-config.json'));
const existingConfigBackup = configBackup.list()[0];
if (!existingConfigBackup || existingConfigBackup.checksum !== configBackup.checksum(remoteConfig.get())) configBackup.backup(remoteConfig.get());
let maintenanceMode = false;
const trendHistory = [];
const safeCleanup = createSafeCleanup({ rootDir: path.join(__dirname, 'data', 'tmp') });
const gameProfiles = createGameProfileStore(path.join(__dirname, 'data', 'game-profiles.json'));
const userTokenStore = createUserTokenStore(path.join(__dirname, 'data', 'user-tokens.json'));
const ADMIN_CONFIG_KEY = process.env.ADMIN_CONFIG_KEY || '';
const persistence = createStorageAdapter({ filePath: process.env.PERSISTENCE_FILE || path.join(__dirname, 'data', 'persistence.json'), remoteUrl: process.env.PERSISTENCE_URL || '', remoteToken: process.env.PERSISTENCE_TOKEN || '' });
let lastExternalPersistAt = 0;
if (process.env.PERSISTENCE_URL) persistence.read().then((snapshot) => {
  if (snapshot) logger.info('[storage] Đã đọc snapshot persistence ngoài một lần khi khởi động.');
}).catch(() => {});

let discordReady = false;
let loginRetryTimer = null;
let loginAttempt = 0;
let sessionStartTimestamp = null;
let errorCount = 0;
let lastPresenceUpdate = null;
let lastActivity = null;    // tên activity đang hiển thị
let rateLimitCount = 0;
let lastMemoryWarningAt = 0;
let processStartTime = Date.now();
let uptimeStartTimestamp = null;
let lastReadyAt = null;
let lastDisconnectAt = null;
let lastLoginStartedAt = 0;

// /ping — endpoint nhẹ nhất cho UptimeRobot (không cần parse JSON)
app.get('/ping', (_req, res) => res.status(200).send('pong'));

// / — trang chủ
app.get('/', (_req, res) => {
  res.status(200).send('Wuthering Waves presence bot đang chạy 24/7.');
});

// /health — JSON đầy đủ cho monitoring
app.get('/health', (_req, res) => {
  const mem = process.memoryUsage();
  const container = getRealRenderRam();
  const memoryRatio = container.limitBytes > 0 ? container.bytes / container.limitBytes : 0;
  if (memoryRatio >= 0.85 && Date.now() - lastMemoryWarningAt > 15 * 60 * 1000) {
    lastMemoryWarningAt = Date.now();
    timeline.record('MEMORY_HIGH', `Container ${container.mib.toFixed(2)} MiB / ${(container.limitBytes / 1_048_576).toFixed(2)} MiB`);
    logger.warn(`[memory] Container đang dùng ${(memoryRatio * 100).toFixed(1)}% limit (${container.mib.toFixed(2)} MiB).`);
  }
  const uptimeSec = Math.floor((Date.now() - processStartTime) / 1000);
  const playtimeStart = sessionStartTimestamp || getStartTimestamp();
  const playtimeH = playtimeStart
    ? ((Date.now() - playtimeStart) / 3_600_000).toFixed(1)
    : null;
  observability.sample({
    ramMiB: container.mib,
    cpu: Number(getCpuUsageDetail()),
    heapMiB: Number((mem.heapUsed / 1_048_576).toFixed(2)),
  });
  trendHistory.push({ ts: Date.now(), ram: container.mib, cpu: Number(getCpuUsageDetail()), heap: mem.heapUsed / 1_048_576 });
  if (trendHistory.length > 12) trendHistory.shift();
  if (process.env.PERSISTENCE_URL && Date.now() - lastExternalPersistAt >= 15 * 60 * 1000) {
    lastExternalPersistAt = Date.now();
    persistence.write({ savedAt: lastExternalPersistAt, uptimeSec, observability: observability.summary(), incidents: timeline.recent(50) }).catch(() => {});
  }

  res.status(200).json({
    ok: true,
    discordReady,
    officialBotReady: Boolean(officialBot?.client?.isReady?.()),
    sessionStartTimestamp,
    playtimeH,
    lastPresenceUpdate,
    lastActivity,
    uptimeSec,
    errorCount,
    rateLimitCount,
    recentErrors,
    presence: { category: currentPresenceCategory, durationMinutes: currentPresenceDurationMinutes },
    nightSaver: { active: isNightSaverActive(), start: process.env.NIGHT_SAVER_START || '23:00', end: process.env.NIGHT_SAVER_END || '07:00', timezone: process.env.NIGHT_SAVER_TZ || 'Asia/Ho_Chi_Minh' },
    anomalyGuard: anomalyGuard.snapshot(),
    resourceBudget: resourceGovernor.snapshot(),
    budgetHud: budgetHud(resourceGovernor.snapshot()),
    cleanup: safeCleanup.snapshot(),
    maintenanceMode,
    maintenanceWindow: { active: isMaintenanceWindowActive(), start: process.env.MAINTENANCE_START || null, end: process.env.MAINTENANCE_END || null },
    healthScore: healthScore({ discordReady, officialBotReady: Boolean(officialBot?.client?.isReady?.()), container: { memory: container }, rateLimitCount, errorCount }),
    trends: { ram: trend(container.mib, trendHistory.at(-2)?.ram), cpu: trend(Number(getCpuUsageDetail()), trendHistory.at(-2)?.cpu), heap: trend(mem.heapUsed / 1_048_576, trendHistory.at(-2)?.heap) },
    observability: observability.summary(),
    restGovernor: restGovernor.snapshot(),
    incidents: timeline.recent(20),
    remoteConfig: { version: remoteConfig.get().version, auditCount: remoteConfig.audit().length },
    lifecycle: { lastReadyAt, lastDisconnectAt, lastLoginStartedAt },
    container: {
      memory: container,
      cpu: getCpuUsageDetail(),
      cpuLimit: '0.1',
    },
    config: {
      resonatorName: CFG.resonatorName,
      unionLevel:    CFG.unionLevel,
      serverRegion:  CFG.serverRegion,
    },
    memory: {
      heapUsedMb:  Number((mem.heapUsed  / 1_048_576).toFixed(2)),
      heapTotalMb: Number((mem.heapTotal / 1_048_576).toFixed(2)),
      rssMb:       Number((mem.rss       / 1_048_576).toFixed(2)),
    },
  });
});

app.get('/incidents', (_req, res) => res.status(200).json({ window: '24h', events: timeline.recent(50) }));
function isAdminRequest(req) {
  return Boolean(ADMIN_CONFIG_KEY) && req.get('x-admin-key') === ADMIN_CONFIG_KEY;
}
app.get('/config', (req, res) => {
  if (!isAdminRequest(req)) return res.status(404).json({ error: 'Not found' });
  return res.status(200).json({ version: remoteConfig.get().version, config: remoteConfig.get(), audit: remoteConfig.audit() });
});
app.get('/public', (_req, res) => {
  const memory = getRealRenderRam();
  const ratio = memory.limitBytes ? memory.bytes / memory.limitBytes : 0;
  const officialReady = Boolean(officialBot?.client?.isReady?.());
  const online = Boolean(discordReady || officialReady);
  const digest = buildIncidentDigest(timeline.recent(50));
  const score = healthScore({ discordReady, officialBotReady: officialReady, container: { memory }, errorCount, rateLimitCount });
  const uptimeH = ((Date.now() - uptimeStartTimestamp) / 3_600_000).toFixed(1);
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>WW Status</title><style>body{margin:0;background:#0b1020;color:#e9e7ff;font:14px system-ui;padding:24px}main{max-width:620px;margin:auto;background:linear-gradient(145deg,#17163b,#0d2942);border:1px solid #6657d9;border-radius:18px;padding:20px;box-shadow:0 12px 40px #0008}h1{margin:0 0 14px;color:#b8b2ff}.badge{display:inline-block;padding:6px 10px;border-radius:99px;background:${online ? '#153e31' : '#4a1f34'};color:${online ? '#6fffd2' : '#ff8ba7'}}.row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #ffffff18}.bar{height:8px;background:#242750;border-radius:8px;overflow:hidden}.bar i{display:block;height:100%;width:${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%;background:linear-gradient(90deg,#57d6ff,#9d6bff)}</style><main><h1>🌊 Wuthering Waves</h1><span class="badge">${online ? 'ONLINE' : 'OFFLINE'}</span><div class="row"><span>Uptime</span><b>${uptimeH}h</b></div><div class="row"><span>Memory</span><b>${memory.mib.toFixed(2)} / ${(memory.limitBytes / 1048576).toFixed(0)} MiB</b></div><div class="bar"><i></i></div><div class="row"><span>CPU</span><b>${getCpuUsageDetail()}</b></div><div class="row"><span>Health</span><b>${score.score}/100 · ${score.level}</b></div><div class="row"><span>Incidents</span><b>${digest.icon} ${digest.level}</b></div><small>Updated ${new Date().toISOString()}</small></main>`);
});
app.get('/admin/config', (req, res) => {
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Admin key required' });
  return res.status(200).json({ version: remoteConfig.get().version, config: remoteConfig.get(), audit: remoteConfig.audit(), backups: configBackup.list().map((item) => ({ createdAt: item.createdAt, checksum: item.checksum })) });
});
app.post('/admin/config', (req, res) => {
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Admin key required' });
  try {
    configBackup.backup(remoteConfig.get());
    const next = remoteConfig.update(req.body || {}, 'web-admin');
    timeline.record('CONFIG_UPDATE', `Remote config v${next.version}`);
    return res.status(200).json({ ok: true, config: next });
  } catch (error) { return res.status(400).json({ ok: false, error: error.message }); }
});
app.post('/admin/config/rollback', (req, res) => {
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Admin key required' });
  try {
    const restored = configBackup.rollback(Number(req.body?.index || 0));
    timeline.record('CONFIG_ROLLBACK', 'Config restored from checksum backup');
    return res.status(200).json({ ok: true, config: restored });
  } catch (error) { return res.status(400).json({ ok: false, error: error.message }); }
});

app.get('/ready', (_req, res) => {
  const officialReady = !officialBot || officialBot.client.isReady();
  const gatewayReady = FULL_OFFICIAL_MODE ? officialReady : discordReady;
  const ready = Boolean(gatewayReady && officialReady);
  res.status(ready ? 200 : 503).json({ ready, discordReady, officialBotReady: officialReady });
});

// /status — trang HTML đọc được bằng mắt thường, mở trên browser
app.get('/status', (_req, res) => {
  const uptimeH = ((Date.now() - processStartTime) / 3_600_000).toFixed(1);
  const playtimeStart = sessionStartTimestamp || getStartTimestamp();
  const playtimeH = playtimeStart
    ? ((Date.now() - playtimeStart) / 3_600_000).toFixed(1)
    : '—';
  const mem = process.memoryUsage();
  const container = getRealRenderRam();
  const heapMb = (mem.heapUsed / 1_048_576).toFixed(2);
  const cpuValue = getCpuUsageDetail();
  observability.sample({ ramMiB: container.mib, cpu: Number(cpuValue), heapMiB: Number(heapMb) });
  const status = (discordReady || officialBot?.client?.isReady?.()) ? '🟢 Online' : '🔴 Offline';

  res.status(200).send(`<!DOCTYPE html>
<html lang="vi">
<head><meta charset="utf-8"><title>WW Bot Status</title>
<meta http-equiv="refresh" content="30">
<style>
  body{font-family:monospace;background:#1a1a2e;color:#e0e0ff;padding:2rem;max-width:600px;margin:auto}
  h1{color:#7b7ff5}
  .row{display:flex;justify-content:space-between;border-bottom:1px solid #333;padding:.4rem 0}
  .ok{color:#4caf50} .bad{color:#f44336} .warn{color:#ff9800}
  .errors{background:#0d0d1a;padding:1rem;border-radius:6px;font-size:.85em;max-height:200px;overflow-y:auto}
</style></head>
<body>
<h1>🌊 Wuthering Waves Bot</h1>
<div class="row"><span>Discord</span><span class="${discordReady ? 'ok' : 'bad'}">${status}</span></div>
<div class="row"><span>Resonator</span><span>${CFG.resonatorName} · ${CFG.serverRegion} UL${CFG.unionLevel}</span></div>
<div class="row"><span>Playtime</span><span>${playtimeH}h</span></div>
<div class="row"><span>Process uptime</span><span>${uptimeH}h</span></div>
<div class="row"><span>RAM Container</span><span class="${container.mib > 450 ? 'warn' : 'ok'}">${container.mib.toFixed(2)} / ${(container.limitBytes / 1_048_576).toFixed(2)} MiB</span></div>
<div class="row"><span>CPU Usage</span><span>${cpuValue} / 0.1 CPU</span></div>
<div class="row"><span>Heap JS</span><span class="${Number(heapMb) > 180 ? 'warn' : 'ok'}">${heapMb} MiB</span></div>
<div class="row"><span>Errors</span><span class="${errorCount > 5 ? 'warn' : 'ok'}">${errorCount} (rate-limit: ${rateLimitCount})</span></div>
<div class="row"><span>24h RAM min/avg/max</span><span>${observability.summary().ramMiB.min ?? '—'} / ${observability.summary().ramMiB.avg ?? '—'} / ${observability.summary().ramMiB.max ?? '—'} MiB</span></div>
<div class="row"><span>24h CPU min/avg/max</span><span>${observability.summary().cpu.min ?? '—'} / ${observability.summary().cpu.avg ?? '—'} / ${observability.summary().cpu.max ?? '—'}</span></div>
<div class="row"><span>Last activity</span><span>${lastActivity || '—'}</span></div>
<div class="row"><span>Last presence</span><span>${lastPresenceUpdate || '—'}</span></div>
<h2>Recent errors</h2>
<div class="errors">${recentErrors.length === 0 ? '<span class="ok">Không có lỗi</span>' :
  recentErrors.map(e => `<div><b>${e.ts}</b> ${e.msg}</div>`).join('')
}</div>
<p style="color:#555;font-size:.8em">Auto-refresh mỗi 30s</p>
</body></html>`);
});

app.listen(port, '0.0.0.0', () => {
  logger.info(`Web is ready on port ${port}. Endpoints: / /ping /health /ready /incidents /status`);
});

// ---------------------------------------------------------------------------
// Discord client — cache tối thiểu, không gây OOM trên Render free
// ---------------------------------------------------------------------------
const client = new Client({
  checkUpdate: false,
  intents: FULL_OFFICIAL_MODE ? [1, 2] : undefined,
  makeCache: Options.cacheWithLimits({
    ...Options.defaultMakeCacheSettings,
    MessageManager:     RUN_SELF_BOT ? 10 : 0,
    ReactionManager:     0,
    UserManager:       RUN_SELF_BOT ? 500 : 0,
    GuildMemberManager: RUN_SELF_BOT ? 100 : 0,
  }),
  sweepers: {
    ...Options.defaultSweeperSettings,
    messages:  { interval: 180, lifetime: 300 },
    users:     { interval: 3600, filter: () => (u) => u.id !== client.user?.id },
    presences: { interval: 300,  filter: () => (p) => p.userId !== client.user?.id },
  },
  ws: {
    properties: {
      os: 'Windows',
      browser: 'Discord Client',
      release_channel: 'stable',
    },
  },
});

// ---------------------------------------------------------------------------
// Memory management — Chạy êm ái 24/7, tuyệt đối KHÔNG tự động restart hay exit
// ---------------------------------------------------------------------------
const FORCED_GC_MS    = 2 * 60 * 1000;
const HEARTBEAT_MS    = 30 * 60 * 1000;

// Lỗi tích dần → decay nửa mỗi giờ để dashboard không giữ cảnh báo cũ mãi.
const ERROR_DECAY_MS  = 60 * 60 * 1000;

function runGC() {
  if (typeof global.gc === 'function') {
    try { global.gc(); } catch (_) { /* ignore */ }
  }
}

// Error decay — halve mỗi giờ
const errorDecayTimer = setInterval(() => {
  if (errorCount > 0) {
    const before = errorCount;
    errorCount = Math.floor(errorCount / 2);
    logger.info(`[error-decay] ${before} → ${errorCount} (decay mỗi giờ)`);
  }
}, ERROR_DECAY_MS);
errorDecayTimer.unref();

// Heartbeat log nhẹ nhàng mỗi 30 phút
const heartbeatTimer = setInterval(() => {
  const uptimeH = ((Date.now() - processStartTime) / 3_600_000).toFixed(1);
  const { heapUsed, rss } = process.memoryUsage();
  const cleanup = safeCleanup.run();
  if (cleanup.removed > 0) logger.info(`[cleanup] Đã dọn ${cleanup.removed} file tạm (${Math.round(cleanup.bytes / 1024)} KiB).`);
  logger.info(`[heartbeat] uptime=${uptimeH}h discord=${discordReady} heap=${Math.round(heapUsed/1024/1024)}MB rss=${Math.round(rss/1024/1024)}MB`);
}, HEARTBEAT_MS);
heartbeatTimer.unref();

setInterval(runGC, FORCED_GC_MS).unref();

// ---------------------------------------------------------------------------
// starttime.json — không bao giờ ghi đè nếu file đã tồn tại
// ---------------------------------------------------------------------------
const BASELINE_TIMESTAMP = 1785900131700; // Mốc playtime bất biến đã có trong repo.
const UPTIME_BASELINE_TIMESTAMP = 1786448910620; // 431.6h tại 2026-08-29T11:24:30.620Z.

function readTimeState() {
  try {
    if (!fs.existsSync(TIME_FILE)) return {};
    const data = JSON.parse(fs.readFileSync(TIME_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    logger.warn('[timer] Không đọc được starttime.json:', e.message);
    return {};
  }
}

function writeTimeState(patch) {
  const tmp = TIME_FILE + '.tmp';
  try {
    const current = readTimeState();
    fs.writeFileSync(tmp, JSON.stringify({ ...current, ...patch }, null, 2) + '\n');
    fs.renameSync(tmp, TIME_FILE);
  } catch (e) {
    logger.warn('[timer] Không ghi được starttime.json:', e.message);
  }
}

function readTimestampFromFile() {
  const ts = Number(readTimeState().startTimestamp);
  if (Number.isFinite(ts) && ts > 0 && ts <= Date.now() + 60_000) return Math.min(ts, Date.now());
  if (fs.existsSync(TIME_FILE)) {
    logger.warn('[timer] starttime.json có startTimestamp không hợp lệ — không ghi đè mốc cũ.');
  }
  return null;
}

function readTimestampFromEnv() {
  const raw = process.env.SESSION_START_TIMESTAMP;
  if (!raw) return null;
  const ts = Number(raw.trim());
  if (Number.isFinite(ts) && ts > 0 && ts <= Date.now() + 60_000) return Math.min(ts, Date.now());
  logger.warn('[timer] SESSION_START_TIMESTAMP không hợp lệ:', raw);
  return null;
}

function getStartTimestamp() {
  const fromFile = readTimestampFromFile();
  if (fromFile) {
    const hours = Math.floor((Date.now() - fromFile) / 3_600_000);
    logger.info(`[timer] Tiếp tục session — đã chơi ${hours}h (nguồn: file).`);
    return fromFile;
  }
  const fromEnv = readTimestampFromEnv();
  if (fromEnv) {
    const hours = Math.floor((Date.now() - fromEnv) / 3_600_000);
    logger.info(`[timer] Tiếp tục session — đã chơi ${hours}h (nguồn: env).`);
    writeTimestampAtomic(fromEnv);
    return fromEnv;
  }
  const fallbackTs = BASELINE_TIMESTAMP <= Date.now() ? BASELINE_TIMESTAMP : Date.now();
  writeTimestampAtomic(fallbackTs);
  const hours = Math.floor((Date.now() - fallbackTs) / 3_600_000);
  logger.info(`[timer] Dùng mốc thời gian baseline — đã chơi ${hours}h.`);
  return fallbackTs;
}

function getUptimeStartTimestamp() {
  const existing = Number(readTimeState().uptimeStartTimestamp);
  if (Number.isFinite(existing) && existing > 0 && existing <= Date.now() + 60_000) {
    return Math.min(existing, Date.now());
  }

  const fromEnv = Number(process.env.UPTIME_START_TIMESTAMP);
  const candidate = Number.isFinite(fromEnv) && fromEnv > 0
    ? fromEnv
    : UPTIME_BASELINE_TIMESTAMP;
  const baseline = candidate <= Date.now() ? candidate : Math.max(1, Date.now() - 431.6 * 3_600_000);
  writeTimeState({ uptimeStartTimestamp: baseline });
  return baseline;
}

function writeTimestampAtomic(ts) {
  writeTimeState({ startTimestamp: ts });
}

// ---------------------------------------------------------------------------
// Rich Presence — activities & score simulation
// ---------------------------------------------------------------------------

// Score drifts realistically (±200 ~ ±2000 mỗi rotate)
let currentScore = 60_000;
function nextScore() {
  const delta = (Math.random() < 0.5 ? 1 : -1) * Math.floor(Math.random() * 2000 + 200);
  currentScore = Math.max(45_000, Math.min(68_000, currentScore + delta));
  return currentScore.toLocaleString();
}

// Veteran UL79/80 endgame activities — đầy đủ nhất có thể
const DETAILS_STATIC = [
  // Forgery Challenge
  '⚒️ Forgery: Waveworn Residue — Floor 4',
  '⚒️ Forgery: Unending Destruction — Floor 4',
  '⚒️ Forgery: Glacio Mats — Floor 4',
  '⚒️ Forgery: Fusion Mats — Floor 4',
  '⚒️ Forgery: Aero Mats — Floor 4',
  '⚒️ Forgery: Spectro Mats — Floor 4',
  '⚒️ Forgery: Electro Mats — Floor 4',
  '⚒️ Forgery: Havoc Mats — Floor 4',
  // Simulation Training
  '📘 Simulation Training — Rank S',
  '📘 Simulation Training — Echo EXP Run',
  // Tactical Hologram
  '💠 Tactical Hologram — Thundering Mephis Lv.6',
  '💠 Tactical Hologram — Bell-Borne Geochelone Lv.6',
  '💠 Tactical Hologram — Inferno Rider Lv.6',
  '💠 Tactical Hologram — Crownless Lv.6',
  '💠 Tactical Hologram — Impermanence Heron Lv.6',
  '💠 Tactical Hologram — Mourning Aix Lv.6',
  '💠 Tactical Hologram — Mech Abomination Lv.6',
  // Boss hunting (echoes)
  '⚔️ Hunting: Thundering Mephis',
  '⚔️ Hunting: Bell-Borne Geochelone',
  '⚔️ Hunting: Crownless',
  '⚔️ Hunting: Dreamless',
  '⚔️ Hunting: Inferno Rider',
  '⚔️ Hunting: Mech Abomination',
  '⚔️ Hunting: Impermanence Heron',
  '⚔️ Hunting: Tempest Mephis',
  '⚔️ Hunting: Mourning Aix',
  '⚔️ Hunting: Calamity Tacet Discord',
  '⚔️ Hunting: Feilian Beringal',
  '⚔️ Hunting: Lightcrusher',
  '⚔️ Hunting: Havoc Dreadmane',
  '⚔️ Hunting: Glacio Dreadmane',
  // Weekly bosses
  '👑 Weekly: Jué (Aero)',
  '👑 Weekly: Fallacy of No Return',
  '👑 Weekly: Tempest Mephis',
  '👑 Weekly: Dreamless',
  '👑 Weekly: Scar — Crux of Conflict',
  // Tower of Adversity
  '🗼 Tower of Adversity — Storm of Forgery',
  '🗼 Tower of Adversity — Hazard Zone',
  '🗼 Tower of Adversity — Illusive Realm',
  '🗼 Tower of Adversity — Floor 10 ★★★',
  // Depths of Illusive Realm
  '🌀 Depths of Illusive Realm — Floor 12',
  '🌀 Depths of Illusive Realm — Floor 11',
  '🌀 Depths of Illusive Realm — Floor 10',
  // Exploration
  '🗺️ Exploring — Jinzhou',
  '🗺️ Exploring — Mt. Firmament',
  '🗺️ Exploring — Dim Forest',
  '🗺️ Exploring — Black Shores',
  '🗺️ Exploring — Huanglong',
  '🗺️ Exploring — Tethys Deep',
  '🗺️ Exploring — Rinascita',
  '🗺️ Exploring — Ragunna',
  '🗺️ Exploring — Hollow Mirage',
  '🗺️ Exploring — The Desolate Passage',
  '🗺️ Exploring — Elusion Reef',
  '🗺️ Exploring — Midnight Abyss',
  // Echo management
  '🔧 Tuning Echoes — Rolling Substats',
  '🔧 Tuning Echoes — 5★ Cost 4 Set',
  '🔧 Tuning Echoes — 5★ Cost 1 Set',
  '🔧 Checking Echo Loadout',
  '📦 Sorting Inventory',
  '📦 Salvaging Echoes',
  // Daily / misc
  '📋 Daily Tasks',
  '⚡ Spending Waveplates',
  '🔮 Convene — Pulling for Characters',
  '🔮 Convene — Pulling for Weapons',
  '🎯 Grinding for S-Rank Echoes',
  '🏃 Running Tacet Fields',
  '🎪 Event: Limited-Time Challenge',
  '🎪 Event: Gathering of Resonators',
  '🎪 Event: Anniversary Celebration',
  '💬 Chatting in Jinzhou',
  '💬 Hanging out in Ragunna',
  '⏸️ AFK — In Menu',
  '📖 Reading Story Chapter',
  '🎬 Watching Cutscene',
  '🏆 Checking Trophies / Achievements',
  '🛒 Shopping at Illusive Trader',
];

// Endstate Matrix dùng score dynamic riêng
const DETAILS_POOL = [
  ...DETAILS_STATIC,
  // placeholder — replaced at runtime by buildMatrixEntry()
];

const presenceRules = remoteConfig.get().presence;
const presenceEngine = createPresenceEngine(DETAILS_POOL, {
  minRotateMs: Math.max(10, Number(presenceRules.minRotateMinutes) || 10) * 60 * 1000,
  maxRotateMs: Math.max(10, Number(presenceRules.maxRotateMinutes) || 20) * 60 * 1000,
});

function buildMatrixEntry() {
  return `🌊 Endstate Matrix — ${nextScore()} pts`;
}

const STATES_POOL = [
  `${CFG.serverRegion} · UL${CFG.unionLevel} · Farming Echoes`,
  `${CFG.serverRegion} · UL${CFG.unionLevel} · Echo Tuning`,
  `${CFG.serverRegion} · UL${CFG.unionLevel} · Daily Quests`,
  `${CFG.serverRegion} · UL${CFG.unionLevel} · Spending Waveplates`,
  `${CFG.serverRegion} · UL${CFG.unionLevel} · Boss Run`,
  `${CFG.serverRegion} · UL${CFG.unionLevel} · Tower Clear`,
  `${CFG.serverRegion} · UL${CFG.unionLevel} · Exploration`,
  `${CFG.serverRegion} · UL${CFG.unionLevel} · ${CFG.resonatorName} Main`,
  `${CFG.serverRegion} · UL${CFG.unionLevel} · Weekly Done ✓`,
  `${CFG.serverRegion} · UL${CFG.unionLevel} · Pushing Content`,
  `${CFG.serverRegion} · UL${CFG.unionLevel} · S-Rank Grind`,
];

let currentDetails = DETAILS_POOL[0];
let currentState   = STATES_POOL[0];
let currentPresenceCategory = presenceEngine.classify(currentDetails);
let currentPresenceDurationMinutes = 10;

// Rotate mỗi 10–20 phút — nhanh hơn một chút để trông tự nhiên hơn
const ROTATE_MIN_MS = 10 * 60 * 1000;
const ROTATE_MAX_MS = 20 * 60 * 1000;

function scheduleDetailRotation(doSetPresence) {
  if (isNightSaverActive()) {
    setTimeout(() => scheduleDetailRotation(doSetPresence), 15 * 60 * 1000).unref();
    return;
  }
  const next = presenceEngine.next();
  setTimeout(() => {
    currentDetails = Math.random() < 0.20 ? buildMatrixEntry() : next.text;
    currentPresenceCategory = next.category;
    currentPresenceDurationMinutes = next.durationMinutes;
    const state = STATES_POOL[Math.floor(Math.random() * STATES_POOL.length)];
    currentState = state;
    logger.info(`[presence] category=${currentPresenceCategory} duration=${currentPresenceDurationMinutes}m → "${currentDetails}" | "${currentState}"`);
    doSetPresence();
    scheduleDetailRotation(doSetPresence);
  }, next.nextDelayMs);
}

function isSupportedPresenceImage(v) {
  return (
    typeof v === 'string' &&
    (v.startsWith('external/') ||
      v.startsWith('mp:') ||
      /^[0-9]{17,19}$/.test(v) ||
      v.startsWith('https://cdn.discordapp.com/') ||
      v.startsWith('https://media.discordapp.net/'))
  );
}

function buildPresence(startTimestamp, largeAsset, smallAsset) {
  const rpc = new RichPresence(client)
    .setApplicationId(CFG.appId)
    .setType('PLAYING')
    .setName('Wuthering Waves')
    .setDetails(currentDetails)
    .setState(currentState)
    .setStartTimestamp(startTimestamp);

  if (isSupportedPresenceImage(largeAsset)) {
    rpc.setAssetsLargeImage(largeAsset).setAssetsLargeText('Wuthering Waves');
  }
  if (isSupportedPresenceImage(smallAsset)) {
    rpc.setAssetsSmallImage(smallAsset).setAssetsSmallText(`${CFG.resonatorName} · Resonator`);
  }
  return rpc;
}

// Status: 80% dnd, 15% online, 5% idle — mô phỏng người thật
function pickStatus() {
  const r = Math.random();
  if (r < 0.80) return 'dnd';
  if (r < 0.95) return 'online';
  return 'idle';
}

function setPresence(startTimestamp, largeAsset, smallAsset) {
  if (!client.user) return;
  try {
    const rpc = buildPresence(startTimestamp, largeAsset, smallAsset);
    const st = pickStatus();
    if (typeof client.user.setPresence === 'function') {
      client.user.setPresence({ activities: [rpc], status: st });
    } else {
      client.user.setActivity(rpc);
      client.user.setStatus(st);
    }
    lastPresenceUpdate = new Date().toISOString();
    lastActivity = currentDetails;
    logger.info(`[presence] Presence set OK: "${currentDetails}" | status=${st}`);
  } catch (e) {
    errorCount++;
    logger.error('[presence] Không cập nhật được Rich Presence:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Discord events
// ---------------------------------------------------------------------------
let doSetPresence = null;   // giữ ref để resume sau reconnect

client.on('ready', async () => {
  discordReady = true;
  lastReadyAt = Date.now();
  lastDisconnectAt = null;
  timeline.record('DISCORD_READY', 'Selfbot Gateway ready');
  loginAttempt = 0;
  logger.info(`[discord] Đã đăng nhập tài khoản: ${client.user.tag} (id: ${client.user.id})`);

  sessionStartTimestamp = getStartTimestamp();

  let largeAsset = null;
  let smallAsset = null;

  // 1. Kích hoạt presence NGAY LẬP TỨC — không chờ bất kỳ request external asset nào
  doSetPresence = () => setPresence(sessionStartTimestamp, largeAsset, smallAsset);
  doSetPresence();
  logger.info('[presence] Rich Presence đã kích hoạt thành công trên Discord!');

  scheduleDetailRotation(doSetPresence);

  // 2. Tải external assets chạy ngầm (timeout 5s), nếu xong thì cập nhật lại assets
  Promise.race([
    RichPresence.getExternal(client, CFG.appId, CFG.largeImg, CFG.smallImg),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Asset fetch timeout (5s)')), 5000)),
  ])
    .then((assets) => {
      if (Array.isArray(assets)) {
        if (isSupportedPresenceImage(assets[0]?.external_asset_path))
          largeAsset = assets[0].external_asset_path;
        if (isSupportedPresenceImage(assets[1]?.external_asset_path))
          smallAsset = assets[1].external_asset_path;
        logger.info('[presence] External assets loaded OK, updating assets...');
        doSetPresence();
      }
    })
    .catch((e) => {
      logger.warn('[presence] Chạy với presence cơ bản (không ảnh):', e.message);
    });
});

// Reconnect sau mất kết nối — presence tự phục hồi qua ready event
client.on('disconnect', () => {
  discordReady = false;
  lastDisconnectAt = Date.now();
  timeline.record('DISCORD_OFFLINE', 'Gateway disconnected');
  // Dọn cache khi offline để tiết kiệm RAM trong lúc reconnect
  clearTransientCaches();
  observability.recordReconnect();
  logger.warn('[discord] Mất kết nối — thư viện đang tự reconnect...');
});

// Token bị Discord thu hồi hoặc session hết hạn
client.on('invalidated', () => {
  discordReady = false;
  logger.error('[discord] Session bị Discord invalidate. Thử đăng nhập lại sau 30s...');
  clearTransientCaches();
  if (RUN_DISCORD) {
    clearTimeout(loginRetryTimer);
    loginRetryTimer = setTimeout(loginWithRetry, 30_000);
  }
});

// Shard lỗi transport
client.on('shardError', (error) => {
  errorCount++;
  logger.error('[shard] Shard error:', error.message);
  logger.info('[shard] Không tự thoát; để thư viện tự reconnect và giữ nguyên bộ đếm uptime/playtime.');
});

// Rate limit — log nhưng không coi là error (Discord đang throttle, bình thường)
client.on('rateLimit', (info) => {
  rateLimitCount++;
  observability.recordRateLimit();
  timeline.record('RATE_LIMIT', `Discord rate limit ${info?.route || 'gateway'}`);
  logger.info(`[rateLimit] #${rateLimitCount} route=${info.route} timeout=${info.timeout}ms — Discord đang điều tiết, không phải lỗi ứng dụng.`);
});

client.on('error', (error) => {
  errorCount++;
  logger.error('[discord] Client error:', error.message);
});

// ---------------------------------------------------------------------------
// Process-level error guards
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  errorCount++;
  logger.error('[process] Unhandled rejection:', String(reason));
});

process.on('uncaughtException', (err) => {
  errorCount++;
  logger.error('[process] Uncaught exception:', err.message);
  // Không exit — chỉ log; watchdog bắt nếu thực sự critical
});

process.on('SIGTERM', () => {
  logger.info('[process] Nhận SIGTERM — tắt gọn để Render deploy bản mới.');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('[process] Nhận SIGINT — dừng debug local.');
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Login với exponential back-off
// ---------------------------------------------------------------------------
async function verifyUserToken(token) {
  try {
    const res = await restGovernor.request('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: token, 'Content-Type': 'application/json' },
    }, '/users/@me');
    if (res.ok) {
      const user = await res.json();
      return { ok: true, user };
    }
    const text = await res.text().catch(() => '');
    const retryHeader = Number(res.headers.get('retry-after') || res.headers.get('x-ratelimit-reset-after')) * 1000;
    let bodyRetry = null;
    try {
      const b = JSON.parse(text);
      if (Number.isFinite(Number(b.retry_after))) bodyRetry = Number(b.retry_after) * 1000;
    } catch (_) {}
    const retryAfter = Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : bodyRetry;
    return { ok: false, status: res.status, text, retryAfter };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function loginWithRetry() {
  lastLoginStartedAt = Date.now();
  if (!RUN_SELF_BOT) {
    logger.info(`[login] Bỏ qua selfbot gateway${FULL_OFFICIAL_MODE ? '; Full Official Mode đang bật' : '; runtime Discord đang tắt'}.`);
    return;
  }

  if (!DISCORD_TOKEN) {
    logger.error('[login] Thiếu secret TOKEN_DISCORD — không thể đăng nhập.');
    return;
  }

  const token = DISCORD_TOKEN
    .trim()
    .replace(/^(?:Bot|Bearer)\s+/i, '')
    .replace(/^(['"])(.*)\1$/s, '$2')
    .trim();

  if (!token) {
    logger.error('[login] Secret TOKEN_DISCORD đang rỗng.');
    return;
  }

  if (BOT_TOKEN && token === BOT_TOKEN.trim()) {
    logger.warn('⚠️ [login] CẢNH BÁO: TOKEN_DISCORD đang dùng chung giá trị với BOT_TOKEN!');
    logger.warn('⚠️ [login] Treo game Rich Presence cần USER TOKEN (tài khoản cá nhân Discord). Bot Token không thể treo Rich Presence!');
  }

  logger.info('[login] Kiểm tra mã Token trên Discord API...');
  const verify = await verifyUserToken(token);
  if (verify.ok) {
    logger.info(`✅ [login] Token hợp lệ cho tài khoản: ${verify.user.username}#${verify.user.discriminator || '0'} (id: ${verify.user.id})`);
  } else if (verify.status === 401) {
    logger.error('❌ [login] TOKEN_DISCORD KHÔNG HỢP LỆ (HTTP 401 Unauthorized)! Discord đã thu hồi token này.');
    logger.error('❌ [login] Hãy mở DevTools F12 trên Discord web/app lấy lại Token mới (Lưu ý: Không bấm Log Out trên web sau khi lấy token).');
    discordReady = false;
    return;
  } else if (verify.status === 429) {
    loginAttempt++;
    const waitMs = Math.max(1_000, Number(verify.retryAfter) || 15 * 60 * 1000);
    logger.info(`🛡️ [login] Discord đang rate-limit; tạm dừng ${Math.ceil(waitMs / 1000)}s (lần ${loginAttempt}), không ghi là lỗi.`);
    clearTimeout(loginRetryTimer);
    loginRetryTimer = setTimeout(loginWithRetry, waitMs);
    return;
  } else {
    logger.warn(`[login] Kiểm tra token trả về ${verify.status || verify.error} — tiếp tục thử kết nối Gateway...`);
  }

  logger.info('[login] Đang đăng nhập Discord Gateway...');
  try {
    const loginPromise = client.login(token);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Discord Gateway connection timeout (45s).')), 45_000)
    );
    await Promise.race([loginPromise, timeoutPromise]);
    logger.info('[login] Hàm client.login đã hoàn tất!');
  } catch (error) {
    discordReady = false;
    logger.error('[login] Login thất bại:', error.message);

    loginAttempt++;
    const delay = Math.min(120_000, 15_000 * 2 ** Math.min(loginAttempt - 1, 3));
    logger.warn(`[login] Thử lại sau ${Math.round(delay / 1000)}s (lần ${loginAttempt}).`);
    clearTimeout(loginRetryTimer);
    loginRetryTimer = setTimeout(loginWithRetry, delay);
  }
}

// ---------------------------------------------------------------------------
// Startup summary
// ---------------------------------------------------------------------------
function printStartupSummary() {
  const mem = process.memoryUsage();
  const hasToken  = !!DISCORD_TOKEN;
  const hasFileTs = (() => {
    try {
      const d = JSON.parse(fs.readFileSync(TIME_FILE, 'utf8'));
      return Number.isFinite(Number(d.startTimestamp));
    } catch { return false; }
  })();

  logger.info('════════════════════════════════════════════');
  logger.info('  Treo Wuthering Waves — startup check      ');
  logger.info('════════════════════════════════════════════');
  logger.info(`  Node          : ${process.version}`);
  logger.info(`  TOKEN_DISCORD : ${hasToken   ? '✅ có'  : '❌ THIẾU'}`);
  logger.info(`  Runtime       : ${RUN_DISCORD ? 'Discord gateway bật' : 'Discord gateway tắt'}`);
  logger.info(`  Timer session : ${hasFileTs  ? '✅ starttime.json' : '✅ Mốc tự động'}`);
  logger.info(`  Resonator     : ${CFG.resonatorName} | ${CFG.serverRegion} UL${CFG.unionLevel}`);
  logger.info(`  Heap limit    : Render cgroup 512MiB (đọc trực tiếp memory.current)`);
  logger.info(`  Heap now      : ${Math.round(mem.heapUsed/1024/1024)}MB`);
  logger.info(`  Activities    : ${DETAILS_POOL.length + 5} items | rotate mỗi 10–20 phút`);
  logger.info(`  Monitor       : REST có backoff, global cooldown và không retry mù khi 429`);
  logger.info(`  Tự dọn dẹp    : ÷2 tích lũy mỗi giờ`);
  logger.info('════════════════════════════════════════════');
}

// ---------------------------------------------------------------------------
// 🔔 Discord Log Bot — BOT THẬT riêng (khác tài khoản selfbot rich-presence ở trên)
// Mỗi MONITOR_INTERVAL_MS sẽ tự ping /health của chính web này (web2),
// rồi gửi/cập nhật trạng thái vào 1 kênh Discord đã cấu hình.
// - Không lỗi   -> chỉ edit 1 message trạng thái duy nhất, không spam kênh.
// - Có lỗi mới  -> gửi thêm 1 message mới kèm log lỗi để user copy.
// Cấu hình qua env: BOT_TOKEN, LOG_CHANNEL_ID, (tuỳ chọn) STATUS_URL, MONITOR_INTERVAL_MS
// ---------------------------------------------------------------------------
const BOT_TOKEN           = process.env.BOT_TOKEN || null;
const REMOTE_FEATURES     = remoteConfig.get().features;
const OFFICIAL_BOT_MODE   = process.env.OFFICIAL_BOT_MODE !== 'false' && REMOTE_FEATURES.officialBot !== false;
const REMOTE_CHANNELS     = remoteConfig.get().channels;
const LOG_CHANNEL_ID      = process.env.LOG_CHANNEL_ID || REMOTE_CHANNELS.log;

const restGovernor = new RestTrafficGovernor({ maxPerSecond: 4, burst: 2, maxFailures: 3, circuitMs: 60_000 });
const MONITOR_INTERVAL_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.MONITOR_INTERVAL_MS) || 5 * 60 * 1000,
);
// Mặc định tự ping chính process qua localhost (nhanh, không lệ thuộc mạng ngoài).
// Có thể đổi sang URL public qua env STATUS_URL, ví dụ:
// https://treo-wuthering-waves.onrender.com/health
const STATUS_URL = process.env.STATUS_URL || `http://127.0.0.1:${port}/health`;

let statusMessageId    = null;   // message trạng thái được edit liên tục, không tạo message mới mỗi lần
let monitorInFlight    = false;
let monitorRateLimitedUntil = 0;

function isDiscordRateLimitError(error) {
  return error?.name === 'DiscordRateLimitError';
}

async function discordApi(pathSuffix, options = {}) {
  const retryDelays = [2_000, 5_000, 15_000];
  for (let attempt = 0; ; attempt += 1) {
    const res = await restGovernor.request(
      `https://discord.com/api/v10${pathSuffix}`,
      { ...options, headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json', ...(options.headers || {}) } },
      pathSuffix,
    );
    if (res.ok) return res.status === 204 ? null : res.json();
    const text = await res.text().catch(() => '');
    if (![502, 503, 504].includes(res.status) || attempt >= retryDelays.length) {
      throw new Error(`Discord API ${res.status}: ${text.slice(0, 300)}`);
    }
    const waitMs = retryDelays[attempt];
    logger.info(`[discord-api] ${res.status} ${pathSuffix} — retry sau ${Math.ceil(waitMs / 1000)}s`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

// ---------------------------------------------------------------------------
// 👋 Chào mừng / Tạm biệt — tự ping khi có member vào hoặc rồi server.
// Dùng CHÍNH client selfbot đã đăng nhập ở trên để BẮT sự kiện (không thêm
// client/gateway mới, KHÔNG động gì tới logic auto treo game), rồi gửi
// embed đẹp qua BOT_TOKEN (REST) vào đúng kênh.
// CÓ HÀNG ĐỮ (QUEUE) + GIỚI HẠN TẦN SUẤT: nếu join/rời liên tục/dồn dập
// (ví dụ do selfbot re-sync member list khi reconnect), sự kiện sẽ được
// xếp hàng và gởi RA TỪNG CÁI, cch nhau tối thiểu WELCOME_THROTTLE_MS
// (mặc định 30 phút) — tránh spam/lag kênh dù join "ảo" hay thật.
// Env: WELCOME_CHANNEL_ID (mặc định = kênh chào-mừng có sẵn),
//      GOODBYE_CHANNEL_ID (điền sau khi chạy apply tạo kênh tạm-biệt xong),
//      WELCOME_THROTTLE_MS (mặc định 1800000 = 30 phút).
// ---------------------------------------------------------------------------
const WELCOME_CHANNEL_ID   = process.env.WELCOME_CHANNEL_ID || REMOTE_CHANNELS.welcome || '1484731010448097520';
const GOODBYE_CHANNEL_ID   = process.env.GOODBYE_CHANNEL_ID || process.env.WELCOME_CHANNEL_ID || REMOTE_CHANNELS.goodbye || '1484731010448097520';
const WELCOME_THROTTLE_MS  = Math.max(
  30 * 60 * 1000,
  Number(process.env.WELCOME_THROTTLE_MS) || 30 * 60 * 1000,
); // 30 phut
const FAKE_MEMBER_OFFSET   = Number(process.env.FAKE_MEMBER_OFFSET) || 0; // Mặc định hiển thị số member thật
const DISABLE_WELCOME       = process.env.DISABLE_WELCOME === 'true' || REMOTE_FEATURES.welcome === false;
const DISABLE_GOODBYE       = process.env.DISABLE_GOODBYE === 'true' || REMOTE_FEATURES.goodbye === false;

function getSpoofedMemberCount(guild) {
  const realCount = Number(guild?.memberCount) || 1;
  return (realCount + FAKE_MEMBER_OFFSET).toLocaleString('vi-VN');
}

function buildWelcomeEmbed(member) {
  const tag = member?.user?.tag || member?.user?.username || String(member?.id || '');
  const avatar = typeof member?.user?.displayAvatarURL === 'function' ? member.user.displayAvatarURL() : undefined;
  return {
    title: '👋 Thành viên mới!',
    description: `Chào mừng <@${member.id}> đã đặt chân vào server! 🎉`,
    color: 0x2ecc71,
    thumbnail: avatar ? { url: avatar } : undefined,
    fields: [
      { name: '👤 Tài khoản', value: tag, inline: true },
      { name: '👥 Tổng thành viên', value: getSpoofedMemberCount(member?.guild), inline: true },
    ],
    timestamp: new Date().toISOString(),
  };
}

function buildGoodbyeEmbed(member) {
  const tag = member?.user?.tag || member?.user?.username || String(member?.id || '');
  const avatar = typeof member?.user?.displayAvatarURL === 'function' ? member.user.displayAvatarURL() : undefined;
  return {
    title: '💨 Có người rời đi...',
    description: `**${tag}** đã rời server. Hẹn gặp lại! 👋`,
    color: 0xe74c3c,
    thumbnail: avatar ? { url: avatar } : undefined,
    fields: [
      { name: '👥 Tổng thành viên còn lại', value: getSpoofedMemberCount(member?.guild), inline: true },
    ],
    timestamp: new Date().toISOString(),
  };
}

// Hàng đợi chung cho cả join và rời — giữ đúng thứ tự xảy ra, gởi ra
// từng cái mỗi WELCOME_THROTTLE_MS để không dồn dập làm lag kênh.
const welcomeQueue = [];
const MAX_WELCOME_QUEUE = 100;
let lastWelcomeSentAt = 0;
let welcomeTimerRunning = false;

function queueWelcomeEvent(type, member) {
  if (!BOT_TOKEN) return;
  if (isNightSaverActive() || (type === 'join' && DISABLE_WELCOME) || (type === 'leave' && DISABLE_GOODBYE)) return;
  const memberId = String(member?.id || 'unknown');
  const duplicate = welcomeQueue.some((item) => item.type === type && String(item.member?.id || '') === memberId);
  if (duplicate) return;
  if (welcomeQueue.length >= MAX_WELCOME_QUEUE) {
    logger.info(`[welcome] Queue đã đầy (${MAX_WELCOME_QUEUE}); bỏ qua event ${type} trùng/nhầm do reconnect.`);
    return;
  }
  welcomeQueue.push({ type, member });
  processWelcomeQueue();
}

async function processWelcomeQueue() {
  if (welcomeTimerRunning) return; // tranh chay song song nhieu vong
  welcomeTimerRunning = true;
  try {
    while (welcomeQueue.length > 0) {
      const waitLeft = lastWelcomeSentAt ? WELCOME_THROTTLE_MS - (Date.now() - lastWelcomeSentAt) : 0;
      if (waitLeft > 0) {
        await new Promise((r) => setTimeout(r, Math.min(waitLeft, 60_000)));
        continue; // kiem tra lai sau moi lan doi toi da 60s, tranh block qua lau 1 lan
      }
      const item = welcomeQueue.shift();
      try {
        if (item.type === 'join' && WELCOME_CHANNEL_ID) {
          const embed = buildWelcomeEmbed(item.member);
          if (officialBot) await officialBot.sendEmbed(WELCOME_CHANNEL_ID, embed);
          else await discordApi(`/channels/${WELCOME_CHANNEL_ID}/messages`, { method: 'POST', body: JSON.stringify({ embeds: [embed] }) });
        } else if (item.type === 'leave' && GOODBYE_CHANNEL_ID) {
          const embed = buildGoodbyeEmbed(item.member);
          if (officialBot) await officialBot.sendEmbed(GOODBYE_CHANNEL_ID, embed);
          else await discordApi(`/channels/${GOODBYE_CHANNEL_ID}/messages`, { method: 'POST', body: JSON.stringify({ embeds: [embed] }) });
        }
        lastWelcomeSentAt = Date.now();
      } catch (e) {
        if (isDiscordRateLimitError(e)) {
          welcomeQueue.unshift(item);
          lastWelcomeSentAt = Date.now();
          logger.info(`[welcome] Discord đang throttle; giữ sự kiện ${item.type} trong queue để gửi lại sau ${Math.ceil(e.retryAfterMs / 1000)}s.`);
          await new Promise((r) => setTimeout(r, Math.min(e.retryAfterMs, 24 * 60 * 60 * 1000)));
          continue;
        }
        errorCount++;
        logger.error(`[welcome] Loi gui ${item.type === 'join' ? 'chao mung' : 'tam biet'}:`, e.message);
        lastWelcomeSentAt = Date.now();
      }
    }
  } finally {
    welcomeTimerRunning = false;
  }
}

if (!OFFICIAL_BOT_MODE || !BOT_TOKEN) client.on('guildMemberAdd', (member) => {
  if (!BOT_TOKEN || !WELCOME_CHANNEL_ID) return;
  queueWelcomeEvent('join', member);
});

if (!OFFICIAL_BOT_MODE || !BOT_TOKEN) client.on('guildMemberRemove', (member) => {
  if (!BOT_TOKEN || !GOODBYE_CHANNEL_ID) return;
  queueWelcomeEvent('leave', member);
});

const COMMANDS = [
  { name: 'create', description: 'Mở bảng chọn game và tùy chỉnh status cá nhân' },
  { name: 'status', description: 'Xem trạng thái bot và tài nguyên Render' },
  { name: 'incidents', description: 'Xem incident trong 24 giờ' },
  { name: 'presence', description: 'Xem activity hiện tại' },
  { name: 'maintenance', description: 'Bật/tắt maintenance mode (admin)' },
  { name: 'token', description: '🔐 Lưu User Token Discord của bạn để dùng /auto-orb (ephemeral — chỉ bạn thấy)' },
  { name: 'auto-orb', description: '🔮 Tự động hoàn thành tất cả Discord Quests và nhận Orbs' },
  { name: 'starstat', description: '🌟 Xem trạng thái hệ thống đẹp với màu động và icon Wuthering Waves' },
];
const ADMIN_USER_IDS = new Set(String(process.env.ADMIN_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
  const officialBot = OFFICIAL_BOT_MODE && BOT_TOKEN

  ? createOfficialBot({
      token: BOT_TOKEN,
      logChannelId: LOG_CHANNEL_ID,
      welcomeChannelId: DISABLE_WELCOME ? null : WELCOME_CHANNEL_ID,
      goodbyeChannelId: DISABLE_GOODBYE ? null : GOODBYE_CHANNEL_ID,
      memberEvents: process.env.ENABLE_MEMBER_EVENTS === 'true',
      onMemberJoin: (member) => queueWelcomeEvent('join', member),
      onMemberLeave: (member) => queueWelcomeEvent('leave', member),
      commands: COMMANDS,
      onInteraction: async (interaction) => {
        if (interaction.isButton?.() && interaction.customId === 'game:change') {
          return interaction.reply({ content: `🎮 **Chọn game** · ${GAME_PRESETS.length} preset gacha demo`, components: gameSelectComponents(), ephemeral: true });
        }
        if (interaction.isButton?.() && interaction.customId === 'game:customize') return interaction.showModal(customizeModal());
        if (interaction.isStringSelectMenu?.() && interaction.customId === 'game:select') {
          const profile = gameProfiles.set(interaction.user.id, normalizeProfile({ gameId: interaction.values[0] }));
          return interaction.update({ content: `✅ Đã lưu cấu hình riêng cho bạn.\n\n${previewText(profile)}\n\n⚠️ Đây là profile cá nhân; không ghi đè status của user khác.`, components: [] });
        }
        if (interaction.isModalSubmit?.() && interaction.customId === 'game:customize_modal') {
          const profile = gameProfiles.set(interaction.user.id, {
            gameId: interaction.fields.getTextInputValue('game_id'),
            status: interaction.fields.getTextInputValue('status'),
            durationMinutes: interaction.fields.getTextInputValue('duration'),
            largeImageUrl: interaction.fields.getTextInputValue('large_image'),
            smallImageUrl: interaction.fields.getTextInputValue('small_image'),
          });
          return interaction.reply({ content: `✅ Đã lưu tùy chỉnh riêng của bạn.\n\n${previewText(profile)}\n\n📌 URL phải là HTTPS; ảnh chỉ được Discord tải khi hiển thị.`, ephemeral: true });
        }
        // Modal submit — lưu user token
        if (interaction.isModalSubmit?.() && interaction.customId === 'quest:token_modal') {
          const rawToken = (interaction.fields.getTextInputValue('user_token_input') || '').trim();
          // Kiểm tra token hợp lệ qua API trước khi lưu
          await interaction.deferReply({ ephemeral: true });
          try {
            const verifyResult = await verifyUserToken(rawToken);
            if (!verifyResult.ok) {
              return interaction.editReply({ content: `❌ Token không hợp lệ (${verifyResult.status ?? verifyResult.error ?? 'unknown'}).\nHãy lấy lại token từ DevTools F12 và thử lại.` });
            }
            userTokenStore.set(interaction.user.id, rawToken);
            logger.info(`[token-store] Đã lưu token cho user ${interaction.user.id} (${verifyResult.user?.username ?? '?'})`);
            return interaction.editReply({ content: `✅ Token của **${verifyResult.user?.username ?? 'bạn'}** đã được lưu thành công!\n🔐 Token được mã hóa AES-256 — không ai có thể đọc kể cả admin.\n\n🔮 Dùng \`/auto-orb\` để tự động nhận Orbs, \`/starstat\` để xem số dư Orbs!` });
          } catch (err) {
            logger.error('[token-store] Lỗi verify/lưu token:', err.message);
            return interaction.editReply({ content: `❌ Lỗi khi xác minh token: ${err.message.slice(0, 100)}` });
          }
        }
        if (!interaction.isChatInputCommand?.()) return;
        if (interaction.commandName === 'create') return interaction.reply({ content: '🌌 **Treo Game Studio**\nChọn game hoặc tùy chỉnh profile cá nhân. Phản hồi này chỉ bạn nhìn thấy.', components: panelComponents(), ephemeral: true });

        if (interaction.commandName === 'status') {
          const response = await fetch(STATUS_URL, { signal: AbortSignal.timeout(8_000) });
          const health = await response.json();
          return interaction.reply({ embeds: [buildStatusEmbed(health)], ephemeral: true });
        }
        if (interaction.commandName === 'incidents') {
          const digest = buildIncidentDigest(timeline.recent(50));
          return interaction.reply({ content: `${digest.text}\n${digest.events.map((e) => `• ${e.code}: ${e.message}`).join('\n') || 'Không có incident mới.'}`, ephemeral: true });
        }
        if (interaction.commandName === 'presence') {
          return interaction.reply({ content: `🎮 ${currentDetails}\n🏷️ ${currentPresenceCategory} · ⏱️ ${currentPresenceDurationMinutes} phút`, ephemeral: true });
        }
        if (interaction.commandName === 'maintenance') {
          if (!ADMIN_USER_IDS.has(interaction.user.id)) return interaction.reply({ content: '⛔ Bạn không có quyền dùng lệnh này.', ephemeral: true });
          maintenanceMode = !maintenanceMode;
          timeline.record('MAINTENANCE', maintenanceMode ? 'Maintenance bật' : 'Maintenance tắt');
          return interaction.reply({ content: maintenanceMode ? '🛠️ Maintenance mode đã bật.' : '✅ Maintenance mode đã tắt.', ephemeral: true });
        }

        // ── /token ──────────────────────────────────────────────────────────
        if (interaction.commandName === 'token') {
          return interaction.showModal({
            custom_id: 'quest:token_modal',
            title: '🔐 Lưu User Token Discord',
            components: [{
              type: 1,
              components: [{
                type: 4,
                custom_id: 'user_token_input',
                label: 'Dán User Token của bạn vào đây',
                style: 2,
                min_length: 50,
                max_length: 200,
                placeholder: 'Token tài khoản Discord (lấy từ DevTools F12 → Network → Authorization)',
                required: true,
              }],
            }],
          });
        }

        // ── /auto-orb ────────────────────────────────────────────────────────
        if (interaction.commandName === 'auto-orb') {
          const userId = interaction.user.id;
          if (!userTokenStore.has(userId)) {
            return interaction.reply({ content: '❌ Bạn chưa lưu token. Hãy dùng `/token` trước để đăng ký.', flags: 64 });
          }
          await interaction.deferReply({ flags: 64 });
          try {
            const plainToken = userTokenStore.get(userId);
            if (!plainToken) throw new Error('Không thể giải mã token. Hãy thử /token lại.');
            const result = await runQuestsForUser(plainToken);
            const orbStr = result.orbsAfter !== null ? `🔮 **${result.orbsAfter} Orbs**` : '🔮 Orbs: —';
            const gainStr = result.orbsGained > 0 ? ` (+${result.orbsGained})` : '';
            let questLines = '';
            if (result.allCaughtUp) {
              questLines = result.quests.map((q) => {
                const icon = q.status === 'claimed' ? '★' : q.status === 'done' ? '✔' : q.status === 'expired' ? '⏰' : '⏳';
                return `${icon} **${q.name.slice(0, 36)}** · ${q.reward}`;
              }).join('\n') || 'Không có quest nào.';
            } else {
              questLines = result.quests.map((q) => {
                const icon = q.status === 'claimed' ? '✅' : '❌';
                return `${icon} **${q.name.slice(0, 36)}** · ${q.reward}${q.error ? `\n  ⚠️ ${q.error}` : ''}`;
              }).join('\n') || 'Không có quest nào.';
            }
            const embed = {
              title: result.allCaughtUp ? '🌊 Auto Orb — Tất cả đã nhận! ✨' : '🔮 Auto Orb — Hoàn thành!',
              color: result.allCaughtUp ? 0x6c5ce7 : (result.quests.some((q) => q.status === 'failed') ? 0xff6b6b : 0x00b894),
              description: `👤 **${result.username}** · ${orbStr}${gainStr}${result.allCaughtUp ? '\n\n✨ Không có quest chờ xử lý — đã nhận hết Orbs!' : ''}`,
              fields: [{ name: '📋 Danh sách Quests', value: questLines.slice(0, 1024) || '—', inline: false }],
              footer: { text: `Wuthering Waves Bot · Auto Quest · ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}` },
              thumbnail: CFG.statusGif ? { url: CFG.statusGif } : undefined,
            };
            return interaction.editReply({ embeds: [embed] });
          } catch (err) {
            logger.error('[auto-orb] Lỗi khi chạy quest:', err.message);
            return interaction.editReply({ content: `❌ Lỗi khi chạy auto quest: ${String(err.message).slice(0, 150)}\n\nGợi ý: Token có thể đã hết hạn, hãy dùng \`/token\` để cập nhật lại.` });
          }
        }

        // ── /starstat ────────────────────────────────────────────────────────
        if (interaction.commandName === 'starstat') {
          await interaction.deferReply({ flags: 64 });
          try {
            const response = await fetch(STATUS_URL, { signal: AbortSignal.timeout(8_000) });
            const health = await response.json();
            const mem = getRealRenderRam();
            const ramRatio = mem.limitBytes > 0 ? mem.bytes / mem.limitBytes : 0;
            const score = health.healthScore?.score ?? 0;
            const scoreColor = score >= 80 ? 0x00b894 : score >= 50 ? 0xfdcb6e : 0xff6b6b;
            const scoreEmoji = score >= 80 ? '🟢' : score >= 50 ? '🟡' : '🔴';
            const uptimeH = uptimeStartTimestamp ? ((Date.now() - uptimeStartTimestamp) / 3_600_000).toFixed(1) : '?';
            const playtimeH = sessionStartTimestamp ? ((Date.now() - sessionStartTimestamp) / 3_600_000).toFixed(1) : '—';
            const digest = buildIncidentDigest(timeline.recent(50));
            const ramBar = progressBar(ramRatio, 12);
            const cpuVal = getCpuUsageDetail();
            const realHeapMb = process.memoryUsage().heapUsed / 1_048_576;
            const userId = interaction.user.id;
            let orbLine = '';
            if (userTokenStore.has(userId)) {
              try {
                const tok = userTokenStore.get(userId);
                const bal = await getOrbBalance(tok);
                orbLine = `\n🔮 **Orbs của bạn:** ${bal.orbs ?? '—'} · ${bal.username}`;
              } catch { orbLine = '\n🔮 **Orbs:** không lấy được (token hết hạn?)'; }
            }
            const starEmbed = {
              title: '🌟 Wuthering Waves · StarStat',
              color: scoreColor,
              description: `🌌 **Live Operations Console** · Render Free 24/7\n${scoreEmoji} Health Score: **${score}/100 · ${health.healthScore?.level ?? 'UNKNOWN'}**${orbLine}`,
              author: { name: 'WW StarStat · Render 24/7', icon_url: CFG.smallImg },
              thumbnail: CFG.statusGif ? { url: CFG.statusGif } : undefined,
              fields: [
                {
                  name: '🎮 Selfbot · Rich Presence',
                  value: `${(health.discordReady || health.officialBotReady) ? '🟢 Online' : '🔴 Offline'} · **${playtimeH}h** playtime\n${CFG.resonatorName} | ${CFG.serverRegion} UL${CFG.unionLevel}\n🏷️ **${health.presence?.category ?? 'farming'}** · ⏱️ ${health.presence?.durationMinutes ?? '—'}m\n📝 ${currentDetails.slice(0, 50)}`,
                  inline: true,
                },
                {
                  name: '💾 Tài Nguyên Render',
                  value: `RAM: **${formatMiB(mem.mib)}/${formatMiB(mem.limitBytes / 1_048_576)} MiB**\n${ramBar} ${(ramRatio * 100).toFixed(1)}% ${health.trends?.ram ?? '→'}\nCPU: **${cpuVal}** ${health.trends?.cpu ?? '→'}\nHeap: **${formatMiB(realHeapMb)} MiB** ${health.trends?.heap ?? '→'}\n⏱️ Uptime: **${uptimeH}h**`,
                  inline: true,
                },
                {
                  name: `${digest.icon} Incidents · ${digest.level}`,
                  value: `${digest.text}\n${isNightSaverActive() ? '🌙 Night Saver ON' : maintenanceMode ? '🛠️ Maintenance' : '☀️ Normal'}\n📦 ${health.budgetHud ?? '—'}`,
                  inline: false,
                },
                {
                  name: '📈 24h Stats',
                  value: `RAM: ${health.observability?.ramMiB?.min ?? '—'} / ${health.observability?.ramMiB?.avg ?? '—'} / ${health.observability?.ramMiB?.max ?? '—'} MiB\nCPU: ${health.observability?.cpu?.min ?? '—'} / ${health.observability?.cpu?.avg ?? '—'} / ${health.observability?.cpu?.max ?? '—'}\n🔄 Reconnects: ${health.observability?.reconnects ?? 0} · ⚡ Rate-limits: ${health.observability?.rateLimits ?? 0}`,
                  inline: false,
                },
              ],
              footer: { text: `Cập nhật lúc ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} · /token để xem Orbs của bạn` },
            };
            return interaction.editReply({ embeds: [starEmbed] });
          } catch (err) {
            logger.error('[starstat] Lỗi:', err.message);
            return interaction.editReply({ content: `❌ Không lấy được dữ liệu: ${err.message}` });
          }
        }
      },
      onError: (error) => {
        const message = String(error?.message || error);
        if (message.includes('disallowed intents') || error?.code === 4014) logger.warn('[official-bot] GuildMembers intent chưa được bật; bot log vẫn có thể chạy, welcome/goodbye member events đang tắt.');
        else { errorCount++; logger.error('[official-bot] Client error:', message); }
      },
    })
  : null;

if (BOT_TOKEN && !DISABLE_WELCOME && !DISABLE_GOODBYE && (WELCOME_CHANNEL_ID || GOODBYE_CHANNEL_ID)) {
  logger.info(`[welcome] Da bat ping chao mung / tam biet & bug mem ao (+${FAKE_MEMBER_OFFSET}) (toi da 1 tin moi ${Math.round(WELCOME_THROTTLE_MS / 60000)} phut).`);
} else {
  logger.info('[welcome] Bỏ qua welcome/goodbye vì chưa cấu hình BOT_TOKEN hoặc channel.');
}

uptimeStartTimestamp = getUptimeStartTimestamp();
processStartTime = uptimeStartTimestamp;
logger.info(`[timer] Tiếp tục uptime — đã chạy ${((Date.now() - uptimeStartTimestamp) / 3_600_000).toFixed(1)}h (nguồn: starttime.json).`);

function sendLogEmbed(embed) {
  if (officialBot) return officialBot.sendEmbed(LOG_CHANNEL_ID, embed, panelComponents());
  return discordApi(`/channels/${LOG_CHANNEL_ID}/messages`, { method: 'POST', body: JSON.stringify({ embeds: [embed] }) });
}

function editLogEmbed(messageId, embed) {
  if (officialBot) return officialBot.editEmbed(LOG_CHANNEL_ID, messageId, embed, panelComponents());
  return discordApi(`/channels/${LOG_CHANNEL_ID}/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify({ embeds: [embed] }) });
}

// Embed đầy đủ thông tin — giống hệt các dòng hiển thị trên trang /status,
// không phải 1 câu ngắn gọn nhàm chán. Khung "Recent errors" màu đen chỉ
// hiện log lỗi khi CÓ lỗi; không có lỗi thì chỉ ghi "Không có lỗi".
let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();
let lastCgroupCpuUsageUs = null;
let lastCgroupCpuTime = Date.now();
let cachedCpuValue = '0.0000';

function readCgroupCpuUsageUs() {
  try {
    const cpuStatPath = '/sys/fs/cgroup/cpu.stat';
    if (!fs.existsSync(cpuStatPath)) return null;
    const stat = fs.readFileSync(cpuStatPath, 'utf8').match(/^usage_usec\s+(\d+)/m);
    const usageUs = Number(stat?.[1]);
    return Number.isFinite(usageUs) ? usageUs : null;
  } catch (_) {
    return null;
  }
}

function getCpuUsageDetail() {
  const now = Date.now();
  const cgroupUsageUs = readCgroupCpuUsageUs();
  if (cgroupUsageUs !== null && lastCgroupCpuUsageUs !== null && now - lastCgroupCpuTime > 2_000) {
    const wallUs = (now - lastCgroupCpuTime) * 1_000;
    const cpuCores = Math.max(0, (cgroupUsageUs - lastCgroupCpuUsageUs) / wallUs);
    cachedCpuValue = cpuCores.toFixed(4);
    lastCgroupCpuUsageUs = cgroupUsageUs;
    lastCgroupCpuTime = now;
    return cachedCpuValue;
  }
  if (cgroupUsageUs !== null) {
    lastCgroupCpuUsageUs = cgroupUsageUs;
    lastCgroupCpuTime = now;
  }

  const timeDeltaMs = now - lastCpuTime;
  if (timeDeltaMs > 2_000) {
    const currentCpu = process.cpuUsage(lastCpuUsage);
    const totalCpuMs = (currentCpu.user + currentCpu.system) / 1_000;
    cachedCpuValue = Math.max(0, totalCpuMs / timeDeltaMs).toFixed(4);
    lastCpuUsage = process.cpuUsage();
    lastCpuTime = now;
  }
  return cachedCpuValue;
}

function getRealRenderRam() {
  try {
    if (fs.existsSync('/sys/fs/cgroup/memory.current')) {
      const currentBytes = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
      const limitRaw = fs.existsSync('/sys/fs/cgroup/memory.max')
        ? fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim()
        : '';
      const limitBytes = Number(limitRaw);
      if (Number.isFinite(currentBytes) && currentBytes > 0) {
        return {
          bytes: currentBytes,
          mib: currentBytes / 1_048_576,
          limitBytes: Number.isFinite(limitBytes) && limitBytes > 0 ? limitBytes : 512 * 1_048_576,
        };
      }
    }
  } catch (_) {}

  const rssBytes = process.memoryUsage().rss;
  return { bytes: rssBytes, mib: rssBytes / 1_048_576, limitBytes: 512 * 1_048_576 };
}

function formatMiB(value) {
  return Number(value).toFixed(2);
}
function progressBar(ratio, width = 10) {
  const safe = Math.max(0, Math.min(1, Number(ratio) || 0));
  const filled = Math.round(safe * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}
function buildStatusEmbed(health) {
  const cfg = health.config || health.cfg || {};
  const uptimeH = uptimeStartTimestamp
    ? ((Date.now() - uptimeStartTimestamp) / 3_600_000).toFixed(1)
    : (health.uptimeSec ? (health.uptimeSec / 3600).toFixed(1) : '?');
  const playtimeH = sessionStartTimestamp
    ? ((Date.now() - sessionStartTimestamp) / 3_600_000).toFixed(1)
    : (health.playtimeH || '—');
  const hasErrors = Boolean(health.recentErrors && health.recentErrors.length > 0);
  const digest = buildIncidentDigest(health.incidents || timeline.recent(50));
  const ts = new Date().toLocaleString('vi-VN', { hour12: false, timeZone: 'Asia/Ho_Chi_Minh' });

  const uniqueErrors = [];
  const seenMsgs = new Set();
  for (const e of health.recentErrors || []) {
    if (!seenMsgs.has(e.msg)) {
      seenMsgs.add(e.msg);
      uniqueErrors.push(e);
    }
  }

  const errorsCodeBlock = uniqueErrors.length > 0
    ? '```js\n' +
      uniqueErrors
        .map((e) => `[${e.ts}] ${e.msg}`)
        .join('\n')
        .slice(0, 950) +
      '\n```'
    : '```js\n✅ Tất cả hệ thống hoạt động hoàn hảo không có lỗi!\n```';

  const realRam = getRealRenderRam();
  const realHeapMb = process.memoryUsage().heapUsed / 1_048_576;
    const cpuVal = getCpuUsageDetail();
  const ramRatio = realRam.limitBytes > 0 ? realRam.bytes / realRam.limitBytes : 0;
  return {
    title: '🛡️ All-In-One System & Log Manager',
    color: hasErrors ? 0xff6b6b : CFG.embedColor,
    description: `🌌 Wuthering Waves · Live Operations Console\n📊 Theo dõi trạng thái, tài nguyên và incident trực tiếp.\n💠 Health Score: **${health.healthScore?.score ?? '—'}/100 · ${health.healthScore?.level ?? 'UNKNOWN'}**`,
    author: { name: 'WW Status Logger · Render 24/7', icon_url: CFG.smallImg },
    thumbnail: CFG.statusGif ? { url: CFG.statusGif } : undefined,
    fields: [
      {
        name: '🎮 Selfbot Treo Game',
        value: `${(health.discordReady || health.officialBotReady) ? '🟢 Online' : '🔴 Offline'} · **${playtimeH}h** playtime\n${cfg.resonatorName ?? 'Hiyuki S6'} | ${cfg.serverRegion ?? 'Asia'} UL${cfg.unionLevel ?? '80'}\n🏷️ Presence: **${health.presence?.category ?? 'farming'}** · ⏱️ ${health.presence?.durationMinutes ?? '—'}m`,
        inline: true,
      },
      {
        name: '💾 Bộ Nhớ & Tài Nguyên (Render 24/7)',
        value: `RAM Container: **${formatMiB(realRam.mib)} MiB** / ${formatMiB(realRam.limitBytes / 1_048_576)} MiB\n${progressBar(ramRatio)} ${(ramRatio * 100).toFixed(1)}% ${health.trends?.ram ?? '→'}\nCPU Usage: **${cpuVal}** / 0.1 CPU ${health.trends?.cpu ?? '→'}\nHeap JS: **${formatMiB(realHeapMb)} MiB** ${health.trends?.heap ?? '→'}\nUptime: **${uptimeH}h**\n📦 Budget: ${health.budgetHud ?? '—'}`,
        inline: true,
      },
      {
        name: `${digest.icon} Incident Digest · ${digest.level}`,
        value: `${digest.text}\n${health.maintenanceMode ? '🛠️ Maintenance · chỉ health/ping' : isNightSaverActive() ? '🌙 Night Saver đang hoạt động · REST giảm tải' : '☀️ Chế độ thường · monitor theo lịch'}\n${digest.events.slice(-5).map((e) => `${e.code} · ${e.message}`).join('\n') || 'Không có incident mới trong 30 phút.'}`,
        inline: false,
      },
      {
        name: '📋 Log Lỗi Code & Hệ Thống (Copy trực tiếp)',
        value: errorsCodeBlock,
        inline: false,
      },
      {
        name: '📈 24h Min / Avg / Max',
        value: `RAM: ${health.observability?.ramMiB?.min ?? '—'} / ${health.observability?.ramMiB?.avg ?? '—'} / ${health.observability?.ramMiB?.max ?? '—'} MiB\nCPU: ${health.observability?.cpu?.min ?? '—'} / ${health.observability?.cpu?.avg ?? '—'} / ${health.observability?.cpu?.max ?? '—'}\nHeap: ${health.observability?.heapMiB?.min ?? '—'} / ${health.observability?.heapMiB?.avg ?? '—'} / ${health.observability?.heapMiB?.max ?? '—'} MiB\nReconnect: ${health.observability?.reconnects ?? 0} · Rate-limit: ${health.observability?.rateLimits ?? 0}`,
        inline: false,
      },
    ],
    footer: { text: `Render Free 24/7 · Cập nhật lúc ${ts}` },
  };
}

function buildFetchFailEmbed(errorMessage) {
  const ts = new Date().toLocaleString('vi-VN', { hour12: false });
  return {
    title: '🌊 Wuthering Waves Bot',
    color: 0xf44336,
    fields: [
      { name: 'Discord', value: '🔴 Không xác định được (web2 không phản hồi)', inline: false },
      {
        name: 'Recent errors',
        value: '```\n' + String(errorMessage).slice(0, 950) + '\n```',
        inline: false,
      },
    ],
    footer: { text: `Cập nhật lúc ${ts} · auto-refresh mỗi ${MONITOR_INTERVAL_MS / 1000}s` },
  };
}

async function findExistingStatusMessage() {
  try {
    if (officialBot) {
      const existing = await officialBot.findRecentEmbed(LOG_CHANNEL_ID, 'Wuthering Waves Bot');
      if (existing) return existing.id;
    } else {
      const msgs = await discordApi(`/channels/${LOG_CHANNEL_ID}/messages?limit=10`);
      if (Array.isArray(msgs)) {
        const existing = msgs.find((m) => m.embeds?.[0]?.title?.includes('Wuthering Waves Bot'));
        if (existing) return existing.id;
      }
    }
  } catch (e) {
    if (isDiscordRateLimitError(e)) {
      monitorRateLimitedUntil = Math.max(monitorRateLimitedUntil, Date.now() + e.retryAfterMs);
      logger.info(`[monitor] Discord đang throttle khi tìm message cũ; giữ nguyên trạng thái và chờ ${Math.ceil(e.retryAfterMs / 1000)}s.`);
    } else {
      logger.warn('[monitor] Không lấy được danh sách message cũ:', e.message);
    }
  }
  return null;
}

async function pushStatusEmbed(embed) {
  if (!statusMessageId) {
    statusMessageId = await findExistingStatusMessage();
  }
  if (Date.now() < monitorRateLimitedUntil) return;
  if (statusMessageId) {
    try {
      await editLogEmbed(statusMessageId, embed);
      return;
    } catch (e) {
      if (isDiscordRateLimitError(e)) {
        monitorRateLimitedUntil = Math.max(monitorRateLimitedUntil, Date.now() + e.retryAfterMs);
        logger.info(`[monitor] Discord đang throttle; bỏ qua vòng cập nhật này và giữ nguyên message trạng thái trong ${Math.ceil(e.retryAfterMs / 1000)}s.`);
        return;
      }
      logger.warn('[monitor] Edit thất bại, gửi message mới:', e.message);
      statusMessageId = null;
    }
  }
  try {
    const sent = await sendLogEmbed(embed);
    statusMessageId = sent?.id || null;
  } catch (e) {
    if (isDiscordRateLimitError(e)) {
      monitorRateLimitedUntil = Math.max(monitorRateLimitedUntil, Date.now() + e.retryAfterMs);
      logger.info(`[monitor] Discord đang throttle khi gửi status; giữ nguyên trạng thái và chờ ${Math.ceil(e.retryAfterMs / 1000)}s.`);
      return;
    }
    logger.warn('[monitor] Gửi status embed thất bại:', e.message);
  }
}

let consecutiveHealthyMonitorTicks = 0;
let lastStatusFingerprint = '';
let lastStatusEditAt = 0;
async function runMonitorTick() {
  if (monitorInFlight || maintenanceMode || isMaintenanceWindowActive() || Date.now() < monitorRateLimitedUntil) return { skipped: true };
  if (officialBot && !officialBot.client.isReady()) return { skipped: true, nextDelay: MONITOR_INTERVAL_MS };
  if (!resourceGovernor.consume('request')) {
    timeline.record('BUDGET_HEALTH_ONLY', 'Đạt ngân sách request/ngày; chỉ giữ health/ping');
    return { skipped: true, budget: true, nextDelay: 30 * 60 * 1000 };
  }
  monitorInFlight = true;
  try {
    const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} khi gọi ${STATUS_URL}`);
    const health = await res.json();
    const anomaly = anomalyGuard.evaluate(health, health.incidents || timeline.recent(50));
    if (anomaly) {
      timeline.record(anomaly.code, anomaly.reasons.join(' · '), { severity: anomaly.severity });
      health.incidents = timeline.recent(50);
    }
    const statusFingerprint = JSON.stringify({ ready: health.discordReady || health.officialBotReady, score: health.healthScore?.score, presence: health.presence?.category, ram: Math.round(Number(health.container?.memory?.mib || 0)), incident: buildIncidentDigest(health.incidents || []).level, budget: health.resourceBudget?.mode });
    const changed = statusFingerprint !== lastStatusFingerprint;
    const due = Date.now() - lastStatusEditAt >= 30 * 60 * 1000;
    if (resourceGovernor.can('discordUpdate') && (changed || due)) {
      await pushStatusEmbed(buildStatusEmbed(health));
      lastStatusFingerprint = statusFingerprint;
      lastStatusEditAt = Date.now();
      resourceGovernor.consume('discordUpdate');
    } else if (!resourceGovernor.can('discordUpdate')) {
      timeline.record('BUDGET_HEALTH_ONLY', 'Đã chạm ngân sách Discord update; bỏ qua edit embed');
    }
    consecutiveHealthyMonitorTicks += 1;
    return { health, nextDelay: nextAdaptiveDelay({ baseMs: MONITOR_INTERVAL_MS, health, consecutiveHealthy: consecutiveHealthyMonitorTicks }) };
  } catch (e) {
    if (isDiscordRateLimitError(e)) {
      monitorRateLimitedUntil = Math.max(monitorRateLimitedUntil, Date.now() + e.retryAfterMs);
      consecutiveHealthyMonitorTicks = 0;
      logger.info(`[monitor] Log channel đang throttle — tạm dừng vòng monitor ${Math.ceil(e.retryAfterMs / 1000)}s; không ghi là lỗi.`);
      return { rateLimited: true, nextDelay: Math.max(MONITOR_INTERVAL_MS, e.retryAfterMs) };
    }
    consecutiveHealthyMonitorTicks = 0;
    logger.error('[monitor] Không ping được /health hoặc gửi Discord:', e.message);
    return { error: true, nextDelay: Math.min(30 * 60 * 1000, MONITOR_INTERVAL_MS * 3) };
  } finally {
    monitorInFlight = false;
  }
}

const DISABLE_MONITOR = process.env.DISABLE_MONITOR === 'true';

if (officialBot) {
  officialBot.login().then(() => logger.info('[official-bot] Bot chính thức đã kết nối Gateway.')).catch((error) => {
    const message = String(error?.message || error);
    if (message.includes('disallowed intents') || error?.code === 4014) logger.warn('[official-bot] Login bị từ chối do privileged intent; hãy bật ENABLE_MEMBER_EVENTS chỉ khi đã bật intent trong Developer Portal.');
    else { errorCount++; logger.error('[official-bot] Login thất bại:', message); }
  });
}

let monitorTimer = null;
function scheduleMonitor(delayMs) {
  clearTimeout(monitorTimer);
  monitorTimer = setTimeout(async () => {
    const result = await runMonitorTick();
    scheduleMonitor(result?.nextDelay || MONITOR_INTERVAL_MS);
  }, Math.max(30_000, delayMs));
  monitorTimer.unref();
}
if (BOT_TOKEN && LOG_CHANNEL_ID && !DISABLE_MONITOR) {
  logger.info(`[monitor] Log bot kích hoạt — adaptive polling bắt đầu sau 30s, min ${MONITOR_INTERVAL_MS / 1000}s`);
  scheduleMonitor(30_000);
} else {
  logger.info('[monitor] Đã tắt hoặc bỏ qua tính năng log Discord (tiết kiệm REST traffic).');
}

// ---------------------------------------------------------------------------
// Watchdog: không restart process, chỉ kích hoạt login retry nếu gateway offline quá lâu.
const watchdogTimer = setInterval(() => {
  if (RUN_SELF_BOT && !discordReady && Date.now() - lastLoginStartedAt > 10 * 60 * 1000) {
    logger.info('[watchdog] Gateway offline quá 10 phút — kích hoạt reconnect an toàn.');
    loginWithRetry();
  }
}, 5 * 60 * 1000);
watchdogTimer.unref();

// Startup
// ---------------------------------------------------------------------------
printStartupSummary();
loginWithRetry();
