/**
 * animate.js — animated showcase recordings.
 * Rebuilds a showcase layout as an HTML page and records it: frames enter
 * with modern, subtle motion (from corners / cascade / alternating sides /
 * zoom-settle), then the page screenshots SCROLL inside their frames before
 * a final hold on the exact static composition.
 */
const { chromium } = require('playwright');

const ANIM_STYLES = ['corners', 'cascade', 'sides', 'zoom-drift'];
const EASE = 'cubic-bezier(.22,.61,.36,1)';
const EASE_OVER = 'cubic-bezier(.34,1.4,.44,1)'; // gentle overshoot

// entrance keyframes per style + item index
function entrance(style, i, item, W, H) {
  const d = (i * 0.14).toFixed(2);
  if (style === 'corners') {
    // fly in from a different corner per card, with a slight settle rotation
    const corner = [[-1, -1], [1, 1], [1, -1], [-1, 1]][i % 4];
    const dx = corner[0] * (W * 0.45), dy = corner[1] * (H * 0.55);
    const rot = (i % 2 === 0 ? -1 : 1) * 5;
    return {
      anim: `ent-${i} 1.05s ${EASE} ${d}s both`,
      kf: `@keyframes ent-${i} { from { transform: translate(${dx}px, ${dy}px) rotate(${rot}deg); opacity: 0; } 70% { opacity: 1; } to { transform: none; opacity: 1; } }`,
    };
  }
  if (style === 'cascade') {
    return {
      anim: `ent-${i} .95s ${EASE_OVER} ${d}s both`,
      kf: `@keyframes ent-${i} { from { transform: translateY(${H * 0.35}px) scale(.96); opacity: 0; } to { transform: none; opacity: 1; } }`,
    };
  }
  if (style === 'sides') {
    const from = i % 2 === 0 ? -W * 0.5 : W * 0.5;
    return {
      anim: `ent-${i} 1s ${EASE} ${d}s both`,
      kf: `@keyframes ent-${i} { from { transform: translateX(${from}px) rotate(${i % 2 === 0 ? -3 : 3}deg); opacity: 0; } to { transform: none; opacity: 1; } }`,
    };
  }
  // zoom-drift
  return {
    anim: `ent-${i} 1s ${EASE} ${d}s both`,
    kf: `@keyframes ent-${i} { from { transform: scale(.78) translateY(60px); opacity: 0; } to { transform: none; opacity: 1; } }`,
  };
}

function buildHtml(layout, style) {
  const { W, H, bgCss, angle, scale, items } = layout;
  const entTotal = 1.1 + items.length * 0.14;
  const scrollStart = entTotal + 0.45;
  const maxScroll = Math.max(0, ...items.map((it) => it.scroll || 0));
  const scrollDur = maxScroll > 0 ? Math.min(6, Math.max(2.6, maxScroll / 260)) : 0;

  const cards = [], keyframes = [];
  items.forEach((it, i) => {
    const e = entrance(style, i, it, W, H);
    keyframes.push(e.kf);
    const scroll = it.scroll || 0;
    let imgAnim = '';
    if (scroll > 4) {
      keyframes.push(`@keyframes sc-${i} { from { transform: translateY(0); } to { transform: translateY(-${scroll}px); } }`);
      imgAnim = `animation: sc-${i} ${scrollDur}s ease-in-out ${scrollStart.toFixed(2)}s forwards;`;
    }
    cards.push(`<div class="card" style="left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px;border-radius:${it.r}px;animation:${e.anim}">
<img src="${it.uriTall || it.uri}" style="width:100%;display:block;${imgAnim}"></div>`);
  });
  const wrapT = angle ? `transform: rotate(${angle}deg) scale(${scale}); transform-origin: ${W / 2}px ${H / 2}px;` : '';
  const total = scrollStart + scrollDur + 1.3;
  const html = `<!DOCTYPE html><html><head><style>
* { margin:0; padding:0; box-sizing:border-box; }
body { width:${W}px; height:${H}px; overflow:hidden; background:${bgCss}; }
.wrap { position:absolute; inset:0; ${wrapT} }
.card { position:absolute; background:#fff; box-shadow:0 14px 40px rgba(10,22,32,.30); overflow:hidden; will-change: transform, opacity; }
.card img { will-change: transform; }
${keyframes.join('\n')}
</style></head><body><div class="wrap">${cards.join('\n')}</div></body></html>`;
  return { html, total };
}

// Records the animation; returns { path, trimStart, style }
async function recordAnimatedShowcase(layout, workDir, log = () => {}, opts = {}) {
  const style = opts.style || ANIM_STYLES[Math.floor(Math.random() * ANIM_STYLES.length)];
  const { W, H } = layout;
  const { html, total } = buildHtml(layout, style);
  log(`Animation: recording "${style}" (${layout.items.length} frames, ~${Math.ceil(total)}s)...`);
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const ctx = await browser.newContext({
      viewport: { width: W, height: H },
      deviceScaleFactor: 1,
      recordVideo: { dir: workDir, size: { width: W, height: H } },
    });
    const t0 = Date.now();
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    // decode all card images, then restart the (inline) animations from zero
    await page.evaluate(async () => {
      await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
      document.querySelectorAll('.card, .card img').forEach((c) => {
        const a = c.style.animation;
        if (!a) return;
        c.style.animation = 'none';
        void c.offsetWidth;
        c.style.animation = a;
      });
    });
    await page.waitForTimeout(120);
    const trimStart = (Date.now() - t0) / 1000;
    await page.waitForTimeout(Math.ceil(total * 1000));
    const video = page.video();
    await ctx.close();
    const p = await video.path();
    log('Animation: recording finished');
    return { path: p, trimStart, style };
  } finally {
    await browser.close();
  }
}

module.exports = { recordAnimatedShowcase, ANIM_STYLES };
