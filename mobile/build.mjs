// Assembles www/ for Capacitor (iOS and Android): bundles server.js + the mobile shims into www/mobile-bridge.js,
// copies the web UI files, and writes a mobile index.html that loads the bridge before app.js.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInfoScript } from '../tools/build-info.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');
const shim = (name) => join(root, 'mobile', 'shims', `${name}.js`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Redirect server.js's local ./platform, ./tools, ./logger, ./audio-output requires to the mobile shims.
const localShims = new Set(['./platform', './tools', './logger', './audio-output']);
const swapLocal = {
  name: 'swap-local',
  setup(b) {
    b.onResolve({ filter: /^\.\// }, (args) => {
      if (localShims.has(args.path)) return { path: shim(args.path.slice(2)) };
    });
  },
};

await build({
  entryPoints: [join(root, 'mobile', 'bridge.js')],
  bundle: true,
  outfile: join(out, 'mobile-bridge.js'),
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

console.log('Built www/ for Capacitor');
