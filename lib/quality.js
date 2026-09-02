const sharp = require('sharp');

async function analyzeCapture(buffer, { viewportHeight = 900 } = {}) {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) throw new Error('missing dimensions');
    const sampleWidth = 96;
    const sampleHeight = Math.max(12, Math.round(meta.height * sampleWidth / meta.width));
    const { data, info } = await sharp(buffer)
      .resize(sampleWidth, sampleHeight, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let sum = 0;
    let sum2 = 0;
    let edges = 0;
    let extreme = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const i = y * info.width + x;
        const value = data[i];
        sum += value;
        sum2 += value * value;
        if (value < 8 || value > 247) extreme++;
        if (x && Math.abs(value - data[i - 1]) > 18) edges++;
        if (y && Math.abs(value - data[i - info.width]) > 18) edges++;
      }
    }

    let longestUniformRun = 0;
    let uniformRun = 0;
    let detailedRows = 0;
    for (let y = 0; y < info.height; y++) {
      let rowSum = 0;
      let rowSum2 = 0;
      let rowEdges = 0;
      for (let x = 0; x < info.width; x++) {
        const i = y * info.width + x;
        const value = data[i];
        rowSum += value;
        rowSum2 += value * value;
        if (x && Math.abs(value - data[i - 1]) > 14) rowEdges++;
      }
      const mean = rowSum / info.width;
      const deviation = Math.sqrt(Math.max(0, rowSum2 / info.width - mean * mean));
      const uniform = deviation < 2.4 && rowEdges < 2;
      if (uniform) {
        uniformRun++;
        longestUniformRun = Math.max(longestUniformRun, uniformRun);
      } else {
        uniformRun = 0;
        detailedRows++;
      }
    }

    const pixels = info.width * info.height;
    const mean = sum / pixels;
    const deviation = Math.sqrt(Math.max(0, sum2 / pixels - mean * mean));
    const edgeRatio = edges / Math.max(1, pixels * 2);
    const detailRatio = detailedRows / info.height;
    const extremeRatio = extreme / pixels;
    const rowsPerViewport = viewportHeight * sampleWidth / meta.width;
    const blankScreens = rowsPerViewport > 0 ? longestUniformRun / rowsPerViewport : 0;
    const issues = [];
    if (meta.width < 280 || meta.height < 180) issues.push('capture is too small');
    if (deviation < 7 || edgeRatio < 0.004) issues.push('capture has very little visible detail');
    if (blankScreens >= 1.35) issues.push(`capture contains a ${blankScreens.toFixed(1)}-screen uniform region`);
    if (detailRatio < 0.12) issues.push('most rows are visually empty');

    const score = Math.max(0, Math.min(100,
      deviation * 0.72
      + Math.min(28, edgeRatio * 760)
      + detailRatio * 30
      - Math.max(0, blankScreens - 0.65) * 18
      - Math.max(0, extremeRatio - 0.94) * 80
    ));
    return {
      width: meta.width,
      height: meta.height,
      score: Math.round(score * 10) / 10,
      usable: issues.length === 0,
      issues,
      blankScreens,
      detailRatio,
      deviation,
      edgeRatio,
    };
  } catch (error) {
    return {
      width: 0,
      height: 0,
      score: 0,
      usable: false,
      issues: [`capture could not be inspected: ${error.message}`],
      blankScreens: 0,
      detailRatio: 0,
      deviation: 0,
      edgeRatio: 0,
    };
  }
}

function chooseBestCapture(candidates) {
  return [...candidates]
    .filter((candidate) => candidate && candidate.buffer && candidate.quality)
    .sort((a, b) => {
      if (a.quality.usable !== b.quality.usable) return a.quality.usable ? -1 : 1;
      return b.quality.score - a.quality.score;
    })[0] || null;
}

module.exports = { analyzeCapture, chooseBestCapture };
