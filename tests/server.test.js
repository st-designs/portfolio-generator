const test = require('node:test');
const assert = require('node:assert/strict');

process.env.OUTPUT_DIR = process.env.OUTPUT_DIR || '/private/tmp/portfolio-generator-tests';
process.env.SETTINGS_FILE = process.env.SETTINGS_FILE || '/private/tmp/portfolio-generator-tests-settings.json';
const { siteName, siteDisplayName, parseSections, parseStyle, parseSeed, qcCheck, outputLocation, ffmpegArgs } = require('../server');

test('siteName keeps ordinary domains concise and IP addresses collision-safe', () => {
  assert.equal(siteName('https://www.example.com/work'), 'example');
  assert.equal(siteName('http://127.0.0.1:4477'), '127-0-0-1');
});

test('siteDisplayName preserves explicit website metadata and safely falls back', () => {
  assert.equal(siteDisplayName({ siteName: 'Example Studio' }, 'example'), 'Example Studio');
  assert.equal(siteDisplayName({ title: 'Example' }, 'example'), 'Example');
  assert.equal(siteDisplayName({ title: 'Award-winning websites | Example' }, 'example'), 'example');
});

test('section and style input is bounded', () => {
  const sections = parseSections({ mockups: { count: 99, radius: 1000 }, screenshots: { on: true } });
  assert.equal(sections.mockups.count, 4);
  assert.equal(sections.mockups.radius, undefined);
  assert.equal(sections.screenshots.on, true);
  const style = parseStyle({ radius: 200, extraWait: 90, patience: 'forever' });
  assert.equal(style.radius, 100);
  assert.equal(style.extraWait, 30);
  assert.equal(style.patience, 'normal');
});

test('layout seed zero remains reproducible', () => {
  assert.equal(parseSeed('0', () => 0.75), 0);
  assert.equal(parseSeed('', () => 0.75), 750000000);
});

test('QC accepts a compact vector logo and rejects an empty canvas', () => {
  const messages = [];
  const logo = '<svg width="1080" height="1080" viewBox="0 0 1080 1080"><svg viewBox="0 0 20 20"><path d="M0 0h20v20z"/></svg></svg>';
  assert.equal(qcCheck('logo', logo, (m) => messages.push(m)), true);
  assert.equal(messages.length, 0);
  assert.equal(qcCheck('empty', '<svg width="1920" height="1080"><rect width="1920" height="1080"/></svg>', () => {}), false);
});

test('generated files are grouped into predictable type folders', () => {
  assert.match(outputLocation({ slug: 'example' }, 'example-hero.svg').path, /output\/example\/SVG\/example-hero\.svg$/);
  assert.match(outputLocation({ slug: 'example' }, 'example-scroll.mp4').path, /output\/example\/MP4\/example-scroll\.mp4$/);
  assert.match(outputLocation({ slug: 'example' }, 'notes.bin').path, /output\/example\/Other\/notes\.bin$/);
});

test('video trimming uses accurate output seeking after the input', () => {
  const args = ffmpegArgs('raw.webm', 'clean.mp4', 8.25);
  assert.ok(args.indexOf('-ss') > args.indexOf('-i'));
  assert.equal(args[args.indexOf('-ss') + 1], '8.25');
});
