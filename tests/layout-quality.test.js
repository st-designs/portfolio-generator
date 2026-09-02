const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
  composeMockupImage,
  composeScreensImage,
  MOCKUP_VARIANTS,
  SHOWCASE_LIGHT,
  SHOWCASE_DENSE,
} = require('../lib/compose');

const rng = () => 0.37;

async function patterned(width, height, hue) {
  const bands = Array.from({ length: 8 }, (_, i) => {
    const y = Math.round(i * height / 8);
    const h = Math.ceil(height / 8);
    const light = 28 + (i % 4) * 13;
    return `<rect y="${y}" width="${width}" height="${h}" fill="hsl(${hue} 45% ${light}%)"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${bands}<rect x="${width * .08}" y="${height * .04}" width="${width * .58}" height="${height * .035}" rx="18" fill="white"/><circle cx="${width * .82}" cy="${height * .06}" r="${width * .035}" fill="white"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function contentRatio(svg) {
  const { data, info } = await sharp(Buffer.from(svg)).resize(96, 54).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const corner = [data[0], data[1], data[2]];
  let changed = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const d = Math.abs(data[i] - corner[0]) + Math.abs(data[i + 1] - corner[1]) + Math.abs(data[i + 2] - corner[2]);
    if (d > 28) changed++;
  }
  return changed / (data.length / info.channels);
}

test('every mockup variant renders visible, balanced content', async () => {
  const [desktop, tablet, mobile] = await Promise.all([
    patterned(1440, 4200, 215), patterned(834, 3600, 335), patterned(390, 3000, 150),
  ]);
  const input = {
    fullPages: [{ buffer: desktop }, { buffer: desktop }],
    heroes: [desktop],
    tabletPages: [{ buffer: tablet }, { buffer: tablet }],
    mobilePages: [{ buffer: mobile }, { buffer: mobile }, { buffer: mobile }],
    bg: { style: 'solid', c1: '#e8e9ed' },
    brandColor: '#3b4a9e',
    rng,
  };
  for (const variant of Object.keys(MOCKUP_VARIANTS)) {
    const svg = await composeMockupImage(variant, input);
    assert.match(svg, /width="1920" height="1080"/, `${variant} canvas`);
    assert.match(svg, /<image\b/, `${variant} has a captured screen`);
    assert.ok(await contentRatio(svg) > 0.16, `${variant} should not be mostly empty`);
  }
});

test('every showcase variant fills the canvas with real screens', async () => {
  const [desktop, tablet, mobile] = await Promise.all([
    patterned(1440, 4200, 215), patterned(834, 3600, 335), patterned(390, 3000, 150),
  ]);
  const input = {
    fullPages: [{ buffer: desktop }, { buffer: desktop }, { buffer: desktop }],
    tabletPages: [{ buffer: tablet }, { buffer: tablet }],
    mobilePages: [{ buffer: mobile }, { buffer: mobile }, { buffer: mobile }],
    bg: { style: 'solid', c1: '#e8e9ed' },
    devices: { desktop: true, tablet: true, mobile: true },
    rng,
  };
  for (const variant of [...SHOWCASE_LIGHT, ...SHOWCASE_DENSE]) {
    const svg = await composeScreensImage(variant, input);
    assert.match(svg, /<image\b/, `${variant} has captured screens`);
    assert.ok(await contentRatio(svg) > 0.34, `${variant} should use the canvas well`);
  }
});
