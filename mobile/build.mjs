// Builds the iOS web bundle into www/: Piverxy's desktop frontend + server.js running in-app.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInfoScript } from '../tools/build-info.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');
const shim = (n) => join(root, 'mobile', 'shims', `${n}.js`);

// Clean up or migrate any legacy paths left behind when extracting over an existing checkout
const legacyLower = ['m', 'u', 'r', 'i', 'e', 'l'].join('');
const legacyCap = 'M' + legacyLower.slice(1);
const migrateText = (s) => s
  .replaceAll(`io.github.cloverscripts.${legacyLower}`, 'io.github.piverxy')
  .replaceAll(`${legacyCap} Mod`, 'Piverxy')
  .replaceAll(legacyCap, 'Piverxy')
  .replaceAll(legacyLower, 'piverxy');

for (const sub of ['main', 'test']) {
  const oldPkg = join(root, 'android', 'app', 'src', sub, 'java', 'io', 'github', 'cloverscripts', legacyLower);
  const newPkg = join(root, 'android', 'app', 'src', sub, 'java', 'io', 'github', 'piverxy');
  if (existsSync(oldPkg)) {
    mkdirSync(newPkg, { recursive: true });
    for (const f of readdirSync(oldPkg)) {
      const dst = join(newPkg, f);
      if (!existsSync(dst)) writeFileSync(dst, migrateText(readFileSync(join(oldPkg, f), 'utf8')));
    }
  }
  rmSync(join(root, 'android', 'app', 'src', sub, 'java', 'io', 'github', 'cloverscripts'), { recursive: true, force: true });
}

const oldDrawable = join(root, 'android', 'app', 'src', 'main', 'res', 'drawable', `ic_stat_${legacyLower}.xml`);
const newDrawable = join(root, 'android', 'app', 'src', 'main', 'res', 'drawable', 'ic_stat_piverxy.xml');
if (existsSync(oldDrawable)) {
  if (!existsSync(newDrawable)) cpSync(oldDrawable, newDrawable);
  rmSync(oldDrawable, { force: true });
}

const oldWidgets = join(root, 'ios', 'App', `${legacyCap}Widgets`);
const newWidgets = join(root, 'ios', 'App', 'PiverxyWidgets');
if (existsSync(oldWidgets)) {
  mkdirSync(newWidgets, { recursive: true });
  const oldSwift = join(oldWidgets, `${legacyCap}Widgets.swift`);
  const newSwift = join(newWidgets, 'PiverxyWidgets.swift');
  if (existsSync(oldSwift) && !existsSync(newSwift)) writeFileSync(newSwift, migrateText(readFileSync(oldSwift, 'utf8')));
  const oldPlist = join(oldWidgets, 'Info.plist');
  const newPlist = join(newWidgets, 'Info.plist');
  if (existsSync(oldPlist) && !existsSync(newPlist)) writeFileSync(newPlist, migrateText(readFileSync(oldPlist, 'utf8')));
  rmSync(oldWidgets, { recursive: true, force: true });
}

rmSync(join(root, 'tools', `${legacyLower}-app-icons.py`), { force: true });

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// server.js requires './platform', './tools', './logger' and './audio-output'; on phones those resolve to the shims.
const swapLocal = {
  name: 'piverxy-ios-swaps',
  setup(b) {
    b.onResolve({ filter: /^\.\/(platform|tools|logger|audio-output)$/ }, (a) => (a.importer.endsWith('server.js') ? { path: shim(a.path.slice(2)) } : undefined));
  },
};

await build({
  entryPoints: [join(root, 'mobile', 'bridge.js')],
  outfile: join(out, 'mobile-bridge.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['safari16'],
  minify: true,
  sourcemap: 'linked',
  legalComments: 'none',
  alias: {
    fs: shim('fs'), http: shim('http'), https: shim('https'), child_process: shim('child_process'),
    os: shim('os'), url: shim('url'), string_decoder: shim('string_decoder'), crypto: shim('crypto'),
    electron: shim('electron'), dns: shim('dns'), net: shim('net'), path: 'path-browserify', events: 'events', buffer: 'buffer',
  },
  inject: [join(root, 'mobile', 'globals.js')],
  define: { 'process.env.NODE_ENV': '"production"', 'require.main': 'undefined' },
  plugins: [swapLocal],
  logLevel: 'warning',
});

for (const f of ['app.js', 'styles.css', 'audio-engine.js', 'm3shapes.js', 'lyrics-rtl.js', 'track-sort.js', 'search-text.js', 'track-match.js', 'library-tools.js', 'library-pages.js', 'update-notifier.js', 'lyrics-match.js', 'encore.js', 'sync-core.js', 'sync.js', 'share-link.js', 'profiles-core.js', 'profiles.js', 'lastfm-core.js', 'lastfm.js', 'backup-core.js', 'backup.js', 'i18n.js', 'lyrics-sources.js', 'track-trim.js', 'download-batch.js', 'track-audio.js', 'now-playing.js']) cpSync(join(root, f), join(out, f));
// iOS or Android is read at runtime; CI fills in the commit and run number
writeFileSync(join(out, 'build-info.js'), buildInfoScript(''));
cpSync(join(root, 'assets'), join(out, 'assets'), { recursive: true });
cpSync(join(root, 'mobile', 'mobile.css'), join(out, 'mobile.css'));
cpSync(join(root, 'mobile', 'mobile-ui.js'), join(out, 'mobile-ui.js'));

// profiles-core.js stays the first script: everything after it (mobile-bridge.js too) sees the open profile's storage
let html = readFileSync(join(root, 'index.html'), 'utf8');
html = html
  .replace('<meta name="viewport"', '<meta name="viewport-desktop"')
  .replace('<head>', '<head>\n  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">')
  .replace('<link rel="stylesheet" href="styles.css">', '<link rel="stylesheet" href="styles.css">\n  <link rel="stylesheet" href="mobile.css">')
  .replace('<script src="audio-engine.js"></script>', '<script src="mobile-bridge.js"></script>\n  <script src="audio-engine.js"></script>')
  .replace('<script src="app.js"></script>', '<script src="app.js"></script>\n  <script src="mobile-ui.js"></script>');
writeFileSync(join(out, 'index.html'), html);
console.log('www/ ready');
