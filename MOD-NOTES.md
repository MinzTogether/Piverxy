# Muriel mod — Android: cài song song với Muriel gốc, đổi thư mục tải, playlist từ thư mục ngang hàng

Dựa trên Muriel 1.3.10 (MIT, © rootscripts / cloverscripts). `LICENSE` giữ nguyên; bản phân phối lại phải kèm nó.

## 0. Cài song song với Muriel gốc

| | Muriel gốc | Mod |
|---|---|---|
| Tên gói (applicationId) | `io.github.cloverscripts.muriel` | `io.github.murielmod` |
| Tên hiện trên màn hình | Muriel | Muriel Mod |
| Thư mục tải mặc định | `Music/Muriel` | `Music/Muriel Mod` |
| Dữ liệu, playlist, đăng nhập | riêng | riêng (Android tách theo tên gói) |

- Hai app chạy độc lập: kênh thông báo, service phát nhạc, FileProvider (dùng `${applicationId}`) đều theo tên gói. App không mở socket thật nên không đụng cổng.
- Thư mục tải mặc định khác nhau vì Android 11+ không cho app này sửa/xoá tệp do app kia tạo trong cùng một thư mục.
- Tên gói chỉ đổi ở `android/app/build.gradle` (`applicationId`), `strings.xml`, `capacitor.config.json`. Java package (`namespace`) giữ nguyên nên không phải sửa code Java. Muốn đặt tên gói khác thì sửa 3 chỗ đó; phần còn lại của mod đọc tên gói lúc chạy.
- Còn hai chỗ dùng chung: (1) cả hai app đều nhận link `muriel://` (QR đồng bộ, link playlist), nên bấm vào link Android sẽ hỏi mở bằng app nào; (2) icon giống nhau, chỉ khác tên.
- Muốn dùng chung một thư mục tải cho cả hai app thì vẫn chọn được, nhưng trên Android 11+ mỗi app chỉ sửa/xoá được tệp do chính nó tải.

## 1. Đổi vị trí lưu bài tải về (Settings → Folders → Download folder → Change)

Nút **Change** / **Reset** trước đây bị ẩn trên điện thoại. Giờ trên Android, **Change** mở một bảng chọn:

- `Music/Muriel Mod` (mặc định; app nhạc và file manager thấy được)
- `Download/Muriel Mod`, `Documents/Muriel Mod`
- **App folder**: `Android/data/<package>/files/download` (không cần quyền; Android 11+ file manager không mở được thư mục này)
- **Another folder**: một thư mục bạn tự đặt tên bên trong Music / Download / Documents / Podcasts / Audiobooks

Có tuỳ chọn *Move the songs I already downloaded*. App kiểm tra ghi được trước khi lưu lựa chọn, rồi tự khởi động lại.
Nếu thư mục đã chọn không dùng được nữa (bị xoá, mất quyền), app quay về `Music/Muriel Mod` thay vì mất bài.
Android 11+ không cho app tự tạo thư mục tuỳ ý ở gốc bộ nhớ, nên mới giới hạn trong các thư mục chuẩn ở trên.

## 2. Playlist từ tệp âm thanh cục bộ nằm ngang hàng với thư mục tải

Nút **Folder playlists** ở màn hình *My files* (chỉ hiện trên Android):

- Quét thư mục cha của thư mục tải về. Mỗi thư mục con có nhạc (sâu tối đa 2 cấp) thành 1 playlist cùng tên.
- Các tệp nhạc nằm rời ở thư mục cha thành playlist **Local files**.
- Bỏ qua chính thư mục tải, thư mục ẩn (bắt đầu bằng dấu chấm), `Android`, và tệp không phải âm thanh.
- Quét lại: thêm bài mới vào playlist cũ, bỏ bài đã bị xoá khỏi máy.
- Tệp được **liên kết tại chỗ**, không sao chép; Muriel không bao giờ xoá chúng.
- Định dạng: mp3, m4a, flac, opus, wav, ogg/oga, aac, weba.

Ví dụ: tải về `Music/Muriel Mod` thì quét ra các thư mục trong `Music/`. Chọn App folder thì quét ra các thư mục nằm cạnh `.../files/download`.

## Các tệp đã sửa

- `android/app/build.gradle`, `res/values/strings.xml`, `capacitor.config.json` — tên gói và tên app riêng cho bản mod
- `mobile/shims/store.js` — vị trí tải cấu hình được, kiểm tra ghi, di chuyển tệp, quét thư mục ngang hàng
- `mobile/electron-api.js` — bảng chọn thư mục; `scanLocalFolders`
- `mobile/shims/platform.js`, `server.js` — `LOCAL_LINK_DIR`, `/api/library-link`, `/api/library-unlink`, đọc tệp theo `item.path`
- `app.js`, `index.html`, `mobile/mobile.css`, `mobile/bridge.js`, `profiles-core.js` — nút, luồng quét/tạo playlist, hiện nút Change trên Android, 2 khoá chỉ-của-máy
- `test/android-store.test.js`, `test/library-link.test.js` — 19 test mới; `test/phone-store.test.js` — đổi tên thư mục mặc định

## Build

CI (`.github/workflows/android.yml`) ký bằng keystore trong GitHub Secrets của repo gốc, nên fork sẽ không build được nếu thiếu `MURIEL_KEYSTORE_B64` và `MURIEL_KEYSTORE_PASSWORD`.
Tự build: `npm ci && node mobile/build.mjs && npx cap sync android && cd android && ./gradlew assembleRelease` (cần JDK 21 và khoá ký của bạn).
Vì tên gói đã khác app gốc nên mod cài song song được, không cần gỡ app gốc. Chữ ký khác khoá cũng không sao: Android coi đây là hai app riêng.
Lần sau muốn cập nhật mod thì phải ký bằng đúng khoá bạn đã dùng cho lần đầu, nếu không Android sẽ đòi gỡ bản mod cũ trước.
