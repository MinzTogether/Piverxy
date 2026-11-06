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

Cách di chuyển an toàn khi app bị đóng giữa chừng hoặc gặp tệp trùng tên:
- **Nhật ký (journal):** trước khi chuyển bài đầu tiên, app ghi nhật ký (đi đâu, từ đâu, đã thử mấy lần), rồi mới ghi lựa chọn. Nếu app bị đóng giữa chừng, lần mở sau các bài còn ở thư mục cũ vẫn hiện và phát được tại chỗ, và việc chuyển tự chạy tiếp ở nền (khoảng 10 giây sau khi mở). Không có bài nào "biến mất".
- **Chép an toàn:** mỗi bài được chép sang tên tạm `.muriel-part-<tên>`, kiểm tra đúng dung lượng rồi mới đổi tên thật và xoá bản cũ. Bài chép dở không bao giờ mang tên thật; tệp tạm bị bỏ sót sẽ được dọn ở lần chạy sau.
- **Trùng tên ở thư mục đích:** app kiểm tra trước khi chép và không bao giờ chép đè lên tệp có sẵn, nên không phụ thuộc cách plugin Filesystem xử lý. Cùng tên và cùng dung lượng thì coi là bài đó đã có sẵn (lần chuyển trước dừng sau khi chép) và xoá bản cũ. Cùng tên nhưng khác dung lượng thì giữ nguyên cả hai tệp, bài đó ở lại thư mục cũ và app báo số bài bị bỏ qua.
- **Bài chép lỗi** (đầy bộ nhớ, mất quyền...): ở lại thư mục cũ, vẫn phát được, và được thử lại ở các lần mở sau (tối đa 3 lượt). Sau lượt thứ ba nhật ký bị bỏ; các bài đó vẫn nằm trên máy ở thư mục cũ nhưng app không còn liệt kê.
- Đổi thư mục lần nữa khi lần chuyển trước chưa xong thì chuyển luôn cả bài còn sót ở các thư mục cũ.
Nếu thư mục đã chọn không dùng được nữa (bị xoá, mất quyền), app quay về `Music/Muriel Mod` thay vì mất bài.
Android 11+ không cho app tự tạo thư mục tuỳ ý ở gốc bộ nhớ, nên mới giới hạn trong các thư mục chuẩn ở trên.

## 2. Playlist từ tệp âm thanh cục bộ nằm ngang hàng với thư mục tải

Nút **Folder playlists** ở màn hình *My files* (chỉ hiện trên Android):

- Quét thư mục cha của thư mục tải về. Mỗi thư mục con có nhạc (sâu tối đa 2 cấp) thành 1 playlist cùng tên.
- Các tệp nhạc nằm rời ở thư mục cha thành playlist **Local files**.
- Bỏ qua chính thư mục tải, thư mục ẩn (bắt đầu bằng dấu chấm), `Android`, và tệp không phải âm thanh.
- Quét lại: thêm bài mới vào playlist cũ, bỏ bài đã bị xoá khỏi máy. Bài chỉ bị bỏ khi mọi yêu cầu liên kết với server đều thành công (kiểm tra mã HTTP) **và** lần quét đọc được đủ mọi thư mục. Nếu một thư mục không đọc được (hoặc vượt giới hạn 5000 bài) thì không xoá gì và app báo "Some folders could not be read".
- Tệp được **liên kết tại chỗ**, không sao chép; Muriel không bao giờ xoá chúng.
- Định dạng: mp3, m4a, flac, opus, wav, ogg/oga, aac, weba.

Ví dụ: tải về `Music/Muriel Mod` thì quét ra các thư mục trong `Music/`. Chọn App folder thì quét ra các thư mục nằm cạnh `.../files/download`.

## Quyền đọc nhạc

Từ Android 11, app chỉ thấy tệp do chính nó tạo. Nhạc bạn chép vào `Music/` hay `Download/` bằng file manager hoặc từ máy tính, hoặc bài do bản cài trước của app tải, sẽ bị ẩn cho tới khi app được phép đọc nhạc và âm thanh. Plugin Filesystem coi như luôn "đã cấp" từ Android 11 nên không bao giờ hỏi quyền này.
- Manifest: thêm `READ_MEDIA_AUDIO` (Android 13+) và nới `READ_EXTERNAL_STORAGE` lên `maxSdkVersion=32` (Android 12 trở xuống). Không dùng `MANAGE_EXTERNAL_STORAGE` (quyền "truy cập mọi tệp") vì quá rộng so với nhu cầu.
- `MediaControlsPlugin.java`: `audioAccess` (xem trạng thái) và `allowAudioAccess` (hiện hộp thoại hệ thống; nếu đã từ chối hẳn thì mở trang cài đặt của app).
- Hỏi khi bấm **Folder playlists**, và chỉ khi thư mục tải nằm trong bộ nhớ chung. Thư mục "App folder" (`Android/data/<package>/files/...`) không cần quyền này nên không hỏi.
- Được cấp xong thì quét tiếp ngay, và các bài trong thư mục tải mà trước đó bị ẩn cũng hiện ra mà không cần khởi động lại app.
- Bị từ chối: app báo cần làm gì. Từ chối hẳn thì lần bấm sau mở trang cài đặt của app (bật mục nhạc và âm thanh, hoặc "Tệp và đa phương tiện" trên Android 11-12).

## Dịch thuật

Muriel dịch giao diện bằng máy lúc chạy (`i18n.js`), không có bảng dịch tĩnh. Nhãn trong `index.html` (nút *Folder playlists* và `title` của nó) tự được dịch cùng cả trang. Phần tạo bằng code thì đã nối vào hệ thống:
- Bảng chọn thư mục: mọi chữ của Muriel mang `data-i18n` (ô nhập dùng `data-i18n-attr="placeholder"`, thông báo lỗi dùng `text()`). Tên thư mục và đường dẫn đánh dấu `translate="no"` để không bị gửi đi dịch.
- Thông báo (toast) và lỗi từ lớp lưu trữ đều qua `Tm(...)`; các chuỗi mới nằm trong danh sách tải trước `I18N.known` ở `app.js` nên có sẵn bản dịch khi cần.
- Tên playlist "Local files" lấy bằng `T()` lúc tạo.

## Các tệp đã sửa

- `android/app/build.gradle`, `res/values/strings.xml`, `capacitor.config.json` — tên gói và tên app riêng cho bản mod
- `android/app/src/main/AndroidManifest.xml`, `MediaControlsPlugin.java` — quyền đọc nhạc
- `mobile/shims/store.js` — vị trí tải cấu hình được, kiểm tra ghi, di chuyển tệp, quét thư mục ngang hàng
- `mobile/electron-api.js` — bảng chọn thư mục (có dịch); `scanLocalFolders`
- `library-tools.js` — `linkFolderSongs` (liên kết rồi mới quên bài, chỉ khi an toàn)
- `mobile/shims/platform.js`, `server.js` — `LOCAL_LINK_DIR`, `/api/library-link`, `/api/library-unlink`, đọc tệp theo `item.path`
- `app.js`, `index.html`, `mobile/mobile.css`, `mobile/bridge.js`, `profiles-core.js` — nút, luồng quét/tạo playlist, hiện nút Change trên Android, 2 khoá chỉ-của-máy
- `test/android-store.test.js`, `test/library-link.test.js`, `test/android-picker.test.js`, `test/library-tools.test.js` — 43 test mới (có test app bị đóng giữa chừng, trùng tên, thử lại, quét đọc dở, bảng chọn, quyền đọc nhạc); `test/phone-store.test.js` — đổi tên thư mục mặc định

## Build

CI (`.github/workflows/android.yml`) ký bằng keystore trong GitHub Secrets của repo gốc, nên fork sẽ không build được nếu thiếu `MURIEL_KEYSTORE_B64` và `MURIEL_KEYSTORE_PASSWORD`.
Tự build: `npm ci && node mobile/build.mjs && npx cap sync android && cd android && ./gradlew assembleRelease` (cần JDK 21 và khoá ký của bạn).
Vì tên gói đã khác app gốc nên mod cài song song được, không cần gỡ app gốc. Chữ ký khác khoá cũng không sao: Android coi đây là hai app riêng.
Lần sau muốn cập nhật mod thì phải ký bằng đúng khoá bạn đã dùng cho lần đầu, nếu không Android sẽ đòi gỡ bản mod cũ trước.
