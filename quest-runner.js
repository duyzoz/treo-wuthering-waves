/**
 * quest-runner.js
 * Orchestrator chạy auto quest cho một user từ encrypted token.
 * Trả về kết quả dưới dạng object để slash command /auto-orb hiển thị.
 *
 * ⚠️ Token chỉ tồn tại dạng plaintext tạm thời trong bộ nhớ khi đang chạy.
 *    File này KHÔNG log token ra console/file.
 */

'use strict';

const { GatewayDispatchEvents } = require('discord-api-types/v10');

const TIMEOUT_MS = 10 * 60 * 1000; // 10 phút timeout toàn bộ quá trình

/**
 * Chạy auto quest cho một user token.
 *
 * @param {string} plainToken  - User token (plaintext, không bao giờ log)
 * @returns {Promise<{
 *   username: string,
 *   userId: string,
 *   orbsBefore: number|null,
 *   orbsAfter: number|null,
 *   orbsGained: number,
 *   quests: Array<{ name: string, reward: string, taskType: string, status: 'claimed'|'skipped'|'failed' }>,
 *   allCaughtUp: boolean,
 *   error: string|null,
 * }>}
 */
async function runQuestsForUser(plainToken) {
  const { HieuTool } = require('./quest-engine');

  const app = new HieuTool(plainToken);
  let settled = false;
  let resolveMain, rejectMain;
  const promise = new Promise((res, rej) => { resolveMain = res; rejectMain = rej; });

  // Timeout guard
  const timeoutId = setTimeout(() => {
    if (!settled) {
      settled = true;
      app.destroy().catch(() => {});
      rejectMain(new Error('Quest runner timeout sau 10 phút'));
    }
  }, TIMEOUT_MS);

  app.once(GatewayDispatchEvents.Ready, async ({ data }) => {
    if (settled) return;
    const user = data.user;
    const result = {
      username: user.username,
      userId: user.id,
      orbsBefore: null,
      orbsAfter: null,
      orbsGained: 0,
      quests: [],
      allCaughtUp: false,
      error: null,
    };

    try {
      // Lấy số orb trước
      try {
        const bal = await app.getBalance();
        result.orbsBefore = bal?.balance ?? null;
      } catch { /* Không ảnh hưởng flow chính */ }

      // Load quests
      const store = await app.loadQuests();

      // Claim trước các quest đã hoàn thành nhưng chưa claim
      const unclaimed = store.claimable();
      if (unclaimed.length > 0) {
        await store.grabAllRewards();
      }

      const pending = store.pending();

      if (pending.length === 0) {
        result.allCaughtUp = true;
        // Vẫn trả về danh sách tất cả quests để hiển thị
        const all = store.all();
        result.quests = all.map((q) => ({
          name: q.name,
          reward: q.getRewardLabel(),
          taskType: q.detectTaskType() || 'unknown',
          status: q.isClaimed() ? 'claimed' : q.isCompleted() ? 'done' : q.isExpired() ? 'expired' : 'active',
        }));
      } else {
        // Chạy từng quest song song
        const rawResults = await Promise.allSettled(
          pending.map((q) => store.execute(q)),
        );

        result.quests = pending.map((q, i) => ({
          name: q.name,
          reward: q.getRewardLabel(),
          taskType: q.detectTaskType() || 'unknown',
          status: rawResults[i]?.status === 'fulfilled' ? 'claimed' : 'failed',
          error: rawResults[i]?.status === 'rejected' ? String(rawResults[i].reason?.message || '').slice(0, 80) : undefined,
        }));
      }

      // Lấy số orb sau
      try {
        const bal = await app.getBalance();
        result.orbsAfter = bal?.balance ?? null;
        if (result.orbsBefore !== null && result.orbsAfter !== null) {
          result.orbsGained = result.orbsAfter - result.orbsBefore;
        }
      } catch { /* ignore */ }

    } catch (err) {
      result.error = String(err?.message || err).slice(0, 200);
    } finally {
      settled = true;
      clearTimeout(timeoutId);
      app.destroy().catch(() => {});
      resolveMain(result);
    }
  });

  // Lỗi gateway
  app.on('error', (err) => {
    if (!settled) {
      settled = true;
      clearTimeout(timeoutId);
      app.destroy().catch(() => {});
      rejectMain(err);
    }
  });

  app.start().catch((err) => {
    if (!settled) {
      settled = true;
      clearTimeout(timeoutId);
      rejectMain(err);
    }
  });

  return promise;
}

/**
 * Chỉ lấy số dư Orb của user (nhanh, không chạy quest).
 * @param {string} plainToken
 * @returns {Promise<{ username: string, userId: string, orbs: number|null }>}
 */
async function getOrbBalance(plainToken) {
  const { HieuTool } = require('./quest-engine');
  const app = new HieuTool(plainToken);
  let settled = false;
  let resolveMain, rejectMain;
  const promise = new Promise((res, rej) => { resolveMain = res; rejectMain = rej; });

  const timeoutId = setTimeout(() => {
    if (!settled) { settled = true; app.destroy().catch(() => {}); rejectMain(new Error('Timeout')); }
  }, 30_000);

  app.once(GatewayDispatchEvents.Ready, async ({ data }) => {
    if (settled) return;
    try {
      const bal = await app.getBalance().catch(() => null);
      settled = true;
      clearTimeout(timeoutId);
      app.destroy().catch(() => {});
      resolveMain({ username: data.user.username, userId: data.user.id, orbs: bal?.balance ?? null });
    } catch (err) {
      settled = true;
      clearTimeout(timeoutId);
      app.destroy().catch(() => {});
      rejectMain(err);
    }
  });

  app.on('error', (err) => {
    if (!settled) { settled = true; clearTimeout(timeoutId); app.destroy().catch(() => {}); rejectMain(err); }
  });

  app.start().catch((err) => {
    if (!settled) { settled = true; clearTimeout(timeoutId); rejectMain(err); }
  });

  return promise;
}

module.exports = { runQuestsForUser, getOrbBalance };
