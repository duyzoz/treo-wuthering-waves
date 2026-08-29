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

(async () => {
  const engine = createPresenceEngine(['⚔️ Hunting: Dreamless', '🗼 Tower of Adversity — Floor 10', '🗺️ Exploring — Jinzhou', '🎪 Event: Limited-Time Challenge', '⚒️ Forgery: Fusion Mats — Floor 4'], { minRotateMs: 1, maxRotateMs: 1 });
  const first = engine.next(new Date('2026-08-29T20:00:00+07:00'));
  const second = engine.next(new Date('2026-08-29T20:01:00+07:00'));
  assert.ok(first.category);
  assert.notEqual(first.text, second.text);
  assert.ok(first.durationMinutes > 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-observe-'));
  const obs = createObservability(path.join(dir, 'observability.json'), { sampleEveryMs: 0 });
  obs.sample({ ramMiB: 100, cpu: 0.01, heapMiB: 20 });
  obs.sample({ ramMiB: 200, cpu: 0.03, heapMiB: 40 });
  obs.recordReconnect();
  obs.recordRateLimit();
  const summary = obs.summary();
  assert.deepEqual(summary.ramMiB, { min: 100, avg: 150, max: 200 });
  assert.equal(summary.reconnects, 1);
  assert.equal(summary.rateLimits, 1);

  const timeline = createIncidentTimeline(path.join(dir, 'incidents.json'), { maxEvents: 2 });
  timeline.record('TEST_ONE', 'first');
  timeline.record('TEST_TWO', 'second');
  timeline.record('TEST_THREE', 'third');
  assert.equal(timeline.recent(10).length, 2);

  const config = createRemoteConfig(path.join(dir, 'remote-config.json'));
  const originalVersion = config.get().version;
  config.update({ channels: { log: '123456789012345678' } }, 'test');
  assert.equal(config.get().channels.log, '123456789012345678');
  config.rollback('test');
  assert.equal(config.get().version, originalVersion + 2);

  const storage = createStorageAdapter({ filePath: path.join(dir, 'storage.json') });
  await storage.write({ ok: true });
  assert.deepEqual(await storage.read(), { ok: true });

  let calls = 0;
  const governor = new RestTrafficGovernor({ maxPerSecond: 1000, burst: 1, fetchImpl: async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: 'You are being rate limited.', retry_after: 0.01, global: true }), { status: 429, headers: { 'content-type': 'application/json', 'x-ratelimit-global': 'true' } });
  } });
  await governor.request('https://discord.test/api', {}, '/test').then(() => assert.fail('expected rate limit')).catch((error) => {
    assert.equal(error.name, 'DiscordRateLimitError');
    assert.equal(error.global, true);
  });
  assert.equal(calls, 1);
  assert.ok(governor.snapshot().globalBlockedUntil > Date.now());
  console.log('wave regression tests: ok');
})().catch((error) => { console.error(error); process.exitCode = 1; });
