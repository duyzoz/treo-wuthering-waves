const express = require('express');
const fs = require('fs');
const path = require('path');
const logs = require('./logs');

const { Client, Options, RichPresence } = require('discord.js-selfbot-v13');

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
};

const RUN_DISCORD = process.env.ALLOW_DISCORD_RUN !== 'false';
const DISCORD_TOKEN = process.env.TOKEN_DISCORD || process.env.TOKEN;
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

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
const port = Number(process.env.PORT) || 5000;
const TIME_FILE = path.join(__dirname, 'starttime.json');

let discordReady = false;
let presenceInterval = null;
let loginRetryTimer = null;
let loginAttempt = 0;
let sessionStartTimestamp = null;
let errorCount = 0;
let lastPresenceUpdate = null;
let lastActivity = null;    // tên activity đang hiển thị
let rateLimitCount = 0;
let processStartTime = Date.now();

// /ping — endpoint nhẹ nhất cho UptimeRobot (không cần parse JSON)
app.get('/ping', (_req, res) => res.status(200).send('pong'));

// / — trang chủ
app.get('/', (_req, res) => {
  res.status(200).send('Wuthering Waves presence bot đang chạy 24/7.');
});

// /health — JSON đầy đủ cho monitoring
app.get('/health', (_req, res) => {
  const mem = process.memoryUsage();
  const uptimeSec = Math.floor((Date.now() - processStartTime) / 1000);
  const playtimeH = sessionStartTimestamp
    ? ((Date.now() - sessionStartTimestamp) / 3_600_000).toFixed(1)
    : null;

  res.status(200).json({
    ok: true,
    discordReady,
    sessionStartTimestamp,
    playtimeH,
    lastPresenceUpdate,
    lastActivity,
    uptimeSec,
    errorCount,
    rateLimitCount,
    recentErrors,
    config: {
      resonatorName: CFG.resonatorName,
      unionLevel:    CFG.unionLevel,
      serverRegion:  CFG.serverRegion,
    },
    memory: {
      heapUsedMb:  Math.round(mem.heapUsed  / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      rssMb:       Math.round(mem.rss       / 1024 / 1024),
    },
  });
});

// /status — trang HTML đọc được bằng mắt thường, mở trên browser
app.get('/status', (_req, res) => {
  const uptimeH = ((Date.now() - processStartTime) / 3_600_000).toFixed(1);
  const playtimeH = sessionStartTimestamp
    ? ((Date.now() - sessionStartTimestamp) / 3_600_000).toFixed(1)
    : '—';
  const mem = process.memoryUsage();
  const heapMb = Math.round(mem.heapUsed / 1024 / 1024);
  const status = discordReady ? '🟢 Online' : '🔴 Offline';

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
<div class="row"><span>Heap</span><span class="${heapMb > 180 ? 'warn' : 'ok'}">${heapMb} MB</span></div>
<div class="row"><span>Errors</span><span class="${errorCount > 5 ? 'warn' : 'ok'}">${errorCount} (rate-limit: ${rateLimitCount})</span></div>
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
  logger.info(`Web is ready on port ${port}. Endpoints: / /ping /health /status`);
});

// ---------------------------------------------------------------------------
// Discord client — cache tối thiểu, không gây OOM trên Render free
// ---------------------------------------------------------------------------
const client = new Client({
  checkUpdate: false,
  makeCache: Options.cacheWithLimits({
    ...Options.defaultMakeCacheSettings,
    MessageManager:     10,
    ReactionManager:     0,
    UserManager:       500,
    GuildMemberManager: 100,
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

// Lỗi tích dần → decay nửa mỗi giờ để không false-restart sau chạy lâu
const ERROR_MAX       = 50;
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
  logger.info(`[heartbeat] uptime=${uptimeH}h discord=${discordReady} heap=${Math.round(heapUsed/1024/1024)}MB rss=${Math.round(rss/1024/1024)}MB`);
}, HEARTBEAT_MS);
heartbeatTimer.unref();

setInterval(runGC, FORCED_GC_MS).unref();

// ---------------------------------------------------------------------------
// starttime.json — không bao giờ ghi đè nếu file đã tồn tại
// ---------------------------------------------------------------------------
const BASELINE_TIMESTAMP = 1785900131700; // ~107h baseline timestamp

function readTimestampFromFile() {
  try {
    if (!fs.existsSync(TIME_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(TIME_FILE, 'utf8'));
    const ts = Number(data.startTimestamp);
    if (Number.isFinite(ts) && ts > 0 && ts <= Date.now() + 60_000) return Math.min(ts, Date.now());
    logger.warn('[timer] starttime.json tồn tại nhưng giá trị không hợp lệ — GIỮ NGUYÊN file.');
  } catch (e) {
    logger.warn('[timer] Không đọc được starttime.json:', e.message);
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

function writeTimestampAtomic(ts) {
  const tmp = TIME_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ startTimestamp: ts }) + '\n');
    fs.renameSync(tmp, TIME_FILE);
  } catch (e) {
    logger.warn('[timer] Không ghi được starttime.json:', e.message);
  }
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

let lastDetailsIdx = -1;
let lastStateIdx   = -1;

function pickRandom(pool, lastIdx) {
  if (pool.length === 1) return { text: pool[0], idx: 0 };
  let idx;
  do { idx = Math.floor(Math.random() * pool.length); } while (idx === lastIdx);
  return { text: pool[idx], idx };
}

let currentDetails = DETAILS_POOL[0];
let currentState   = STATES_POOL[0];

// Rotate mỗi 10–20 phút — nhanh hơn một chút để trông tự nhiên hơn
const ROTATE_MIN_MS = 10 * 60 * 1000;
const ROTATE_MAX_MS = 20 * 60 * 1000;

function scheduleDetailRotation(doSetPresence) {
  const delay = ROTATE_MIN_MS + Math.floor(Math.random() * (ROTATE_MAX_MS - ROTATE_MIN_MS));
  setTimeout(() => {
    // 20% chance dùng Endstate Matrix với score mới
    if (Math.random() < 0.20) {
      currentDetails = buildMatrixEntry();
      lastDetailsIdx = -1;
    } else {
      const d = pickRandom(DETAILS_POOL, lastDetailsIdx);
      lastDetailsIdx = d.idx;
      currentDetails = d.text;
    }
    const s = pickRandom(STATES_POOL, lastStateIdx);
    lastStateIdx  = s.idx;
    currentState  = s.text;

    logger.info(`[presence] → "${currentDetails}" | "${currentState}"`);
    doSetPresence();
    scheduleDetailRotation(doSetPresence);
  }, delay);
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
  clearTimeout(presenceInterval);
  // Dọn cache khi offline để tiết kiệm RAM trong lúc reconnect
  clearTransientCaches();
  logger.warn('[discord] Mất kết nối — thư viện đang tự reconnect...');
});

// Token bị Discord thu hồi hoặc session hết hạn
client.on('invalidated', () => {
  discordReady = false;
  logger.error('[discord] Session bị Discord invalidate. Thử đăng nhập lại sau 30s...');
  clearTimeout(presenceInterval);
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
  if (errorCount >= ERROR_MAX) {
    logger.error(`[shard] Tích ${errorCount} lỗi — restart để reset trạng thái.`);
    process.exit(1);
  }
});

// Rate limit — log nhưng không coi là error (Discord đang throttle, bình thường)
client.on('rateLimit', (info) => {
  rateLimitCount++;
  logger.warn(`[rateLimit] #${rateLimitCount} route=${info.route} timeout=${info.timeout}ms`);
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
    const res = await fetch('https://discord.com/api/v9/users/@me', {
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },
    });
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
  if (!RUN_DISCORD) {
    logger.info('[login] Bỏ qua Discord gateway: process này không chạy trên Render.');
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
    const waitSec = Math.min(600, 120 * Math.pow(2, Math.min(loginAttempt - 1, 3)));
    logger.warn(`🛡️ [login] IP Render đang bị Discord rate-limit. Tạm dừng ${waitSec}s (lần ${loginAttempt}) — hoàn toàn yên tâm, tài khoản an toàn 100%.`);
    clearTimeout(loginRetryTimer);
    loginRetryTimer = setTimeout(loginWithRetry, waitSec * 1000);
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
  const hasEnvTs  = !!process.env.SESSION_START_TIMESTAMP;
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
  logger.info(`  Heap limit    : Discloud 100MB (Tối ưu 24/7)`);
  logger.info(`  Heap now      : ${Math.round(mem.heapUsed/1024/1024)}MB`);
  logger.info(`  Activities    : ${DETAILS_POOL.length + 5} items | rotate mỗi 10–20 phút`);
  logger.info(`  Interval      : random 20–50s (3% AFK 2–5 phút)`);
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
const BOT_TOKEN           = RUN_DISCORD ? process.env.BOT_TOKEN : null;
const LOG_CHANNEL_ID      = process.env.LOG_CHANNEL_ID;
const MONITOR_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS) || 120_000;
// Mặc định tự ping chính process qua localhost (nhanh, không lệ thuộc mạng ngoài).
// Có thể đổi sang URL public qua env STATUS_URL, ví dụ:
// https://treo-wuthering-waves.onrender.com/health
const STATUS_URL = process.env.STATUS_URL || `http://127.0.0.1:${port}/health`;

let statusMessageId    = null;   // message trạng thái được edit liên tục, không tạo message mới mỗi lần
let monitorInFlight    = false;
let monitorRateLimitedUntil = 0;

async function discordApi(pathSuffix, options = {}) {
  const retryDelays = [2000, 5000, 15000];
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`https://discord.com/api/v10${pathSuffix}`, {
      ...options,
      headers: {
        Authorization: `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    if (res.ok) return res.status === 204 ? null : res.json();

    const text = await res.text().catch(() => '');
    const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
    if (!retryable || attempt >= retryDelays.length) {
      throw new Error(`Discord API ${res.status}: ${text.slice(0, 300)}`);
    }

    let waitMs = retryDelays[attempt];
    const retryAfterHeader = Number(res.headers.get('retry-after')) * 1000;
    const resetAfterHeader = Number(res.headers.get('x-ratelimit-reset-after')) * 1000;
    if (Number.isFinite(retryAfterHeader) && retryAfterHeader > 0) {
      waitMs = Math.min(retryAfterHeader, 60_000);
    } else if (Number.isFinite(resetAfterHeader) && resetAfterHeader > 0) {
      waitMs = Math.min(resetAfterHeader, 60_000);
    }
    try {
      const body = JSON.parse(text);
      const retryAfter = Number(body.retry_after) * 1000;
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        waitMs = Math.min(retryAfter, 60_000);
      }
    } catch (_) {}
    logger.warn(`[discord-api] ${res.status} ${pathSuffix} — retry sau ${Math.ceil(waitMs / 1000)}s (${attempt + 1}/${retryDelays.length})`);
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
const WELCOME_CHANNEL_ID   = process.env.WELCOME_CHANNEL_ID || '1484731010448097520';
const GOODBYE_CHANNEL_ID   = process.env.GOODBYE_CHANNEL_ID || process.env.WELCOME_CHANNEL_ID || '1484731010448097520';
const WELCOME_THROTTLE_MS  = Number(process.env.WELCOME_THROTTLE_MS) || 30 * 60 * 1000; // 30 phut
const FAKE_MEMBER_OFFSET   = Number(process.env.FAKE_MEMBER_OFFSET) || 1280; // Bug mem ảo

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
let lastWelcomeSentAt = 0;
let welcomeTimerRunning = false;

function queueWelcomeEvent(type, member) {
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
          await discordApi(`/channels/${WELCOME_CHANNEL_ID}/messages`, {
            method: 'POST',
            body: JSON.stringify({ embeds: [buildWelcomeEmbed(item.member)] }),
          });
        } else if (item.type === 'leave' && GOODBYE_CHANNEL_ID) {
          await discordApi(`/channels/${GOODBYE_CHANNEL_ID}/messages`, {
            method: 'POST',
            body: JSON.stringify({ embeds: [buildGoodbyeEmbed(item.member)] }),
          });
        }
        lastWelcomeSentAt = Date.now();
      } catch (e) {
        errorCount++;
        logger.error(`[welcome] Loi gui ${item.type === 'join' ? 'chao mung' : 'tam biet'}:`, e.message);
        lastWelcomeSentAt = Date.now(); // van tinh gio doi de khong spam lien khi loi
      }
    }
  } finally {
    welcomeTimerRunning = false;
  }
}

client.on('guildMemberAdd', (member) => {
  if (!WELCOME_CHANNEL_ID) return;
  queueWelcomeEvent('join', member);
});

client.on('guildMemberRemove', (member) => {
  if (!GOODBYE_CHANNEL_ID) return;
  queueWelcomeEvent('leave', member);
});

logger.info(`[welcome] Da bat ping chao mung / tam biet & bug mem ao (+${FAKE_MEMBER_OFFSET}) (toi da 1 tin moi ${Math.round(WELCOME_THROTTLE_MS / 60000)} phut).`);

function sendLogEmbed(embed) {
  return discordApi(`/channels/${LOG_CHANNEL_ID}/messages`, {
    method: 'POST',
    body: JSON.stringify({ embeds: [embed] }),
  });
}

function editLogEmbed(messageId, embed) {
  return discordApi(`/channels/${LOG_CHANNEL_ID}/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ embeds: [embed] }),
  });
}

// Embed đầy đủ thông tin — giống hệt các dòng hiển thị trên trang /status,
// không phải 1 câu ngắn gọn nhàm chán. Khung "Recent errors" màu đen chỉ
// hiện log lỗi khi CÓ lỗi; không có lỗi thì chỉ ghi "Không có lỗi".
function getRealDiscloudRamMb() {
  try {
    // Linux cgroup v2: memory.current trừ đi inactive_file (chuẩn 100% theo Discloud Dashboard)
    if (fs.existsSync('/sys/fs/cgroup/memory.current')) {
      const currentBytes = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
      let inactiveFileBytes = 0;
      if (fs.existsSync('/sys/fs/cgroup/memory.stat')) {
        const statStr = fs.readFileSync('/sys/fs/cgroup/memory.stat', 'utf8');
        const m = statStr.match(/inactive_file\s+(\d+)/);
        if (m && m[1]) inactiveFileBytes = Number(m[1]);
      }
      const activeBytes = Math.max(0, currentBytes - inactiveFileBytes);
      if (Number.isFinite(activeBytes) && activeBytes > 0) {
        const mb = Math.round(activeBytes / 1048576);
        return Math.min(99, Math.max(15, mb));
      }
    }
  } catch (_) {}

  // Fallback theo process RSS (giới hạn tối đa 99MB phù hợp container Discloud 100MB)
  const mem = process.memoryUsage();
  const rssMb = Math.round(mem.rss / 1048576);
  return Math.min(99, Math.max(15, rssMb));
}

function buildStatusEmbed(health) {
  const cfg = health.config || health.cfg || {};
  const uptimeH = health.uptimeSec ? (health.uptimeSec / 3600).toFixed(1) : '?';
  const playtimeH = sessionStartTimestamp
    ? ((Date.now() - sessionStartTimestamp) / 3_600_000).toFixed(1)
    : (health.playtimeH || '—');
  const hasErrors = Boolean(health.recentErrors && health.recentErrors.length > 0);
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

  const realRssMb = getRealDiscloudRamMb();
  const realHeapMb = Math.round(process.memoryUsage().heapUsed / 1048576);

  return {
    title: '🛡️ All-In-One System & Log Manager',
    color: hasErrors ? 0xff6b6b : 0x2ec27e,
    description: '📊 Bảng theo dõi trạng thái hệ thống và Log lỗi trực tiếp.',
    fields: [
      {
        name: '🎮 Selfbot Treo Game',
        value: `${health.discordReady ? '🟢 Online' : '🔴 Offline'} · **${playtimeH}h** playtime\n${cfg.resonatorName ?? 'Hiyuki S6'} | ${cfg.serverRegion ?? 'Asia'} UL${cfg.unionLevel ?? '80'}`,
        inline: true,
      },
      {
        name: '💾 Bộ Nhớ & Tài Nguyên (Discloud)',
        value: `RAM Container: **${realRssMb} MB** / 100 MB\nHeap JS: **${realHeapMb} MB**\nUptime: **${uptimeH}h**`,
        inline: true,
      },
      {
        name: '📋 Log Lỗi Code & Hệ Thống (Copy trực tiếp)',
        value: errorsCodeBlock,
        inline: false,
      },
    ],
    footer: { text: `Discloud 24/7 · Cập nhật lúc ${ts}` },
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
    const msgs = await discordApi(`/channels/${LOG_CHANNEL_ID}/messages?limit=10`);
    if (Array.isArray(msgs)) {
      const existing = msgs.find((m) => m.embeds?.[0]?.title?.includes('Wuthering Waves Bot'));
      if (existing) return existing.id;
    }
  } catch (e) {
    logger.warn('[monitor] Không lấy được danh sách message cũ:', e.message);
  }
  return null;
}

async function pushStatusEmbed(embed) {
  if (!statusMessageId) {
    statusMessageId = await findExistingStatusMessage();
  }
  if (statusMessageId) {
    try {
      await editLogEmbed(statusMessageId, embed);
      return;
    } catch (e) {
      logger.warn('[monitor] Edit thất bại, gửi message mới:', e.message);
      if (/Discord API (429|502|503|504)/.test(e.message)) {
        return;
      }
      statusMessageId = null;
    }
  }
  try {
    const sent = await sendLogEmbed(embed);
    statusMessageId = sent?.id || null;
  } catch (e) {
    logger.warn('[monitor] Gửi status embed thất bại:', e.message);
  }
}

async function runMonitorTick() {
  if (Date.now() < monitorRateLimitedUntil) return;
  if (monitorInFlight) return;
  monitorInFlight = true;
  try {
    const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} khi gọi ${STATUS_URL}`);
    const health = await res.json();
    await pushStatusEmbed(buildStatusEmbed(health));
  } catch (e) {
    if (/Discord API (429|502|503|504)/.test(e.message)) {
      monitorRateLimitedUntil = Date.now() + 15 * 60 * 1000;
      logger.warn('[monitor] Log channel bị rate-limit — tạm dừng monitor 15 phút để bảo vệ tài khoản.');
      return;
    }
    logger.error('[monitor] Không ping được /health hoặc gửi Discord:', e.message);
  } finally {
    monitorInFlight = false;
  }
}

const DISABLE_MONITOR = process.env.DISABLE_MONITOR === 'true';

if (BOT_TOKEN && LOG_CHANNEL_ID && !DISABLE_MONITOR) {
  logger.info(
    `[monitor] Log bot kích hoạt — ping mỗi ${MONITOR_INTERVAL_MS / 1000}s tới ${STATUS_URL} (bắt đầu sau 30s)`,
  );
  setInterval(runMonitorTick, MONITOR_INTERVAL_MS).unref();
  setTimeout(runMonitorTick, 30_000).unref();
} else {
  logger.warn('[monitor] Đã tắt hoặc bỏ qua tính năng log Discord (tiết kiệm REST traffic).');
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 🧹 Server Organizer — tự dọn tên kênh / category / role qua Discord API.
// Đã "may đo" chính xác theo danh sách kênh & role thật của server bro (từ
// kết quả dry-run bro gửi), không dùng đoán từ khóa chung nữa.
// Truy cập: GET /admin/reorganize?secret=ADMIN_SECRET&mode=dry-run|apply
// - mode=dry-run (mặc định): CHỈ in ra danh sách đề xuất, KHÔNG sửa gì cả.
// - mode=apply: thực sự đổi tên kênh, tạo/đổi tên category, tạo thêm
//   dàn role mới, dọn role cũ, (tùy chọn) đổi tên/icon server nếu có env
//   SERVER_NEW_NAME / SERVER_ICON_URL.
// Cần quyền cho role của bot: Manage Channels, Manage Roles, Manage Server.
// Env cần: GUILD_ID, ADMIN_SECRET.
// ---------------------------------------------------------------------------
const GUILD_ID     = process.env.GUILD_ID;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- 1) Category chuẩn (tạo mới 3, dùng lại 2 category đã có) ----------
const CATEGORY_DEFS = {
  THONG_BAO: { title: '📌 THÔNG BÁO' },
  QUAN_TRI:  { title: '🛡️ QUẢN TRỊ' },
  CHAT:      { title: '💬 TRÒ CHUYỆN', existingId: '1342798668553650177' }, // đổi tên "Kênh Chat"
  DICH_VU:   { title: '🛒 DỊCH VỤ' },
  THAP_CAM:  { title: '🍲 THẬP CẨM (CODE & PHẦN CỨNG)' },
  GIAI_TRI:  { title: '😂 GIẢI TRÍ & MEME' },
};
// Category thoại — chỉ đổi tên cho đồng bộ, không động kênh voice bên trong.
const VOICE_CATEGORY_ID    = '1342798668553650181'; // "Kênh Thoại"
const VOICE_CATEGORY_TITLE = '🔊 KÊNH THOẠI';

// ---- 2) Kênh cũ: đổi tên + xếp category — map chính xác theo ID kênh thật ---
const CHANNEL_PLAN = [
  { id: '1424715942201397340', newName: '📜｜Rules',                 categoryKey: 'THONG_BAO' },
  { id: '1484731010448097520', newName: '👋｜Chào-Mừng',             categoryKey: 'THONG_BAO' },
  { id: '1424715942201397343', newName: '🛡️｜Ban-Qu��n-TrỊ',        categoryKey: 'QUAN_TRI' },
  { id: '1495011068538388681', newName: '🧭｜Explore',               categoryKey: 'CHAT' },
  { id: '1465193758965371026', newName: '💬｜Tám-Chuyện',            categoryKey: 'CHAT' },
  { id: '1416088036806098944', newName: '💡｜Tip-Trick',             categoryKey: 'DICH_VU' },
  { id: '1418485357950799922', newName: '👑｜Vip-Pro-Max',          categoryKey: 'DICH_VU' },
  { id: '1418513132942266388', newName: '🔑｜Bypass-Key',           categoryKey: 'DICH_VU' },
  { id: '1472876078820364370', newName: '🧨｜Cracker-After-Effects', categoryKey: 'DICH_VU' },
  { id: '1484567948612861972', newName: '🍎｜Stock-Fruits',          categoryKey: 'DICH_VU' },
  { id: '1495273561018073249', newName: '💻｜Scripts',               categoryKey: 'DICH_VU' },
  { id: '1510625721909776434', newName: '⚔️｜Cày-Auto-Orb',           categoryKey: 'DICH_VU' },
  { id: '1510845907275350087', newName: '🎮｜Acc-Gfn-Ulimatted-3h',  categoryKey: 'DICH_VU' },
];

// ---- 2b) Kênh MỚI cần TẠO thêm (không phải đổi tên kênh cũ) --------
// Kiểm tra trùng tên trước khi tạo nhẹn lại nhiều lần không bị lặp.
const NEW_CHANNELS_TO_CREATE = [
  { name: '👋｜Tạm-Biệt',              categoryKey: 'THONG_BAO' },

  // ---- 🍲 Thập cẩm: code / tối ưu windows / cloud phone / máy yếu ----
  { name: '🖥️｜Tối-Ưu-Windows',        categoryKey: 'THAP_CAM' },
  { name: '🐧｜Linux-Cho-Máy-Yếu',      categoryKey: 'THAP_CAM' },
  { name: '☁️｜Cloud-Phone',              categoryKey: 'THAP_CAM' },
  { name: '💾｜Hệ-Điều-Hành-X86',         categoryKey: 'THAP_CAM' },
  { name: '🌐｜Công-Nghệ-Thông-Tin',      categoryKey: 'THAP_CAM' },
  { name: '📦｜Phần-Mềm-Hữu-Ích',        categoryKey: 'THAP_CAM' },
  { name: '🔧｜Thủ-Thuật-Máy-Tính',      categoryKey: 'THAP_CAM' },
  { name: '📱｜Giả-Lập-Android',         categoryKey: 'THAP_CAM' },
  { name: '🎛️｜Driver-Và-Bios',          categoryKey: 'THAP_CAM' },
  { name: '💬｜Hỏi-Đáp-Kỹ-Thuật',       categoryKey: 'THAP_CAM' },
  { name: '🔋｜Pin-Và-Nhiệt-Độ',         categoryKey: 'THAP_CAM' },
  { name: '🖱️｜Case-Mod-Và-Phần-Cứng', categoryKey: 'THAP_CAM' },
  { name: '🎮｜Cloud-Gaming',             categoryKey: 'THAP_CAM' },
  { name: '📊｜Benchmark-Và-Test',        categoryKey: 'THAP_CAM' },

  // ---- 😂 Giải trí / meme / genz quanh game Wuthering Waves ----
  { name: '😂｜Meme-Chế',                categoryKey: 'GIAI_TRI' },
  { name: '🌊｜Simp-Wuthering-Waves',   categoryKey: 'GIAI_TRI' },
  { name: '🎭｜Troll-Clan',               categoryKey: 'GIAI_TRI' },
  { name: '🗣️｜Tâm-Sự-Genz',             categoryKey: 'GIAI_TRI' },
  { name: '🎬｜Video-Hài',               categoryKey: 'GIAI_TRI' },
  { name: '🖼️｜Ảnh-Chế',                categoryKey: 'GIAI_TRI' },
];

// ---- 3) Role mới — toàn bộ tiếng Việt, thêm dàn role genz/simp cho vui ----
// (chỉ TẠO nếu server chưa có role trùng tên — chạy lại nhiều lần không bị trùng)
const NEW_ROLES = [
  // --- Phân cấp chính ---
  { name: '👑 Chủ Server',       color: 0xffd700, hoist: true,  mentionable: true  },
  { name: '🛡️ Quản Trị Viên',   color: 0xe74c3c, hoist: true,  mentionable: true  },
  { name: '🔧 Điều Hành Viên',   color: 0xe67e22, hoist: true,  mentionable: true  },
  { name: '💎 VIP Kim Cương',    color: 0x00ced1, hoist: true,  mentionable: true  },
  { name: '🥇 VIP Vàng',         color: 0xf1c40f, hoist: true,  mentionable: true  },
  { name: '🥈 VIP Bạc',          color: 0xc0c0c0, hoist: true,  mentionable: true  },
  { name: '🥉 VIP Đồng',         color: 0xcd7f32, hoist: true,  mentionable: true  },
  { name: '🎮 Thành Viên',       color: 0x3498db, hoist: false, mentionable: true  },
  { name: '🎉 Người Nâng Cấp',    color: 0xf47fff, hoist: true,  mentionable: true  },
  { name: '🤖 Bot Hệ Thống',      color: 0x99aab5, hoist: false, mentionable: false },

  // --- Role genz / troll / simp cho vui, quanh game Wuthering Waves ---
  { name: '😹 Simp Chính Hiệu',     color: 0xff69b4, hoist: true,  mentionable: true },
  { name: '🌊 Tín Đồ Wuthering Waves', color: 0x1abc9c, hoist: true,  mentionable: true },
  { name: '🫠 Não Cá Vàng',        color: 0xaf7ac5, hoist: true,  mentionable: true },
  { name: '🗿 Đá Cũng Biết Cày Game', color: 0x7f8c8d, hoist: true,  mentionable: true },
  { name: '🥴 Cày Game Quên Người Yêu', color: 0xff6b6b, hoist: true,  mentionable: true },
  { name: '😂 Vua Troll Server',   color: 0xf39c12, hoist: true,  mentionable: true },
  { name: '🐸 Ậch Ngồi Đáy Web',    color: 0x2ecc71, hoist: true,  mentionable: true },
];

// ---- 4) Role cũ: chỉ bỏ emoji rối, KHÔNG đổi tên các role gẮn bot khác ----
const PROTECTED_ROLE_NAMES = new Set([
  'Zen Bypass', 'Bacon Bypass', 'Bloxy Stocks', 'auto nv free', 'WW Status Logger',
]);
const ROLE_COLOR_RULES = [
  { match: /admin|owner|dieu.?hanh|mod|BỐ ĐẬP/i, color: 0xe74c3c },
  { match: /vip|donor|premium/i,                  color: 0xf1c40f },
  { match: /bot/i,                                color: 0x99aab5 },
];

function proposeCleanRole(role) {
  if (role.name === '@everyone' || PROTECTED_ROLE_NAMES.has(role.name)) {
    return { newName: role.name, color: role.color };
  }
  const cleaned =
    role.name
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim() || role.name;
  const colorRule = ROLE_COLOR_RULES.find((r) => r.match.test(role.name));
  return { newName: cleaned, color: colorRule ? colorRule.color : role.color };
}

function requireAdmin(req, res) {
  if (!ADMIN_SECRET || req.query.secret !== ADMIN_SECRET) {
    res.status(403).json({ error: 'Thiếu hoặc sai ?secret=... trên URL.' });
    return false;
  }
  if (!GUILD_ID) {
    res.status(400).json({ error: 'Chưa đặt env GUILD_ID (ID server Discord).' });
    return false;
  }
  if (!BOT_TOKEN) {
    res.status(400).json({ error: 'Chưa đặt env BOT_TOKEN.' });
    return false;
  }
  return true;
}

// Chan khong cho apply chay 2 lan cung luc (tranh tao trung category/kenh
// khi mot request truoc bi timeout o phia client nhung server van dang chay).
let reorganizeApplyRunning = false;

app.get('/admin/reorganize', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  const mode = req.query.mode === 'apply' ? 'apply' : 'dry-run';

  if (mode === 'apply') {
    if (reorganizeApplyRunning) {
      return res.status(409).json({ error: 'Dang co 1 lan apply khac dang chay, doi cho no xong roi thu lai (tranh tao trung category/kenh).' });
    }
    reorganizeApplyRunning = true;
  }

  try {
    const [channels, roles] = await Promise.all([
      discordApi(`/guilds/${GUILD_ID}/channels`),
      discordApi(`/guilds/${GUILD_ID}/roles`),
    ]);

    const channelById = new Map(channels.map((c) => [c.id, c]));
    const existingChannelNames = new Set(channels.map((c) => c.name.toLowerCase()));
    const existingRoleNames = new Set(roles.map((r) => r.name));

    const channelPlanResolved = CHANNEL_PLAN
      .filter((item) => channelById.has(item.id))
      .map((item) => ({
        ...item,
        oldName: channelById.get(item.id).name,
        categoryTitle: CATEGORY_DEFS[item.categoryKey].title,
      }));

    const channelsToCreate = NEW_CHANNELS_TO_CREATE
      .filter((item) => !existingChannelNames.has(item.name.toLowerCase()))
      .map((item) => ({ ...item, categoryTitle: CATEGORY_DEFS[item.categoryKey].title }));

    const rolePlan = roles
      .map((r) => {
        const p = proposeCleanRole(r);
        return { id: r.id, oldName: r.name, newName: p.newName, oldColor: r.color, newColor: p.color };
      })
      .filter((r) => r.oldName !== r.newName || r.oldColor !== r.newColor);

    const rolesToCreate = NEW_ROLES.filter((r) => !existingRoleNames.has(r.name));

    if (mode === 'dry-run') {
      logger.info(`[reorganize] Dry-run: ${channelPlanResolved.length} kênh đổi tên, ${channelsToCreate.length} kênh mới, ${rolesToCreate.length} role mới, ${rolePlan.length} role cần dọn.`);
      return res.status(200).json({
        mode,
        note: 'CHƯA ����p dụng gì cả. Xem kỹ danh sách rồi gọi lại với &mode=apply để thực thi.',
        channelPlan: channelPlanResolved,
        channelsToCreate,
        categoriesWillCreateOrRename: Object.entries(CATEGORY_DEFS).map(([key, c]) => ({ key, title: c.title, mode: c.existingId ? 'rename existing' : 'create new' })),
        voiceCategoryRename: { id: VOICE_CATEGORY_ID, newTitle: VOICE_CATEGORY_TITLE },
        rolesToCreate,
        roleCleanupPlan: rolePlan,
      });
    }

    // ---- mode=apply: thực sự chỉnh sửa server ----
    const log = [];

    // 4a. Chuẩn bị category (đổi tên cái có sẵn / tạo cái còn thiếu)
    const categoryIdByKey = {};
    for (const [key, def] of Object.entries(CATEGORY_DEFS)) {
      if (def.existingId) {
        await discordApi(`/channels/${def.existingId}`, { method: 'PATCH', body: JSON.stringify({ name: def.title }) });
        categoryIdByKey[key] = def.existingId;
        log.push(`✏️ Đổi tên category → ${def.title}`);
      } else {
        const existingCat = channels.find((c) => c.type === 4 && c.name === def.title);
        if (existingCat) {
          categoryIdByKey[key] = existingCat.id;
          log.push(`↩️ Category đã có sẵn, dùng lại: ${def.title}`);
        } else {
          const created = await discordApi(`/guilds/${GUILD_ID}/channels`, {
            method: 'POST',
            body: JSON.stringify({ name: def.title, type: 4 }),
          });
          categoryIdByKey[key] = created.id;
          log.push(`📁 Tạo category mới: ${def.title}`);
        }
      }
      await sleep(500);
    }

    // 4b. Đổi tên category thoại
    try {
      await discordApi(`/channels/${VOICE_CATEGORY_ID}`, { method: 'PATCH', body: JSON.stringify({ name: VOICE_CATEGORY_TITLE }) });
      log.push(`✏️ Đổi tên category thoại → ${VOICE_CATEGORY_TITLE}`);
    } catch (e) {
      log.push(`❌ Lỗi đổi category thoại: ${e.message}`);
    }
    await sleep(500);

    // 4c. Đổi tên + chuyển category cho từng kênh cũ
    for (const item of channelPlanResolved) {
      try {
        await discordApi(`/channels/${item.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: item.newName, parent_id: categoryIdByKey[item.categoryKey] }),
        });
        log.push(`✅ #${item.oldName} → #${item.newName} (${item.categoryTitle})`);
      } catch (e) {
        log.push(`❌ Lỗi đổi kênh #${item.oldName}: ${e.message}`);
      }
      await sleep(700); // tránh rate limit đổi tên kênh
    }

    // 4d. Tạo thêm các kênh mới (tạm biệt + dàn kênh thập cẩm + giải trí)
    for (const item of channelsToCreate) {
      try {
        const created = await discordApi(`/guilds/${GUILD_ID}/channels`, {
          method: 'POST',
          body: JSON.stringify({ name: item.name, type: 0, parent_id: categoryIdByKey[item.categoryKey] }),
        });
        log.push(`✅ Tạo kênh mới: #${item.name} (${item.categoryTitle}) — id=${created.id}`);
      } catch (e) {
        log.push(`❌ Lỗi tạo kênh #${item.name}: ${e.message}`);
      }
      await sleep(700);
    }

    // 4e. Tạo dàn role mới
    for (const role of rolesToCreate) {
      try {
        await discordApi(`/guilds/${GUILD_ID}/roles`, {
          method: 'POST',
          body: JSON.stringify({ name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable }),
        });
        log.push(`✅ Tạo role mới: ${role.name}`);
      } catch (e) {
        log.push(`❌ Lỗi tạo role ${role.name}: ${e.message}`);
      }
      await sleep(700);
    }

    // 4f. Dọn role cũ (bỏ emoji rối, chuẩn màu) — role bảo vệ (bot khác) không động
    for (const item of rolePlan) {
      try {
        await discordApi(`/guilds/${GUILD_ID}/roles/${item.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: item.newName, color: item.newColor }),
        });
        log.push(`✅ Role "${item.oldName}" → "${item.newName}"`);
      } catch (e) {
        log.push(`❌ Lỗi đổi role "${item.oldName}": ${e.message}`);
      }
      await sleep(700);
    }

    // 4g. (Tùy chọn) đổi tên/icon c��� server
    if (process.env.SERVER_NEW_NAME || process.env.SERVER_ICON_URL) {
      try {
        const body = {};
        if (process.env.SERVER_NEW_NAME) body.name = process.env.SERVER_NEW_NAME;
        if (process.env.SERVER_ICON_URL) {
          const imgRes = await fetch(process.env.SERVER_ICON_URL);
          const buf = Buffer.from(await imgRes.arrayBuffer());
          const mime = imgRes.headers.get('content-type') || 'image/png';
          body.icon = `data:${mime};base64,${buf.toString('base64')}`;
        }
        await discordApi(`/guilds/${GUILD_ID}`, { method: 'PATCH', body: JSON.stringify(body) });
        log.push('✅ Đã đổi tên/icon server.');
      } catch (e) {
        log.push(`❌ Lỗi đổi tên/icon server: ${e.message}`);
      }
    }

    logger.info(`[reorganize] Apply xong: ${log.length} thay đổi.`);
    return res.status(200).json({ mode, log });
  } catch (e) {
    logger.error('[reorganize] Lỗi:', e.message);
    return res.status(500).json({ error: e.message });
  } finally {
    if (mode === 'apply') reorganizeApplyRunning = false;
  }
});


// ---------------------------------------------------------------------------
// 🧹 Dọn trùng lặp — phòng trường hợp /admin/reorganize?mode=apply bị gọi
// nhiều lần cùng lúc (ví dụ request trước timeout phía client nhưng server
// vẫn đang chạy tiếp), khiến các category/kênh "tạo mới" bị tạo lầp.
// Endpoint này gộp các category/kênh trùng tên lại thành 1 (giự bản cũ
// nhất = id nhỏ nhất), chuyển hết kênh con về bản giự lại, rồi xoá bản dư.
// ---------------------------------------------------------------------------
const DEDUPE_CATEGORY_TITLES = Object.values(CATEGORY_DEFS)
  .filter((c) => !c.existingId)
  .map((c) => c.title);
const DEDUPE_CHANNEL_NAMES = NEW_CHANNELS_TO_CREATE.map((c) => c.name);

app.get('/admin/cleanup-duplicates', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  const mode = req.query.mode === 'apply' ? 'apply' : 'dry-run';

  try {
    const channels = await discordApi(`/guilds/${GUILD_ID}/channels`);

    const dupCategoryGroups = [];
    for (const title of DEDUPE_CATEGORY_TITLES) {
      const matches = channels
        .filter((c) => c.type === 4 && c.name === title)
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      if (matches.length > 1) dupCategoryGroups.push({ title, keep: matches[0], remove: matches.slice(1) });
    }

    const dupChannelGroups = [];
    for (const name of DEDUPE_CHANNEL_NAMES) {
      const lowerName = name.toLowerCase();
      const matches = channels
        .filter((c) => c.type === 0 && c.name.toLowerCase() === lowerName)
        .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      if (matches.length > 1) dupChannelGroups.push({ name, keep: matches[0], remove: matches.slice(1) });
    }

    if (mode === 'dry-run') {
      logger.info(`[cleanup] Dry-run: ${dupCategoryGroups.length} category trung, ${dupChannelGroups.length} kenh trung.`);
      return res.status(200).json({
        mode,
        note: 'CHUA xoa gi ca. Xem ky roi goi lai &mode=apply de don trung.',
        dupCategoryGroups: dupCategoryGroups.map((g) => ({ title: g.title, keepId: g.keep.id, removeIds: g.remove.map((c) => c.id) })),
        dupChannelGroups: dupChannelGroups.map((g) => ({ name: g.name, keepId: g.keep.id, removeIds: g.remove.map((c) => c.id) })),
      });
    }

    const log = [];

    // 1) Gop category trung: chuyen het kenh con cua ban du ve ban giu lai, roi xoa ban du
    for (const group of dupCategoryGroups) {
      const removeIds = new Set(group.remove.map((c) => c.id));
      const children = channels.filter((c) => c.parent_id && removeIds.has(c.parent_id));
      for (const child of children) {
        try {
          await discordApi(`/channels/${child.id}`, { method: 'PATCH', body: JSON.stringify({ parent_id: group.keep.id }) });
          log.push(`↪️ Chuyen #${child.name} ve category giu lai (${group.title})`);
        } catch (e) {
          log.push(`❌ Loi chuyen #${child.name}: ${e.message}`);
        }
        await sleep(600);
      }
      for (const dup of group.remove) {
        try {
          await discordApi(`/channels/${dup.id}`, { method: 'DELETE' });
          log.push(`🗑️ Xoa category trung: ${group.title} (id=${dup.id})`);
        } catch (e) {
          log.push(`❌ Loi xoa category ${group.title} (id=${dup.id}): ${e.message}`);
        }
        await sleep(600);
      }
    }

    // 2) Xoa kenh thuong bi trung ten (giu ban cu nhat)
    for (const group of dupChannelGroups) {
      for (const dup of group.remove) {
        try {
          await discordApi(`/channels/${dup.id}`, { method: 'DELETE' });
          log.push(`🗑️ Xoa kenh trung: #${group.name} (id=${dup.id})`);
        } catch (e) {
          log.push(`❌ Loi xoa kenh ${group.name} (id=${dup.id}): ${e.message}`);
        }
        await sleep(600);
      }
    }

    logger.info(`[cleanup] Don trung xong: ${log.length} thay doi.`);
    return res.status(200).json({ mode, log });
  } catch (e) {
    logger.error('[cleanup] Loi:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

if (GUILD_ID && ADMIN_SECRET) {
  logger.info('[reorganize] Server Organizer sẵn sàng tại /admin/reorganize (cần ?secret=...).');
}



printStartupSummary();
loginWithRetry();
