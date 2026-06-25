import * as mupdf from "mupdf";
import { isRotated } from "./blank.js";

// Single walk over every page that records, per image pixel-dimension ("WxH"):
//   - displaySizes: the largest on-page size in points it's drawn at (for --dpi).
//     When several images share a dimension we keep the largest (downsamples least).
//   - dimsToPlacements: every placement (CTM + page rect) for off-page blanking.
//   - rotatedDims: dimensions drawn rotated/skewed (left fully intact when blanking).
// `onPage(done, total)` is called after each page so a worker can report progress.
// One pass feeds both --dpi and blanking; the device resolves nested Form XObjects
// and gives the composite CTM for free.
export function analyzePages(doc, { onPage } = {}) {
  const displaySizes = new Map();
  const dimsToPlacements = new Map();
  const rotatedDims = new Set();
  const pageCount = doc.countPages();
  for (let p = 0; p < pageCount; p++) {
    const page = doc.loadPage(p);
    const b = page.getBounds(); // [x0, y0, x1, y1]
    const pageRect = { x0: b[0], y0: b[1], x1: b[2], y1: b[3] };
    const record = (image, ctm) => {
      const w = image.getWidth(), h = image.getHeight();
      const key = `${w}x${h}`;

      // largest display size (CTM maps the unit square to page points)
      const ptW = Math.hypot(ctm[0], ctm[1]);
      const ptH = Math.hypot(ctm[2], ctm[3]);
      const cur = displaySizes.get(key);
      if (cur) { cur.ptW = Math.max(cur.ptW, ptW); cur.ptH = Math.max(cur.ptH, ptH); }
      else displaySizes.set(key, { ptW, ptH });

      // placement for blanking
      if (isRotated(ctm)) rotatedDims.add(key);
      let list = dimsToPlacements.get(key);
      if (!list) dimsToPlacements.set(key, (list = []));
      list.push({ ctm: [ctm[0], ctm[1], ctm[2], ctm[3], ctm[4], ctm[5]], page: pageRect });
    };
    const device = new mupdf.Device({
      fillImage(image, ctm) { record(image, ctm); },
      fillImageMask(image, ctm) { record(image, ctm); },
    });
    // Identity matrix so the CTM the device sees is in page points.
    page.run(device, mupdf.Matrix.identity);
    device.close();
    if (onPage) onPage(p + 1, pageCount);
  }
  return { displaySizes, dimsToPlacements, rotatedDims };
}

// Effective pixels-per-inch at which an image of `pxW x pxH` is displayed, given
// its measured on-page size in points. Returns the larger of the two axes' PPI
// (so we never under-estimate resolution and over-downsample).
export function effectivePPI(pxW, pxH, ptW, ptH) {
  const ppiW = ptW > 0 ? (pxW * 72) / ptW : 0;
  const ppiH = ptH > 0 ? (pxH * 72) / ptH : 0;
  return Math.max(ppiW, ppiH);
}
