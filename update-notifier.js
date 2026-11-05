// "Update available": compares this build (build-info.js, stamped in CI) with the platform's rolling GitHub
// release (ios-latest / android-latest / windows-latest). Asks GitHub at most every 6 hours; "Later" hides the
// banner for that build for 3 days. Local and dev builds (sha "dev") never ask.
(() => {
  const build = window.MURIEL_BUILD || {};
  const CHECK_EVERY = 6 * 3600 * 1000;
  const SNOOZE = 3 * 24 * 3600 * 1000;
  const TAGS = { ios: 'ios-latest', android: 'android-latest', windows: 'windows-latest' };
  const ASSETS = { android: 'Muriel.apk', windows: 'Muriel.exe' }; // iOS goes to the release page (sideload)
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  const channel = build.channel || (window.Capacitor && window.Capacitor.getPlatform ? window.Capacitor.getPlatform() : '');
  const tag = TAGS[channel];
  const enabled = !!(tag && build.sha && build.sha !== 'dev');

  async function latestRelease() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(`https://api.github.com/repos/${build.repo || 'cloverscripts/riff-muriel'}/releases/tags/${tag}`, { headers: { Accept: 'application/vnd.github+json' }, signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // newer = built from another commit and published after this build was made (so test builds that are
  // newer than the public release don't get told to "update" to an older one)
  function describe(rel) {
    if (!rel || !rel.target_commitish || rel.target_commitish === build.sha) return null;
    const published = Date.parse(rel.published_at || rel.created_at || 0);
    const built = Date.parse(build.builtAt || 0);
    if (!(published > built + 60000)) return null;
    const asset = (rel.assets || []).find((a) => a.name === ASSETS[channel]);
    const run = Number(((rel.body || '').match(/run (\d+)/) || [])[1]) || 0;
    const version = ((rel.body || '').match(/muriel-version: ([0-9][\w.-]*)/) || [])[1] || '';
    return { sha: rel.target_commitish, run, version, url: (asset && asset.browser_download_url) || rel.html_url, page: rel.html_url };
  }

  function open(url) {
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) location.href = url; // the native shell hands outside links to the browser
    else window.open(url, '_blank');
  }

  // "Muriel 1.2.4" when the new build is a new version, else its build number
  function label(update) {
    if (update.version && update.version !== build.version) return `Muriel ${update.version}`;
    if (update.run && build.run && update.run > build.run) return `Build ${update.run}`;
    return 'A newer Muriel build';
  }

  let banner = null;
  function hideBanner() {
    if (!banner) return;
    const b = banner; banner = null;
    b.classList.remove('show');
    setTimeout(() => b.remove(), 400);
  }
  function showBanner(update) {
    if (banner) return;
    const snooze = store.get('muriel_update_snooze');
    if (snooze && snooze.sha === update.sha && snooze.until > Date.now()) return;
    banner = document.createElement('div');
    banner.className = 'update-banner';
    banner.setAttribute('role', 'status');
    banner.innerHTML = `
      <svg class="update-banner-star" viewBox="0 0 1024 1024" aria-hidden="true"><path d="M512 32Q570 454 992 512Q570 570 512 992Q454 570 32 512Q454 454 512 32Z"/></svg>
      <div class="update-banner-text"><b data-i18n>Update available</b><span data-i18n></span></div>
      <button type="button" class="update-banner-later" data-i18n>Later</button>
      <button type="button" class="update-banner-go" data-i18n>Download</button>`;
    banner.querySelector('span').textContent = label(update) + ' is ready';
    banner.querySelector('.update-banner-go').addEventListener('click', () => { open(update.url); hideBanner(); });
    banner.querySelector('.update-banner-later').addEventListener('click', () => { store.set('muriel_update_snooze', { sha: update.sha, until: Date.now() + SNOOZE }); hideBanner(); });
    document.body.appendChild(banner);
    requestAnimationFrame(() => requestAnimationFrame(() => banner && banner.classList.add('show')));
  }

  // Settings > About: status line and "Check now"
  const statusEl = document.getElementById('update-status');
  const checkBtn = document.getElementById('btn-check-updates');
  const setStatus = (text, update) => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle('has-update', !!update);
    if (checkBtn) checkBtn.textContent = update ? 'Download' : 'Check now';
  };
  let current = null;

  async function check(manual) {
    if (!enabled) { if (manual) setStatus('Update checks run in the official builds'); return; }
    const last = store.get('muriel_update_last') || 0;
    if (!manual && Date.now() - last < CHECK_EVERY) {
      const cached = store.get('muriel_update_found');
      if (cached && cached.from === build.sha) { current = cached.update; showBanner(current); setStatus(`${label(current)} is available`, current); }
      return;
    }
    if (manual) setStatus('Checking…');
    const rel = await latestRelease();
    if (!rel) { if (manual) setStatus("Couldn't reach GitHub, try again later"); return; }
    store.set('muriel_update_last', Date.now());
    current = describe(rel);
    store.set('muriel_update_found', current ? { from: build.sha, update: current } : null);
    if (current) { setStatus(`${label(current)} is available`, current); showBanner(current); }
    else setStatus(`You're up to date${build.run ? ` (build ${build.run})` : ''}`);
  }

  if (checkBtn) checkBtn.addEventListener('click', () => (current ? open(current.url) : check(true)));
  if (statusEl) setStatus(enabled ? `${build.version ? `Muriel ${build.version} · ` : ''}Build ${build.run || '?'} · ${String(build.sha).slice(0, 7)}` : 'Development build');

  // first check a little after start-up, then whenever the app comes back to the foreground
  setTimeout(() => check(false), 8000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(false); });
  window.MurielUpdates = { check: () => check(true) };
})();
