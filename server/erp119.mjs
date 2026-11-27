/* ERP 119.3 on its own host (erp.<domain>), served by the same Node process.

   The vendor's file (releases/sellersmart-erp-119.3/SellerSmart_ERP_119_3.html)
   is kept byte for byte in the repository; this module patches it in memory
   when it is first requested:

     1. before its loader script, add the Supabase client and erp119/sync.js
        (the server storage adapter, see that file);
     2. make the loader wait for the adapter (SRCloud119.ready) before it
        starts the ERP iframe, so the ERP never boots on stale local data;
     3. give the loader's "taking long" notice more time, since the first
        open copies and downloads the whole workspace.

   Each patch anchors on an exact snippet of the vendor file and fails loudly
   if it is missing, so a new vendor release cannot silently run without
   the adapter.

   Routes on that host:
     /, /index.html          the patched ERP, behind the same session-cookie
                             gate as the main app (middleware.js)
     /login, /login.html     erp119/login.html
     /erp119/sync.js         the adapter
     /assets/app-config.js   Supabase URL = this host (Caddy proxies the
                             Supabase API on it), anon key from the env
     /assets/vendor/supabase.js   from public/

   Environment:
     ERP119_HOST   host name, e.g. erp.sellersmart.uz (unset: feature off)
     ERP119_HTML   vendor file, default the 119.3 release above */

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const LOADER_TAG = '<script id="portable-loader">';
const WAIT_ANCHOR = 'await SRWriter101.ready;';
const WATCHDOG_ANCHOR = "show('Yuklash cho‘zildi.";
/* Both pages name the config script; at serve time the tag is replaced by
   the config itself, inline. A separate /assets/app-config.js request is
   what content blockers drop ("config" in the path), and without it the
   page cannot reach the server at all. */
const CONFIG_TAG = '<script src="/assets/app-config.js"></script>';

export function patchErp119Html(source, { syncVersion = '' } = {}) {
  const loaderAt = source.lastIndexOf(LOADER_TAG);
  if (loaderAt < 0) throw new Error('erp119: loader script not found in the vendor HTML');
  const waitAt = source.indexOf(WAIT_ANCHOR, loaderAt);
  if (waitAt < 0) throw new Error('erp119: loader wait point not found in the vendor HTML');

  let loader = source.slice(loaderAt);
  loader = loader.replace(WAIT_ANCHOR, WAIT_ANCHOR + 'if(window.SRCloud119)await window.SRCloud119.ready;');
  // The watchdog is cosmetic (it only shows a notice); widen it if present.
  const watchdogAt = loader.indexOf(WATCHDOG_ANCHOR);
  if (watchdogAt >= 0) {
    const end = loader.indexOf('},30000);', watchdogAt);
    if (end >= 0 && end - watchdogAt < 400) loader = loader.slice(0, end) + '},180000);' + loader.slice(end + '},30000);'.length);
  }

  const inject =
    CONFIG_TAG + '\n' +
    '<script src="/assets/vendor/supabase.js"></script>\n' +
    `<script src="/erp119/sync.js${syncVersion ? '?v=' + syncVersion : ''}"></script>\n`;
  return source.slice(0, loaderAt) + inject + loader;
}

export function createErp119({ root, publicDir, gate, env }) {
  // One host, or several separated by commas (e.g. a second name for testing).
  const hosts = String(env.ERP119_HOST || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!hosts.length) return null;
  const host = hosts.join(',');
  const htmlPath = String(env.ERP119_HTML || '').trim()
    || join(root, 'releases', 'sellersmart-erp-119.3', 'SellerSmart_ERP_119_3.html');
  const dir = join(root, 'erp119');
  const files = new Map([
    ['/erp119/sync.js', [join(dir, 'sync.js'), 'text/javascript; charset=utf-8']],
    ['/assets/vendor/supabase.js', [join(publicDir, 'assets', 'vendor', 'supabase.js'), 'text/javascript; charset=utf-8']]
  ]);

  let page = null; // { body, etag, key }

  async function patchedPage() {
    const [src, sync] = await Promise.all([stat(htmlPath), stat(join(dir, 'sync.js'))]);
    const key = `${src.size}-${Math.floor(src.mtimeMs)}-${Math.floor(sync.mtimeMs)}`;
    if (page && page.key === key) return page;
    const html = patchErp119Html(await readFile(htmlPath, 'utf8'), {
      syncVersion: Math.floor(sync.mtimeMs).toString(36)
    });
    const at = html.indexOf(CONFIG_TAG);
    page = { head: html.slice(0, at), tail: html.slice(at + CONFIG_TAG.length), key };
    return page;
  }

  function inlineConfig(url) {
    return '<script>' + configScript(url).replace(/</g, '\\u003c') + '</script>';
  }

  function baseHeaders(secure) {
    const h = {
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'camera=(self), microphone=(), geolocation=()',
      'cache-control': 'private, no-cache'
    };
    if (secure) h['strict-transport-security'] = 'max-age=63072000';
    return h;
  }

  function configScript(url) {
    return `/* Generated by server/erp119.mjs. */
window.SMART_RETAIL_CONFIG = ${JSON.stringify({
      supabaseUrl: `${url.protocol}//${url.host}`,
      supabaseAnonKey: String(env.SUPABASE_PUBLIC_KEY || env.SUPABASE_ANON_KEY || '').trim(),
      staffEmailDomain: String(env.STAFF_EMAIL_DOMAIN || 'staff.sellersmart.uz').trim()
    }, null, 2)};
`;
  }

  return {
    host,
    matches: (url) => hosts.includes(url.hostname.toLowerCase()),
    async handle(req, res, url, pathname) {
      const secure = url.protocol === 'https:';
      const headers = baseHeaders(secure);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { ...headers, allow: 'GET, HEAD' });
        return res.end();
      }

      if (pathname === '/' || pathname === '/index.html') {
        // gate() answers the request itself (redirect to /login.html) when
        // the session cookie is missing or refused.
        if (await gate(req, res, url, headers)) return;
        const p = await patchedPage();
        const etag = `W/"erp119-${p.key}-${Buffer.from(url.host).toString('hex')}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { ...headers, etag });
          return res.end();
        }
        const body = Buffer.from(p.head + inlineConfig(url) + p.tail);
        res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-length': body.length, etag });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }

      if (pathname === '/login' || pathname === '/login.html') {
        const html = (await readFile(join(dir, 'login.html'), 'utf8')).replace(CONFIG_TAG, inlineConfig(url));
        const body = Buffer.from(html);
        res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }

      if (pathname === '/assets/app-config.js') {
        const body = configScript(url);
        res.writeHead(200, { ...headers, 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }

      const file = files.get(pathname);
      if (!file) {
        res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found');
      }
      const info = await stat(file[0]);
      res.writeHead(200, { ...headers, 'content-type': file[1], 'content-length': info.size });
      if (req.method === 'HEAD') return res.end();
      createReadStream(file[0]).on('error', () => res.destroy()).pipe(res);
    }
  };
}
