# Fix report — Android media permission revoked (P1)

## Status

**Implemented and covered by automated tests. Not yet verified on a physical Android device, so by the acceptance criteria this bug is not closed.** The device runbook is in section 6. Nothing in this environment could build the APK or run on a phone.

| | |
|---|---|
| Full suite | 410 tests: 407 pass, 3 fail. The 3 are `soundcloud-hls`, `youtube-opus` and one YouTube-library test; they need the `youtubei.js` package that this sandbox lacks, and they fail identically on the original code. |
| New tests | 47 (21 storage/API `MP-*`, 9 real-server `SRV-*`, 17 page/bridge/dialog `PG-*`/`BR-*`/`PR-*`) |
| On the original code | 20 of the 21 `MP-*` fail and 6 of the 9 `SRV-*` fail. The ones that pass assert behaviour that must not change. |
| Not done here | APK build, any run on a device, Gradle compile of the Java change (see section 8) |

## 1. What was wrong

The report's suspect (`listLinked()` restoring from `SIB_KEY` without a permission check) is real but is the mild part. On Android 11+ a revoked permission makes the folders read as empty, so `listLinked()` restores *nothing*; it does not restore wrong data. The visible symptom comes from the layers around it:

- The library (`library.json`, app-private) and the playlists (page `localStorage`) keep the linked songs, so the UI still lists them. This is correct and is preserved.
- Playing one then fails: the server answers 404 or the WebView's read is refused, and the page says "File missing from library" and auto-skips up to 5 songs.

Two **data-integrity defects** sat behind that, both reproduced on the original code by the new tests:

1. **A scan without the permission overwrote what is remembered.** `scanLinked()` saw nothing, treated it as a complete scan, and rewrote `piverxy_local_folders` from `{"folders":["Album One"],"loose":true}` to `{"folders":[],"loose":false}` (test `MP-09`). After the permission came back, a restart restored nothing until a manual rescan.
2. **Losing the permission *during* a scan emptied the playlists.** The page received a "complete" scan with no songs and posted `/api/library-unlink {"keep":[]}`, which forgets every linked song and strips them from every playlist (test `MP-14`). The permission check at the top of `scanLocalFolders` made this rare, not impossible.

One latent defect: `bridge.js` `fileUrlFor` cached *rejected* promises forever, so a single refused read poisoned that song until the app restarted (`BR-02`).

## 2. What changed

| File | Change |
|---|---|
| `mobile/shims/store.js` | Lock state (`linkedAccess`, `isLinkedLocked`, `refreshLinkedAccess`). `listLinked` does not read the folders while locked and does not touch `SIB_KEY`. `scanLinked` returns `{ locked: true }` without scanning or remembering anything, and re-checks after reading in case the permission went mid-scan. `fileUrl` refuses a locked linked path with `MEDIA_PERMISSION_REQUIRED`. |
| `mobile/shims/platform.js` | `linkedAccessLocked()`, the hook `server.js` asks. |
| `server.js` | `/api/library-file` answers `403 {"code":"MEDIA_PERMISSION_REQUIRED"}` for a locked linked song. `/api/library-unlink` with `keep` (a rescan) is refused while locked. `/api/library?locked=1` marks locked songs. The cover worker skips locked songs so an online cover does not permanently hide the embedded one. |
| `mobile/bridge.js` | A refused file URL is no longer cached, and a locked linked song never gets a URL, even from the cache. The server's `MEDIA_PERMISSION_REQUIRED` reaches the page as the event `piverxy:media-permission-required`. |
| `mobile/electron-api.js` | `getMediaAccess()`, `openAppSettings()`, `promptMediaAccess()`. Re-reads the permission at foreground (`visibilitychange` and Capacitor `appStateChange`), after every in-app permission ask, and before every scan. A scan cut short by the permission returns `needsPermission`. |
| `app.js` | `playTrack` returns at its very first statement for a locked song (no queue, history or audio-engine contact) and shows the prompt. The audio error handler no longer treats a locked song as missing or skips on. Locked rows are dimmed. |
| `MediaControlsPlugin.java` | New `openAppSettings` (opens the app's page in Settings). |
| `mobile/mobile.css` | One rule dimming locked rows. |
| Docs, tests | `MOD-NOTES.md` section; `test/media-permission-server.test.js`, `test/media-permission-page.test.js`, `MP-*` tests in `test/android-store.test.js`. |

## 3. Behaviour now

A linked song is **locked** when all of these hold: Android, the song lives in shared storage (the active download folder is not the app's own folder), and the music permission is missing (`READ_MEDIA_AUDIO` on Android 13+, `READ_EXTERNAL_STORAGE` on 12 and older).

- Locked is **computed from the permission as it is now and never stored**. No new storage key, no format change, so there is no migration and nothing that can stay stuck.
- Locked songs stay in the library and in every playlist, unchanged. Tapping one shows "Music access is off" with **Not now** / **Open app settings**. Nothing plays, nothing is queued, nothing is skipped, nothing is marked missing.
- Permission back (Settings, then return to the app): the songs are put back in the file index *first*, then unlock. The prompt closes by itself and the rows un-dim. No rescan, no new playlists.
- **Never locked:** songs imported into the app, songs Piverxy downloaded, and everything under the app's own folder.
- Nothing is unlinked, forgotten or deleted because of the permission. `/api/library-unlink` *without* `keep` (what the app sends when you deliberately change the download folder) is unchanged and still allowed.

## 4. Mandatory regression tests

| Required test | Where |
|---|---|
| Permission granted → scan → play | `MP-01`, `SRV-01`, `MP-16` (first-time user, permission asked in the dialog) |
| Revoked → restart → playlist preserved but locked | `MP-02`, `MP-02b`, `SRV-03`, `SRV-07` |
| Revoked → attempt playback → permission prompt | `MP-03`, `SRV-02`, `PG-06`, `PG-07`, `PR-01`..`PR-05`, `BR-03` |
| Restored → playback works again | `MP-04`, `MP-04b`, `SRV-06`, `BR-01`, `BR-02` |
| Revoked while running → state refreshes | `MP-05`, `MP-05b`, `MP-17`, `PG-02`, `PG-03`, `PG-04` |
| App-private music remains playable | `MP-06`, `SRV-04` |
| Piverxy-downloaded music remains playable | `MP-07` |
| No duplicate playlists after restoration | `MP-08`, `MP-15` |
| No unlink/delete caused by permission denial | `MP-09`, `MP-09b`, `MP-14`, `SRV-05`, `SRV-07` |

Two tests were mutation-checked (fix removed, test fails, fix restored, test passes): `MP-16` and `MP-17`. `MP-16` catches a flaw in my first design: the lock was cached, so a first-time user who allowed the permission in the in-app dialog was refused by the server's unlink guard until the next foreground.

Run: `node --test` (everything), or `node --test test/android-store.test.js test/media-permission-server.test.js test/media-permission-page.test.js`.

## 5. Automated vs device

The Filesystem model in `test/android-store.test.js` reproduces the Android 11+ rule that an app without the permission cannot see other apps' files. It is a model. The real behaviour of the system permission dialog, Settings, process death and `Capacitor.convertFileSrc` is only established on a device.

## 6. Device runbook (needed to close the bug)

**Prerequisites.** JDK 21, a debug build (`npm ci && node mobile/build.mjs && npx cap sync android && cd android && ./gradlew assembleDebug`), and at least one phone on Android 13+ and one on Android 11 or 12. Package: `io.github.piverxy`. Permission: `android.permission.READ_MEDIA_AUDIO` (13+) or `android.permission.READ_EXTERNAL_STORAGE` (11–12); below it `$PERM`.

**Test data.** Files pushed with `adb` belong to the shell user, so Piverxy cannot see them without the permission, exactly like files from a file manager or a PC:

```
adb shell mkdir -p /sdcard/Music/TestAlbum
adb push one.mp3 /sdcard/Music/TestAlbum/01.mp3
adb push two.mp3 /sdcard/Music/TestAlbum/02.mp3
adb push loose.mp3 /sdcard/Music/loose.mp3
adb shell sha256sum /sdcard/Music/TestAlbum/* /sdcard/Music/loose.mp3   # keep this output
```

Also have one song **downloaded by Piverxy** and one **imported** into the library (My files → **Add files**), made while the permission was granted.

| # | Steps | Expected |
|---|---|---|
| T0 | Fresh install, never granted. Open **My files** → **Folder playlists** → Allow. | Playlists "Local files" and "TestAlbum" appear with 1 and 2 songs; they play; no error toast. *(MP-01, MP-16)* |
| T1 | Settings → Apps → Piverxy → Permissions → turn the music permission **off**. Reopen Piverxy. | Playlists and counts unchanged. The 3 linked songs are dimmed. The downloaded and imported songs are not and still play. |
| T2 | Tap a dimmed song. | Prompt "Music access is off". No audio, no "File missing" toast, no skipping, queue unchanged. **Not now** closes it; tapping again shows it again. |
| T3 | Tap **Open app settings**. | Piverxy's page in Settings opens. |
| T4 | Turn the permission on, go back to Piverxy. | Prompt gone (if open), rows no longer dimmed, **without restarting**. The song plays. Playlists identical to T0. |
| T5 | Tap **Folder playlists** twice. | No duplicate playlists; counts as in T0. |
| T6 | Re-run the `sha256sum` line. | Identical to the saved output: no file touched. |
| T7 | Debug build: `adb shell run-as io.github.piverxy sha256sum files/Piverxy/library.json` before T1 and after T4. | Same hash (expected path `files/Piverxy/library.json`; list with `ls files/Piverxy` if it differs). |
| T8 | `adb shell pm revoke io.github.piverxy $PERM`, then reopen. Then `adb shell pm grant io.github.piverxy $PERM`, press Home and return **without** killing the app. | Revoke behaves as T1. After the grant, returning to the app unlocks the songs by itself (the foreground refresh). |
| T9 | First-time user again (clear app data), tap **Folder playlists**, choose **Don't allow**, repeat once more. | Existing instruction toasts; nothing created; the second time Settings opens. |
| T10 | Optional: remote-debug the WebView and run `JSON.parse(localStorage.devsize_playlists).map(p=>[p.name,p.tracks.length])` before and after. | Identical. |

**Pass** = T0–T9 on both an Android 13+ and an Android 11/12 device. Capture a screen recording of T1–T4 and the `sha256sum` outputs.

If the build fails, start with `MediaControlsPlugin.java` (section 8).

## 7. Rollback

Everything is additive and persists nothing new, so reverting the change leaves existing data valid: `git revert` the commit, or restore the 8 source files listed in section 2.

## 8. Limits, assumptions, decisions

- **Java not compiled against the SDK.** The new `openAppSettings` method was compiled against stubs of the signatures it calls (`openSettings`, `audioState`); its body is the same call `allowAudioAccess` already makes. A real `./gradlew assembleDebug` is the proof.
- **JS bundle not built here** (no `node_modules`, no network). The new `require('@capacitor/app')` in `electron-api.js` matches existing uses in `bridge.js`.
- **Revoking in Settings normally kills the app process on Android**, so "revoked while running" is, in practice, a restart. The in-app refresh is unit-tested (`MP-05`) and the grant direction can be observed on device (T8). A revoke without a kill is hard to produce on purpose.
- **Android 10 and older (existing limit, not changed).** Without the permission the whole shared download folder is unusable (`listDownloads` sets `pub = null`), so even songs Piverxy downloaded into `Music/Piverxy` cannot play until it returns. The files stay on the device. The requirement that Piverxy-downloaded music stays playable holds on Android 11+.
- **Prompt offers only Not now / Open app settings.** I did not add a button for the system dialog: a permission turned off in Settings is usually not asked for again by it. This is an assumption worth confirming in T1–T3. The existing Folder playlists flow still uses the dialog first.
- **A queue stops at a locked song** with the prompt instead of skipping to the next playable one. Skipping silently would hide the problem.
- **`/api/library?locked=1` is opt-in**, because the list is copied whole into playlists and favorites; a mark that is only true for a while must not be saved into them.
- **A plugin error is treated as "granted"** (the existing semantics of `readAccessOf`, kept so older plugin builds behave as before).
- Left out on purpose to honour "no new features": a "access is back" toast.
