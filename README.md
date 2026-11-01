# PixelForge

A Photoshop-inspired desktop image editor built with Electron + TypeScript. Opens and saves **layered PSD files** and edits all common image formats with brushes, layers, blend modes, selections and filters.

## Features (v0.5)

| Area | What works |
|---|---|
| **Files** | Open/save **PSD** (layers, names, opacity, visibility, blend modes preserved; groups are flattened into layers). Open PNG, JPEG, WebP, GIF, BMP, AVIF, ICO, SVG. Export PNG, JPEG, WebP, BMP, PSD. Drag & drop, multiple document tabs. |
| **Layers** | Add, duplicate, delete, reorder (drag or buttons), merge down, flatten, rename (double-click), visibility, opacity, 16 blend modes. |
| **Layer masks** | Add Reveal All / Hide All / From Selection; paint on the mask with any tool (white reveals, black hides; brush, eraser, bucket, gradient, fills, filters and Invert all work on masks). Click the mask thumbnail to edit it, Shift+click to disable. Apply or delete a mask from the Layer menu. Masks move with their layer, survive merge/duplicate/flip/resize, and **round-trip through PSD**. |
| **Text** | Text tool (`T`): click to type, click existing text to re-edit. Font, size, bold, italic, alignment, color (foreground). Text stays an editable layer — move it, restyle it, mask it, blend it. Painting on it or applying filters rasterizes it (undoable). |
| **Brush & eraser** | Size, hardness, opacity, flow, spacing; pen-pressure sensitivity; stroke-level opacity like Photoshop. `[` / `]` resize. |
| **Tools** | Move, rectangular marquee, brush, eraser, paint bucket (tolerance/contiguous), gradient, eyedropper, hand. |
| **Selection** | Rectangle & ellipse marquee, freehand lasso, magic wand (tolerance, contiguous, sample all layers). **Shift** adds, **Alt** subtracts, **Shift+Alt** intersects. Select ▸ All / Deselect / Inverse (`Ctrl+Shift+I`) / Feather. Irregular selections limit brush, eraser, bucket, gradient, fills, filters and move, and can become a layer mask. Selection changes are undoable. |
| **Image** | Image size, canvas size, rotate 90°, flip H/V. |
| **Adjustments** | **Levels** (input black/white, gamma, output range, per-channel, histogram, Auto) and **Curves** (smooth overshoot-free curve, add/drag/remove points, per-channel, presets) with live preview. Also Auto Levels, brightness/contrast, hue/saturation, invert, desaturate, sepia. Adjustments respect selections and work on layer masks. |
| **Adjustment layers** | Non-destructive **Levels, Curves, Brightness/Contrast, Hue/Saturation, Invert** layers (Layers panel ◐ button or Layer menu). They affect everything below them, come with a layer mask (paint to limit the effect) and an opacity, and stay editable — double-click the icon to reopen the dialog. Merge Down bakes one into the layer below; Flatten renders them. **Photoshop's own Levels / Curves / Invert / Brightness-Contrast / Hue-Saturation adjustment layers open as editable adjustment layers** and are written back to PSD. |
| **Filters** | Gaussian blur. |
| **Editing** | Undo/redo history (100 steps), zoom/pan (wheel, Space-drag), fit/100%. |

### Known limitations
- Layers are document-sized (pixels moved off-canvas are cropped).
- PSD: smart-object editing and layer effects are not preserved. Adjustment layers other than Levels, Curves, Invert, Brightness/Contrast and Hue/Saturation (e.g. Vibrance, Selective Color) open as hidden placeholders with a warning. Brightness/Contrast and Hue/Saturation use PixelForge's own formulas, so they look *similar* but not identical to Photoshop's. Hue/Saturation's per-colour ranges and Lightness are ignored.
- Adjustment layers have no blend modes (only opacity + mask). Each one holds a full-size blank pixel canvas, and each LUT-based adjustment costs a full-image pass per redraw (about 140 ms per layer at 12 megapixels in a software-rendered browser), so many adjustment layers on very large images will feel slower while painting. Text layers are saved as pixels, so they re-open as normal (rasterized) layers in PixelForge and Photoshop. Vector masks and mask feather/density are ignored.
- No TIFF/RAW support yet.

## Shortcuts
`V` move · `M` marquee · `L` lasso · `W` magic wand · `B` brush · `E` eraser · `G` bucket · `D` gradient · `T` text · `I` eyedropper · `H` hand · `X` swap colors · `[` `]` brush size
`Ctrl+N/O/S` new/open/save PSD · `Ctrl+Shift+S` export PNG · `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo · `Ctrl+J` duplicate layer · `Ctrl+E` merge down · `Ctrl+A/D` select all/none · `Ctrl+L` levels · `Ctrl+M` curves · `Ctrl+Shift+L` auto levels · `Ctrl+I` invert · `Ctrl+0/1` fit/100% · `Space`+drag pan

## Development

```bash
npm install
npm run app:dev     # Vite dev server + Electron with hot reload
npm run dev         # browser-only (works for most things; file dialogs fall back to the web APIs)
npm run build       # typecheck + production build
npm start           # build and launch the desktop app
npm test            # unit tests (tone maths) + end-to-end tests (headless Chromium via Playwright; run `npm run build` first)
npm run dist:win    # Windows installer + portable exe (electron-builder)
```

## Roadmap
Adjustment-layer blend modes, more adjustment types (vibrance, color balance, selective color), polygonal lasso, quick selection, clone stamp, layer styles, groups, custom brush tips, tablet tilt, TIFF support.

## License
MIT
