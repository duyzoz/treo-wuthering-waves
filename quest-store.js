/**
 * quest-store.js
 * Port từ QuestStore + Quest trong engine.ts sang JavaScript thuần.
 * Xử lý toàn bộ logic nhận diện task type, tính tiến độ,
 * và thực thi từng loại quest (video, gameplay, stream, social, ...).
 */

'use strict';

const { randomUUID } = require('node:crypto');

// ---------------------------------------------------------------------------
// TaskType enum
// ---------------------------------------------------------------------------
const TaskType = {
  WATCH_VIDEO:         'WATCH_VIDEO',
  WATCH_VIDEO_ON_MOBILE: 'WATCH_VIDEO_ON_MOBILE',
  WATCH_STREAM:        'WATCH_STREAM',
  PLAY_ON_DESKTOP:     'PLAY_ON_DESKTOP',
  STREAM_ON_DESKTOP:   'STREAM_ON_DESKTOP',
  PLAY_ON_XBOX:        'PLAY_ON_XBOX',
  PLAY_ON_PLAYSTATION: 'PLAY_ON_PLAYSTATION',
  PLAY_ON_NINTENDO:    'PLAY_ON_NINTENDO',
  PLAY_ON_MOBILE:      'PLAY_ON_MOBILE',
  PLAY_ACTIVITY:       'PLAY_ACTIVITY',
  PLAY_SOCIAL_GAME:    'PLAY_SOCIAL_GAME',
  JOIN_COMMUNITY:      'JOIN_COMMUNITY',
  SHARE_CONTENT:       'SHARE_CONTENT',
  FOLLOW_SOCIAL:       'FOLLOW_SOCIAL',
  COMPLETE_SURVEY:     'COMPLETE_SURVEY',
  MAKE_PURCHASE:       'MAKE_PURCHASE',
  REDEEM_CODE:         'REDEEM_CODE',
};

// Thứ tự ưu tiên detect task type
const TASK_TYPE_PRIORITY = [
  TaskType.PLAY_ON_DESKTOP,
  TaskType.PLAY_ON_XBOX,
  TaskType.PLAY_ON_PLAYSTATION,
  TaskType.PLAY_ON_NINTENDO,
  TaskType.PLAY_ON_MOBILE,
  TaskType.PLAY_SOCIAL_GAME,
  TaskType.PLAY_ACTIVITY,
  TaskType.STREAM_ON_DESKTOP,
  TaskType.WATCH_STREAM,
  TaskType.WATCH_VIDEO,
  TaskType.WATCH_VIDEO_ON_MOBILE,
  TaskType.FOLLOW_SOCIAL,
  TaskType.SHARE_CONTENT,
  TaskType.JOIN_COMMUNITY,
  TaskType.COMPLETE_SURVEY,
  TaskType.REDEEM_CODE,
  TaskType.MAKE_PURCHASE,
];

// ---------------------------------------------------------------------------
// Quest — wrapper quanh dữ liệu quest thô từ API
// ---------------------------------------------------------------------------
class Quest {
  constructor(raw) {
    this._raw = raw;
  }

  static from(raw) { return new Quest(raw); }

  get id() { return this._raw.id; }
  get config() { return this._raw.config; }
  get userStatus() { return this._raw.user_status; }
  get preview() { return this._raw.preview; }
  get name() {
    return (this._raw.config?.messages?.quest_name || '').trim() || this.id;
  }

  isExpired(now = new Date()) {
    return now.getTime() > new Date(this._raw.config?.expires_at || 0).getTime();
  }
  isCompleted() { return Boolean(this.userStatus?.completed_at); }
  isEnrolled()  { return Boolean(this.userStatus?.enrolled_at); }
  isClaimed()   { return Boolean(this.userStatus?.claimed_at); }

  refreshStatus(status) { this._raw.user_status = status; }

  _getTasks() {
    return this.config?.task_config_v2?.tasks ?? this.config?.task_config?.tasks ?? null;
  }

  detectTaskType() {
    const tasks = this._getTasks();
    if (!tasks) return null;
    return TASK_TYPE_PRIORITY.find((t) => tasks[t] != null) ?? null;
  }

  getTarget() {
    const tt = this.detectTaskType();
    if (!tt) return 900;
    return this._getTasks()?.[tt]?.target ?? 900;
  }

  getProgress() {
    const tt = this.detectTaskType();
    if (!tt) return 0;
    return this.userStatus?.progress?.[tt]?.value ?? 0;
  }

  getRemaining() { return Math.max(0, this.getTarget() - this.getProgress()); }

  getRewardLabel() {
    const rewards = this.config?.rewards_config?.rewards;
    if (!rewards?.length) return 'Unknown';
    if (rewards[0].orb_quantity) return `${rewards[0].orb_quantity} Orbs`;
    return rewards[0].messages?.name ?? 'Unknown';
  }

  getOrbQuantity() {
    const rewards = this.config?.rewards_config?.rewards;
    if (!rewards?.length) return 0;
    return rewards[0].orb_quantity ?? 0;
  }
}

// ---------------------------------------------------------------------------
// QuestStore — tập hợp + thực thi quest
// ---------------------------------------------------------------------------
class QuestStore {
  constructor(engine, rawList = []) {
    this._engine = engine;
    this._pool = new Map();
    rawList.forEach((raw) => {
      const q = Quest.from(raw);
      this._pool.set(q.id, q);
    });
  }

  all()  { return Array.from(this._pool.values()); }
  find(id) { return this._pool.get(id); }
  get count() { return this._pool.size; }

  pending() {
    return this.all().filter((q) =>
      q.id !== '1412491570820812933' &&   // Loại trừ quest đặc biệt không auto được
      !q.isCompleted() &&
      !q.isExpired(),
    );
  }

  claimable() {
    return this.all().filter((q) => q.isCompleted() && !q.isClaimed());
  }

  async enroll(questId) {
    const res = await this._engine._rest.post(`/quests/${questId}/enroll`, {
      body: { location: 11, is_targeted: false, metadata_raw: null },
    });
    this.find(questId)?.refreshStatus(res);
  }

  async grabReward(questId) {
    try {
      return await this._engine.claimReward(questId);
    } catch {
      return null;
    }
  }

  async grabAllRewards() {
    for (const q of this.claimable()) {
      await this.grabReward(q.id);
    }
  }

  _sleep(ms) {
    // Jitter ±20% để tránh pattern nhận diện
    const jitter = Math.floor(ms * 0.2 * (Math.random() * 2 - 1));
    return new Promise((r) => setTimeout(r, Math.max(500, ms + jitter)));
  }

  async execute(quest) {
    const taskType = quest.detectTaskType();
    if (!taskType) return { skipped: true, reason: 'unknown task type' };

    if (!quest.isEnrolled()) {
      await this.enroll(quest.id);
    }

    const target = quest.getTarget();
    const done   = quest.getProgress();

    if (taskType === TaskType.WATCH_VIDEO || taskType === TaskType.WATCH_VIDEO_ON_MOBILE) {
      await this._executeVideoWatch(quest, taskType, target, done);
    } else if (taskType === TaskType.PLAY_ON_DESKTOP || taskType === TaskType.STREAM_ON_DESKTOP) {
      await this._executeDesktopGameplay(quest, taskType);
    } else if (taskType === TaskType.PLAY_ON_XBOX || taskType === TaskType.PLAY_ON_PLAYSTATION || taskType === TaskType.PLAY_ON_NINTENDO) {
      await this._executeConsoleGameplay(quest, taskType);
    } else if (taskType === TaskType.PLAY_ON_MOBILE || taskType === TaskType.PLAY_SOCIAL_GAME || taskType === TaskType.PLAY_ACTIVITY) {
      await this._executeMobileGameplay(quest, taskType);
    } else if (taskType === TaskType.WATCH_STREAM) {
      await this._executeStreamWatch(quest);
    } else if (taskType === TaskType.FOLLOW_SOCIAL) {
      await this._executeSocialAction(quest, 'follow', 'social');
    } else if (taskType === TaskType.SHARE_CONTENT) {
      await this._executeSocialAction(quest, 'share', 'social');
    } else if (taskType === TaskType.JOIN_COMMUNITY) {
      await this._executeSocialAction(quest, 'join', 'community');
    } else {
      await this._executeGenericProgress(quest);
    }

    await this.grabReward(quest.id);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Video watching (WATCH_VIDEO / WATCH_VIDEO_ON_MOBILE)
  // -------------------------------------------------------------------------
  async _executeVideoWatch(quest, _taskType, target, done) {
    const enrolledAt = new Date(quest.userStatus?.enrolled_at || Date.now()).getTime();
    let finished = false;

    while (true) {
      const maxAllowed = Math.floor((Date.now() - enrolledAt) / 1000) + 10;
      const diff = maxAllowed - done;
      const next = done + 7;

      if (diff >= 7) {
        const res = await this._engine._rest.post(`/quests/${quest.id}/video-progress`, {
          body: { timestamp: Math.min(target, next + Math.random()) },
        });
        finished = Boolean(res?.completed_at);
        done = Math.min(target, next);
      }

      if (next >= target) break;
      await this._sleep(1000);
    }

    if (!finished) {
      await this._engine._rest.post(`/quests/${quest.id}/video-progress`, {
        body: { timestamp: target },
      }).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Desktop gameplay + streaming (PLAY_ON_DESKTOP / STREAM_ON_DESKTOP)
  // -------------------------------------------------------------------------
  async _executeDesktopGameplay(quest, taskType) {
    const tasks = quest.config?.task_config_v2?.tasks ?? quest.config?.task_config?.tasks;
    const taskDef = tasks?.[taskType];
    const appId = taskDef?.applications?.[0]?.id ?? quest.config?.application?.id;

    while (!quest.isCompleted()) {
      const res = await this._engine._rest.post(`/quests/${quest.id}/heartbeat`, {
        body: { application_id: appId, terminal: false },
      }).catch(() => null);
      if (res) quest.refreshStatus(res);
      await this._sleep(60_000);
    }

    await this._engine._rest.post(`/quests/${quest.id}/heartbeat`, {
      body: { application_id: appId, terminal: true },
    }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Console gameplay (PLAY_ON_XBOX / PLAY_ON_PLAYSTATION / PLAY_ON_NINTENDO)
  // -------------------------------------------------------------------------
  async _executeConsoleGameplay(quest, taskType) {
    const tasks = quest.config?.task_config_v2?.tasks ?? quest.config?.task_config?.tasks;
    const taskDef = tasks?.[taskType];
    const appId = taskDef?.applications?.[0]?.id ?? quest.config?.application?.id;
    const platform = taskType.replace('PLAY_ON_', '');

    while (!quest.isCompleted()) {
      const res = await this._engine._rest.post(`/quests/${quest.id}/console-heartbeat`, {
        body: { application_id: appId, platform, terminal: false },
      }).catch(() => null);
      if (res) quest.refreshStatus(res);
      await this._sleep(60_000);
    }

    await this._engine._rest.post(`/quests/${quest.id}/console-heartbeat`, {
      body: { application_id: appId, platform, terminal: true },
    }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Mobile / Social / Activity (PLAY_ON_MOBILE / PLAY_SOCIAL_GAME / PLAY_ACTIVITY)
  // -------------------------------------------------------------------------
  async _executeMobileGameplay(quest, taskType) {
    const tasks = quest.config?.task_config_v2?.tasks ?? quest.config?.task_config?.tasks;
    const taskDef = tasks?.[taskType];
    const appId = taskDef?.applications?.[0]?.id ?? quest.config?.application?.id;

    while (!quest.isCompleted()) {
      const res = await this._engine._rest.post(`/quests/${quest.id}/mobile-heartbeat`, {
        body: { application_id: appId, session_id: randomUUID() },
      }).catch(() => null);
      if (res) quest.refreshStatus(res);
      await this._sleep(45_000);
    }
  }

  // -------------------------------------------------------------------------
  // Stream watching (WATCH_STREAM)
  // -------------------------------------------------------------------------
  async _executeStreamWatch(quest) {
    const enrolledAt = new Date(quest.userStatus?.enrolled_at || Date.now()).getTime();
    const target = quest.getTarget();
    let done = quest.getProgress();

    while (done < target) {
      const elapsed = Math.floor((Date.now() - enrolledAt) / 1000);
      const next = Math.min(done + 30, target);
      const res = await this._engine._rest.post(`/quests/${quest.id}/stream-progress`, {
        body: { timestamp: next, elapsed },
      }).catch(() => null);
      done = Math.min(target, next);
      if (res?.completed_at) break;
      await this._sleep(30_000);
    }
  }

  // -------------------------------------------------------------------------
  // Social actions (FOLLOW_SOCIAL / SHARE_CONTENT / JOIN_COMMUNITY)
  // -------------------------------------------------------------------------
  async _executeSocialAction(quest, action, platform) {
    const res = await this._engine._rest.post(`/quests/${quest.id}/social-action`, {
      body: { action, platform },
    }).catch(() => null);
    if (res) quest.refreshStatus(res);
  }

  // -------------------------------------------------------------------------
  // Generic progress polling (COMPLETE_SURVEY / REDEEM_CODE / MAKE_PURCHASE)
  // -------------------------------------------------------------------------
  async _executeGenericProgress(quest) {
    const maxAttempts = 100;
    let attempts = 0;
    while (!quest.isCompleted() && attempts < maxAttempts) {
      const res = await this._engine._rest.get(`/quests/${quest.id}/progress`).catch(() => null);
      if (res) quest.refreshStatus(res);
      attempts++;
      await this._sleep(10_000);
    }
  }
}

module.exports = { Quest, QuestStore, TaskType };
