// Dev harness: serves www/ and a /__proxy that stands in for CapacitorHttp (no CORS) in a desktop browser.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const www = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'www');
const port = Number(process.env.PORT) || 5173;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.map': 'application/json' };

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__proxy') {
    try {
      const headers = JSON.parse(req.headers['x-fwd-headers'] || '{}');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const r = await fetch(u.searchParams.get('url'), { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: 'follow' });
      const h = {};
      r.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding|connection|set-cookie)$/i.test(k)) h[k] = v; });
      const buf = Buffer.from(await r.arrayBuffer());
      if (r.status >= 400) console.log(`[proxy] ${r.status} ${req.method} ${u.searchParams.get('url').slice(0, 90)}
  sent: ${JSON.stringify(headers).slice(0, 300)}
  got: ${buf.toString('utf8', 0, 400)}`);
      res.writeHead(r.status, h);
      res.end(buf);
    } catch (e) { res.writeHead(502); res.end(String(e)); }
    return;
  }
  let p;
  try { p = resolve(join(www, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname))); } catch { p = ''; }
  // only files inside www/ (".." in the path used to reach the whole disk), and headers only once the read worked
  if (!p.startsWith(www + sep)) { res.writeHead(404); return res.end('not found'); }
  try {
    if (!(await stat(p)).isFile()) throw new Error('not a file');
    const body = await readFile(p);
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
// this machine only: the proxy and the files are not for the rest of the network
}).listen(port, '127.0.0.1', () => console.log(`muriel mobile dev: http://127.0.0.1:${port}`));
