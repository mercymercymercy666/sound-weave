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

// Composites bgImg onto ctx clipped to the provided stitch-shape Path2D.
// This makes the image look like part of the fabric texture instead of a photographic overlay.
function compositeImgThrough(ctx, bgImg, W, H, path, { blend = "multiply", opacity = 0.75, lineWidth = 1, filled = false } = {}) {
  if (!bgImg || !W || !H) return;
  try {
    const off = document.createElement("canvas"); off.width = W; off.height = H;
    const ox = off.getContext("2d");
    const iw = bgImg.naturalWidth || bgImg.width || W;
    const ih = bgImg.naturalHeight || bgImg.height || H;
    const scale = Math.max(W / iw, H / ih);
    ox.imageSmoothingEnabled = true;
    ox.drawImage(bgImg, (W - iw * scale) / 2, (H - ih * scale) / 2, iw * scale, ih * scale);
    ox.globalCompositeOperation = "destination-in";
    if (filled) { ox.fillStyle = "rgba(255,255,255,1)"; ox.fill(path); }
    ox.lineWidth = lineWidth; ox.lineCap = "round"; ox.lineJoin = "round";
    ox.strokeStyle = "rgba(255,255,255,1)"; if (!filled) ox.stroke(path);
    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.globalCompositeOperation = blend;
    ctx.drawImage(off, 0, 0);
    ctx.restore();
  } catch(_) {}
}

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

  // Background: dark base
  ctx.fillStyle = "#1c1c1c";
  ctx.fillRect(0, 0, W, H);
  // bgImg composited through cell-shaped mask (knit-fabric look, not photographic overlay)
  if (bgImg) {
    const p = new Path2D();
    const cs = cell - gap;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const xp = x * cell + gap / 2, yp = y * cell + gap / 2;
      const r = borderRadius > 0 ? Math.min(borderRadius * cs * 0.012, cs / 2) : 0;
      if (r > 0) { p.roundRect(xp, yp, cs, cs, r); } else { p.rect(xp, yp, cs, cs); }
    }
    compositeImgThrough(ctx, bgImg, W, H, p, { blend: "screen", opacity: imageOpacity * 0.8, filled: true });
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
        // Subtle layer color tint over mask image — multiply so image shows through
        ctx.globalCompositeOperation = "multiply";
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = `rgb(${tintR},${tintG},${tintB})`;
        ctx.fillRect(xp, yp, cw, ch);
        ctx.globalCompositeOperation = "source-over";
      } else if (audioActive && bgImg) {
        // Audio-active + bgImg: use multiply so image pixel always visible under color
        ctx.globalCompositeOperation = "multiply";
        ctx.globalAlpha = Math.min(tintA, 0.60);
        ctx.fillStyle = `rgb(${tintR},${tintG},${tintB})`;
        ctx.fillRect(xp, yp, cw, ch);
        ctx.globalCompositeOperation = "source-over";
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
    const p = new Path2D();
    const r = Math.max(2, cell * 0.4);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const cx = x * cell + cell / 2, cy = y * cell + cell / 2;
      p.moveTo(cx + r, cy); p.arc(cx, cy, r, 0, Math.PI * 2);
    }
    compositeImgThrough(ctx, bgImg, W, H, p, { blend: "screen", opacity: imageOpacity * 0.85, filled: true });
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
        // Base fill: audio-active + bgImg → blend image through circle, multiply tint
        if (audioActive && bgImg) {
          ctx.save();
          ctx.beginPath(); ctx.arc(cx, cy, stRadius, 0, Math.PI * 2); ctx.clip();
          const iw = bgImg.naturalWidth || W, ih = bgImg.naturalHeight || H;
          const imgSc = Math.max(W / iw, H / ih);
          ctx.drawImage(bgImg, (W - iw * imgSc) / 2, (H - ih * imgSc) / 2, iw * imgSc, ih * imgSc);
          ctx.globalCompositeOperation = "multiply";
          ctx.globalAlpha = Math.min(alpha, 0.60);
          ctx.fillStyle = `rgb(${stR},${stG},${stB})`; ctx.fill();
          ctx.globalCompositeOperation = "source-over";
          ctx.restore();
        } else {
          ctx.beginPath(); ctx.arc(cx, cy, stRadius, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${stR},${stG},${stB},${alpha})`; ctx.fill();
        }
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
    const sw = Math.max(2, (cell - gap) * (0.7 + sizeVariation * 0.2));
    const p = new Path2D();
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const xp = x * cell + (cell - sw) / 2, yp = y * cell + (cell - sw) / 2;
      const r = borderRadius > 0 ? Math.min(borderRadius * sw * 0.012, sw / 2) : 0;
      if (r > 0) { p.roundRect(xp, yp, sw, sw, r); } else { p.rect(xp, yp, sw, sw); }
    }
    compositeImgThrough(ctx, bgImg, W, H, p, { blend: "screen", opacity: imageOpacity * 0.9, filled: true });
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
        if (audioActive && bgImg) {
          // Drop shadow pass (shape only, transparent fill)
          ctx.save();
          ctx.shadowColor = "rgba(0,0,0,0.75)";
          ctx.shadowBlur = Math.max(2, sw * 0.35);
          ctx.shadowOffsetY = Math.max(1, sw * 0.18);
          ctx.globalAlpha = 0.01;
          ctx.fillStyle = "rgba(0,0,0,0)";
          ctx.beginPath();
          if (rad > 0) ctx.roundRect(px, py, sw, sh, rad); else ctx.rect(px, py, sw, sh);
          ctx.fill();
          ctx.restore();
          // bgImg clipped to stitch + multiply tint — image pixel always visible
          ctx.save();
          ctx.beginPath();
          if (rad > 0) ctx.roundRect(px, py, sw, sh, rad); else ctx.rect(px, py, sw, sh);
          ctx.clip();
          const iw2 = bgImg.naturalWidth || W, ih2 = bgImg.naturalHeight || H;
          const imgSc2 = Math.max(W / iw2, H / ih2);
          ctx.drawImage(bgImg, (W - iw2 * imgSc2) / 2, (H - ih2 * imgSc2) / 2, iw2 * imgSc2, ih2 * imgSc2);
          ctx.globalCompositeOperation = "multiply";
          ctx.globalAlpha = Math.min(alpha, 0.60);
          ctx.fillStyle = `rgb(${tR},${tG},${tB})`; ctx.fill();
          ctx.globalCompositeOperation = "source-over";
          ctx.restore();
        } else {
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
        }

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
          const vW = sw * 0.52, vTop = py + sh * 0.10, vBot = py + sh * 0.82;
          const vLw = Math.max(1.5, sw * 0.22);
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

// Average FFT bins in a frequency band [lo01, hi01] (0..1 fractions of bin count)
function bandAvg(bins, lo01, hi01) {
  const n = bins.length;
  const lo = Math.floor(lo01 * n);
  const hi = Math.min(n - 1, Math.floor(hi01 * n));
  if (lo > hi) return 0;
  let sum = 0;
  for (let i = lo; i <= hi; i++) sum += bins[i];
  return sum / ((hi - lo + 1) * 255);
}

// Draw Artikulation-style notation marks at a grid row based on frequency bands
function drawNotationAtRow(ctx, bins, energy01, cursorY, color, alpha, cell, cols) {
  if (!bins || bins.length === 0 || energy01 < 0.01) return;
  const sub  = bandAvg(bins, 0.00, 0.03);
  const bass = bandAvg(bins, 0.03, 0.10);
  const lmid = bandAvg(bins, 0.10, 0.25);
  const mid  = bandAvg(bins, 0.25, 0.50);
  const hi   = bandAvg(bins, 0.50, 0.80);
  const air  = bandAvg(bins, 0.80, 1.00);
  const cy = cursorY * cell + cell * 0.5;
  const totalW = cols * cell;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (sub > 0.04) {
    const count = Math.max(1, Math.floor(sub * 5));
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.5, cell * 0.12); ctx.setLineDash([]);
    for (let i = 0; i < count; i++) {
      const cx = ((i + 0.5) / count) * totalW;
      const r  = cell * (0.3 + sub * 0.45);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    }
  }
  if (bass > 0.04) {
    const count = Math.max(1, Math.floor(bass * 9));
    ctx.fillStyle = color;
    const h = Math.max(1.5, cell * 0.16);
    for (let i = 0; i < count; i++) {
      const x0 = (i / count) * totalW + cell * 0.08;
      const w  = (totalW / count) * (0.4 + bass * 0.55);
      ctx.fillRect(x0, cy - h * 0.5, w, h);
    }
  }
  if (lmid > 0.04) {
    const count = Math.max(2, Math.floor(lmid * 12));
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, cell * 0.10); ctx.setLineDash([]);
    for (let i = 0; i < count; i++) {
      const cx = ((i + 0.5) / count) * totalW;
      const r  = cell * (0.20 + lmid * 0.22);
      ctx.beginPath();
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r * 0.6, cy);
      ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r * 0.6, cy);
      ctx.closePath(); ctx.stroke();
    }
  }
  if (mid > 0.04) {
    const count = Math.max(2, Math.floor(mid * 16));
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.2, cell * 0.13); ctx.lineCap = "round"; ctx.setLineDash([]);
    for (let i = 0; i < count; i++) {
      const cx = ((i + 0.5) / count) * totalW;
      const h  = cell * (0.28 + mid * 0.42);
      ctx.beginPath();
      ctx.moveTo(cx - h * 0.5, cy - h * 0.4); ctx.lineTo(cx, cy + h * 0.5); ctx.lineTo(cx + h * 0.5, cy - h * 0.4);
      ctx.stroke();
    }
  }
  if (hi > 0.03) {
    const count = Math.max(3, Math.floor(hi * 22));
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const t  = ((i * 1.618 + cursorY * 0.31) % 1 + 1) % 1;
      const cx = t * totalW;
      const r  = Math.max(1.5, cell * (0.07 + hi * 0.10));
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (air > 0.03) {
    const count = Math.max(2, Math.floor(air * 14));
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(0.8, cell * 0.09); ctx.lineCap = "round"; ctx.setLineDash([]);
    for (let i = 0; i < count; i++) {
      const t  = ((i * 2.618 + cursorY * 0.17) % 1 + 1) % 1;
      const cx = t * totalW;
      const r  = cell * (0.14 + air * 0.20);
      const d  = r * 0.72;
      ctx.beginPath();
      ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
      ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d);
      ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx - d, cy + d);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// Draws a parchment/twilight knit-stitch pattern — V-shapes per cell, per-layer color fills
function drawStitch(canvas, grids, layers, bgImg, cell, opts = {}) {
  const { rows, cols, maskImg = null, invert = false,
    warpColor = "#c8a96e", cc = "#e8d5b7",
    colorAlpha = 0.85, ccAlpha = 0.18 } = opts;
  canvas.width = cols * cell;
  canvas.height = rows * cell;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;

  const W = cols * cell, H = rows * cell;
  ctx.fillStyle = invert ? "#fdf3e7" : "#16121e";
  ctx.fillRect(0, 0, W, H);

  // Build V-stitch path for all cells (shared for bgImg masking and base texture)
  const vPath = new Path2D();
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const cx = x * cell, cy = y * cell;
    vPath.moveTo(cx + cell * 0.12, cy + cell * 0.10);
    vPath.lineTo(cx + cell * 0.50, cy + cell * 0.88);
    vPath.lineTo(cx + cell * 0.88, cy + cell * 0.10);
  }

  // bgImg composited through V-stitch mask (same technique as poster)
  if (bgImg) {
    compositeImgThrough(ctx, bgImg, W, H, vPath, {
      blend: invert ? "multiply" : "screen",
      opacity: invert ? 0.75 : 0.65,
      lineWidth: Math.max(1.5, cell * 0.13),
    });
  }

  const [wpR, wpG, wpB] = parseColor(warpColor);
  const [ccR, ccG, ccB] = parseColor(cc);

  // Base V-texture — uses warpColor at low opacity so MC picker is always visible
  ctx.strokeStyle = `rgba(${wpR},${wpG},${wpB},0.20)`;
  ctx.lineWidth = Math.max(0.7, cell * 0.09);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.stroke(vPath);
  for (const L of layers) {
    const grid01 = grids[L.id];
    if (!grid01) continue;

    // Square fill at low opacity — use cc color
    ctx.fillStyle = `rgb(${ccR},${ccG},${ccB})`;
    ctx.globalAlpha = ccAlpha;
    ctx.globalCompositeOperation = "source-over";
    for (let y = 0; y < rows; y++) {
      const row = grid01[y]; if (!row) continue;
      for (let x = 0; x < cols; x++) {
        if (row[x] === 1) ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    // V-stroke on top — use warpColor (MC)
    ctx.strokeStyle = `rgb(${wpR},${wpG},${wpB})`;
    ctx.lineWidth = Math.max(1.5, cell * 0.16);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.globalCompositeOperation = bgImg ? "multiply" : "source-over";
    ctx.globalAlpha = bgImg ? 0.75 : colorAlpha;
    ctx.beginPath();
    for (let y = 0; y < rows; y++) {
      const row = grid01[y]; if (!row) continue;
      for (let x = 0; x < cols; x++) {
        if (row[x] === 1) {
          const cx = x * cell, cy = y * cell;
          ctx.moveTo(cx + cell * 0.12, cy + cell * 0.10);
          ctx.lineTo(cx + cell * 0.50, cy + cell * 0.88);
          ctx.lineTo(cx + cell * 0.88, cy + cell * 0.10);
        }
      }
    }
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  if (maskImg) {
    for (const L of layers) {
      const grid01 = grids[L.id]; if (!grid01) continue;
      for (let y = 0; y < rows; y++) {
        const row = grid01[y]; if (!row) continue;
        for (let x = 0; x < cols; x++) {
          if (row[x] === 1) {
            const sw = cell - pad * 2, sh = cell - pad * 2;
            const px = x * cell + pad, py = y * cell + pad;
            ctx.save();
            ctx.beginPath(); ctx.rect(px, py, sw, sh); ctx.clip();
            const mw = maskImg.naturalWidth / cols, mh = maskImg.naturalHeight / rows;
            ctx.globalAlpha = 0.9;
            ctx.drawImage(maskImg, x * mw, y * mh, mw, mh, px, py, sw, sh);
            ctx.restore();
          }
        }
      }
    }
  }
}

// Cached offscreen canvas for drawMediaOverlay — avoids per-frame allocation
let _mediaOffCanvas = null;

// Reveals a media element (image or video) through a brush-painted mask canvas
function drawMediaOverlay(canvas, mediaEl, maskCanvas, opacity, blendMode) {
  if (!mediaEl || !maskCanvas) return;
  const W = canvas.width, H = canvas.height;
  if (!W || !H) return;
  const mw = mediaEl.videoWidth ?? mediaEl.naturalWidth ?? W;
  const mh = mediaEl.videoHeight ?? mediaEl.naturalHeight ?? H;
  if (!mw || !mh) return;
  if (!_mediaOffCanvas || _mediaOffCanvas.width !== W || _mediaOffCanvas.height !== H) {
    _mediaOffCanvas = document.createElement("canvas");
    _mediaOffCanvas.width = W; _mediaOffCanvas.height = H;
  }
  const off = _mediaOffCanvas;
  const offCtx = off.getContext("2d");
  offCtx.clearRect(0, 0, W, H);
  const scale = Math.max(W / mw, H / mh);
  offCtx.drawImage(mediaEl, (W - mw * scale) / 2, (H - mh * scale) / 2, mw * scale, mh * scale);
  offCtx.globalCompositeOperation = "destination-in";
  offCtx.drawImage(maskCanvas, 0, 0, W, H);
  offCtx.globalCompositeOperation = "source-over";
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.globalCompositeOperation = blendMode;
  ctx.drawImage(off, 0, 0);
  ctx.restore();
}

async function imageToGrid01(file, rows, cols, { threshold = 0.5, invert = false } = {}) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.createElement("canvas");
    c.width = cols; c.height = rows;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cols, rows);
    ctx.drawImage(img, 0, 0, cols, rows);
    const data = ctx.getImageData(0, 0, cols, rows).data;
    const grid = makeGrid(rows, cols, 0);
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const i = (y * cols + x) * 4;
        const lum = (data[i] * 0.2126 + data[i+1] * 0.7152 + data[i+2] * 0.0722) / 255;
        let bit = lum < threshold ? 1 : 0;
        if (invert) bit = bit ? 0 : 1;
        grid[y][x] = bit;
      }
    return grid;
  } finally { URL.revokeObjectURL(url); }
}

// ---- AUDIO LAYER ENGINE ----
const BAND_RANGES = { sub:[0.00,0.03], bass:[0.03,0.10], lmid:[0.10,0.25], mid:[0.25,0.50], hi:[0.50,0.80], air:[0.80,1.00] };
function computeBandEnergies(bins) {
  const all = (() => { let s=0; for(let i=0;i<bins.length;i++) s+=bins[i]; return clamp(Math.pow(s/bins.length/255,0.7),0,1); })();
  const boost = (v, b, p) => clamp(Math.pow(v*b, p), 0, 1);
  return {
    all,
    sub:  boost(bandAvg(bins, ...BAND_RANGES.sub),  3.5, 0.55),
    bass: boost(bandAvg(bins, ...BAND_RANGES.bass), 3.0, 0.55),
    lmid: boost(bandAvg(bins, ...BAND_RANGES.lmid), 2.5, 0.60),
    mid:  boost(bandAvg(bins, ...BAND_RANGES.mid),  2.0, 0.60),
    hi:   boost(bandAvg(bins, ...BAND_RANGES.hi),   3.0, 0.65),
    air:  boost(bandAvg(bins, ...BAND_RANGES.air),  4.0, 0.65),
  };
}

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
  const bandsRef = useRef({ all:0, sub:0, bass:0, lmid:0, mid:0, hi:0, air:0 });

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
    bandsRef.current = { all:0, sub:0, bass:0, lmid:0, mid:0, hi:0, air:0 };
  }

  function startTick(analyser) {
    const bins = new Uint8Array(analyser.frequencyBinCount);
    let lastUpdateMs = 0;
    const tick = (now) => {
      analyser.getByteFrequencyData(bins);
      binsRef.current = bins;
      const b = computeBandEnergies(bins);
      bandsRef.current = b;
      // Throttle React state to ~20fps — grid runs at full 60fps via refs
      if (now - lastUpdateMs > 50) { lastUpdateMs = now; setEnergy(b.all); }
      rafRef.current = requestAnimationFrame(tick);
    };
    tick(0);
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

  return { energy, binsRef, bandsRef, startMic, startFileFromElement, startOsc, updateOsc, stop, streamRef };
}

function spectralCentroid01(bins) {
  let num = 0, den = 0;
  const n = bins.length;
  for (let i = 0; i < n; i++) { const mag = bins[i] / 255; den += mag; num += mag * (i / (n - 1)); }
  return den > 1e-6 ? clamp(num / den, 0, 1) : 0;
}

function brushRowFromAudio({ bins, cols, y, energy01, threshold, tSec, guideRow = null, imageMode = "OFF" }) {
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
    let th = threshold;
    if (imageMode === "BIAS" && guideRow && guideRow[x] === 1) th = clamp(threshold - 0.18, 0, 1);
    let bit = v >= th ? 1 : 0;
    if (Math.abs(x - cursorX) <= thick) bit = 1;
    const stripes = Math.sin(phase + x * 0.35) > 0.55 ? 1 : 0;
    if (energy01 > 0.12) bit = bit | (stripes & (v > th * 0.9 ? 1 : 0));
    if (imageMode === "MASK"  && guideRow) bit = guideRow[x] === 1 ? bit : 0;
    if (imageMode === "CARVE" && guideRow) bit = guideRow[x] === 1 ? 0 : bit;
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

// ── POSTER draw functions ─────────────────────────────────────────────────────
function posterRng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0x100000000; };
}

function compositeTextsToGrid(texts, gridW, gridH) {
  const c = document.createElement("canvas");
  c.width = gridW; c.height = gridH;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, gridW, gridH);
  ctx.fillStyle = "#000";
  for (const t of texts) {
    if (!t.content) continue;
    ctx.font = `${t.bold ? "bold " : ""}${t.fontSize}px ${t.fontFamily}`;
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    const lines = t.content.split("\n");
    const lineH = t.fontSize * 1.3;
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], t.x, t.y + i * lineH);
  }
  const data = ctx.getImageData(0, 0, gridW, gridH).data;
  const grid = [];
  for (let y = 0; y < gridH; y++) {
    const row = [];
    for (let x = 0; x < gridW; x++) {
      const i = (y * gridW + x) * 4;
      const lum = (data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114) / 255;
      row.push(lum < 0.5 ? 1 : 0);
    }
    grid.push(row);
  }
  return grid;
}

function getPosterTextBounds(t) {
  const c = document.createElement("canvas"); c.width = 4000; c.height = 1;
  const ctx = c.getContext("2d");
  ctx.font = `${t.bold ? "bold " : ""}${t.fontSize}px ${t.fontFamily}`;
  const lines = t.content.split("\n");
  const w = Math.max(...lines.map(l => ctx.measureText(l || " ").width), t.fontSize * 0.5);
  const h = lines.length * t.fontSize * 1.3;
  return { x: t.x, y: t.y, w, h };
}

function drawPosterSelectionHighlight(canvas, texts, selectedId, cell) {
  if (selectedId == null || !texts) return;
  const t = texts.find(x => x.id === selectedId);
  if (!t) return;
  const b = getPosterTextBounds(t);
  const ctx = canvas.getContext("2d");
  const pad = 2;
  ctx.save();
  ctx.strokeStyle = "rgba(90,150,255,0.85)"; ctx.lineWidth = 1.5;
  ctx.setLineDash([Math.max(3, cell * 0.4), Math.max(2, cell * 0.3)]);
  ctx.strokeRect(b.x * cell - pad, b.y * cell - pad, b.w * cell + pad * 2, b.h * cell + pad * 2);
  ctx.setLineDash([]);
  // Move handle — top-left corner (blue)
  ctx.fillStyle = "rgba(90,150,255,0.9)";
  ctx.fillRect(b.x * cell - pad, b.y * cell - pad, 8, 8);
  // Resize handle — bottom-right corner (orange)
  ctx.fillStyle = "rgba(255,150,30,0.95)";
  const rx = (b.x + b.w) * cell + pad - 8, ry = (b.y + b.h) * cell + pad - 8;
  ctx.fillRect(rx, ry, 8, 8);
  // Resize arrow indicator inside handle
  ctx.fillStyle = "#fff"; ctx.font = "7px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("↘", rx + 4, ry + 4);
  ctx.restore();
}

// Returns true if (gx,gy) in grid units is near the resize handle of text t
function hitPosterResizeHandle(t, gx, gy, cell) {
  const b = getPosterTextBounds(t);
  const hx = b.x + b.w, hy = b.y + b.h; // handle in grid units
  const hitR = 8 / cell; // 8px hit radius in grid units
  return Math.abs(gx - hx) < hitR && Math.abs(gy - hy) < hitR;
}

function drawStaveGroup(ctx, centerRow, gridW, cell, color, seed) {
  const rand = posterRng(seed);
  const totalW = gridW * cell; const cy = centerRow * cell;
  const staveH = cell * 3.2; const gap = staveH / 4;
  ctx.strokeStyle = color; ctx.lineWidth = Math.max(0.4, cell * 0.05);
  ctx.lineCap = "butt"; ctx.setLineDash([]);
  ctx.globalAlpha = 0.20;
  for (let li = 0; li < 5; li++) {
    const ly = cy - staveH / 2 + li * gap;
    ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(totalW, ly); ctx.stroke();
  }
  const bars = Math.floor(2 + rand() * 4);
  ctx.globalAlpha = 0.15; ctx.lineWidth = Math.max(0.6, cell * 0.07);
  for (let bi = 0; bi < bars; bi++) {
    const bx = ((bi + 1) / (bars + 1)) * totalW;
    ctx.beginPath(); ctx.moveTo(bx, cy - staveH/2 - gap*0.15); ctx.lineTo(bx, cy + staveH/2 + gap*0.15); ctx.stroke();
  }
  const count = Math.floor(5 + rand() * 12);
  ctx.globalAlpha = 0.42; ctx.lineCap = "round";
  for (let i = 0; i < count; i++) {
    const tPos = (i + 0.25 + rand() * 0.5) / count;
    const sx = tPos * totalW; const li = Math.floor(rand() * 7) - 1;
    const sy = cy - staveH / 2 + li * gap;
    const r = cell * (0.20 + rand() * 0.28);
    const type = Math.floor(rand() * 6);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = Math.max(0.8, cell * 0.09);
    ctx.beginPath();
    if      (type === 0) { ctx.arc(sx, sy, r, 0, Math.PI*2); ctx.stroke(); }
    else if (type === 1) { ctx.ellipse(sx, sy, r*0.75, r*0.55, -0.4, 0, Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.lineWidth = Math.max(0.6, cell*0.07); ctx.moveTo(sx+r*0.68, sy); ctx.lineTo(sx+r*0.68, sy-cell*1.8); ctx.stroke(); }
    else if (type === 2) { ctx.moveTo(sx, sy-r); ctx.lineTo(sx+r*0.6, sy); ctx.lineTo(sx, sy+r); ctx.lineTo(sx-r*0.6, sy); ctx.closePath(); ctx.stroke(); }
    else if (type === 3) { ctx.moveTo(sx-r*0.6, sy-r*0.4); ctx.lineTo(sx, sy+r*0.5); ctx.lineTo(sx+r*0.6, sy-r*0.4); ctx.stroke(); }
    else if (type === 4) { ctx.arc(sx, sy, r*0.35, 0, Math.PI*2); ctx.fill(); }
    else { const d = r*0.72; ctx.moveTo(sx-r,sy); ctx.lineTo(sx+r,sy); ctx.moveTo(sx,sy-r); ctx.lineTo(sx,sy+r); ctx.moveTo(sx-d,sy-d); ctx.lineTo(sx+d,sy+d); ctx.moveTo(sx+d,sy-d); ctx.lineTo(sx-d,sy+d); ctx.stroke(); }
  }
  ctx.globalAlpha = 1; ctx.setLineDash([]);
}

function drawPoster(canvas, { gridW, gridH, cell, texts, fabricLayers, fabricInvert, staveCount, notationSeed, bgImg = null, sourceCanvas = null, posterLayerAlpha = 1 }) {
  const W = gridW * cell; const H = gridH * cell;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const BG          = fabricInvert ? "#16121e" : "#fdf3e7";
  const FABRIC_BASE = fabricInvert ? "rgba(220,185,130,0.18)" : "rgba(140,95,40,0.20)";
  const NOTATION    = fabricInvert ? "rgba(200,170,110,0.7)" : "#8B6845";
  const TEXT_INK    = fabricInvert ? "#fdf3e7" : "#3d2b1f";
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
  if (sourceCanvas && sourceCanvas.width > 0 && sourceCanvas.height > 0) {
    // Use live edit canvas as fabric base — mirrors whatever mode is active
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sourceCanvas, 0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
  } else {
  // Build a single V-stitch path (all cells batched) — reused for both image masking and base texture
  const vPath = new Path2D();
  for (let y = 0; y < gridH; y++) for (let x = 0; x < gridW; x++) {
    const cx = x * cell; const cy = y * cell;
    vPath.moveTo(cx + cell*0.12, cy + cell*0.10);
    vPath.lineTo(cx + cell*0.50, cy + cell*0.88);
    vPath.lineTo(cx + cell*0.88, cy + cell*0.10);
  }
  // If bgImg: composite it through the V-stitch mask so the image IS the fabric texture
  if (bgImg) {
    const off = document.createElement("canvas"); off.width = W; off.height = H;
    const ox = off.getContext("2d");
    const iw = bgImg.naturalWidth || bgImg.width || W;
    const ih = bgImg.naturalHeight || bgImg.height || H;
    const scale = Math.max(W / iw, H / ih);
    ox.imageSmoothingEnabled = true;
    ox.drawImage(bgImg, (W - iw*scale)/2, (H - ih*scale)/2, iw*scale, ih*scale);
    // Clip to V-stitch shapes only
    ox.globalCompositeOperation = "destination-in";
    ox.lineWidth = Math.max(1.5, cell * 0.13); ox.lineCap = "round"; ox.lineJoin = "round";
    ox.strokeStyle = "rgba(255,255,255,0.9)"; ox.stroke(vPath);
    // Blend image-in-stitches onto poster
    ctx.save();
    ctx.globalAlpha = fabricInvert ? 0.60 : 0.70;
    ctx.globalCompositeOperation = fabricInvert ? "screen" : "multiply";
    ctx.drawImage(off, 0, 0);
    ctx.restore();
  }
  // Base V-texture (FABRIC_BASE) drawn on top of image-in-stitches
  ctx.strokeStyle = FABRIC_BASE; ctx.lineWidth = Math.max(0.7, cell * 0.09);
  ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke(vPath);
  } // end else (no sourceCanvas)
  // Audio fabric layers
  if (fabricLayers && fabricLayers.length > 0) {
    const pad = Math.max(1, cell * 0.10);
    for (const L of fabricLayers) {
      const { grid01, color, alpha } = L; if (!grid01) continue;
      const la = alpha * posterLayerAlpha;
      ctx.fillStyle = color; ctx.globalAlpha = la * 0.45;
      for (let y = 0; y < gridH; y++) for (let x = 0; x < gridW; x++)
        if (grid01[y]?.[x] === 1) ctx.fillRect(x*cell+pad, y*cell+pad, cell-pad*2, cell-pad*2);
      ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.2, cell*0.14);
      ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.globalAlpha = la;
      ctx.beginPath();
      for (let y = 0; y < gridH; y++) for (let x = 0; x < gridW; x++) {
        if (grid01[y]?.[x] === 1) {
          const cx = x*cell; const cy = y*cell;
          ctx.moveTo(cx+cell*0.12, cy+cell*0.10);
          ctx.lineTo(cx+cell*0.50, cy+cell*0.88);
          ctx.lineTo(cx+cell*0.88, cy+cell*0.10);
        }
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
  }
  // Musical staves
  if (staveCount > 0) {
    const spacing = gridH / (staveCount + 1);
    for (let si = 1; si <= staveCount; si++)
      drawStaveGroup(ctx, si * spacing, gridW, cell, NOTATION, notationSeed + si * 17);
  }
  // Knit texts (rendered as stitches)
  const knitTexts    = (texts ?? []).filter(t => t.knit !== false && t.content);
  const legibleTexts = (texts ?? []).filter(t => t.knit === false  && t.content);
  if (knitTexts.length > 0) {
    ctx.lineWidth = Math.max(1.2, cell*0.14);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const t of knitTexts) {
      const tGrid = compositeTextsToGrid([t], gridW, gridH);
      const tColor = t.color ?? TEXT_INK;
      const glowPx = (t.glow ?? 0) * cell;
      const bgOp = t.bgOpacity ?? 0;
      if (bgOp > 0) {
        ctx.fillStyle = t.bgColor ?? BG; ctx.globalAlpha = bgOp;
        for (let y = 0; y < gridH; y++) for (let x = 0; x < gridW; x++)
          if (tGrid[y]?.[x] === 1) ctx.fillRect(x*cell, y*cell, cell, cell);
      }
      ctx.strokeStyle = tColor; ctx.globalAlpha = t.opacity ?? 0.85;
      ctx.globalCompositeOperation = t.blend ?? "source-over";
      if (glowPx > 0) { ctx.shadowColor = tColor; ctx.shadowBlur = glowPx; }
      ctx.beginPath();
      for (let y = 0; y < gridH; y++) for (let x = 0; x < gridW; x++) {
        if (tGrid[y]?.[x] === 1) {
          const cx = x*cell; const cy = y*cell;
          ctx.moveTo(cx+cell*0.12, cy+cell*0.10);
          ctx.lineTo(cx+cell*0.50, cy+cell*0.88);
          ctx.lineTo(cx+cell*0.88, cy+cell*0.10);
        }
      }
      ctx.stroke();
      ctx.shadowBlur = 0; ctx.shadowColor = "transparent"; ctx.globalCompositeOperation = "source-over";
    }
    ctx.globalAlpha = 1;
  }
  // Legible texts (direct fillText)
  if (legibleTexts.length > 0) {
    ctx.imageSmoothingEnabled = true; ctx.textAlign = "left"; ctx.textBaseline = "top";
    for (const t of legibleTexts) {
      const fs = Math.max(8, t.fontSize * cell);
      ctx.font = `${t.bold ? "bold " : ""}${fs}px ${t.fontFamily}`;
      const lines = t.content.split("\n"); const lineH = fs * 1.25;
      const textColor = t.color ?? TEXT_INK;
      const glowPx = (t.glow ?? 0) * cell;
      if (glowPx > 0) {
        ctx.shadowColor = textColor;
        ctx.shadowBlur = glowPx;
      } else {
        ctx.shadowColor = fabricInvert ? "rgba(0,0,0,0.5)" : "rgba(255,255,255,0.6)";
        ctx.shadowBlur = Math.max(2, cell * 0.5);
      }
      ctx.fillStyle = textColor;
      ctx.globalAlpha = t.opacity ?? 0.92;
      ctx.globalCompositeOperation = t.blend ?? "source-over";
      for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], t.x * cell, t.y * cell + i * lineH);
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.shadowBlur = 0; ctx.shadowColor = "transparent"; ctx.globalAlpha = 1; ctx.imageSmoothingEnabled = false;
  }
}

// Default per-band colors: A=sun (red→yellow), others=shades of their base hue
const DEFAULT_LAYER_BAND_COLORS = {
  A: { all:"#ff5500", sub:"#ff1100", bass:"#ff4400", lmid:"#ff7700", mid:"#ffaa00", hi:"#ffcc00", air:"#ffe066" },
  B: { all:"#0088ff", sub:"#003380", bass:"#0055cc", lmid:"#0077ff", mid:"#0088ff", hi:"#44aaff", air:"#88ccff" },
  C: { all:"#00c878", sub:"#004422", bass:"#007744", lmid:"#00aa55", mid:"#00c878", hi:"#44dd99", air:"#88ffcc" },
  D: { all:"#ff8c00", sub:"#883300", bass:"#bb5500", lmid:"#ee7700", mid:"#ff8c00", hi:"#ffaa33", air:"#ffcc77" },
  F: { all:"#00d4d4", sub:"#003333", bass:"#006666", lmid:"#009999", mid:"#00d4d4", hi:"#44eeee", air:"#88ffff" },
  G: { all:"#ff66cc", sub:"#660033", bass:"#990066", lmid:"#cc3399", mid:"#ff66cc", hi:"#ff99dd", air:"#ffccee" },
  H: { all:"#b0e050", sub:"#334400", bass:"#667700", lmid:"#99aa00", mid:"#b0e050", hi:"#ccee77", air:"#ddeebb" },
};
const IDS = ["A", "B", "C", "D", "F", "G", "H"];

// Poster font options — includes user-requested + stitch-friendly Google Fonts
const POSTER_FONTS = [
  { label: "Serif",            value: "serif" },
  { label: "Sans-serif",       value: "sans-serif" },
  { label: "Monospace",        value: "monospace" },
  { label: "Baskerville",      value: "'Libre Baskerville', Baskerville, serif" },
  { label: "Futura / Jost",    value: "Futura, Jost, 'Century Gothic', sans-serif" },
  { label: "Alte Haas",        value: "'Alte Haas Grotesk', 'Helvetica Neue', Arial, sans-serif" },
  { label: "Comhencium",       value: "Comhencium, serif" },
  { label: "Council",          value: "Council, serif" },
  { label: "Courier Prime",    value: "'Courier Prime', 'Courier New', monospace" },
  { label: "Josefin Sans",     value: "'Josefin Sans', sans-serif" },
  { label: "Cinzel",           value: "Cinzel, serif" },
  { label: "Playfair Display", value: "'Playfair Display', serif" },
  { label: "Cormorant",        value: "'Cormorant Garamond', serif" },
  { label: "IM Fell English",  value: "'IM Fell English', serif" },
  { label: "Special Elite",    value: "'Special Elite', cursive" },
  { label: "Bebas Neue",       value: "'Bebas Neue', sans-serif" },
];

export default function App() {
  const [layerColors, setLayerColors] = useState(DEFAULT_LAYER_BAND_COLORS);
  const [layerBand, setLayerBand] = useState({ A:"all", B:"all", C:"all", D:"all", F:"all", G:"all", H:"all" });
  const layerBandRef = useRef(layerBand); layerBandRef.current = layerBand;

  const LAYERS = useMemo(() => [
    { id: "A", name: "MIC",     type: "mic",  color: layerColors.A[layerBand.A ?? "all"] },
    { id: "B", name: "AUDIO 1", type: "file", color: layerColors.B[layerBand.B ?? "all"] },
    { id: "C", name: "AUDIO 2", type: "file", color: layerColors.C[layerBand.C ?? "all"] },
    { id: "D", name: "AUDIO 3", type: "file", color: layerColors.D[layerBand.D ?? "all"] },
    { id: "F", name: "AUDIO 4", type: "file", color: layerColors.F[layerBand.F ?? "all"] },
    { id: "G", name: "AUDIO 5", type: "file", color: layerColors.G[layerBand.G ?? "all"] },
    { id: "H", name: "AUDIO 6", type: "file", color: layerColors.H[layerBand.H ?? "all"] },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [layerColors, layerBand]);

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
  const [patternMode, setPatternMode] = useState("weave"); // "weave"|"lace"|"chart"|"stitch"
  const [stitchInvert, setStitchInvert] = useState(false);
  const [editInvert, setEditInvert] = useState(false);
  const editInvertRef = useRef(false);

  const [isRecording, setIsRecording] = useState(false);
  const [performOpen, setPerformOpen] = useState(false);
  const performWinRef = useRef(null);
  const [clips, setClips] = useState([]);
  const [clipStyles, setClipStyles] = useState({}); // id -> style name
  const [clipBlends, setClipBlends] = useState({}); // id -> blend mode
  const [clipNames, setClipNames] = useState({});   // id -> custom display name
  const WARM = "brightness(1.06) saturate(1.35) sepia(0.22)";
  const CLIP_STYLES = {
    warm:      WARM,
    weave:     "sepia(0.7) contrast(1.4) brightness(0.88)",
    stitch:    `${WARM} saturate(2.2) contrast(1.3) hue-rotate(10deg)`,
    chart:     "grayscale(1) contrast(2.5) brightness(1.1)",
    threshold: "grayscale(1) contrast(100)",
    cmyk:      "saturate(3) contrast(0.65) brightness(1.4) hue-rotate(200deg)",
  };
  const BLEND_MODES = ["normal","multiply","screen","overlay","soft-light","difference","luminosity"];
  const clipNextIdRef = useRef(0);
  const clipPerformIds = useRef({}); // localClipId -> last perform-window element id

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

  const [modes, setModes]           = useState({ A: "off", B: "off", C: "off", D: "off", F: "off", G: "off", H: "off" });
  const [speeds, setSpeeds]         = useState({ A: 10,  B: 10,  C: 10,  D: 10,  F: 10,  G: 10,  H: 10 });
  const [thresholds, setThresholds] = useState({ A: 0.55, B: 0.55, C: 0.55, D: 0.55, F: 0.55, G: 0.55, H: 0.55 });
  const [alphas, setAlphas]         = useState({ A: 0.55, B: 0.55, C: 0.55, D: 0.55, F: 0.55, G: 0.55, H: 0.55 });

  // Image guide
  const [imageGuide, setImageGuide] = useState(() => makeGrid(80, 60, 0));
  const [imageMode, setImageMode] = useState("OFF"); // "OFF"|"MASK"|"CARVE"|"BIAS"
  const [imgThreshold, setImgThreshold] = useState(0.50);
  const [imgInvert, setImgInvert] = useState(false);
  const [showImageGuide, setShowImageGuide] = useState(true);
  const [videoGuideActive, setVideoGuideActive] = useState(false);

  // Notation + score overlays
  const [showNotation, setShowNotation] = useState(false);
  const [showScore, setShowScore] = useState(false);

  // Brush/media overlay
  const [ovActiveTool, setOvActiveTool] = useState("grid"); // "grid"|"brush"
  const [ovType, setOvType]             = useState(null);   // null|"image"|"video"
  const [ovBlend, setOvBlend]           = useState("multiply");
  const [ovOpacity, setOvOpacity]       = useState(0.85);
  const [ovBrushSize, setOvBrushSize]   = useState(6);
  const [ovBrushMode, setOvBrushMode]   = useState("reveal"); // "reveal"|"erase"
  const [ovVideoPlaying, setOvVideoPlaying] = useState(false);

  const audioA = useAudioLayer();
  const audioB = useAudioLayer();
  const audioC = useAudioLayer();
  const audioD = useAudioLayer();
  const audioF = useAudioLayer();
  const audioG = useAudioLayer();
  const audioH = useAudioLayer();
  const audioMap = useMemo(
    () => ({ A: audioA, B: audioB, C: audioC, D: audioD, F: audioF, G: audioG, H: audioH }),
    [audioA, audioB, audioC, audioD, audioF, audioG, audioH]
  );
  const audioMapRef = useRef(audioMap);
  audioMapRef.current = audioMap;


  const audioRefB = useRef(null);
  const audioRefC = useRef(null);
  const audioRefD = useRef(null);
  const audioRefF = useRef(null);
  const audioRefG = useRef(null);
  const audioRefH = useRef(null);
  const canvasRef = useRef(null);
  const notationCanvasRef = useRef(null);
  const scoreCanvasRef    = useRef(null);
  const videoRef          = useRef(null);
  const overlayCanvasRef  = useRef(null);
  const overlayMaskRef    = useRef(null);
  const overlayBgCanvasRef = useRef(null); // sits BEHIND main canvas so stitches show on top
  const overlayMediaRef   = useRef(null);
  const ovIsPaintingRef   = useRef(false);
  const maskHistoryRef    = useRef([]); // undo stack for brush strokes
  const ovMouseRef        = useRef({ x: 0, y: 0, over: false });
  const ovParamRef        = useRef({});
  const rowCursorRef      = useRef(rowCursor);
  rowCursorRef.current    = rowCursor;
  const scoreHistRef      = useRef({});

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
    setImageGuide((prev) => resize(prev));
  }, [rows, cols, LAYERS]);

  // Wire modes → audio start/stop
  useEffect(() => { (async () => { try { if (modes.A === "off") await audioA.stop(); if (modes.A === "mic")  await audioA.startMic(); } catch (e) { console.warn(e); setModes(m => ({ ...m, A: "off" })); } })(); }, [modes.A]); // eslint-disable-line
  useEffect(() => { (async () => { try { if (modes.B === "off") await audioB.stop(); if (modes.B === "file") await audioB.startFileFromElement(audioRefB.current); } catch (e) { console.warn(e); setModes(m => ({ ...m, B: "off" })); } })(); }, [modes.B]); // eslint-disable-line
  useEffect(() => { (async () => { try { if (modes.C === "off") await audioC.stop(); if (modes.C === "file") await audioC.startFileFromElement(audioRefC.current); } catch (e) { console.warn(e); setModes(m => ({ ...m, C: "off" })); } })(); }, [modes.C]); // eslint-disable-line
  useEffect(() => { (async () => { try { if (modes.D === "off") await audioD.stop(); if (modes.D === "file") await audioD.startFileFromElement(audioRefD.current); } catch (e) { console.warn(e); setModes(m => ({ ...m, D: "off" })); } })(); }, [modes.D]); // eslint-disable-line
  useEffect(() => { (async () => { try { if (modes.F === "off") await audioF.stop(); if (modes.F === "file") await audioF.startFileFromElement(audioRefF.current); } catch (e) { console.warn(e); setModes(m => ({ ...m, F: "off" })); } })(); }, [modes.F]); // eslint-disable-line
  useEffect(() => { (async () => { try { if (modes.G === "off") await audioG.stop(); if (modes.G === "file") await audioG.startFileFromElement(audioRefG.current); } catch (e) { console.warn(e); setModes(m => ({ ...m, G: "off" })); } })(); }, [modes.G]); // eslint-disable-line
  useEffect(() => { (async () => { try { if (modes.H === "off") await audioH.stop(); if (modes.H === "file") await audioH.startFileFromElement(audioRefH.current); } catch (e) { console.warn(e); setModes(m => ({ ...m, H: "off" })); } })(); }, [modes.H]); // eslint-disable-line
  // Audio → grid paint loop
  useEffect(() => {
    let raf = null;
    let last = performance.now();
    const acc = { A: 0, B: 0, C: 0, D: 0, F: 0, G: 0, H: 0 };

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
              const bandKey = layerBandRef.current[id] ?? "all";
              const energy01 = audio.bandsRef.current[bandKey] ?? audio.energy;
              const y = nextCursor[id] ?? 0;
              const row = brushRowFromAudio({ bins, cols, y, energy01, threshold: thresholds[id] ?? 0.55, tSec, guideRow: imageGuide?.[y], imageMode });
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
  }, [LAYERS, modes, speeds, thresholds, cols, rows, symmetry, imageGuide, imageMode]);

  const combinedGrid = useMemo(() => combineN(grids, combineMode), [grids, combineMode]);

  // Draw canvas
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const drawOpts = { rows, cols, warpColor, cc, gap, imageOpacity, colorAlpha, ccAlpha, borderRadius, sizeVariation, posterizeLevels, maskImg, invert: stitchInvert };
    if (patternMode === "lace")        drawLace(c, grids, LAYERS, bgImg, clamp(cell, 4, 30), drawOpts);
    else if (patternMode === "chart")  drawChart(c, grids, LAYERS, bgImg, clamp(cell, 4, 30), drawOpts);
    else if (patternMode === "stitch") drawStitch(c, grids, LAYERS, bgImg, clamp(cell, 4, 30), drawOpts);
    else                               drawWeave(c, grids, LAYERS, bgImg, clamp(cell, 4, 30), drawOpts);
  }, [patternMode, grids, LAYERS, bgImg, cell, rows, cols, warpColor, cc, gap, imageOpacity, colorAlpha, ccAlpha, borderRadius, sizeVariation, posterizeLevels, maskImg, stitchInvert]);

  // Video guide — sample frames into imageGuide at ~15fps
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !videoGuideActive) return;
    let raf;
    let lastMs = 0;
    const step = (now) => {
      if (vid.readyState >= 2 && now - lastMs >= 1000 / 15) {
        lastMs = now;
        const c = document.createElement("canvas");
        c.width = cols; c.height = rows;
        const ctx2 = c.getContext("2d", { willReadFrequently: true });
        ctx2.fillStyle = "#fff"; ctx2.fillRect(0, 0, cols, rows);
        ctx2.drawImage(vid, 0, 0, cols, rows);
        const data = ctx2.getImageData(0, 0, cols, rows).data;
        const g = makeGrid(rows, cols, 0);
        for (let y = 0; y < rows; y++)
          for (let x = 0; x < cols; x++) {
            const i = (y * cols + x) * 4;
            const lum = (data[i] * 0.2126 + data[i+1] * 0.7152 + data[i+2] * 0.0722) / 255;
            let bit = lum < imgThreshold ? 1 : 0;
            if (imgInvert) bit = bit ? 0 : 1;
            g[y][x] = bit;
          }
        setImageGuide(symmetry ? mirrorVertical01(g) : g);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [videoGuideActive, cols, rows, imgThreshold, imgInvert, symmetry]);

  // Notation overlay RAF loop
  useEffect(() => {
    const nc = notationCanvasRef.current;
    if (!showNotation) {
      if (nc) { const ctx = nc.getContext("2d"); ctx.clearRect(0, 0, nc.width, nc.height); }
      return;
    }
    let raf;
    const step = () => {
      const nc2 = notationCanvasRef.current;
      const sc = canvasRef.current;
      if (!nc2 || !sc) { raf = requestAnimationFrame(step); return; }
      if (nc2.width !== sc.width || nc2.height !== sc.height) { nc2.width = sc.width; nc2.height = sc.height; }
      const ctx = nc2.getContext("2d");
      ctx.clearRect(0, 0, nc2.width, nc2.height);
      const cs = clamp(cell, 4, 30);
      for (const L of LAYERS) {
        if (modes[L.id] === "off") continue;
        const audio = audioMapRef.current[L.id];
        const bins = audio?.binsRef.current;
        const energy01 = audio?.energy ?? 0;
        if (!bins || energy01 < 0.01) continue;
        const cursorY = rowCursorRef.current?.[L.id] ?? 0;
        const prevY = (cursorY - 1 + rows) % rows;
        const a = alphas[L.id] ?? 0.55;
        drawNotationAtRow(ctx, bins, energy01 * 0.35, prevY,   L.color, a * 0.45, cs, cols);
        drawNotationAtRow(ctx, bins, energy01,        cursorY, L.color, a,         cs, cols);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { if (raf) cancelAnimationFrame(raf); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showNotation, LAYERS, modes, alphas, cell, cols, rows]);

  // Score view RAF loop
  const SCORE_LANE_H = 28;
  const SCORE_COLS   = 220;
  useEffect(() => {
    const sc = scoreCanvasRef.current;
    if (!showScore) {
      if (sc) { const ctx = sc.getContext("2d"); ctx.clearRect(0, 0, sc.width, sc.height); }
      return;
    }
    let raf;
    const step = () => {
      const sc2 = scoreCanvasRef.current;
      const stitchC = canvasRef.current;
      if (!sc2 || !stitchC) { raf = requestAnimationFrame(step); return; }
      const W = stitchC.width;
      const H = LAYERS.length * SCORE_LANE_H;
      if (sc2.width !== W || sc2.height !== H) { sc2.width = W; sc2.height = H; }
      const hist = scoreHistRef.current;
      for (const L of LAYERS) {
        const audio = audioMapRef.current[L.id];
        const bins = audio?.binsRef.current;
        const energy01 = audio?.energy ?? 0;
        if (!hist[L.id]) hist[L.id] = [];
        if (modes[L.id] !== "off" && bins && energy01 > 0.005)
          hist[L.id].push({ sub: bandAvg(bins,0,0.03), bass: bandAvg(bins,0.03,0.10), lmid: bandAvg(bins,0.10,0.25), mid: bandAvg(bins,0.25,0.50), hi: bandAvg(bins,0.50,0.80), air: bandAvg(bins,0.80,1), energy: energy01 });
        else hist[L.id].push(null);
        if (hist[L.id].length > SCORE_COLS) hist[L.id].shift();
      }
      const ctx = sc2.getContext("2d");
      ctx.fillStyle = "#0a0a0a"; ctx.fillRect(0, 0, W, H);
      for (let li = 0; li < LAYERS.length; li++) {
        const L = LAYERS[li];
        const laneTop = li * SCORE_LANE_H;
        const laneMid = laneTop + SCORE_LANE_H * 0.5;
        ctx.globalAlpha = 0.22; ctx.strokeStyle = L.color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(18, laneMid); ctx.lineTo(W, laneMid); ctx.stroke();
        ctx.globalAlpha = 0.8; ctx.fillStyle = L.color;
        ctx.font = "bold 9px ui-monospace, monospace"; ctx.fillText(L.id, 4, laneMid + 3);
        ctx.globalAlpha = 1;
        const frames = hist[L.id] || [];
        const colW = (W - 20) / SCORE_COLS;
        for (let ci = 0; ci < frames.length; ci++) {
          const frame = frames[ci]; if (!frame) continue;
          const x = 20 + ci * colW;
          const age = ci / frames.length;
          const bands = [frame.sub, frame.bass, frame.lmid, frame.mid, frame.hi, frame.air];
          const maxV = Math.max(...bands); if (maxV < 0.03) continue;
          const domIdx = bands.indexOf(maxV);
          const centDen = bands.reduce((s,v) => s+v, 0);
          const centNum = bands.reduce((s,v,i) => s+v*i, 0);
          const cent01 = centDen > 1e-6 ? centNum / centDen / 5 : 0.5;
          const yOff = (cent01 - 0.5) * SCORE_LANE_H * 0.72;
          const cy = laneMid + yOff;
          const r = Math.max(2, SCORE_LANE_H * 0.18 * (0.4 + frame.energy * 0.9));
          ctx.globalAlpha = (0.15 + age * 0.85) * (0.55 + frame.energy * 0.45);
          ctx.strokeStyle = L.color; ctx.fillStyle = L.color;
          ctx.lineWidth = Math.max(1, r * 0.25); ctx.lineCap = "round";
          ctx.beginPath();
          switch (domIdx) {
            case 0: ctx.arc(x, cy, r, 0, Math.PI*2); ctx.stroke(); break;
            case 1: ctx.fillRect(x - r*0.22, cy - r, r*0.44, r*2); break;
            case 2: ctx.moveTo(x, cy-r); ctx.lineTo(x+r*0.6,cy); ctx.lineTo(x,cy+r); ctx.lineTo(x-r*0.6,cy); ctx.closePath(); ctx.stroke(); break;
            case 3: ctx.moveTo(x-r*0.55,cy-r*0.45); ctx.lineTo(x,cy+r*0.55); ctx.lineTo(x+r*0.55,cy-r*0.45); ctx.stroke(); break;
            case 4: ctx.arc(x, cy, r*0.55, 0, Math.PI*2); ctx.fill(); break;
            case 5: ctx.moveTo(x-r,cy); ctx.lineTo(x+r,cy); ctx.moveTo(x,cy-r); ctx.lineTo(x,cy+r); ctx.stroke(); break;
          }
        }
      }
      ctx.globalAlpha = 0.35; ctx.strokeStyle = "#39ff14"; ctx.lineWidth = 1;
      ctx.setLineDash([3,4]); ctx.beginPath(); ctx.moveTo(W-1,0); ctx.lineTo(W-1,H); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { if (raf) cancelAnimationFrame(raf); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showScore, LAYERS, modes]);

  // Overlay param sync
  useEffect(() => {
    ovParamRef.current = { ovActiveTool, ovType, ovBlend, ovOpacity, ovBrushSize, ovBrushMode };
  }, [ovActiveTool, ovType, ovBlend, ovOpacity, ovBrushSize, ovBrushMode]);

  editInvertRef.current = editInvert; // inline — always current before RAF reads it

  // Sync perform window background with editInvert
  useEffect(() => {
    const pw = performWinRef.current;
    if (pw && !pw.closed) {
      pw.postMessage({ type: "setBg", color: editInvert ? "#ffffff" : "#000000" }, "*");
      pw.postMessage({ type: "setInvert", invert: editInvert }, "*");
    }
  }, [editInvert, performOpen]);

  // Ctrl+Z: undo brush stroke (edit canvas) or poster design (poster panel)
  useEffect(() => {
    const handler = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "z") {
        e.preventDefault();
        if (posterHistoryRef.current.length > 0) { undoPoster(); } else { undoBrushStroke(); }
      } else if (e.key === "c") {
        const sid = posterParamRef.current.selectedId;
        if (sid == null) return;
        const t = (posterParamRef.current.texts || []).find(t => t.id === sid);
        if (t) { e.preventDefault(); posterCopiedTextRef.current = { ...t }; }
      } else if (e.key === "v") {
        const copied = posterCopiedTextRef.current;
        if (!copied) return;
        e.preventDefault();
        pushPosterHistory();
        const id = posterNextIdRef.current;
        posterNextIdRef.current += 1;
        setPosterNextId(id + 1);
        const newText = { ...copied, id, x: copied.x + 2, y: copied.y + 2 };
        setPosterTexts(prev => [...prev, newText]);
        setPosterSelectedId(id);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Overlay RAF loop — draws overlay + cursor on overlayCanvasRef (on top of stitches, blend modes let stitches show through)
  useEffect(() => {
    let raf;
    const step = () => {
      const oc = overlayCanvasRef.current;
      const sc = canvasRef.current;
      const mc = overlayMaskRef.current;
      const me = overlayMediaRef.current;
      const { ovType: ot, ovOpacity: opacity, ovActiveTool: tool, ovBrushSize: bs } = ovParamRef.current;
      if (!oc || !sc) { raf = requestAnimationFrame(step); return; }
      const W = sc.width, H = sc.height;
      if (oc.width !== W || oc.height !== H) { oc.width = W; oc.height = H; }
      const ctx = oc.getContext("2d");
      ctx.clearRect(0, 0, W, H);
      // Draw overlay — always source-over; CSS mix-blend-mode on the canvas element handles blending with stitches
      if (ot && me && mc) drawMediaOverlay(oc, me, mc, opacity, "source-over");
      // Draw brush cursor on top
      if (tool === "brush" && ot && ovMouseRef.current.over) {
        const cs = clamp(cell, 4, 30);
        ctx.save();
        ctx.strokeStyle = ovParamRef.current.ovBrushMode === "erase" ? "rgba(255,80,80,0.85)" : "rgba(57,255,20,0.85)";
        ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(ovMouseRef.current.x, ovMouseRef.current.y, bs * cs, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]); ctx.restore();
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell]);

  // Perform window mirror — composites main + overlay canvas, streams via ImageBitmap
  useEffect(() => {
    if (!performOpen) return;
    let raf;
    let offCanvas = null;
    const step = () => {
      const pw = performWinRef.current;
      if (!pw || pw.closed) { setPerformOpen(false); return; }
      const mc = canvasRef.current;
      const oc = overlayCanvasRef.current;
      if (!mc) { raf = requestAnimationFrame(step); return; }
      const W = mc.width, H = mc.height;
      if (!W || !H) { raf = requestAnimationFrame(step); return; }
      if (!offCanvas || offCanvas.width !== W || offCanvas.height !== H) {
        offCanvas = document.createElement("canvas");
        offCanvas.width = W; offCanvas.height = H;
      }
      const ctx = offCanvas.getContext("2d");
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(mc, 0, 0);
      if (oc && oc.width === W && oc.height === H) {
        const ob = ovParamRef.current.ovBlend ?? "source-over";
        ctx.globalCompositeOperation = ob;
        ctx.drawImage(oc, 0, 0);
        ctx.globalCompositeOperation = "source-over";
      }
      createImageBitmap(offCanvas).then(bmp => {
        if (!pw || pw.closed) { bmp.close(); setPerformOpen(false); return; }
        pw.postMessage({ type: "frame", bitmap: bmp }, "*", [bmp]);
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [performOpen]);

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
    el.load();
    setTimeout(() => setModes((m) => ({ ...m, [id]: "file" })), 0);
  }

  // Sync-play: reset all loaded file layers to t=0 and start together
  function syncPlayAll() {
    const fileRefs = { B: audioRefB, C: audioRefC, D: audioRefD, F: audioRefF, G: audioRefG, H: audioRefH };
    Object.entries(fileRefs).forEach(([id, ref]) => {
      const el = ref.current;
      if (!el || !el.src) return;
      el.currentTime = 0;
      el.play().catch(() => {});
      setModes((m) => ({ ...m, [id]: "file" }));
    });
  }

  // Pause all file layers
  function pauseAll() {
    const fileRefs = { B: audioRefB, C: audioRefC, D: audioRefD, F: audioRefF, G: audioRefG, H: audioRefH };
    Object.values(fileRefs).forEach(({ current: el }) => { if (el) el.pause(); });
  }

  // Image guide helpers
  async function handleImageGuide(file) {
    if (!file) return;
    const grid = await imageToGrid01(file, rows, cols, { threshold: imgThreshold, invert: imgInvert });
    setImageGuide(symmetry ? mirrorVertical01(grid) : grid);
    setImageMode("MASK");
  }

  // Overlay helpers
  function initOverlayMask() {
    const mc = document.createElement("canvas");
    mc.width = cols; mc.height = rows;
    overlayMaskRef.current = mc;
  }

  function handleOverlayFile(file) {
    if (!file) return;
    if (overlayMediaRef.current?._objUrl) URL.revokeObjectURL(overlayMediaRef.current._objUrl);
    const url = URL.createObjectURL(file);
    initOverlayMask();
    if (file.type.startsWith("video/")) {
      const vid = document.createElement("video");
      vid._objUrl = url;
      vid.src = url; vid.loop = true; vid.muted = true; vid.playsInline = true;
      vid.addEventListener("canplay", () => { overlayMediaRef.current = vid; setOvType("video"); setOvVideoPlaying(false); }, { once: true });
      vid.addEventListener("play",  () => setOvVideoPlaying(true));
      vid.addEventListener("pause", () => setOvVideoPlaying(false));
    } else {
      const img = new Image();
      img._objUrl = url;
      img.src = url;
      img.onload = () => { overlayMediaRef.current = img; setOvType("image"); };
    }
  }

  function removeOverlay() {
    if (overlayMediaRef.current?.pause) overlayMediaRef.current.pause();
    if (overlayMediaRef.current?._objUrl) URL.revokeObjectURL(overlayMediaRef.current._objUrl);
    overlayMediaRef.current = null; overlayMaskRef.current = null;
    setOvType(null); setOvActiveTool("grid");
  }

  function saveMaskSnapshot() {
    const mc = overlayMaskRef.current;
    if (!mc) return;
    const snap = mc.getContext("2d").getImageData(0, 0, mc.width, mc.height);
    maskHistoryRef.current.push(snap);
    if (maskHistoryRef.current.length > 20) maskHistoryRef.current.shift();
  }

  function undoBrushStroke() {
    const mc = overlayMaskRef.current;
    if (!mc || maskHistoryRef.current.length === 0) return;
    mc.getContext("2d").putImageData(maskHistoryRef.current.pop(), 0, 0);
  }

  function ovPaintAt(clientX, clientY) {
    const mc = overlayMaskRef.current;
    const canvas = canvasRef.current;
    if (!mc || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cs = clamp(cell, 4, 30);
    const gx = (clientX - rect.left) / cs;
    const gy = (clientY - rect.top) / cs;
    const br = ovParamRef.current.ovBrushSize;
    const ctx = mc.getContext("2d");
    if (ovParamRef.current.ovBrushMode === "erase") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(255,255,255,1)";
    }
    ctx.beginPath(); ctx.arc(gx, gy, br, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }

  window.getPerformAudioStreams = () => {
    const streams = [];
    if (modes.A === "mic" && audioA.streamRef?.current) streams.push(audioA.streamRef.current);
    [[audioRefB,"B"],[audioRefC,"C"],[audioRefD,"D"],[audioRefF,"F"],[audioRefG,"G"],[audioRefH,"H"]].forEach(([ref,id]) => {
      if (modes[id] === "file" && ref.current?.captureStream) { try { streams.push(ref.current.captureStream()); } catch {} }
    });
    return streams;
  };

  function startRecording() {
    const pw = performWinRef.current;
    if (!pw || pw.closed) return;
    const mimeType = MediaRecorder.isTypeSupported("video/mp4") ? "video/mp4"
      : MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm";
    pw.postMessage({ type: "startRecord", mimeType }, "*");
    setIsRecording(true);
  }

  function stopRecording() {
    const pw = performWinRef.current;
    if (pw && !pw.closed) pw.postMessage({ type: "stopRecord" }, "*");
    setIsRecording(false);
  }

  function saveSession() {
    const toDataUrl = (img) => {
      if (!img) return null;
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      return c.toDataURL();
    };
    const session = {
      v: 1,
      patternMode, rows, cols, cell, symmetry, combineMode,
      warpColor, cc, gap, imageOpacity, colorAlpha, ccAlpha,
      borderRadius, sizeVariation, posterizeLevels,
      editInvert, stitchInvert,
      modes, speeds, thresholds, alphas, layerBand, layerColors,
      grids,
      imageMode, imgThreshold, imgInvert,
      ovBlend, ovOpacity, ovBrushSize, ovBrushMode,
      bgImg: toDataUrl(bgImg),
      maskImg: toDataUrl(maskImg),
      posterTexts, posterNextId,
      posterCell, staveCount, notationSeed, fabricInvert,
      posterOvType, posterOvOpacity, posterOvBlend,
    };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(session)], { type: "application/json" }));
    a.download = `soundweave-${new Date().toISOString().slice(0,19).replace(/[:T]/g,"-")}.json`;
    a.click();
  }

  function loadSession(file) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const s = JSON.parse(e.target.result);
        if (s.patternMode) setPatternMode(s.patternMode);
        if (s.rows)    setRows(s.rows);
        if (s.cols)    setCols(s.cols);
        if (s.cell)    setCell(s.cell);
        if (s.symmetry != null)    setSymmetry(s.symmetry);
        if (s.combineMode)         setCombineMode(s.combineMode);
        if (s.warpColor)           setWarpColor(s.warpColor);
        if (s.cc)                  setCc(s.cc);
        if (s.gap != null)         setGap(s.gap);
        if (s.imageOpacity != null) setImageOpacity(s.imageOpacity);
        if (s.colorAlpha != null)  setColorAlpha(s.colorAlpha);
        if (s.ccAlpha != null)     setCcAlpha(s.ccAlpha);
        if (s.borderRadius != null) setBorderRadius(s.borderRadius);
        if (s.sizeVariation != null) setSizeVariation(s.sizeVariation);
        if (s.posterizeLevels != null) setPosterizeLevels(s.posterizeLevels);
        if (s.editInvert != null)  setEditInvert(s.editInvert);
        if (s.stitchInvert != null) setStitchInvert(s.stitchInvert);
        if (s.modes)      setModes(s.modes);
        if (s.speeds)     setSpeeds(s.speeds);
        if (s.thresholds) setThresholds(s.thresholds);
        if (s.alphas)     setAlphas(s.alphas);
        if (s.layerBand)  setLayerBand(s.layerBand);
        if (s.layerColors) setLayerColors(s.layerColors);
        if (s.grids)      setGrids(s.grids);
        if (s.imageMode)  setImageMode(s.imageMode);
        if (s.imgThreshold != null) setImgThreshold(s.imgThreshold);
        if (s.imgInvert != null)    setImgInvert(s.imgInvert);
        if (s.ovBlend)    setOvBlend(s.ovBlend);
        if (s.ovOpacity != null)   setOvOpacity(s.ovOpacity);
        if (s.ovBrushSize != null) setOvBrushSize(s.ovBrushSize);
        if (s.ovBrushMode) setOvBrushMode(s.ovBrushMode);
        if (s.bgImg) { const img = new Image(); img.onload = () => setBgImg(img); img.src = s.bgImg; }
        else setBgImg(null);
        if (s.maskImg) { const img = new Image(); img.onload = () => setMaskImg(img); img.src = s.maskImg; }
        else setMaskImg(null);
        if (s.posterTexts)          setPosterTexts(s.posterTexts);
        if (s.posterNextId != null)  setPosterNextId(s.posterNextId);
        if (s.posterCell != null)    setPosterCell(s.posterCell);
        if (s.staveCount != null)    setStaveCount(s.staveCount);
        if (s.notationSeed != null)  setNotationSeed(s.notationSeed);
        if (s.fabricInvert != null)  setFabricInvert(s.fabricInvert);
        if (s.posterOvType !== undefined) setPosterOvType(s.posterOvType);
        if (s.posterOvOpacity != null)    setPosterOvOpacity(s.posterOvOpacity);
        if (s.posterOvBlend)              setPosterOvBlend(s.posterOvBlend);
      } catch (err) { console.error("Failed to load session", err); }
    };
    reader.readAsText(file);
  }

  function openPerformWindow() {
    if (performWinRef.current && !performWinRef.current.closed) {
      performWinRef.current.focus(); return;
    }
    const pw = window.open("", "SoundWeavePerform", "popup=1,width=1280,height=720");
    if (!pw) return;
    const html = `<!doctype html><html><head><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;overflow:hidden;width:100vw;height:100vh}
#pc{display:block;position:absolute;inset:0;width:100%;height:100%;object-fit:contain;image-rendering:pixelated;background:#000}
#clips{position:absolute;inset:0;pointer-events:none}
.clip{position:absolute;pointer-events:all;cursor:move;user-select:none;min-width:40px;min-height:40px}
.clip img,.clip video{display:block;width:100%;height:100%;object-fit:contain}
.clip-bar{position:absolute;top:-22px;left:0;right:0;height:22px;background:rgba(0,0,0,0.7);display:flex;align-items:center;gap:4px;padding:0 4px;font:11px monospace;color:#ccc}
.clip-name{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:10px;opacity:0.7}
.clip-btn{background:none;border:none;color:#fff;cursor:pointer;padding:1px 4px;font-size:12px;line-height:1;border-radius:3px}
.clip-btn:hover{background:rgba(255,255,255,0.2)}
.clip-resize{position:absolute;bottom:0;right:0;width:14px;height:14px;cursor:se-resize;background:linear-gradient(135deg,transparent 50%,rgba(255,153,51,0.8) 50%)}
.txt-box{position:absolute;pointer-events:all;user-select:none;min-width:60px}
.txt-bar{display:flex;align-items:center;gap:2px;padding:2px 4px;background:rgba(0,0,0,0.72);cursor:move;flex-wrap:wrap;border-radius:3px 3px 0 0}
.txt-content{outline:none;padding:4px 6px;white-space:pre-wrap;word-break:break-word;cursor:text;min-width:60px;min-height:1em}
.txt-sel{background:rgba(20,0,40,0.85);color:#ccc;border:1px solid rgba(255,255,255,0.18);font-size:9px;padding:1px 2px;border-radius:2px;cursor:pointer;max-width:70px}
.txt-btn2{background:none;border:none;color:#ccc;cursor:pointer;padding:1px 5px;font-size:11px;line-height:1;border-radius:3px}
.txt-btn2:hover{background:rgba(255,255,255,0.18)}
.txt-resize{position:absolute;bottom:0;right:0;width:12px;height:12px;cursor:se-resize;background:linear-gradient(135deg,transparent 50%,rgba(255,200,80,0.7) 50%)}
#txt-add{position:fixed;bottom:44px;right:8px;background:rgba(0,0,0,0.55);color:rgba(255,255,255,0.55);font:bold 12px/1 monospace;cursor:pointer;z-index:999;padding:5px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.14);transition:opacity 0.4s;letter-spacing:1px}
#txt-add:hover{color:#fff;background:rgba(30,0,60,0.85)}
#fs{position:fixed;bottom:8px;right:8px;background:rgba(0,0,0,0.55);color:rgba(255,255,255,0.4);font:10px/1 monospace;letter-spacing:1px;cursor:pointer;z-index:999;padding:4px 7px;border-radius:4px;border:1px solid rgba(255,255,255,0.12);transition:opacity 0.4s}
#fs:hover{color:#fff;background:rgba(30,0,60,0.8)}
</style></head><body>
<canvas id="pc"></canvas>
<div id="clips"></div>
<div id="txt-add" onclick="addTextBox()">T+</div>
<div id="fs" onclick="goFS()">⛶ fullscreen</div>
<script>
var clipNum=0,txtNum=0;
var PERF_FONTS=[['serif','Serif'],['sans-serif','Sans'],['monospace','Mono'],["'Courier Prime','Courier New',monospace",'Courier'],["'Bebas Neue',sans-serif",'Bebas'],["'Josefin Sans',sans-serif",'Josefin'],['cursive','Cursive']];
function addTextBox(){
  var id='txt-'+(++txtNum);
  var div=document.createElement('div');div.id=id;div.className='txt-box';
  div.style.cssText='left:120px;top:120px;z-index:'+(Date.now()%9000+1000)+';';
  var bar=document.createElement('div');bar.className='txt-bar';
  // font family
  var fontSel=document.createElement('select');fontSel.className='txt-sel';
  PERF_FONTS.forEach(function(f){var o=document.createElement('option');o.value=f[0];o.textContent=f[1];fontSel.appendChild(o);});
  // font size
  var sizeInp=document.createElement('input');sizeInp.type='number';sizeInp.value='48';sizeInp.min='8';sizeInp.max='400';sizeInp.className='txt-sel';sizeInp.style.width='46px';
  // bold
  var boldBtn=document.createElement('button');boldBtn.className='txt-btn2';boldBtn.textContent='B';boldBtn.style.fontWeight='bold';var isBold=false;
  // color
  var colInp=document.createElement('input');colInp.type='color';colInp.value='#ffffff';colInp.style.cssText='width:22px;height:18px;padding:0;border:none;background:none;cursor:pointer;vertical-align:middle;';
  // glow toggle
  var glowBtn=document.createElement('button');glowBtn.className='txt-btn2';glowBtn.textContent='✦';glowBtn.title='glow';var glowOn=false;
  // opacity
  var opSel=document.createElement('select');opSel.className='txt-sel';
  [['1','100%'],['0.85','85%'],['0.7','70%'],['0.5','50%'],['0.3','30%'],['0.1','10%']].forEach(function(v){var o=document.createElement('option');o.value=v[0];o.textContent=v[1];opSel.appendChild(o);});
  // blend
  var blendSel=document.createElement('select');blendSel.className='txt-sel';
  ['normal','screen','overlay','multiply','difference','luminosity','soft-light'].forEach(function(m){var o=document.createElement('option');o.value=m;o.textContent=m;blendSel.appendChild(o);});
  // close
  var closeBtn=document.createElement('button');closeBtn.className='txt-btn2';closeBtn.textContent='×';closeBtn.style.marginLeft='2px';closeBtn.onclick=function(){div.remove();};
  [fontSel,sizeInp,boldBtn,colInp,glowBtn,opSel,blendSel,closeBtn].forEach(function(el){bar.appendChild(el);});
  div.appendChild(bar);
  // content
  var content=document.createElement('div');content.className='txt-content';content.contentEditable='true';content.spellcheck=false;
  content.style.cssText='font-family:serif;font-size:48px;color:#fff;line-height:1.15;';
  content.textContent='Text';
  div.appendChild(content);
  // resize handle
  var rsz=document.createElement('div');rsz.className='txt-resize';div.appendChild(rsz);
  // wire up controls
  function applyGlow(){content.style.textShadow=glowOn?'0 0 20px '+colInp.value+',0 0 40px '+colInp.value:'none';}
  fontSel.onchange=function(){content.style.fontFamily=this.value;};
  sizeInp.oninput=function(){content.style.fontSize=this.value+'px';};
  boldBtn.onclick=function(){isBold=!isBold;content.style.fontWeight=isBold?'bold':'normal';boldBtn.style.background=isBold?'rgba(255,255,255,0.22)':'';};
  colInp.oninput=function(){content.style.color=this.value;applyGlow();};
  glowBtn.onclick=function(){glowOn=!glowOn;applyGlow();glowBtn.style.background=glowOn?'rgba(255,210,80,0.22)':'';};
  opSel.onchange=function(){div.style.opacity=this.value;};
  blendSel.onchange=function(){div.style.mixBlendMode=this.value;};
  // store props for recording
  div.dataset.txtbox='1';
  // draggable by bar, resize by handle
  makeTextDraggable(div,bar,rsz);
  document.getElementById('clips').appendChild(div);
  setTimeout(function(){content.focus();var r=document.createRange();r.selectNodeContents(content);var s=window.getSelection();s.removeAllRanges();s.addRange(r);},0);
}
function makeTextDraggable(div,handle,rsz){
  var dragging=false,rx=0,ry=0,rl=0,rt=0;
  handle.addEventListener('mousedown',function(e){
    if(e.target.tagName==='SELECT'||e.target.tagName==='INPUT'||e.target.tagName==='BUTTON')return;
    dragging=true;rx=e.clientX;ry=e.clientY;rl=parseInt(div.style.left)||0;rt=parseInt(div.style.top)||0;div.style.zIndex=Date.now()%9000+1000;e.preventDefault();
  });
  window.addEventListener('mousemove',function(e){if(dragging){div.style.left=(rl+e.clientX-rx)+'px';div.style.top=(rt+e.clientY-ry)+'px';}});
  window.addEventListener('mouseup',function(){dragging=false;});
  var resizing=false,rsx=0,rsw=0;
  rsz.addEventListener('mousedown',function(e){resizing=true;rsx=e.clientX;rsw=div.offsetWidth;e.stopPropagation();e.preventDefault();});
  window.addEventListener('mousemove',function(e){if(resizing){div.style.width=Math.max(60,rsw+(e.clientX-rsx))+'px';}});
  window.addEventListener('mouseup',function(){resizing=false;});
}
function goFS(){document.documentElement.requestFullscreen&&document.documentElement.requestFullscreen();['fs','txt-add'].forEach(function(id){var o=document.getElementById(id);if(o){o.style.opacity=0;setTimeout(function(){o.remove()},400);}});}
document.addEventListener('keydown',function(e){if(e.key==='f'||e.key==='F')goFS();});
window.addEventListener('message',function(e){
  if(!e.data)return;
  if(e.data.type==='frame'){var c=document.getElementById('pc'),b=e.data.bitmap;c.width=b.width;c.height=b.height;c.getContext('2d').drawImage(b,0,0);b.close();}
  else if(e.data.type==='addClip'){var dataUrl=e.data.dataUrl;if(e.data.buffer){var blob=new Blob([e.data.buffer],{type:e.data.mimeType||'video/mp4'});dataUrl=URL.createObjectURL(blob);}addClip(e.data.id,dataUrl,e.data.mediaType,e.data.filter||'',e.data.mix||'normal',e.data.label||'');}
  else if(e.data.type==='removeClip'){var el=document.getElementById('clip-'+e.data.id);if(el)el.remove();}
  else if(e.data.type==='updateClip'){var el=document.getElementById('clip-'+e.data.id);if(el){var inn=el.querySelector('img,video');if(inn&&e.data.filter!=null)inn.style.filter=e.data.filter;if(e.data.mix!=null)el.style.mixBlendMode=e.data.mix;}}
  else if(e.data.type==='setBg'){document.body.style.background=e.data.color;}
  else if(e.data.type==='setInvert'){var c=document.getElementById('pc');if(c)c.style.filter=e.data.invert?'invert(1)':'none';}
  else if(e.data.type==='startRecord'){startPerfRecord(e.data.mimeType);}
  else if(e.data.type==='stopRecord'){stopPerfRecord();}
});
var _recAnim,_recMR,_recChunks=[],_recCanvas;
function startPerfRecord(mimeType){
  _recChunks=[];
  var pc=document.getElementById('pc');
  var W=window.innerWidth,H=window.innerHeight;
  _recCanvas=document.createElement('canvas');
  _recCanvas.width=W;_recCanvas.height=H;
  var ctx=_recCanvas.getContext('2d');
  var isInv=pc.style.filter==='invert(1)';
  function frame(){
    ctx.clearRect(0,0,W,H);
    if(pc.width&&pc.height){
      var scale=Math.min(W/pc.width,H/pc.height);
      var dw=pc.width*scale,dh=pc.height*scale;
      var dx=(W-dw)/2,dy=(H-dh)/2;
      ctx.drawImage(pc,dx,dy,dw,dh);
    }
    document.querySelectorAll('#clips .clip').forEach(function(div){
      var inn=div.querySelector('img,video');if(!inn)return;
      var l=parseInt(div.style.left)||0,t=parseInt(div.style.top)||0,w=div.offsetWidth,h=div.offsetHeight;
      ctx.save();
      var mix=div.style.mixBlendMode;if(mix&&mix!=='normal')ctx.globalCompositeOperation=mix;
      try{ctx.drawImage(inn,l,t,w,h);}catch(e){}
      ctx.restore();
    });
    document.querySelectorAll('#clips .txt-box').forEach(function(div){
      var content=div.querySelector('.txt-content');if(!content)return;
      var l=parseInt(div.style.left)||0,t=parseInt(div.style.top)||0;
      var cs=window.getComputedStyle(content);
      var sz=parseFloat(cs.fontSize)||48;
      var color=cs.color||'#fff';
      var fontFamily=cs.fontFamily||'serif';
      var bold=cs.fontWeight;
      var shadow=cs.textShadow;
      var opacity=parseFloat(div.style.opacity)||1;
      var blend=div.style.mixBlendMode||'normal';
      ctx.save();
      ctx.globalAlpha=opacity;
      if(blend&&blend!=='normal')ctx.globalCompositeOperation=blend;
      ctx.font=(parseInt(bold)>=700?'bold ':'')+sz+'px '+fontFamily;
      ctx.fillStyle=color;
      if(shadow&&shadow!=='none'){ctx.shadowColor=color;ctx.shadowBlur=sz*0.8;}
      var lines=(content.innerText||'').split('\\n');
      lines.forEach(function(line,i){ctx.fillText(line,l+6,t+sz*(i+1)+2);});
      ctx.restore();
    });
    if(isInv){ctx.save();ctx.globalCompositeOperation='difference';ctx.fillStyle='white';ctx.fillRect(0,0,W2,H2);ctx.restore();}
    _recAnim=requestAnimationFrame(frame);
  }
  frame();
  var stream=_recCanvas.captureStream(30);
  var combined=new MediaStream(stream.getVideoTracks());
  try{
    var rawStreams=window.opener&&window.opener.getPerformAudioStreams?window.opener.getPerformAudioStreams():[];
    if(rawStreams.length>0){var mixCtx=new AudioContext(),dest=mixCtx.createMediaStreamDestination();rawStreams.forEach(function(s){mixCtx.createMediaStreamSource(s).connect(dest);});dest.stream.getAudioTracks().forEach(function(t){combined.addTrack(t);});}
  }catch(e){console.warn('perform audio mix failed',e);}
  var mt=mimeType||'video/webm';
  _recMR=new MediaRecorder(combined,{mimeType:mt});
  _recMR.ondataavailable=function(e){if(e.data.size>0)_recChunks.push(e.data);};
  _recMR.onstop=function(){cancelAnimationFrame(_recAnim);var blob=new Blob(_recChunks,{type:mt});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='perform_'+Date.now()+'.'+(mt.startsWith('video/mp4')?'mp4':'webm');a.click();};
  _recMR.start();
}
function stopPerfRecord(){if(_recMR&&_recMR.state!=='inactive')_recMR.stop();else cancelAnimationFrame(_recAnim);}
function makeDraggable(div,resize){
  var dragging=false,rx=0,ry=0,rl=0,rt=0;
  div.addEventListener('mousedown',function(e){if(e.target===resize||e.target.classList.contains('clip-btn'))return;dragging=true;rx=e.clientX;ry=e.clientY;rl=parseInt(div.style.left)||0;rt=parseInt(div.style.top)||0;div.style.zIndex=Date.now()%9000+1000;e.preventDefault();});
  window.addEventListener('mousemove',function(e){if(dragging){div.style.left=(rl+e.clientX-rx)+'px';div.style.top=(rt+e.clientY-ry)+'px';}});
  window.addEventListener('mouseup',function(){dragging=false;});
  var resizing=false,rsx=0,rsw=0,rsh=0;
  resize.addEventListener('mousedown',function(e){resizing=true;rsx=e.clientX;rsw=div.offsetWidth;rsh=div.offsetHeight;e.stopPropagation();e.preventDefault();});
  window.addEventListener('mousemove',function(e){if(resizing){var dw=e.clientX-rsx;div.style.width=Math.max(40,rsw+dw)+'px';div.style.height=Math.max(40,rsh+dw*(rsh/rsw))+'px';}});
  window.addEventListener('mouseup',function(){resizing=false;});
}
function addClip(id,dataUrl,mediaType,filter,mix,label){
  var clips=document.getElementById('clips');
  var div=document.createElement('div');div.id='clip-'+id;div.className='clip';
  div.style.cssText='left:80px;top:80px;width:280px;height:280px;';
  if(mix&&mix!=='normal')div.style.mixBlendMode=mix;
  var bar=document.createElement('div');bar.className='clip-bar';
  var name=document.createElement('span');name.className='clip-name';name.textContent=label||('clip '+( ++clipNum ));bar.appendChild(name);
  var closeBtn=document.createElement('button');closeBtn.className='clip-btn';closeBtn.textContent='×';closeBtn.onclick=function(){div.remove();};bar.appendChild(closeBtn);
  div.appendChild(bar);
  var inner;
  if(mediaType==='video'){inner=document.createElement('video');inner.src=dataUrl;inner.autoplay=true;inner.loop=true;inner.muted=true;inner.playsInline=true;}
  else{inner=document.createElement('img');inner.src=dataUrl;}
  inner.style.cssText='display:block;width:100%;height:100%;object-fit:contain;';
  inner.style.filter=filter||'brightness(1.06) saturate(1.35) sepia(0.22)';
  div.appendChild(inner);
  var resize=document.createElement('div');resize.className='clip-resize';div.appendChild(resize);
  makeDraggable(div,resize);
  clips.appendChild(div);
}
<\/script></body></html>`;
    pw.document.write(html);
    pw.document.close();
    performWinRef.current = pw;
    setPerformOpen(true);
    // Send any existing clips once window has loaded
  }

  function closePerformWindow() {
    performWinRef.current?.close();
    performWinRef.current = null;
    setPerformOpen(false);
  }

  function addClip(file) {
    const url = URL.createObjectURL(file);
    const isVideo = file.type.startsWith("video") || /\.(mp4|webm|mov|avi|mkv|m4v|ogv|ogg|flv|wmv)$/i.test(file.name);
    const type = isVideo ? "video" : "image";
    const id = clipNextIdRef.current++;
    const clip = { id, name: file.name, blobUrl: url, type, mimeType: file.type || (isVideo ? "video/mp4" : "image/png") };
    setClips(prev => [...prev, clip]);
  }

  function removeClip(id) {
    setClips(prev => { const c = prev.find(x => x.id === id); if (c) URL.revokeObjectURL(c.blobUrl); return prev.filter(x => x.id !== id); });
    if (performWinRef.current && !performWinRef.current.closed)
      performWinRef.current.postMessage({ type: "removeClip", id }, "*");
  }

  function sendClipToPerform(clip) {
    if (!performWinRef.current || performWinRef.current.closed) return;
    const filter = CLIP_STYLES[clipStyles[clip.id] ?? "warm"] ?? WARM;
    const mix = clipBlends[clip.id] ?? "normal";
    const label = clipNames[clip.id] ?? clip.name;
    const pid = clip.id + "_" + Date.now();
    clipPerformIds.current[clip.id] = pid;
    if (clip.type === "video") {
      fetch(clip.blobUrl).then(r => r.arrayBuffer()).then(buf => {
        if (!performWinRef.current || performWinRef.current.closed) return;
        performWinRef.current.postMessage({ type: "addClip", id: pid, buffer: buf, mimeType: clip.mimeType, mediaType: "video", label, filter, mix }, "*", [buf]);
      });
    } else {
      performWinRef.current.postMessage({ type: "addClip", id: pid, dataUrl: clip.blobUrl, mediaType: clip.type, label, filter, mix }, "*");
    }
  }

  const energyAll = useMemo(() => {
    const e = {};
    for (const L of LAYERS) e[L.id] = Math.round((audioMap[L.id]?.energy ?? 0) * 100);
    return e;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [LAYERS, audioMap, audioA.energy, audioB.energy, audioC.energy, audioD.energy, audioF.energy, audioG.energy, audioH.energy]);

  const audioRefs = { B: audioRefB, C: audioRefC, D: audioRefD, F: audioRefF, G: audioRefG, H: audioRefH };

  // Live state refs for RAF loops (updated every render, no deps needed)
  const gridsRef = useRef(grids); gridsRef.current = grids;
  const alphasRef = useRef(alphas); alphasRef.current = alphas;
  const colsRef = useRef(cols); colsRef.current = cols;
  const bgImgRef = useRef(bgImg); bgImgRef.current = bgImg;
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const layersRef = useRef(LAYERS); layersRef.current = LAYERS;

  // ── POSTER state ─────────────────────────────────────────────────────────
  const [posterOpen, setPosterOpen] = useState(false);
  const [posterTexts, setPosterTexts] = useState([
    { id: 0, content: "SOUND WEAVE", fontSize: 18, fontFamily: "serif", bold: true, x: 8, y: 68, knit: true, opacity: 1, blend: "source-over", color: null, glow: 0 },
  ]);
  const [posterSelectedId, setPosterSelectedId] = useState(0);
  const [posterNextId, setPosterNextId] = useState(1);
  const posterNextIdRef = useRef(1); posterNextIdRef.current = posterNextId;
  const [staveCount, setStaveCount] = useState(8);
  const [notationSeed, setNotationSeed] = useState(42);
  const [posterCell, setPosterCell] = useState(5);
  const [fabricInvert, setFabricInvert] = useState(false);
  const [posterActiveTool, setPosterActiveTool] = useState("select");
  const [posterCursor, setPosterCursor] = useState("default");
  const [posterBrushSize, setPosterBrushSize] = useState(6);
  const [posterBrushMode, setPosterBrushMode] = useState("reveal");
  const [posterOvType, setPosterOvType] = useState(null);
  const [posterOvOpacity, setPosterOvOpacity] = useState(0.85);
  const [posterOvBlend, setPosterOvBlend] = useState("multiply");
  const [posterOvVideoPlaying, setPosterOvVideoPlaying] = useState(false);
  const [posterLayerAlpha, setPosterLayerAlpha] = useState(1);
  const [isPosterRecording, setIsPosterRecording] = useState(false);
  const posterMediaRecorderRef = useRef(null);
  const posterRecordedChunksRef = useRef([]);
  const [posterImgs, setPosterImgs] = useState([]);
  const [posterImgNextId, setPosterImgNextId] = useState(0);
  const [posterSelectedImgId, setPosterSelectedImgId] = useState(null);
  const posterImgsRef = useRef([]);
  const posterImgElemsRef = useRef({});
  const posterImgResizeRef = useRef(null); // { id, handle, origX, origY, origW, origH, startGX, startGY }
  const posterHistoryRef = useRef([]);
  const posterCopiedTextRef = useRef(null);
  function pushPosterHistory() {
    posterHistoryRef.current.push({
      texts: JSON.parse(JSON.stringify(posterTexts)),
      imgs: posterImgs.map(pi => ({ ...pi })),
    });
    if (posterHistoryRef.current.length > 60) posterHistoryRef.current.shift();
  }
  function undoPoster() {
    if (posterHistoryRef.current.length === 0) return;
    const prev = posterHistoryRef.current.pop();
    setPosterTexts(prev.texts);
    setPosterImgs(prev.imgs);
    posterParamRef.current.dirty = true;
  }

  const posterCanvasRef   = useRef(null);
  const posterParamRef    = useRef({});
  const isPosterRecordingRef = useRef(false);
  isPosterRecordingRef.current = isPosterRecording;
  const posterRecordCanvasRef = useRef(null);
  const posterDragRef     = useRef(null);
  if (!posterDragRef.current && !posterImgResizeRef.current) posterImgsRef.current = posterImgs;
  const posterResizeRef   = useRef(null); // { id, origFontSize, startGY }
  const posterMaskRef     = useRef(null);
  const posterMediaRef    = useRef(null);
  const posterIsPaintingRef = useRef(false);
  const posterMouseRef    = useRef({ x: 0, y: 0, over: false });

  // Sync poster params to ref
  useEffect(() => {
    posterParamRef.current = {
      ...posterParamRef.current,
      texts: posterTexts, selectedId: posterSelectedId,
      cell: posterCell, staveCount, notationSeed, fabricInvert, posterLayerAlpha,
      activeTool: posterActiveTool, brushSize: posterBrushSize, brushMode: posterBrushMode,
      overlayType: posterOvType, overlayOpacity: posterOvOpacity, overlayBlend: posterOvBlend,
      dirty: true,
    };
  }, [posterTexts, posterSelectedId, posterCell, staveCount, notationSeed, fabricInvert, posterLayerAlpha,
      posterActiveTool, posterBrushSize, posterBrushMode, posterOvType, posterOvOpacity, posterOvBlend]);

  // Poster RAF loop
  useEffect(() => {
    if (!posterOpen) return;
    let raf;
    let lastSyncMs = 0;
    const step = (now) => {
      const c = posterCanvasRef.current;
      if (!c) { raf = requestAnimationFrame(step); return; }
      let needsDraw = posterParamRef.current.dirty;
      if (now - lastSyncMs >= 100) {
        lastSyncMs = now;
        posterParamRef.current.gridW = colsRef.current;
        posterParamRef.current.gridH = rowsRef.current;
        posterParamRef.current.fabricLayers = layersRef.current.map(L => ({
          color: L.color, alpha: alphasRef.current[L.id] ?? 0.55, grid01: gridsRef.current[L.id],
        }));
      }
      // Always redraw — poster mirrors live edit canvas (audio-reactive)
      needsDraw = true;
      const ot = posterParamRef.current.overlayType;
      const tool = posterParamRef.current.activeTool;
      if (ot === "video" || (tool === "brush" && posterMouseRef.current.over)) needsDraw = true;
      if (needsDraw) {
        posterParamRef.current.dirty = false;
        const { cell: cs = 5, staveCount: sc = 8, notationSeed: ns = 42,
          fabricLayers, fabricInvert: fi = false, texts: ts = [], selectedId: sid,
          gridW: gw = colsRef.current, gridH: gh = rowsRef.current,
          overlayBlend: blend, overlayOpacity: opacity, posterLayerAlpha: pla = 1 } = posterParamRef.current;
        drawPoster(c, { gridW: gw, gridH: gh, cell: cs, texts: ts, fabricLayers: fabricLayers ?? null, fabricInvert: fi, staveCount: sc, notationSeed: ns, bgImg: bgImgRef.current, sourceCanvas: canvasRef.current, posterLayerAlpha: pla });
        if (ot && posterMediaRef.current && posterMaskRef.current)
          drawMediaOverlay(c, posterMediaRef.current, posterMaskRef.current, opacity, blend);
        else if (!ot && overlayMediaRef.current) {
          // Share edit view's overlay (full reveal, no brush mask)
          const { ovBlend: eb, ovOpacity: eo } = ovParamRef.current;
          const fm = document.createElement("canvas"); fm.width = c.width; fm.height = c.height;
          fm.getContext("2d").fillRect(0, 0, fm.width, fm.height);
          drawMediaOverlay(c, overlayMediaRef.current, fm, eo, eb);
        }
        // Draw poster images
        { const ctx2 = c.getContext("2d");
          for (const pi of posterImgsRef.current) {
            const imgEl = posterImgElemsRef.current[pi.id];
            if (!imgEl || !imgEl.complete) continue;
            ctx2.save(); ctx2.globalAlpha = pi.opacity ?? 1; ctx2.globalCompositeOperation = pi.blend ?? "source-over";
            ctx2.drawImage(imgEl, pi.x * cs, pi.y * cs, pi.w * cs, pi.h * cs);
            ctx2.restore();
          }
          const selImg = posterImgsRef.current.find(pi => pi.id === posterParamRef.current.selectedImgId);
          if (selImg) {
            const ix = selImg.x * cs, iy = selImg.y * cs, iw = selImg.w * cs, ih = selImg.h * cs;
            ctx2.save(); ctx2.strokeStyle = "#c8a96e"; ctx2.lineWidth = 2; ctx2.setLineDash([4, 4]);
            ctx2.strokeRect(ix, iy, iw, ih); ctx2.setLineDash([]);
            // Corner + edge handles
            const hs = 7;
            const handles = [[ix,iy],[ix+iw/2,iy],[ix+iw,iy],[ix+iw,iy+ih/2],[ix+iw,iy+ih],[ix+iw/2,iy+ih],[ix,iy+ih],[ix,iy+ih/2]];
            ctx2.fillStyle = "#c8a96e";
            for (const [hx, hy] of handles) ctx2.fillRect(hx - hs/2, hy - hs/2, hs, hs);
            ctx2.restore();
          }
        }
        drawPosterSelectionHighlight(c, ts, sid, cs);
        if (tool === "brush" && posterMouseRef.current.over) {
          const ctx = c.getContext("2d");
          ctx.save();
          ctx.strokeStyle = posterParamRef.current.brushMode === "erase" ? "rgba(255,80,80,0.8)" : "rgba(255,255,255,0.8)";
          ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.arc(posterMouseRef.current.x, posterMouseRef.current.y, posterParamRef.current.brushSize * cs, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]); ctx.restore();
        }
        // Pixel-level invert for recording (CSS filter doesn't affect captureStream)
        if (editInvertRef.current) {
          const ictx = c.getContext("2d");
          ictx.save(); ictx.globalCompositeOperation = "difference"; ictx.fillStyle = "#ffffff";
          ictx.fillRect(0, 0, c.width, c.height); ictx.restore();
        }
        // High-res 3x record canvas
        if (isPosterRecordingRef.current && posterRecordCanvasRef.current) {
          const rc = posterRecordCanvasRef.current;
          const rcs = cs * 3;
          drawPoster(rc, { gridW: gw, gridH: gh, cell: rcs, texts: ts, fabricLayers: fabricLayers ?? null, fabricInvert: fi, staveCount: sc, notationSeed: ns, bgImg: bgImgRef.current, sourceCanvas: canvasRef.current, posterLayerAlpha: pla });
          const rctx = rc.getContext("2d");
          for (const pi of posterImgsRef.current) {
            const imgEl = posterImgElemsRef.current[pi.id];
            if (!imgEl || !imgEl.complete) continue;
            rctx.save(); rctx.globalAlpha = pi.opacity ?? 1; rctx.globalCompositeOperation = pi.blend ?? "source-over";
            rctx.drawImage(imgEl, pi.x * rcs, pi.y * rcs, pi.w * rcs, pi.h * rcs);
            rctx.restore();
          }
          if (editInvertRef.current) {
            rctx.save(); rctx.globalCompositeOperation = "difference"; rctx.fillStyle = "#ffffff";
            rctx.fillRect(0, 0, rc.width, rc.height); rctx.restore();
          }
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posterOpen, LAYERS]);

  function posterInitMask() {
    const mc = document.createElement("canvas");
    mc.width = posterParamRef.current.gridW ?? cols;
    mc.height = posterParamRef.current.gridH ?? rows;
    posterMaskRef.current = mc;
  }
  function handlePosterFile(file) {
    if (!file) return;
    if (posterMediaRef.current?._objUrl) URL.revokeObjectURL(posterMediaRef.current._objUrl);
    const url = URL.createObjectURL(file);
    posterInitMask();
    if (file.type.startsWith("video/")) {
      const vid = document.createElement("video");
      vid._objUrl = url; vid.src = url; vid.loop = true; vid.muted = true; vid.playsInline = true;
      vid.addEventListener("canplay", () => { posterMediaRef.current = vid; setPosterOvType("video"); setPosterOvVideoPlaying(false); }, { once: true });
      vid.addEventListener("play", () => setPosterOvVideoPlaying(true));
      vid.addEventListener("pause", () => setPosterOvVideoPlaying(false));
    } else {
      const img = new Image(); img._objUrl = url; img.src = url;
      img.onload = () => { posterMediaRef.current = img; setPosterOvType("image"); };
    }
  }
  function removePosterOverlay() {
    if (posterMediaRef.current?.pause) posterMediaRef.current.pause();
    if (posterMediaRef.current?._objUrl) URL.revokeObjectURL(posterMediaRef.current._objUrl);
    posterMediaRef.current = null; posterMaskRef.current = null; setPosterOvType(null);
  }
  function posterPaintAt(clientX, clientY) {
    const mc = posterMaskRef.current; const canvas = posterCanvasRef.current;
    if (!mc || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cs = posterParamRef.current.cell ?? 5;
    const ctx = mc.getContext("2d");
    if (posterParamRef.current.brushMode === "erase") { ctx.globalCompositeOperation = "destination-out"; ctx.fillStyle = "rgba(0,0,0,1)"; }
    else { ctx.globalCompositeOperation = "source-over"; ctx.fillStyle = "rgba(255,255,255,1)"; }
    ctx.beginPath(); ctx.arc((clientX - rect.left) / cs, (clientY - rect.top) / cs, posterParamRef.current.brushSize ?? 6, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    posterParamRef.current.dirty = true;
  }
  function addPosterImg(file) {
    pushPosterHistory();
    if (!file) return;
    const id = posterImgNextId; setPosterImgNextId(id + 1);
    const blobUrl = URL.createObjectURL(file);
    const imgEl = new Image();
    imgEl.onload = () => {
      const aspect = imgEl.naturalWidth / imgEl.naturalHeight;
      const w = 30; const h = Math.round(w / aspect);
      posterImgElemsRef.current[id] = imgEl;
      setPosterImgs(prev => [...prev, { id, blobUrl, x: 5, y: 5, w, h, opacity: 1, blend: "source-over" }]);
      setPosterSelectedImgId(id);
      posterParamRef.current.selectedImgId = id;
      posterParamRef.current.dirty = true;
    };
    imgEl.src = blobUrl;
  }
  function removePosterImg(id) {
    pushPosterHistory();
    URL.revokeObjectURL(posterImgs.find(pi => pi.id === id)?.blobUrl);
    delete posterImgElemsRef.current[id];
    setPosterImgs(prev => prev.filter(pi => pi.id !== id));
    if (posterSelectedImgId === id) { setPosterSelectedImgId(null); posterParamRef.current.selectedImgId = null; }
    posterParamRef.current.dirty = true;
  }
  function addPosterText() {
    pushPosterHistory();
    const id = posterNextId; setPosterNextId(id + 1);
    setPosterTexts(prev => [...prev, { id, content: "New text", fontSize: 18, fontFamily: "serif", bold: false, x: 8, y: 8, knit: true, opacity: 1, blend: "source-over", color: null, glow: 0 }]);
    setPosterSelectedId(id);
  }
  function removePosterText(id) {
    pushPosterHistory();
    setPosterTexts(prev => prev.filter(t => t.id !== id));
    setPosterSelectedId(prev => prev === id ? null : prev);
  }
  function updatePosterSelected(patch) {
    if (posterSelectedId === null) return;
    setPosterTexts(prev => prev.map(t => t.id === posterSelectedId ? { ...t, ...patch } : t));
  }
  function commitPosterSelected(patch) {
    pushPosterHistory();
    updatePosterSelected(patch);
  }
  function exportPosterPNG() {
    const { cell: cs = 5, staveCount: sc = 8, notationSeed: ns = 42, fabricLayers, fabricInvert: fi = false,
      texts: ts = [], gridW: gw = cols, gridH: gh = rows,
      overlayType: ot, overlayOpacity: opacity, overlayBlend: blend, posterLayerAlpha: pla = 1 } = posterParamRef.current;
    const print = document.createElement("canvas");
    drawPoster(print, { gridW: gw, gridH: gh, cell: cs * 3, texts: ts, fabricLayers: fabricLayers ?? null, fabricInvert: fi, staveCount: sc, notationSeed: ns, bgImg: bgImgRef.current, sourceCanvas: canvasRef.current, posterLayerAlpha: pla });
    if (ot && posterMediaRef.current && posterMaskRef.current) {
      const scaledMask = document.createElement("canvas");
      scaledMask.width = print.width; scaledMask.height = print.height;
      scaledMask.getContext("2d").drawImage(posterMaskRef.current, 0, 0, print.width, print.height);
      drawMediaOverlay(print, posterMediaRef.current, scaledMask, opacity, blend);
    }
    // Draw poster images at 3x scale
    { const pctx = print.getContext("2d");
      for (const pi of posterImgs) {
        const imgEl = posterImgElemsRef.current[pi.id];
        if (!imgEl || !imgEl.complete) continue;
        pctx.save(); pctx.globalAlpha = pi.opacity ?? 1; pctx.globalCompositeOperation = pi.blend ?? "source-over";
        pctx.drawImage(imgEl, pi.x * cs * 3, pi.y * cs * 3, pi.w * cs * 3, pi.h * cs * 3);
        pctx.restore();
      }
    }
    let out = print;
    if (editInvert) {
      const inv = document.createElement("canvas");
      inv.width = print.width; inv.height = print.height;
      const ic = inv.getContext("2d");
      ic.filter = "invert(1)";
      ic.drawImage(print, 0, 0);
      out = inv;
    }
    const a = document.createElement("a"); a.download = "knit-poster.png"; a.href = out.toDataURL("image/png"); a.click();
  }

  function startPosterRecording() {
    const c = posterCanvasRef.current; if (!c) return;
    posterRecordedChunksRef.current = [];
    // Create high-res 3x record canvas
    const { cell: cs = 5, gridW: gw = colsRef.current, gridH: gh = rowsRef.current } = posterParamRef.current;
    const rc = document.createElement("canvas");
    rc.width = gw * cs * 3; rc.height = gh * cs * 3;
    posterRecordCanvasRef.current = rc;
    isPosterRecordingRef.current = true;
    const combined = new MediaStream(rc.captureStream(30).getVideoTracks());
    const rawStreams = [];
    if (modes.A === "mic" && audioA.streamRef.current) rawStreams.push(audioA.streamRef.current);
    [[audioRefB,"B"],[audioRefC,"C"],[audioRefD,"D"],[audioRefF,"F"],[audioRefG,"G"],[audioRefH,"H"]].forEach(([ref,id]) => {
      if (modes[id] === "file" && ref.current?.captureStream) { try { rawStreams.push(ref.current.captureStream()); } catch {} }
    });
    if (rawStreams.length > 0) {
      try {
        const mixCtx = new AudioContext();
        const dest = mixCtx.createMediaStreamDestination();
        rawStreams.forEach(s => mixCtx.createMediaStreamSource(s).connect(dest));
        dest.stream.getAudioTracks().forEach(t => combined.addTrack(t));
      } catch (e) { console.warn("Audio mix failed:", e); }
    }
    const mimeType = MediaRecorder.isTypeSupported("video/mp4")
      ? "video/mp4"
      : MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
        ? "video/webm;codecs=vp9,opus" : "video/webm";
    const mr = new MediaRecorder(combined, { mimeType });
    mr.ondataavailable = (e) => { if (e.data.size > 0) posterRecordedChunksRef.current.push(e.data); };
    mr.onstop = () => {
      const isMP4 = mimeType.startsWith("video/mp4");
      const blob = new Blob(posterRecordedChunksRef.current, { type: mimeType });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `knit-poster.${isMP4 ? "mp4" : "webm"}`;
      a.click();
    };
    mr.start();
    posterMediaRecorderRef.current = mr;
    setIsPosterRecording(true);
  }

  function stopPosterRecording() {
    isPosterRecordingRef.current = false;
    posterRecordCanvasRef.current = null;
    posterMediaRecorderRef.current?.stop();
    setIsPosterRecording(false);
  }

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

  const posterSelected = posterTexts.find(t => t.id === posterSelectedId) ?? null;

  return (
    <div style={{ minHeight: "100vh", background: "#080808", padding: 16, fontFamily: "ui-monospace, 'Courier New', monospace", color: NG }}>
      {/* hidden video element for video guide */}
      <video ref={videoRef} style={{ display: "none" }} />

      <div style={{ maxWidth: posterOpen ? 1900 : 1400, margin: "0 auto", display: "grid", gridTemplateColumns: posterOpen ? "1.2fr 0.65fr 420px" : "1.2fr 0.65fr", gap: 12 }}>

        {/* ── LEFT: Canvas + image controls ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ ...panel, display: "flex", flexDirection: "column", gap: 10 }}>

            {/* Header row */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 20, letterSpacing: 2, textShadow: `0 0 12px ${NG}` }}>SOUND WEAVE</div>
                <div style={{ ...muted, marginTop: 3 }}>upload an image, add sound — the weave draws itself</div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {/* Pattern mode toggle */}
                <div style={{ display: "flex", background: "#0a0a0a", border: `1px solid ${ng20}`, borderRadius: 10, padding: 3, gap: 3 }}>
                  {["weave", "lace", "chart", "stitch"].map((m) => (
                    <button key={m} onClick={() => setPatternMode(m)}
                      style={{ padding: "5px 13px", borderRadius: 7, fontSize: 12, cursor: "pointer", fontWeight: 700, border: "none",
                        background: patternMode === m ? NG : "transparent",
                        color: patternMode === m ? "#000" : "rgba(57,255,20,0.5)",
                        boxShadow: patternMode === m ? `0 0 8px ${NG}` : "none",
                        letterSpacing: 1, transition: "all 0.15s" }}>
                      {m}
                    </button>
                  ))}
                </div>
                <button onClick={() => setEditInvert(v => !v)}
                  style={{ padding: "5px 13px", borderRadius: 7, fontSize: 12, cursor: "pointer", fontWeight: 700, border: `1px solid ${editInvert ? "#fff" : ng20}`,
                    background: editInvert ? "#fff" : "transparent",
                    color: editInvert ? "#000" : "rgba(255,255,255,0.45)",
                    letterSpacing: 1, transition: "all 0.15s" }}>
                  invert
                </button>
                <div style={{ width: 1, height: 20, background: ng20 }} />
                <button onClick={() => setGrids(() => { const o = {}; for (const id of IDS) o[id] = makeGrid(rows, cols, 0); return o; })}
                  style={btn(false)}>clear</button>
                <button onClick={() => { const c = canvasRef.current; if (c) downloadPNG(c, `weave_${cols}x${rows}.png`); }}
                  style={btn(false)}>export png</button>
                {isRecording
                  ? <button onClick={stopRecording} style={{ ...btn(true), background: "#ff2222", borderColor: "#ff2222", color: "#fff", boxShadow: "0 0 10px #ff2222" }}>stop rec</button>
                  : <button onClick={startRecording} style={{ ...btn(false), boxShadow: `0 0 6px ${NG}` }}>record</button>
                }
                <button onClick={saveSession} style={{ ...btn(false), borderColor: "#33aaff", color: "#66ccff" }}>save</button>
                <label style={{ ...btn(false), borderColor: "#33aaff", color: "#66ccff", cursor: "pointer" }}>
                  load<input type="file" accept=".json" style={{ display: "none" }} onChange={e => { if (e.target.files?.[0]) { loadSession(e.target.files[0]); e.target.value = ""; } }} />
                </label>
                {performOpen
                  ? <button onClick={closePerformWindow} style={{ ...btn(true), background: "#6600cc", borderColor: "#9933ff", color: "#fff", boxShadow: "0 0 10px #9933ff" }}>✕ perform</button>
                  : <button onClick={openPerformWindow} style={{ ...btn(false), borderColor: "#9933ff", color: "#cc99ff", boxShadow: "0 0 6px #9933ff44" }}>⬡ perform</button>
                }
                <button onClick={() => setPosterOpen(o => !o)}
                  style={{ ...btn(posterOpen), borderColor: posterOpen ? NG : "#c8a96e", color: posterOpen ? "#000" : "#c8a96e" }}>
                  poster {posterOpen ? "▶" : "◀"}
                </button>
              </div>
            </div>

            {/* Canvas stack: overlayBg (behind) → canvas → notation → cursor */}
            <div style={{ position: "relative", border: `1px solid ${ng20}`, borderRadius: 10, overflow: "hidden", lineHeight: 0, boxShadow: `0 0 20px rgba(57,255,20,0.06)`, }}>
              {/* overlay image/video — BEHIND stitches */}
              {/* main stitch canvas */}
              <canvas ref={canvasRef}
                onMouseDown={(e) => { if (ovActiveTool === "grid") { setMouseDown(true); paintAtEvent(e); } }}
                onMouseMove={(e) => { if (ovActiveTool === "grid" && mouseDown) paintAtEvent(e); }}
                onMouseUp={() => setMouseDown(false)}
                onMouseLeave={() => setMouseDown(false)}
                style={{ display: "block", position: "relative", cursor: ovActiveTool === "grid" ? "crosshair" : "default", filter: editInvert ? "invert(1)" : "none" }}
              />
              {/* notation overlay */}
              <canvas ref={notationCanvasRef} style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }} />
              {/* brush cursor — on top, captures mouse in brush mode */}
              <canvas ref={overlayCanvasRef}
                style={{ position: "absolute", top: 0, left: 0,
                  pointerEvents: ovActiveTool === "brush" && ovType ? "auto" : "none",
                  cursor: "crosshair",
                  mixBlendMode: ovType ? ovBlend : "normal" }}
                onMouseDown={(e) => { saveMaskSnapshot(); ovIsPaintingRef.current = true; ovPaintAt(e.clientX, e.clientY); }}
                onMouseMove={(e) => {
                  const rect = overlayCanvasRef.current?.getBoundingClientRect();
                  if (rect) ovMouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top, over: true };
                  if (ovIsPaintingRef.current) ovPaintAt(e.clientX, e.clientY);
                }}
                onMouseUp={() => { ovIsPaintingRef.current = false; }}
                onMouseLeave={() => { ovIsPaintingRef.current = false; ovMouseRef.current = { ...ovMouseRef.current, over: false }; }}
                onMouseEnter={() => { ovMouseRef.current = { ...ovMouseRef.current, over: true }; }}
              />
            </div>

            {/* Score view */}
            {showScore && (
              <div style={{ border: `1px solid ${ng20}`, borderRadius: 8, overflow: "hidden", lineHeight: 0 }}>
                <canvas ref={scoreCanvasRef} style={{ display: "block" }} />
              </div>
            )}

            {/* Below-canvas toolbar */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span style={muted}>draw:</span>
              <button onClick={() => { setOvActiveTool("grid"); setDrawValue(1); }} style={btn(ovActiveTool === "grid" && drawValue === 1)}>mc</button>
              <button onClick={() => { setOvActiveTool("grid"); setDrawValue(0); }} style={btn(ovActiveTool === "grid" && drawValue === 0)}>cc</button>
              {ovType && (
                <button onClick={() => setOvActiveTool(ovActiveTool === "brush" ? "grid" : "brush")}
                  style={{ ...btn(ovActiveTool === "brush"), borderColor: ovActiveTool === "brush" ? NG : "#ff66cc", color: ovActiveTool === "brush" ? "#000" : "#ff66cc" }}>
                  brush {ovActiveTool === "brush" ? "on" : "off"}
                </button>
              )}
              <div style={{ width: 1, height: 20, background: ng20 }} />
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, cursor: "pointer" }}>
                <input type="checkbox" checked={symmetry} onChange={(e) => setSymmetry(e.target.checked)} />
                symmetry
              </label>
              <div style={{ width: 1, height: 20, background: ng20 }} />
              <span style={muted}>layers:</span>
              {["OR", "XOR", "AND"].map((m) => (
                <button key={m} onClick={() => setCombineMode(m)} style={btn(combineMode === m)}>{m}</button>
              ))}
            </div>

            {/* Energy meters */}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span style={muted}>energy</span>
              {LAYERS.map((L) => (
                <span key={L.id} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
                  <span style={{ color: L.color, fontWeight: 700 }}>{L.id}</span>
                  <span style={{ display: "inline-block", width: Math.max(2, energyAll[L.id] * 0.5), height: 5, background: L.color, borderRadius: 3, boxShadow: `0 0 4px ${L.color}`, transition: "width 0.1s" }} />
                  <span style={muted}>{energyAll[L.id]}%</span>
                </span>
              ))}
            </div>
          </div>

          {/* ── SOUND CONTROLS (below canvas) ── */}

          {/* Sound layers */}
          <div style={panel}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: 1 }}>sound layers</div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={syncPlayAll} style={{ ...btn(false), fontSize: 11, borderColor: "#00c878", color: "#00c878" }}>sync play</button>
                <button onClick={pauseAll} style={{ ...btn(false), fontSize: 11 }}>pause all</button>
              </div>
            </div>
            {LAYERS.map((L) => (
              <div key={L.id} style={{ border: `1px solid ${ng20}`, borderRadius: 9, padding: 9, marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <b style={{ color: L.color, fontSize: 14, letterSpacing: 1 }}>{L.id}</b>
                    <span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>{L.name}</span>
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ display: "inline-block", width: Math.max(2, energyAll[L.id] * 0.5), height: 5, background: L.color, borderRadius: 3, transition: "width 0.1s" }} />
                    <span style={muted}>{energyAll[L.id]}%</span>
                  </span>
                </div>
                <div style={{ display: "flex", gap: 5, marginBottom: 6 }}>
                  {(L.type === "mic" ? ["off", "mic"] : ["off", "file"]).map((m) => (
                    <button key={m} onClick={() => setModes((s) => ({ ...s, [L.id]: m }))} style={btn(modes[L.id] === m)}>{m}</button>
                  ))}
                </div>
                {/* Frequency band selector + live mini spectrum + color pickers */}
                <div style={{ display: "flex", gap: 4, alignItems: "flex-end", marginBottom: 6 }}>
                  {/* "all" column */}
                  {[["all", layerColors[L.id].all, (audioMap[L.id]?.energy ?? 0)],
                    ...["sub","bass","lmid","mid","hi","air"].map(bk => [bk, layerColors[L.id][bk], (audioMap[L.id]?.bandsRef.current[bk] ?? 0)])
                  ].map(([bk, col, lvl], i) => (
                    <React.Fragment key={bk}>
                      {i === 1 && <div style={{ width: 1, height: 44, background: "rgba(255,255,255,0.1)", alignSelf: "center" }} />}
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                        {/* Live bar */}
                        <div style={{ width: 20, height: 18, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
                          <div style={{ width: 14, height: `${Math.max(8, lvl * 100)}%`, background: col, borderRadius: 2, maxHeight: 18, transition: "height 0.05s" }} />
                        </div>
                        {/* Band select button */}
                        <button onClick={() => setLayerBand(b => ({ ...b, [L.id]: bk }))}
                          style={{ padding: "1px 3px", fontSize: 8, borderRadius: 4, cursor: "pointer", border: `1px solid ${layerBand[L.id] === bk ? col : "rgba(255,255,255,0.15)"}`, background: layerBand[L.id] === bk ? col : "transparent", color: layerBand[L.id] === bk ? "#000" : "rgba(255,255,255,0.45)", lineHeight: 1.4 }}>
                          {bk}
                        </button>
                        {/* Color picker dot */}
                        <label style={{ position: "relative", width: 10, height: 10, borderRadius: "50%", background: col, border: "1px solid rgba(255,255,255,0.25)", cursor: "pointer", display: "block", flexShrink: 0 }}>
                          <input type="color" value={col}
                            onChange={(e) => setLayerColors(lc => ({ ...lc, [L.id]: { ...lc[L.id], [bk]: e.target.value } }))}
                            style={{ position: "absolute", opacity: 0, width: 1, height: 1, pointerEvents: "none" }} />
                        </label>
                      </div>
                    </React.Fragment>
                  ))}
                </div>
                {L.type === "file" && (
                  <div style={{ marginBottom: 6 }}>
                    <input type="file" accept="audio/*" onChange={(e) => filePickerToAudio(audioRefs[L.id], e.target.files?.[0], L.id)} style={{ fontSize: 11 }} />
                    <audio ref={audioRefs[L.id]} controls style={{ width: "100%", marginTop: 4, height: 28 }} />
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                  <label style={label12}>speed
                    <input type="range" min={1} max={30} value={speeds[L.id]}
                      onChange={(e) => setSpeeds((s) => ({ ...s, [L.id]: Number(e.target.value) }))} style={{ marginTop: 2 }} />
                    <span style={muted}>{speeds[L.id]}r/s</span>
                  </label>
                  <label style={label12}>threshold
                    <input type="range" min={0} max={1} step={0.01} value={thresholds[L.id]}
                      onChange={(e) => setThresholds((t) => ({ ...t, [L.id]: Number(e.target.value) }))} style={{ marginTop: 2 }} />
                    <span style={muted}>{Math.round(thresholds[L.id] * 100)}%</span>
                  </label>
                  <label style={label12}>mix
                    <input type="range" min={0} max={1} step={0.01} value={alphas[L.id]}
                      onChange={(e) => setAlphas((a) => ({ ...a, [L.id]: Number(e.target.value) }))} style={{ marginTop: 2 }} />
                    <span style={muted}>{Math.round(alphas[L.id] * 100)}%</span>
                  </label>
                </div>
              </div>
            ))}
          </div>

        </div>

        {/* ── RIGHT: Image controls ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

          {/* Background image */}
          <div style={panel}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, letterSpacing: 1 }}>background image</div>
            <input type="file" accept="image/*" onChange={(e) => handleBgImage(e.target.files?.[0])} />
            {bgImg && <button onClick={() => setBgImg(null)} style={{ ...btn(false), marginTop: 6, fontSize: 11 }}>remove</button>}
            <label style={{ ...label12, marginTop: 10 }}>gap brightness
              <input type="range" min={0} max={1} step={0.01} value={imageOpacity}
                onChange={(e) => setImageOpacity(Number(e.target.value))} style={{ marginTop: 4 }} />
              <span style={muted}>{Math.round(imageOpacity * 100)}%</span>
            </label>
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid #1e1e1e` }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4, letterSpacing: 1 }}>audio mask image</div>
              <div style={{ ...muted, fontSize: 11, marginBottom: 6 }}>revealed only on audio-active stitches</div>
              <input type="file" accept="image/*" onChange={(e) => handleMaskImage(e.target.files?.[0])} />
              {maskImg && <button onClick={() => setMaskImg(null)} style={{ ...btn(false), marginTop: 6, fontSize: 11 }}>remove</button>}
            </div>
          </div>

          {/* Image guide */}
          <div style={panel}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4, letterSpacing: 1 }}>image guide</div>
            <div style={{ ...muted, fontSize: 11, marginBottom: 8 }}>gates which stitches the audio can fill</div>
            <div style={{ display: "flex", gap: 5, marginBottom: 6, flexWrap: "wrap" }}>
              {["OFF", "MASK", "CARVE", "BIAS"].map((m) => (
                <button key={m} onClick={() => setImageMode(m)} style={btn(imageMode === m)}>{m}</button>
              ))}
            </div>
            <div style={{ ...muted, fontSize: 11, marginBottom: 8 }}>
              {imageMode === "OFF"   && "no gating — all stitches free"}
              {imageMode === "MASK"  && "fills only where guide = 1"}
              {imageMode === "CARVE" && "fills only where guide = 0"}
              {imageMode === "BIAS"  && "guide lowers threshold — more fill where bright"}
            </div>
            <input type="file" accept="image/*,video/*" onChange={(e) => {
              const f = e.target.files?.[0]; if (!f) return;
              if (f.type.startsWith("video/")) {
                const vid = videoRef.current;
                if (vid) { vid.src = URL.createObjectURL(f); vid.loop = true; vid.muted = true; vid.play().catch(() => {}); setVideoGuideActive(true); }
              } else { setVideoGuideActive(false); handleImageGuide(f); }
            }} />
            {videoGuideActive && <div style={{ ...muted, fontSize: 11, marginTop: 4 }}>video guide active — sampling frames</div>}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
              <label style={label12}>threshold
                <input type="range" min={0} max={1} step={0.01} value={imgThreshold}
                  onChange={(e) => setImgThreshold(Number(e.target.value))} style={{ marginTop: 4 }} />
                <span style={muted}>{Math.round(imgThreshold * 100)}%</span>
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, cursor: "pointer", paddingTop: 14 }}>
                <input type="checkbox" checked={imgInvert} onChange={(e) => setImgInvert(e.target.checked)} />
                invert guide
              </label>
            </div>
            <button onClick={() => { setVideoGuideActive(false); setImageGuide(makeGrid(rows, cols, 0)); setImageMode("OFF"); }}
              style={{ ...btn(false), marginTop: 8, fontSize: 11 }}>clear guide</button>
          </div>

          {/* Overlay brush */}
          <div style={panel}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4, letterSpacing: 1 }}>overlay brush</div>
            <div style={{ ...muted, fontSize: 11, marginBottom: 8 }}>image/video sits behind stitches — paint to reveal, stitches always on top</div>
            <input type="file" accept="image/*,video/*" onChange={(e) => handleOverlayFile(e.target.files?.[0])} />
            {ovType && (
              <>
                <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                  <button onClick={() => setOvActiveTool("grid")} style={btn(ovActiveTool === "grid")}>grid mode</button>
                  <button onClick={() => setOvActiveTool("brush")}
                    style={{ ...btn(ovActiveTool === "brush"), borderColor: ovActiveTool === "brush" ? NG : "#ff66cc", color: ovActiveTool === "brush" ? "#000" : "#ff66cc" }}>
                    brush mode
                  </button>
                  <button onClick={removeOverlay} style={{ ...btn(false), borderColor: "#ff4444", color: "#ff4444" }}>remove</button>
                </div>
                {ovActiveTool === "brush" && (
                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    <button onClick={() => setOvBrushMode("reveal")} style={btn(ovBrushMode === "reveal")}>reveal</button>
                    <button onClick={() => setOvBrushMode("erase")}
                      style={{ ...btn(ovBrushMode === "erase"), borderColor: "#ff4444", color: ovBrushMode === "erase" ? "#000" : "#ff4444", background: ovBrushMode === "erase" ? "#ff4444" : "transparent" }}>
                      erase
                    </button>
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
                  <label style={label12}>brush size
                    <input type="range" min={1} max={20} value={ovBrushSize}
                      onChange={(e) => setOvBrushSize(Number(e.target.value))} style={{ marginTop: 4 }} />
                    <span style={muted}>{ovBrushSize} cells</span>
                  </label>
                  <label style={label12}>opacity
                    <input type="range" min={0} max={1} step={0.01} value={ovOpacity}
                      onChange={(e) => setOvOpacity(Number(e.target.value))} style={{ marginTop: 4 }} />
                    <span style={muted}>{Math.round(ovOpacity * 100)}%</span>
                  </label>
                </div>
                <label style={{ ...label12, marginTop: 6 }}>blend mode
                  <select value={ovBlend} onChange={(e) => setOvBlend(e.target.value)}
                    style={{ marginTop: 4, background: "#1a1a1a", color: NG, border: `1px solid ${ng20}`, borderRadius: 6, padding: "3px 8px", fontSize: 12, display: "block" }}>
                    {["multiply", "screen", "overlay", "soft-light", "hard-light", "color-burn", "difference", "exclusion", "normal"].map((b) => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                  </select>
                </label>
                <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                  <button onClick={() => { const mc = overlayMaskRef.current; if (mc) { const ctx = mc.getContext("2d"); ctx.clearRect(0, 0, mc.width, mc.height); } }} style={btn(false)}>clear mask</button>
                  <button onClick={() => { const mc = overlayMaskRef.current; if (mc) { const ctx = mc.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, mc.width, mc.height); } }} style={btn(false)}>fill mask</button>
                  {ovType === "video" && (
                    <button onClick={() => { const me = overlayMediaRef.current; if (!me) return; ovVideoPlaying ? me.pause() : me.play().catch(() => {}); }}
                      style={btn(false)}>{ovVideoPlaying ? "pause video" : "play video"}</button>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Perform clips */}
          <div style={panel}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, letterSpacing: 1, color: "#cc99ff" }}>perform clips</div>
            <label style={{ ...label12, display: "block", marginBottom: 8 }}>
              <span style={{ ...btn(false), borderColor: "#9933ff", color: "#cc99ff", cursor: "pointer", display: "inline-block" }}>+ add image / video</span>
              <input type="file" accept="image/*,video/*,.mp4,.webm,.mov,.avi,.mkv,.m4v,.ogv" style={{ display: "none" }}
                onChange={e => { if (e.target.files[0]) { addClip(e.target.files[0]); e.target.value = ""; } }} />
            </label>
            {clips.length === 0 && <div style={{ fontSize: 11, color: "rgba(200,169,110,0.4)", fontStyle: "italic" }}>upload images or videos</div>}
            {clips.map(c => (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4, background: "rgba(153,51,255,0.08)", borderRadius: 5, padding: "4px 6px", flexWrap: "wrap" }}>
                {c.type === "image"
                  ? <img src={c.blobUrl} style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 3, border: "1px solid rgba(153,51,255,0.3)", flexShrink: 0 }} />
                  : <div style={{ width: 28, height: 28, background: "#1a0033", borderRadius: 3, border: "1px solid rgba(153,51,255,0.3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, flexShrink: 0 }}>▶</div>
                }
                <input
                  value={clipNames[c.id] ?? c.name}
                  onChange={e => setClipNames(prev => ({ ...prev, [c.id]: e.target.value }))}
                  style={{ flex: 1, fontSize: 10, color: "#cc99ff", background: "transparent", border: "none", borderBottom: "1px solid rgba(153,51,255,0.3)", outline: "none", minWidth: 0, padding: "1px 2px" }}
                  title="clip name in perform window"
                />
                <select
                  value={clipStyles[c.id] ?? "warm"}
                  onChange={e => {
                    const s = e.target.value;
                    setClipStyles(prev => ({ ...prev, [c.id]: s }));
                    const pid = clipPerformIds.current[c.id];
                    if (pid && performWinRef.current && !performWinRef.current.closed)
                      performWinRef.current.postMessage({ type: "updateClip", id: pid, filter: CLIP_STYLES[s] }, "*");
                  }}
                  style={{ background: "#1a0033", color: "#cc99ff", border: "1px solid rgba(153,51,255,0.4)", borderRadius: 3, fontSize: 9, padding: "1px 2px", cursor: "pointer" }}
                >
                  {Object.keys(CLIP_STYLES).map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <select
                  value={clipBlends[c.id] ?? "normal"}
                  onChange={e => {
                    const m = e.target.value;
                    setClipBlends(prev => ({ ...prev, [c.id]: m }));
                    const pid = clipPerformIds.current[c.id];
                    if (pid && performWinRef.current && !performWinRef.current.closed)
                      performWinRef.current.postMessage({ type: "updateClip", id: pid, mix: m }, "*");
                  }}
                  style={{ background: "#1a0033", color: "#cc99ff", border: "1px solid rgba(153,51,255,0.4)", borderRadius: 3, fontSize: 9, padding: "1px 2px", cursor: "pointer" }}
                >
                  {BLEND_MODES.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                <button onClick={() => sendClipToPerform(c)}
                  style={{ ...btn(false), borderColor: "#9933ff", color: "#cc99ff", padding: "2px 5px", fontSize: 10 }} title="send to perform">⬡</button>
                <button onClick={() => removeClip(c.id)} style={{ ...btn(false), padding: "2px 5px", fontSize: 10, color: "#ff6666", borderColor: "#ff444466" }}>×</button>
              </div>
            ))}
          </div>

          {/* Style */}
          <div style={panel}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, letterSpacing: 1 }}>style — {patternMode}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 8 }}>
              <label style={label12}>mc color
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                  <input type="color" value={warpColor} onChange={(e) => setWarpColor(e.target.value)} style={colorPick} />
                  <span style={muted}>{warpColor}</span>
                </div>
              </label>
              <label style={label12}>cc color
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                  <input type="color" value={cc} onChange={(e) => setCc(e.target.value)} style={colorPick} />
                  <span style={muted}>{cc}</span>
                </div>
              </label>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[
                ["color α", colorAlpha, 0, 1, 0.01, (v) => setColorAlpha(v), `${Math.round(colorAlpha * 100)}%`],
                ["weft α", ccAlpha, 0, 1, 0.01, (v) => setCcAlpha(v), `${Math.round(ccAlpha * 100)}%`],
                ["corner radius", borderRadius, 0, 50, 1, (v) => setBorderRadius(v), `${borderRadius}%`],
                ["size variation", sizeVariation, 0, 1, 0.01, (v) => setSizeVariation(v), `${Math.round(sizeVariation * 100)}%`],
                ["posterize", posterizeLevels, 2, 16, 1, (v) => setPosterizeLevels(v), `${posterizeLevels} lvl`],
                ["gap", gap, 0, 4, 1, (v) => setGap(v), `${gap}px`],
              ].map(([name, val, min, max, step, set, lbl]) => (
                <label key={name} style={label12}>
                  {name}
                  <input type="range" min={min} max={max} step={step} value={val}
                    onChange={(e) => set(Number(e.target.value))} style={{ marginTop: 4 }} />
                  <span style={muted}>{lbl}</span>
                </label>
              ))}
            </div>
            {patternMode === "stitch" && (
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, cursor: "pointer", marginTop: 10 }}>
                <input type="checkbox" checked={stitchInvert} onChange={(e) => setStitchInvert(e.target.checked)} />
                invert stitch fill
              </label>
            )}
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid #1e1e1e`, display: "flex", gap: 16, flexWrap: "wrap" }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, cursor: "pointer" }}>
                <input type="checkbox" checked={showNotation} onChange={(e) => setShowNotation(e.target.checked)} />
                notation overlay
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, cursor: "pointer" }}>
                <input type="checkbox" checked={showScore} onChange={(e) => setShowScore(e.target.checked)} />
                score view
              </label>
            </div>
          </div>

          {/* Grid size */}
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
            <label style={{ ...label12, marginTop: 8 }}>cell size
              <input type="range" min={4} max={24} value={cell} onChange={(e) => setCell(Number(e.target.value))} style={{ marginTop: 4 }} />
              <span style={muted}>{cell}px</span>
            </label>
          </div>
        </div>

        {/* ── POSTER: collapsible 3rd column ── */}
        {posterOpen && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

            {/* Poster canvas */}
            <div style={{ background: "#1a1610", border: "1px solid #3a2e20", borderRadius: 14, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: "#c8a96e", letterSpacing: 1 }}>KNIT POSTER</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={exportPosterPNG}
                    style={{ padding: "5px 12px", borderRadius: 8, fontSize: 11, cursor: "pointer", fontWeight: 600, border: "1px solid #c8a96e", background: "transparent", color: "#c8a96e" }}>
                    export png
                  </button>
                  {isPosterRecording
                    ? <button onClick={stopPosterRecording} style={{ padding: "5px 12px", borderRadius: 8, fontSize: 11, cursor: "pointer", fontWeight: 600, border: "1px solid #ff2222", background: "#ff2222", color: "#fff" }}>stop rec</button>
                    : <button onClick={startPosterRecording} style={{ padding: "5px 12px", borderRadius: 8, fontSize: 11, cursor: "pointer", fontWeight: 600, border: "1px solid #c8a96e", background: "transparent", color: "#c8a96e" }}>record</button>
                  }
                  <button onClick={() => setPosterOpen(false)}
                    style={{ padding: "5px 10px", borderRadius: 8, fontSize: 11, cursor: "pointer", border: "1px solid #3a2e20", background: "transparent", color: "#a07040" }}>
                    ✕
                  </button>
                </div>
              </div>
              <div style={{ ...muted, fontSize: 11, marginBottom: 8, color: "rgba(200,169,110,0.5)" }}>
                mirrors the live audio pattern as V-stitch fabric
              </div>
              {/* Poster canvas — drag to move texts, brush to paint overlay */}
              <div style={{ overflow: "auto", borderRadius: 8, lineHeight: 0, border: "1px solid #3a2e20" }}>
                <canvas ref={posterCanvasRef}
                  style={{ display: "block", cursor: posterActiveTool === "brush" && posterOvType ? "crosshair" : posterCursor, filter: "none" }}
                  onMouseDown={(e) => {
                    const tool = posterParamRef.current.activeTool;
                    if (tool === "brush" && posterParamRef.current.overlayType) { posterIsPaintingRef.current = true; posterPaintAt(e.clientX, e.clientY); return; }
                    const c = posterCanvasRef.current; if (!c) return;
                    const rect = c.getBoundingClientRect(); const cs = posterParamRef.current.cell ?? 5;
                    const gx = (e.clientX - rect.left) / cs; const gy = (e.clientY - rect.top) / cs;
                    const ts = posterParamRef.current.texts || [];
                    // Check resize handle first (only for selected text)
                    const sid = posterParamRef.current.selectedId;
                    if (sid != null) {
                      const sel = ts.find(t => t.id === sid);
                      if (sel && hitPosterResizeHandle(sel, gx, gy, cs)) {
                        pushPosterHistory();
                        posterResizeRef.current = { id: sel.id, origFontSize: sel.fontSize, startGY: gy };
                        e.preventDefault(); return;
                      }
                    }
                    // Check image resize handles first (only for selected image)
                    const selImgId = posterParamRef.current.selectedImgId;
                    if (selImgId != null) {
                      const selImg = posterImgsRef.current.find(pi => pi.id === selImgId);
                      if (selImg) {
                        const hr = 7 / cs; // handle hit radius in grid units
                        const mx = selImg.x + selImg.w / 2, my = selImg.y + selImg.h / 2;
                        const r = selImg.x + selImg.w, b2 = selImg.y + selImg.h;
                        const handles = [
                          ["nw", selImg.x, selImg.y], ["n", mx, selImg.y], ["ne", r, selImg.y],
                          ["e",  r, my],               ["se", r, b2],
                          ["s",  mx, b2],              ["sw", selImg.x, b2], ["w", selImg.x, my],
                        ];
                        for (const [handle, hx, hy] of handles) {
                          if (Math.abs(gx - hx) <= hr && Math.abs(gy - hy) <= hr) {
                            pushPosterHistory();
                            posterImgResizeRef.current = { id: selImg.id, handle, origX: selImg.x, origY: selImg.y, origW: selImg.w, origH: selImg.h, startGX: gx, startGY: gy };
                            e.preventDefault(); return;
                          }
                        }
                      }
                    }
                    // Check image drag
                    for (let i = posterImgsRef.current.length - 1; i >= 0; i--) {
                      const pi = posterImgsRef.current[i];
                      if (gx >= pi.x && gx <= pi.x + pi.w && gy >= pi.y && gy <= pi.y + pi.h) {
                        pushPosterHistory();
                        setPosterSelectedImgId(pi.id); posterParamRef.current.selectedImgId = pi.id;
                        posterDragRef.current = { type: "img", id: pi.id, startGX: gx, startGY: gy, origX: pi.x, origY: pi.y };
                        posterParamRef.current.dirty = true; return;
                      }
                    }
                    // Then check text move
                    for (let i = ts.length - 1; i >= 0; i--) {
                      const t = ts[i]; const b = getPosterTextBounds(t); const hit = 4 / cs;
                      if (gx >= b.x - hit && gx <= b.x + b.w + hit && gy >= b.y - hit && gy <= b.y + b.h + hit) {
                        pushPosterHistory();
                        setPosterSelectedId(t.id);
                        posterDragRef.current = { type: "text", id: t.id, startGX: gx, startGY: gy, origX: t.x, origY: t.y };
                        return;
                      }
                    }
                    setPosterSelectedId(null);
                  }}
                  onMouseMove={(e) => {
                    const c = posterCanvasRef.current; if (!c) return;
                    const rect = c.getBoundingClientRect(); const cs = posterParamRef.current.cell ?? 5;
                    posterMouseRef.current.x = e.clientX - rect.left; posterMouseRef.current.y = e.clientY - rect.top;
                    if (posterIsPaintingRef.current && posterParamRef.current.activeTool === "brush") { posterPaintAt(e.clientX, e.clientY); return; }
                    const gx = (e.clientX - rect.left) / cs;
                    const gy = (e.clientY - rect.top) / cs;
                    // Text resize — mutate ref, commit on mouseUp
                    if (posterResizeRef.current) {
                      const { id, origFontSize, startGY } = posterResizeRef.current;
                      const newSize = Math.max(3, Math.round(origFontSize + (gy - startGY)));
                      posterParamRef.current.texts = (posterParamRef.current.texts || []).map(t => t.id === id ? { ...t, fontSize: newSize } : t);
                      posterParamRef.current.dirty = true; return;
                    }
                    // Image resize — mutate ref, commit on mouseUp
                    if (posterImgResizeRef.current) {
                      const { id, handle, origX, origY, origW, origH, startGX, startGY } = posterImgResizeRef.current;
                      const dx = gx - startGX, dy = gy - startGY;
                      let nx = origX, ny = origY, nw = origW, nh = origH;
                      if (handle.includes("e")) { nw = Math.max(2, origW + dx); }
                      if (handle.includes("w")) { nw = Math.max(2, origW - dx); nx = origX + origW - nw; }
                      if (handle.includes("s")) { nh = Math.max(2, origH + dy); }
                      if (handle.includes("n")) { nh = Math.max(2, origH - dy); ny = origY + origH - nh; }
                      posterImgsRef.current = posterImgsRef.current.map(pi => pi.id === id ? { ...pi, x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh) } : pi);
                      posterParamRef.current.dirty = true; return;
                    }
                    // Update hover cursor — only setState when value changes
                    const sid = posterParamRef.current.selectedId;
                    const ts2 = posterParamRef.current.texts || [];
                    const sel = sid != null ? ts2.find(t => t.id === sid) : null;
                    const onHandle = sel ? hitPosterResizeHandle(sel, gx, gy, cs) : false;
                    const newCursor = onHandle ? "se-resize" : posterDragRef.current ? "grabbing" : posterImgResizeRef.current ? "crosshair" : sel ? "grab" : "default";
                    if (newCursor !== posterParamRef.current._cursor) { posterParamRef.current._cursor = newCursor; setPosterCursor(newCursor); }
                    // Move — mutate refs, commit on mouseUp
                    if (!posterDragRef.current) return;
                    const { type, id, startGX, startGY, origX, origY } = posterDragRef.current;
                    if (type === "img") {
                      posterImgsRef.current = posterImgsRef.current.map(pi => pi.id === id ? { ...pi, x: Math.round(origX + gx - startGX), y: Math.round(origY + gy - startGY) } : pi);
                      posterParamRef.current.dirty = true;
                    } else {
                      posterParamRef.current.texts = (posterParamRef.current.texts || []).map(t => t.id === id ? { ...t, x: Math.round(origX + gx - startGX), y: Math.round(origY + gy - startGY) } : t);
                      posterParamRef.current.dirty = true;
                    }
                  }}
                  onMouseUp={() => {
                    // Commit ref mutations to state
                    if (posterResizeRef.current || posterDragRef.current?.type === "text")
                      setPosterTexts([...(posterParamRef.current.texts || [])]);
                    if (posterImgResizeRef.current || posterDragRef.current?.type === "img")
                      setPosterImgs([...posterImgsRef.current]);
                    posterIsPaintingRef.current = false; posterDragRef.current = null; posterResizeRef.current = null; posterImgResizeRef.current = null;
                  }}
                  onMouseLeave={() => {
                    if (posterResizeRef.current || posterDragRef.current?.type === "text")
                      setPosterTexts([...(posterParamRef.current.texts || [])]);
                    if (posterImgResizeRef.current || posterDragRef.current?.type === "img")
                      setPosterImgs([...posterImgsRef.current]);
                    posterMouseRef.current.over = false; posterIsPaintingRef.current = false; posterDragRef.current = null; posterResizeRef.current = null; posterImgResizeRef.current = null;
                  }}
                  onMouseEnter={() => { posterMouseRef.current.over = true; }}
                />
              </div>
            </div>

            {/* Poster settings */}
            <div style={{ background: "#1a1610", border: "1px solid #3a2e20", borderRadius: 14, padding: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: "#a07040", letterSpacing: 1, marginBottom: 10 }}>POSTER SETTINGS</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                {[
                  ["cell size", posterCell, 3, 10, 1, setPosterCell, `${posterCell}px`],
                  ["staves", staveCount, 0, 20, 1, setStaveCount, staveCount],
                  ["notation seed", notationSeed, 1, 999, 1, setNotationSeed, notationSeed],
                ].map(([name, val, min, max, step, set, lbl]) => (
                  <label key={name} style={{ fontSize: 11, color: "#c8a96e", display: "block" }}>
                    {name}
                    <input type="range" min={min} max={max} step={step} value={val}
                      onChange={(e) => set(Number(e.target.value))} style={{ marginTop: 3 }} />
                    <span style={{ fontSize: 10, color: "rgba(200,169,110,0.5)" }}>{lbl}</span>
                  </label>
                ))}
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11, color: "#c8a96e", cursor: "pointer", paddingTop: 14 }}>
                  <input type="checkbox" checked={fabricInvert} onChange={(e) => setFabricInvert(e.target.checked)} />
                  dark mode
                </label>
                <label style={{ fontSize: 11, color: "#a07040", paddingTop: 8 }}>
                  sound layer opacity — {Math.round(posterLayerAlpha * 100)}%
                  <input type="range" min={0} max={1} step={0.01} value={posterLayerAlpha}
                    onChange={e => setPosterLayerAlpha(Number(e.target.value))}
                    style={{ display: "block", width: "100%", marginTop: 3 }} />
                </label>
              </div>
            </div>

            {/* Poster text layers */}
            <div style={{ background: "#1a1610", border: "1px solid #3a2e20", borderRadius: 14, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: "#a07040", letterSpacing: 1 }}>TEXT LAYERS</div>
                <button onClick={addPosterText}
                  style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer", border: "1px solid #c8a96e", background: "transparent", color: "#c8a96e" }}>
                  + add
                </button>
              </div>
              {posterTexts.map((t) => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, padding: "6px 8px", borderRadius: 7,
                  background: t.id === posterSelectedId ? "rgba(200,169,110,0.12)" : "transparent",
                  border: `1px solid ${t.id === posterSelectedId ? "#c8a96e" : "#2e2416"}`, cursor: "pointer" }}
                  onClick={() => setPosterSelectedId(t.id)}>
                  <span style={{ fontSize: 11, color: "#c8a96e", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.content || "(empty)"}
                  </span>
                  <span style={{ fontSize: 10, color: "rgba(200,169,110,0.4)" }}>{t.knit ? "knit" : "text"}</span>
                  <button onClick={(e) => { e.stopPropagation(); removePosterText(t.id); }}
                    style={{ background: "none", border: "none", color: "#a07040", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}>✕</button>
                </div>
              ))}
              {/* Selected text editor */}
              {posterSelected && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #2e2416", display: "flex", flexDirection: "column", gap: 8 }}>
                  <textarea value={posterSelected.content}
                    onChange={(e) => updatePosterSelected({ content: e.target.value })}
                    onBlur={(e) => commitPosterSelected({ content: e.target.value })}
                    style={{ width: "100%", height: 60, background: "#0e0b08", color: "#c8a96e", border: "1px solid #3a2e20", borderRadius: 6, padding: 6, fontSize: 12, boxSizing: "border-box", resize: "vertical" }} />
                  <label style={{ fontSize: 11, color: "#a07040", display: "block" }}>
                    font size — {posterSelected.fontSize}px
                    <input type="range" min={3} max={120} value={posterSelected.fontSize}
                      onPointerDown={pushPosterHistory}
                      onChange={(e) => updatePosterSelected({ fontSize: Number(e.target.value) })}
                      style={{ marginTop: 3, display: "block", width: "100%" }} />
                  </label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    <div />
                    <label style={{ fontSize: 11, color: "#a07040", display: "block" }}>font
                      <select value={posterSelected.fontFamily} onChange={(e) => commitPosterSelected({ fontFamily: e.target.value })}
                        style={{ marginTop: 3, background: "#0e0b08", color: "#c8a96e", border: "1px solid #3a2e20", borderRadius: 5, padding: "3px 6px", fontSize: 12, width: "100%", boxSizing: "border-box" }}>
                        {POSTER_FONTS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                      </select>
                    </label>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 11, color: "#a07040", cursor: "pointer" }}>
                      <input type="checkbox" checked={posterSelected.bold ?? false} onChange={(e) => commitPosterSelected({ bold: e.target.checked })} />
                      bold
                    </label>
                    <label style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 11, color: "#a07040", cursor: "pointer" }}>
                      <input type="checkbox" checked={posterSelected.knit !== false} onChange={(e) => commitPosterSelected({ knit: e.target.checked })} />
                      knit style
                    </label>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <label style={{ fontSize: 11, color: "#a07040", display: "flex", alignItems: "center", gap: 5 }}>
                      <input type="checkbox" checked={posterSelected.color != null}
                        onChange={e => commitPosterSelected({ color: e.target.checked ? "#c8a96e" : null })} />
                      color
                      {posterSelected.color != null && (
                        <input type="color" value={posterSelected.color}
                          onChange={e => commitPosterSelected({ color: e.target.value })}
                          style={{ width: 28, height: 20, cursor: "pointer", padding: 1, borderRadius: 4, border: "none" }} />
                      )}
                    </label>
                  </div>
                  <label style={{ fontSize: 11, color: "#a07040" }}>
                    glow — {posterSelected.glow ?? 0}
                    <input type="range" min={0} max={20} step={0.5} value={posterSelected.glow ?? 0}
                      onPointerDown={pushPosterHistory}
                      onChange={(e) => updatePosterSelected({ glow: Number(e.target.value) })}
                      style={{ display: "block", width: "100%", marginTop: 3 }} />
                  </label>
                  {posterSelected.knit !== false && (
                    <div style={{ display: "flex", gap: 8 }}>
                      <label style={{ fontSize: 11, color: "#a07040", flex: 1 }}>
                        cell bg — {Math.round((posterSelected.bgOpacity ?? 0) * 100)}%
                        <input type="range" min={0} max={1} step={0.01} value={posterSelected.bgOpacity ?? 0}
                          onPointerDown={pushPosterHistory}
                          onChange={(e) => updatePosterSelected({ bgOpacity: Number(e.target.value) })}
                          style={{ display: "block", width: "100%", marginTop: 3 }} />
                      </label>
                      <label style={{ fontSize: 11, color: "#a07040" }}>
                        color
                        <input type="color" value={posterSelected.bgColor ?? "#fdf3e7"}
                          onChange={e => commitPosterSelected({ bgColor: e.target.value })}
                          style={{ display: "block", width: 28, height: 20, cursor: "pointer", padding: 1, borderRadius: 4, border: "none", marginTop: 3 }} />
                      </label>
                    </div>
                  )}
                  <label style={{ fontSize: 11, color: "#a07040" }}>
                    opacity — {Math.round((posterSelected.opacity ?? 1) * 100)}%
                    <input type="range" min={0} max={1} step={0.01} value={posterSelected.opacity ?? 1}
                      onPointerDown={pushPosterHistory}
                      onChange={(e) => updatePosterSelected({ opacity: Number(e.target.value) })}
                      style={{ display: "block", width: "100%", marginTop: 3 }} />
                  </label>
                  <label style={{ fontSize: 11, color: "#a07040" }}>blend
                    <select value={posterSelected.blend ?? "source-over"}
                      onChange={(e) => commitPosterSelected({ blend: e.target.value })}
                      style={{ marginTop: 3, display: "block", background: "#0e0b08", color: "#c8a96e", border: "1px solid #3a2e20", borderRadius: 5, padding: "3px 6px", fontSize: 11 }}>
                      {["source-over","multiply","screen","overlay","soft-light","hard-light","color-burn","difference","exclusion"].map(b => (
                        <option key={b} value={b}>{b}</option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </div>

            {/* Poster image layers */}
            <div style={{ background: "#1a1610", border: "1px solid #3a2e20", borderRadius: 14, padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: "#a07040", letterSpacing: 1 }}>IMAGE LAYERS</div>
                <label style={{ padding: "4px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer", border: "1px solid #c8a96e", color: "#c8a96e" }}>
                  + add
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: "none" }}
                    onChange={e => { addPosterImg(e.target.files?.[0]); e.target.value = ""; }} />
                </label>
              </div>
              {posterImgs.map(pi => (
                <div key={pi.id} style={{ marginBottom: 8, padding: "8px", borderRadius: 8,
                  background: pi.id === posterSelectedImgId ? "rgba(200,169,110,0.12)" : "rgba(255,255,255,0.03)",
                  border: `1px solid ${pi.id === posterSelectedImgId ? "#c8a96e" : "#2e2416"}`, cursor: "pointer" }}
                  onClick={() => { setPosterSelectedImgId(pi.id); posterParamRef.current.selectedImgId = pi.id; posterParamRef.current.dirty = true; }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                    <img src={pi.blobUrl} style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 4 }} />
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                      <label style={{ fontSize: 11, color: "#a07040" }}>
                        opacity — {Math.round(pi.opacity * 100)}%
                        <input type="range" min={0} max={1} step={0.01} value={pi.opacity}
                          onPointerDown={pushPosterHistory}
                          onChange={e => { setPosterImgs(prev => prev.map(p => p.id === pi.id ? { ...p, opacity: Number(e.target.value) } : p)); posterParamRef.current.dirty = true; }}
                          style={{ display: "block", width: "100%", marginTop: 2 }} />
                      </label>
                      <label style={{ fontSize: 11, color: "#a07040" }}>
                        size — {pi.w}
                        <input type="range" min={5} max={200} step={1} value={pi.w}
                          onPointerDown={pushPosterHistory}
                          onChange={e => { const w = Number(e.target.value); const imgEl = posterImgElemsRef.current[pi.id]; const h = imgEl ? Math.round(w / (imgEl.naturalWidth / imgEl.naturalHeight)) : pi.h; setPosterImgs(prev => prev.map(p => p.id === pi.id ? { ...p, w, h } : p)); posterParamRef.current.dirty = true; }}
                          style={{ display: "block", width: "100%", marginTop: 2 }} />
                      </label>
                    </div>
                    <button onClick={e => { e.stopPropagation(); removePosterImg(pi.id); }}
                      style={{ background: "none", border: "none", color: "#a07040", cursor: "pointer", fontSize: 14, padding: "0 4px" }}>×</button>
                  </div>
                  <label style={{ fontSize: 11, color: "#a07040" }}>blend
                    <select value={pi.blend ?? "source-over"}
                      onChange={e => { pushPosterHistory(); setPosterImgs(prev => prev.map(p => p.id === pi.id ? { ...p, blend: e.target.value } : p)); posterParamRef.current.dirty = true; }}
                      style={{ marginLeft: 6, background: "#0e0b08", color: "#c8a96e", border: "1px solid #3a2e20", borderRadius: 5, padding: "2px 6px", fontSize: 11 }}>
                      {["source-over","multiply","screen","overlay","soft-light","hard-light","difference","exclusion"].map(b => <option key={b} value={b}>{b}</option>)}
                    </select>
                  </label>
                </div>
              ))}
              {posterImgs.length === 0 && <div style={{ fontSize: 11, color: "rgba(200,169,110,0.4)" }}>no images — add a PNG to layer on top</div>}
            </div>

            {/* Poster overlay brush */}
            <div style={{ background: "#1a1610", border: "1px solid #3a2e20", borderRadius: 14, padding: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 12, color: "#a07040", letterSpacing: 1, marginBottom: 8 }}>OVERLAY BRUSH</div>
              <input type="file" accept="image/*,video/*" onChange={(e) => handlePosterFile(e.target.files?.[0])} />
              {posterOvType && (
                <>
                  <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                    <button onClick={() => setPosterActiveTool("select")}
                      style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11, cursor: "pointer", border: `1px solid ${posterActiveTool === "select" ? "#c8a96e" : "#3a2e20"}`, background: posterActiveTool === "select" ? "#c8a96e" : "transparent", color: posterActiveTool === "select" ? "#000" : "#c8a96e" }}>
                      select
                    </button>
                    <button onClick={() => setPosterActiveTool("brush")}
                      style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11, cursor: "pointer", border: "1px solid #9060c0", background: posterActiveTool === "brush" ? "#9060c0" : "transparent", color: posterActiveTool === "brush" ? "#fff" : "#9060c0" }}>
                      brush
                    </button>
                    {posterActiveTool === "brush" && (
                      <>
                        <button onClick={() => setPosterBrushMode("reveal")}
                          style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11, cursor: "pointer", border: `1px solid ${posterBrushMode === "reveal" ? "#c8a96e" : "#3a2e20"}`, background: posterBrushMode === "reveal" ? "#c8a96e" : "transparent", color: posterBrushMode === "reveal" ? "#000" : "#c8a96e" }}>
                          reveal
                        </button>
                        <button onClick={() => setPosterBrushMode("erase")}
                          style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11, cursor: "pointer", border: "1px solid #c04040", background: posterBrushMode === "erase" ? "#c04040" : "transparent", color: posterBrushMode === "erase" ? "#fff" : "#c04040" }}>
                          erase
                        </button>
                      </>
                    )}
                    <button onClick={removePosterOverlay}
                      style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11, cursor: "pointer", border: "1px solid #c04040", background: "transparent", color: "#c04040" }}>
                      remove
                    </button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
                    <label style={{ fontSize: 11, color: "#a07040", display: "block" }}>brush size
                      <input type="range" min={1} max={20} value={posterBrushSize}
                        onChange={(e) => setPosterBrushSize(Number(e.target.value))} style={{ marginTop: 3 }} />
                      <span style={{ fontSize: 10, color: "rgba(200,169,110,0.5)" }}>{posterBrushSize} cells</span>
                    </label>
                    <label style={{ fontSize: 11, color: "#a07040", display: "block" }}>opacity
                      <input type="range" min={0} max={1} step={0.01} value={posterOvOpacity}
                        onChange={(e) => setPosterOvOpacity(Number(e.target.value))} style={{ marginTop: 3 }} />
                      <span style={{ fontSize: 10, color: "rgba(200,169,110,0.5)" }}>{Math.round(posterOvOpacity * 100)}%</span>
                    </label>
                  </div>
                  <label style={{ fontSize: 11, color: "#a07040", display: "block", marginTop: 6 }}>blend
                    <select value={posterOvBlend} onChange={(e) => setPosterOvBlend(e.target.value)}
                      style={{ marginTop: 3, background: "#0e0b08", color: "#c8a96e", border: "1px solid #3a2e20", borderRadius: 5, padding: "3px 6px", fontSize: 11, display: "block", width: "100%" }}>
                      {["multiply", "screen", "overlay", "soft-light", "hard-light", "color-burn", "difference", "normal"].map(b => <option key={b} value={b}>{b}</option>)}
                    </select>
                  </label>
                  <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <button onClick={() => { const mc = posterMaskRef.current; if (mc) { const ctx = mc.getContext("2d"); ctx.clearRect(0,0,mc.width,mc.height); posterParamRef.current.dirty = true; } }}
                      style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11, cursor: "pointer", border: "1px solid #3a2e20", background: "transparent", color: "#a07040" }}>
                      clear mask
                    </button>
                    <button onClick={() => { const mc = posterMaskRef.current; if (mc) { const ctx = mc.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0,0,mc.width,mc.height); posterParamRef.current.dirty = true; } }}
                      style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11, cursor: "pointer", border: "1px solid #3a2e20", background: "transparent", color: "#a07040" }}>
                      fill mask
                    </button>
                    {posterOvType === "video" && (
                      <button onClick={() => { const me = posterMediaRef.current; if (!me) return; posterOvVideoPlaying ? me.pause() : me.play().catch(() => {}); }}
                        style={{ padding: "5px 10px", borderRadius: 7, fontSize: 11, cursor: "pointer", border: "1px solid #3a2e20", background: "transparent", color: "#a07040" }}>
                        {posterOvVideoPlaying ? "pause" : "play"}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>

          </div>
        )}

      </div>
    </div>
  );
}
