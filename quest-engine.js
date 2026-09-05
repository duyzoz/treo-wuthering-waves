/**
 * quest-engine.js
 * Port từ engine.ts (Discord-Auto-Quests-REMAKEBY-NGDUY) sang JavaScript thuần.
 * Sử dụng @discordjs/rest + @discordjs/ws + @discordjs/core để kết nối
 * qua user token (không phải Bot Token) và giao tiếp với Discord Quest API.
 *
 * ⚠️  User token cần được xử lý cẩn thận — file này KHÔNG log token ra console.
 */

'use strict';

const { REST, DefaultRestOptions } = require('@discordjs/rest');
const { WebSocketManager, WebSocketShard } = require('@discordjs/ws');
const { Client } = require('@discordjs/core');
const { GatewayOpcodes } = require('discord-api-types/v10');
const { randomUUID } = require('node:crypto');

// ---------------------------------------------------------------------------
// Discord Client fingerprint — giả lập Desktop Client chuẩn
// ---------------------------------------------------------------------------
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9215 Chrome/138.0.7204.251 Electron/37.6.0 Safari/537.36';

function makeClientProps() {
  return {
    os: 'Windows',
    browser: 'Discord Client',
    release_channel: 'stable',
    client_version: '1.0.9215',
    os_version: '10.0.19045',
    os_arch: 'x64',
    app_arch: 'x64',
    system_locale: 'en-US',
    has_client_mods: false,
    client_launch_id: randomUUID(),
    browser_user_agent: USER_AGENT,
    browser_version: '37.6.0',
    os_sdk_version: '19045',
    client_build_number: 471091,
    native_build_number: 72186,
    client_event_source: null,
    launch_signature: randomUUID(),
    client_heartbeat_session_id: randomUUID(),
    client_app_state: 'focused',
  };
}

// ---------------------------------------------------------------------------
// patchedFetch — thêm headers Discord Client vào mọi REST request
// ---------------------------------------------------------------------------
function makePatchedFetch(clientProps) {
  return async function patchedFetch(url, init) {
    if (init && init.headers) {
      const h = new (require('undici').Headers)(init.headers);
      if (h.has('User-Agent')) h.set('User-Agent', USER_AGENT);
      // Bỏ prefix "Bot " nếu có — đây là user token
      if (h.has('Authorization')) {
        h.set('Authorization', h.get('Authorization').replace(/^Bot /i, ''));
      }
      h.append('accept-language', 'vi');
      h.append('origin', 'https://discord.com');
      h.append('pragma', 'no-cache');
      h.append('priority', 'u=1, i');
      h.append('referer', 'https://discord.com/channels/@me');
      h.append('sec-ch-ua', '"Not)A;Brand";v="8", "Chromium";v="138"');
      h.append('sec-ch-ua-mobile', '?0');
      h.append('sec-ch-ua-platform', '"Windows"');
      h.append('sec-fetch-dest', 'empty');
      h.append('sec-fetch-mode', 'cors');
      h.append('sec-fetch-site', 'same-origin');
      h.append('x-debug-options', 'bugReporterEnabled');
      h.append('x-discord-locale', 'en-US');
      h.append('x-discord-timezone', 'Asia/Saigon');
      h.append('x-super-properties', Buffer.from(JSON.stringify(clientProps)).toString('base64'));
      init.headers = h;
    }
    return DefaultRestOptions.makeRequest(url, init);
  };
}

// ---------------------------------------------------------------------------
// Patch WebSocketShard.send để gửi Identify payload đúng dạng user client
// ---------------------------------------------------------------------------
let _shardPatched = false;
function patchWebSocketShard(clientProps) {
  if (_shardPatched) return;
  _shardPatched = true;
  const origSend = WebSocketShard.prototype.send;
  WebSocketShard.prototype.send = async function (payload) {
    if (payload.op === GatewayOpcodes.Identify) {
      payload.d = {
        token: payload.d.token,
        properties: { ...clientProps, is_fast_connect: false, gateway_connect_reasons: 'AppSkeleton' },
        capabilities: 0,
        presence: payload.d.presence,
        compress: payload.d.compress,
        client_state: { guild_versions: {} },
      };
    }
    return origSend.call(this, payload);
  };
}

// ---------------------------------------------------------------------------
// HieuTool — Discord client dùng user token để gọi Quest API
// ---------------------------------------------------------------------------
class HieuTool extends Client {
  constructor(token) {
    const clientProps = makeClientProps();
    patchWebSocketShard(clientProps);
    const rest = new REST({ version: '10', makeRequest: makePatchedFetch(clientProps) }).setToken(token);
    const gw = new WebSocketManager({ token, intents: 0, rest });
    // Override fetchGatewayInformation để không gọi Bot endpoint
    gw.fetchGatewayInformation = () =>
      Promise.resolve({
        url: 'wss://gateway.discord.gg',
        shards: 1,
        session_start_limit: { total: 1000, remaining: 1000, reset_after: 14400000, max_concurrency: 1 },
      });
    super({ rest, gateway: gw });
    this._gw = gw;
    this._rest = rest;
  }

  /** Kết nối Gateway */
  start() {
    return this._gw.connect();
  }

  /** Lấy số dư Orbs của user */
  async getBalance() {
    return this._rest.get('/users/@me/virtual-currency/balance');
  }

  /** Claim reward cho một quest */
  async claimReward(questId) {
    return this._rest.post(`/quests/${questId}/claim-reward`, { body: {} });
  }

  /** Tải danh sách quest của user */
  async loadQuests() {
    const { QuestStore } = require('./quest-store');
    const res = await this._rest.get('/quests/@me');
    return new QuestStore(this, res.quests || []);
  }

  /** Huỷ kết nối Gateway */
  async destroy() {
    try { await this._gw.destroy(); } catch { /* ignore */ }
  }
}

module.exports = { HieuTool };
