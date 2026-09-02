#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const IMAGES = path.join(ROOT, 'docs', 'images');
const TEMP_OUTPUT = path.join(os.tmpdir(), 'portfolio-generator-readme-output');

process.env.NO_OPEN = '1';
process.env.OUTPUT_DIR = TEMP_OUTPUT;
process.env.SETTINGS_FILE = path.join(os.tmpdir(), 'portfolio-generator-readme-settings.json');
process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

const { chromium } = require('playwright');

function waitForUrl(url, timeout = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryRequest = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode < 500) resolve();
        else retry();
      });
      request.on('error', retry);
    };
    const retry = () => {
      if (Date.now() - started >= timeout) reject(new Error(`Timed out waiting for ${url}`));
      else setTimeout(tryRequest, 200);
    };
    tryRequest();
  });
}

(async () => {
  fs.mkdirSync(IMAGES, { recursive: true });
  fs.rmSync(TEMP_OUTPUT, { recursive: true, force: true });

  const fixture = spawn(process.execPath, ['test-site/site.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const { startServer } = require('../server');
  const server = startServer({ port: 0, host: '127.0.0.1', shouldOpen: false });
  if (!server.listening) await once(server, 'listening');
  const appUrl = `http://127.0.0.1:${server.address().port}`;

  let browser;
  try {
    await waitForUrl('http://127.0.0.1:4477');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(appUrl, { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(IMAGES, 'app-overview.png') });

    await page.fill('#url', 'http://127.0.0.1:4477');
    await page.evaluate(() => {
      document.querySelector('#pages').value = '/';
      document.querySelector('#mk-count').value = '2';
      document.querySelector('#sc-count').value = '2';
      document.querySelector('#ms-patience').value = 'fast';
      document.querySelector('#on-scvid').checked = false;
      document.querySelector('#on-video').checked = false;
    });
    await page.click('#go');
    await page.waitForSelector('.site', { timeout: 180000 });
    await page.screenshot({ path: path.join(IMAGES, 'generated-results.png') });
    console.log(`README screenshots saved in ${IMAGES}`);
  } finally {
    if (browser) await browser.close();
    server.close();
    fixture.kill('SIGTERM');
    fs.rmSync(TEMP_OUTPUT, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
