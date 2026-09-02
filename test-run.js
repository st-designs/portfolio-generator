// One-shot CLI test: node test-run.js <url> [phase]
// phase "capture": capture + save raw assets to .test-cache
// phase "compose": compose SVGs from .test-cache
const fs = require('fs');
const path = require('path');
const CACHE = path.join(__dirname, '.test-cache');

(async () => {
  const url = process.argv[2];
  const phase = process.argv[3] || 'all';

  if (phase === 'capture' || phase === 'all') {
    const { capture } = require('./lib/capture');
    const t0 = Date.now();
    const captured = await capture(url, {
      onLog: (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`),
      pages: process.env.TEST_PAGES ? process.env.TEST_PAGES.split(',') : [],
    });
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(path.join(CACHE, 'meta.json'), JSON.stringify({
      meta: captured.meta,
      logoType: captured.logo ? captured.logo.type : null,
      logoSvg: captured.logo && captured.logo.type === 'svg' ? captured.logo.svg : null,
      fullPageUrls: captured.fullPages.map((f) => f.url),
      mobileUrls: captured.mobilePages.map((m) => m.url),
    }, null, 2));
    if (captured.logo && captured.logo.type === 'raster') fs.writeFileSync(path.join(CACHE, 'logo.bin'), captured.logo.buffer);
    fs.writeFileSync(path.join(CACHE, 'hero.png'), captured.screenshots.hero);
    if (captured.screenshots.heroTall) fs.writeFileSync(path.join(CACHE, 'hero-tall.png'), captured.screenshots.heroTall);
    fs.writeFileSync(path.join(CACHE, 'section.png'), captured.screenshots.section || captured.screenshots.hero);
    captured.fullPages.forEach((f, i) => fs.writeFileSync(path.join(CACHE, `full-${i}.png`), f.buffer));
    captured.mobilePages.forEach((m, i) => fs.writeFileSync(path.join(CACHE, `mobile-${i}.png`), m.buffer));
    console.log('CAPTURE SAVED');
    if (phase === 'capture') return;
  }

  if (phase === 'compose' || phase === 'all') {
    const { composeAll } = require('./lib/compose');
    const saved = JSON.parse(fs.readFileSync(path.join(CACHE, 'meta.json'), 'utf8'));
    const captured = {
      meta: saved.meta,
      logo: saved.logoType === 'svg' ? { type: 'svg', svg: saved.logoSvg }
        : saved.logoType === 'raster' ? { type: 'raster', buffer: fs.readFileSync(path.join(CACHE, 'logo.bin')) } : null,
      screenshots: {
        hero: fs.readFileSync(path.join(CACHE, 'hero.png')),
        heroTall: fs.existsSync(path.join(CACHE, 'hero-tall.png')) ? fs.readFileSync(path.join(CACHE, 'hero-tall.png')) : null,
        section: fs.readFileSync(path.join(CACHE, 'section.png')),
      },
      fullPages: saved.fullPageUrls.map((u, i) => ({ url: u, buffer: fs.readFileSync(path.join(CACHE, `full-${i}.png`)) })),
      mobilePages: saved.mobileUrls.map((u, i) => ({ url: u, buffer: fs.readFileSync(path.join(CACHE, `mobile-${i}.png`)) })),
    };
    const svgs = await composeAll(captured, console.log, process.env.SEED);
    delete svgs.__seed;
    const outDir = path.join(__dirname, 'output', 'test');
    fs.mkdirSync(outDir, { recursive: true });
    for (const [name, svg] of Object.entries(svgs)) {
      fs.writeFileSync(path.join(outDir, `${name}.svg`), svg);
      console.log(`wrote output/test/${name}.svg (${(svg.length / 1024).toFixed(0)} KB)`);
    }
    console.log('COMPOSE DONE');
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
