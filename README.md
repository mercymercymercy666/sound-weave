# Sound Weave

A live knitting pattern generator that weaves sound into fabric.

Upload an image, feed it sound — mic or audio files — and watch a textile pattern grow, driven by audio in real time.

**Live:** https://mercymercymercy666.github.io/sound-weave/

---

## Pattern modes

| Mode | Description |
|---|---|
| **Weave** | Interlocking woven strips — over-under illusion with raised/recessed cells |
| **Lace** | Organic circular stitches, eyelet rings, wavy yarn lines |
| **Chart** | Filet/knitting chart — V-symbols with drop shadow, holes as faint rings |
| **Stitch** | V-symbol stitches with a soft background fill |

## Audio layers

| Layer | Source |
|---|---|
| A | Microphone |
| B / C / D | Audio file players |

Layers are visualised simultaneously and can be combined with OR / XOR / AND logic.

## Features

- **4 pattern modes** — weave, lace, chart, stitch
- **4 audio layers** — mic + three file players
- **Perform window** — separate fullscreen output for projection; streams the live canvas
- **Clips** — load images/videos, apply filter styles + blend modes, send to perform window
- **Invert** — flip all colors on edit canvas and perform window simultaneously
- **Background image** — pattern renders over your photo
- **Audio mask image** — second image revealed only through audio-active stitches
- **Manual painting** — click/drag to paint cells directly
- **Video export** — record canvas + audio as .webm
- **Knitting instructions** — row-by-row MC/CC stitch counts with float warnings
- **Poster view** — stylised print-ready layout with text layers and overlay brush

## Clip styles
`warm` · `weave` · `stitch` · `chart` · `threshold` · `cmyk`

Each clip has an independent blend mode (multiply, screen, overlay, difference, etc.)

## Run locally

```bash
npm install
npm run dev
```

## Deploy

Push to `main` → GitHub Actions builds and deploys to GitHub Pages automatically.
Built with React 19 + Vite.
