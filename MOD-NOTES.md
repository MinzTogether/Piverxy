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

Cách di chuyển an toàn khi app bị đóng giữa chừng, gặp tệp trùng tên, mất quyền đọc hoặc lỗi đọc thư mục.
Nguyên tắc: **không bao giờ xoá hay ngừng liệt kê một bài chỉ vì app không đọc được, quét chưa đầy đủ, trùng tên, trùng dung lượng hoặc đã thử nhiều lần.** Bài ở lại và phát được cho tới khi xác minh được việc di chuyển đã xong.
- **Nhật ký (journal):** trước khi chuyển bài đầu tiên, app ghi nhật ký (đi đâu, từ đâu, đã chạy mấy lượt, lượt gần nhất còn lại gì), rồi mới ghi lựa chọn. Nếu app bị đóng giữa chừng, lần mở sau các bài còn ở thư mục cũ vẫn hiện và phát được tại chỗ, và việc chuyển tự chạy tiếp ở nền (khoảng 10 giây sau khi mở). Không có bài nào "biến mất".
- **Nhật ký chỉ bị xoá khi không còn gì phải xử lý.** Bài trùng tên (conflict), bài chép lỗi, bản cũ không xoá được, thư mục cũ không đọc được và thiếu quyền đọc nhạc đều giữ nhật ký. Số lượt chạy (`tries`) chỉ để đếm, không bao giờ làm nhật ký bị bỏ. Mỗi lần mở app chạy thử một lượt, và nút **Retry** trong Settings chạy ngay.
- **Chép an toàn:** mỗi bài được chép sang tên tạm `.muriel-part-<tên>`, kiểm tra đúng dung lượng rồi mới đổi tên thật, kiểm tra lại bản mới, và chỉ sau đó mới xoá bản cũ. Bài chép dở không bao giờ mang tên thật; tệp tạm bị bỏ sót sẽ được dọn ở lần chạy sau.
- **Trùng tên ở thư mục đích:** app kiểm tra trước khi chép và không bao giờ chép đè lên tệp có sẵn. **Cùng tên và cùng dung lượng không chứng minh là cùng một bài.** Chỉ khi hai tệp giống nhau từng byte (`MediaControlsPlugin.sameFile`: đọc từng khối 64 KB, không nạp cả tệp vào RAM, dừng ở byte khác đầu tiên) thì mới coi là lần chuyển trước dừng sau khi chép và xoá bản cũ. Khác nội dung, khác dung lượng, hoặc không so sánh được (plugin bản cũ, tệp không đọc được) thì là *conflict*: giữ nguyên cả hai tệp, không đoán.
- **Conflict vẫn hiện và phát được sau khi mở lại app:** bản ở thư mục cũ được liệt kê dưới tên `<tên> (old).<đuôi>` (hoặc `(old 2)`...), bản ở thư mục mới giữ tên gốc. Bạn tự xử lý (xoá hoặc đổi tên một trong hai tệp) rồi bấm **Retry**; app không tự xoá hay ghi đè.
- **Xoá bản cũ phải được xác nhận:** xoá xong app kiểm tra lại. Nếu bản cũ vẫn còn thì bài ở trạng thái *cleanup pending*, không tính là "đã chuyển": bản mới vẫn phát được, bản cũ không bị ép xoá, nhật ký được giữ để thử tiếp.
- **Thư mục cũ không đọc được ≠ thư mục đã mất:** lỗi quyền, I/O hoặc không rõ lý do thì thư mục đó tính là *unreadable* (giữ nhật ký, không coi là đã xử lý xong). Chỉ khi lỗi báo "không tồn tại" **và** kiểm tra lại cũng không thấy thư mục thì mới đánh dấu *missing*. Lỗi được ghi vào log (giai đoạn, đường dẫn, mã lỗi; không ghi nội dung bài).
- **Quyền đọc nhạc:** từ Android 11 một thư mục cũ có thể "trông như trống" vì bài do app khác tạo bị ẩn. Khi chưa có quyền, các bài nhìn thấy vẫn được chuyển nhưng nhật ký được giữ ("cần quyền") để chuyển nốt khi đã cấp quyền.
- **Bài chép lỗi** (đầy bộ nhớ, mất quyền...): ở lại thư mục cũ, vẫn phát được, và được thử lại ở mọi lần mở app sau đó cũng như khi bấm Retry (không giới hạn số lần).
- **Trạng thái và Retry:** nếu còn bài chưa chuyển, Settings → Folders → Download folder hiện số bài còn lại và lý do (trùng tên, chép lỗi, chưa xoá được bản cũ, thư mục cũ không đọc được, cần quyền) cùng nút **Retry**. Retry hỏi quyền đọc nhạc trước nếu việc chuyển đang chờ quyền, rồi chạy lại việc chuyển; có bài chuyển được thì app tự khởi động lại để làm mới danh sách.
- Đổi thư mục lần nữa khi lần chuyển trước chưa xong thì chuyển luôn cả bài còn sót ở các thư mục cũ.
Nếu thư mục đã chọn không dùng được nữa (bị xoá, mất quyền), app quay về `Music/Muriel Mod` thay vì mất bài.
Android 11+ không cho app tự tạo thư mục tuỳ ý ở gốc bộ nhớ, nên mới giới hạn trong các thư mục chuẩn ở trên.

## 2. Playlist từ tệp âm thanh cục bộ nằm ngang hàng với thư mục tải

Nút **Folder playlists** ở màn hình *My files* (chỉ hiện trên Android):

- Quét thư mục cha của thư mục tải về. Mỗi thư mục con có nhạc (sâu tối đa 2 cấp) thành 1 playlist cùng tên.
- Các tệp nhạc nằm rời ở thư mục cha thành playlist **Local files**.
- Bỏ qua chính thư mục tải, thư mục ẩn (bắt đầu bằng dấu chấm), `Android`, và tệp không phải âm thanh.
- Quét lại: thêm bài mới vào playlist cũ, bỏ bài đã bị xoá khỏi máy. Bài chỉ bị bỏ khi mọi yêu cầu liên kết với server đều thành công (kiểm tra mã HTTP) **và** lần quét đọc được đủ mọi thư mục. Nếu một thư mục không đọc được (hoặc vượt giới hạn 5000 bài) thì không xoá gì và app báo "Some folders could not be read".
- Giới hạn 5000 bài tính trên **toàn bộ lần quét** (mọi thư mục cộng lại), không phải từng thư mục. Chạm giới hạn thì lần quét dừng và được đánh dấu *partial*; đúng 5000 bài mà không bỏ sót gì thì không phải partial.
- Danh sách thư mục đã liên kết (app dùng nó để khôi phục bài vào file index mỗi lần mở) chỉ được ghi đúng theo kết quả khi lần quét **đầy đủ**. Lần quét dở (partial) chỉ **thêm** thư mục mới thấy, không bao giờ bỏ thư mục nào: thư mục tạm thời không đọc được không bị coi là đã bị xoá, và vẫn được khôi phục ở lần mở sau.
- Tệp được **liên kết tại chỗ**, không sao chép; Muriel không bao giờ xoá chúng.
- Định dạng: mp3, m4a, flac, opus, wav, ogg/oga, aac, weba.

Ví dụ: tải về `Music/Muriel Mod` thì quét ra các thư mục trong `Music/`. Chọn App folder thì quét ra các thư mục nằm cạnh `.../files/download`.

## 3. App cache — mở app nhanh hơn từ lần thứ hai

**Vì sao mở app chậm.** Giao diện chờ `getServerPort()`, mà hàm này chờ `fs.init()` và server chạy xong. Cho nên mọi thứ dưới đây đều nằm trên đường mở app:

- `fs.init()` liệt kê toàn bộ `/data` rồi đọc từng tệp `.json/.lrc/.txt` qua cầu nối Capacitor, mỗi tệp một lần gọi, ở **mọi** lần mở. Mỗi bài từng xem lời có một tệp `.lrc`, nên app càng dùng lâu càng mở chậm.
- Client YouTube (`youtubei.js`) không có cache: mỗi lần mở lại gọi `/v1/config`, `/iframe_api`, tải tệp player `base.js` (~2,5 MB) rồi phân tích nó, trước khi tìm kiếm hay gợi ý chạy được.
- Trang chủ hỏi lại My Wave (`/api/vibe`) và For you (`/api/discover`) ở mỗi lần mở và hiện vòng quay trong lúc chờ. Các cache của server (`searchCache`, `vibeCache`, …) nằm trong RAM nên mất khi app bị tắt.

**Cái gì được cache.** Tất cả nằm trong IndexedDB của WebView (không đi qua cầu nối) hoặc localStorage:

| Phần | Nằm ở | Dùng khi nào |
| --- | --- | --- |
| Nội dung tệp văn bản trong `/data` (`mobile/app-cache.js`, kho `texts`) | IndexedDB `muriel-app-cache` | `fs.init()` chỉ dùng bản lưu nếu **dung lượng và giờ sửa** của tệp y hệt lúc đọc trước. Khác một trong hai thì đọc lại như cũ. Tệp bị xoá thì bị bỏ khỏi cache; tệp sửa trong 2 giây cuối (hoặc không có giờ thật) không được nhớ |
| Player của YouTube (`mobile/extract.js`, kho `blobs`) | IndexedDB, khoá có kèm phiên bản `youtubei.js` | Vẫn gọi `/iframe_api` mỗi lần để biết player hiện hành nên player mới được nhận ngay; chỉ bỏ qua bước tải + phân tích khi đã có. Giữ 3 player mới nhất. Phiên (session) vẫn tạo mới mỗi lần như trước (`enable_session_cache: false`) |
| My Wave và For you (`mobile/home-cache.js`) | localStorage `muriel_appcache_wave`, `muriel_appcache_foryou` (theo hồ sơ) | Trang chủ hiện bản lưu ngay, rồi xin bản mới ở nền và thay vào. Mất mạng thì bản lưu ở lại thay vì báo lỗi. Quá 7 ngày, sai định dạng hoặc hỏng thì coi như không có. Nếu bạn đã cuộn My Wave thì bản mới chỉ được lưu cho lần sau, không giật màn hình |

**Nguyên tắc an toàn.**

- Cache chỉ là bộ tăng tốc. Không hàm nào trong `app-cache.js` / `home-cache.js` ném lỗi: IndexedDB thiếu, hỏng, treo hay bị tắt đều đọc ra "chưa có gì" và mọi nơi gọi làm đúng như trước khi có cache.
- Cố ý **không** cache danh sách tệp/thư mục (`store.list()`, `listDownloads`, thư mục liên kết). Đó là cách app biết tệp bị xoá, bị đổi hay mất quyền ở bên ngoài, và các quy tắc ở mục 1 và 2 dựa vào nó. Cũng không cache URL phát nhạc (hết hạn sau vài giờ) hay phiên YouTube.
- Tắt/bật ở Settings → Storage → **App cache** (khoá `muriel_app_cache`, `'0'` là tắt, dùng chung mọi hồ sơ). Tắt thì cache bị xoá sạch. Nút *Clear app cache* xoá ngay; hộp thoại *Clear cache* cũng xoá nó và hiện dung lượng ở dòng *Web & App Data*.
- `muriel_appcache_*` nằm trong `NEVER` của `backup-core.js`: không vào bản sao lưu hồ sơ.

**Kiểm tra trên máy.** Mỗi lần mở app ghi một dòng vào nhật ký (Settings → About → Share error log), ví dụ `start: 812 entries listed in 140 ms; 460 text files, 455 from the app cache, 5 read; ready in 210 ms`. Lần mở đầu tiên sau khi cập nhật bản mod thì `0 from the app cache` (cache còn trống, chậm như cũ); từ lần thứ hai gần hết tệp phải đến từ cache. Việc đo tốc độ thật trên điện thoại chưa làm được trong môi trường phát triển này.

**Tối ưu đường khởi động.** `getServerPort()` trên mobile trả cổng ngay lập tức thay vì chặn `DOMContentLoaded` chờ `fs.init()` (mọi lời gọi `fetch` / `electronAPI` cần file index đều tự đợi `ready` ở dưới nền). Nhờ vậy giao diện, theme và cache của My Wave / For you được vẽ ngay ở frame đầu tiên; đồng thời `fs.init()` nạp IndexedDB song song với `store.list()` và duyệt các thư mục con song song.

## Quyền đọc nhạc

Từ Android 11, app chỉ thấy tệp do chính nó tạo. Nhạc bạn chép vào `Music/` hay `Download/` bằng file manager hoặc từ máy tính, hoặc bài do bản cài trước của app tải, sẽ bị ẩn cho tới khi app được phép đọc nhạc và âm thanh. Plugin Filesystem coi như luôn "đã cấp" từ Android 11 nên không bao giờ hỏi quyền này.
- Manifest: thêm `READ_MEDIA_AUDIO` (Android 13+) và nới `READ_EXTERNAL_STORAGE` lên `maxSdkVersion=32` (Android 12 trở xuống). Không dùng `MANAGE_EXTERNAL_STORAGE` (quyền "truy cập mọi tệp") vì quá rộng so với nhu cầu.
- `MediaControlsPlugin.java`: `audioAccess` (xem trạng thái) và `allowAudioAccess` (hiện hộp thoại hệ thống; nếu đã từ chối hẳn thì mở trang cài đặt của app).
- `MediaControlsPlugin.sameFile` + `FileCompare.java`: so sánh hai tệp từng byte (dùng khi di chuyển, xem mục 1). Chạy trên luồng riêng, không chặn thông báo phát nhạc, và không ghi/xoá/đổi tên gì.
- Hỏi khi bấm **Folder playlists**, và chỉ khi thư mục tải nằm trong bộ nhớ chung. Thư mục "App folder" (`Android/data/<package>/files/...`) không cần quyền này nên không hỏi.
- Được cấp xong thì quét tiếp ngay, và các bài trong thư mục tải mà trước đó bị ẩn cũng hiện ra mà không cần khởi động lại app.
- Bị từ chối: app báo cần làm gì. Từ chối hẳn thì lần bấm sau mở trang cài đặt của app (bật mục nhạc và âm thanh, hoặc "Tệp và đa phương tiện" trên Android 11-12).

### Quyền bị thu hồi (Settings → Apps → Muriel Mod → Permissions)

Tắt quyền này thì các bài **liên kết tại chỗ** (thư mục ngang hàng với thư mục tải) bị **khoá tạm thời**: Android không cho đọc, nhưng bài vẫn ở trong thư viện và mọi playlist. Không bài nào bị gỡ liên kết, bị quên hay bị xoá vì lỗi quyền; bật lại quyền là phát lại được.
- Khoá chỉ là trạng thái tính từ quyền *hiện tại* (`store.linkedAccess()`), không lưu ở đâu nên không bao giờ bị kẹt. Được kiểm tra lại: lúc mở app, khi app quay lại màn hình (`visibilitychange` + `appStateChange`), trước mỗi lần quét, và ngay sau mỗi lần app tự xin quyền. Quên bước cuối thì khoá cũ sẽ chặn nhầm lần quét đầu tiên của người mới (test MP-16).
- Mở app khi chưa có quyền: `listLinked` không quét thư mục (Android chỉ trả về rỗng hoặc một phần) và không đụng vào `SIB_KEY`. Có quyền lại thì các bài được đưa vào chỉ mục tệp **trước**, rồi mới mở khoá (`refreshLinkedAccess`).
- `scanLinked` không quét và không ghi `SIB_KEY` khi thiếu quyền (trả `{ locked: true }`; kiểm tra lại sau khi quét xong, phòng quyền bị thu hồi giữa chừng). Trước đây một lần quét "đầy đủ nhưng không thấy gì" ghi đè danh sách thư mục đã nhớ và để `/api/library-unlink` quên hết bài, kéo theo mất bài khỏi mọi playlist.
- `server.js`: bài bị khoá trả `403 { code: "MEDIA_PERMISSION_REQUIRED" }` ở `/api/library-file` (không còn là 404 "File not found"); `/api/library-unlink` có `keep` (kiểu quét lại) bị từ chối khi đang khoá (quên cả loạt có chủ ý khi đổi thư mục tải thì không có `keep` nên vẫn chạy). `/api/library?locked=1` thêm `locked: true`; chỉ khi được hỏi vì danh sách thường được chép nguyên vào playlist và yêu thích, nơi dấu tạm thời sẽ bị lưu lại.
- Trang (`app.js`): `playTrack` chặn bài bị khoá ngay dòng đầu (không vào hàng đợi, lịch sử hay Audio Engine) và hiện hộp thoại *Music access is off* với nút **Open app settings** (`MediaControlsPlugin.openAppSettings`), vì quyền đã tắt trong Settings thường không được hộp thoại hệ thống hỏi lại. Hàng bị khoá được làm mờ. Lỗi phát của bài bị khoá không còn bị coi là "file missing" và không bị tự nhảy qua bài khác.
- **Không bao giờ bị khoá:** bài đã nhập vào thư viện (nằm trong thư mục riêng của app), bài app tải về, và mọi thứ của thư mục "App folder".
- Giới hạn có sẵn từ trước (chưa sửa, không thuộc lỗi này): Android 10 trở xuống mất quyền thì cả thư mục chung đều không dùng được (`listDownloads` đặt `pub = null`), nên cả bài app tự tải vào `Music/Muriel Mod` cũng tạm không phát được; tệp vẫn nguyên trên máy.
- Chưa thử trên máy thật. Các bước kiểm tra nằm trong `FIX-REPORT-MEDIA-PERMISSION.md`.

## Dịch thuật

Muriel dịch giao diện bằng máy lúc chạy (`i18n.js`), không có bảng dịch tĩnh. Nhãn trong `index.html` (nút *Folder playlists* và `title` của nó) tự được dịch cùng cả trang. Phần tạo bằng code thì đã nối vào hệ thống:
- Bảng chọn thư mục: mọi chữ của Muriel mang `data-i18n` (ô nhập dùng `data-i18n-attr="placeholder"`, thông báo lỗi dùng `text()`). Tên thư mục và đường dẫn đánh dấu `translate="no"` để không bị gửi đi dịch.
- Thông báo (toast) và lỗi từ lớp lưu trữ đều qua `Tm(...)`; các chuỗi mới nằm trong danh sách tải trước `I18N.known` ở `app.js` nên có sẵn bản dịch khi cần.
- Tên playlist "Local files" lấy bằng `T()` lúc tạo.

## Các tệp đã sửa

- `android/app/build.gradle`, `res/values/strings.xml`, `capacitor.config.json` — tên gói và tên app riêng cho bản mod
- `android/app/src/main/AndroidManifest.xml`, `MediaControlsPlugin.java` — quyền đọc nhạc; `sameFile` (so sánh byte); `openAppSettings` (mở trang cài đặt của app)
- `android/app/src/main/java/.../FileCompare.java` — so sánh hai tệp từng khối 64 KB (thuần Java); `android/app/src/test/java/.../FileCompareTest.java` — 6 test JUnit (`./gradlew testDebugUnitTest`)
- `mobile/shims/store.js` — vị trí tải cấu hình được, kiểm tra ghi, di chuyển tệp (nhật ký không bao giờ bị bỏ khi còn việc dở), quét thư mục ngang hàng (giới hạn toàn cục, không ghi đè danh sách khi quét dở); `moveStatus`, `retryMove`; khoá bài khi mất quyền (`linkedAccess`, `refreshLinkedAccess`, `isLinkedLocked`)
- `mobile/electron-api.js` — bảng chọn thư mục (có dịch); `scanLocalFolders`; `getMoveStatus`, `retryMove`; `getMediaAccess`, `openAppSettings`, `promptMediaAccess` (hộp thoại khi bài bị khoá)
- `library-tools.js` — `linkFolderSongs` (liên kết rồi mới quên bài, chỉ khi an toàn)
- `mobile/shims/platform.js`, `server.js` — `LOCAL_LINK_DIR`, `/api/library-link`, `/api/library-unlink`, đọc tệp theo `item.path`; `linkedAccessLocked` và lỗi `MEDIA_PERMISSION_REQUIRED`
- `app.js`, `index.html`, `mobile/mobile.css`, `mobile/bridge.js`, `profiles-core.js` — nút, luồng quét/tạo playlist, hiện nút Change trên Android, 2 khoá chỉ-của-máy; dòng trạng thái việc chuyển + nút Retry và các thông báo sau khi đổi thư mục
- `test/android-store.test.js`, `test/library-link.test.js`, `test/android-picker.test.js`, `test/library-tools.test.js` — test cho app bị đóng giữa chừng, trùng tên (cùng dung lượng khác nội dung), thử lại nhiều lần, đọc thư mục lỗi / thư mục đã mất, xoá bản cũ thất bại, quét đọc dở, giới hạn toàn cục, bảng chọn, quyền đọc nhạc, trạng thái và Retry; `test/phone-store.test.js` — đổi tên thư mục mặc định; `test/media-permission-server.test.js`, `test/media-permission-page.test.js` (và các test `MP-*` trong `android-store.test.js`) — quyền bị thu hồi: khoá bài, chặn phát, không bài nào bị quên/xoá, mở khoá khi có quyền lại
- App cache (mục 3): `mobile/app-cache.js`, `mobile/home-cache.js` (mới); `mobile/shims/fs.js` (`init()` dùng cache, ghi dòng thời gian khởi động); `mobile/extract.js` (cache player YouTube); `mobile/bridge.js` (`window.MurielAppCache`); `mobile/electron-api.js` (`getCacheSize`/`clearCache` tính cả app cache); `mobile/mobile-ui.js` (dòng *App cache* ở Settings → Storage); `app.js` (My Wave và For you hiện từ cache); `profiles-core.js` (khoá chỉ-của-máy `muriel_app_cache`); `backup-core.js` (`muriel_appcache_*` không sao lưu)
- `test/app-cache.test.js`, `test/home-cache.test.js`, `test/app-cache-start.test.js`, `test/youtube-player-cache.test.js` — test cho cache (kho IndexedDB, `fs.init()` qua nhiều lần mở, thư viện `youtubei.js` thật với mạng giả); thêm devDependency `fake-indexeddb`

## Build

CI (`.github/workflows/android.yml`) ký bằng keystore trong GitHub Secrets của repo gốc, nên fork sẽ không build được nếu thiếu `MURIEL_KEYSTORE_B64` và `MURIEL_KEYSTORE_PASSWORD`.
Tự build: `npm ci && node mobile/build.mjs && npx cap sync android && cd android && ./gradlew assembleRelease` (cần JDK 21 và khoá ký của bạn).
Vì tên gói đã khác app gốc nên mod cài song song được, không cần gỡ app gốc. Chữ ký khác khoá cũng không sao: Android coi đây là hai app riêng.
Lần sau muốn cập nhật mod thì phải ký bằng đúng khoá bạn đã dùng cho lần đầu, nếu không Android sẽ đòi gỡ bản mod cũ trước.
