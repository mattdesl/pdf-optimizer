import * as mupdf from "mupdf";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { optimize } from "./src/index.js";

// Build a tiny PDF by hand containing one RGB image stored exactly the way
// Figma stores them: raw 8-bit RGB samples, FlateDecode, DeviceRGB. This lets
// us test the core recompression path deterministically without a big fixture.
function makeFlateImagePdf(w, h) {
  const doc = new mupdf.PDFDocument();
  const samples = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      samples[i] = (x * 255 / w) | 0;       // smooth gradient -> JPEG wins big
      samples[i + 1] = (y * 255 / h) | 0;
      samples[i + 2] = ((x ^ y) & 255);
    }
  }
  const flate = zlib.deflateSync(samples);

  const dict = doc.newDictionary();
  dict.put("Type", doc.newName("XObject"));
  dict.put("Subtype", doc.newName("Image"));
  dict.put("Width", w);
  dict.put("Height", h);
  dict.put("BitsPerComponent", 8);
  dict.put("ColorSpace", doc.newName("DeviceRGB"));
  dict.put("Filter", doc.newName("FlateDecode"));
  const imgRef = doc.addRawStream(flate, dict);

  const resources = doc.newDictionary();
  const xobjects = doc.newDictionary();
  xobjects.put("Im0", imgRef);
  resources.put("XObject", xobjects);

  const contents = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  const page = doc.addPage([0, 0, w, h], 0, resources, contents);
  doc.insertPage(-1, page);

  // Copy out of WASM memory so the buffer survives later mupdf allocations.
  return Uint8Array.from(doc.saveToBuffer("compress-images=no").asUint8Array());
}

async function run() {
  const w = 512, h = 512;
  const input = makeFlateImagePdf(w, h);

  // 1) basic recompression: smaller, valid, image becomes DCTDecode, RGB kept
  const { bytes, stats } = await optimize(input, { quality: 80 });
  const outLen = bytes.length; // capture before openDocument detaches the buffer
  assert.equal(stats.images, 1, "one image");
  assert.equal(stats.recompressed, 1, "image recompressed");
  assert.ok(outLen < input.length, "output is smaller");

  const out = mupdf.PDFDocument.openDocument(bytes, "application/pdf");
  assert.equal(out.countPages(), 1, "page count preserved");
  let found = null;
  for (let i = 1; i < out.countObjects(); i++) {
    const o = out.newIndirect(i);
    if (o.isStream() && o.get("Subtype").isName() && o.get("Subtype").asName() === "Image") { found = o; break; }
  }
  assert.ok(found, "image survives");
  assert.equal(found.get("Filter").asName(), "DCTDecode", "now JPEG");
  assert.equal(found.get("ColorSpace").asName(), "DeviceRGB", "colorspace preserved");
  assert.equal(found.get("Width").asNumber(), w, "width preserved (no downsample)");

  // 2) placement-aware downsample: page is 512pt wide, image 512px => 72 PPI.
  //    Targeting 36 dpi must halve it; targeting 300 must leave it alone.
  const lo = await optimize(makeFlateImagePdf(w, h), { quality: 80, dpi: 36 });
  assert.equal(lo.stats.downsampled, 1, "downsampled below target dpi");
  const hi = await optimize(makeFlateImagePdf(w, h), { quality: 80, dpi: 300 });
  assert.equal(hi.stats.downsampled, 0, "not downsampled when under target dpi");

  // 3) off-page blanking: a 100x100 image (red top half, blue bottom half) drawn
  //    1:1 onto a 100x50 page shows only half of itself; the rest is off-page.
  //    Blanking must flatten only the off-page half. The robust invariant: the
  //    optimized render equals the original render. A row-orientation bug would
  //    blank the visible half and flip this.
  const orig = renderFirstPage(makeHalfOffPagePdf());
  const bb = await optimize(makeHalfOffPagePdf(), { quality: 90, minBytes: 0 });
  assert.equal(bb.stats.blanked, 1, "off-page image was blanked");
  const opt = renderFirstPage(bb.bytes);
  let maxDiff = 0;
  for (let i = 0; i < orig.length; i++) maxDiff = Math.max(maxDiff, Math.abs(orig[i] - opt[i]));
  assert.ok(maxDiff < 8, `blanking left the visible area unchanged (max channel diff ${maxDiff})`);

  console.log("ok — all tests passed");
  console.log(`   recompress: ${input.length} -> ${outLen} bytes (${(100*outLen/input.length).toFixed(0)}%)`);
}

function renderFirstPage(bytes) {
  const doc = mupdf.PDFDocument.openDocument(bytes, "application/pdf");
  const pix = doc.loadPage(0).toPixmap([1, 0, 0, 1, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true);
  const px = pix.getPixels();
  const buf = typeof px.asUint8Array === "function" ? px.asUint8Array() : px;
  return Uint8Array.from(buf);
}

// 100x100 image, red top half / blue bottom half, drawn 1:1 onto a 100x50 page so
// only half of the image is on-page.
function makeHalfOffPagePdf() {
  const doc = new mupdf.PDFDocument();
  const W = 100, H = 100;
  const s = Buffer.alloc(W * H * 3);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = (r * W + c) * 3;
      if (r < H / 2) { s[i] = 255; } else { s[i + 2] = 255; }
    }
  }
  const dict = doc.newDictionary();
  dict.put("Type", doc.newName("XObject"));
  dict.put("Subtype", doc.newName("Image"));
  dict.put("Width", W); dict.put("Height", H); dict.put("BitsPerComponent", 8);
  dict.put("ColorSpace", doc.newName("DeviceRGB"));
  dict.put("Filter", doc.newName("FlateDecode"));
  const imgRef = doc.addRawStream(zlib.deflateSync(s), dict);
  const resources = doc.newDictionary();
  const xobjects = doc.newDictionary();
  xobjects.put("Im0", imgRef);
  resources.put("XObject", xobjects);
  const page = doc.addPage([0, 0, 100, 50], 0, resources, `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`);
  doc.insertPage(-1, page);
  return Uint8Array.from(doc.saveToBuffer("compress-images=no").asUint8Array());
}

run().catch((e) => { console.error("FAIL:", e); process.exit(1); });
