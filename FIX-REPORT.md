# Báo cáo sửa lỗi — theo "Báo cáo review kỹ thuật Piverxy MOD" (06/11/2026)

Nền: `riff-piverxy-android-mod-add-storage-permission.zip`. Mọi finding P0/P1/P2 của báo cáo đã được sửa trong mã nguồn và có test hồi quy. Phần cần thiết bị Android thật (Phase C) **chưa làm được trong môi trường này**, xem mục 4.

## 1. Kết quả theo từng finding

| Mã | Mức | Đã sửa thế nào | File | Test |
|---|---|---|---|---|
| PIV-STORE-001 | P0 | Cùng tên + cùng dung lượng **không** còn được coi là cùng bài. Chỉ khi hai tệp giống nhau từng byte (`MediaControlsPlugin.sameFile` → `FileCompare`, đọc từng khối 64 KB, dừng ở byte khác đầu tiên) mới xoá bản cũ. Khác nội dung, hoặc không so sánh được → *conflict*, giữ nguyên cả hai tệp, không ghi đè. Sau khi chép còn kiểm tra lại bản mới trước khi xoá bản cũ. Không `stat` được tên đích (lỗi không phải "không tồn tại") → không chép, tránh ghi đè. | `mobile/shims/store.js` (`moveOne`, `sameBytes`), `MediaControlsPlugin.java`, `FileCompare.java` | RT-01 (khác bytes; không so sánh được; không có plugin), RT-02, `FileCompareTest` (6 test JUnit) |
| PIV-STORE-002 | P1 | `readdir` lỗi được phân loại: lỗi quyền / I/O / không rõ → *unreadable* (giữ nhật ký, bài không bị coi là đã xử lý). Chỉ khi lỗi báo "không tồn tại" **và** `stat` lại cũng không thấy thư mục → *missing*. Log có giai đoạn + đường dẫn + mã lỗi, không có nội dung bài. | `store.js` (`runMove`, `isGoneDir`, `warnMove`) | RT-03, RT-04 |
| PIV-STORE-003 | P1 | Nhật ký chỉ bị xoá khi không còn conflict, bài lỗi, bản cũ chưa xoá được, thư mục không đọc được, thiếu quyền. Bài conflict vẫn được liệt kê sau khi mở lại app: bản cũ hiện dưới tên `<tên> (old).<đuôi>` nên không bị bản mới trùng tên che mất. Danh sách thư mục cũ được liệt kê cả khi thư mục đích tạm thời không dùng được. | `store.js` (`settleMove`, `listDownloads`, `heldOf`, `freeName`) | RT-05 (3 lần khởi động lại), test cũ về conflict đã sửa lại |
| PIV-STORE-004 | P1 | Bỏ giới hạn 3 lượt làm mất nhật ký. `tries` chỉ để đếm. Mỗi lần mở app tự chạy lại một lượt, và có nút **Retry** trong Settings; trạng thái hiện số bài còn lại và lý do. | `store.js` (`resumeMove`, `retryMove`, `moveStatus`), `electron-api.js`, `app.js`, `index.html` | RT-06 (12 lượt thất bại + khởi động lại; bài vẫn hiện và phát được; xong khi hết nguyên nhân), test API cho trạng thái/Retry |
| PIV-LIB-001 | P1 | `SIB_KEY` chỉ ghi đúng kết quả khi lần quét đầy đủ. Lần quét dở chỉ **thêm** thư mục, không bao giờ bỏ thư mục nào (lần quét dở đầu tiên vẫn ghi để bài phát được sau khi khởi động lại). | `store.js` (`scanLinked`) | RT-07 (3 test), RT-08 |
| PIV-LIB-002 | P2 | Giới hạn 5000 bài là giới hạn **toàn lần quét** (bộ đếm chung chạy xuyên mọi thư mục, kể cả đệ quy). Đúng 5000 mà không bỏ sót gì thì không phải partial. | `store.js` (`listAudio`, `collectLinked`) | RT-09 (3 test, trong đó có lúc mở app) |
| PIV-STORE-005 | P2 | Xoá bản cũ xong được kiểm tra lại. Còn tồn tại → trạng thái *cleanup pending* (không tính là "moved"), bản mới vẫn phát được, bản cũ không bị ép xoá, nhật ký giữ lại để thử tiếp. | `store.js` (`dropSource`, `moveOne`) | RT-10 |

Mục B.4 của báo cáo (luồng link theo batch) đã đúng sẵn: `linkFolderSongs` chỉ `unlink` khi mọi batch thành công **và** lần quét không partial (`app.js` truyền `!found.partial`). Test hiện có đã khoá điều này nên không đổi.

## 2. Thay đổi hành vi bạn cần biết

- Bản trong thư mục cũ của một bài bị conflict hiện ra là `Tên (old).mp3` (hoặc `(old 2)`). Khi bạn xoá/đổi tên một trong hai tệp rồi bấm Retry, bản cũ sẽ được chuyển nốt và hậu tố biến mất sau khi app khởi động lại.
- Nếu chưa cấp quyền đọc nhạc, các bài nhìn thấy vẫn được chuyển nhưng nhật ký được giữ lại ("cần quyền"): từ Android 11, thư mục cũ có thể trông như trống vì bài do app khác tạo bị ẩn. Retry sẽ hỏi quyền trước rồi chuyển nốt. Báo cáo không nêu riêng điểm này, nhưng nó theo nguyên tắc "không ngừng liệt kê file chỉ vì app không đọc được" và RT-12.
- Mỗi lần mở app, việc chuyển còn dở chạy lại một lượt (không giới hạn số lượt, không vòng lặp trong một phiên). Conflict cùng dung lượng sẽ được so sánh lại bằng byte ở mỗi lượt; chi phí chỉ đáng kể khi có rất nhiều conflict.
- Hai lượt chuyển không chạy chồng lên nhau (hàng đợi); Retry bấm lúc đang chạy sẽ báo "đang chạy".
- Thay đổi native: thêm `sameFile` và `FileCompare.java` (thuần Java, không phụ thuộc Android). Không thêm quyền mới.

## 3. Kiểm chứng đã làm

- `node --test` cho 5 file test trong báo cáo: **đều pass** (`android-store.test.js` từ 25 lên 46 test; còn lại giữ nguyên).
- Toàn bộ bộ test: 360/363 pass. 3 test còn lại (`soundcloud-hls`, `youtube-opus`, một test YouTube library) fail vì thiếu gói `youtubei.js` trong môi trường này; bản gốc cũng fail y hệt, không liên quan tới thay đổi.
- Các test hồi quy mới được chạy thử trên `store.js` **gốc**: đều fail (RT-01 fail đúng lý do là bản gốc xoá bài nguồn), trừ RT-02 và test "quét dở lần đầu" vì chúng khoá hành vi đúng đã có sẵn. Sau khi sửa tất cả đều pass.
- Java: `FileCompare` và đoạn `sameFile` được biên dịch bằng `javac` (JDK 21) với stub của Capacitor/Android và chạy thử (cùng bytes, cùng dung lượng khác bytes, khác dung lượng, tệp 5 MB khác đúng một byte ở cuối / ở ranh giới khối, tệp thiếu, thư mục). `FileCompareTest` biên dịch và chạy được với stub JUnit.

## 4. Chưa làm được (cần máy thật / Android SDK)

- Chưa chạy `./gradlew assembleDebug|assembleRelease` và `testDebugUnitTest` (không có Android SDK/mạng ở đây). Mã Java mới nhỏ, nhưng **bắt buộc build thử trước khi phát hành**.
- RT-11, RT-13, RT-15 (hộp thoại quyền lần đầu trên Android 13+, luồng Android 11–12, cài song song với Piverxy gốc) và Phase C: phải thử trên thiết bị/emulator API 29, 30/31, 32, 33, 34/35 (cấp quyền, từ chối, từ chối hẳn, thu hồi trong Settings; App folder và Shared storage). RT-12 và RT-14 mới được kiểm tra ở mức giả lập trong Node.
- `sameFile` đọc tệp bằng `java.io` giống plugin Filesystem; cần thử với tệp thật vài chục MB ở Music/ và Download/ để xác nhận thời gian so sánh.
- Báo cáo khuyến nghị HOLD/NO-GO cho tới khi hết các mục trên. Phần mã đã đủ điều kiện để đưa vào vòng test Phase C; quyết định phát hành vẫn nên dựa trên kết quả thiết bị thật.
