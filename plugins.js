const fs = require('fs');
const path = require('path');
const { dialog, ipcMain, shell } = require('electron');
const { DATA_DIR } = require('./platform');

const PLUGINS_DIR = path.join(DATA_DIR, 'plugins');
const STATE_FILE = path.join(PLUGINS_DIR, 'state.json');

function ensureDir() {
  try { fs.mkdirSync(PLUGINS_DIR, { recursive: true }); } catch (e) {}
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}

function writeState(state) {
  ensureDir();
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); } catch (e) {}
}

function parseMeta(code, file) {
  const meta = { name: file.replace(/\.js$/i, ''), author: '', version: '', description: '' };
  const head = code.slice(0, 2048);
  for (const key of ['name', 'author', 'version', 'description']) {
    const m = head.match(new RegExp(`@${key}\\s+([^\\r\\n*]+)`, 'i'));
    if (m) meta[key] = m[1].trim();
  }
  return meta;
}

function isSafePluginFile(file) {
  return typeof file === 'string' && file === path.basename(file) && /\.js$/i.test(file) && !file.startsWith('.');
}

function listPlugins() {
  ensureDir();
  const state = readState();
  let files = [];
  try { files = fs.readdirSync(PLUGINS_DIR).filter((f) => f.toLowerCase().endsWith('.js')); } catch (e) {}
  return files.map((file) => {
    let code = '';
    try { code = fs.readFileSync(path.join(PLUGINS_DIR, file), 'utf8'); } catch (e) {}
    return { file, ...parseMeta(code, file), enabled: !!state[file], code };
  });
}

function register(getWin) {
  const isAppWindow = (event) => {
    const win = typeof getWin === 'function' ? getWin() : null;
    if (!win || win.isDestroyed() || !event || event.sender !== win.webContents) return false;
    if (event.senderFrame && event.senderFrame !== win.webContents.mainFrame) return false;
    return true;
  };

  ipcMain.removeHandler('list-plugins');
  ipcMain.removeHandler('set-plugin-enabled');
  ipcMain.removeHandler('remove-plugin');
  ipcMain.removeHandler('disable-all-plugins');
  ipcMain.removeHandler('import-plugins');

  ipcMain.handle('list-plugins', (event) => {
    if (!isAppWindow(event)) return [];
    return listPlugins();
  });

  ipcMain.handle('set-plugin-enabled', (event, { file, enabled } = {}) => {
    if (!isAppWindow(event) || !isSafePluginFile(file)) return false;
    const state = readState();
    state[file] = !!enabled;
    writeState(state);
    return true;
  });

  ipcMain.handle('remove-plugin', (event, file) => {
    if (!isAppWindow(event) || !isSafePluginFile(file)) return false;
    const safe = path.basename(String(file || ''));
    try { fs.unlinkSync(path.join(PLUGINS_DIR, safe)); } catch (e) {}
    const state = readState();
    delete state[safe];
    writeState(state);
    return true;
  });

  ipcMain.handle('disable-all-plugins', (event) => {
    if (!isAppWindow(event)) return false;
    writeState({});
    return true;
  });

  ipcMain.handle('import-plugins', async (event) => {
    if (!isAppWindow(event)) return 0;
    ensureDir();
    const res = await dialog.showOpenDialog(getWin(), {
      title: 'Add Plugin',
      filters: [{ name: 'Piverxy Plugin (.js)', extensions: ['js'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (res.canceled || !res.filePaths.length) return 0;
    const state = readState();
    let count = 0;
    for (const src of res.filePaths) {
      const name = path.basename(src);
      if (!name.toLowerCase().endsWith('.js')) continue;
      try {
        fs.copyFileSync(src, path.join(PLUGINS_DIR, name));
        if (!(name in state)) state[name] = false;
        count++;
      } catch (e) {}
    }
    writeState(state);
    return count;
  });

  ipcMain.removeAllListeners('open-plugins-folder');
  ipcMain.on('open-plugins-folder', (event) => {
    if (!isAppWindow(event)) return;
    ensureDir();
    shell.openPath(PLUGINS_DIR);
  });
}

module.exports = { register };
