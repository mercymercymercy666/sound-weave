import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const makeGrid = (rows, cols, fill = 0) =>
  Array.from({ length: rows }, () => Array(cols).fill(fill));

function mirrorVertical01(grid) {
  const rows = grid.length;
  const cols = grid[0].length;
  const half = Math.floor(cols / 2);
  const out = grid.map((r) => r.slice());
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < half; x++) out[y][cols - 1 - x] = out[y][x];
  return out;
}

function rleRow(row01) {
  const segs = [];
  let cur = row01[0];
  let n = 1;
  for (let i = 1; i < row01.length; i++) {
    if (row01[i] === cur) n++;
    else { segs.push({ v: cur, n }); cur = row01[i]; n = 1; }
  }
  segs.push({ v: cur, n });
  return segs;
}

function instructionsFromGrid(grid01, { floatsWarnOver = 5 } = {}) {
  const rows = grid01.length;
  const out = [];
  const warnings = [];
  for (let r = 0; r < rows; r++) {
    const y = rows - 1 - r;
    const isRS = r % 2 === 0;
    // WS rows are worked right→left: reverse the sequence so instructions read in working direction
    const row = isRS ? grid01[y] : [...grid01[y]].reverse();
    const segs = rleRow(row);
    for (const s of segs)
      if (s.n > floatsWarnOver)
        warnings.push(`Row ${r + 1} (${isRS ? "RS" : "WS"}): ${s.n} ${s.v === 0 ? "MC" : "CC"} — catch float every ${floatsWarnOver} sts`);
    const text = segs.map((s) => `${s.n} ${s.v === 0 ? "MC" : "CC"}`).join(", ");
    out.push(`Row ${r + 1} (${isRS ? "RS" : "WS"}): ${text}`);
  }
  return { rowsText: out, warnings };
}

function downloadPNG(canvas, filename = "knit-weave.png") {
  const a = document.createElement("a");
  a.download = filename;
  a.href = canvas.toDataURL("image/png");
  a.click();
}

// Parse "rgba(r, g, b, a)" or "#rrggbb" → [r, g, b]
function parseColor(str) {
  const m = str.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
  const h = str.replace("#", "");
  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
}

// Deterministic per-cell pseudo-random [0,1)
function cellRand(x, y) {
  const n = (x * 1234567 + y * 7654321) ^ (x * 937 + y * 1234);
  return ((n ^ (n >> 13)) * 0x45d9f3b & 0x7fffffff) / 0x7fffffff;
}

// Draws an interwoven strip grid over a background image.
//
// Visual model: real woven fabric where the IMAGE is the texture of each strip.
// - Gaps between strips show a dark/muted background (contrast makes weave visible)
// - Strip intersections show the image at full brightness with a subtle color tint
// - 3D edge highlights (bright top/left, dark bottom/right) show which strip is on top
// - Size variation uses a bimodal distribution → mix of thin threads and thick strips
//
function drawWeave(canvas, grids, layers, bgImg, cell, opts = {}) {
  const {
    rows, cols,
    warpColor = "#c8a96e",
    cc = "#f0ede8",
    gap = 2,
    imageOpacity = 0.65,
    colorAlpha = 0.75,    // how strongly the derived color covers image texture (0=raw image, 1=flat color)
    ccAlpha = 0.30,
    borderRadius = 0,
    sizeVariation = 0.5,
    posterizeLevels = 5,  // color quantization of sampled image: 2=B&W, 16=near full color
    maskImg = null,       // second image revealed only by audio-reactive cells
  } = opts;

  const W = cols * cell;
  const H = rows * cell;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;

  // Background: dark base + dimmed image in gaps
  ctx.fillStyle = "#1c1c1c";
  ctx.fillRect(0, 0, W, H);
  if (bgImg) {
    ctx.globalAlpha = imageOpacity * 0.45;
    ctx.drawImage(bgImg, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  // Per-CELL independent size (avoids stripe artifacts from per-row/col sizing)
  function cellSize(r) {
    if (sizeVariation < 0.01) return (cell - gap) * 0.85;
    const skewed = r < 0.55
      ? r * 0.65
      : 0.36 + (r - 0.55) * 2.05;
    const fraction = (1 - sizeVariation) * 0.85 + sizeVariation * skewed;
    return Math.max(2, Math.round((cell - gap) * clamp(fraction, 0.12, 1.0)));
  }

  const [ccR, ccG, ccB] = parseColor(cc);
  const [wpR, wpG, wpB] = parseColor(warpColor);

  const imgNW = bgImg?.naturalWidth ?? 0;
  const imgNH = bgImg?.naturalHeight ?? 0;

  // Sample image at grid resolution → pixel array for per-cell color derivation
  let imgPixels = null;
  if (bgImg && imgNW > 0) {
    try {
      const sc = new OffscreenCanvas(cols, rows);
      const sx = sc.getContext("2d");
      sx.imageSmoothingEnabled = true;
      sx.drawImage(bgImg, 0, 0, cols, rows);
      imgPixels = sx.getImageData(0, 0, cols, rows).data;
    } catch (_) {}
  }

  // Posterize a channel value to N discrete levels
  const pz = (v) => Math.round(Math.round(v / 255 * (posterizeLevels - 1)) * (255 / (posterizeLevels - 1)));

  // Get posterized image color at cell (x, y)
  function cellImgColor(x, y) {
    if (!imgPixels) return null;
    const i = (y * cols + x) * 4;
    return [pz(imgPixels[i]), pz(imgPixels[i + 1]), pz(imgPixels[i + 2])];
  }

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      // Collect active audio layers
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      for (const L of layers) {
        if (grids[L.id]?.[y]?.[x] === 1) {
          const [lr, lg, lb] = parseColor(L.color);
          rSum += lr; gSum += lg; bSum += lb; count++;
        }
      }
      const audioActive = count > 0;
      const warpOnTop = (y + x) % 2 === 0 || audioActive;

      // Strip direction: ~30% horizontal pieces, ~30% vertical, ~40% varied square
      const dirR  = cellRand(x * 337  + y * 521,  x * 191 + y * 673);
      const sizeR1 = cellRand(x * 1103 + y * 769,  x * 457 + 37);
      const sizeR2 = cellRand(x * 2311 + y * 457,  y * 769 + 83);
      let cw, ch;
      if (sizeVariation > 0.05 && dirR < 0.28) {
        // Horizontal piece: wide and thin
        const b = cellSize(sizeR1);
        cw = Math.min(cell - gap, Math.round(b * (1.1 + sizeVariation * 0.9)));
        ch = Math.max(2, Math.round(b * (0.38 - sizeVariation * 0.18)));
      } else if (sizeVariation > 0.05 && dirR < 0.58) {
        // Vertical piece: tall and narrow
        const b = cellSize(sizeR2);
        cw = Math.max(2, Math.round(b * (0.38 - sizeVariation * 0.18)));
        ch = Math.min(cell - gap, Math.round(b * (1.1 + sizeVariation * 0.9)));
      } else {
        cw = cellSize(sizeR1);
        ch = cellSize(sizeR2);
      }

      // Sine-wave displacement — breaks grid rigidity, creates fabric curvature feel
      const waveAmp = sizeVariation * 0.18;
      const xWave = Math.round(Math.sin(y * 0.55 + x * 0.17) * waveAmp * cell);
      const yWave = Math.round(Math.sin(x * 0.55 + y * 0.17) * waveAmp * cell);
      const xp = x * cell + (cell - cw) / 2 + xWave;
      const yp = y * cell + (cell - ch) / 2 + yWave;
      const rad = borderRadius > 0 ? Math.min(borderRadius * Math.min(cw, ch) * 0.012, cw / 2, ch / 2) : 0;
      const edgePx = Math.max(1, Math.round(Math.min(cw, ch) * 0.20));

      // Image source rect
      const srcX = (x / cols) * imgNW;
      const srcY = (y / rows) * imgNH;
      const srcW = imgNW / cols;
      const srcH = imgNH / rows;

      // Base color from posterized image
      let tintR, tintG, tintB, tintA;
      if (audioActive) {
        tintR = Math.round(rSum / count);
        tintG = Math.round(gSum / count);
        tintB = Math.round(bSum / count);
        tintA = clamp(colorAlpha + 0.2, 0, 1);
      } else {
        const ic = cellImgColor(x, y);
        if (ic) {
          // Blend posterized image color 30% toward warp/cc — makes color pickers visible
          const bR = warpOnTop ? wpR : ccR, bG = warpOnTop ? wpG : ccG, bB = warpOnTop ? wpB : ccB;
          const blend = 0.30;
          tintR = Math.round(ic[0] * (1 - blend) + bR * blend);
          tintG = Math.round(ic[1] * (1 - blend) + bG * blend);
          tintB = Math.round(ic[2] * (1 - blend) + bB * blend);
          tintA = warpOnTop ? colorAlpha : ccAlpha;  // different opacity per strip direction
        } else {
          tintR = warpOnTop ? wpR : ccR;
          tintG = warpOnTop ? wpG : ccG;
          tintB = warpOnTop ? wpB : ccB;
          tintA = warpOnTop ? colorAlpha : ccAlpha;
        }
      }

      // Checkerboard tone: warp-on-top = raised (lighter), weft-on-top = recessed (darker)
      // Apply before drawing so both image texture and tint are affected
      const shadowAlpha = warpOnTop ? 0 : 0.42;

      // --- Draw cell ---
      ctx.save();
      if (rad > 0) {
        ctx.beginPath();
        ctx.roundRect(xp, yp, cw, ch, rad);
        ctx.clip();
      }

      // 1. Image texture
      if (bgImg && srcW > 0) {
        ctx.globalAlpha = 1;
        ctx.drawImage(bgImg, srcX, srcY, srcW, srcH, xp, yp, cw, ch);
      } else {
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgb(${tintR},${tintG},${tintB})`;
        ctx.fillRect(xp, yp, cw, ch);
      }

      // 2. Mask image reveal — shown only on audio-active cells
      if (audioActive && maskImg) {
        ctx.globalAlpha = 0.92;
        ctx.drawImage(maskImg, srcX, srcY, srcW > 0 ? srcW : maskImg.naturalWidth / cols,
          srcW > 0 ? srcH : maskImg.naturalHeight / rows, xp, yp, cw, ch);
        // Subtle layer color tint over mask image
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = `rgb(${tintR},${tintG},${tintB})`;
        ctx.fillRect(xp, yp, cw, ch);
      } else {
        // 2b. Posterized color tint (normal path)
        ctx.globalAlpha = tintA;
        ctx.fillStyle = `rgb(${tintR},${tintG},${tintB})`;
        ctx.fillRect(xp, yp, cw, ch);
      }

      // 3. Checkerboard depth shadow (recessed cells are darker)
      if (shadowAlpha > 0) {
        ctx.globalAlpha = shadowAlpha;
        ctx.fillStyle = "#000";
        ctx.fillRect(xp, yp, cw, ch);
      }

      ctx.globalAlpha = 1;
      ctx.restore();

      // --- 3D edge highlights (show which strip is raised) ---
      if (warpOnTop) {
        // Raised horizontal: bright top, dark bottom
        ctx.fillStyle = "rgba(255,255,255,0.50)";
        ctx.fillRect(xp, yp, cw, edgePx);
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(xp, yp + ch - edgePx, cw, edgePx);
      } else {
        // Raised vertical: bright left, dark right
        ctx.fillStyle = "rgba(255,255,255,0.50)";
        ctx.fillRect(xp, yp, edgePx, ch);
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(xp + cw - edgePx, yp, edgePx, ch);
      }
    }
  }
}

// Draws organic lace — circular stitches, wavy yarn lines, eyelet rings
function drawLace(canvas, grids, layers, bgImg, cell, opts = {}) {
  const {
    rows, cols,
    warpColor = "#c8a96e",
    gap = 2,
    imageOpacity = 0.65,
    colorAlpha = 0.75,
    sizeVariation = 0.5,
    posterizeLevels = 5,
    maskImg = null,
  } = opts;

  const W = cols * cell;
  const H = rows * cell;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;

  ctx.fillStyle = "#0d0d0d";
  ctx.fillRect(0, 0, W, H);
  if (bgImg) {
    ctx.globalAlpha = imageOpacity * 0.35;
    ctx.drawImage(bgImg, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  const [wpR, wpG, wpB] = parseColor(warpColor);

  let imgPixels = null;
  if (bgImg && (bgImg.naturalWidth ?? 0) > 0) {
    try {
      const sc = new OffscreenCanvas(cols, rows);
      const sx = sc.getContext("2d");
      sx.imageSmoothingEnabled = true;
      sx.drawImage(bgImg, 0, 0, cols, rows);
      imgPixels = sx.getImageData(0, 0, cols, rows).data;
    } catch (_) {}
  }
  const pz = (v) => Math.round(Math.round(v / 255 * (posterizeLevels - 1)) * (255 / (posterizeLevels - 1)));

  // Wavy yarn connecting lines
  ctx.strokeStyle = `rgba(${wpR},${wpG},${wpB},0.18)`;
  ctx.lineWidth = Math.max(1, cell * 0.12);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cx = x * cell + cell / 2, cy = y * cell + cell / 2;
      if (x < cols - 1) {
        const nx = (x + 1) * cell + cell / 2, ny = cy;
        const wave = Math.sin((x + y * 0.7) * 1.1) * cell * 0.18 * sizeVariation;
        ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.quadraticCurveTo((cx + nx) / 2, cy + wave, nx, ny); ctx.stroke();
      }
      if (y < rows - 1) {
        const nx = cx, ny = (y + 1) * cell + cell / 2;
        const wave = Math.sin((y + x * 0.7) * 1.1) * cell * 0.18 * sizeVariation;
        ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.quadraticCurveTo(cx + wave, (cy + ny) / 2, nx, ny); ctx.stroke();
      }
    }
  }

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const cx = x * cell + cell / 2, cy = y * cell + cell / 2;
      const r1 = cellRand(x * 1103 + y * 769, x * 457 + 37);
      const r2 = cellRand(x * 337 + y * 521, x * 191 + y * 673);

      let audioActive = false, audioR = wpR, audioG = wpG, audioB2 = wpB, count = 0;
      for (const L of layers) {
        if (grids[L.id]?.[y]?.[x] === 1) {
          const [lr, lg, lb] = parseColor(L.color);
          audioR += lr; audioG += lg; audioB2 += lb; count++; audioActive = true;
        }
      }
      if (count > 0) { audioR = Math.round(audioR / count); audioG = Math.round(audioG / count); audioB2 = Math.round(audioB2 / count); }

      let stR = wpR, stG = wpG, stB = wpB;
      if (imgPixels) {
        const i = (y * cols + x) * 4, blend = 0.25;
        stR = Math.round(pz(imgPixels[i])   * (1 - blend) + wpR * blend);
        stG = Math.round(pz(imgPixels[i+1]) * (1 - blend) + wpG * blend);
        stB = Math.round(pz(imgPixels[i+2]) * (1 - blend) + wpB * blend);
      }
      if (audioActive) { stR = audioR; stG = audioG; stB = audioB2; }

      const alpha = audioActive ? Math.min(colorAlpha + 0.3, 1) : colorAlpha;
      const isEyelet = !audioActive && r1 < 0.20;
      const isDecrease = !audioActive && !isEyelet && r2 < 0.25;
      const stRadius = Math.max(2, (cell / 2 - gap) * (0.55 + sizeVariation * 0.35));

      if (isEyelet) {
        const holeR = stRadius * 0.55;
        ctx.beginPath(); ctx.arc(cx, cy, holeR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${stR},${stG},${stB},${alpha})`;
        ctx.lineWidth = Math.max(1, cell * 0.14); ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, Math.max(1, holeR * 0.25), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${stR},${stG},${stB},${alpha * 0.5})`; ctx.fill();
      } else if (isDecrease) {
        ctx.save(); ctx.translate(cx, cy);
        ctx.rotate(r2 < 0.125 ? -Math.PI / 5 : Math.PI / 5);
        ctx.beginPath(); ctx.ellipse(0, 0, stRadius * 0.55, stRadius * 0.85, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${stR},${stG},${stB},${alpha})`; ctx.fill();
        ctx.beginPath(); ctx.ellipse(0, -stRadius * 0.18, stRadius * 0.22, stRadius * 0.28, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${alpha * 0.35})`; ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath(); ctx.arc(cx, cy, stRadius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${stR},${stG},${stB},${alpha})`; ctx.fill();
        // Mask image reveal on audio-active stitches
        if (audioActive && maskImg) {
          ctx.save();
          ctx.beginPath(); ctx.arc(cx, cy, stRadius, 0, Math.PI * 2); ctx.clip();
          const mw = maskImg.naturalWidth / cols, mh = maskImg.naturalHeight / rows;
          ctx.globalAlpha = 0.90;
          ctx.drawImage(maskImg, x * mw, y * mh, mw, mh, cx - stRadius, cy - stRadius, stRadius * 2, stRadius * 2);
          ctx.globalAlpha = 0.20;
          ctx.fillStyle = `rgb(${stR},${stG},${stB})`; ctx.fill();
          ctx.restore();
        } else {
          ctx.beginPath(); ctx.arc(cx - stRadius * 0.22, cy - stRadius * 0.25, stRadius * 0.38, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,255,255,${alpha * 0.45})`; ctx.fill();
          ctx.beginPath(); ctx.arc(cx + stRadius * 0.15, cy + stRadius * 0.22, stRadius * 0.28, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(0,0,0,${alpha * 0.3})`; ctx.fill();
        }
      }
      if (audioActive) {
        ctx.beginPath(); ctx.arc(cx, cy, stRadius + 1.5, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${stR},${stG},${stB},0.6)`; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }
  }
}

// Draws a filet/knitting-chart pattern:
// Image luminance determines filled stitch vs eyelet hole.
// Filled cells get the image color + a knit-stitch V-symbol for texture.
// Hole cells show a faint ring. Looks like filet crochet or a knitting chart.
function drawChart(canvas, grids, layers, bgImg, cell, opts = {}) {
  const {
    rows, cols,
    warpColor = "#c8a96e",
    gap = 1,
    imageOpacity = 0.3,
    colorAlpha = 0.85,
    borderRadius = 20,
    sizeVariation = 0.5,   // controls stitch fill ratio (0=tightest, 1=most gap)
    posterizeLevels = 5,
    maskImg = null,
  } = opts;

  const W = cols * cell;
  const H = rows * cell;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;

  // Very dark background — holes need to read clearly
  ctx.fillStyle = "#060606";
  ctx.fillRect(0, 0, W, H);
  if (bgImg) {
    ctx.globalAlpha = imageOpacity;
    ctx.drawImage(bgImg, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  const [wpR, wpG, wpB] = parseColor(warpColor);

  let imgPixels = null;
  if (bgImg && (bgImg.naturalWidth ?? 0) > 0) {
    try {
      const sc = new OffscreenCanvas(cols, rows);
      const sx = sc.getContext("2d");
      sx.imageSmoothingEnabled = true;
      sx.drawImage(bgImg, 0, 0, cols, rows);
      imgPixels = sx.getImageData(0, 0, cols, rows).data;
    } catch (_) {}
  }
  const pz = (v) => Math.round(Math.round(v / 255 * (posterizeLevels - 1)) * (255 / (posterizeLevels - 1)));

  // Stitch cell geometry — sizeVariation controls how much gap between stitches
  const pad = gap + Math.round(sizeVariation * cell * 0.12);
  const sw = cell - pad * 2;   // stitch width
  const sh = cell - pad * 2;   // stitch height
  const rad = Math.min(borderRadius * 0.01 * Math.min(sw, sh) * 0.7, sw / 2, sh / 2);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const px = x * cell + pad;
      const py = y * cell + pad;
      const cx = x * cell + cell / 2;
      const cy = y * cell + cell / 2;

      // Audio layer check
      let rSum = wpR, gSum = wpG, bSum = wpB, count = 0;
      for (const L of layers) {
        if (grids[L.id]?.[y]?.[x] === 1) {
          const [lr, lg, lb] = parseColor(L.color);
          rSum += lr; gSum += lg; bSum += lb; count++;
        }
      }
      const audioActive = count > 0;

      // Per-cell color from image
      let tR = wpR, tG = wpG, tB = wpB;
      let lum = 0.5; // default: half filled
      if (imgPixels) {
        const i = (y * cols + x) * 4;
        const pR = pz(imgPixels[i]), pG = pz(imgPixels[i+1]), pB = pz(imgPixels[i+2]);
        lum = (pR * 0.299 + pG * 0.587 + pB * 0.114) / 255;
        const blend = 0.22;
        tR = Math.round(pR * (1 - blend) + wpR * blend);
        tG = Math.round(pG * (1 - blend) + wpG * blend);
        tB = Math.round(pB * (1 - blend) + wpB * blend);
      }
      if (audioActive) {
        tR = Math.round(rSum / (count + 1));
        tG = Math.round(gSum / (count + 1));
        tB = Math.round(bSum / (count + 1));
      }

      // Filled stitch if: audio active, or image bright enough (threshold ~35%)
      const filled = audioActive || lum > 0.35;
      const alpha = audioActive ? Math.min(colorAlpha + 0.15, 1) : colorAlpha;

      if (filled) {
        // ── Filled knit stitch ──
        // Drop shadow before base fill
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.75)";
        ctx.shadowBlur = Math.max(2, sw * 0.35);
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = Math.max(1, sw * 0.18);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = `rgb(${tR},${tG},${tB})`;
        ctx.beginPath();
        if (rad > 0) ctx.roundRect(px, py, sw, sh, rad);
        else ctx.rect(px, py, sw, sh);
        ctx.fill();
        ctx.restore();

        // Thin border stroke for definition
        ctx.globalAlpha = alpha * 0.5;
        ctx.strokeStyle = `rgba(${Math.min(tR+60,255)},${Math.min(tG+60,255)},${Math.min(tB+60,255)},0.55)`;
        ctx.lineWidth = Math.max(0.5, sw * 0.06);
        ctx.beginPath();
        if (rad > 0) ctx.roundRect(px, py, sw, sh, rad); else ctx.rect(px, py, sw, sh);
        ctx.stroke();

        // Mask image reveal on audio-active stitches
        if (audioActive && maskImg) {
          ctx.save();
          ctx.beginPath();
          if (rad > 0) ctx.roundRect(px, py, sw, sh, rad); else ctx.rect(px, py, sw, sh);
          ctx.clip();
          const mw = maskImg.naturalWidth / cols, mh = maskImg.naturalHeight / rows;
          ctx.globalAlpha = 0.90;
          ctx.drawImage(maskImg, x * mw, y * mh, mw, mh, px, py, sw, sh);
          ctx.globalAlpha = 0.20;
          ctx.fillStyle = `rgb(${tR},${tG},${tB})`;
          ctx.beginPath();
          if (rad > 0) ctx.roundRect(px, py, sw, sh, rad); else ctx.rect(px, py, sw, sh);
          ctx.fill();
          ctx.restore();
        } else {
          // Top-left sheen
          ctx.globalAlpha = alpha * 0.45;
          const grad = ctx.createLinearGradient(px, py, px + sw * 0.6, py + sh * 0.6);
          grad.addColorStop(0, "rgba(255,255,255,0.55)");
          grad.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = grad;
          ctx.beginPath();
          if (rad > 0) ctx.roundRect(px, py, sw, sh, rad);
          else ctx.rect(px, py, sw, sh);
          ctx.fill();
        }

        // Knit stitch V-symbol — bold and clear
        if (sw >= 5) {
          const vW = sw * 0.34, vTop = py + sh * 0.15, vBot = py + sh * 0.75;
          const vLw = Math.max(1.2, sw * 0.14);
          // Shadow behind V for depth
          ctx.save();
          ctx.shadowColor = "rgba(0,0,0,0.6)";
          ctx.shadowBlur = Math.max(1, sw * 0.15);
          ctx.shadowOffsetY = Math.max(0.5, sw * 0.07);
          ctx.globalAlpha = alpha * 0.85;
          ctx.strokeStyle = "rgba(255,255,255,0.95)";
          ctx.lineWidth = vLw;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.beginPath();
          ctx.moveTo(cx - vW, vTop);
          ctx.lineTo(cx, vBot);
          ctx.lineTo(cx + vW, vTop);
          ctx.stroke();
          ctx.restore();
        }

        // Bottom shadow strip for embossed look
        ctx.globalAlpha = alpha * 0.35;
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(px, py + sh - Math.max(1, sh * 0.14), sw, Math.max(1, sh * 0.14));

        ctx.globalAlpha = 1;
      } else {
        // ── Eyelet / hole ── tiny ring, barely visible
        ctx.globalAlpha = 0.22;
        ctx.strokeStyle = `rgb(${tR},${tG},${tB})`;
        ctx.lineWidth = Math.max(0.5, cell * 0.06);
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(1, cell * 0.10), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }
}

// ---- AUDIO LAYER ENGINE ----
function useAudioLayer() {
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceRef = useRef(null);
  const streamRef = useRef(null);
  const oscRef = useRef(null);
  const gainRef = useRef(null);
  const rafRef = useRef(null);
  const [energy, setEnergy] = useState(0);
  const binsRef = useRef(new Uint8Array(512));

  async function stop() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (oscRef.current) { try { oscRef.current.stop(); } catch {} try { oscRef.current.disconnect(); } catch {} oscRef.current = null; }
    if (sourceRef.current) { try { sourceRef.current.disconnect(); } catch {} sourceRef.current = null; }
    if (gainRef.current) { try { gainRef.current.disconnect(); } catch {} gainRef.current = null; }
    if (analyserRef.current) { try { analyserRef.current.disconnect(); } catch {} analyserRef.current = null; }
    if (streamRef.current) { try { streamRef.current.getTracks().forEach((t) => t.stop()); } catch {} streamRef.current = null; }
    if (audioCtxRef.current) { try { await audioCtxRef.current.close(); } catch {} audioCtxRef.current = null; }
    setEnergy(0);
    binsRef.current = new Uint8Array(512);
  }

  function startTick(analyser) {
    const bins = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(bins);
      binsRef.current = bins;
      let sum = 0;
      for (let i = 0; i < bins.length; i++) sum += bins[i];
      setEnergy(clamp(Math.pow(sum / bins.length / 255, 0.7), 0, 1));
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  }

  async function startMic() {
    await stop();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.85;
    analyserRef.current = analyser;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    const src = ctx.createMediaStreamSource(stream);
    sourceRef.current = src;
    src.connect(analyser);
    startTick(analyser);
  }

  async function startFileFromElement(audioEl) {
    await stop();
    if (!audioEl) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.85;
    analyserRef.current = analyser;
    const src = ctx.createMediaElementSource(audioEl);
    sourceRef.current = src;
    src.connect(analyser);
    analyser.connect(ctx.destination);
    startTick(analyser);
  }

  async function startOsc({ freq = 220, type = "sine", gain = 0.04 } = {}) {
    await stop();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.85;
    analyserRef.current = analyser;
    const g = ctx.createGain(); g.gain.value = gain; gainRef.current = g;
    const osc = ctx.createOscillator();
    osc.type = type; osc.frequency.value = freq; oscRef.current = osc;
    osc.connect(g); g.connect(analyser); analyser.connect(ctx.destination);
    osc.start();
    startTick(analyser);
  }

  function updateOsc({ freq, gain }) {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (oscRef.current && typeof freq === "number") oscRef.current.frequency.setTargetAtTime(freq, ctx.currentTime, 0.01);
    if (gainRef.current && typeof gain === "number") gainRef.current.gain.setTargetAtTime(gain, ctx.currentTime, 0.01);
  }

  return { energy, binsRef, startMic, startFileFromElement, startOsc, updateOsc, stop, streamRef };
}

function spectralCentroid01(bins) {
  let num = 0, den = 0;
  const n = bins.length;
  for (let i = 0; i < n; i++) { const mag = bins[i] / 255; den += mag; num += mag * (i / (n - 1)); }
  return den > 1e-6 ? clamp(num / den, 0, 1) : 0;
}

function brushRowFromAudio({ bins, cols, y, energy01, threshold, tSec }) {
  const out = new Array(cols).fill(0);
  if (!bins || bins.length === 0) return out;
  const centroid = spectralCentroid01(bins);
  const cursorX = Math.floor(centroid * (cols - 1));
  const thick = 1 + Math.floor(energy01 * 6);
  const stripeFreq = 2 + Math.floor(centroid * 6);
  const phase = (tSec * (1 + energy01 * 4) + y * 0.07) * stripeFreq;
  for (let x = 0; x < cols; x++) {
    const idx = Math.floor((x / cols) * bins.length);
    const v = (bins[idx] ?? 0) / 255;
    let bit = v >= threshold ? 1 : 0;
    if (Math.abs(x - cursorX) <= thick) bit = 1;
    const stripes = Math.sin(phase + x * 0.35) > 0.55 ? 1 : 0;
    if (energy01 > 0.12) bit = bit | (stripes & (v > threshold * 0.9 ? 1 : 0));
    out[x] = bit;
  }
  return out;
}

function combineN(layerGrids, mode = "OR") {
  const ids = Object.keys(layerGrids);
  if (!ids.length) return [[]];
  const rows = layerGrids[ids[0]].length;
  const cols = layerGrids[ids[0]][0].length;
  const out = makeGrid(rows, cols, 0);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      let v = mode === "AND" ? 1 : 0;
      for (const id of ids) {
        const b = layerGrids[id][y][x] | 0;
        if (mode === "OR") v = v | b;
        else if (mode === "XOR") v = v ^ b;
        else if (mode === "AND") v = v & b;
      }
      out[y][x] = v ? 1 : 0;
    }
  return out;
}

const LAYER_COLORS = { A: "#ff3333", B: "#0088ff", C: "#00c878", D: "#ff8c00" };
const IDS = ["A", "B", "C", "D"];

export default function App() {
  const LAYERS = useMemo(() => [
    { id: "A", name: "MIC",     type: "mic",  color: "rgba(255,60,60,1)"   },
    { id: "B", name: "AUDIO 1", type: "file", color: "rgba(0,140,255,1)"   },
    { id: "C", name: "AUDIO 2", type: "file", color: "rgba(0,200,120,1)"   },
    { id: "D", name: "AUDIO 3", type: "file", color: "rgba(255,160,0,1)"   },
  ], []);

  const [cols, setCols] = useState(60);
  const [rows, setRows] = useState(80);
  const [cell, setCell] = useState(10);
  const [symmetry, setSymmetry] = useState(true);
  const [combineMode, setCombineMode] = useState("OR");

  // Woven visual
  const [warpColor, setWarpColor] = useState("#c8a96e");
  const [cc, setCc] = useState("#e8d5b7");
  const [gap, setGap] = useState(2);
  const [imageOpacity, setImageOpacity] = useState(0.65);
  const [colorAlpha, setColorAlpha] = useState(0.40);
  const [ccAlpha, setCcAlpha] = useState(0.30);
  const [borderRadius, setBorderRadius] = useState(20);
  const [sizeVariation, setSizeVariation] = useState(0.5);
  const [posterizeLevels, setPosterizeLevels] = useState(5);
  const [bgImg, setBgImg] = useState(null);
  const [maskImg, setMaskImg] = useState(null);
  const [patternMode, setPatternMode] = useState("weave"); // "weave" | "lace"

  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);

  const [floatWarnOver, setFloatWarnOver] = useState(5);

  const [grids, setGrids] = useState(() => {
    const o = {};
    for (const id of IDS) o[id] = makeGrid(80, 60, 0);
    return o;
  });
  const [rowCursor, setRowCursor] = useState(() => {
    const o = {};
    for (const id of IDS) o[id] = 0;
    return o;
  });

  const [drawValue, setDrawValue] = useState(1);
  const [mouseDown, setMouseDown] = useState(false);

  const [modes, setModes]           = useState({ A: "off", B: "off", C: "off", D: "off" });
  const [speeds, setSpeeds]         = useState({ A: 10,  B: 10,  C: 10,  D: 10 });
  const [thresholds, setThresholds] = useState({ A: 0.55, B: 0.55, C: 0.55, D: 0.55 });

  const audioA = useAudioLayer();
  const audioB = useAudioLayer();
  const audioC = useAudioLayer();
  const audioD = useAudioLayer();
  const audioMap = useMemo(
    () => ({ A: audioA, B: audioB, C: audioC, D: audioD }),
    [audioA, audioB, audioC, audioD]
  );
  const audioMapRef = useRef(audioMap);
  audioMapRef.current = audioMap;

  const audioRefB = useRef(null);
  const audioRefC = useRef(null);
  const audioRefD = useRef(null);
  const canvasRef = useRef(null);

  // Resize grids when rows/cols change
  useEffect(() => {
    const resize = (prev) => {
      const next = makeGrid(rows, cols, 0);
      const r = Math.min(rows, prev.length);
      const c = Math.min(cols, prev[0]?.length ?? 0);
      for (let y = 0; y < r; y++) for (let x = 0; x < c; x++) next[y][x] = prev[y][x];
      return next;
    };
    setGrids((prev) => { const next = { ...prev }; for (const L of LAYERS) next[L.id] = resize(prev[L.id]); return next; });
    setRowCursor((prev) => { const next = { ...prev }; for (const L of LAYERS) next[L.id] = 0; return next; });
  }, [rows, cols, LAYERS]);

  // Wire modes → audio start/stop
  useEffect(() => { (async () => { try { if (modes.A === "off") await audioA.stop(); if (modes.A === "mic")  await audioA.startMic(); } catch (e) { console.warn(e); setModes(m => ({ ...m, A: "off" })); } })(); }, [modes.A]); // eslint-disable-line
  useEffect(() => { (async () => { try { if (modes.B === "off") await audioB.stop(); if (modes.B === "file") await audioB.startFileFromElement(audioRefB.current); } catch (e) { console.warn(e); setModes(m => ({ ...m, B: "off" })); } })(); }, [modes.B]); // eslint-disable-line
  useEffect(() => { (async () => { try { if (modes.C === "off") await audioC.stop(); if (modes.C === "file") await audioC.startFileFromElement(audioRefC.current); } catch (e) { console.warn(e); setModes(m => ({ ...m, C: "off" })); } })(); }, [modes.C]); // eslint-disable-line
  useEffect(() => { (async () => { try { if (modes.D === "off") await audioD.stop(); if (modes.D === "file") await audioD.startFileFromElement(audioRefD.current); } catch (e) { console.warn(e); setModes(m => ({ ...m, D: "off" })); } })(); }, [modes.D]); // eslint-disable-line
  // Audio → grid paint loop
  useEffect(() => {
    let raf = null;
    let last = performance.now();
    const acc = { A: 0, B: 0, C: 0, D: 0 };

    const step = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      setRowCursor((prevCursor) => {
        const nextCursor = { ...prevCursor };
        setGrids((prevGrids) => {
          let nextGrids = prevGrids;
          const tSec = now / 1000;
          for (const L of LAYERS) {
            const id = L.id;
            if (modes[id] === "off") continue;
            acc[id] = (acc[id] ?? 0) + dt * (speeds[id] ?? 10);
            while (acc[id] >= 1) {
              acc[id] -= 1;
              const audio = audioMapRef.current[id];
              const bins = audio.binsRef.current;
              const energy01 = audio.energy;
              const y = nextCursor[id] ?? 0;
              const row = brushRowFromAudio({ bins, cols, y, energy01, threshold: thresholds[id] ?? 0.55, tSec });
              if (nextGrids === prevGrids) nextGrids = { ...prevGrids };
              const g = nextGrids[id].map((r) => r.slice());
              g[y] = row;
              nextGrids[id] = symmetry ? mirrorVertical01(g) : g;
              nextCursor[id] = (y + 1) % rows;
            }
          }
          return nextGrids;
        });
        return nextCursor;
      });
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => raf && cancelAnimationFrame(raf);
  }, [LAYERS, modes, speeds, thresholds, cols, rows, symmetry]);

  const combinedGrid = useMemo(() => combineN(grids, combineMode), [grids, combineMode]);
  const knit = useMemo(() => instructionsFromGrid(combinedGrid, { floatsWarnOver: floatWarnOver }), [combinedGrid, floatWarnOver]);

  // Draw canvas — dispatch to weave or lace renderer
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const drawOpts = { rows, cols, warpColor, cc, gap, imageOpacity, colorAlpha, ccAlpha, borderRadius, sizeVariation, posterizeLevels, maskImg };
    if (patternMode === "lace") drawLace(c, grids, LAYERS, bgImg, clamp(cell, 4, 30), drawOpts);
    else if (patternMode === "chart") drawChart(c, grids, LAYERS, bgImg, clamp(cell, 4, 30), drawOpts);
    else drawWeave(c, grids, LAYERS, bgImg, clamp(cell, 4, 30), drawOpts);
  }, [patternMode, grids, LAYERS, bgImg, cell, rows, cols, warpColor, cc, gap, imageOpacity, colorAlpha, ccAlpha, borderRadius, sizeVariation, posterizeLevels, maskImg]);

  function paintAtEvent(e) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cs = clamp(cell, 4, 30);
    const x = Math.floor((e.clientX - rect.left) / cs);
    const y = Math.floor((e.clientY - rect.top) / cs);
    if (x < 0 || y < 0 || y >= rows || x >= cols) return;
    setGrids((prev) => {
      const next = { ...prev, A: prev.A.map((r) => r.slice()) };
      next.A[y][x] = drawValue;
      if (symmetry) next.A = mirrorVertical01(next.A);
      return next;
    });
  }

  function handleBgImage(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setBgImg(img);
    img.src = url;
  }

  function handleMaskImage(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setMaskImg(img);
    img.src = url;
  }

  function filePickerToAudio(ref, file, id) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const el = ref.current;
    if (!el) return;
    el.src = url;
    el.play().catch(() => {});
    setTimeout(() => setModes((m) => ({ ...m, [id]: "file" })), 0);
  }

  function startRecording() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    recordedChunksRef.current = [];

    const canvasStream = canvas.captureStream(30);
    const combined = new MediaStream(canvasStream.getVideoTracks());

    // Mix all active audio sources into one stream via AudioContext
    const rawStreams = [];
    if (modes.A === "mic" && audioA.streamRef.current)
      rawStreams.push(audioA.streamRef.current);
    [[audioRefB, "B"], [audioRefC, "C"], [audioRefD, "D"]].forEach(([ref, id]) => {
      if (modes[id] === "file" && ref.current?.captureStream) {
        try { rawStreams.push(ref.current.captureStream()); } catch {}
      }
    });
    if (rawStreams.length > 0) {
      try {
        const mixCtx = new AudioContext();
        const dest = mixCtx.createMediaStreamDestination();
        rawStreams.forEach((s) => mixCtx.createMediaStreamSource(s).connect(dest));
        dest.stream.getAudioTracks().forEach((t) => combined.addTrack(t));
      } catch (e) { console.warn("Audio mix failed:", e); }
    }

    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9" : "video/webm";
    const mr = new MediaRecorder(combined, { mimeType });
    mr.ondataavailable = (e) => { if (e.data.size > 0) recordedChunksRef.current.push(e.data); };
    mr.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `weave_${cols}x${rows}.webm`;
      a.click();
    };
    mr.start();
    mediaRecorderRef.current = mr;
    setIsRecording(true);
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }

  function downloadPattern() {
    const text = knit.rowsText.join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `knit_pattern_${cols}x${rows}.txt`;
    a.click();
  }

  const energyAll = useMemo(() => {
    const e = {};
    for (const L of LAYERS) e[L.id] = Math.round((audioMap[L.id]?.energy ?? 0) * 100);
    return e;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [LAYERS, audioMap, audioA.energy, audioB.energy, audioC.energy, audioD.energy]);

  const audioRefs = { B: audioRefB, C: audioRefC, D: audioRefD };

  // shared style tokens
  const NG = "#39ff14";
  const ng20 = "rgba(57,255,20,0.20)";
  const panel = { background: "#111", border: `1px solid #1e1e1e`, borderRadius: 14, padding: 14 };
  const label12 = { fontSize: 12, color: NG, display: "block" };
  const muted = { fontSize: 11, color: "rgba(57,255,20,0.45)" };
  const btn = (active) => ({
    padding: "5px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer", fontWeight: 600,
    background: active ? NG : "transparent",
    color: active ? "#000" : NG,
    border: `1px solid ${active ? NG : ng20}`,
  });
  const colorPick = { width: 36, height: 28, borderRadius: 6, cursor: "pointer", padding: 2 };

  return (
    <div style={{ minHeight: "100vh", background: "#080808", padding: 16, fontFamily: "ui-monospace, 'Courier New', monospace", color: NG }}>
      <div style={{ maxWidth: 1340, margin: "0 auto", display: "grid", gridTemplateColumns: "1.45fr 1fr", gap: 12 }}>

        {/* ── LEFT: Canvas ── */}
        <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 20, letterSpacing: 2, textShadow: `0 0 12px ${NG}` }}>
                SOUND WEAVE
              </div>
              <div style={{ ...muted, marginTop: 3 }}>upload an image, add sound — the weave draws itself</div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {/* style mode — prominent toggle */}
              <div style={{ display: "flex", background: "#0a0a0a", border: `1px solid ${ng20}`, borderRadius: 10, padding: 3, gap: 3 }}>
                {["weave", "lace", "chart"].map((m) => (
                  <button key={m} onClick={() => setPatternMode(m)}
                    style={{ padding: "5px 16px", borderRadius: 7, fontSize: 12, cursor: "pointer", fontWeight: 700, border: "none",
                      background: patternMode === m ? NG : "transparent",
                      color: patternMode === m ? "#000" : "rgba(57,255,20,0.5)",
                      boxShadow: patternMode === m ? `0 0 8px ${NG}` : "none",
                      letterSpacing: 1, transition: "all 0.15s" }}>
                    {m}
                  </button>
                ))}
              </div>
              <div style={{ width: 1, height: 20, background: ng20 }} />
              <button onClick={() => setGrids(() => { const o = {}; for (const id of IDS) o[id] = makeGrid(rows, cols, 0); return o; })}
                style={btn(false)}>clear</button>
              <button onClick={() => { const c = canvasRef.current; if (c) downloadPNG(c, `weave_${cols}x${rows}.png`); }}
                style={btn(false)}>export png</button>
              {isRecording
                ? <button onClick={stopRecording}
                    style={{ ...btn(true), background: "#ff2222", borderColor: "#ff2222", color: "#fff", boxShadow: "0 0 10px #ff2222" }}>stop rec</button>
                : <button onClick={startRecording}
                    style={{ ...btn(true), boxShadow: `0 0 10px ${NG}` }}>record video</button>
              }
            </div>
          </div>

          <div style={{ border: `1px solid ${ng20}`, borderRadius: 10, overflow: "auto", boxShadow: `0 0 20px rgba(57,255,20,0.06)` }}>
            <canvas
              ref={canvasRef}
              onMouseDown={(e) => { setMouseDown(true); paintAtEvent(e); }}
              onMouseMove={(e) => { if (mouseDown) paintAtEvent(e); }}
              onMouseUp={() => setMouseDown(false)}
              onMouseLeave={() => setMouseDown(false)}
              style={{ display: "block", cursor: "crosshair" }}
            />
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={() => setDrawValue(1)} style={btn(drawValue === 1)}>paint mc</button>
            <button onClick={() => setDrawValue(0)} style={btn(drawValue === 0)}>paint cc</button>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, cursor: "pointer" }}>
              <input type="checkbox" checked={symmetry} onChange={(e) => setSymmetry(e.target.checked)} />
              symmetry ↔
            </label>
            <span style={{ ...muted }}>combine:</span>
            {["OR", "XOR", "AND"].map((m) => (
              <button key={m} onClick={() => setCombineMode(m)} style={btn(combineMode === m)}>{m}</button>
            ))}
          </div>

          {/* energy meters */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <span style={muted}>energy</span>
            {LAYERS.map((L) => (
              <span key={L.id} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}>
                <span style={{ color: LAYER_COLORS[L.id], fontWeight: 700 }}>{L.id}</span>
                <span style={{ display: "inline-block", width: Math.max(2, energyAll[L.id] * 0.6), height: 6, background: LAYER_COLORS[L.id], borderRadius: 3, boxShadow: `0 0 4px ${LAYER_COLORS[L.id]}`, transition: "width 0.1s" }} />
                <span style={muted}>{energyAll[L.id]}%</span>
              </span>
            ))}
          </div>
        </div>

        {/* ── RIGHT: Controls ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

          {/* background + mask images */}
          <div style={panel}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, letterSpacing: 1 }}>background image</div>
            <input type="file" accept="image/*" onChange={(e) => handleBgImage(e.target.files?.[0])} />
            {bgImg && (
              <button onClick={() => setBgImg(null)} style={{ ...btn(false), marginTop: 8, fontSize: 11 }}>remove image</button>
            )}
            <label style={{ ...label12, marginTop: 10 }}>
              gap brightness
              <input type="range" min={0} max={1} step={0.01} value={imageOpacity}
                onChange={(e) => setImageOpacity(Number(e.target.value))} style={{ marginTop: 5 }} />
              <span style={muted}>{Math.round(imageOpacity * 100)}%</span>
            </label>

            <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid #1e1e1e` }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, letterSpacing: 1 }}>audio mask image</div>
              <div style={{ ...muted, fontSize: 11, marginBottom: 8 }}>revealed only where sound is active — animates with the audio</div>
              <input type="file" accept="image/*" onChange={(e) => handleMaskImage(e.target.files?.[0])} />
              {maskImg && (
                <button onClick={() => setMaskImg(null)} style={{ ...btn(false), marginTop: 8, fontSize: 11 }}>remove mask</button>
              )}
            </div>
          </div>

          {/* pattern style */}
          <div style={panel}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, letterSpacing: 1 }}>style — {patternMode}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 8 }}>
              <label style={label12}>
                warp color
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                  <input type="color" value={warpColor} onChange={(e) => setWarpColor(e.target.value)} style={colorPick} />
                  <span style={muted}>{warpColor}</span>
                </div>
              </label>
              <label style={label12}>
                weft color
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                  <input type="color" value={cc} onChange={(e) => setCc(e.target.value)} style={colorPick} />
                  <span style={muted}>{cc}</span>
                </div>
              </label>
            </div>
            <div style={{ ...muted, marginBottom: 10, fontSize: 11 }}>
              audio layers: {LAYERS.map(L => <span key={L.id} style={{ marginRight: 6, color: L.color.replace(/,\s*[\d.]+\)/, ",1)") }}>{L.id} ●</span>)}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[
                ["color opacity", colorAlpha, 0, 1, 0.01, (v) => setColorAlpha(v), `${Math.round(colorAlpha*100)}%`],
                ["weft opacity", ccAlpha, 0, 1, 0.01, (v) => setCcAlpha(v), `${Math.round(ccAlpha*100)}%`],
                ["corner radius", borderRadius, 0, 50, 1, (v) => setBorderRadius(v), `${borderRadius}%`],
                ["size variation", sizeVariation, 0, 1, 0.01, (v) => setSizeVariation(v), `${Math.round(sizeVariation*100)}%`],
                ["posterize", posterizeLevels, 2, 16, 1, (v) => setPosterizeLevels(v), `${posterizeLevels} lvl`],
                ["weave gap", gap, 0, 4, 1, (v) => setGap(v), `${gap}px`],
              ].map(([name, val, min, max, step, set, label]) => (
                <label key={name} style={label12}>
                  {name}
                  <input type="range" min={min} max={max} step={step} value={val}
                    onChange={(e) => set(Number(e.target.value))} style={{ marginTop: 4 }} />
                  <span style={muted}>{label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* ⊞ Grid */}
          <div style={panel}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, letterSpacing: 1 }}>grid size</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <label style={label12}>cols
                <input type="number" value={cols} min={20} max={160}
                  onChange={(e) => setCols(clamp(Number(e.target.value) || 60, 20, 160))} style={{ marginTop: 4 }} />
              </label>
              <label style={label12}>rows
                <input type="number" value={rows} min={20} max={320}
                  onChange={(e) => setRows(clamp(Number(e.target.value) || 80, 20, 320))} style={{ marginTop: 4 }} />
              </label>
            </div>
            <label style={{ ...label12, marginTop: 8 }}>
              cell size
              <input type="range" min={4} max={24} value={cell} onChange={(e) => setCell(Number(e.target.value))} style={{ marginTop: 4 }} />
              <span style={muted}>{cell}px</span>
            </label>
          </div>

          {/* 🎵 Sound Inputs */}
          <div style={panel}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, letterSpacing: 1 }}>sound inputs</div>
            {LAYERS.map((L) => (
              <div key={L.id} style={{ border: `1px solid ${ng20}`, borderRadius: 9, padding: 9, marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <b style={{ color: LAYER_COLORS[L.id], fontSize: 12, letterSpacing: 1 }}>{L.id} — {L.name}</b>
                  <span style={muted}>{energyAll[L.id]}%</span>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(L.type === "mic" ? ["off","mic"] : L.type === "file" ? ["off","file"] : ["off","osc"]).map((m) => (
                    <button key={m} onClick={() => setModes((s) => ({ ...s, [L.id]: m }))} style={btn(modes[L.id] === m)}>
                      {m}
                    </button>
                  ))}
                </div>
                {L.type === "file" && (
                  <div style={{ marginTop: 8 }}>
                    <input type="file" accept="audio/*" onChange={(e) => filePickerToAudio(audioRefs[L.id], e.target.files?.[0], L.id)} />
                    <audio ref={audioRefs[L.id]} controls />
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
                  <label style={label12}>speed
                    <input type="range" min={1} max={30} value={speeds[L.id]}
                      onChange={(e) => setSpeeds((s) => ({ ...s, [L.id]: Number(e.target.value) }))} style={{ marginTop: 4 }} />
                    <span style={muted}>{speeds[L.id]} r/s</span>
                  </label>
                  <label style={label12}>threshold
                    <input type="range" min={0} max={1} step={0.01} value={thresholds[L.id]}
                      onChange={(e) => setThresholds((t) => ({ ...t, [L.id]: Number(e.target.value) }))} style={{ marginTop: 4 }} />
                    <span style={muted}>{Math.round(thresholds[L.id]*100)}%</span>
                  </label>
                </div>
              </div>
            ))}
          </div>

          {/* 🧵 Knitting Instructions */}
          <div style={panel}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, letterSpacing: 1 }}>knitting instructions</div>
            <label style={label12}>float warning (run length)
              <input type="number" min={2} max={20} value={floatWarnOver}
                onChange={(e) => setFloatWarnOver(clamp(Number(e.target.value) || 5, 2, 20))} style={{ marginTop: 4 }} />
            </label>
            {knit.warnings.length > 0
              ? <div style={{ marginTop: 8, color: "#ff4444", fontSize: 11 }}>
                  <b>warnings</b>
                  <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
                    {knit.warnings.slice(0, 8).map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              : <div style={{ marginTop: 8, ...muted, fontSize: 11 }}>no float warnings</div>
            }
            <textarea readOnly value={knit.rowsText.slice(0, 40).join("\n")}
              style={{ width: "100%", height: 180, marginTop: 8, padding: 8, borderRadius: 8, fontSize: 11, boxSizing: "border-box" }} />
            <div style={{ ...muted, marginTop: 6, fontSize: 11 }}>showing 40 of {knit.rowsText.length} rows</div>
            <button onClick={downloadPattern}
              style={{ ...btn(true), marginTop: 8, width: "100%", boxShadow: `0 0 8px ${NG}` }}>
              download full pattern ({knit.rowsText.length} rows)
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
