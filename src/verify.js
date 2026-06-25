import * as mupdf from "mupdf";

// Render every page of `a` and `b` at the given scale and report per-page
// mean/max absolute pixel difference per channel (0-255). This is the proof
// that recompression didn't break a shape, mask, or shift color — small mean
// diffs are expected JPEG quantization; large diffs flag a problem.
export function compare(aBytes, bBytes, { scale = 0.25 } = {}) {
  const a = mupdf.PDFDocument.openDocument(aBytes, "application/pdf");
  const b = mupdf.PDFDocument.openDocument(bBytes, "application/pdf");
  const pages = Math.min(a.countPages(), b.countPages());
  const results = [];
  for (let p = 0; p < pages; p++) {
    const ra = render(a, p, scale);
    const rb = render(b, p, scale);
    if (ra.w !== rb.w || ra.h !== rb.h || ra.buf.length !== rb.buf.length) {
      results.push({ page: p, mismatch: `${ra.w}x${ra.h} vs ${rb.w}x${rb.h}` });
      continue;
    }
    let sum = 0, max = 0;
    for (let i = 0; i < ra.buf.length; i++) {
      const d = Math.abs(ra.buf[i] - rb.buf[i]);
      sum += d;
      if (d > max) max = d;
    }
    results.push({ page: p, w: ra.w, h: ra.h, mean: sum / ra.buf.length, max });
  }
  return results;
}

function render(doc, p, scale) {
  const page = doc.loadPage(p);
  const pix = page.toPixmap([scale, 0, 0, scale, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
  const px = pix.getPixels();
  const buf = typeof px.asUint8Array === "function" ? px.asUint8Array() : px;
  return { buf, w: pix.getWidth(), h: pix.getHeight() };
}
