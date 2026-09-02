#!/usr/bin/env node
/**
 * Terminal mode — generate the portfolio set without the web UI.
 *
 *   node cli.js <url> [url2] [--seed=42] [--pages=/about,/services]
 *               [--no-logo] [--no-mockups] [--no-showcase]
 *   npm run generate -- https://example.com
 *
 * Multiple URLs mix screenshots across sites (logo/colors from the first).
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { capture } = require('./lib/capture');
const { composeLogoSet, composeMockupSet, composeShowcaseSet, composeFeaturedSet } = require('./lib/compose');

function siteName(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host.split('.')[0].replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'site';
  } catch { return 'site'; }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

(async () => {
  const args = process.argv.slice(2);
  let urls = args.filter((a) => !a.startsWith('--'));
  const opt = (name, def) => ((args.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || def);
  const flag = (name) => args.includes(`--${name}`);

  console.log('\n  Portfolio Generator — terminal mode\n');
  if (!urls.length) {
    const u = await ask('  Website URL (e.g. https://example.com): ');
    if (!u) { console.log('  No URL given, exiting.'); process.exit(1); }
    urls = [u];
  }
  urls = urls.map((u) => (/^https?:\/\//i.test(u) ? u : 'https://' + u)).slice(0, 3);

  const slug = siteName(urls[0]) + (urls.length > 1 ? '-mix' : '');
  let OUT_DIR = process.env.OUTPUT_DIR;
  if (!OUT_DIR) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
      if (cfg.outputDir && fs.existsSync(cfg.outputDir)) OUT_DIR = cfg.outputDir;
    } catch {}
  }
  if (!OUT_DIR) OUT_DIR = path.join(__dirname, 'Generated');
  const outDir = path.join(OUT_DIR, slug);
  const t0 = Date.now();
  const log = (m) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] ${m}`);

  console.log(`  Generating portfolio set for ${urls.join(' + ')}`);
  console.log(`  Output folder: ${outDir}\n`);

  try {
    const pages = opt('pages', '') ? opt('pages', '').split(',').map((p) => p.trim()) : [];
    const wantMockups = !flag('no-mockups');
    const caps = [];
    for (const u of urls) caps.push(await capture(u, { pages, onLog: log, tablet: wantMockups }));

    const requestedSeed = Number.parseInt(opt('seed', ''), 10);
    const seed = Number.isFinite(requestedSeed) ? requestedSeed : Math.floor(Math.random() * 1e9);
    const rng = mulberry32(seed);
    const first = caps[0];
    const pools = {
      fullPages: caps.flatMap((c) => c.fullPages),
      mobilePages: caps.flatMap((c) => c.mobilePages),
      tabletPages: caps.flatMap((c) => c.tabletPages || []),
      heroes: caps.map((c) => c.screenshots.hero).filter(Boolean),
      sections: caps.map((c) => c.screenshots.section).filter(Boolean),
      heroTall: first.screenshots.heroTall,
      hero: first.screenshots.hero,
    };

    fs.mkdirSync(outDir, { recursive: true });
    const write = (key, svg) => { fs.writeFileSync(path.join(outDir, `${slug}-${key}.svg`), svg); log(`wrote ${slug}-${key}.svg`); };

    if (!flag('no-logo')) {
      const set = await composeLogoSet({ logo: first.logo, mark: first.mark, brandColor: first.meta.brandColor, logoIsLight: first.meta.logoIsLight });
      for (const [k, svg] of Object.entries(set)) write(k, svg);
    }
    if (wantMockups) {
      const set = await composeMockupSet({ ...pools, brandColor: first.meta.brandColor, rng, count: 4 });
      set.forEach((m, i) => write(`mockup-${i + 1}`, m.svg));
    }
    if (!flag('no-showcase')) {
      const set = await composeShowcaseSet({ ...pools, rng, count: 4 });
      set.forEach((m, i) => write(`showcase-${i + 1}`, m.svg));
    }
    if (!flag('no-featured')) {
      const set = await composeFeaturedSet({ heroTall: pools.heroTall, hero: pools.hero, brandColor: first.meta.brandColor, rng });
      write('featured', set.featured);
      write('hero', set.hero);
    }

    console.log(`\n  Done in ${((Date.now() - t0) / 1000).toFixed(0)}s.`);
    console.log(`  Layout seed: ${seed}  (run with --seed=${seed} to reproduce)\n`);
  } catch (e) {
    console.error(`\n  FAILED: ${e.message}\n`);
    process.exit(1);
  }
})();
