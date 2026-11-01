# PixelForge

A Photoshop-inspired desktop image editor built with Electron + TypeScript. Opens and saves **layered PSD files** and edits all common image formats with brushes, layers, blend modes, selections and filters.

## Features (v0.1)

| Area | What works |
|---|---|
| **Files** | Open/save **PSD** (layers, names, opacity, visibility, blend modes preserved; groups are flattened into layers). Open PNG, JPEG, WebP, GIF, BMP, AVIF, ICO, SVG. Export PNG, JPEG, WebP, BMP, PSD. Drag & drop, multiple document tabs. |
| **Layers** | Add, duplicate, delete, reorder (drag or buttons), merge down, flatten, rename (double-click), visibility, opacity, 16 blend modes. |
| **Brush & eraser** | Size, hardness, opacity, flow, spacing; pen-pressure sensitivity; stroke-level opacity like Photoshop. `[` / `]` resize. |
| **Tools** | Move, rectangular marquee, brush, eraser, paint bucket (tolerance/contiguous), gradient, eyedropper, hand. |
| **Selection** | Rectangular selection limits brush, fills, gradients, filters and move. |
| **Image** | Image size, canvas size, rotate 90°, flip H/V. |
| **Filters** | Invert, desaturate, sepia, gaussian blur, brightness/contrast, hue/saturation. |
| **Editing** | Undo/redo history (100 steps), zoom/pan (wheel, Space-drag), fit/100%. |

### Known limitations
- Layers are document-sized (pixels moved off-canvas are cropped).
- PSD: layer masks, adjustment layers, smart-object editing, layer effects and text editability are not preserved (text/smart objects import as their rasterized pixels).
- No TIFF/RAW support yet.

## Shortcuts
`V` move · `M` marquee · `B` brush · `E` eraser · `G` bucket · `D` gradient · `I` eyedropper · `H` hand · `X` swap colors · `[` `]` brush size
`Ctrl+N/O/S` new/open/save PSD · `Ctrl+Shift+S` export PNG · `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo · `Ctrl+J` duplicate layer · `Ctrl+E` merge down · `Ctrl+A/D` select all/none · `Ctrl+I` invert · `Ctrl+0/1` fit/100% · `Space`+drag pan

## Development

```bash
npm install
npm run app:dev     # Vite dev server + Electron with hot reload
npm run dev         # browser-only (works for most things; file dialogs fall back to the web APIs)
npm run build       # typecheck + production build
npm start           # build and launch the desktop app
npm test            # end-to-end tests (headless Chromium via Playwright; run `npm run build` first)
npm run dist:win    # Windows installer + portable exe (electron-builder)
```

## Roadmap
Layer masks, text tool, lasso/magic-wand selections, clone stamp, curves/levels, layer styles, groups, custom brush tips, tablet tilt, TIFF support.

## License
MIT
