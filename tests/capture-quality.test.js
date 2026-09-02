const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { analyzeCapture, chooseBestCapture } = require('../lib/quality');

async function solid(width, height, color = '#ffffff') {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

async function detailed(width, height) {
  const rows = Array.from({ length: 14 }, (_, index) => {
    const top = Math.round(index * height / 14);
    const rowHeight = Math.ceil(height / 14);
    const fill = index % 2 ? '#173b65' : '#f4b84a';
    return `<rect y="${top}" width="${width}" height="${rowHeight}" fill="${fill}"/><text x="48" y="${top + 72}" font-size="48" fill="white">Section ${index + 1}</text>`;
  }).join('');
  return sharp(Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${rows}</svg>`)).png().toBuffer();
}

test('capture analysis rejects an empty image and accepts detailed page content', async () => {
  const [empty, page] = await Promise.all([solid(1440, 3600), detailed(1440, 3600)]);
  const [emptyQuality, pageQuality] = await Promise.all([
    analyzeCapture(empty, { viewportHeight: 900 }),
    analyzeCapture(page, { viewportHeight: 900 }),
  ]);
  assert.equal(emptyQuality.usable, false);
  assert.equal(pageQuality.usable, true);
  assert.ok(pageQuality.score > emptyQuality.score);
});

test('best-capture selection prefers a usable candidate over the latest attempt', async () => {
  const [empty, page] = await Promise.all([solid(1440, 2200), detailed(1440, 2200)]);
  const candidates = [
    { label: 'complete', buffer: page, quality: await analyzeCapture(page) },
    { label: 'reload', buffer: empty, quality: await analyzeCapture(empty) },
  ];
  assert.equal(chooseBestCapture(candidates).label, 'complete');
});
