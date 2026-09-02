#!/bin/bash
# Double-click this file to start the Portfolio Shot Generator.
# It installs dependencies on first run, then opens the web UI.
cd "$(dirname "$0")"

echo ""
echo "  ── Portfolio Shot Generator ──"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed."
  echo "  Install it from https://nodejs.org (LTS version), then run this again."
  read -n 1 -s -r -p "  Press any key to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  First run: installing dependencies (1-2 minutes)..."
  npm install --no-fund --no-audit
  npx playwright install chromium
  echo ""
fi

echo "  Starting... your browser will open in a moment."
echo "  Keep this window open while you use the app. Press Ctrl+C to stop."
echo ""
npm start
