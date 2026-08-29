const fs = require('fs');
const path = require('path');

const GAME_PRESETS = [
  { id: 'wuwa', name: 'Wuthering Waves', emoji: '🌌', statuses: ['Exploring the Solaris-3', 'Farming Echoes', 'Tower of Adversity', 'Tuning 5★ Echoes'] },
  { id: 'genshin', name: 'Genshin Impact', emoji: '✨', statuses: ['Exploring Teyvat', 'Farming Artifacts', 'Spiral Abyss', 'Commission Run'] },
  { id: 'hsr', name: 'Honkai: Star Rail', emoji: '🚂', statuses: ['Trailblazing the Cosmos', 'Farming Relics', 'Memory of Chaos', 'Daily Training'] },
  { id: 'zzz', name: 'Zenless Zone Zero', emoji: '⚡', statuses: ['Random Play Shift', 'Hollow Zero', 'Farming Discs', 'Agent Training'] },
  { id: 'arknights', name: 'Arknights', emoji: '🛡️', statuses: ['Running Sanity', 'Contingency Contract', 'Recruiting Operators', 'Base Management'] },
  { id: 'bluearchive', name: 'Blue Archive', emoji: '📘', statuses: ['Schale Office', 'Tactical Contest', 'Cafe Visit', 'Mission Clear'] },
  { id: 'nikke', name: 'GODDESS OF VICTORY: NIKKE', emoji: '🎯', statuses: ['Outpost Duty', 'Special Interception', 'Simulation Room', 'Squad Training'] },
  { id: 'reverse1999', name: 'Reverse: 1999', emoji: '🕰️', statuses: ['Storm Research', 'Limbo Challenge', 'Insight Farming', 'Wilderness Care'] },
  { id: 'lovedandeepspace', name: 'Love and Deepspace', emoji: '💫', statuses: ['Deepspace Hunter', 'Date Memory', 'Daily Agenda', 'Orbit Challenge'] },
  { id: 'tof', name: 'Tower of Fantasy', emoji: '🌠', statuses: ['Exploring Aesperia', 'Joint Operation', 'Bygone Phantasm', 'Suppressing World Boss'] },
];

function safeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || raw.length > 512) return '';
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.local')) return '';
    return url.toString();
  } catch (_) { return ''; }
}

function normalizeProfile(input = {}) {
  const preset = GAME_PRESETS.find((item) => item.id === input.gameId) || GAME_PRESETS[0];
  const duration = Math.min(1440, Math.max(5, Number(input.durationMinutes) || 30));
  const status = String(input.status || preset.statuses[0]).replace(/[\r\n]/g, ' ').slice(0, 90);
  return { gameId: preset.id, gameName: preset.name, emoji: preset.emoji, status, durationMinutes: duration, largeImageUrl: safeUrl(input.largeImageUrl), smallImageUrl: safeUrl(input.smallImageUrl), updatedAt: new Date().toISOString() };
}

function createGameProfileStore(filePath = path.join(process.cwd(), 'data', 'game-profiles.json')) {
  let profiles = {};
  try { profiles = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { profiles = {}; }
  function persist() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(profiles));
    fs.renameSync(tmp, filePath);
  }
  function set(userId, input) {
    const id = String(userId || '').replace(/[^0-9]/g, '').slice(0, 24);
    if (!id) throw new Error('User ID không hợp lệ');
    profiles[id] = normalizeProfile(input);
    const ids = Object.keys(profiles);
    if (ids.length > 250) delete profiles[ids[0]];
    persist();
    return profiles[id];
  }
  return { get: (userId) => profiles[String(userId)] || null, set, count: () => Object.keys(profiles).length, filePath };
}

module.exports = { GAME_PRESETS, normalizeProfile, createGameProfileStore };
