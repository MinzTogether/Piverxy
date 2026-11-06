# Muriel Mod

**A community-maintained modification of [Muriel](https://github.com/cloverscripts/riff-muriel), with additional Android-focused improvements.**

Muriel is a music player for Windows, macOS, Linux and Android. It brings online music discovery, offline downloads, a local music library, lyrics and audio tools into one app.

> **This is the modded repository.** It is maintained separately from the original project at [cloverscripts/riff-muriel](https://github.com/cloverscripts/riff-muriel). It is not an official upstream release and is not affiliated with YouTube, Google, SoundCloud, Spotify or Apple.

## What it does

- **Music discovery and playback** — search and play music from YouTube, YouTube Music and SoundCloud.
- **Offline library** — download supported tracks and organize local music, folders and playlists.
- **Lyrics** — online synced lyrics, LRC files, manual timing and fullscreen karaoke.
- **Audio tools** — equalizer, presets, playback speed, reverb, and tools for trimming and exporting clips.
- **Personal interface** — compact player layout, custom image/GIF/video backgrounds, optional glass blur and visualizers.
- **Performance options** — controls for blur, thumbnail quality, visualizer frame rate and background memory use.

## What this mod adds

The mod keeps the core Muriel experience while adding and refining mobile behavior, especially on Android.

### Android storage and downloads

- **Choose a download location** — use the app folder or a supported shared-storage location such as Music, Download, Documents, Podcasts or Audiobooks. You can also create a folder of your own inside a supported location.
- **Move existing downloads** — optionally move tracks when changing the download folder.
- **Safer file moves** — interrupted moves can resume, incomplete temporary copies are not treated as finished tracks, and existing files are not overwritten. Files that cannot be moved remain in their previous location.
- **Folder playlists** — scan folders alongside the download folder and turn music folders into playlists. Supported audio formats include MP3, M4A, FLAC, Opus, WAV, OGG/OGA, AAC and WEBA.
- **Link files in place** — folder playlists reference audio where it already exists; they do not copy or delete those source files.
- **Android audio permission** — the app requests the relevant media-reading permission when it needs to scan music that it did not create itself. It does not request broad all-files access.

### Mobile playback

The Android build includes native media playback support so playback can continue in the background, with system media controls and a playback notification.

The Android application ID is io.github.murielmod, allowing this mod to be installed separately from the upstream Muriel app.

## Getting started

### Desktop

Requirements: Node.js and npm.

```bash
git clone https://github.com/MinzTogether/murielmod.git
cd murielmod
npm install
npm start
```

### Build desktop packages

```bash
npm run dist
```

Build artifacts are written to dist/. The configured desktop targets are Windows (NSIS), Linux (AppImage) and macOS (DMG/ZIP).

### Android

The Android app is built with Capacitor and the native project in android/.

1. Install Node.js, npm, Android Studio and the Android SDK.
2. Install the project dependencies and sync the native Android project:

   ```bash
   npm install
   npx cap sync android
   ```

3. Open the repository's android/ directory in Android Studio.
4. Build or run the app from Android Studio.

Some Android features depend on native permissions and services, so running the desktop app with npm start is not a substitute for testing the Android build.

### iOS

A Capacitor iOS target is included. Building it requires macOS, Xcode and the iOS development tools.

## Where your data is stored

- **Windows:** %LOCALAPPDATA%/Muriel
- **macOS:** ~/Library/Application Support/Muriel
- **Linux:** ~/.cache/muriel (settings in ~/.config/muriel)
- **Android:** app data is kept in the app's private storage; downloaded songs can be saved to the selected download folder. The default shared folder is Music/Muriel Mod.
- **iOS:** app documents are stored in the Muriel documents area.

## Legal and responsible use

Muriel is a player, not a music-hosting service. It does not host or sell music. Online sources, lyrics, artwork and metadata are provided by third-party services and remain subject to their own terms.

Use the app lawfully, respect copyright and the terms of the services you use, and only download or keep music that you have the right to use. The software is provided “as is”; see [LEGAL.md](LEGAL.md) for the full notice.

## Credits and attribution

This repository is a modification of the original Muriel project:

- **Original source used for this mod:** [cloverscripts/riff-muriel](https://github.com/cloverscripts/riff-muriel) — Muriel by **cloverscripts**.
- **Underlying Riff project:** [rootscripts/riff](https://github.com/rootscripts/riff) — credited by the upstream Muriel project as its Riff foundation.
- **This mod:** maintained in [MinzTogether/murielmod](https://github.com/MinzTogether/murielmod).

The upstream MIT license and its copyright notice are retained in [LICENSE](LICENSE). Please preserve the applicable license and attribution notices when redistributing this source.

## License

MIT. See [LICENSE](LICENSE) for the full license text.
