# pdf-optimizer

[![experimental](http://badges.github.io/stability-badges/dist/experimental.svg)](http://github.com/badges/stability-badges)

Shrink image-heavy PDFs — especially **Figma exports** — by recompressing their
raster images **in place**, without re-writing the rest of the document.

Figma (and tools like it) export photographs as *losslessly* Flate-compressed
raw bitmaps, so a deck full of images can be hundreds of megabytes. This tool
swaps each image stream for a JPEG and leaves **everything else byte-for-byte
intact**: vectors, clipping/soft masks, text, the ICC color profile, and the
document structure. That's the key difference from Ghostscript (`gs`), which
re-interprets the whole PDF and tends to flatten color (dropping the embedded
ICC profile) and mangle masks/shapes.

On a real 24-page Figma portfolio:

| | size | color | masks/vectors |
|---|---|---|---|
| original | 302.8 MB | ICC | intact |
| `gs -dPDFSETTINGS=/screen` | 24.7 MB | **flattened to DeviceRGB** | **re-baked** |
| `pdf-optimize` (defaults) | 38.9 MB | **ICC preserved** | **untouched** |
| `pdf-optimize -q 45 --subsampling 4:2:0` | 15.7 MB | **ICC preserved** | **untouched** |

Render-diffing every page before/after shows the output is 2–3× closer to the
original than the Ghostscript result. Ghostscript is smaller only because it uses
aggressive JPEG quality + 4:2:0 chroma (it does **not** downsample) — match those
dials and `pdf-optimize` is both smaller *and* fidelity-preserving.

## How it works

For every image XObject:

1. Decode its samples (in the image's **own** color space — no conversion).
2. **Route by content.** Figma stores everything as Flate, so an image's existing
   bytes-per-pixel cleanly separates flat/vector-like art (compresses hard) from
   photos (barely compresses):
   - **photographic** → re-encode as JPEG with [sharp](https://sharp.pixelplumbing.com/)
     (mozjpeg, 4:4:4 chroma by default for full color fidelity).
   - **flat / vector-like** → kept **lossless**, re-deflated at max level (beats
     Figma's default Flate). JPEG is never applied here — it would look worse
     (ringing on edges) and is often larger.
3. **Blank off-page pixels.** Figma "fill" images often extend past the page (or
   their frame); those pixels are stored but never seen. They're flattened to a
   flat colour so they compress to almost nothing — **without** touching the
   placement, CTM, dimensions or content streams (only never-rendered pixels
   change). On by default; `--no-blank-offpage` to disable.
4. Resize for `--dpi` (placement-aware, see below; default 300).
5. Write the result back onto the **same object** ([mupdf](https://mupdf.readthedocs.io/)
   `writeRawStream`), set `/Filter`, and keep `/ColorSpace`, `/SMask` (alpha),
   and bit depth unchanged.
6. Keep the original stream if the new one isn't actually smaller; leave images
   below `--min-bytes` untouched.

Soft masks (alpha) stay as separate, lossless objects, so transparency is never
JPEG'd. Indexed / Separation / Lab / CMYK images are left untouched (safe
fallback). The final save uses mupdf with `compress-images=no` so your fresh
JPEGs are never re-touched.

`--dpi` is **placement-aware**: it measures how large each image is actually
drawn on the page and only downsamples images whose *effective* resolution
exceeds the target (default 300), leaving full-bleed/low-res images alone.
`--dpi 0` disables downsampling.

## Install

```sh
npm install -g pdf-optimizer
```

## Usage

```sh
pdf-optimize deck.pdf                      # -> deck.optimized.pdf (q80, dpi 300, blank off-page)
pdf-optimize deck.pdf -q 85 --dpi 200 -o deck.min.pdf
pdf-optimize deck.pdf --dpi 0 --no-blank-offpage   # recompress only, change nothing else
pdf-optimize deck.pdf --verify             # render every page before/after, report pixel diffs
```

```
Options:
  -o, --output <file>     output path (default: <input>.optimized.pdf)
  -q, --quality <n>       JPEG quality 1-100 (default: 80)
      --dpi <n>           downsample images above this effective PPI (default: 300; 0 = off)
      --subsampling <s>   chroma subsampling: 4:4:4 | 4:2:2 | 4:2:0 (default: 4:4:4)
      --no-blank-offpage  keep pixels drawn off the page (blanking is on by default)
      --min-ratio <r>     only replace an image if new/old size <= r (default: 1.0)
      --min-bytes <n>     leave images smaller than n bytes untouched (default: 4096)
      --vector-threshold <b>  Flate bytes/pixel below which an image is kept
                          lossless instead of JPEG'd (default: 0.2)
      --verify            render every page before/after and report pixel diffs
      --quiet             suppress per-image progress (keep summary + per-page report)
      --silent            no output at all
  -h, --help
```

After optimizing, a per-page report shows how many images changed on each page
(jpeg / lossless / downsampled / off-page-blanked).

### Programmatic

```js
import { optimize, compare } from "pdf-optimizer";
import { readFileSync, writeFileSync } from "node:fs";

const { bytes, stats } = await optimize(readFileSync("deck.pdf"), {
  quality: 85,
  dpi: 200,             // placement-aware downsample (omit/null = off)
  subsampling: "4:4:4",
  blankOffPage: true,   // flatten never-visible pixels (default)
});
writeFileSync("deck.optimized.pdf", bytes);

// optional QA: per-page mean/max pixel difference
const diffs = compare(readFileSync("deck.pdf"), bytes);
```

## Browser (WASM)

The same engine runs entirely in the browser — no upload, no server. A tiny
[Vite](https://vite.dev/) app is included:

```sh
npm run dev      # dev server with the drag-and-drop UI
npm run build    # static site -> dist/
```

It's the **same `src/optimize.js` engine** as the CLI; only the image codecs are
swapped. The main thread is pure UI (a ~4 KB bundle):

- **`web/optimize.worker.js`** — an orchestrator worker that runs the whole
  `optimize()` (mupdf + the engine), so the page never blocks. It reports the
  image count up front (free — the engine already lists the images in one pass)
  and streams progress for a progress bar.
- **`src/encode.worker.js`** — a nested **pool of 2–4 workers** doing the *entire*
  per-image pixel pipeline: **native `DecompressionStream` inflate** (decode runs in
  the pool, in parallel — it was the serial bottleneck on the orchestrator thread),
  then the shared `processPixels` (blank → resize → encode) with
  [jsquash](https://github.com/jamsinclair/jSquash) MozJPEG (4:4:4-capable, same
  codec as sharp), Lanczos resize, and [pako](https://github.com/nodeca/pako)
  deflate. The orchestrator only reads the *compressed* stream and writes the
  result. A worker that OOMs on a giant image is respawned while that one image
  keeps its original. Parallelism is **capped and scaled down for large files**
  (down to 2 in-flight images above ~150 MB) so a huge PDF doesn't exhaust memory
  and hang the tab; it isn't a user-facing dial in the web app.

```js
import { optimize } from "pdf-optimizer/browser";
const { bytes, stats } = await optimize(new Uint8Array(await file.arrayBuffer()), { quality: 80 });
```

Architecture: `src/optimize.js` is platform-agnostic, processes images with a
configurable `concurrency`, and takes injected codecs; `src/index.js` wires the
Node codecs (sharp + node:zlib, run inline), `src/browser.js` wires the WASM
codecs (jsquash + pako, dispatched to the worker pool). One engine, two adapters.

> **Dev note:** the wasm codecs fetch their `.wasm` at runtime, and Vite's dev
> server otherwise answers those with `index.html` (the worker then hangs on init).
> `vite.config.js` includes a middleware that serves `.wasm` raw — if you edit the
> config, **fully restart `npm run dev`** (Vite reads it only at startup) and hard-
> reload. The production build is unaffected.

## Notes / limitations

- Targets raster bloat. Font optimization isn't included: Figma embeds text as
  **Type 3 fonts** (glyphs are mini content streams), which are already compact
  and risky to rewrite, so they're left alone.
- Only JPEG (`/DCTDecode`) is used for recompression — PDF has no WebP filter,
  and JPEG2000 viewer support is unreliable. Images are kept lossless when JPEG
  wouldn't be smaller.
- CMYK and Indexed/Separation/Lab images are passed through untouched.
- Off-page blanking is conservative: it only acts on images whose pixel
  dimensions map to a single image and aren't drawn rotated/skewed, and currently
  measures visibility against the page box (not frame clip paths), so it never
  blanks a visible pixel. Clip-aware blanking would recover more.

## License

MIT, see [LICENSE.md](http://github.com/mattdesl/pdf-optimizer/blob/master/LICENSE.md) for details.
