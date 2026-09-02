const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

const MAX_FILES = 5000;
const MAX_BYTES = 220 * 1024 * 1024;
const MIME = {
  '.avif': 'image/avif', '.css': 'text/css; charset=utf-8', '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.mp4': 'video/mp4', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webm': 'video/webm', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.xml': 'application/xml; charset=utf-8',
};

function safeArchivePath(name) {
  const normalized = String(name || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return null;
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '..')) return null;
  return parts.join('/');
}

function chooseEntry(files) {
  const html = files.filter((name) => /\.html?$/i.test(name));
  if (!html.length) return null;
  return html.sort((a, b) => {
    const ai = /(^|\/)index\.html?$/i.test(a) ? 0 : 1;
    const bi = /(^|\/)index\.html?$/i.test(b) ? 0 : 1;
    return ai - bi || a.split('/').length - b.split('/').length || a.length - b.length;
  })[0];
}

function createImportStore({ serve = true } = {}) {
  const roots = new Map();
  let server = null;
  let origin = '';
  let sequence = 0;

  async function ensureServer() {
    if (server) return origin;
    server = http.createServer((req, res) => {
      try {
        const parsed = new URL(req.url, 'http://127.0.0.1');
        const [, requestedId, ...rest] = parsed.pathname.split('/');
        let id = requestedId;
        let root = roots.get(id);
        let requestedParts = rest;
        if (!root && req.headers.referer) {
          const refererId = new URL(req.headers.referer).pathname.split('/').filter(Boolean)[0];
          if (roots.has(refererId)) {
            id = refererId;
            root = roots.get(id);
            requestedParts = [requestedId, ...rest];
          }
        }
        if (!root) { res.writeHead(404).end('Archive not found'); return; }
        const requested = safeArchivePath(decodeURIComponent(requestedParts.join('/'))) || root.entry;
        let file = path.resolve(root.dir, requested);
        const entryRelative = path.resolve(root.dir, path.dirname(root.entry), requested);
        if (!fs.existsSync(file) && entryRelative.startsWith(root.dir + path.sep)) file = entryRelative;
        if (file !== root.dir && !file.startsWith(root.dir + path.sep)) { res.writeHead(403).end('Forbidden'); return; }
        const actual = fs.existsSync(file) && fs.statSync(file).isDirectory() ? path.join(file, 'index.html') : file;
        if (!fs.existsSync(actual) || !fs.statSync(actual).isFile()) { res.writeHead(404).end('File not found'); return; }
        res.setHeader('Content-Type', MIME[path.extname(actual).toLowerCase()] || 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        fs.createReadStream(actual).pipe(res);
      } catch {
        res.writeHead(400).end('Invalid request');
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    return origin;
  }

  async function importBuffer(buffer, filename = 'website.zip') {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('The selected archive is empty');
    if (buffer.length > MAX_BYTES) throw new Error('The archive is larger than 220 MB');
    const id = `site-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-generator-import-'));
    const extracted = [];
    let total = 0;
    try {
      if (/\.html?$/i.test(filename) && !buffer.subarray(0, 2).equals(Buffer.from('PK'))) {
        fs.writeFileSync(path.join(dir, 'index.html'), buffer);
        extracted.push('index.html');
        total = buffer.length;
      } else {
        let zip;
        try { zip = await JSZip.loadAsync(buffer); } catch { throw new Error('The selected file is not a readable ZIP archive'); }
        const entries = Object.values(zip.files).filter((entry) => !entry.dir);
        if (entries.length > MAX_FILES) throw new Error(`The archive contains more than ${MAX_FILES} files`);
        for (const entry of entries) {
          const relative = safeArchivePath(entry.name);
          if (!relative) throw new Error(`The archive contains an unsafe path: ${entry.name}`);
          const contents = await entry.async('nodebuffer');
          total += contents.length;
          if (total > MAX_BYTES) throw new Error('The extracted website is larger than 220 MB');
          const destination = path.join(dir, relative);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.writeFileSync(destination, contents);
          extracted.push(relative);
        }
      }
      const entry = chooseEntry(extracted);
      if (!entry) throw new Error('No HTML page was found in the archive');
      roots.set(id, { dir, entry, filename: path.basename(filename) });
      if (serve) await ensureServer();
      return {
        id,
        name: path.basename(filename).replace(/\.(zip|html?)$/i, '') || 'Archived website',
        entry,
        files: extracted.length,
        bytes: total,
        url: serve ? `${origin}/${id}/${entry.split('/').map(encodeURIComponent).join('/')}` : '',
      };
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  function close() {
    for (const { dir } of roots.values()) fs.rmSync(dir, { recursive: true, force: true });
    roots.clear();
    if (server) server.close();
    server = null;
    origin = '';
  }

  return { importBuffer, close, _roots: roots };
}

module.exports = { createImportStore, safeArchivePath, chooseEntry, MAX_FILES, MAX_BYTES };
