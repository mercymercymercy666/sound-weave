# Sound Weave

A live knitting pattern generator that weaves sound into fabric.

Upload an image, feed it sound — mic, audio files — and watch a textile pattern grow over your image, driven by the audio in real time.

**Live demo:** https://mercymercymercy666.github.io/knit-sound/

---

## How it works

Sound is analysed in real time (frequency spectrum + energy). Each audio frame paints a row of the binary knit grid: loud / high-frequency moments fill stitches, quiet moments leave holes. The result renders as one of three textile pattern styles over your background image.

## Pattern styles

| Mode | Description |
|---|---|
| **Weave** | Interlocking woven strips — an over-under illusion with raised/recessed cells |
| **Lace** | Organic circular stitches, eyelet rings, and wavy yarn lines |
| **Chart** | Filet/knitting chart style — filled stitches with V-symbol + drop shadow, holes as faint rings |

Switch between modes with the **Weave / Lace / Chart** pill toggle at the top of the canvas.

## Audio sources (4 layers)

| Layer | Type |
|---|---|
| A | Microphone |
| B / C / D | Audio file players |

All layers are visualised simultaneously with different colors. Layers can be combined with OR / XOR / AND logic.

## Features

- **3 pattern styles** — weave, lace, chart (filet knitting)
- **4 audio layers** — mic (A) + three audio file players (B/C/D)
- **Background image** — upload any image; pattern renders on top with adjustable opacity
- **Audio mask image** — upload a second image revealed only through audio-active (moving) stitches
- **Symmetry** — mirrors the pattern horizontally
- **Layer combination** — OR / XOR / AND modes blend all active layers
- **Manual painting** — click/drag on the canvas to paint cells
- **Video export** — record canvas animation with mixed audio as .webm
- **Knitting instructions** — full row-by-row MC/CC stitch counts with float warnings
- **Export PNG** — download the current pattern as an image
- **Download pattern** — save all rows as a .txt knitting chart

## Controls

| Control | Description |
|---|---|
| Pattern mode | Weave / Lace / Chart pill toggle |
| Background image | Upload a photo — the pattern overlays it |
| Audio mask image | Second image revealed only on audio-reactive stitches |
| Image opacity | How much the background shows through |
| MC / CC colors | The two yarn/stitch colors |
| Gap | Pixel gap between cells |
| Border radius | Cell corner rounding |
| Size variation | Controls stitch fill ratio |
| Posterize | Color quantisation levels |
| Cols / Rows | Grid size in stitches |
| Cell size | Zoom level |
| Speed | How fast each layer paints rows (rows/sec) |
| Threshold | Minimum audio level to activate a stitch |
| Symmetry | Mirror pattern left/right |
| Combine | How layers are merged (OR / XOR / AND) |
| Record | Capture canvas + audio as .webm video |
| Download pattern | Export full knit chart as .txt |

## Deploy

Deploys automatically via GitHub Actions on every push to `main`.
Built with React 19 + Vite.
