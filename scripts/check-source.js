#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['.git', 'dist', 'Generated', 'node_modules', 'output']);
const javascript = [];

function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(absolute);
    else if (entry.isFile() && entry.name.endsWith('.js')) javascript.push(absolute);
  }
}

collect(ROOT);

for (const file of javascript.sort()) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status || 1);
  }
}

for (const relative of ['config.json', 'package.json']) {
  JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((source) => source.trim());

inlineScripts.forEach((source, index) => {
  new vm.Script(source, { filename: `public/index.html:inline-script-${index + 1}` });
});

console.log(`Source check passed: ${javascript.length} JavaScript files, ${inlineScripts.length} inline script, 2 JSON files.`);
