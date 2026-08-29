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
| `MONITOR_INTERVAL_MS` | `300000` | Monitor tối thiểu 5 phút/lần |
| `WELCOME_THROTTLE_MS` | `1800000` | Tối thiểu 30 phút giữa các welcome/goodbye |
| `FAKE_MEMBER_OFFSET` | `0` | Hiển thị member count thật |
| `DISABLE_WELCOME` | `false` | Tắt riêng welcome khi cần |
| `DISABLE_GOODBYE` | `false` | Tắt riêng goodbye khi cần |
| `OBSERVABILITY_FILE` | `data/observability.json` | Nơi lưu snapshot 24 giờ |

## Các Wave tiếp theo

Wave 6 có thể là **Neon Dashboard Theme**, chuyển dashboard sang card màu tím/xanh theo Wuthering Waves, có badge trạng thái, progress bar memory, chip category presence và biểu đồ 24 giờ.

Wave 7 là **Incident Timeline**, gom reconnect, rate-limit, deploy, memory warning và Discord outage thành timeline có mã sự kiện, giúp copy một lần khi cần chẩn đoán.

Wave 8 là **Remote Configuration**, dùng file cấu hình có version và validation để đổi activity, trọng số, thời lượng và channel mà không sửa source; mọi thay đổi được audit và rollback.

Wave 9 là **Storage Adapter**, hỗ trợ SQLite/S3/Redis hoặc dịch vụ key-value để snapshot 24 giờ sống qua redeploy Render thay vì chỉ lưu trên filesystem ephemeral.

Wave 10 là **Full Official Mode**, loại bỏ hoàn toàn `discord.js-selfbot-v13` sau khi chấp nhận bot presence chính thức thay cho rich presence tài khoản người dùng.

## Tài liệu tham khảo

Discord rate limits: <https://docs.discord.com/developers/topics/rate-limits>

Discord Gateway: <https://docs.discord.com/developers/events/gateway>

Discord privileged intents: <https://support-dev.discord.com/hc/en-us/articles/6207308062871-What-are-Privileged-Intents>
