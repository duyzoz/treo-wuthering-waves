/**
 * quest-runner.js — REST-only orchestrator (không dùng WebSocket)
 * Gọi trực tiếp Discord Quest API qua HTTP, không cần mở Gateway.
 * Timeout: 5 phút (an toàn với Discord slash command 15 phút limit).
 */

'use strict';

const { createQuestClient } = require('./quest-engine');
const { Quest, QuestStore } = require('./quest-store');

const TIMEOUT_MS = 5 * 60 * 1000; // 5 phút

/**
 * Chạy auto quest cho user token.
 * @param {string} plainToken
 */
async function runQuestsForUser(plainToken) {
  const client = createQuestClient(plainToken);

  // Wrapper timeout
  const withTimeout = (p) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('Quest timeout sau 5 phút')), TIMEOUT_MS)),
  ]);

  // Lấy thông tin user
  const user = await withTimeout(client.getSelf());

  // Số orb trước
  let orbsBefore = null;
  try { orbsBefore = (await client.getBalance()).balance ?? null; } catch { /* ignore */ }

  // Load danh sách quest
  const questsResponse = await withTimeout(client.getQuests());
  const store = new QuestStore(client, questsResponse.quests || []);

  // Claim những quest đã xong nhưng chưa nhận
  await store.grabAllRewards().catch(() => {});

  const pending = store.pending();

  if (pending.length === 0) {
    let orbsAfter = null;
    try { orbsAfter = (await client.getBalance()).balance ?? null; } catch { /* ignore */ }
    return {
      username: user.username,
      userId: user.id,
      orbsBefore,
      orbsAfter: orbsAfter ?? orbsBefore,
      orbsGained: 0,
      quests: store.all().map((q) => ({
        name: q.name,
        reward: q.getRewardLabel(),
        taskType: q.detectTaskType() || 'unknown',
        status: q.isClaimed() ? 'claimed' : q.isCompleted() ? 'done' : q.isExpired() ? 'expired' : 'active',
      })),
      allCaughtUp: true,
      error: null,
    };
  }

  // Thực hiện tất cả quest song song
  const rawResults = await Promise.allSettled(
    pending.map((q) => withTimeout(store.execute(q))),
  );

  // Số orb sau
  let orbsAfter = null;
  try { orbsAfter = (await client.getBalance()).balance ?? null; } catch { /* ignore */ }

  return {
    username: user.username,
    userId: user.id,
    orbsBefore,
    orbsAfter,
    orbsGained: (orbsAfter ?? 0) - (orbsBefore ?? 0),
    quests: pending.map((q, i) => ({
      name: q.name,
      reward: q.getRewardLabel(),
      taskType: q.detectTaskType() || 'unknown',
      status: rawResults[i]?.status === 'fulfilled' ? 'claimed' : 'failed',
      error: rawResults[i]?.status === 'rejected'
        ? String(rawResults[i].reason?.message || '').slice(0, 80)
        : undefined,
    })),
    allCaughtUp: false,
    error: null,
  };
}

/**
 * Chỉ lấy số dư Orbs (không chạy quest) — nhanh hơn, cho /starstat.
 * @param {string} plainToken
 */
async function getOrbBalance(plainToken) {
  const client = createQuestClient(plainToken);
  const [user, bal] = await Promise.all([
    client.getSelf(),
    client.getBalance().catch(() => null),
  ]);
  return {
    username: user.username,
    userId: user.id,
    orbs: bal?.balance ?? null,
  };
}

module.exports = { runQuestsForUser, getOrbBalance };
