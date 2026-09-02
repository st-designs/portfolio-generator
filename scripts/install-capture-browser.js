#!/usr/bin/env node

// Keep Chromium inside playwright-core so electron-builder can ship it with
// the app instead of relying on a per-user Playwright cache.
const { spawnSync } = require('child_process');
const path = require('path');

const cli = path.join(path.dirname(require.resolve('playwright')), 'cli.js');
const result = spawnSync(process.execPath, [cli, 'install', 'chromium'], {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status == null ? 1 : result.status);
