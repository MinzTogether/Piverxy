<div align="center">
  <img src="assets/icon.png" alt="Piverxy app icon" width="112">
  <h1>Piverxy</h1>
  <p><strong>A music player for discovery, listening, and managing your personal library.</strong></p>
  <p>
    <a href="https://github.com/MinzTogether/Piverxy/releases/latest">Releases</a>
    ·
    <a href="https://github.com/MinzTogether/Piverxy/issues">Issues</a>
    ·
    <a href="LICENSE">MIT License</a>
  </p>
</div>

---

Piverxy is a cross-platform music player built around a simple idea: bring music discovery, streaming, local files, and playback tools together in one place. It combines an Electron desktop app with Capacitor-based Android and iOS builds.

## Features

### Discover and listen
- Search for and play music from **YouTube**, **YouTube Music**, and **SoundCloud**.
- Save supported tracks for offline listening.
- Browse recommendations and your listening history.

### Your music library
- Play audio files stored on your device.
- Organize favorites, albums, artists, and playlists.
- On Android, create playlists from audio folders without copying or moving the original files.
- Manage downloads and local music from one library.

### Lyrics and audio tools
- Find online lyrics and load local **LRC** files.
- Follow synchronized lyrics, use manual timing, or open fullscreen karaoke mode.
- Adjust playback with an equalizer, presets, speed controls, and reverb.
- Trim tracks and export audio clips.

### Personalization and convenience
- Customize the background with an image, GIF, or video.
- Adjust visual effects, blur, and visualizer settings.
- Use compact playback and lyrics views.
- Keep separate profiles, back up and restore app data, and use sharing or sync features.
- Connect integrations such as Discord Rich Presence and Last.fm.

### Mobile experience
- Android and iOS builds use Capacitor.
- Support for background audio and native media controls.
- Mobile-specific library and file access features.
- Startup and content caching to make repeat launches smoother.

## Downloads

Choose the build for your device:

| Platform | Available build |
| --- | --- |
| Windows | Portable executable and release installer |
| Linux | AppImage |
| macOS | DMG and ZIP (Intel and Apple silicon) |
| Android | APK |
| iOS | Unsigned IPA for sideloading |

- [Latest desktop release](https://github.com/MinzTogether/Piverxy/releases/latest)
- [Latest Windows build](https://github.com/MinzTogether/Piverxy/releases/tag/windows-latest)
- [Latest Android APK](https://github.com/MinzTogether/Piverxy/releases/tag/android-latest)
- [Latest iOS IPA](https://github.com/MinzTogether/Piverxy/releases/tag/ios-latest)

The Android and iOS rolling builds are published by GitHub Actions. The iOS IPA is unsigned and must be signed for installation with a sideloading tool such as AltStore, SideStore, or Sideloadly. Availability of signing and installation methods depends on your Apple account and device.

## Run from source

### Requirements

- Git
- **Node.js 22 or newer**
- npm

### Desktop

~~~bash
git clone https://github.com/MinzTogether/Piverxy.git
cd Piverxy
npm ci
npm start
~~~

### Run the tests

~~~bash
npm test
~~~

### Package the desktop app

~~~bash
npm run dist
~~~

Build output is written to <code>dist/</code>. Desktop packaging is intended to run on the target operating system; Windows, Linux, and macOS use their respective Electron Builder targets.

## Build the mobile projects

First install the npm dependencies as shown above, then generate the mobile web bundle:

~~~bash
node mobile/build.mjs
~~~

Sync the generated bundle into the native project you want to build:

**Android**
~~~bash
npx cap sync android
~~~

Open the <code>android/</code> project in Android Studio, or build it with the included Gradle wrapper.

**iOS (macOS with Xcode)**
~~~bash
npx cap sync ios
~~~

Open <code>ios/App/App.xcodeproj</code> in Xcode to build the iOS app. The automated iOS workflow creates an unsigned IPA.

## Project structure

| Path | Purpose |
| --- | --- |
| <code>index.html</code>, <code>styles.css</code>, <code>app.js</code> | Main user interface |
| <code>main.js</code>, <code>preload.js</code>, <code>server.js</code> | Electron entry point, secure bridge, and local app server |
| <code>mobile/</code> | Capacitor bridge, mobile UI, and mobile-specific services |
| <code>android/</code>, <code>ios/</code> | Native Android and iOS projects |
| <code>assets/</code> | App icons and bundled frontend assets |
| <code>test/</code> | Automated tests |

## Credits and license

Piverxy is a modified and independently maintained project based on [Muriel](https://github.com/cloverscripts/riff-muriel), which in turn originated from [Riff](https://github.com/rootscripts/riff).

The upstream MIT license and copyright notice are retained in [LICENSE](LICENSE). Please keep the license and attribution notices with redistributed copies.

## Legal note

Piverxy does not host music. You are responsible for respecting copyright, the terms of the services you use, and the rights of artists and content owners. Only download or keep content that you own or are authorized to download.

Piverxy is an independent project and is not affiliated with, endorsed by, or sponsored by YouTube, YouTube Music, Google, SoundCloud, or their respective owners.
