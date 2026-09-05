/**
 * user-token-store.js
 * Lưu trữ User Token của Discord được mã hóa AES-256-GCM.
 * Key mã hóa lấy từ env QUEST_ENCRYPTION_KEY (32 bytes = 256 bits).
 * Token KHÔNG BAO GIỜ lưu dạng plaintext — chỉ giải mã tạm thời trong RAM khi cần.
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');

const ALGO = 'aes-256-gcm';
const IV_LEN = 16;
const TAG_LEN = 16;

function getEncryptionKey() {
  const raw = process.env.QUEST_ENCRYPTION_KEY || '';
  if (!raw) {
    // Tạo key ngẫu nhiên nếu thiếu env — token sẽ mất sau restart (cảnh báo)
    if (!getEncryptionKey._warned) {
      console.warn('[user-token-store] ⚠️ QUEST_ENCRYPTION_KEY chưa được đặt. Token sẽ bị mất sau mỗi lần restart. Hãy đặt biến env này trên Render!');
      getEncryptionKey._warned = true;
    }
    if (!getEncryptionKey._fallback) {
      getEncryptionKey._fallback = crypto.randomBytes(32);
    }
    return getEncryptionKey._fallback;
  }
  // Dùng SHA-256 để đảm bảo luôn ra 32 bytes bất kể độ dài key
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  };
}

function decrypt(stored) {
  const key = getEncryptionKey();
  const iv = Buffer.from(stored.iv, 'hex');
  const tag = Buffer.from(stored.tag, 'hex');
  const data = Buffer.from(stored.data, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function createUserTokenStore(filePath) {
  const dir = path.dirname(filePath);

  function ensureDir() {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  function readAll() {
    try {
      if (!fs.existsSync(filePath)) return {};
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeAll(data) {
    ensureDir();
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, filePath);
  }

  /**
   * Lưu token cho userId (mã hóa trước khi ghi).
   * @param {string} userId  Discord user ID
   * @param {string} token   Plaintext user token
   */
  function set(userId, token) {
    const all = readAll();
    all[userId] = {
      encrypted: encrypt(token),
      savedAt: new Date().toISOString(),
    };
    writeAll(all);
  }

  /**
   * Lấy token plaintext (giải mã trong RAM).
   * @param {string} userId
   * @returns {string|null}
   */
  function get(userId) {
    const all = readAll();
    const entry = all[userId];
    if (!entry) return null;
    try {
      return decrypt(entry.encrypted);
    } catch {
      return null;
    }
  }

  /**
   * Kiểm tra userId có token không.
   * @param {string} userId
   * @returns {boolean}
   */
  function has(userId) {
    const all = readAll();
    return Boolean(all[userId]);
  }

  /**
   * Xóa token của userId.
   * @param {string} userId
   */
  function remove(userId) {
    const all = readAll();
    delete all[userId];
    writeAll(all);
  }

  /**
   * Danh sách userId đã lưu token (không trả token).
   * @returns {string[]}
   */
  function list() {
    return Object.keys(readAll());
  }

  /**
   * Thông tin lưu của userId (không có token).
   * @param {string} userId
   */
  function info(userId) {
    const all = readAll();
    const entry = all[userId];
    if (!entry) return null;
    return { userId, savedAt: entry.savedAt };
  }

  return { set, get, has, remove, list, info };
}

module.exports = { createUserTokenStore };
