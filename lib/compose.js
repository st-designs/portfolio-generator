/**
 * compose.js — builds the 8 portfolio SVGs from captured assets.
 * Sizes match the template set:
 *   logo 480x480 · landing 1920x1080 · featured 1080x1080 · mobile 1920x1080
 *   page-1/page-2 948x1080 · section 1920x1080 · showcase 1920x1080
 */
const sharp = require('sharp');

const LIGHT_BG = '#d5d8df'; // template light lavender-grey
const jpegOptions = (quality = 92) => ({ quality: Math.max(92, quality), chromaSubsampling: '4:4:4', mozjpeg: true });

// deterministic PRNG so a seed reproduces the exact same layout
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const range = (rng, min, max) => min + rng() * (max - min);
function shuffle(rng, arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ------------------------------------------------------------- image prep

async function toDataUri(buffer, { width, height, top = 0, quality = 82, format = 'jpeg' } = {}) {
  let img = sharp(buffer);
  const meta = await img.metadata();
  if (width) {
    img = img.resize({ width: Math.round(width), withoutEnlargement: false });
  }
  let buf = await img.toBuffer();
  if (height) {
    const m = await sharp(buf).metadata();
    const h = Math.min(Math.round(height), m.height - Math.round(top));
    buf = await sharp(buf).extract({ left: 0, top: Math.round(top), width: m.width, height: Math.max(1, h) }).toBuffer();
  }
  const out = format === 'png'
    ? await sharp(buf).png().toBuffer()
    : await sharp(buf).flatten({ background: '#ffffff' }).jpeg(jpegOptions(quality)).toBuffer();
  return `data:image/${format};base64,${out.toString('base64')}`;
}

// crop to exact cover box (like CSS object-fit: cover, top-anchored)
async function coverDataUri(buffer, boxW, boxH, { anchor = 'top', scale = 2, quality = 82 } = {}) {
  const targetW = Math.round(boxW * scale), targetH = Math.round(boxH * scale);
  const position = anchor === 'left-top' ? 'left top' : anchor === 'top' ? 'top' : 'centre';
  const out = await sharp(buffer)
    .resize(targetW, targetH, { fit: 'cover', position })
    .flatten({ background: '#ffffff' }).jpeg(jpegOptions(quality)).toBuffer();
  return `data:image/jpeg;base64,${out.toString('base64')}`;
}

function svgOpen(w, h) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
}

const SHADOW_DEF = `<defs><filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%">
<feDropShadow dx="0" dy="10" stdDeviation="22" flood-color="#0a1620" flood-opacity="0.28"/>
</filter></defs>`;

function clipRounded(id, x, y, w, h, r) {
  return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}"/></clipPath>`;
}

// rounded-rect path with per-corner radii [tl, tr, br, bl]
function roundedPath(x, y, w, h, [tl, tr, br, bl]) {
  return `M${x + tl},${y} h${w - tl - tr} ${tr ? `a${tr},${tr} 0 0 1 ${tr},${tr}` : ''} v${h - tr - br} ${br ? `a${br},${br} 0 0 1 -${br},${br}` : ''} h-${w - br - bl} ${bl ? `a${bl},${bl} 0 0 1 -${bl},-${bl}` : ''} v-${h - bl - tl} ${tl ? `a${tl},${tl} 0 0 1 ${tl},-${tl}` : ''} z`;
}

// ------------------------------------------------------------- layouts

// nest an SVG logo as real inline markup (NOT an <image> data-URI, which
// Figma and some tools can't render) positioned+scaled via a child <svg>
function inlineNestedSvg(svgText, x, y, w, h) {
  let s = svgText.replace(/<\?xml[^>]*\?>/gi, '').replace(/<!DOCTYPE[^>]*>/gi, '').trim();
  const openTag = (s.match(/<svg[^>]*>/i) || [''])[0];
  if (!openTag) return null;
  // ensure a viewBox so the nested svg scales; synthesize from width/height
  if (!/viewBox/i.test(openTag)) {
    const wm = openTag.match(/width=["']?([\d.]+)/i), hm = openTag.match(/height=["']?([\d.]+)/i);
    if (wm && hm) s = s.replace(/<svg/i, `<svg viewBox="0 0 ${wm[1]} ${hm[1]}"`);
    else return null; // can't scale safely — caller falls back to raster
  }
  s = s.replace(/<svg([^>]*?)>/i, (full, attrs) => {
    attrs = attrs.replace(/\s(x|y|width|height|preserveAspectRatio)=["'][^"']*["']/gi, '');
    return `<svg${attrs} x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet">`;
  });
  return s;
}

// 1. LOGO 480x480 — logo centered on brand color
async function composeLogo({ logo, brandColor, logoIsLight }) {
  const W = 480, H = 480;
  // pick a background that contrasts with the logo
  const bg = logoIsLight ? brandColor : (isDark(brandColor) ? '#f2f0eb' : brandColor);
  let inner = '';
  if (logo && logo.type === 'svg') {
    inner = inlineNestedSvg(logo.svg, 96, 96, 288, 288);
    if (!inner) {
      // no viewBox and no dimensions — rasterize via sharp as a safe fallback
      try {
        const png = await sharp(Buffer.from(logo.svg), { density: 300 }).resize({ width: 576, height: 576, fit: 'inside' }).png().toBuffer();
        inner = `<image href="data:image/png;base64,${png.toString('base64')}" x="96" y="96" width="288" height="288" preserveAspectRatio="xMidYMid meet"/>`;
      } catch { inner = ''; }
    }
  } else if (logo && logo.type === 'raster') {
    const uri = await toDataUri(logo.buffer, { format: 'png' });
    inner = `<image href="${uri}" x="96" y="96" width="288" height="288" preserveAspectRatio="xMidYMid meet"/>`;
  }
  return `${svgOpen(W, H)}<rect width="${W}" height="${H}" fill="${bg}"/>${inner}</svg>`;
}

function isDark(hex) {
  const s = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

// 2. LANDING 1920x1080 — full-bleed hero
async function composeLanding({ hero }) {
  const W = 1920, H = 1080;
  const uri = await coverDataUri(hero, W, H, { scale: 1.5, quality: 85 });
  return `${svgOpen(W, H)}<image href="${uri}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/></svg>`;
}

// 3. FEATURED 1920x1080 — full-width hero shot pushed into one of the
// four corners (seeded). The three corners touching the canvas edges are
// square; only the single free corner gets a 20px radius.
async function composeFeatured({ heroTall, hero, brandColor, brandPaint, rng, radius }) {
  const W = 1920, H = 1080, R = frameRadius(rng, radius);
  const PAD = Math.round(range(rng, 96, 130));
  const corner = pick(rng, ['bottom-right', 'bottom-left', 'top-right', 'top-left']);
  const boxW = W - PAD, boxH = H - PAD;
  const x = corner.includes('right') ? PAD : 0;
  const y = corner.includes('bottom') ? PAD : 0;
  // free corner = diagonally opposite the placement corner
  const radii = {
    'bottom-right': [R, 0, 0, 0], // free: top-left
    'bottom-left': [0, R, 0, 0],  // free: top-right
    'top-right': [0, 0, 0, R],    // free: bottom-left
    'top-left': [0, 0, R, 0],     // free: bottom-right
  }[corner];
  const path = roundedPath(x, y, boxW, boxH, radii);
  const src = heroTall || hero;
  const uri = await coverDataUri(src, boxW, boxH, { scale: 1.2, quality: 85 });
  const paint = brandPaint || bgPaint(null, brandColor);
  return `${svgOpen(W, H)}
${paint.defs}<rect width="${W}" height="${H}" fill="${paint.fill}"/>
${SHADOW_DEF}
<defs><clipPath id="fc"><path d="${path}"/></clipPath></defs>
<g filter="url(#cardShadow)"><path d="${path}" fill="#fff"/></g>
<image href="${uri}" x="${x}" y="${y}" width="${boxW}" height="${boxH}" clip-path="url(#fc)" preserveAspectRatio="xMidYMin slice"/>
</svg>`;
}

// 4. MOBILE 1920x1080 — three phone frames on brand color
async function composeMobile({ mobilePages, brandColor }) {
  const W = 1920, H = 1080;
  const phoneW = 400, phoneH = 880, bezel = 12, r = 54;
  const y = (H - phoneH) / 2;
  const gap = 88;
  const totalW = phoneW * 3 + gap * 2;
  const x0 = (W - totalW) / 2;
  const shots = [...mobilePages];
  while (shots.length && shots.length < 3) shots.push(shots[shots.length - 1]);

  let phones = '';
  for (let i = 0; i < 3; i++) {
    if (!shots[i]) break;
    const x = x0 + i * (phoneW + gap);
    const scrW = phoneW - bezel * 2, scrH = phoneH - bezel * 2;
    // vary crop: 1st top, 2nd slightly scrolled, 3rd top (different pages anyway)
    const meta = await sharp(shots[i].buffer).metadata();
    const scaledH = meta.height * (scrW * 2 / meta.width);
    const topPx = i === 1 && scaledH > scrH * 4 ? Math.round(meta.height * 0.18) : 0;
    const cropped = topPx
      ? await sharp(shots[i].buffer).extract({ left: 0, top: topPx, width: meta.width, height: meta.height - topPx }).toBuffer()
      : shots[i].buffer;
    const uri = await coverDataUri(cropped, scrW, scrH, { scale: 2, quality: 80 });
    phones += `
<g filter="url(#cardShadow)"><rect x="${x}" y="${y}" width="${phoneW}" height="${phoneH}" rx="${r}" fill="#0b0d10"/></g>
<defs>${clipRounded('ph' + i, x + bezel, y + bezel, scrW, scrH, r - bezel)}</defs>
<image href="${uri}" x="${x + bezel}" y="${y + bezel}" width="${scrW}" height="${scrH}" clip-path="url(#ph${i})" preserveAspectRatio="xMidYMin slice"/>`;
  }
  return `${svgOpen(W, H)}<rect width="${W}" height="${H}" fill="${brandColor}"/>${SHADOW_DEF}${phones}</svg>`;
}

// width-fit, top-anchored, never zoom-crops: scale to exact card width; if the
// page is shorter than the card, extend with white below (no sideways crop)
async function widthFitDataUri(buffer, boxW, boxH, { scale = 2, quality = 82 } = {}) {
  const tw = Math.round(boxW * scale), th = Math.round(boxH * scale);
  const resized = await sharp(buffer).resize({ width: tw }).toBuffer();
  const m = await sharp(resized).metadata();
  let out;
  if (m.height >= th) {
    out = await sharp(resized).extract({ left: 0, top: 0, width: tw, height: th });
  } else {
    out = await sharp(resized).extend({ bottom: th - m.height, background: '#ffffff' });
  }
  const buf = await out.flatten({ background: '#ffffff' }).jpeg(jpegOptions(quality)).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

// 5/6. PAGE 948x1080 — full-page shot in white card on light grey
async function composePage({ fullPage, bg = LIGHT_BG }) {
  const W = 948, H = 1080;
  const cardX = 100, cardY = 98, cardW = W - 200, cardH = H - cardY; // runs to bottom edge
  const uri = await widthFitDataUri(fullPage, cardW, cardH, { scale: 2, quality: 82 });
  return `${svgOpen(W, H)}
<rect width="${W}" height="${H}" fill="${bg}"/>
${SHADOW_DEF}
<defs>${clipRounded('pg', cardX, cardY, cardW, cardH, 10)}</defs>
<g filter="url(#cardShadow)"><rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="10" fill="#fff"/></g>
<image href="${uri}" x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" clip-path="url(#pg)" preserveAspectRatio="xMidYMin slice"/>
</svg>`;
}

// 7. SECTION 1920x1080 — the captured section shown complete (contain-fit):
// the card adopts the section's exact aspect ratio, centered on light grey,
// so nothing is ever cropped off.
async function composeSection({ section, bg = LIGHT_BG }) {
  const W = 1920, H = 1080;
  const maxW = W - 380, maxH = H - 220;
  const m = await sharp(section).metadata();
  let cardW = maxW, cardH = Math.round(maxW * m.height / m.width);
  if (cardH > maxH) { cardH = maxH; cardW = Math.round(maxH * m.width / m.height); }
  const cardX = Math.round((W - cardW) / 2), cardY = Math.round((H - cardH) / 2);
  const uri = await coverDataUri(section, cardW, cardH, { scale: 1.6, quality: 84 });
  return `${svgOpen(W, H)}
<rect width="${W}" height="${H}" fill="${bg}"/>
${SHADOW_DEF}
<defs>${clipRounded('sec', cardX, cardY, cardW, cardH, 20)}</defs>
<g filter="url(#cardShadow)"><rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="20" fill="#fff"/></g>
<image href="${uri}" x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" clip-path="url(#sec)" preserveAspectRatio="xMidYMid slice"/>
</svg>`;
}

// 8. SHOWCASE 1920x1080 — masonry collage. All desktop shots share one width,
// all mobile shots share a clearly smaller width (so mobile reads as mobile),
// and every seed includes both. The seed picks an arrangement style —
// straight, tilted left/right, or zoomed — plus column order, offsets, gaps,
// and which page lands where.
async function composeShowcase({ fullPages, mobilePages, rng, bg = LIGHT_BG, forceAngle, forceZoom }) {
  const W = 1920, H = 1080, GAP = Math.round(range(rng, 22, 30));
  // arrangement style
  const angle = forceAngle !== undefined ? forceAngle : pick(rng, [0, 0, 0, -7, 7, -11, 11]);
  const zoom = forceZoom !== undefined ? forceZoom : pick(rng, [1, 1, 0.88, 1.12]);
  const tilted = angle !== 0;
  const deskW = Math.round(range(rng, 340, 410));      // one width for all desktop
  const mobW = Math.round(deskW * range(rng, 0.42, 0.5)); // one clearly smaller width for all mobile
  const deskPool = shuffle(rng, fullPages.map((f) => f.buffer));
  const mobPool = shuffle(rng, mobilePages.map((m) => m.buffer));
  if (!deskPool.length && !mobPool.length) return `${svgOpen(W, H)}<rect width="${W}" height="${H}" fill="${bg}"/></svg>`;

  // tilted/zoomed collages need extra bleed so no background peeks through
  const over = tilted || zoom < 1 ? 460 : 90;
  const xStart = -Math.round(range(rng, over * 0.6, over));
  const xEnd = W + over;
  const yStart = -Math.round(range(rng, 180, over + 60));
  const yEnd = H + over;

  // seeded column sequence: mostly desktop, mobile mixed in — always ≥1 of
  // each kind when both pools exist
  const cols = [];
  let x = xStart;
  while (x < xEnd) {
    const useMobile = mobPool.length && cols.length > 0 && rng() < 0.3;
    cols.push({ type: useMobile ? 'mobile' : 'desktop', w: useMobile ? mobW : deskW, yOff: Math.round(range(rng, yStart, 40)) });
    x += (useMobile ? mobW : deskW) + GAP;
  }
  // guarantee a *visible* mobile column: bled/edge columns can rotate out of
  // frame, so require one within the central third of the sequence
  if (mobPool.length && cols.length > 2) {
    const mid = Math.floor(cols.length / 2);
    const centralHasMobile = cols.some((c, i) => c.type === 'mobile' && Math.abs(i - mid) <= Math.ceil(cols.length / 6));
    if (!centralHasMobile) cols[mid] = { ...cols[mid], type: 'mobile', w: mobW };
  }
  if (deskPool.length && !cols.some((c) => c.type === 'desktop')) {
    cols[0] = { ...cols[0], type: 'desktop', w: deskW };
  }

  let parts = [];
  let di = 0, mi = 0, clipN = 0;
  x = xStart;
  for (const col of cols) {
    let y = col.yOff;
    while (y < yEnd) {
      const buf = col.type === 'mobile'
        ? mobPool[mi++ % mobPool.length]
        : (deskPool.length ? deskPool[di++ % deskPool.length] : mobPool[mi++ % mobPool.length]);
      const meta = await sharp(buf).metadata();
      const drawW = col.w;
      let drawH = Math.round(meta.height * (drawW / meta.width));
      drawH = Math.min(drawH, Math.round(range(rng, 1100, 1500))); // cap very long pages
      const uri = await coverDataUri(buf, drawW, drawH, { scale: 1.6, quality: 74 });
      const id = 'sw' + clipN++;
      const r = col.type === 'mobile' ? 14 : 8; // mobile cards read as phones
      parts.push(`<defs>${clipRounded(id, x, y, drawW, drawH, r)}</defs>
<g filter="url(#cardShadow)"><rect x="${x}" y="${y}" width="${drawW}" height="${drawH}" rx="${r}" fill="#fff"/></g>
<image href="${uri}" x="${x}" y="${y}" width="${drawW}" height="${drawH}" clip-path="url(#${id})" preserveAspectRatio="xMidYMin slice"/>`);
      y += drawH + GAP;
      if (clipN > 40) break;
    }
    x += col.w + GAP;
    if (clipN > 40) break;
  }
  const transform = `rotate(${angle} ${W / 2} ${H / 2}) translate(${W / 2} ${H / 2}) scale(${(tilted ? 1.22 : 1) * zoom}) translate(${-W / 2} ${-H / 2})`;
  return `${svgOpen(W, H)}
<rect width="${W}" height="${H}" fill="${bg}"/>
${SHADOW_DEF}
<g transform="${transform}">
${parts.join('\n')}
</g></svg>`;
}

// ------------------------------------------------------------- entry

async function composeAll(captured, log = () => {}, seed, opts = {}) {
  const { logo, meta, screenshots, fullPages, mobilePages } = captured;
  const brandColor = opts.brandColor || meta.brandColor;
  const bg = opts.bgColor || LIGHT_BG;
  if (seed === undefined || seed === null || seed === '') seed = Math.floor(Math.random() * 1e9);
  seed = parseInt(seed, 10) || 1;
  log(`Layout seed: ${seed} (re-use it to reproduce this exact layout)`);
  const rng = mulberry32(seed);
  const out = {};

  log('Composing logo');
  out['logo'] = await composeLogo({ logo, brandColor, logoIsLight: meta.logoIsLight });
  log('Composing hero');
  out['landing'] = await composeLanding({ hero: screenshots.hero });
  log('Composing featured');
  out['featured'] = await composeFeatured({ heroTall: screenshots.heroTall, hero: screenshots.hero, brandColor, rng });
  if (mobilePages.length) {
    log('Composing mobile');
    out['mobile'] = await composeMobile({ mobilePages, brandColor });
  }
  // page-1/page-2: prefer two different inner subpages (fullPages[0] is the homepage)
  const inner = fullPages.slice(1);
  const pageA = inner[0] || fullPages[0];
  const pageB = inner[1] || fullPages[0];
  if (pageA) { log(`Composing page 1 (${pageA.url})`); out['page-1'] = await composePage({ fullPage: pageA.buffer, bg }); }
  if (pageB) { log(`Composing page 2 (${pageB.url})`); out['page-2'] = await composePage({ fullPage: pageB.buffer, bg }); }
  log('Composing section');
  out['section'] = await composeSection({ section: screenshots.section || screenshots.hero, bg });
  log('Composing showcase');
  out['showcase'] = await composeShowcase({ fullPages, mobilePages, rng, bg });
  out.__seed = seed;
  return out;
}

// Compose a single layout — used by the per-image regenerate feature.
// opts: { seed?, fullPage? (buffer for page-1/2), logoAltBg? (flip logo
// background), brandColor?, bgColor? }
async function composeOne(name, captured, opts = {}) {
  const { logo, meta, screenshots, fullPages, mobilePages } = captured;
  const brandColor = opts.brandColor || meta.brandColor;
  const bg = opts.bgColor || LIGHT_BG;
  const rng = mulberry32(parseInt(opts.seed, 10) || Math.floor(Math.random() * 1e9));
  switch (name) {
    case 'logo':
      return composeLogo({
        logo, brandColor,
        logoIsLight: opts.logoAltBg ? !meta.logoIsLight : meta.logoIsLight,
      });
    case 'landing': return composeLanding({ hero: screenshots.hero });
    case 'featured': return composeFeatured({ heroTall: screenshots.heroTall, hero: screenshots.hero, brandColor, rng });
    case 'mobile': return composeMobile({ mobilePages, brandColor });
    case 'page-1':
    case 'page-2': return composePage({ fullPage: opts.fullPage || (fullPages[0] && fullPages[0].buffer), bg });
    case 'section': return composeSection({ section: screenshots.section || screenshots.hero, bg });
    case 'showcase': return composeShowcase({ fullPages, mobilePages, rng, bg });
    default: throw new Error('unknown layout: ' + name);
  }
}

// ================================================================ v2 sections
// Three toggleable output categories: logo set (mark + wordmark), device
// mockup set, and showcase set. All device frames are pure vector — no
// image assets.

const FRAME = '#0b0d10';
let uid = 0;
const nid = () => 'd' + (++uid);

// Background spec: string (solid) or { style:'auto'|'solid'|'gradient', c1, c2 }.
// Returns { defs, fill } ready to drop into an SVG.
function bgPaint(bg, fallback) {
  if (!bg || (typeof bg === 'object' && (bg.style === 'auto' || !bg.style))) {
    const c = (typeof bg === 'object' && bg.style === 'auto' && bg.c1) ? bg.c1 : fallback;
    return { defs: '', fill: c || fallback };
  }
  if (typeof bg === 'string') return { defs: '', fill: bg };
  if (bg.style === 'solid') return { defs: '', fill: bg.c1 || fallback };
  // gradient
  const id = nid();
  const c1 = bg.c1 || fallback, c2 = bg.c2 || '#0b1f2c';
  return {
    defs: `<defs><linearGradient id="${id}" x1="0%" y1="0%" x2="100%" y2="100%">
<stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs>`,
    fill: `url(#${id})`,
  };
}

// CSS string for a background spec (used by animated HTML compositions)
function bgCss(bg, fallback) {
  if (!bg || (typeof bg === 'object' && (bg.style === 'auto' || !bg.style))) {
    return (typeof bg === 'object' && bg.c1) ? bg.c1 : fallback;
  }
  if (typeof bg === 'string') return bg;
  if (bg.style === 'solid') return bg.c1 || fallback;
  return `linear-gradient(135deg, ${bg.c1 || fallback}, ${bg.c2 || '#0b1f2c'})`;
}

// resolve a frame radius: explicit number wins, otherwise seeded per image
const frameRadius = (rng, radius) => (Number.isFinite(radius) ? radius : Math.round(range(rng, 8, 28)));

// slice a full-page screenshot: width-fit to w, then a window of height h
// starting at offsetRatio of the scrollable page (clamped so it never runs
// past the real end — controlled cropping only)
async function pageSegment(buf, w, h, offsetRatio, { scale = 1.5, quality = 76 } = {}) {
  const tw = Math.round(w * scale), th = Math.round(h * scale);
  const resized = await sharp(buf).resize({ width: tw }).toBuffer();
  const m = await sharp(resized).metadata();
  let top = Math.round((m.height - th) * Math.max(0, Math.min(1, offsetRatio)));
  if (top < 0) top = 0;
  let out;
  if (m.height <= th) {
    out = await sharp(resized).extend({ bottom: th - m.height, background: '#ffffff' });
  } else {
    out = await sharp(resized).extract({ left: 0, top, width: tw, height: th });
  }
  const jpg = await out.flatten({ background: '#ffffff' }).jpeg(jpegOptions(quality)).toBuffer();
  return `data:image/jpeg;base64,${jpg.toString('base64')}`;
}

// segment picker: first pass hands out the TOP of every page; later passes
// walk down the same pages (0 -> 0.42 -> 0.8), so side-by-side segments of
// one page always read as a scroll progression and never repeat a viewport
function segmentPicker(rng, pages) {
  const order = shuffle(rng, pages);
  let i = 0, round = 0;
  const ROUNDS = [0, 0.45, 1]; // top -> middle -> end (footer included)
  return () => {
    if (!order.length) return null;
    if (i >= order.length) { i = 0; round++; }
    return { buffer: order[i++].buffer, offsetRatio: ROUNDS[round % ROUNDS.length] };
  };
}

// --- vector device frames; each returns SVG with the shot clipped inside ---

// Device screens use width-fit windows (pageSegment): the frame never crops
// the page horizontally, and offsetRatio picks top / middle / footer views.
async function phoneDevice(x, y, w, h, buf, { topOffset = 0 } = {}) {
  const bez = Math.max(10, Math.round(w * 0.032));
  const r = Math.round(w * 0.135);
  const sw = w - bez * 2, sh = h - bez * 2;
  const uri = await pageSegment(buf, sw, sh, topOffset, { scale: 2, quality: 80 });
  const id = nid();
  return `<g filter="url(#cardShadow)"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${FRAME}"/></g>
<defs>${clipRounded(id, x + bez, y + bez, sw, sh, r - bez)}</defs>
<image href="${uri}" x="${x + bez}" y="${y + bez}" width="${sw}" height="${sh}" clip-path="url(#${id})" preserveAspectRatio="xMidYMin slice"/>`;
}

async function tabletDevice(x, y, w, h, buf, { topOffset = 0 } = {}) {
  // slim, modern bezel
  const bez = Math.max(9, Math.round(w * 0.02));
  const r = Math.round(w * 0.045);
  const sw = w - bez * 2, sh = h - bez * 2;
  const uri = await pageSegment(buf, sw, sh, topOffset, { scale: 2, quality: 80 });
  const id = nid();
  return `<g filter="url(#cardShadow)"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${FRAME}"/></g>
<defs>${clipRounded(id, x + bez, y + bez, sw, sh, Math.max(6, r - bez))}</defs>
<image href="${uri}" x="${x + bez}" y="${y + bez}" width="${sw}" height="${sh}" clip-path="url(#${id})" preserveAspectRatio="xMidYMin slice"/>`;
}

// laptop: 16:10 screen in a bezel + a wider base deck below
// content is width-fit (never side-cropped) — pass a full-page capture
async function laptopDevice(x, y, w, buf) {
  const h = Math.round(w * 0.625);
  const bez = 14, r = 16;
  const sw = w - bez * 2, sh = h - bez * 2;
  const baseW = Math.round(w * 1.14), baseH = Math.max(20, Math.round(w * 0.022));
  const baseX = x - Math.round((baseW - w) / 2), baseY = y + h;
  const notchW = Math.round(baseW * 0.13);
  const uri = await pageSegment(buf, sw, sh, 0, { scale: 1.6, quality: 82 });
  const id = nid();
  return `<g filter="url(#cardShadow)">
<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${FRAME}"/>
<rect x="${baseX}" y="${baseY}" width="${baseW}" height="${baseH}" rx="${baseH / 2}" fill="#1a1e23"/>
<rect x="${baseX + (baseW - notchW) / 2}" y="${baseY}" width="${notchW}" height="${Math.round(baseH * 0.45)}" rx="${Math.round(baseH * 0.2)}" fill="#2c3238"/>
</g>
<defs>${clipRounded(id, x + bez, y + bez, sw, sh, 6)}</defs>
<image href="${uri}" x="${x + bez}" y="${y + bez}" width="${sw}" height="${sh}" clip-path="url(#${id})" preserveAspectRatio="xMidYMin slice"/>`;
}

// desktop monitor: 16:9 screen, chin, neck + foot
// content is width-fit (never side-cropped) — pass a full-page capture
async function desktopDevice(x, y, w, buf) {
  const h = Math.round(w * 0.5625);
  const bez = 16, chin = Math.max(30, Math.round(w * 0.035)), r = 18;
  const sw = w - bez * 2, sh = h - bez * 2;
  const neckW = Math.round(w * 0.07), neckH = Math.max(40, Math.round(w * 0.05));
  const footW = Math.round(w * 0.3), footH = 14;
  const uri = await pageSegment(buf, sw, sh, 0, { scale: 1.6, quality: 82 });
  const id = nid();
  return `<g filter="url(#cardShadow)">
<rect x="${x}" y="${y}" width="${w}" height="${h + chin}" rx="${r}" fill="${FRAME}"/>
<rect x="${x + (w - neckW) / 2}" y="${y + h + chin}" width="${neckW}" height="${neckH}" fill="#1a1e23"/>
<rect x="${x + (w - footW) / 2}" y="${y + h + chin + neckH}" width="${footW}" height="${footH}" rx="${footH / 2}" fill="#1a1e23"/>
</g>
<defs>${clipRounded(id, x + bez, y + bez, sw, sh, 8)}</defs>
<image href="${uri}" x="${x + bez}" y="${y + bez}" width="${sw}" height="${sh}" clip-path="url(#${id})" preserveAspectRatio="xMidYMin slice"/>`;
}

// crop N px (source-scale ratio 0..0.6) off the top of a tall screenshot
async function sliceTop(buf, ratio) {
  if (!ratio) return buf;
  const m = await sharp(buf).metadata();
  const top = Math.round(m.height * Math.min(ratio, 0.6));
  return sharp(buf).extract({ left: 0, top, width: m.width, height: m.height - top }).toBuffer();
}

const pickBuf = (rng, pages) => pages[Math.floor(rng() * pages.length)].buffer;

// draw-without-replacement sampler: within one image, every slot gets a
// DIFFERENT screen (only repeats once the pool is truly exhausted)
function sampler(rng, items, get = (x) => x.buffer) {
  let pool = shuffle(rng, items), i = 0;
  return () => {
    if (!pool.length) return null;
    if (i >= pool.length) { pool = shuffle(rng, pool); i = 0; }
    return get(pool[i++]);
  };
}

// --- mockup arrangements (1920x1080 on the accent color) ---

const MOCKUP_VARIANTS = {
  'three-phones': { needs: 'mobile' },
  'two-phones': { needs: 'mobile' },
  'phones-angled': { needs: 'mobile' },
  'tablet-solo': { needs: 'tablet' },
  'tablet-phone': { needs: 'tablet+mobile' },
  'phone-tablet': { needs: 'tablet+mobile' },
  'two-tablets': { needs: 'tablet' },
  'tablet-landscape': { needs: 'desktop' },
  'laptop-solo': { needs: 'desktop' },
  'laptop-phone': { needs: 'desktop+mobile' },
  'desktop-solo': { needs: 'desktop' },
  'desktop-phone': { needs: 'desktop+mobile' },
  'tablet-desktop': { needs: 'desktop+tablet' },
};

async function composeMockupImage(variant, { mobilePages, tabletPages, fullPages = [], heroes, bg, rng, brandColor }) {
  const W = 1920, H = 1080;
  const paint = bgPaint(bg, brandColor || '#0e2a3a');
  const parts = [`${paint.defs}<rect width="${W}" height="${H}" fill="${paint.fill}"/>`, SHADOW_DEF];
  // no-repeat samplers: multiple devices in one image never show the same screen
  const mob = sampler(rng, mobilePages);
  const tab = sampler(rng, tabletPages);
  const fp = fullPages.length ? sampler(rng, fullPages) : null;
  // laptop/desktop/landscape screens use FULL-PAGE captures (width-fit, never
  // side-cropped); the hero viewport shot is only a last-resort fallback
  const heroFallback = sampler(rng, heroes, (x) => x);
  const desk = () => (fp ? fp() : heroFallback());
  // secondary devices sometimes show the middle or the footer of the page
  const vary = () => pick(rng, [0, 0, 0.45, 1]);

  if (variant === 'three-phones') {
    const w = 430, h = 940, gap = 150, x0 = (W - w * 3 - gap * 2) / 2, y = (H - h) / 2;
    for (let i = 0; i < 3; i++) parts.push(await phoneDevice(x0 + i * (w + gap), y, w, h, mob(), { topOffset: i === 0 ? 0 : vary() }));
  } else if (variant === 'two-phones') {
    const w = 470, h = 1000, gap = 300, x0 = (W - w * 2 - gap) / 2;
    parts.push(await phoneDevice(x0, (H - h) / 2 - 40, w, h, mob()));
    parts.push(await phoneDevice(x0 + w + gap, (H - h) / 2 + 40, w, h, mob(), { topOffset: vary() }));
  } else if (variant === 'phones-angled') {
    const w = 460, h = 980, gap = 300, x0 = (W - w * 2 - gap) / 2;
    const a = pick(rng, [-7, 7]);
    parts.push(`<g transform="rotate(${a} ${W / 2} ${H / 2}) translate(${W / 2} ${H / 2}) scale(1.1) translate(${-W / 2} ${-H / 2})">`);
    parts.push(await phoneDevice(x0, (H - h) / 2 - 30, w, h, mob()));
    parts.push(await phoneDevice(x0 + w + gap, (H - h) / 2 + 50, w, h, mob(), { topOffset: vary() }));
    parts.push('</g>');
  } else if (variant === 'tablet-solo') {
    const w = 740, h = Math.round(w * 4 / 3), y = (H - h) / 2;
    parts.push(await tabletDevice((W - w) / 2, Math.max(46, y), w, h, tab()));
  } else if (variant === 'tablet-phone' || variant === 'phone-tablet') {
    const tw = 700, th = Math.round(tw * 4 / 3), pw = 350, ph = 760;
    const phoneRight = variant === 'tablet-phone';
    const tx = phoneRight ? 380 : W - 380 - tw;
    const px = phoneRight ? tx + tw + 110 : tx - pw - 110;
    parts.push(await tabletDevice(tx, (H - th) / 2, tw, th, tab()));
    parts.push(await phoneDevice(px, (H - ph) / 2 + 100, pw, ph, mob(), { topOffset: vary() }));
  } else if (variant === 'laptop-solo') {
    const w = 1340;
    parts.push(await laptopDevice((W - w) / 2, 105, w, desk()));
  } else if (variant === 'laptop-phone') {
    const w = 1150, pw = 340, ph = 740;
    parts.push(await laptopDevice(170, 140, w, desk()));
    parts.push(await phoneDevice(170 + w - 30, 250, pw, ph, mob(), { topOffset: vary() }));
  } else if (variant === 'desktop-solo') {
    const w = 1400;
    parts.push(await desktopDevice((W - w) / 2, 88, w, desk()));
  } else if (variant === 'two-tablets') {
    const w = 620, h = Math.round(w * 4 / 3), gap = 260, x0 = (W - w * 2 - gap) / 2;
    parts.push(await tabletDevice(x0, (H - h) / 2 - 36, w, h, tab()));
    parts.push(await tabletDevice(x0 + w + gap, (H - h) / 2 + 36, w, h, tab(), { topOffset: vary() }));
  } else if (variant === 'tablet-landscape') {
    // landscape tablet showing the desktop layout (left-anchored, keeps headlines)
    const w = 1310, h = Math.round(w * 3 / 4 * 0.92);
    parts.push(await tabletDevice((W - w) / 2, (H - h) / 2, w, h, fp ? fp() : desk()));
  } else if (variant === 'desktop-phone') {
    const w = 1200, pw = 340, ph = 740;
    const phoneLeft = rng() < 0.5;
    const dx = phoneLeft ? 550 : 170;
    parts.push(await desktopDevice(dx, 110, w, desk()));
    parts.push(await phoneDevice(phoneLeft ? dx - pw + 80 : dx + w - 80, 250, pw, ph, mob(), { topOffset: vary() }));
  } else if (variant === 'tablet-desktop') {
    const dw = 1120, tw = 500, th = Math.round(tw * 4 / 3);
    parts.push(await desktopDevice(150, 130, dw, desk()));
    parts.push(await tabletDevice(150 + dw - 60, (H - th) / 2 + 80, tw, th, tab(), { topOffset: vary() }));
  }
  return `${svgOpen(W, H)}${parts.join('\n')}</svg>`;
}

async function composeMockupSet({ mobilePages = [], tabletPages = [], fullPages = [], heroes = [], brandColor, bg, rng, count = 4, exclude = [], devices }) {
  const on = (d) => !devices || devices[d] !== false;
  let available = Object.keys(MOCKUP_VARIANTS).filter((v) => {
    const n = MOCKUP_VARIANTS[v].needs;
    if (n.includes('mobile') && (!mobilePages.length || !on('mobile'))) return false;
    if (n.includes('tablet') && (!tabletPages.length || !on('tablet'))) return false;
    if (n.includes('desktop') && (!heroes.length || !on('desktop'))) return false;
    return true;
  });
  // regenerate: never redraw the arrangement the image currently shows
  if (exclude.length && available.some((v) => !exclude.includes(v))) {
    available = available.filter((v) => !exclude.includes(v));
  }
  if (!available.length) return [];
  const order = shuffle(rng, available);
  const out = [];
  for (let i = 0; i < count; i++) {
    const variant = order[i % order.length];
    out.push({
      variant,
      svg: await composeMockupImage(variant, { mobilePages, tabletPages, fullPages, heroes, bg, brandColor, rng }),
    });
  }
  return out;
}

// --- showcase variants (1920x1080 on the portfolio background) ---

// light = 1-3 large screens, generous spacing, premium & minimal;
// dense = 4-6 screens as a full-bleed organized wall
const SHOWCASE_LIGHT = ['solo', 'duo', 'trio', 'solo-angled', 'duo-angled', 'trio-angled'];
const SHOWCASE_DENSE = ['dense-4', 'dense-5', 'dense-6', 'dense-4-angled', 'dense-5-angled', 'dense-6-angled'];

// One balanced rectangle: N full-height vertical strips (mixed device widths)
// filling the entire canvas edge-to-edge with consistent gaps. Each strip is a
// full-page screenshot windowed at a scroll offset — long pages contribute
// multiple, meaningfully different segments in scroll order. Angled variants
// tilt the whole wall with enough overfill that corners never show through.
async function composeScreensImage(variant, { fullPages, tabletPages = [], mobilePages, bg, rng, devices, radius, wantLayout = false }) {
  const W = 1920, H = 1080;
  const dense = variant.startsWith('dense');
  const n = dense ? parseInt(variant.split('-')[1], 10)
    : variant.startsWith('solo') ? 1 : variant.startsWith('duo') ? 2 : 3;
  const angle = variant.endsWith('angled') ? pick(rng, [-8, -5, 5, 8]) : 0;
  const paint = bgPaint(bg, LIGHT_BG);
  const R = frameRadius(rng, radius);
  const layout = { W: 1920, H: 1080, bgCss: bgCss(bg, LIGHT_BG), angle, scale: 1, items: [] };

  const ratio = { desktop: 3, tablet: 2.2, mobile: 1.5 };
  const avail = [];
  if (fullPages.length && (!devices || devices.desktop !== false)) avail.push('desktop');
  if (tabletPages.length && (!devices || devices.tablet !== false)) avail.push('tablet');
  if (mobilePages.length && (!devices || devices.mobile !== false)) avail.push('mobile');
  if (!avail.length) {
    if (fullPages.length) avail.push('desktop');
    else if (mobilePages.length) avail.push('mobile');
    else return `${svgOpen(W, H)}${paint.defs}<rect width="${W}" height="${H}" fill="${paint.fill}"/></svg>`;
  }
  const types = shuffle(rng, Array.from({ length: n }, (_, i) => avail[i % avail.length]));
  const seg = {
    desktop: segmentPicker(rng, fullPages),
    tablet: segmentPicker(rng, tabletPages),
    mobile: segmentPicker(rng, mobilePages),
  };
  const parts = [`${paint.defs}<rect width="${W}" height="${H}" fill="${paint.fill}"/>`, SHADOW_DEF];
  const inner = [];

  if (!dense) {
    // premium minimal: 1-3 large screens with generous horizontal spacing —
    // but every screen bleeds past the top AND bottom edges, so a screenshot's
    // start or end corner is never visible inside the frame
    const bleed = Math.round(range(rng, 120, 220));
    const yTop = -bleed, stripH = H + bleed * 2;
    const GAP = Math.round(range(rng, 100, 150));
    const maxSpan = W * (n === 1 ? 0.56 : 0.9);
    const sumR = types.reduce((a, t) => a + ratio[t], 0);
    const unit = (maxSpan - GAP * (n - 1)) / sumR;
    const totalW = Math.round(sumR * unit) + GAP * (n - 1);
    let x = Math.round((W - totalW) / 2);
    for (const t of types) {
      const w = Math.round(ratio[t] * unit);
      // prefer a page long enough to fill the whole strip (no visible ends)
      let s = seg[t]();
      let bestS = s, bestH = 0;
      for (let tries = 0; tries < 3; tries++) {
        const m = await sharp(s.buffer).metadata();
        const scaledH = m.height * ((w * 1.5) / m.width);
        if (scaledH >= stripH * 1.5) { bestS = s; break; }
        if (scaledH > bestH) { bestH = scaledH; bestS = s; }
        s = seg[t]();
      }
      s = bestS;
      const uri = await pageSegment(s.buffer, w, stripH, s.offsetRatio, { scale: 1.5 });
      const id = nid();
      const item = { x, y: yTop, w, h: stripH, r: R, uri };
      if (wantLayout) {
        const m2 = await sharp(s.buffer).metadata();
        const tallH = Math.min(Math.round(m2.height * (w / m2.width)), Math.round(stripH * 3.2));
        item.uriTall = await widthFitDataUri(s.buffer, w, tallH, { scale: 1.2, quality: 74 });
        item.tallH = tallH;
        item.scroll = Math.max(0, tallH - stripH);
      }
      layout.items.push(item);
      inner.push(`<defs>${clipRounded(id, x, yTop, w, stripH, R)}</defs>
<g filter="url(#cardShadow)"><rect x="${x}" y="${yTop}" width="${w}" height="${stripH}" rx="${R}" fill="#fff"/></g>
<image href="${uri}" x="${x}" y="${yTop}" width="${w}" height="${stripH}" clip-path="url(#${id})" preserveAspectRatio="xMidYMin slice"/>`);
      x += w + GAP;
    }
  } else {
    // organized wall: full-bleed rectangle of full-height strips
    const GAP = Math.round(range(rng, 26, 40));
    const over = angle ? 300 : 0;
    const spanW = W + over * 2;
    const sumR = types.reduce((a, t) => a + ratio[t], 0);
    const unit = (spanW - GAP * (n - 1)) / sumR;
    const yTop = -(angle ? 220 : 0), yBottom = H + (angle ? 220 : 0);
    const stripH = yBottom - yTop;
    let x = -over;
    for (const t of types) {
      const w = Math.round(ratio[t] * unit);
      // prefer a page long enough to fill the whole strip (no white tail)
      let s = seg[t]();
      let bestS = s, bestH = 0;
      for (let tries = 0; tries < 3; tries++) {
        const m = await sharp(s.buffer).metadata();
        const scaledH = m.height * ((w * 1.3) / m.width);
        if (scaledH >= stripH * 1.3) { bestS = s; break; }
        if (scaledH > bestH) { bestH = scaledH; bestS = s; }
        s = seg[t]();
      }
      s = bestS;
      const uri = await pageSegment(s.buffer, w, stripH, s.offsetRatio, { scale: 1.3 });
      const id = nid();
      const r = angle ? Math.min(R, 16) : 0;
      const item = { x, y: yTop, w, h: stripH, r, uri };
      if (wantLayout) {
        const m2 = await sharp(s.buffer).metadata();
        const tallH = Math.min(Math.round(m2.height * (w / m2.width)), Math.round(stripH * 3.2));
        item.uriTall = await widthFitDataUri(s.buffer, w, tallH, { scale: 1.1, quality: 72 });
        item.tallH = tallH;
        item.scroll = Math.max(0, tallH - stripH);
      }
      layout.items.push(item);
      inner.push(`<defs>${clipRounded(id, x, yTop, w, stripH, r)}</defs>
<g filter="url(#cardShadow)"><rect x="${x}" y="${yTop}" width="${w}" height="${stripH}" rx="${r}" fill="#fff"/></g>
<image href="${uri}" x="${x}" y="${yTop}" width="${w}" height="${stripH}" clip-path="url(#${id})" preserveAspectRatio="xMidYMin slice"/>`);
      x += w + GAP;
    }
  }
  if (angle) {
    layout.scale = dense ? 1.12 : 1.02;
    parts.push(`<g transform="rotate(${angle} ${W / 2} ${H / 2}) translate(${W / 2} ${H / 2}) scale(${layout.scale}) translate(${-W / 2} ${-H / 2})">`, ...inner, '</g>');
  } else {
    parts.push(...inner);
  }
  const svg = `${svgOpen(W, H)}${parts.join('\n')}</svg>`;
  return wantLayout ? { svg, layout } : svg;
}

async function composeShowcaseImage(variant, { fullPages, mobilePages, sections, heroTall, hero, bg, rng }) {
  const W = 1920, H = 1080;
  if (variant === 'collage') return composeShowcase({ fullPages, mobilePages, rng, bg, forceAngle: 0, forceZoom: 1 });
  if (variant === 'collage-tilted') return composeShowcase({ fullPages, mobilePages, rng, bg, forceAngle: pick(rng, [-11, -7, 7, 11]) });
  if (variant === 'collage-zoom') return composeShowcase({ fullPages, mobilePages, rng, bg, forceAngle: 0, forceZoom: pick(rng, [0.85, 1.15]) });

  const parts = [`<rect width="${W}" height="${H}" fill="${bg}"/>`, SHADOW_DEF];
  if (variant === 'pages-trio') {
    const w = 560, h = 930, gap = 60, x0 = (W - w * 3 - gap * 2) / 2;
    const pool = shuffle(rng, fullPages);
    for (let i = 0; i < 3; i++) {
      const y = (H - h) / 2 + (i === 1 ? -34 : 34);
      const uri = await widthFitDataUri(pool[i % pool.length].buffer, w, h, { scale: 1.6, quality: 78 });
      const id = nid();
      parts.push(`<defs>${clipRounded(id, x0 + i * (w + gap), y, w, h, 12)}</defs>
<g filter="url(#cardShadow)"><rect x="${x0 + i * (w + gap)}" y="${y}" width="${w}" height="${h}" rx="12" fill="#fff"/></g>
<image href="${uri}" x="${x0 + i * (w + gap)}" y="${y}" width="${w}" height="${h}" clip-path="url(#${id})" preserveAspectRatio="xMidYMin slice"/>`);
    }
  } else if (variant === 'sections-duo') {
    // two wide section cards, offset diagonally; sources: real sections +
    // random slices of full pages
    const srcs = [...sections];
    while (srcs.length < 2 && fullPages.length) {
      srcs.push(await sliceTop(pickBuf(rng, fullPages), range(rng, 0.15, 0.45)));
    }
    const w = 1060, h = 430;
    const spots = [{ x: 140, y: 120 }, { x: W - 140 - w, y: H - 120 - h }];
    for (let i = 0; i < 2 && srcs[i]; i++) {
      const uri = await coverDataUri(srcs[i], w, h, { scale: 1.5, quality: 80 });
      const id = nid();
      parts.push(`<defs>${clipRounded(id, spots[i].x, spots[i].y, w, h, 16)}</defs>
<g filter="url(#cardShadow)"><rect x="${spots[i].x}" y="${spots[i].y}" width="${w}" height="${h}" rx="16" fill="#fff"/></g>
<image href="${uri}" x="${spots[i].x}" y="${spots[i].y}" width="${w}" height="${h}" clip-path="url(#${id})" preserveAspectRatio="xMidYMin slice"/>`);
    }
  } else if (variant === 'feature') {
    // one large hero shot pushed off an edge, optionally slightly tilted
    const src = heroTall || hero || (fullPages[0] && fullPages[0].buffer);
    const w = Math.round(range(rng, 1250, 1450));
    const h = Math.round(w * 0.86);
    const side = pick(rng, ['left', 'right']);
    const x = side === 'right' ? W - w + 120 : -120;
    const y = Math.round(range(rng, 100, 180));
    const a = pick(rng, [0, 0, -3, 3]);
    const uri = await coverDataUri(src, w, h, { scale: 1.4, quality: 83 });
    const id = nid();
    parts.push(`<g transform="rotate(${a} ${W / 2} ${H / 2})">
<defs>${clipRounded(id, x, y, w, h, 18)}</defs>
<g filter="url(#cardShadow)"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="#fff"/></g>
<image href="${uri}" x="${x}" y="${y}" width="${w}" height="${h}" clip-path="url(#${id})" preserveAspectRatio="xMidYMin slice"/>
</g>`);
  }
  return `${svgOpen(W, H)}${parts.join('\n')}</svg>`;
}

// A full set is half light (2-4 screens), half dense (4-6 screens).
// `family` locks regeneration to the image's existing density family.
async function composeShowcaseSet({ fullPages = [], tabletPages = [], mobilePages = [], bg, rng, count = 4, exclude = [], family, devices, radius }) {
  const listFor = (fam) => {
    let l = fam === 'dense' ? SHOWCASE_DENSE : SHOWCASE_LIGHT;
    if (exclude.length && l.some((v) => !exclude.includes(v))) l = l.filter((v) => !exclude.includes(v));
    return l;
  };
  // 50/50 split, light first then dense (e.g. 4 -> LLDD, 6 -> LLLDDD)
  const plan = family
    ? Array(count).fill(family)
    : Array.from({ length: count }, (_, i) => (i < Math.ceil(count / 2) ? 'light' : 'dense'));
  const orders = { light: shuffle(rng, listFor('light')), dense: shuffle(rng, listFor('dense')) };
  const idx = { light: 0, dense: 0 };
  const out = [];
  for (const fam of plan) {
    const variant = orders[fam][idx[fam]++ % orders[fam].length];
    out.push({
      variant,
      svg: await composeScreensImage(variant, { fullPages, tabletPages, mobilePages, bg, rng, devices }),
    });
  }
  return out;
}

// Display set: the corner composition (1920x1080) + a clean full-bleed hero
async function composeFeaturedSet({ heroTall, hero, brandColor, bg, rng, radius }) {
  const paint = bgPaint(bg, brandColor);
  return {
    featured: await composeFeatured({ heroTall, hero, brandPaint: paint, rng, radius }),
    hero: await composeLanding({ hero }),
  };
}

// --- logo set: square mark (favicon) + wordmark, on brand or light bg ---

async function logoTile(asset, W, H, inset, bg) {
  let inner = '';
  if (asset && asset.type === 'svg') {
    inner = inlineNestedSvg(asset.svg, inset, inset, W - inset * 2, H - inset * 2) || '';
    if (!inner) {
      try {
        const png = await sharp(Buffer.from(asset.svg), { density: 300 }).resize({ width: (W - inset * 2) * 2, height: (H - inset * 2) * 2, fit: 'inside' }).png().toBuffer();
        inner = `<image href="data:image/png;base64,${png.toString('base64')}" x="${inset}" y="${inset}" width="${W - inset * 2}" height="${H - inset * 2}" preserveAspectRatio="xMidYMid meet"/>`;
      } catch {}
    }
  } else if (asset && asset.type === 'raster') {
    const uri = await toDataUri(asset.buffer, { format: 'png' });
    inner = `<image href="${uri}" x="${inset}" y="${inset}" width="${W - inset * 2}" height="${H - inset * 2}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  return `${svgOpen(W, H)}<rect width="${W}" height="${H}" fill="${bg}"/>${inner}</svg>`;
}

// aspect ratio of a logo asset (width/height); 1 when unknown
async function logoAspect(asset) {
  try {
    if (!asset) return 1;
    if (asset.type === 'raster') {
      const m = await sharp(asset.buffer).metadata();
      return m.width && m.height ? m.width / m.height : 1;
    }
    const open = (asset.svg.match(/<svg[^>]*>/i) || [''])[0];
    const vb = open.match(/viewBox=["']([\d.\s+-]+)["']/i);
    if (vb) {
      const p = vb[1].trim().split(/[\s,]+/).map(Number);
      if (p[2] > 0 && p[3] > 0) return p[2] / p[3];
    }
    const w = parseFloat((open.match(/width=["']?([\d.]+)/i) || [])[1]);
    const h = parseFloat((open.match(/height=["']?([\d.]+)/i) || [])[1]);
    return w > 0 && h > 0 ? w / h : 1;
  } catch { return 1; }
}

// assets: 'both' | 'icon' | 'wordmark'
// icon 1080x1080; wordmark 1080 tall, width follows the logo's aspect ratio
async function composeLogoSet({ logo, mark, brandColor, logoIsLight, altBg = false, bg, assets = 'both' }) {
  const flip = altBg ? !logoIsLight : logoIsLight;
  const autoBg = flip ? brandColor : (isDark(brandColor) ? '#f2f0eb' : brandColor);
  const paint = bgPaint(bg, autoBg);
  const tileBg = paint.fill.startsWith('url(') ? { defs: paint.defs, fill: paint.fill } : { defs: '', fill: paint.fill };
  const tile = async (asset, W, H, inset) => {
    const svg = await logoTile(asset, W, H, inset, tileBg.fill === 'transparent' ? autoBg : tileBg.fill);
    return tileBg.defs ? svg.replace(/(<svg[^>]*>)/, `$1${tileBg.defs}`) : svg;
  };
  const out = {};
  if (assets !== 'wordmark') out.logo = await tile(mark || logo, 1080, 1080, 270);
  if (assets !== 'icon') {
    const asp = await logoAspect(logo || mark);
    const contentH = 460;
    const W = Math.max(1080, Math.min(2800, Math.round(contentH * Math.max(asp, 0.6) + 2 * 300)));
    out.wordmark = await tile(logo || mark, W, 1080, 300);
  }
  return out;
}

// Simple screenshot tile: plain full-bleed, or boxed on a background with a
// rounded frame. Canvas adapts to the shot's own dimensions.
async function composeShotImage(buf, { boxed = false, bg, brandColor, rng, radius }) {
  const meta = await sharp(buf).metadata();
  const shotW = Math.round(meta.width / 2) || meta.width; // captures are 2x retina
  const shotH = Math.round(meta.height / 2) || meta.height;
  if (!boxed) {
    const uri = `data:image/jpeg;base64,${(await sharp(buf).flatten({ background: '#ffffff' }).jpeg(jpegOptions(94)).toBuffer()).toString('base64')}`;
    return `${svgOpen(shotW, shotH)}<image href="${uri}" x="0" y="0" width="${shotW}" height="${shotH}" preserveAspectRatio="xMidYMin slice"/></svg>`;
  }
  const R = frameRadius(rng, radius);
  const pad = Math.round(Math.min(shotW, shotH) * 0.09);
  const W = shotW + pad * 2, H = shotH + pad * 2;
  const paint = bgPaint(bg, brandColor || LIGHT_BG);
  const uri = `data:image/jpeg;base64,${(await sharp(buf).flatten({ background: '#ffffff' }).jpeg(jpegOptions(94)).toBuffer()).toString('base64')}`;
  const id = nid();
  return `${svgOpen(W, H)}
${paint.defs}<rect width="${W}" height="${H}" fill="${paint.fill}"/>
${SHADOW_DEF}
<defs>${clipRounded(id, pad, pad, shotW, shotH, R)}</defs>
<g filter="url(#cardShadow)"><rect x="${pad}" y="${pad}" width="${shotW}" height="${shotH}" rx="${R}" fill="#fff"/></g>
<image href="${uri}" x="${pad}" y="${pad}" width="${shotW}" height="${shotH}" clip-path="url(#${id})" preserveAspectRatio="xMidYMin slice"/>
</svg>`;
}

module.exports = { composeAll, composeOne, composeLogoSet, composeMockupSet, composeMockupImage, composeShowcaseSet, composeFeaturedSet, composeShotImage, composeScreensImage, MOCKUP_VARIANTS, SHOWCASE_LIGHT, SHOWCASE_DENSE, bgCss };
