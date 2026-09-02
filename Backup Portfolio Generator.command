#!/bin/bash
# Double-click to back up the Portfolio Shot Generator exactly as it is right
# now. The zip goes to the _backups folder next to your generated portfolios
# (the outputDir in config.json), with a timestamp in the name.
cd "$(dirname "$0")"

OUT=""
if command -v node >/dev/null 2>&1; then
  OUT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('config.json','utf8')).outputDir||'')}catch(e){console.log('')}")
fi
[ -z "$OUT" ] && OUT="$(dirname "$(pwd)")"
mkdir -p "$OUT/_backups"

STAMP=$(date +%Y%m%d-%H%M%S)
DEST="$OUT/_backups/portfolio-generator-$STAMP.zip"
zip -qr "$DEST" . -x "node_modules/*" -x "output/*" -x ".test-cache/*" -x "*.log"

echo ""
echo "  ✓ Backed up to:"
echo "    $DEST"
echo ""
read -n 1 -s -r -p "  Press any key to close..."
