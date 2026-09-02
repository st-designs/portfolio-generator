/**
 * capture.js — Playwright capture pipeline.
 * Renders at a 1440px frame, extracts logo + brand colors, takes
 * hero / full-page / section / mobile screenshots.
 */
const fs = require('fs');
const path = require('path');

// `npm run setup` installs Chromium beside playwright-core so release builds
// can bundle it. Use that same copy in the local web/CLI launchers instead of
// falling back to an unrelated per-user Playwright cache. Electron release
// builds set an explicit unpacked path before this module loads.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const localBrowsers = path.join(path.dirname(require.resolve('playwright-core')), '.local-browsers');
  if (fs.existsSync(localBrowsers)) process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsers;
}

const { chromium } = require('playwright');
const sharp = require('sharp');
const { analyzeCapture, chooseBestCapture } = require('./quality');

const DESKTOP = { width: 1440, height: 810 }; // 16:9 hero frame (default)
const MOBILE = { width: 390, height: 844 };   // default mobile frame
const SCALE = 2; // retina rendering

const TABLET = { width: 834, height: 1112 }; // default tablet frame (iPad-ish)

// ---------------------------------------------------------------- patience
// One knob controls every wait budget. "thorough" trades minutes for
// certainty on heavy, animation-rich sites.
const PATIENCE = {
  fast: { netIdle: 4000, scrollPause: 80, settlePause: 250, shotGap: 600, stabilityRounds: 1, imgWait: 2500 },
  normal: { netIdle: 12000, scrollPause: 130, settlePause: 450, shotGap: 1000, stabilityRounds: 2, imgWait: 4000 },
  thorough: { netIdle: 22000, scrollPause: 230, settlePause: 900, shotGap: 1800, stabilityRounds: 3, imgWait: 8000 },
};
let P = PATIENCE.normal;
let CLEAN_OVERLAYS = true;
let EXTRA_WAIT = 0; // flat additional seconds per page, user-controlled
let STITCH_MODE = 'auto'; // auto | always | off
function setPatience(name) { P = PATIENCE[name] || PATIENCE.normal; }
function setOverlayCleanup(b) { CLEAN_OVERLAYS = b !== false; }
function setExtraWait(sec) { const n = parseFloat(sec); EXTRA_WAIT = Number.isFinite(n) ? Math.max(0, Math.min(30, n)) : 0; }
function setStitchMode(m) { STITCH_MODE = ['auto', 'always', 'off'].includes(m) ? m : 'auto'; }

// mean absolute pixel difference between two shots (0-255 scale), computed
// on small grayscale thumbnails — cheap and robust
async function shotDiff(a, b) {
  try {
    const norm = (buf) => sharp(buf).resize(64, 64, { fit: 'fill' }).grayscale().raw().toBuffer();
    const [da, db] = await Promise.all([norm(a), norm(b)]);
    let sum = 0;
    for (let i = 0; i < da.length; i++) sum += Math.abs(da[i] - db[i]);
    return sum / da.length;
  } catch { return 0; }
}

// take a shot, wait, take another — only accept once consecutive shots match
// (catches carousels mid-swap, fading content, late-loading media)
async function stableShot(page, shotFn, log = () => {}) {
  let prev = await shotFn();
  const candidates = [{ label: 'initial', buffer: prev, quality: await analyzeCapture(prev, { viewportHeight: page.viewportSize().height }) }];
  for (let i = 0; i < P.stabilityRounds; i++) {
    await page.waitForTimeout(P.shotGap);
    const next = await shotFn();
    candidates.push({ label: `settled-${i + 1}`, buffer: next, quality: await analyzeCapture(next, { viewportHeight: page.viewportSize().height }) });
    const d = await shotDiff(prev, next);
    if (d < 1.6) return chooseBestCapture(candidates).buffer;
    log(`  stability check: view still changing (Δ${d.toFixed(1)}) — waiting...`);
    prev = next;
  }
  return chooseBestCapture(candidates).buffer;
}

// normalize user-supplied viewport overrides (falls back to defaults)
function viewportsFrom(v = {}) {
  const num = (x, d) => { const n = parseInt(x, 10); return n >= 320 && n <= 3840 ? n : d; };
  return {
    desktop: { width: num(v.desktopWidth, DESKTOP.width), height: num(v.desktopHeight, DESKTOP.height) },
    tablet: { width: num(v.tabletWidth, TABLET.width), height: num(v.tabletHeight, TABLET.height) },
    mobile: { width: num(v.mobileWidth, MOBILE.width), height: num(v.mobileHeight, MOBILE.height) },
  };
}

const UA_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const UA_TABLET = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// Prefer Playwright's Chromium. Launching another installed application can
// trigger macOS App Management prompts, and Portfolio Generator does not need
// permission to manage other apps. Installed-browser fallback is kept on
// Windows only; macOS should never need App Management access.
async function launchBrowser(log = () => {}) {
  const launchArgs = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  try {
    const b = await chromium.launch(launchArgs);
    log('Using Portfolio Generator capture browser');
    return b;
  } catch {}
  const channels = process.platform === 'win32'
    ? [['chrome', 'Google Chrome'], ['msedge', 'Microsoft Edge']]
    : [];
  for (const [channel, label] of channels) {
    try {
      const b = await chromium.launch({ ...launchArgs, channel });
      log(`Using installed ${label}`);
      return b;
    } catch {}
  }
  throw new Error('No supported capture browser was found. Run the app setup to install its capture browser, then try again.');
}

const desktopCtx = (vp = DESKTOP) => ({ viewport: vp, deviceScaleFactor: SCALE, userAgent: UA_DESKTOP });
const mobileCtx = (vp = MOBILE) => ({ viewport: vp, deviceScaleFactor: SCALE, isMobile: true, hasTouch: true, userAgent: UA_MOBILE });
const tabletCtx = (vp = TABLET) => ({ viewport: vp, deviceScaleFactor: SCALE, isMobile: true, hasTouch: true, userAgent: UA_TABLET });

// open a page, settle it, run fn, tear everything down
async function withPage(url, fn, { mobile = false, log = () => {}, viewports } = {}) {
  const VP = viewportsFrom(viewports);
  const browser = await launchBrowser(log);
  try {
    const ctx = await browser.newContext(mobile ? mobileCtx(VP.mobile) : desktopCtx(VP.desktop));
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await settle(page, log);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

// full-page screenshot. scale:'css' keeps 1 CSS px = 1 image px: stays under
// Chromium's 16384px texture limit and avoids tile-memory artifacts.
async function fullPageShot(p) {
  const vp = p.viewportSize();
  const docH = await p.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
  if (docH <= 15000) {
    try { return await p.screenshot({ type: 'png', fullPage: true, scale: 'css' }); } catch {}
  }
  return p.screenshot({ type: 'png', scale: 'css', clip: { x: 0, y: 0, width: vp.width, height: Math.min(docH, 15000) } });
}

// Scroll-and-stitch full-page capture: scrolls viewport by viewport and
// composites the tiles. Each section is captured in its NATURAL scroll state,
// which is the only correct way to shoot sites whose layout is driven by the
// scroll position (GSAP ScrollTrigger pinning, Locomotive, parallax).
// Fixed and top-sticky elements are hidden after the first tile so headers and
// navigation appear exactly once in the finished image.
async function fullPageShotStitched(p, log = () => {}) {
  const vp = p.viewportSize();
  const docH = await p.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
  const H = Math.min(docH, 15000);
  const W = vp.width;
  log(`  stitched capture: ${Math.ceil(H / vp.height)} tiles...`);
  const comps = [];
  let first = true;
  try {
    for (let y = 0; y < H; y += vp.height) {
      await p.evaluate((yy) => window.scrollTo(0, yy), y);
      await p.waitForTimeout(Math.max(280, P.settlePause));
      if (CLEAN_OVERLAYS) await hideFloaters(p, { loop: true });
      await fixVideos(p);
      const shot = await p.screenshot({ type: 'png', scale: 'css' });
      const maxScroll = Math.max(0, docH - vp.height);
      const actualY = Math.min(y, maxScroll);
      const cropTop = y - actualY;
      const tileH = Math.min(vp.height - cropTop, H - y);
      if (tileH <= 0) break;
      const img = (cropTop > 0 || tileH < vp.height)
        ? await sharp(shot).extract({ left: 0, top: cropTop, width: W, height: tileH }).toBuffer()
        : shot;
      comps.push({ input: img, left: 0, top: y });
      if (first) {
        first = false;
        // Hide repeated viewport chrome for subsequent tiles. Preserve the
        // complete inline style so the live page is restored exactly.
        await p.evaluate(() => {
          for (const el of document.querySelectorAll('body *')) {
            const cs = getComputedStyle(el);
            const box = el.getBoundingClientRect();
            const fixed = cs.position === 'fixed';
            const topSticky = cs.position === 'sticky' && box.top <= 24 && box.bottom > 0;
            const viewportChrome = (fixed || topSticky) && box.height < innerHeight * 0.45 && box.width > 20;
            if (viewportChrome && cs.visibility !== 'hidden' && cs.display !== 'none') {
              el.setAttribute('data-psg-fh', '1');
              const inlineStyle = el.getAttribute('style');
              if (inlineStyle === null) el.setAttribute('data-psg-fh-no-style', '1');
              else el.setAttribute('data-psg-fh-style', inlineStyle);
              el.style.setProperty('visibility', 'hidden', 'important');
            }
          }
        }).catch(() => {});
      }
    }
  } finally {
    await p.evaluate(() => {
      document.querySelectorAll('[data-psg-fh]').forEach((el) => {
        if (el.hasAttribute('data-psg-fh-no-style')) el.removeAttribute('style');
        else el.setAttribute('style', el.getAttribute('data-psg-fh-style') || '');
        el.removeAttribute('data-psg-fh');
        el.removeAttribute('data-psg-fh-style');
        el.removeAttribute('data-psg-fh-no-style');
      });
      window.scrollTo(0, 0);
    }).catch(() => {});
  }
  return sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
    .composite(comps).png().toBuffer();
}

// does this page position content based on scroll? (single-pass fullPage
// screenshots are unreliable on these — stitch instead)
async function usesScrollLinkedLayout(p) {
  return p.evaluate(() => !!(
    (window.gsap && window.ScrollTrigger) ||
    document.querySelector('.pin-spacer, [data-scroll-container], [data-locomotive], .locomotive-scroll, [data-luxy], #luxy')
  )).catch(() => false);
}

// full-page shot with visual-completeness validation: on a suspicious blank
// band it re-scrolls and waits, then reloads the page entirely — never
// silently returns a half-rendered capture without saying so.
async function fullPageShotChecked(p, log = () => {}, url) {
  await refreshCaptureSurface(p, { loop: true });
  const vpH = p.viewportSize().height;
  const candidates = [];
  const addCandidate = async (label, buffer) => {
    const quality = await analyzeCapture(buffer, { viewportHeight: vpH });
    candidates.push({ label, buffer, quality });
    log(`  image check (${label}): ${quality.score.toFixed(1)}/100${quality.usable ? '' : ` — ${quality.issues.join('; ')}`}`);
    return quality;
  };
  const finish = () => {
    const best = chooseBestCapture(candidates);
    if (!best) throw new Error('No screenshot candidate was produced');
    if (candidates.length > 1) log(`  selected ${best.label} capture (${best.quality.score.toFixed(1)}/100)`);
    return best.buffer;
  };
  if (STITCH_MODE === 'always') {
    log('  stitched capture (forced by setting)');
    await addCandidate('stitched', await fullPageShotStitched(p, log));
    return finish();
  }
  // scroll-linked layouts (GSAP pinning, Locomotive, parallax) can't be
  // captured in one pass — go straight to scroll-and-stitch
  if (STITCH_MODE === 'auto' && await usesScrollLinkedLayout(p)) {
    log('  scroll-linked layout detected — using stitched capture');
    await addCandidate('stitched', await fullPageShotStitched(p, log));
    return finish();
  }
  let buf = await stableShot(p, () => fullPageShot(p), log);
  let quality = await addCandidate('stable', buf);
  if (quality.usable) return finish();

  log('  completeness check: re-scrolling to recover missing content...');
  await autoScroll(p);
  await stabilize(p);
  await refreshCaptureSurface(p, { loop: true });
  await p.waitForTimeout(1200);
  buf = await fullPageShot(p);
  quality = await addCandidate('rescrolled', buf);
  if (quality.usable) return finish();

  // second fallback: stitched capture (correct even when sections only render in view)
  if (STITCH_MODE !== 'off') {
    log('  completeness check: still incomplete — switching to stitched capture...');
    buf = await fullPageShotStitched(p, log);
    quality = await addCandidate('stitched', buf);
    if (quality.usable) return finish();
  }

  if (url) {
    log('  completeness check: still incomplete — reloading the page...');
    try {
      await p.reload({ waitUntil: 'domcontentloaded', timeout: 35000 });
      await settle(p, log);
      await refreshCaptureSurface(p, { loop: true });
      buf = await fullPageShot(p);
      await addCandidate('reloaded', buf);
    } catch {}
  }
  const best = chooseBestCapture(candidates);
  if (best && !best.quality.usable) log('  completeness check: no attempt passed every check; using the strongest available capture');
  return finish();
}

// ---------------------------------------------------------------- helpers

async function dismissOverlays(page) {
  // Layer 1: click consent "accept" / popup "close" buttons (best — the site
  // remembers the choice and won't re-show the popup on the next page).
  try {
    const clicked = await page.evaluate(() => {
      let n = 0;
      const click = (el) => { try { el.click(); n++; } catch {} };
      // known consent-framework buttons
      const known = [
        '#onetrust-accept-btn-handler', '.cc-btn.cc-allow', '.cc-accept', '.cc-dismiss',
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '.cky-btn-accept',
        '#cookie_action_close_header', '.cmplz-accept', '.borlabs-cookie-accept',
        '[data-cookiefirst-action="accept"]', '.fc-cta-consent', '.iubenda-cs-accept-btn',
        '#didomi-notice-agree-button', '.osano-cm-accept-all', '.truste-button1',
      ];
      for (const sel of known) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) click(el);
      }
      // text-based accept buttons (exact-ish match, short labels only)
      const accepts = ['accept all', 'accept all cookies', 'accept cookies', 'allow all', 'i accept', 'accept', 'agree', 'i agree', 'got it', 'ok', 'okay', 'understood', 'dismiss'];
      const els = [...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')];
      for (const el of els) {
        const t = (el.innerText || el.value || '').trim().toLowerCase();
        if (t && t.length < 30 && accepts.includes(t) && el.offsetParent !== null) click(el);
      }
      // close buttons inside modal-ish containers
      const modalish = document.querySelectorAll('[class*="modal" i], [class*="popup" i], [class*="lightbox" i], [class*="newsletter" i], [role="dialog"], [aria-modal="true"]');
      for (const m of modalish) {
        const r = m.getBoundingClientRect();
        if (r.width < 50 || r.height < 50) continue;
        const closer = m.querySelector('[aria-label*="close" i], [class*="close" i], [data-dismiss], button[title*="close" i]');
        if (closer && closer.offsetParent !== null) click(closer);
      }
      return n;
    });
    if (clicked) await page.waitForTimeout(700);
  } catch {}

  // Layer 2: hide what's left — modal dialogs, backdrops, chat widgets —
  // without touching real page content (sticky headers, parallax heroes).
  try {
    await page.evaluate(() => {
      const vw = innerWidth, vh = innerHeight;
      const hide = (el) => { el.style.setProperty('display', 'none', 'important'); };

      // known chat/support widgets (elements and iframes)
      const chatSel = [
        '#intercom-container', '.intercom-lightweight-app', '#hubspot-messages-iframe-container',
        '#tawkchat-container', '#tawk-bubble-container', 'iframe[title*="chat" i]', '.crisp-client',
        '#drift-frame-chat', '#drift-frame-controller', '.drift-frame-controller', '#tidio-chat',
        '#launcher[title*="chat" i]', 'iframe#launcher', '.zopim', '#fb-root .fb_dialog',
        '.gorgias-chat-key', '#chat-widget-container', '.livechat-widget', '[class*="chat-bubble" i]',
        '[id*="livechat" i]', '[class*="whatsapp" i][class*="float" i]', 'a[href*="wa.me"]',
        'iframe[src*="intercom" i]', 'iframe[src*="hubspot" i]', 'iframe[src*="drift" i]',
        'iframe[src*="crisp" i]', 'iframe[src*="tawk" i]', 'iframe[src*="tidio" i]',
        'iframe[src*="gorgias" i]', 'iframe[src*="zendesk" i]', 'iframe[name*="chat" i]',
      ];
      chatSel.forEach((s) => { try { document.querySelectorAll(s).forEach(hide); } catch {} });

      // generic fixed/sticky overlay detection
      for (const el of document.querySelectorAll('body *')) {
        if (!(el instanceof HTMLElement)) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const z = parseInt(cs.zIndex, 10) || 0;
        const area = (r.width * r.height) / (vw * vh);
        const cls = ((el.className || '') + ' ' + (el.id || '')).toString().toLowerCase();
        const isNavish = el.matches('header, nav, header *, nav *') || /\b(header|navbar|nav-|menu)\b/.test(cls);
        const modalName = /(modal|popup|pop-up|overlay|backdrop|lightbox|dialog|newsletter|subscribe|signup-modal|exit-intent|interstitial|cookie|consent|gdpr)/.test(cls)
          || el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true';

        // backdrop: covers (nearly) the whole screen
        if (area > 0.85 && z >= 10 && !isNavish) { hide(el); continue; }
        // centered dialog: mid-screen box with elevated z-index
        const centeredX = Math.abs((r.left + r.width / 2) - vw / 2) < vw * 0.2;
        const belowHeader = r.top > vh * 0.08;
        if (modalName && z >= 10 && (area > 0.03 || (r.width > 300 && r.height > 140))) { hide(el); continue; }
        if (z >= 100 && area > 0.25 && centeredX && belowHeader && !isNavish) { hide(el); continue; }
        // bottom cookie bars / slide-ins
        const atBottom = r.bottom > vh * 0.85 && r.height < vh * 0.45;
        if (atBottom && z >= 10 && /(cookie|consent|gdpr|privacy|banner|notice)/.test(cls)) { hide(el); continue; }
        // fixed newsletter and CTA bars that otherwise sit over the captured page
        const hasLeadControl = !!el.querySelector('form, input[type="email"], button, [role="button"]');
        if (atBottom && z >= 10 && hasLeadControl && /(newsletter|subscribe|signup|sign-up|cta|promo|sticky|floating|lead)/.test(cls)) { hide(el); continue; }
        // small corner bubbles (chat launchers)
        const inCorner = (r.left > vw * 0.75 || r.right < vw * 0.25) && r.top > vh * 0.6;
        if (inCorner && area < 0.06 && z >= 100 && !el.matches('header *, nav *')) { hide(el); continue; }
        // off-canvas menu drawers caught mid-state: a sliver hanging over the
        // left or right edge of the viewport
        const rightSliver = r.left > vw * 0.55 && r.right > vw + 10;
        const leftSliver = r.right < vw * 0.45 && r.left < -10;
        if ((rightSliver || leftSliver) && r.width > 40 && r.height > vh * 0.3 && z >= 10) { hide(el); continue; }
        // slide-in menus flagged by their own class names
        if (/(offcanvas|off-canvas|drawer|slide-menu|mobile-menu|menu-panel|side-nav|sidenav)/.test(cls)
          && cs.position === 'fixed' && z >= 10 && (r.left > vw * 0.5 || r.right < vw * 0.5)) { hide(el); continue; }
      }

      // release scroll locks that popups leave behind
      for (const el of [document.documentElement, document.body]) {
        const cs = getComputedStyle(el);
        if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') {
          el.style.setProperty('overflow', 'visible', 'important');
        }
      }
    });
  } catch {}
}

async function autoScroll(page) {
  // Trigger lazy-loading / scroll animations, then return to top
  try {
    await page.evaluate(async (pause) => {
      const step = window.innerHeight * 0.75;
      const max = Math.min(document.body.scrollHeight, 20000);
      for (let y = 0; y < max; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, pause));
      }
      window.scrollTo(0, 0);
    }, P.scrollPause);
    await page.waitForTimeout(Math.max(600, P.settlePause * 2));
  } catch {}
}

async function fixVideos(page) {
  // Headless Chromium lacks h264 — undecodable <video> renders as a black box.
  // Swap in the poster image (or hide the video) so screenshots stay clean.
  try {
    await page.evaluate(() => {
      document.querySelectorAll('video').forEach((v) => {
        if (v.readyState >= 2) return; // decodable, leave it
        const poster = v.getAttribute('poster');
        if (poster) {
          const img = document.createElement('img');
          img.src = poster;
          const r = v.getBoundingClientRect();
          img.style.cssText = `display:block;width:${r.width ? r.width + 'px' : '100%'};height:${r.height ? r.height + 'px' : '100%'};object-fit:cover;`;
          img.className = v.className;
          v.replaceWith(img);
        } else {
          v.style.visibility = 'hidden';
        }
      });
    });
    await page.waitForTimeout(400);
  } catch {}
}

async function stabilize(page) {
  // Snap the page to a clean, fully-loaded state before screenshotting:
  // no mid-transition carousels, no half-loaded images, no swapping fonts.
  try {
    await page.evaluate(async (IMG_WAIT) => {
      // wait for pending <img> elements
      const pending = [...document.images].filter((i) => !i.complete);
      await Promise.race([
        Promise.all(pending.map((i) => new Promise((r) => { i.onload = i.onerror = r; }))),
        new Promise((r) => setTimeout(r, IMG_WAIT)),
      ]);
      // wait for CSS background-images of visible elements (often missed)
      const bgUrls = new Set();
      for (const el of document.querySelectorAll('*')) {
        const bi = getComputedStyle(el).backgroundImage;
        const m = bi && bi.match(/url\(("|')?([^"')]+)/);
        if (m && el.getBoundingClientRect().width > 0) bgUrls.add(m[2]);
        if (bgUrls.size >= 60) break;
      }
      await Promise.race([
        Promise.all([...bgUrls].map((u) => new Promise((r) => { const im = new Image(); im.onload = im.onerror = r; im.src = u; }))),
        new Promise((r) => setTimeout(r, IMG_WAIT)),
      ]);
      try { await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2000))]); } catch {}
      // jump animations/transitions to their end state; pause infinite ones
      const snap = () => document.getAnimations().forEach((a) => {
        try { a.finish(); } catch { try { a.pause(); } catch {} }
      });
      snap();
      setTimeout(snap, 250); // catch chained animations kicked off by the first snap
    }, P.imgWait);
    await page.waitForTimeout(P.settlePause);
  } catch {}
}

// Visual completeness check: broken images, images still loading, and a
// document that is still growing all indicate an unfinished render. Retries
// the lazy-load pass once before giving up.
async function verifyRender(page, log = () => {}) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const check = await page.evaluate(() => {
      const imgs = [...document.images].filter((i) => i.getBoundingClientRect().width > 40);
      const visible = (el) => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return box.width > 40 && box.height > 12 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const skeletons = [...document.querySelectorAll('[class*="skeleton" i], [class*="shimmer" i], [aria-busy="true"], [data-loading="true"]')].filter(visible).length;
      return {
        broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
        pending: imgs.filter((i) => !i.complete).length,
        skeletons,
        h: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      };
    }).catch(() => null);
    if (!check) return last;
    await page.waitForTimeout(700);
    const h2 = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)).catch(() => check.h);
    const stable = Math.abs(h2 - check.h) < 8;
    last = { ...check, heightStable: stable };
    if (stable && check.pending === 0 && check.skeletons === 0) {
      if (check.broken > 0) log(`  render check: ${check.broken} broken image(s) — that's the site itself, not the capture`);
      return last;
    }
    const reasons = [check.pending && `${check.pending} loading image(s)`, check.skeletons && `${check.skeletons} loading placeholder(s)`, !stable && 'page height still changing'].filter(Boolean);
    log(`  render check: ${reasons.join(', ')} — giving it another pass...`);
    await autoScroll(page);
    await stabilize(page);
  }
  log('  render check: page kept changing; capturing current state');
  return last;
}

// Hide late-appearing floating UI (back-to-top arrows, cookie banners) —
// as a guarded JS pass, NEVER blanket CSS: substring selectors like
// [class*="scroll-top"] can match a site's body/main wrapper and blank the
// whole page. Every candidate must be a small-enough FIXED element.
// `loop: true` installs an interval so elements appearing mid-scroll (videos)
// are caught too.
function hideFloatersInPage(loop) {
  const TOTOP = '[class*="back-to-top" i],[class*="backtotop" i],[class*="back_to_top" i],[class*="scroll-top" i],[class*="scrolltop" i],[class*="scroll-to-top" i],[id*="back-to-top" i],[id*="backtotop" i],[id*="scrolltop" i],[aria-label*="back to top" i],[aria-label*="scroll to top" i]';
  const COOKIE = '[class*="cookie-banner" i],[class*="cookie-consent" i],[class*="cookie-notice" i],[class*="cookieconsent" i],[id*="cookie-banner" i],[id*="cookie-consent" i],[id*="cookie-notice" i],[class*="cookie-bar" i],[id*="cookiebar" i]';
  const FLOATING = '[class*="chat-bubble" i],[class*="chat-widget" i],[class*="chat-launcher" i],[class*="help-bubble" i],[class*="support-widget" i],[class*="whatsapp" i],[class*="newsletter" i],[class*="subscribe" i],[class*="exit-intent" i],[id*="chat-widget" i],[id*="chat-launcher" i],a[href*="wa.me"],iframe[title*="chat" i],iframe[name*="chat" i],iframe[src*="intercom" i],iframe[src*="hubspot" i],iframe[src*="drift" i],iframe[src*="crisp" i],iframe[src*="tawk" i],iframe[src*="tidio" i],iframe[src*="gorgias" i],iframe[src*="zendesk" i]';
  const pass = () => {
    const vw = innerWidth, vh = innerHeight;
    const guard = (el, maxW, maxH) => {
      if (!(el instanceof HTMLElement)) return false;
      if (el === document.body || el === document.documentElement) return false;
      if (el.matches('main, main *, article, article *')) return false;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') return false;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      return r.width <= vw * maxW && r.height <= vh * maxH;
    };
    document.querySelectorAll(TOTOP).forEach((el) => {
      if (guard(el, 0.4, 0.3)) el.style.setProperty('display', 'none', 'important');
    });
    document.querySelectorAll(COOKIE).forEach((el) => {
      if (guard(el, 1.01, 0.5)) el.style.setProperty('display', 'none', 'important');
    });
    document.querySelectorAll(FLOATING).forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const parentFixed = [...el.parentElement ? [el.parentElement] : []].some((p) => ['fixed', 'sticky'].includes(getComputedStyle(p).position));
      if (el.matches('iframe') || cs.position === 'fixed' || cs.position === 'sticky' || parentFixed) {
        if (r.width <= vw * 1.01 && r.height <= vh * 0.65) el.style.setProperty('display', 'none', 'important');
      }
    });
    for (const el of document.querySelectorAll('body *')) {
      if (!(el instanceof HTMLElement) || el.matches('header, header *, nav, nav *')) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const z = parseInt(cs.zIndex, 10) || 0;
      const words = [el.id, el.className, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('href')].join(' ').toLowerCase();
      const corner = (r.left > vw * 0.7 || r.right < vw * 0.3) && r.top > vh * 0.52;
      const semanticFloater = /(chat|support|help|whatsapp|messenger|contact|launcher|bubble|newsletter|subscribe|exit.intent)/.test(words);
      if (semanticFloater && corner && z >= 5 && r.width < vw * 0.38 && r.height < vh * 0.45) {
        el.style.setProperty('display', 'none', 'important');
      }
    }
  };
  pass();
  if (loop && !window.__psgFloaterLoop) window.__psgFloaterLoop = setInterval(pass, 300);
}

async function hideFloaters(page, { loop = false } = {}) {
  try { await page.evaluate(hideFloatersInPage, loop); } catch {}
}

async function refreshCaptureSurface(page, { loop = false } = {}) {
  if (CLEAN_OVERLAYS) {
    await dismissOverlays(page);
    await hideFloaters(page, { loop });
    try { await page.keyboard.press('Escape'); } catch {}
  }
  await fixVideos(page);
}

// Scroll-triggered entrance animations (AOS, WOW, Elementor, GSAP reveal
// patterns) keep sections invisible until they animate into view. If our
// scroll pass moves past them too quickly — or the trigger never fires — the
// full-page capture shows blank/missing sections. Force everything visible.
async function forceRevealHidden(page) {
  try {
    // known animation-library initial states
    await page.addStyleTag({
      content: `
[data-aos] { opacity: 1 !important; transform: none !important; }
.aos-init:not(.aos-animate), .wow:not(.animated), .elementor-invisible,
[data-sr-id], .sal-animate, [data-sal]:not(.sal-animate)
{ visibility: visible !important; opacity: 1 !important; transform: none !important; animation: none !important; }
* { content-visibility: visible !important; }`,
    });
    // generic sweep: sizeable in-flow content stuck at opacity 0 or hidden
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('section, div, article, li, figure, img, h1, h2, h3, p')) {
        const r = el.getBoundingClientRect();
        if (r.width < 120 || r.height < 60) continue;
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed') continue; // overlays are handled elsewhere
        if (parseFloat(cs.opacity) < 0.05 || cs.visibility === 'hidden') {
          el.style.setProperty('opacity', '1', 'important');
          el.style.setProperty('visibility', 'visible', 'important');
          // undo entrance offsets but leave legit layout transforms alone
          const t = cs.transform;
          if (t && t !== 'none' && /matrix/.test(t)) el.style.setProperty('transform', 'none', 'important');
        }
      }
    });
  } catch {}
}

async function settle(page, log = () => {}) {
  const netIdle = parseInt(process.env.NETIDLE_MS || String(P.netIdle), 10);
  try { await page.waitForLoadState('networkidle', { timeout: netIdle }); } catch {}
  if (CLEAN_OVERLAYS) await dismissOverlays(page);
  await autoScroll(page);
  if (EXTRA_WAIT > 0) await page.waitForTimeout(EXTRA_WAIT * 1000); // user-set patience
  await forceRevealHidden(page); // scroll-entrance animations that never fired
  if (CLEAN_OVERLAYS) {
    // second pass: catches delayed popups (timers, exit-intent, scroll-triggered)
    await dismissOverlays(page);
    await hideFloaters(page);
    // Escape closes menus/drawers/lightboxes left open by earlier interactions
    try { await page.keyboard.press('Escape'); } catch {}
  }
  await fixVideos(page);
  await stabilize(page);
  return verifyRender(page, log);
}

function sameOrigin(href, base) {
  try { return new URL(href, base).origin === new URL(base).origin; } catch { return false; }
}

// ---------------------------------------------------------------- colors

function hexToRgb(hex) {
  const m = hex.replace('#', '');
  const s = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}
function luminance([r, g, b]) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function saturation([r, g, b]) {
  const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
  return mx === 0 ? 0 : (mx - mn) / mx;
}
function parseCssColor(str) {
  if (!str) return null;
  str = str.trim();
  if (str.startsWith('#')) return hexToRgb(str);
  const m = str.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)/);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) < 0.5) return null; // transparent
    return [+m[1], +m[2], +m[3]];
  }
  return null;
}

async function dominantColors(buffer, n = 6) {
  // quantized histogram of a downsized image
  try {
    const { data, info } = await sharp(buffer).resize(48, 48, { fit: 'inside' }).ensureAlpha()
      .raw().toBuffer({ resolveWithObject: true });
    const counts = new Map();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue;
      const q = [data[i], data[i + 1], data[i + 2]].map((v) => Math.round(v / 24) * 24);
      const key = q.join(',');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([k, count]) => ({ rgb: k.split(',').map(Number), count }));
  } catch { return []; }
}

function pickBrandColor(candidates) {
  // Prefer a dark, saturated color (like the template's deep navy).
  const scored = candidates.filter(Boolean).map((rgb) => {
    const lum = luminance(rgb), sat = saturation(rgb);
    let score = 0;
    if (lum < 0.35) score += 2; else if (lum < 0.55) score += 1;
    score += sat * 2;
    if (lum > 0.85 || (sat < 0.08 && lum > 0.6)) score -= 3; // near-white / washed grey
    if (lum < 0.02 && sat < 0.05) score -= 1; // pure black is dull; prefer tinted darks
    return { rgb, score };
  }).sort((a, b) => b.score - a.score);
  if (scored.length && scored[0].score > 0.4) return rgbToHex(scored[0].rgb);
  // fall back to darkening the most saturated candidate
  const sat = scored.filter((s) => saturation(s.rgb) > 0.15).sort((a, b) => saturation(b.rgb) - saturation(a.rgb));
  if (sat.length) {
    const [r, g, b] = sat[0].rgb;
    return rgbToHex([r * 0.35, g * 0.35, b * 0.35]);
  }
  return '#0e2a3a';
}

// ---------------------------------------------------------------- logo

async function extractLogo(page, baseUrl, log) {
  // 1) inline <svg> inside header/nav link
  try {
    const inline = await page.evaluate(() => {
      const scopes = ['header', 'nav', '[class*="header" i]', '[class*="navbar" i]', '[class*="logo" i]'];
      for (const sc of scopes) {
        for (const root of document.querySelectorAll(sc)) {
          const svg = root.querySelector('a svg, svg');
          if (svg && svg.getBoundingClientRect().width > 24) {
            const clone = svg.cloneNode(true);
            // bake computed fill/stroke so it renders standalone
            const walk = (orig, cp) => {
              const cs = getComputedStyle(orig);
              if (cs.fill && cs.fill !== 'none' && !cp.getAttribute('fill')) cp.setAttribute('fill', cs.fill);
              if (cs.stroke && cs.stroke !== 'none' && !cp.getAttribute('stroke')) cp.setAttribute('stroke', cs.stroke);
              for (let i = 0; i < orig.children.length; i++) walk(orig.children[i], cp.children[i]);
            };
            try { walk(svg, clone); } catch {}
            if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            if (!clone.getAttribute('viewBox')) {
              const r = svg.getBoundingClientRect();
              clone.setAttribute('viewBox', `0 0 ${Math.round(r.width)} ${Math.round(r.height)}`);
            }
            return clone.outerHTML;
          }
        }
      }
      return null;
    });
    if (inline) { log('Logo: inline SVG found in header'); return { type: 'svg', svg: inline }; }
  } catch {}

  // 2) <img> logo candidates
  const imgSrc = await page.evaluate(() => {
    const score = (img) => {
      let s = 0;
      const attrs = ((img.src || '') + ' ' + (img.alt || '') + ' ' + (img.className || '')).toLowerCase();
      if (attrs.includes('logo')) s += 5;
      if (img.closest('header, nav, [class*="header" i], [class*="navbar" i]')) s += 3;
      const r = img.getBoundingClientRect();
      if (r.width > 40 && r.width < 600 && r.top < 250) s += 2;
      if (r.width === 0) s -= 10;
      return s;
    };
    const imgs = [...document.querySelectorAll('img')].map((i) => ({ src: i.currentSrc || i.src, s: score(i) }))
      .filter((x) => x.src && x.s > 3).sort((a, b) => b.s - a.s);
    return imgs.length ? imgs[0].src : null;
  }).catch(() => null);

  const tryFetch = async (url, label) => {
    try {
      const resp = await page.request.get(url);
      if (!resp.ok()) return null;
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      const body = await resp.body();
      if (ct.includes('svg') || url.split('?')[0].toLowerCase().endsWith('.svg')) {
        log(`Logo: SVG fetched (${label})`);
        return { type: 'svg', svg: body.toString('utf8') };
      }
      log(`Logo: raster fetched (${label})`);
      return { type: 'raster', buffer: body };
    } catch { return null; }
  };

  if (imgSrc) {
    const r = await tryFetch(new URL(imgSrc, baseUrl).href, 'header <img>');
    if (r) return r;
  }

  // 3) icons / og:image fallbacks
  const fallbacks = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('link[rel*="icon"], link[rel="apple-touch-icon"]').forEach((l) => {
      out.push({ href: l.href, sizes: l.sizes ? l.sizes.value : '' });
    });
    const og = document.querySelector('meta[property="og:image"]');
    if (og) out.push({ href: og.content, sizes: 'og' });
    return out;
  }).catch(() => []);
  fallbacks.sort((a, b) => (parseInt(b.sizes) || 0) - (parseInt(a.sizes) || 0));
  for (const f of fallbacks) {
    if (!f.href) continue;
    const r = await tryFetch(new URL(f.href, baseUrl).href, 'icon/og fallback');
    if (r) return r;
  }
  log('Logo: none found');
  return null;
}

// Extract the site's square mark (favicon / touch icon). Prefers the
// apple-touch-icon (usually 180px+), then the largest declared icon.
// .ico files are skipped (not renderable in SVG/Figma).
async function extractMark(page, baseUrl, log) {
  const icons = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('link[rel*="icon" i]').forEach((l) => {
      out.push({ href: l.href, sizes: l.sizes ? l.sizes.value : '', rel: l.rel || '' });
    });
    return out;
  }).catch(() => []);
  icons.sort((a, b) => {
    const score = (i) => (/apple-touch/i.test(i.rel) ? 1000 : 0) + (parseInt(i.sizes, 10) || 0) + (/\.svg/i.test(i.href) ? 500 : 0);
    return score(b) - score(a);
  });
  for (const i of icons) {
    if (!i.href || /\.ico(\?|$)/i.test(i.href)) continue;
    try {
      const resp = await page.request.get(new URL(i.href, baseUrl).href);
      if (!resp.ok()) continue;
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (ct.includes('icon') && !ct.includes('svg')) continue;
      const body = await resp.body();
      if (ct.includes('svg') || i.href.split('?')[0].toLowerCase().endsWith('.svg')) {
        log('Mark: SVG icon found');
        return { type: 'svg', svg: body.toString('utf8') };
      }
      log(`Mark: icon found (${i.sizes || 'unsized'})`);
      return { type: 'raster', buffer: body };
    } catch {}
  }
  log('Mark: no usable icon — the wordmark will be used for the square tile');
  return null;
}

// estimate logo lightness to choose a contrasting background
async function logoIsLight(logo) {
  try {
    if (logo.type === 'raster') {
      const doms = await dominantColors(logo.buffer, 3);
      if (!doms.length) return false;
      const total = doms.reduce((a, d) => a + d.count, 0);
      const avg = doms.reduce((a, d) => a + luminance(d.rgb) * d.count, 0) / total;
      return avg > 0.55;
    }
    // svg: inspect fill colors
    const fills = [...logo.svg.matchAll(/(?:fill|stroke)=["']([^"']+)["']/g)].map((m) => parseCssColor(m[1])).filter(Boolean);
    if (logo.svg.match(/(?:fill|stroke)=["'](?:#fff|#ffffff|white)/i)) return true;
    if (!fills.length) return false; // default fill = black
    return fills.reduce((a, c) => a + luminance(c), 0) / fills.length > 0.55;
  } catch { return false; }
}

// ---------------------------------------------------------------- section picking

// Score sections for visual richness: prefer a distinct (ideally dark)
// background, multi-column layouts, and imagery — not a plain text block.
// excludeTops: document-y positions of sections already used (skip them).
async function pickSectionBox(page, excludeTops = []) {
  return page.evaluate((excludeTops) => {
    const lum = (c) => {
      const m = c.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\)/);
      if (!m) return null;
      if (m[4] !== undefined && parseFloat(m[4]) < 0.5) return null;
      return (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) / 255;
    };
    const bodyLum = lum(getComputedStyle(document.body).backgroundColor);
    const effBg = (el) => {
      let l = lum(getComputedStyle(el).backgroundColor);
      if (l === null && el.firstElementChild) l = lum(getComputedStyle(el.firstElementChild).backgroundColor);
      return l;
    };
    const vw = innerWidth, vh = innerHeight;
    const cands = [];
    for (const el of document.querySelectorAll('section, [class*="section" i], main > div, [class*="row" i]')) {
      const r = el.getBoundingClientRect();
      const top = r.top + scrollY, h = r.height, w = r.width;
      if (h < 400 || h > 1400 || w < vw * 0.85 || top < vh * 0.6) continue;
      if (excludeTops.some((t) => Math.abs(t - top) < 120)) continue;
      let score = 0;
      const bg = effBg(el);
      if (bg !== null && bg < 0.45) score += 4;                       // dark, standout background
      else if (bg !== null && bodyLum !== null && Math.abs(bg - bodyLum) > 0.15) score += 2; // distinct bg
      const imgs = el.querySelectorAll('img, picture, video, svg, [style*="background-image"]').length;
      if (imgs >= 2) score += 2; else if (imgs === 1) score += 1;
      for (const c of el.querySelectorAll(':scope > *, :scope > * > *, :scope > * > * > *')) {
        const cs = getComputedStyle(c);
        if ((cs.display === 'grid' || cs.display === 'flex') && c.children.length >= 3) {
          const rects = [...c.children].map((k) => k.getBoundingClientRect());
          const sameRow = rects.filter((k) => Math.abs(k.top - rects[0].top) < 40 && k.width > 80);
          if (sameRow.length >= 3) { score += 3; break; }
        }
      }
      const textLen = (el.innerText || '').length;
      if (imgs === 0 && textLen > 100 && score < 3) score -= 2;       // plain text block
      if (h > 500 && h < 1100) score += 1;                            // comfortable aspect
      cands.push({ top, h: Math.min(h, 1300), score });
    }
    cands.sort((a, b) => b.score - a.score || a.top - b.top);
    return cands.length ? cands[0] : null;
  }, excludeTops);
}

async function shootSection(page, box) {
  await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, box.top - 200));
  await page.waitForTimeout(500);
  await stabilize(page);
  // fullPage makes the clip document-relative: exact section, nothing cut off
  return page.screenshot({
    type: 'png', scale: 'css', fullPage: true,
    clip: { x: 0, y: Math.round(box.top), width: page.viewportSize().width, height: Math.round(box.h) },
  });
}

// ---------------------------------------------------------------- single-shot recapture API (used by regenerate)

async function captureHero(url, log = () => {}, viewports) {
  const VP = viewportsFrom(viewports);
  return withPage(url, async (page) => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await fixVideos(page);
    await page.waitForTimeout(400);
    const hero = await stableShot(page, () => page.screenshot({ type: 'png' }), log);
    await page.setViewportSize({ width: VP.desktop.width, height: VP.desktop.width });
    await page.waitForTimeout(600);
    await fixVideos(page);
    const heroTall = await stableShot(page, () => page.screenshot({ type: 'png', scale: 'css' }), log);
    return { hero, heroTall };
  }, { log, viewports });
}

async function captureFullPage(url, log = () => {}, viewports) {
  return withPage(url, (page) => fullPageShotChecked(page, log, url), { log, viewports });
}

async function captureSection(url, excludeTops = [], log = () => {}, viewports) {
  return withPage(url, async (page) => {
    const box = await pickSectionBox(page, excludeTops);
    if (!box) return null;
    return { buffer: await shootSection(page, box), top: box.top };
  }, { log, viewports });
}

async function captureMobiles(urls, log = () => {}, viewports) {
  const VP = viewportsFrom(viewports);
  const browser = await launchBrowser(log);
  const out = [];
  try {
    const ctx = await browser.newContext(mobileCtx(VP.mobile));
    const page = await ctx.newPage();
    for (const u of urls) {
      try {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await settle(page, log);
        const buffer = await fullPageShotChecked(page, log, u);
        const quality = await analyzeCapture(buffer, { viewportHeight: VP.mobile.height });
        if (!quality.usable) { log(`  mobile skipped after image checks: ${u}`); continue; }
        out.push({ url: u, buffer, quality });
        log(`  mobile ok: ${u} (${quality.score.toFixed(1)}/100)`);
      } catch { log(`  mobile skipped: ${u}`); }
    }
  } finally { await browser.close(); }
  return out;
}

// ---------------------------------------------------------------- main

async function capture(targetUrl, opts = {}) {
  const log = opts.onLog || (() => {});
  const manualPages = (opts.pages || []).filter((p) => p.trim());
  const VP = viewportsFrom(opts.viewports);
  const browser = await launchBrowser(log);
  const result = { screenshots: {}, fullPages: [], mobilePages: [], meta: { viewports: VP, diagnostics: [] } };

  try {
    const ctx = await browser.newContext(desktopCtx(VP.desktop));
    const page = await ctx.newPage();
    log(`Loading ${targetUrl} at ${VP.desktop.width}px frame...`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const initialDiagnostics = await settle(page, log);
    if (initialDiagnostics) result.meta.diagnostics.push({ url: targetUrl, frame: 'desktop', ...initialDiagnostics });

    result.meta.title = await page.title();
    result.meta.siteName = await page.evaluate(() => {
      const content = (selector) => document.querySelector(selector)?.getAttribute('content')?.trim() || '';
      return content('meta[property="og:site_name"]')
        || content('meta[name="application-name"]')
        || content('meta[name="apple-mobile-web-app-title"]');
    }).catch(() => '');
    result.meta.url = targetUrl;

    // ---- colors from the page
    const cssColors = await page.evaluate(() => {
      const out = [];
      const push = (v) => v && out.push(v);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) push(meta.content);
      const sels = ['header', 'nav', 'footer', 'button', '.btn', '[class*="button" i]', '[class*="hero" i]', 'a[class*="btn" i]'];
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (el) {
          const cs = getComputedStyle(el);
          push(cs.backgroundColor); push(cs.color);
        }
      }
      push(getComputedStyle(document.body).backgroundColor);
      return out;
    }).catch(() => []);

    // ---- logo + square mark (favicon)
    const logo = await extractLogo(page, targetUrl, log);
    result.logo = logo;
    result.mark = await extractMark(page, targetUrl, log);

    const colorCandidates = cssColors.map(parseCssColor).filter(Boolean);
    if (logo && logo.type === 'raster') {
      (await dominantColors(logo.buffer)).forEach((d) => colorCandidates.push(d.rgb));
    }
    if (logo && logo.type === 'svg') {
      [...logo.svg.matchAll(/(?:fill|stroke|stop-color)[=:]["'\s]*([^"';)\s]+)/g)]
        .map((m) => parseCssColor(m[1])).filter(Boolean).forEach((c) => colorCandidates.push(c));
    }
    result.meta.brandColor = pickBrandColor(colorCandidates);
    result.meta.logoIsLight = logo ? await logoIsLight(logo) : false;
    log(`Brand color: ${result.meta.brandColor}`);

    // ---- hero screenshot (1440x810 frame @2x)
    log('Capturing hero...');
    await page.evaluate(() => window.scrollTo(0, 0));
    await refreshCaptureSurface(page, { loop: true }); // catches late reinsertion
    await page.waitForTimeout(400);
    result.screenshots.hero = await stableShot(page, () => page.screenshot({ type: 'png' }), log);
    result.meta.heroQuality = await analyzeCapture(result.screenshots.hero, { viewportHeight: VP.desktop.height });

    // ---- tall square hero — used by the featured layout so the
    // full page width is visible rather than a tight crop
    log('Capturing square hero...');
    await page.setViewportSize({ width: VP.desktop.width, height: VP.desktop.width });
    await page.waitForTimeout(600);
    await refreshCaptureSurface(page, { loop: true });
    result.screenshots.heroTall = await stableShot(page, () => page.screenshot({ type: 'png', scale: 'css' }), log);
    await page.setViewportSize(VP.desktop);
    await page.waitForTimeout(300);

    // ---- discover pages
    let pageUrls = manualPages.map((p) => new URL(p, targetUrl).href);
    if (!pageUrls.length) {
      const links = await page.evaluate(() => {
        const seen = new Set(); const out = [];
        const anchors = [...document.querySelectorAll('header a[href], nav a[href], [class*="nav" i] a[href]')];
        for (const a of anchors) {
          const href = a.href;
          if (!href || seen.has(href)) continue;
          const bad = /login|signin|sign-in|signup|register|logout|cart|account|#|mailto:|tel:|\.pdf|\.zip/i;
          if (bad.test(href)) continue;
          seen.add(href); out.push(href);
        }
        return out;
      }).catch(() => []);
      pageUrls = links.filter((l) => sameOrigin(l, targetUrl) && l.replace(/\/$/, '') !== targetUrl.replace(/\/$/, ''));
      log(`Discovered ${pageUrls.length} nav pages`);
    }
    result.meta.discoveredPages = pageUrls.slice(0, 20); // kept for regenerate rotation
    const MAX_PAGES = parseInt(process.env.MAX_PAGES || '6', 10);
    pageUrls = pageUrls.slice(0, MAX_PAGES);

    // ---- full-page screenshots (homepage + inner pages)
    log('Capturing full page: homepage');
    const homeBuffer = await fullPageShotChecked(page, log, targetUrl);
    const homeQuality = await analyzeCapture(homeBuffer, { viewportHeight: VP.desktop.height });
    if (!homeQuality.usable && result.meta.heroQuality.usable) {
      log('  homepage full-page capture was unusable — using the verified hero frame instead');
      result.fullPages.push({ url: targetUrl, buffer: result.screenshots.hero, quality: result.meta.heroQuality, fallback: 'hero' });
    } else {
      result.fullPages.push({ url: targetUrl, buffer: homeBuffer, quality: homeQuality });
    }

    for (const u of pageUrls) {
      try {
        log(`Capturing full page: ${u}`);
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 35000 });
        const diagnostics = await settle(page, log);
        if (diagnostics) result.meta.diagnostics.push({ url: u, frame: 'desktop', ...diagnostics });
        const buffer = await fullPageShotChecked(page, log, u);
        const quality = await analyzeCapture(buffer, { viewportHeight: VP.desktop.height });
        if (!quality.usable) { log(`  skipped after image checks: ${u}`); continue; }
        result.fullPages.push({ url: u, buffer, quality });
      } catch (e) { log(`  skipped (${e.message.split('\n')[0]})`); }
      if (result.fullPages.length >= 6) break;
    }

    // ---- section screenshot (back on homepage)
    log('Capturing section...');
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
      await settle(page, log);
      const box = await pickSectionBox(page);
      if (box) {
        result.screenshots.section = await shootSection(page, box);
        result.meta.sectionTop = box.top; // kept for regenerate exclusion
      } else {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.45));
        await page.waitForTimeout(500);
        await stabilize(page);
        await refreshCaptureSurface(page, { loop: true });
        result.screenshots.section = await page.screenshot({ type: 'png' });
      }
    } catch (e) {
      log(`  section pick failed (${e.message.split('\n')[0]}) — using hero as fallback`);
      result.screenshots.section = result.screenshots.hero;
    }

    await ctx.close();

    // ---- mobile captures
    log(`Capturing mobile (${VP.mobile.width}px frame)...`);
    const mctx = await browser.newContext(mobileCtx(VP.mobile));
    const mpage = await mctx.newPage();
    const mobileTargets = [targetUrl, ...pageUrls].slice(0, parseInt(process.env.MAX_MOBILE || '3', 10));
    for (const u of mobileTargets) {
      try {
        await mpage.goto(u, { waitUntil: 'domcontentloaded', timeout: 35000 });
        const diagnostics = await settle(mpage, log);
        if (diagnostics) result.meta.diagnostics.push({ url: u, frame: 'mobile', ...diagnostics });
        const buffer = await fullPageShotChecked(mpage, log, u);
        const quality = await analyzeCapture(buffer, { viewportHeight: VP.mobile.height });
        if (!quality.usable) { log(`  mobile skipped after image checks: ${u}`); continue; }
        result.mobilePages.push({ url: u, buffer, quality });
        log(`  mobile ok: ${u} (${quality.score.toFixed(1)}/100)`);
      } catch (e) { log(`  mobile skipped: ${u}`); }
    }
    await mctx.close();

    // ---- tablet captures (only when device mockups are enabled)
    result.tabletPages = [];
    if (opts.tablet) {
      log(`Capturing tablet (${VP.tablet.width}px frame)...`);
      const tctx = await browser.newContext(tabletCtx(VP.tablet));
      const tpage = await tctx.newPage();
      const tabletTargets = [targetUrl, ...pageUrls].slice(0, parseInt(process.env.MAX_TABLET || '2', 10));
      for (const u of tabletTargets) {
        try {
          await tpage.goto(u, { waitUntil: 'domcontentloaded', timeout: 35000 });
          const diagnostics = await settle(tpage, log);
          if (diagnostics) result.meta.diagnostics.push({ url: u, frame: 'tablet', ...diagnostics });
          const buffer = await fullPageShotChecked(tpage, log, u);
          const quality = await analyzeCapture(buffer, { viewportHeight: VP.tablet.height });
          if (!quality.usable) { log(`  tablet skipped after image checks: ${u}`); continue; }
          result.tabletPages.push({ url: u, buffer, quality });
          log(`  tablet ok: ${u} (${quality.score.toFixed(1)}/100)`);
        } catch { log(`  tablet skipped: ${u}`); }
      }
      await tctx.close();
    }
    const accepted = [...result.fullPages, ...result.mobilePages, ...result.tabletPages];
    result.meta.quality = {
      accepted: accepted.length,
      average: accepted.length ? Math.round(accepted.reduce((sum, item) => sum + item.quality.score, 0) / accepted.length) : 0,
      warnings: result.meta.diagnostics.filter((item) => item.broken || item.pending || item.skeletons || !item.heightStable).length,
    };
  } finally {
    await browser.close();
  }
  return result;
}

async function captureTablets(urls, log = () => {}, viewports) {
  const VP = viewportsFrom(viewports);
  const browser = await launchBrowser(log);
  const out = [];
  try {
    const ctx = await browser.newContext(tabletCtx(VP.tablet));
    const page = await ctx.newPage();
    for (const u of urls) {
      try {
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 35000 });
        await settle(page, log);
        const buffer = await fullPageShotChecked(page, log, u);
        const quality = await analyzeCapture(buffer, { viewportHeight: VP.tablet.height });
        if (!quality.usable) { log(`  tablet skipped after image checks: ${u}`); continue; }
        out.push({ url: u, buffer, quality });
        log(`  tablet ok: ${u} (${quality.score.toFixed(1)}/100)`);
      } catch { log(`  tablet skipped: ${u}`); }
    }
  } finally { await browser.close(); }
  return out;
}

// -------------------------------------------------- simple screenshots
// Viewport (first screen, no scrolling) and/or full-length captures of the
// given URLs at custom dimensions. Used by the Screenshots section.
async function captureShots(urls, { width = 1440, height = 900, viewport = true, full = false } = {}, log = () => {}) {
  const num = (x, d) => { const n = parseInt(x, 10); return n >= 320 && n <= 3840 ? n : d; };
  const W = num(width, 1440), H = num(height, 900);
  const browser = await launchBrowser(log);
  const out = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE, userAgent: UA_DESKTOP });
    const page = await ctx.newPage();
    for (const u of urls) {
      try {
        log(`Screenshot: ${u} (${W}x${H})`);
        await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 40000 });
        await settle(page, log);
        await page.evaluate(() => window.scrollTo(0, 0));
        await refreshCaptureSurface(page, { loop: true });
        await page.waitForTimeout(300);
        const entry = { url: u, width: W, height: H };
        if (viewport) {
          entry.viewport = await stableShot(page, () => page.screenshot({ type: 'png' }), log);
          entry.viewportQuality = await analyzeCapture(entry.viewport, { viewportHeight: H });
        }
        if (full) {
          entry.full = await fullPageShotChecked(page, log, u);
          entry.fullQuality = await analyzeCapture(entry.full, { viewportHeight: H });
        }
        if ((entry.viewport && !entry.viewportQuality.usable) && (!entry.full || !entry.fullQuality.usable)) {
          log(`  screenshot skipped after image checks: ${u}`);
          continue;
        }
        out.push(entry);
      } catch (e) { log(`  screenshot skipped: ${u} (${e.message.split('\n')[0]})`); }
    }
  } finally { await browser.close(); }
  return out;
}

// ---------------------------------------------------------------- scroll video

// Records a clean 1440x1440 scroll-through of the page: popups dismissed,
// lazy content pre-loaded via a full scroll pass, then a smooth constant-speed
// scroll from top to bottom. Returns the path of the recorded .webm.
async function recordScrollVideo(url, workDir, log = () => {}, opts = {}) {
  const num = (x, d) => { const n = parseInt(x, 10); return n >= 320 && n <= 3840 ? n : d; };
  const W = num(opts.width, 1440), H = num(opts.height, 1440);
  const maxSeconds = opts.maxSeconds || 55;
  const baseSpeed = opts.pxPerSec || 650;
  const browser = await launchBrowser(log);
  try {
    const ctx = await browser.newContext({
      viewport: { width: W, height: H },
      deviceScaleFactor: 1,
      userAgent: UA_DESKTOP,
      recordVideo: { dir: workDir, size: { width: W, height: H } },
    });
    const t0 = Date.now(); // recording starts with the context
    const page = await ctx.newPage();
    log(`Video: loading page (${W}x${H})...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // full readiness pass: popups gone, lazy content loaded, animations settled
    await settle(page, log);
    await dismissOverlays(page);
    await hideFloaters(page, { loop: true }); // keep catching mid-scroll arrivals
    if (opts.bg) {
      try { await page.addStyleTag({ content: `html, body { background: ${opts.bg} !important; }` }); } catch {}
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await refreshCaptureSurface(page, { loop: true });
    await page.waitForTimeout(300);
    // everything before this point (loading, popups being dismissed) gets
    // trimmed out of the final cut
    const trimStart = (Date.now() - t0) / 1000 + 0.2;
    await page.waitForTimeout(1200); // hold on the hero

    const total = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - innerHeight);
    const speed = Math.max(baseSpeed, Math.ceil(total / maxSeconds)); // very long pages speed up instead of failing
    log(`Video: scrolling ${total}px at ${speed}px/s (~${Math.ceil(total / speed)}s)...`);
    await page.evaluate(async (speed) => {
      const total = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - innerHeight;
      if (total <= 0) return;
      await new Promise((res) => {
        const start = performance.now();
        const step = (t) => {
          const y = Math.min(total, ((t - start) / 1000) * speed);
          window.scrollTo(0, y);
          if (y >= total) res(); else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    }, speed);
    await page.waitForTimeout(1400); // hold on the footer
    const video = page.video();
    await ctx.close(); // finalizes the file
    const p = await video.path();
    log('Video: recording finished');
    return { path: p, trimStart };
  } finally {
    await browser.close();
  }
}

module.exports = { capture, captureHero, captureFullPage, captureSection, captureMobiles, captureTablets, captureShots, recordScrollVideo, setPatience, setOverlayCleanup, setExtraWait, setStitchMode };
// internal steps exposed for diagnostics/tests
module.exports._internals = { dismissOverlays, autoScroll, fixVideos, stabilize, verifyRender, hideFloaters, settle, forceRevealHidden, fullPageShotStitched, fullPageShot, usesScrollLinkedLayout };
