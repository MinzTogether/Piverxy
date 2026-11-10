'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const share = require('../share-link.js');
const extract = require('../mobile/extract.js');
const googleLib = require('../google-library.js');

// 1. Playlist decompression limit (share-link.js)
test('1. Playlist decompression: enforces MAX_BYTES on compressed and raw payloads', async () => {
  assert.equal(typeof share.MAX_BYTES, 'number');
  assert.equal(share.MAX_BYTES, 512 * 1024);

  // Small deflate-raw payload that expands to 1 MB (> 512 KB cap)
  const bomb = zlib.deflateRawSync(Buffer.alloc(1024 * 1024, 'x'));
  await assert.rejects(
    share.decode('z' + bomb.toString('base64url')),
    /playlist link is too big/
  );

  // Custom lower maxBytes cap via opts
  const medium = zlib.deflateRawSync(Buffer.from(JSON.stringify({ v: 1, n: 'Test', t: [['y', 'nac6B__nFl0', 'A'.repeat(2000), 'Artist', 120]] })));
  await assert.rejects(
    share.decode('z' + medium.toString('base64url'), { maxBytes: 512 }),
    /playlist link is too big/
  );

  // Within custom maxBytes cap succeeds
  const decoded = await share.decode('z' + medium.toString('base64url'), { maxBytes: 8192 });
  assert.equal(decoded.name, 'Test');
  assert.equal(decoded.tracks.length, 1);
});

// 2. Electron hardening (main.js, plugins.js, google-library.js)
test('2. Electron hardening: BrowserWindow, session permissions, navigation and IPC sender checks', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const pluginsSrc = fs.readFileSync(path.join(__dirname, '..', 'plugins.js'), 'utf8');
  const googleSrc = fs.readFileSync(path.join(__dirname, '..', 'google-library.js'), 'utf8');

  // webPreferences hardening
  assert.doesNotMatch(mainSrc, /webSecurity:\s*false/, 'webSecurity: false must not be present');
  assert.match(mainSrc, /webSecurity:\s*true/);
  assert.match(mainSrc, /sandbox:\s*true/);
  assert.match(mainSrc, /contextIsolation:\s*true/);
  assert.match(mainSrc, /nodeIntegration:\s*false/);
  assert.match(mainSrc, /webviewTag:\s*false/);
  assert.match(mainSrc, /allowRunningInsecureContent:\s*false/);

  // Dangerous flags removed
  assert.doesNotMatch(mainSrc, /--expose-gc/);
  assert.doesNotMatch(mainSrc, /PIVERXY_FLAGS/);

  // Default session permission handler & navigation guards
  assert.match(mainSrc, /setPermissionRequestHandler\(\(wc,\s*permission,\s*cb\)\s*=>\s*cb\(false\)\)/);
  assert.match(mainSrc, /setPermissionCheckHandler\(\(\)\s*=>\s*false\)/);
  assert.match(mainSrc, /will-navigate/);
  assert.match(mainSrc, /will-redirect/);
  assert.match(mainSrc, /will-attach-webview/);
  assert.match(mainSrc, /function\s+isAppSender\b|const\s+isAppSender\s*=/);

  // IPC sender verification in plugins.js and google-library.js
  assert.match(pluginsSrc, /isAppWindow/);
  assert.match(pluginsSrc, /isSafePluginFile/);
  assert.match(googleSrc, /isAppWindow/);
  assert.equal(googleLib.partitionFor('default'), 'persist:piverxy-google');
  assert.equal(googleLib.partitionFor('abcd12'), 'persist:piverxy-google-abcd12');
});

// 3. YouTube decipher isolation (mobile/extract.js)
test('3. YouTube decipher isolation: evaluates n and sig in an isolated sandbox without host access', async () => {
  const sampleScript = `
    var exportedVars = {
      nFunction: function(val) { return "dec_n_" + val.split("").reverse().join(""); },
      sigFunction: function(val) { return "dec_sig_" + val.slice(2) + val.slice(0, 2); }
    };
  `;

  const res = await extract.evalDecipher({ output: sampleScript }, { n: '12345', sig: 'abcdef' });
  assert.deepEqual(res, { n: 'dec_n_54321', sig: 'dec_sig_cdefab' });

  // Verify host globals, network, storage, and prototype-chain escape are inaccessible inside the sandbox
  globalThis.__piverxySecretCanary = 'top-secret-token';
  try {
    const probeScript = `
      var exportedVars = {
        nFunction: function(val) {
          var leaks = [];
          if (typeof process !== 'undefined') leaks.push('process');
          if (typeof require !== 'undefined') leaks.push('require');
          if (typeof window !== 'undefined') leaks.push('window');
          if (typeof document !== 'undefined') leaks.push('document');
          if (typeof fetch !== 'undefined') leaks.push('fetch');
          if (typeof XMLHttpRequest !== 'undefined') leaks.push('XMLHttpRequest');
          if (typeof __piverxyFetch !== 'undefined') leaks.push('__piverxyFetch');
          if (typeof __piverxySecretCanary !== 'undefined') leaks.push('canary');
          try {
            var hostGlobal = this.constructor.constructor('return this')();
            if (hostGlobal && hostGlobal.__piverxySecretCanary) leaks.push('proto-escape');
          } catch (_) {}
          return leaks.length ? 'LEAK:' + leaks.join(',') : 'isolated:' + val;
        }
      };
    `;
    const check = await extract.evalDecipher({ output: probeScript }, { n: 'ok' });
    assert.equal(check.n, 'isolated:ok');
  } finally {
    delete globalThis.__piverxySecretCanary;
  }

  // Verify dynamic eval/Function inside the sandbox is blocked in VM mode
  const dynamicEvalScript = `
    var exportedVars = {
      nFunction: function(val) {
        return eval('"ev_" + val');
      }
    };
  `;
  await assert.rejects(
    extract.evalDecipher({ output: dynamicEvalScript }, { n: 'test' }),
    /Code generation from strings disallowed|eval/i
  );

  // Verify infinite loop is terminated by timeout
  const infiniteLoopScript = `
    var exportedVars = {
      nFunction: function(val) { while (true) {} return val; }
    };
  `;
  await assert.rejects(
    extract.evalDecipher({ output: infiniteLoopScript }, { n: 'loop' }, { timeoutMs: 120 }),
    /timed out|Script execution timed out/i
  );

  // Verify input size caps
  await assert.rejects(
    extract.evalDecipher({ output: sampleScript }, { n: 'x'.repeat(extract.MAX_DECIPHER_INPUT_CHARS + 1) }),
    /too long/
  );
  await assert.rejects(
    extract.evalDecipher({ output: 'a'.repeat(extract.MAX_DECIPHER_SCRIPT_BYTES + 1) }, { n: 'abc' }),
    /too large/
  );
});

test('3b. YouTube decipher isolation: Web Worker path strips network/storage globals and terminates on timeout', async () => {
  const origWorker = globalThis.Worker;
  const origURL = globalThis.URL;
  let blobSources = [];
  let terminated = 0;

  class FakeWorker {
    constructor(url) {
      this.url = url;
      this.onmessage = null;
      this.onerror = null;
    }
    postMessage(data) {
      const src = blobSources[blobSources.length - 1] || '';
      if (src.includes('while (true)')) return; // simulate hang for timeout test
      const selfObj = {
        fetch: () => {},
        XMLHttpRequest: function () {},
        WebSocket: function () {},
        importScripts: () => {},
        indexedDB: {},
        __piverxyFetch: () => {},
        Capacitor: {},
        electronAPI: {},
        localStorage: {},
        postMessage: (msg) => {
          if (this.onmessage) setImmediate(() => this.onmessage({ data: msg }));
        },
        close: () => {},
      };
      const fn = new Function('self', src);
      fn(selfObj);
      if (typeof selfObj.onmessage === 'function') {
        selfObj.onmessage({ data });
      }
    }
    terminate() {
      terminated++;
    }
  }

  globalThis.Worker = FakeWorker;
  const realCreateObjectURL = URL.createObjectURL;
  const realRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => {
    blob.text().then((t) => blobSources.push(t));
    return 'blob:fake-worker';
  };
  URL.revokeObjectURL = () => {};

  try {
    // Wait a tick inside FakeWorker after blob.text() resolves
    globalThis.Worker = class extends FakeWorker {
      postMessage(data) {
        setTimeout(() => super.postMessage(data), 10);
      }
    };
    const workerProbe = `
      var exportedVars = {
        nFunction: function(v) {
          return [typeof fetch, typeof XMLHttpRequest, typeof __piverxyFetch, typeof Capacitor, typeof electronAPI, v].join(':');
        }
      };
    `;
    const r = await extract.evalDecipher({ output: workerProbe }, { n: 'wk' });
    assert.equal(r.n, 'undefined:undefined:undefined:undefined:undefined:wk');
    assert.ok(terminated >= 1, 'worker is terminated on cleanup');

    const beforeTerm = terminated;
    await assert.rejects(
      extract.evalDecipher({ output: 'var exportedVars = { nFunction: function() { while (true) {} } };' }, { n: 'hang' }, { timeoutMs: 60 }),
      /YouTube decipher timed out/
    );
    assert.ok(terminated > beforeTerm, 'hung worker is terminated on timeout');
  } finally {
    globalThis.Worker = origWorker;
    URL.createObjectURL = realCreateObjectURL;
    URL.revokeObjectURL = realRevokeObjectURL;
  }
});

// 4. Rust workflow (.github/workflows/rust.yml)
test('4. Rust workflow: verifies SHA-256 of bundled node.exe, installs dependencies and sets persist-credentials: false', () => {
  const rustYml = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'rust.yml'), 'utf8');
  assert.match(rustYml, /persist-credentials:\s*false/);
  assert.match(rustYml, /npm ci --no-audit --no-fund/);
  assert.match(rustYml, /SHASUMS256\.txt/);
  assert.match(rustYml, /Get-FileHash\s+-Path\s+backend\/node\.exe\s+-Algorithm\s+SHA256/);
  assert.match(rustYml, /New-Item\s+-ItemType\s+Directory\s+-Force\s+-Path\s+backend/);
  assert.match(rustYml, /working-directory:\s*rust/);
});
