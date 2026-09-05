/**
 * quest-engine.js  — REST-only Discord Quest client
 * KHÔNG dùng WebSocket/Gateway — chỉ dùng REST API.
 * Nhanh hơn, ổn định hơn trên Render Free Tier.
 */

'use strict';

const { REST, DefaultRestOptions } = require('@discordjs/rest');
const { randomUUID } = require('node:crypto');

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

function makePatchedFetch(clientProps) {
  return async function patchedFetch(url, init) {
    if (init && init.headers) {
      // Dùng undici Headers nếu có, fallback về global
      let h;
      try { h = new (require('undici').Headers)(init.headers); }
      catch { h = new global.Headers(init.headers); }

      if (h.has('User-Agent')) h.set('User-Agent', USER_AGENT);
      // Bỏ prefix "Bot " — đây là user token
      if (h.has('Authorization')) {
        h.set('Authorization', h.get('Authorization').replace(/^Bot /i, ''));
      }
      h.set('accept-language', 'vi');
      h.set('origin', 'https://discord.com');
      h.set('pragma', 'no-cache');
      h.set('referer', 'https://discord.com/channels/@me');
      h.set('sec-ch-ua', '"Not)A;Brand";v="8", "Chromium";v="138"');
      h.set('sec-ch-ua-mobile', '?0');
      h.set('sec-ch-ua-platform', '"Windows"');
      h.set('sec-fetch-dest', 'empty');
      h.set('sec-fetch-mode', 'cors');
      h.set('sec-fetch-site', 'same-origin');
      h.set('x-debug-options', 'bugReporterEnabled');
      h.set('x-discord-locale', 'en-US');
      h.set('x-discord-timezone', 'Asia/Saigon');
      h.set('x-super-properties', Buffer.from(JSON.stringify(clientProps)).toString('base64'));
      init.headers = h;
    }
    return DefaultRestOptions.makeRequest(url, init);
  };
}

/**
 * Tạo REST-only client cho Quest API dùng user token.
 * Không mở WebSocket — gọi trực tiếp HTTP.
 * @param {string} token  User token (plaintext, không log)
 */
function createQuestClient(token) {
  const clientProps = makeClientProps();
  const rest = new REST({ version: '10', makeRequest: makePatchedFetch(clientProps) }).setToken(token);

  return {
    _rest: rest,
    getSelf:     ()         => rest.get('/users/@me'),
    getBalance:  ()         => rest.get('/users/@me/virtual-currency/balance'),
    getQuests:   ()         => rest.get('/quests/@me'),
    claimReward: (questId)  => rest.post(`/quests/${questId}/claim-reward`, { body: {} }),
  };
}

module.exports = { createQuestClient };
