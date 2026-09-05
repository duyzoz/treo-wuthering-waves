# 🌊 Treo Wuthering Waves — All-In-One Discord Bot

Bot Discord chạy 24/7 trên **Render Free Tier** — tích hợp rich presence selfbot, log trạng thái hệ thống, welcome/goodbye và **Auto Quest Orb** cho tài khoản Discord cá nhân.

> Repo gốc giữ nguyên 100%. Tất cả tính năng mới chỉ được thêm vào, không xóa hay thay đổi tính năng cũ.

---

## 🆕 Thay đổi mới (Wave 31–35)

### ✅ Wave 31 — User Token Store (AES-256-GCM)
- **`user-token-store.js`**: Lưu User Token của Discord dạng mã hóa AES-256-GCM
- Token không bao giờ lưu dạng plaintext trên disk
- Key mã hóa từ env `QUEST_ENCRYPTION_KEY` (không ai đọc được token kể cả admin/chủ bot)
- Dữ liệu lưu tại `data/user-tokens.json`

### ✅ Wave 32 — Quest Engine (Port từ Discord-Auto-Quests-REMAKEBY-NGDUY)
- **`quest-engine.js`**: Port TypeScript engine sang JavaScript thuần
  - Giả lập fingerprint Discord Desktop Client (User-Agent, x-super-properties)
  - REST + WebSocket Gateway dùng User Token (không phải Bot Token)
  - Hỗ trợ đầy đủ Quest API: `/quests/@me`, `/quests/:id/heartbeat`, `/quests/:id/video-progress`, v.v.

### ✅ Wave 33 — Quest Store (All Task Types)
- **`quest-store.js`**: Xử lý mọi loại task Discord Quest
  - 🎬 Video watching (`WATCH_VIDEO`, `WATCH_VIDEO_ON_MOBILE`)
  - 🎮 Desktop gameplay & streaming (`PLAY_ON_DESKTOP`, `STREAM_ON_DESKTOP`)
  - 🎯 Console (`PLAY_ON_XBOX`, `PLAY_ON_PLAYSTATION`, `PLAY_ON_NINTENDO`)
  - 📱 Mobile/Social (`PLAY_ON_MOBILE`, `PLAY_ACTIVITY`, `PLAY_SOCIAL_GAME`)
  - 📹 Stream watching (`WATCH_STREAM`)
  - 👥 Social (`FOLLOW_SOCIAL`, `SHARE_CONTENT`, `JOIN_COMMUNITY`)
  - 📋 Generic (`COMPLETE_SURVEY`, `REDEEM_CODE`)
  - Jitter ±20% random sleep để tránh pattern detection

### ✅ Wave 34 — Quest Runner
- **`quest-runner.js`**: Orchestrator chạy quest hoàn chỉnh
  - `runQuestsForUser(token)`: login → load quests → claim unclaimed → execute pending → return kết quả
  - `getOrbBalance(token)`: lấy số dư Orbs nhanh (cho `/starstat`)
  - Timeout 10 phút toàn bộ quá trình
  - Log chỉ ghi `user_id`, KHÔNG BAO GIỜ log token

### ✅ Wave 35 — Slash Commands mới
3 lệnh slash mới được thêm vào bot chính thức:

#### `/token` 🔐
- Mở **Modal ephemeral** để user dán User Token Discord
- Bot verify token qua Discord API trước khi lưu
- Token được mã hóa AES-256-GCM ngay lập tức
- Reply ephemeral — chỉ người dùng thấy, không spam channel

#### `/auto-orb` 🔮
- Tự động hoàn thành tất cả Discord Quests của tài khoản người dùng
- Hiển thị bảng kết quả với từng quest: tên, phần thưởng, trạng thái
- Hiển thị số Orbs trước → sau → đã nhận được
- Reply ephemeral — private cho từng user

#### `/starstat` 🌟
- Status board đẹp hơn với:
  - Health Score màu động (🟢 xanh / 🟡 vàng / 🔴 đỏ)
  - RAM progress bar gradient
  - CPU, Heap, Uptime
  - Incident digest compact
  - Budget HUD
  - **Orbs của bạn** (nếu đã `/token`)
  - 24h min/avg/max stats

---

## 📦 Dependencies mới

Thêm vào `package.json` (tương thích với Node 20.x):

```json
"@discordjs/core": "^1.1.1",
"@discordjs/rest": "^2.2.0",
"@discordjs/ws": "^1.0.2",
"discord-api-types": "^0.37.61",
"undici": "^6.0.0"
```

---

## ⚙️ Biến môi trường mới

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `QUEST_ENCRYPTION_KEY` | Key mã hóa token user (bắt buộc để token bền qua restart) | Random (token mất sau restart) |

> ⚠️ **Quan trọng**: Đặt `QUEST_ENCRYPTION_KEY` trên Render Dashboard với ít nhất 32 ký tự ngẫu nhiên. Nếu không đặt, token của user sẽ bị mất mỗi lần bot restart/deploy.

---

## 🔒 Bảo mật Token

- User Token **không bao giờ** được gửi về server của bot theo dạng plaintext
- Token được mã hóa AES-256-GCM ngay khi user submit modal
- Key mã hóa chỉ tồn tại trên Render (env var), không trong source code
- Token chỉ được giải mã tạm thời trong RAM khi đang chạy quest
- Không ai — kể cả chủ tạo bot — có thể đọc token từ file `data/user-tokens.json`

---

## 🛠️ Cách dùng

### Người dùng

1. Vào Discord, mở DevTools `F12` → tab **Network** → tìm bất kỳ request nào đến `discord.com` → xem header `Authorization`
2. Gõ `/token` trong server → Dán token vào Modal → Submit
3. Gõ `/auto-orb` để tự động nhận tất cả Discord Quests & Orbs
4. Gõ `/starstat` để xem dashboard đẹp + số dư Orbs

### Slash Commands đầy đủ

| Lệnh | Mô tả |
|---|---|
| `/create` | Mở Game Studio panel |
| `/status` | Xem trạng thái bot (embed cũ) |
| `/incidents` | Xem incident 24h |
| `/presence` | Xem activity hiện tại |
| `/maintenance` | Admin: bật/tắt maintenance |
| `/token` | 🆕 Lưu User Token (ephemeral modal) |
| `/auto-orb` | 🆕 Tự động nhận Orbs |
| `/starstat` | 🆕 Dashboard đẹp với Orbs |

---

## 🏗️ Kiến trúc file

```
treo-wuthering-waves/
├── index.js                # Entry point — HTTP server + Discord bots + slash commands
├── official-bot.js         # Discord.js official bot (BOT_TOKEN)
├── presence-engine.js      # Weighted presence rotation
├── observability.js        # 24h snapshot RAM/CPU/heap
├── rest-governor.js        # Token bucket + circuit breaker
├── incident-timeline.js    # Event timeline
├── remote-config.js        # Remote config với version & audit
├── storage-adapter.js      # SQLite/S3/Redis adapter
├── ops-guard.js            # Night saver + anomaly guard
├── config-backup.js        # Config backup SHA-256
├── resource-governor.js    # Daily budget (requests/discord/io)
├── dashboard-metrics.js    # Health score, trend, budget HUD
├── safe-cleanup.js         # Dọn file tạm
├── game-profiles.js        # Game profile store
├── game-panel.js           # Game Studio panel components
├── quest-engine.js         # 🆕 Discord client dùng User Token cho Quest API
├── quest-store.js          # 🆕 Quest + QuestStore — execute all task types
├── quest-runner.js         # 🆕 Orchestrator chạy auto quest
├── user-token-store.js     # 🆕 AES-256-GCM encrypted token storage
├── logs.js                 # Log buffer
├── render.yaml             # Render config (selfbot mode)
└── render-official.yaml    # Render config (full official mode)
```

---

## 🌐 Endpoints HTTP

| Endpoint | Mô tả |
|---|---|
| `/ping` | Health check nhẹ nhất (UptimeRobot) |
| `/` | Trang chủ |
| `/health` | JSON đầy đủ cho monitoring |
| `/status` | HTML status page |
| `/public` | HTML public (auto-refresh 60s, không lộ secret) |
| `/ready` | Readiness check (Render) |
| `/incidents` | Incident timeline JSON |
| `/admin/config` | Admin: xem/sửa config (yêu cầu `x-admin-key`) |

---

## 📋 Waves đã triển khai

| Wave | Tính năng |
|---|---|
| 1 | Presence Engine (farming/boss/tower/exploration/event) |
| 2 | Observability 24h snapshots |
| 3 | REST Governor (token bucket, cooldown, circuit breaker) |
| 4 | `/ready`, watchdog, graceful SIGTERM, memory warning |
| 5 | Official Bot Mode (discord.js Gateway) |
| 6 | Neon Dashboard Theme |
| 7 | Incident Timeline |
| 8 | Remote Configuration |
| 9 | Storage Adapter |
| 10 | Full Official Mode flag |
| 11 | Night Saver |
| 12 | Ops Guard (anomaly warning) |
| 13 | Compact Incident Digest |
| 14 | Slash Commands: `/status` `/incidents` `/presence` `/maintenance` |
| 15 | Config Backup (SHA-256, rollback) |
| 16 | Resource Governor (daily budget) |
| 17 | Adaptive Polling |
| 18 | `/public` endpoint |
| 19 | Admin Config API |
| 20 | Official Blueprint `render-official.yaml` |
| 21 | Compact Embed V2 |
| 22 | Persona Presence |
| 23 | Health Score |
| 24 | Trend Arrows |
| 25 | Smart fingerprint edit (chỉ edit khi thay đổi) |
| 26 | CDN thumbnail |
| 27 | Backoff reconnect |
| 28 | Budget display in embed |
| 29 | `/public` HTML inline |
| 30 | Maintenance Window |
| 31 | 🆕 User Token Store (AES-256-GCM) |
| 32 | 🆕 Quest Engine (port từ Discord-Auto-Quests-REMAKEBY-NGDUY) |
| 33 | 🆕 Quest Store (tất cả task types + jitter anti-detection) |
| 34 | 🆕 Quest Runner (orchestrator, timeout, no token log) |
| 35 | 🆕 Slash Commands: `/token` `/auto-orb` `/starstat` |
