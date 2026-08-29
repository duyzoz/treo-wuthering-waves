# Wuthering Waves Bot — Waves 1–5

## Đã triển khai

Wave 1 dùng `presence-engine.js` để phân loại activity thành `farming`, `boss`, `tower`, `exploration` và `event`. Mỗi nhóm có trọng số, cửa sổ giờ, thời lượng dự kiến và cơ chế không lặp activity liền nhau.

Wave 2 dùng `observability.js` để lưu snapshot tối đa 24 giờ gồm RAM container, CPU, Heap JS, reconnect và rate-limit. File runtime mặc định là `data/observability.json`; có thể đổi bằng `OBSERVABILITY_FILE`. Vì filesystem của Render Free có thể bị thay mới khi deploy, muốn dữ liệu sống qua redeploy cần trỏ biến này tới storage bên ngoài có persistence.

Wave 3 dùng `rest-governor.js` để điều phối REST theo token bucket, route cooldown, global cooldown và circuit breaker. Request 429 đọc đúng thời gian retry từ header/body và không retry mù.

Wave 4 có `/ready`, watchdog reconnect không tự exit process, graceful SIGTERM, cảnh báo memory từ 85% và hai công tắc `DISABLE_WELCOME`/`DISABLE_GOODBYE` độc lập với monitor.

Wave 5 bật `OFFICIAL_BOT_MODE=true` trên Render. Bot chính thức dùng `discord.js` Gateway cho log, status message, welcome/goodbye và bot presence. Selfbot chỉ còn phần rich presence tài khoản cũ để tương thích; muốn loại hoàn toàn selfbot cần chuyển activity sang bot presence chính thức.

## Render configuration

`BOT_TOKEN` phải là token của Discord Application/Bot chính thức, không dùng user token. Trong Discord Developer Portal cần bật **Server Members Intent** nếu muốn nhận event member join/leave. Các biến quan trọng gồm:

| Biến | Giá trị gợi ý | Ý nghĩa |
|---|---:|---|
| `OFFICIAL_BOT_MODE` | `true` | Dùng bot chính thức cho REST/Gateway log và welcome |
| `FULL_OFFICIAL_MODE` | `false` | `true` sẽ tắt hẳn selfbot runtime và chỉ chạy bot chính thức |
| `STATUS_GIF_URL` | URL tùy chọn | GIF/CDN làm thumbnail; không tải file vào container |
| `EMBED_COLOR` | `0x6d5dfc` | Màu theme tím Wuthering Waves |
| `MONITOR_INTERVAL_MS` | `300000` | Monitor tối thiểu 5 phút/lần |
| `WELCOME_THROTTLE_MS` | `1800000` | Tối thiểu 30 phút giữa các welcome/goodbye |
| `FAKE_MEMBER_OFFSET` | `0` | Hiển thị member count thật |
| `DISABLE_WELCOME` | `false` | Tắt riêng welcome khi cần |
| `DISABLE_GOODBYE` | `false` | Tắt riêng goodbye khi cần |
| `OBSERVABILITY_FILE` | `data/observability.json` | Nơi lưu snapshot 24 giờ |

## Nguyên tắc tiết kiệm Render Free

Bot không tải video/GIF về filesystem, không tạo worker riêng cho từng tính năng và không polling dưới 5 phút cho monitor. Timeline và snapshot đều có giới hạn số bản ghi, ghi atomic và tự prune theo cửa sổ 24 giờ. Storage ngoài chỉ được đọc một lần lúc boot và ghi tối đa mỗi 15 phút khi có `PERSISTENCE_URL`; nếu không cấu hình URL ngoài thì bot chỉ dùng local file nhẹ.

## Các Wave tiếp theo

Wave 6 có thể là **Neon Dashboard Theme**, chuyển dashboard sang card màu tím/xanh theo Wuthering Waves, có badge trạng thái, progress bar memory, chip category presence và biểu đồ 24 giờ.

Wave 7 là **Incident Timeline**, gom reconnect, rate-limit, deploy, memory warning và Discord outage thành timeline có mã sự kiện, giúp copy một lần khi cần chẩn đoán.

Wave 8 là **Remote Configuration**, dùng file cấu hình có version và validation để đổi activity, trọng số, thời lượng và channel mà không sửa source; mọi thay đổi được audit và rollback.

Wave 9 là **Storage Adapter**, hỗ trợ SQLite/S3/Redis hoặc dịch vụ key-value để snapshot 24 giờ sống qua redeploy Render thay vì chỉ lưu trên filesystem ephemeral.

Wave 10 đã có cờ **Full Official Mode**. Đặt `FULL_OFFICIAL_MODE=true` để không đăng nhập selfbot, giảm cache selfbot và chạy log/welcome/presence bằng bot chính thức. Việc xóa dependency `discord.js-selfbot-v13` hoàn toàn là bước dọn cuối sau khi xác nhận không còn cần rich presence tài khoản người dùng.

## Wave 11–15 và cấu hình tiết kiệm

Wave 11 dùng `NIGHT_SAVER_ENABLED=true`, `NIGHT_SAVER_START=23:00`, `NIGHT_SAVER_END=07:00` và `NIGHT_SAVER_TZ=Asia/Ho_Chi_Minh`. Trong khung giờ này presence không rotate, welcome/goodbye bị tạm dừng và monitor không gửi status update; `/health` và `/ping` vẫn hoạt động để Render/UptimeRobot không restart nhầm.

Wave 12 chạy ngay trong monitor tick hiện có, không tạo timer mới. Guard cảnh báo khi RAM đạt 85%, CPU cao, reconnect lặp hoặc rate-limit lặp; cooldown mặc định 30 phút.

Wave 13 hiển thị một Compact Incident Digest trong status embed, gom event 30 phút thành `OK`, `WARN` hoặc `CRITICAL`, không tạo message mới cho mỗi event.

Wave 14 đăng ký slash commands một lần khi official bot ready: `/status`, `/incidents`, `/presence` và `/maintenance`. Hãy đặt `ADMIN_USER_IDS` bằng danh sách ID Discord admin phân tách bằng dấu phẩy; chỉ admin mới bật/tắt maintenance.

Wave 15 dùng `config-backup.js`, lưu tối đa 5 bản backup nhỏ trong file `.backups.json`, xác minh SHA-256 trước rollback và ghi atomic. Dữ liệu runtime nằm trong thư mục `data/` và không được commit.

## Wave 16–20 và profile Render

Wave 16 giới hạn mặc định `400` request/ngày, `300` Discord update/ngày và `1200` I/O/ngày qua `MAX_REQUESTS_PER_DAY`, `MAX_DISCORD_UPDATES_PER_DAY` và `MAX_IO_PER_DAY`. Khi chạm hạn mức, bot chuyển sang `health-only` và không edit Discord nữa.

Wave 17 dùng adaptive polling một timeout duy nhất. Trạng thái ổn định giữ chu kỳ tối thiểu 5 phút; RAM cao, CPU cao, reconnect hoặc rate-limit sẽ kéo dài tối đa 15–30 phút, sau đó hạ dần khi ổn định.

Wave 18 cung cấp `GET /public`, chỉ hiển thị Online/Offline, uptime, RAM, CPU và incident level. Route này không trả token, channel ID, admin key hoặc cấu hình nội bộ.

Wave 19 cung cấp `GET /admin/config`, `POST /admin/config` và `POST /admin/config/rollback`. Các route yêu cầu header `x-admin-key` khớp `ADMIN_CONFIG_KEY`, tự backup trước update và validation giới hạn body 16 KiB.

Wave 20 có blueprint `render-official.yaml`. Profile này dùng `package.official.json`, chỉ cài `discord.js` chính thức và `express`, chạy `FULL_OFFICIAL_MODE=true`, không nạp package selfbot. Profile hiện tại `render.yaml` vẫn giữ rich presence legacy để không thay đổi hành vi tài khoản đang dùng.

## Tài liệu tham khảo

Discord rate limits: <https://docs.discord.com/developers/topics/rate-limits>

Discord Gateway: <https://docs.discord.com/developers/events/gateway>

Discord privileged intents: <https://support-dev.discord.com/hc/en-us/articles/6207308062871-What-are-Privileged-Intents>
