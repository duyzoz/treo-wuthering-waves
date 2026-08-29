const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPresenceEngine } = require('./presence-engine');
const { createObservability } = require('./observability');
const { RestTrafficGovernor } = require('./rest-governor');
const { createIncidentTimeline } = require('./incident-timeline');
const { createRemoteConfig } = require('./remote-config');
const { createStorageAdapter } = require('./storage-adapter');
const { isNightSaverActive, createAnomalyGuard, buildIncidentDigest } = require('./ops-guard');
const { createConfigBackup } = require('./config-backup');
const { createResourceGovernor, nextAdaptiveDelay } = require('./resource-governor');
const { healthScore, trend, isMaintenanceWindowActive } = require('./dashboard-metrics');
const { createSafeCleanup } = require('./safe-cleanup');

(async () => {
  const engine = createPresenceEngine(['⚔️ Hunting: Dreamless', '🗼 Tower of Adversity — Floor 10'], { minRotateMs: 1, maxRotateMs: 1 });
  assert.notEqual(engine.next(new Date('2026-08-29T20:00:00+07:00')).text, engine.next(new Date('2026-08-29T20:01:00+07:00')).text);
  const previousNightSaver = process.env.NIGHT_SAVER_ENABLED;
  delete process.env.NIGHT_SAVER_ENABLED;
  assert.equal(isNightSaverActive(new Date('2026-08-29T23:30:00+07:00'), '23:00', '07:00'), true);
  assert.equal(isNightSaverActive(new Date('2026-08-29T12:00:00+07:00'), '23:00', '07:00'), false);
  if (previousNightSaver !== undefined) process.env.NIGHT_SAVER_ENABLED = previousNightSaver;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-wave-'));
  const obs = createObservability(path.join(dir, 'observability.json'), { sampleEveryMs: 0 });
  obs.sample({ ramMiB: 100, cpu: 0.01, heapMiB: 20 }); obs.sample({ ramMiB: 200, cpu: 0.03, heapMiB: 40 }); obs.recordReconnect(); obs.recordRateLimit();
  assert.deepEqual(obs.summary().ramMiB, { min: 100, avg: 150, max: 200 });

  const timeline = createIncidentTimeline(path.join(dir, 'incidents.json'), { maxEvents: 2 });
  timeline.record('DISCORD_OFFLINE', 'offline'); timeline.record('RATE_LIMIT', 'throttled'); timeline.record('MEMORY_HIGH', 'high');
  assert.equal(timeline.recent(10).length, 2);
  assert.equal(buildIncidentDigest(timeline.recent(10)).level, 'WARN');
  const guard = createAnomalyGuard({ cooldownMs: 60_000 });
  const alert = guard.evaluate({ container: { memory: { bytes: 900, limitBytes: 1000 }, cpu: '0.01' } }, [], Date.now());
  assert.equal(alert.severity, 'WARN');

  const config = createRemoteConfig(path.join(dir, 'remote-config.json')); const originalVersion = config.get().version;
  config.update({ channels: { log: '123456789012345678' } }, 'test'); assert.equal(config.get().channels.log, '123456789012345678'); config.rollback('test'); assert.equal(config.get().version, originalVersion + 2);
  const backup = createConfigBackup(path.join(dir, 'remote-config.json')); backup.backup(config.get()); assert.equal(backup.list().length, 1); assert.equal(backup.rollback().version, config.get().version);
  const storage = createStorageAdapter({ filePath: path.join(dir, 'storage.json') }); await storage.write({ ok: true }); assert.deepEqual(await storage.read(), { ok: true });

  const budget = createResourceGovernor({ maxRequestsPerDay: 2, maxDiscordUpdatesPerDay: 1, maxIoPerDay: 2 });
  assert.equal(budget.consume('request'), true, 'budget first request');
  assert.equal(budget.consume('request'), true, 'budget second request');
  assert.equal(budget.consume('request'), false, 'budget third request blocked');
  assert.equal(budget.snapshot().mode, 'health-only', 'budget health-only mode');
  assert.equal(nextAdaptiveDelay({ baseMs: 300000, health: { container: { memory: { bytes: 900, limitBytes: 1000 } } } }), 900000, 'adaptive delay');
  assert.equal(trend(12, 10), '↑');
  assert.equal(trend(10, 12), '↓');
  assert.equal(healthScore({ discordReady: true, officialBotReady: true, container: { memory: { bytes: 100, limitBytes: 1000 } }, errorCount: 0, rateLimitCount: 0 }).level, 'EXCELLENT');
  assert.equal(isMaintenanceWindowActive(new Date('2026-08-29T03:00:00+07:00'), '02:00', '05:00'), true);
  const cleanupDir = path.join(dir, 'data', 'tmp'); fs.mkdirSync(cleanupDir, { recursive: true }); fs.writeFileSync(path.join(cleanupDir, 'old.tmp'), 'old'); fs.writeFileSync(path.join(cleanupDir, 'keep.json'), '{}'); const oldTime = Date.now() - 2 * 24 * 60 * 60 * 1000; fs.utimesSync(path.join(cleanupDir, 'old.tmp'), oldTime / 1000, oldTime / 1000);
  const cleanup = createSafeCleanup({ rootDir: cleanupDir, maxAgeMs: 24 * 60 * 60 * 1000 }); assert.equal(cleanup.run(Date.now()).removed, 1); assert.equal(fs.existsSync(path.join(cleanupDir, 'keep.json')), true);

  let calls = 0; const governor = new RestTrafficGovernor({ maxPerSecond: 1000, burst: 1, fetchImpl: async () => { calls += 1; return new Response(JSON.stringify({ retry_after: 0.01, global: true }), { status: 429, headers: { 'content-type': 'application/json', 'x-ratelimit-global': 'true' } }); } });
  await governor.request('https://discord.test/api', {}, '/test').then(() => assert.fail('expected rate limit')).catch((error) => { assert.equal(error.name, 'DiscordRateLimitError'); assert.equal(error.global, true); });
  assert.equal(calls, 1); assert.ok(governor.snapshot().globalBlockedUntil > Date.now());
  console.log('safe cleanup regression tests: ok');
})().catch((error) => { console.error(error); process.exitCode = 1; });
