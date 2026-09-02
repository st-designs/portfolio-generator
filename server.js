/**
 * Portfolio Generator server.
 * Captures live and saved websites, composes portfolio assets, and serves the UI.
 */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const sharp = require('sharp');
const { capture, captureHero, captureShots, recordScrollVideo, setPatience, setOverlayCleanup, setExtraWait, setStitchMode } = require('./lib/capture');
const { composeLogoSet, composeMockupSet, composeShowcaseSet, composeFeaturedSet, composeShotImage, composeScreensImage, SHOWCASE_LIGHT, SHOWCASE_DENSE } = require('./lib/compose');
const { recordAnimatedShowcase, ANIM_STYLES } = require('./lib/animate');
const { createImportStore } = require('./lib/imports');

let FFMPEG = null;
try { FFMPEG = require('@ffmpeg-installer/ffmpeg').path; } catch {}

function resolveOutDir() {
  if (process.env.OUTPUT_DIR) return process.env.OUTPUT_DIR;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    if (cfg.outputDir && fs.existsSync(cfg.outputDir)) return cfg.outputDir;
    if (cfg.outputDir) console.warn(`config.json outputDir does not exist: ${cfg.outputDir} — falling back to parent folder`);
  } catch {}
  return path.join(process.env.PORTFOLIO_DATA_DIR || __dirname, 'Generated');
}
const OUT_DIR = resolveOutDir();
const SETTINGS_FILE = process.env.SETTINGS_FILE
  || path.join(process.env.PORTFOLIO_DATA_DIR || __dirname, 'settings.json');

const app = express();
const importStore = createImportStore();
app.disable('x-powered-by');
app.post('/api/import', express.raw({ type: ['application/zip', 'application/octet-stream', 'text/html'], limit: '220mb' }), async (req, res) => {
  try {
    const rawName = String(req.get('x-archive-name') || 'website.zip');
    const filename = decodeURIComponent(rawName).replace(/[\r\n]/g, '').slice(0, 200);
    const imported = await importStore.importBuffer(req.body, filename);
    res.json(imported);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/vendor/jszip.min.js', (_req, res) => res.sendFile(require.resolve('jszip/dist/jszip.min.js')));
app.use('/output', express.static(OUT_DIR));

const jobs = new Map();
let jobSeq = 0;
let workQueue = Promise.resolve();

// Playwright is intentionally serialized. Parallel Chromium jobs compete for
// memory and, more importantly, the capture module's active quality preset.
// A queue keeps captures deterministic and prevents the app from freezing.
function enqueue(work) {
  const next = workQueue.then(work, work);
  workQueue = next.catch(() => {});
  return next;
}

function siteName(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const raw = /^\d+(\.\d+){3}$/.test(host) ? host : host.split('.')[0];
    return raw.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'site';
  } catch { return 'site'; }
}

function siteDisplayName(meta = {}, fallback = 'site') {
  const clean = (value) => String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const explicit = clean(meta.siteName);
  if (explicit) return explicit.slice(0, 100);
  const title = clean(meta.title);
  // A short, unsuffixed document title is commonly the site name. Longer
  // marketing/page titles are less reliable than the stable hostname slug.
  if (title && title.length <= 60 && !/\s(?:[|·—–-])\s/.test(title)) return title;
  return clean(fallback) || 'site';
}

const okColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c.trim()) ? c.trim() : undefined);

function parseBg(b = {}) {
  const style = ['auto', 'solid', 'gradient'].includes(b.style) ? b.style : 'auto';
  return { style, c1: okColor(b.c1), c2: okColor(b.c2) };
}

function parseSections(s = {}) {
  const on = (o, d = true) => (o && o.on !== undefined ? !!o.on : d);
  const num = (x, d, min, max) => { const n = parseInt(x, 10); return n >= min && n <= max ? n : d; };
  const devices = (o = {}) => ({ desktop: o.desktop !== false, tablet: o.tablet !== false, mobile: o.mobile !== false });
  const pages = (o) => (typeof (o && o.pages) === 'string' ? o.pages.split(/[\n,]/).map((x) => x.trim()).filter(Boolean) : []);
  const disp = s.display || s.featured;
  const rad = (o) => { const n = parseInt(o && o.radius, 10); return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined; };
  return {
    logo: { on: on(s.logo), assets: ['both', 'icon', 'wordmark'].includes(s.logo && s.logo.assets) ? s.logo.assets : 'both', bg: parseBg(s.logo && s.logo.bg) },
    display: { on: on(disp), bg: parseBg(disp && disp.bg), radius: rad(disp) },
    mockups: { on: on(s.mockups), count: num(s.mockups && s.mockups.count, 4, 1, 4), devices: devices(s.mockups && s.mockups.devices), pages: pages(s.mockups), bg: parseBg(s.mockups && s.mockups.bg), radius: rad(s.mockups) },
    showcase: { on: on(s.showcase), count: num(s.showcase && s.showcase.count, 4, 1, 6), devices: devices(s.showcase && s.showcase.devices), pages: pages(s.showcase), bg: parseBg(s.showcase && s.showcase.bg), radius: rad(s.showcase) },
    showcaseVideo: {
      on: s.showcaseVideo ? on(s.showcaseVideo) : !!(s.showcase && s.showcase.animate),
      count: num(s.showcaseVideo && s.showcaseVideo.count, 1, 1, 4),
      devices: devices(s.showcaseVideo && s.showcaseVideo.devices),
      pages: pages(s.showcaseVideo),
      bg: parseBg(s.showcaseVideo && s.showcaseVideo.bg),
      radius: rad(s.showcaseVideo),
    },
    screenshots: {
      on: on(s.screenshots, false),
      urls: pages(s.screenshots && { pages: s.screenshots.urls }),
      viewport: !(s.screenshots && s.screenshots.viewport === false),
      full: !!(s.screenshots && s.screenshots.full),
      width: s.screenshots && s.screenshots.width, height: s.screenshots && s.screenshots.height,
      frame: ['auto', 'plain', 'boxed'].includes(s.screenshots && s.screenshots.frame) ? s.screenshots.frame : 'auto',
      bg: parseBg(s.screenshots && s.screenshots.bg), radius: rad(s.screenshots),
    },
    video: {
      on: on(s.video),
      url: typeof (s.video && s.video.url) === 'string' ? s.video.url.trim() : '',
      width: s.video && s.video.width, height: s.video && s.video.height,
      bg: okColor(s.video && s.video.bg),
    },
  };
}

function parseStyle(st = {}) {
  const bgOn = st.bg && st.bg.on;
  const radRaw = st.radius;
  const radius = radRaw === 'seeded' ? 'seeded'
    : (Number.isFinite(parseInt(radRaw, 10)) ? Math.max(0, Math.min(100, parseInt(radRaw, 10))) : 24);
  const ew = parseFloat(st.extraWait);
  return {
    bg: bgOn ? parseBg(st.bg) : null,
    radius,
    overlays: !(st.overlays === false),
    patience: ['fast', 'normal', 'thorough'].includes(st.patience) ? st.patience : 'normal',
    extraWait: Number.isFinite(ew) ? Math.max(0, Math.min(30, ew)) : 0,
    stitch: ['auto', 'always', 'off'].includes(st.stitch) ? st.stitch : 'auto',
  };
}
const bgIsSet = (bg) => bg && (bg.style !== 'auto' || bg.c1);
// per-section > master > undefined (compose falls back to its own defaults)
const effBg = (job, sec) => (bgIsSet(sec.bg) ? sec.bg : (job.style.bg || undefined));
// per-section number > master number > undefined ('seeded' = per-image random)
const effRad = (job, sec) => (Number.isFinite(sec.radius) ? sec.radius : (job.style.radius === 'seeded' ? undefined : job.style.radius));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseSeed(value, random = Math.random) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : Math.floor(random() * 1e9);
}

function qcCheck(key, svg, log) {
  const issues = [];
  const visual = /<(image|path|text|circle|ellipse|polygon|polyline|line)\b/i.test(svg || '')
    || ((svg || '').match(/<rect\b/gi) || []).length > 1
    || ((svg || '').match(/<svg\b/gi) || []).length > 1;
  if (!svg || (svg.length < 1200 && !visual)) issues.push('suspiciously small output');
  if (!visual) issues.push('no rendered content found');
  if (!/width="\d+" height="\d+"/.test(svg)) issues.push('missing canvas size');
  if (issues.length) log(`  QC ${key}: WARN — ${issues.join('; ')}`);
  return issues.length === 0;
}

const OUTPUT_FOLDERS = {
  svg: 'SVG', png: 'PNG', jpg: 'JPG', jpeg: 'JPG',
  mp4: 'MP4', webm: 'WEBM', gif: 'GIF', zip: 'ZIP',
};

function outputLocation(job, file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const folder = OUTPUT_FOLDERS[ext] || 'Other';
  return {
    dir: path.join(OUT_DIR, job.slug, folder),
    path: `output/${job.slug}/${folder}/${file}`,
  };
}

function writeImage(job, key, svg) {
  const file = `${job.slug}-${key}.svg`;
  const target = outputLocation(job, file);
  fs.mkdirSync(target.dir, { recursive: true });
  fs.writeFileSync(path.join(target.dir, file), svg);
  const entry = { key, file, path: target.path };
  const prev = job.images.find((i) => i.key === key);
  if (prev) Object.assign(prev, entry); else job.images.push(entry);
}

function mergedPools(caps) {
  const usable = (items) => items.filter((item) => !item.quality || item.quality.usable);
  return {
    fullPages: usable(caps.flatMap((c) => c.fullPages)),
    mobilePages: usable(caps.flatMap((c) => c.mobilePages)),
    tabletPages: usable(caps.flatMap((c) => c.tabletPages || [])),
    heroes: caps.map((c) => c.screenshots.hero).filter(Boolean),
    heroTall: caps[0].screenshots.heroTall,
    hero: caps[0].screenshots.hero,
  };
}

function filterPools(pools, pageList) {
  if (!pageList || !pageList.length) return pools;
  const norm = (u) => { try { return new URL(u, 'https://x.test').pathname.replace(/\/$/, '') || '/'; } catch { return u; } };
  const wanted = pageList.map(norm);
  const match = (pg) => { const p = norm(pg.url); return wanted.some((w) => p === w || pg.url === w || p.endsWith(w)); };
  const f = (arr) => { const r = arr.filter(match); return r.length ? r : arr; };
  return { ...pools, fullPages: f(pools.fullPages), mobilePages: f(pools.mobilePages), tabletPages: f(pools.tabletPages) };
}

// ---- fresh crawl: full re-discovery + re-capture of every site (used by
// generation and by EVERY regenerate — no cached captures are ever reused)
async function freshCrawl(job, log) {
  log('Fresh crawl: re-discovering pages and capturing the live site...');
  const caps = [];
  for (let index = 0; index < job.urls.length; index++) {
    const u = job.urls[index];
    if (job.urls.length > 1) log(`=== Site ${index + 1}/${job.urls.length}: ${u} ===`);
    try {
      const captured = await capture(u, { pages: job.crawl, onLog: log, viewports: job.opts.viewports, tablet: job.needTablet });
      if (!captured.fullPages.length && !captured.screenshots.hero) throw new Error('no usable captures were produced');
      caps.push(captured);
    } catch (error) {
      log(`Site skipped after retries: ${u} (${error.message.split('\n')[0]})`);
    }
  }
  if (!caps.length) throw new Error('None of the requested websites produced a usable capture');
  job.caps = caps;
  job.url = caps[0].meta.url || job.url;
}

async function markPreview(mark) {
  try {
    if (!mark) return '';
    const input = mark.type === 'svg' ? Buffer.from(mark.svg) : mark.buffer;
    const png = await sharp(input).resize(64, 64, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch { return ''; }
}

// ---- scroll video: record webm, convert to mp4 (high quality)
function ffmpegArgs(inPath, outPath, trimStart = 0) {
  const args = ['-y', '-i', inPath];
  // Output seeking decodes up to the requested timestamp. Input seeking can
  // jump backwards to a keyframe and leak the loading/overlay phase.
  if (trimStart > 0.05) args.push('-ss', trimStart.toFixed(2));
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-an', outPath);
  return args;
}

function ffmpegConvert(inPath, outPath, trimStart = 0) {
  return new Promise((resolve, reject) => {
    if (!FFMPEG) return reject(new Error('ffmpeg not installed — run npm install'));
    const p = spawn(FFMPEG, ffmpegArgs(inPath, outPath, trimStart));
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + err.split('\n').slice(-3).join(' ')))));
    p.on('error', reject);
  });
}

async function makeVideo(job, log) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'psg-video-'));
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const v = job.sections.video;
      let videoUrl = job.url; // default: the homepage of THIS run's site
      if (v.url) {
        try {
          const resolved = new URL(v.url, job.url);
          if (/^https?:/i.test(v.url) && resolved.origin !== new URL(job.url).origin) {
            log(`Video: saved URL (${v.url}) belongs to a different site — using this site's homepage instead.`);
          } else {
            videoUrl = resolved.href;
          }
        } catch { log('Video: invalid saved URL — using the homepage.'); }
      }
      const { path: webm, trimStart } = await recordScrollVideo(videoUrl, work, log, { width: v.width, height: v.height, bg: v.bg });
      const mp4 = `${job.slug}-scroll.mp4`;
      const mp4Target = outputLocation(job, mp4);
      fs.mkdirSync(mp4Target.dir, { recursive: true });
      try {
        log('Video: converting to MP4 (trimming the loading phase)...');
        await ffmpegConvert(webm, path.join(mp4Target.dir, mp4), trimStart);
        const entry = { key: 'video', file: mp4, path: mp4Target.path, type: 'video' };
        const prev = job.images.find((i) => i.key === 'video');
        if (prev) Object.assign(prev, entry); else job.images.push(entry);
        log('Video: saved ' + mp4);
      } catch (e) {
        // graceful fallback: deliver the webm rather than nothing
        log(`Video: MP4 conversion unavailable (${e.message.split('\n')[0]}) — saving WebM instead`);
        const webmName = `${job.slug}-scroll.webm`;
        const webmTarget = outputLocation(job, webmName);
        fs.mkdirSync(webmTarget.dir, { recursive: true });
        fs.copyFileSync(webm, path.join(webmTarget.dir, webmName));
        const entry = { key: 'video', file: webmName, path: webmTarget.path, type: 'video' };
        const prev = job.images.find((i) => i.key === 'video');
        if (prev) Object.assign(prev, entry); else job.images.push(entry);
      }
      return;
    } catch (e) {
      log(`Video: attempt ${attempt} failed (${e.message.split('\n')[0]})${attempt === 1 ? ' — retrying...' : ''}`);
    }
  }
  log('Video: could not record after 2 attempts — skipped.');
}

// ---- per-section composition (also used by "Regenerate all")
async function composeSectionOne(job, name, log, rng) {
  const pools = mergedPools(job.caps);
  const first = job.caps[0];
  const brand = first.meta.brandColor;
  job.variantByKey = job.variantByKey || {};
  const save = (key, svg) => { qcCheck(key, svg, log); writeImage(job, key, svg); };

  if (name === 'logo') {
    log('Composing logo set...');
    const set = await composeLogoSet({
      logo: first.logo, mark: first.mark, brandColor: brand,
      logoIsLight: first.meta.logoIsLight, altBg: job.logoAlt,
      bg: effBg(job, job.sections.logo), assets: job.sections.logo.assets,
    });
    for (const [key, svg] of Object.entries(set)) save(key, svg);
  } else if (name === 'display') {
    log('Composing display images (hero + featured)...');
    const set = await composeFeaturedSet({
      heroTall: pools.heroTall, hero: pools.hero, brandColor: brand,
      bg: effBg(job, job.sections.display), rng, radius: effRad(job, job.sections.display),
    });
    save('hero', set.hero);
    save('featured', set.featured);
  } else if (name === 'mockups') {
    log('Composing device mockups...');
    const mp = filterPools(pools, job.sections.mockups.pages);
    const set = await composeMockupSet({
      ...mp, brandColor: brand, bg: effBg(job, job.sections.mockups), rng,
      count: job.sections.mockups.count, devices: job.sections.mockups.devices,
    });
    set.forEach((m, i) => {
      log(`  mockup-${i + 1}: ${m.variant}`);
      job.variantByKey[`mockup-${i + 1}`] = m.variant;
      save(`mockup-${i + 1}`, m.svg);
    });
  } else if (name === 'showcase') {
    log('Composing showcases...');
    const sp = filterPools(pools, job.sections.showcase.pages);
    const set = await composeShowcaseSet({
      ...sp, bg: effBg(job, job.sections.showcase), rng,
      count: job.sections.showcase.count, devices: job.sections.showcase.devices,
      radius: effRad(job, job.sections.showcase),
    });
    set.forEach((m, i) => {
      log(`  showcase-${i + 1}: ${m.variant}`);
      job.variantByKey[`showcase-${i + 1}`] = m.variant;
      save(`showcase-${i + 1}`, m.svg);
    });
  } else if (name === 'screenshots') {
    const sec = job.sections.screenshots;
    const urls = (sec.urls.length ? sec.urls : ['/']).map((u) => { try { return new URL(u, job.url).href; } catch { return null; } }).filter(Boolean);
    log('Capturing simple screenshots...');
    const shots = await captureShots(urls, { width: sec.width, height: sec.height, viewport: sec.viewport, full: sec.full }, log);
    job.shotEntries = shots.map((e) => ({ url: e.url }));
    let i = 0;
    for (const shot of shots) {
      i++;
      const boxed = sec.frame === 'plain' ? false : sec.frame === 'boxed' ? true : rng() < 0.5;
      const o = { boxed, bg: effBg(job, sec), brandColor: brand, rng, radius: effRad(job, sec) };
      if (shot.viewport) save(`shot-${i}`, await composeShotImage(shot.viewport, o));
      if (shot.full) save(`shot-${i}-full`, await composeShotImage(shot.full, { ...o, boxed: false }));
    }
  } else if (name === 'showcaseVideo') {
    for (let i = 1; i <= job.sections.showcaseVideo.count; i++) await makeAnimatedShowcase(job, log, rng, i);
  } else if (name === 'video') {
    await makeVideo(job, log);
  }
}

// ---- animated showcase: same composition engine, HTML+CSS motion, MP4 out
async function makeAnimatedShowcase(job, log, rng, idx = 1) {
  const sec = job.sections.showcaseVideo;
  const pools = filterPools(mergedPools(job.caps), sec.pages);
  // multi-frame layouts only — a solo card doesn't make a showcase video
  const MULTI = ['trio', 'quad', 'trio-angled', 'quad-angled', 'dense-4', 'dense-5', 'dense-4-angled', 'dense-5-angled'];
  const variant = MULTI[Math.floor(rng() * MULTI.length)];
  log(`Composing showcase video ${idx} (${variant})...`);
  const { layout } = await composeScreensImage(variant, {
    ...pools, bg: effBg(job, sec) || undefined, rng,
    devices: sec.devices, radius: effRad(job, sec), wantLayout: true,
  });
  if (!layout.items.length) { log('Showcase video: no content — skipped.'); return; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'psg-anim-'));
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const styleName = ANIM_STYLES[Math.floor(rng() * ANIM_STYLES.length)];
      const { path: webm, trimStart, style } = await recordAnimatedShowcase(layout, work, log, { style: styleName });
      const key = `showcase-video-${idx}`;
      const mp4 = `${job.slug}-${key}.mp4`;
      const mp4Target = outputLocation(job, mp4);
      fs.mkdirSync(mp4Target.dir, { recursive: true });
      try {
        log('Animation: converting to MP4...');
        await ffmpegConvert(webm, path.join(mp4Target.dir, mp4), trimStart);
        const entry = { key, file: mp4, path: mp4Target.path, type: 'video' };
        const prev = job.images.find((i) => i.key === key);
        if (prev) Object.assign(prev, entry); else job.images.push(entry);
        job.variantByKey[key] = `${variant}/${style}`;
        log(`Animation: saved ${mp4} (${style})`);
      } catch (e) {
        log(`Animation: MP4 conversion unavailable (${e.message.split('\n')[0]}) — saving WebM`);
        const w = `${job.slug}-${key}.webm`;
        const webmTarget = outputLocation(job, w);
        fs.mkdirSync(webmTarget.dir, { recursive: true });
        fs.copyFileSync(webm, path.join(webmTarget.dir, w));
        const entry = { key, file: w, path: webmTarget.path, type: 'video' };
        const prev = job.images.find((i) => i.key === key);
        if (prev) Object.assign(prev, entry); else job.images.push(entry);
      }
      return;
    } catch (e) {
      log(`Animation: attempt ${attempt} failed (${e.message.split('\n')[0]})${attempt === 1 ? ' — retrying...' : ''}`);
    }
  }
  log('Animation: could not record — skipped.');
}

// ------------------------------------------------------------- settings

app.get('/api/settings', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); }
  catch { res.json({}); }
});
app.post('/api/settings', (req, res) => {
  let current = {};
  try { current = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...current, ...(req.body || {}) }, null, 2));
  res.json({ ok: true });
});

// ------------------------------------------------------------- generate

app.post('/api/generate', (req, res) => {
  let { urls, url, pages, seed, frames, sections, style, source } = req.body || {};
  const urlList = (typeof urls === 'string' ? urls.split(/\n/) : Array.isArray(urls) ? urls : [url])
    .map((u) => (u || '').trim()).filter(Boolean)
    .map((u) => (/^https?:\/\//i.test(u) ? u : 'https://' + u))
    .filter((u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } })
    .slice(0, 8);
  if (!urlList.length) return res.status(400).json({ error: 'At least one URL is required' });

  const id = String(++jobSeq);
  const sec = parseSections(sections);
  const globalPages = typeof pages === 'string' ? pages.split(/[\n,]/).map((s) => s.trim()).filter(Boolean) : [];
  const sourceType = source && source.type === 'archive' ? 'archive' : 'url';
  const sourceName = sourceType === 'archive'
    ? String(source && source.name || '').replace(/[^a-z0-9 _-]/gi, '').trim().slice(0, 80)
    : urlList.join(', ');
  const job = {
    status: 'queued', log: ['Queued — waiting for the capture engine…'], images: [],
    slug: siteName(urlList[0]) + (urlList.length > 1 ? '-mix' : ''),
    urls: urlList, url: urlList[0],
    sections: sec,
    style: parseStyle(style),
    crawl: globalPages.length ? globalPages : [...new Set([...sec.mockups.pages, ...sec.showcase.pages])],
    needTablet: (sec.mockups.on && sec.mockups.devices.tablet) || (sec.showcase.on && sec.showcase.devices.tablet),
    opts: { viewports: frames || {} },
    logoAlt: false,
    source: { type: sourceType, name: sourceName || (sourceType === 'archive' ? 'Archived website' : urlList[0]) },
  };
  if (sourceType === 'archive' && sourceName) job.slug = sourceName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || job.slug;
  jobs.set(id, job);
  const log = (m) => { job.log.push(m); console.log(`[job ${id}] ${m}`); };

  enqueue(async () => {
    job.status = 'running';
    job.log.length = 0;
    try {
      setPatience(job.style.patience);
      setOverlayCleanup(job.style.overlays);
      setExtraWait(job.style.extraWait);
      setStitchMode(job.style.stitch);
      log(`Capture patience: ${job.style.patience}${job.style.extraWait ? ` (+${job.style.extraWait}s extra wait per page)` : ''} · overlays ${job.style.overlays ? 'hidden' : 'KEPT as-is'} · stitch ${job.style.stitch}`);
      await freshCrawl(job, log);
      job.seed = parseSeed(seed);
      log(`Layout seed: ${job.seed} (re-use it to reproduce this exact arrangement)`);
      const rng = mulberry32(job.seed);
      for (const name of ['logo', 'display', 'mockups', 'showcase', 'showcaseVideo', 'screenshots', 'video']) {
        if (job.sections[name].on) await composeSectionOne(job, name, log, rng);
      }
      job.meta = {
        title: job.caps[0].meta.title,
        siteName: job.caps[0].meta.siteName,
        quality: job.caps[0].meta.quality,
      };
      job.displayName = siteDisplayName(job.meta, job.slug);
      job.favicon = await markPreview(job.caps[0].mark);
      job.status = 'done';
      log(`Done. ${job.images.length} files in ${path.join(OUT_DIR, job.slug)}`);
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      log(`ERROR: ${e.message}`);
    }
  });

  res.json({ jobId: id });
});

// ------------------------------------------------------------- regenerate

// Regeneration reuses the verified capture pool for layout-only outputs, which
// makes a new arrangement fast. Outputs whose content itself changes (hero,
// screenshots, and scroll video) still perform a fresh capture.
app.post('/api/regenerate', (req, res) => {
  const { jobId, image } = req.body || {};
  const job = jobs.get(String(jobId));
  if (!job || !job.caps) return res.status(404).json({ error: 'This run is no longer in memory — generate the site again first.' });
  if (job.status === 'running' || job.status === 'queued') return res.status(409).json({ error: 'A job is already running — wait for it to finish.' });

  job.status = 'queued';
  const log = (m) => { job.log.push(m); console.log(`[job ${jobId}] ${m}`); };
  log(`— Regenerating ${image} —`);

  enqueue(async () => {
    job.status = 'running';
    setPatience(job.style.patience);
    setOverlayCleanup(job.style.overlays);
    setExtraWait(job.style.extraWait);
    setStitchMode(job.style.stitch);
    const vps = job.opts.viewports;
    const regenSeed = Math.floor(Math.random() * 1e9);
    const rng = mulberry32(regenSeed);
    log(`Regeneration seed: ${regenSeed}`);
    const save = (key, svg) => { qcCheck(key, svg, log); writeImage(job, key, svg); };
    try {
      const first = () => job.caps[0];
      const brand = () => first().meta.brandColor;

      if (image === 'logo' || image === 'wordmark' || image === 'all-logo') {
        job.logoAlt = !job.logoAlt;
        log(`Logo: trying ${job.logoAlt ? 'alternate' : 'original'} background...`);
        const set = await composeLogoSet({
          logo: first().logo, mark: first().mark, brandColor: brand(),
          logoIsLight: first().meta.logoIsLight, altBg: job.logoAlt,
          bg: effBg(job, job.sections.logo), assets: 'both',
        });
        if (image === 'all-logo') { for (const [k, v] of Object.entries(set)) save(k, v); }
        else if (set[image]) save(image, set[image]);
      } else if (image === 'featured' || image === 'hero' || image === 'all-display') {
        log('Re-capturing the hero fresh...');
        const { hero, heroTall } = await captureHero(job.url, log, vps);
        first().screenshots.hero = hero;
        first().screenshots.heroTall = heroTall;
        const set = await composeFeaturedSet({ heroTall, hero, brandColor: brand(), bg: effBg(job, job.sections.display), rng, radius: effRad(job, job.sections.display) });
        if (image === 'all-display' || image === 'hero') save('hero', set.hero);
        if (image === 'all-display' || image === 'featured') save('featured', set.featured);
      } else if (image === 'video' || image === 'all-video') {
        await makeVideo(job, log);
      } else if (image.startsWith('showcase-video-') || image === 'all-showcasevideo') {
        if (image === 'all-showcasevideo') {
          for (let i = 1; i <= job.sections.showcaseVideo.count; i++) await makeAnimatedShowcase(job, log, rng, i);
        } else {
          await makeAnimatedShowcase(job, log, rng, parseInt(image.split('-').pop(), 10) || 1);
        }
      } else if (image.startsWith('shot-') || image === 'all-screenshots') {
        await composeSectionOne(job, 'screenshots', log, rng); // fresh capture of the configured URLs
      } else if (image === 'all-mockups' || image === 'all-showcase') {
        await composeSectionOne(job, image.replace('all-', ''), log, rng);
      } else if (image.startsWith('mockup-') || image.startsWith('showcase-')) {
        const pools = mergedPools(job.caps);
        const current = (job.variantByKey && job.variantByKey[image]) || '';
        if (image.startsWith('mockup-')) {
          const sec = job.sections.mockups;
          const set = await composeMockupSet({
            ...filterPools(pools, sec.pages), brandColor: brand(), bg: effBg(job, sec), rng,
            count: 1, devices: sec.devices, exclude: current ? [current] : [],
          });
          if (set.length) {
            log(`New arrangement: ${set[0].variant}`);
            job.variantByKey[image] = set[0].variant;
            save(image, set[0].svg);
          }
        } else {
          const sec = job.sections.showcase;
          const family = current.startsWith('dense') ? 'dense' : 'light';
          const set = await composeShowcaseSet({
            ...filterPools(pools, sec.pages), bg: effBg(job, sec), rng, count: 1,
            devices: sec.devices, radius: effRad(job, sec), exclude: current ? [current] : [], family,
          });
          if (set.length) {
            log(`New arrangement: ${set[0].variant} (${family})`);
            job.variantByKey[image] = set[0].variant;
            save(image, set[0].svg);
          }
        }
      } else {
        throw new Error(`unknown image "${image}"`);
      }
      job.status = 'done';
      log(`Regenerated ${image}.`);
    } catch (e) {
      job.status = 'done';
      log(`Regenerate failed: ${e.message.split('\n')[0]}`);
    }
  });

  res.json({ ok: true });
});

// convert a generated MP4 to GIF on demand (960px wide, 12fps, palette)
app.post('/api/togif', async (req, res) => {
  try {
    const rel = String((req.body || {}).path || '');
    if (!rel.startsWith('output/') || rel.includes('..')) return res.status(400).json({ error: 'bad path' });
    const src = path.join(OUT_DIR, rel.replace(/^output\//, ''));
    if (!fs.existsSync(src) || !FFMPEG) return res.status(404).json({ error: 'source or ffmpeg missing' });
    const base = path.basename(src).replace(/\.(mp4|webm)$/, '.gif');
    const siteDir = path.dirname(path.dirname(src));
    const gif = path.join(siteDir, 'GIF', base);
    fs.mkdirSync(path.dirname(gif), { recursive: true });
    if (!fs.existsSync(gif)) {
      await new Promise((resolve, reject) => {
        const pr = spawn(FFMPEG, ['-y', '-i', src, '-vf', 'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse', gif]);
        pr.on('close', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg gif failed'))));
        pr.on('error', reject);
      });
    }
    const siteSlug = rel.replace(/^output\//, '').split('/')[0];
    res.json({ path: `output/${siteSlug}/GIF/${base}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const { caps, ...publicJob } = job;
  res.json({ ...publicJob, canRegenerate: !!caps });
});

const PORT = process.env.PORT || 3311;
const HOST = process.env.HOST || '127.0.0.1';
const openBrowser = (url) => {
  if (process.env.NO_OPEN) return;
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
};

function startServer({ port = PORT, host = HOST, shouldOpen = !process.env.NO_OPEN } = {}) {
  const server = app.listen(port, host, () => {
  const address = server.address();
  if (!address) return;
  const actualPort = address.port;
  const url = `http://localhost:${actualPort}`;
  console.log(`
  ┌─────────────────────────────────────────────────────┐
  │   Portfolio Generator is running                    │
  │                                                     │
  │   1. Your browser should open automatically.        │
  │      If not, open:  ${url}              │
  │   2. Paste a website URL and click Generate.        │
  │   3. Watch progress in the sidebar; results         │
  │      appear on the right when done.                 │
  │                                                     │
  │   Press Ctrl+C here to stop.                        │
  └─────────────────────────────────────────────────────┘
`);
  if (shouldOpen) openBrowser(url);
});

server.on('close', () => importStore.close());

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    const url = `http://localhost:${port}`;
    console.log(`
  The app is already running in another window.
  Opening ${url} in your browser now — use that one,
  or close the other Terminal window first and try again.
`);
    openBrowser(url);
    process.exit(0);
  }
  throw e;
  });
  return server;
}

if (require.main === module) startServer();

module.exports = { app, startServer, siteName, siteDisplayName, parseSections, parseStyle, parseSeed, qcCheck, outputLocation, ffmpegArgs };
