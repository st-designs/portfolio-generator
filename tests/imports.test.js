const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const { createImportStore, safeArchivePath, chooseEntry } = require('../lib/imports');

test('archive paths and entry-page selection are deterministic', () => {
  assert.equal(safeArchivePath('../secret.txt'), null);
  assert.equal(safeArchivePath('/absolute/index.html'), null);
  assert.equal(safeArchivePath('site/assets/main.css'), 'site/assets/main.css');
  assert.equal(chooseEntry(['deep/page.html', 'site/index.html', 'landing.html']), 'site/index.html');
});

test('a ZIP website is safely extracted with its assets intact', async (t) => {
  const zip = new JSZip();
  zip.file('saved/index.html', '<!doctype html><link rel="stylesheet" href="style.css"><h1>Portfolio archive</h1>');
  zip.file('saved/style.css', 'h1{color:#345}');
  const store = createImportStore({ serve: false });
  t.after(() => store.close());
  const imported = await store.importBuffer(await zip.generateAsync({ type: 'nodebuffer' }), 'saved-site.zip');
  assert.equal(imported.entry, 'saved/index.html');
  assert.equal(imported.files, 2);
  const root = store._roots.get(imported.id);
  const html = fs.readFileSync(path.join(root.dir, imported.entry), 'utf8');
  assert.match(html, /Portfolio archive/);
  assert.equal(fs.readFileSync(path.join(root.dir, 'saved/style.css'), 'utf8'), 'h1{color:#345}');
});
