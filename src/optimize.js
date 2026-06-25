import * as mupdf from "mupdf";
import { analyzePages, effectivePPI } from "./placement.js";
import { isRotated } from "./blank.js";

// Image work is delegated to an injected codec so the same engine runs under Node
// (pixel pipeline inline, sharp + node:zlib) and in the browser (pipeline dispatched
// to a worker pool: native inflate + jsquash + pako). A codec provides:
//   wantsCompressed: bool — true to receive the raw Flate stream (worker inflates it)
//   processImage(job) -> { recompressed, kind, filter, bytes, downsampled, blanked, newW, newH }
//                        | { recompressed:false } | { skip }

// Run `fn` over `items` with at most `limit` in flight. Order isn't preserved.
async function mapLimit(items, limit, fn) {
  let next = 0;
  const runners = [];
  for (let k = 0; k < Math.min(limit, items.length); k++) {
    runners.push((async () => { while (next < items.length) await fn(items[next++]); })());
  }
  await Promise.all(runners);
}

// Classify an image XObject's colorspace. We only recompress images whose
// samples map directly to N interleaved channels (Gray/RGB/CMYK, incl. ICC and
// Cal variants). Indexed / Separation / DeviceN / Lab / Pattern are left
// untouched — their samples are not pixels and must not be JPEG-encoded.
function classifyColorSpace(doc, obj) {
  let cs = obj.get("ColorSpace");
  if (cs.isIndirect()) cs = cs.resolve();
  if (cs.isName()) {
    const n = cs.asName();
    if (n === "DeviceRGB" || n === "CalRGB") return { channels: 3 };
    if (n === "DeviceGray" || n === "CalGray") return { channels: 1 };
    if (n === "DeviceCMYK") return { channels: 4 };
    return { skip: n };
  }
  if (cs.isArray()) {
    const head = cs.get(0);
    const name = head.isName() ? head.asName() : "?";
    if (name === "ICCBased") {
      const stream = cs.get(1).resolve();
      const nObj = stream.get("N");
      const channels = nObj && nObj.isNumber() ? nObj.asNumber() : 0;
      if (channels === 1 || channels === 3 || channels === 4) return { channels };
      return { skip: `ICCBased/N=${channels}` };
    }
    if (name === "CalRGB") return { channels: 3 };
    if (name === "CalGray") return { channels: 1 };
    return { skip: name }; // Indexed, Separation, DeviceN, Lab, Pattern, ...
  }
  return { skip: "unknown" };
}

// Map each page index to the set of image-XObject xrefs it draws, following
// nested Form XObjects. Used only for the per-page report.
function collectPageImageXrefs(doc) {
  const map = new Map();
  for (let p = 0; p < doc.countPages(); p++) {
    const set = new Set();
    walkXObjects(doc.findPage(p).get("Resources"), set, new Set());
    map.set(p, set);
  }
  return map;
}

function walkXObjects(resources, set, visitedForms) {
  if (!resources || !resources.isDictionary()) return;
  const xobjects = resources.get("XObject");
  if (!xobjects.isDictionary()) return;
  xobjects.forEach((val) => {
    const ref = val.isIndirect() ? val.asIndirect() : null;
    const o = val.resolve();
    const st = o.get("Subtype");
    if (!st.isName()) return;
    if (st.asName() === "Image") {
      if (ref != null) set.add(ref);
    } else if (st.asName() === "Form") {
      if (ref != null) {
        if (visitedForms.has(ref)) return;
        visitedForms.add(ref);
      }
      walkXObjects(o.get("Resources"), set, visitedForms);
    }
  });
}

/**
 * Optimize a PDF by recompressing its raster images in place. Everything else
 * — vectors, text, soft masks, colorspaces, structure — is preserved.
 *
 * @param {Uint8Array} input  raw PDF bytes
 * @param {object} opts
 * @param {object} opts.codecs              { encodeJpeg, resizeRaw, deflate } (injected per platform)
 * @param {number} [opts.quality=80]        JPEG quality (1-100)
 * @param {string} [opts.subsampling="4:4:4"] chroma subsampling ("4:4:4" keeps full color)
 * @param {number} [opts.dpi]               target effective PPI; images displayed above this are downsampled
 * @param {number} [opts.minRatio=1.0]      only replace an image if new/old size <= minRatio
 * @param {number} [opts.minBytes=4096]     leave images smaller than this untouched
 * @param {number} [opts.vectorBpp=0.2]     images below this Flate bytes/pixel are treated as
 *                                          flat/vector-like and kept lossless (never JPEG'd)
 * @param {boolean} [opts.blankOffPage=true] flatten pixels that are never visible (drawn off the
 *                                          page) so they compress away; no content/CTM edits
 * @param {(m:object)=>void} [opts.onImage] per-image progress callback
 * @returns {{bytes: Uint8Array, stats: object}}
 */
export async function optimize(input, opts = {}) {
  const codecs = opts.codecs;
  if (!codecs) throw new Error("optimize() requires opts.codecs — use the Node (index.js) or browser (browser.js) entry point");
  const quality = opts.quality ?? 80;
  const subsampling = opts.subsampling ?? "4:4:4";
  const targetDPI = opts.dpi ?? null;
  const minRatio = opts.minRatio ?? 1.0;
  const minBytes = opts.minBytes ?? 4096;
  const vectorBpp = opts.vectorBpp ?? 0.2;
  const blankOffPage = opts.blankOffPage ?? true;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const onImage = opts.onImage ?? (() => {});
  const onStart = opts.onStart ?? (() => {});       // ({ totalImages }) — for progress bars
  const onAnalyze = opts.onAnalyze ?? (() => {});   // ({ page, total }) — analyze progress

  const doc = mupdf.PDFDocument.openDocument(input, "application/pdf");

  // One page walk feeds both --dpi (display sizes) and off-page blanking
  // (placements). Skipped entirely when neither is requested.
  let displaySizes = null, dimsToPlacements = null, rotatedDims = null, dimsToXrefs = null;
  if (targetDPI || blankOffPage) {
    ({ displaySizes, dimsToPlacements, rotatedDims } = analyzePages(doc, {
      onPage: (page, total) => onAnalyze({ page, total }),
    }));
  }

  // Find xrefs used as SMasks so we can leave alpha channels alone.
  const n = doc.countObjects();
  const smaskRefs = new Set();
  for (let i = 1; i < n; i++) {
    const o = doc.newIndirect(i);
    if (!o.isStream()) continue;
    const sm = o.get("SMask");
    if (sm.isIndirect()) smaskRefs.add(sm.asIndirect());
  }

  // For off-page blanking: which base-image xrefs share each pixel dimension. We
  // only blank when a dimension maps to a single image (placements unambiguous).
  if (blankOffPage) {
    dimsToXrefs = new Map();
    for (let i = 1; i < n; i++) {
      const o = doc.newIndirect(i);
      if (!o.isStream()) continue;
      const st = o.get("Subtype");
      if (!st.isName() || st.asName() !== "Image" || smaskRefs.has(i)) continue;
      const key = `${o.get("Width").asNumber()}x${o.get("Height").asNumber()}`;
      let s = dimsToXrefs.get(key);
      if (!s) dimsToXrefs.set(key, (s = new Set()));
      s.add(i);
    }
  }

  const stats = {
    images: 0, recompressed: 0, jpeg: 0, lossless: 0, downsampled: 0, blanked: 0,
    keptOriginal: 0, skipped: 0, bytesBefore: 0, bytesAfter: 0, skips: {}, pages: [],
  };
  const outcome = new Map(); // base-image xref -> { changed, kind, blanked, downsampled }

  // The base images to process. Heavy per-image work (resize/encode/deflate) runs
  // through the injected codecs, which on the browser dispatch to a worker pool;
  // `concurrency` keeps that pool fed. mupdf calls stay implicitly serialized —
  // they're synchronous, so they never interleave across the await points below.
  const baseXrefs = [];
  for (let i = 1; i < n; i++) {
    const o = doc.newIndirect(i);
    if (!o.isStream()) continue;
    const st = o.get("Subtype");
    if (!st.isName() || st.asName() !== "Image" || smaskRefs.has(i)) continue;
    baseXrefs.push(i);
  }
  onStart({ totalImages: baseXrefs.length }); // known upfront, no extra walk

  await mapLimit(baseXrefs, concurrency, async (i) => {
    const o = doc.newIndirect(i);
    stats.images++;
    let oldBytes = 0;
    try { oldBytes = o.readRawStream().length; } catch { /* ignore */ }
    stats.bytesBefore += oldBytes;

    const width = o.get("Width").asNumber();
    const height = o.get("Height").asNumber();
    const bpcObj = o.get("BitsPerComponent");
    const bpc = bpcObj.isNumber() ? bpcObj.asNumber() : 0;

    // Placements to use for off-page blanking — only when this dimension maps to
    // exactly one image and isn't drawn rotated/skewed (else leave fully intact).
    let placements = null;
    if (blankOffPage) {
      const key = `${width}x${height}`;
      if (!rotatedDims.has(key) && dimsToXrefs.get(key)?.size === 1) {
        placements = dimsToPlacements.get(key) || null;
      }
    }

    const result = await processImage(doc, o, {
      width, height, bpc, oldBytes, quality, subsampling, codecs,
      targetDPI, displaySizes, minRatio, minBytes, vectorBpp, placements,
    });

    if (result.recompressed) {
      stats.recompressed++;
      if (result.kind === "jpeg") stats.jpeg++; else if (result.kind === "lossless") stats.lossless++;
      if (result.downsampled) stats.downsampled++;
      if (result.blanked) stats.blanked++;
      stats.bytesAfter += result.newBytes;
    } else if (result.skip) {
      stats.skipped++;
      stats.skips[result.skip] = (stats.skips[result.skip] || 0) + 1;
      stats.bytesAfter += oldBytes;
    } else {
      stats.keptOriginal++;
      stats.bytesAfter += oldBytes;
    }
    outcome.set(i, {
      changed: !!result.recompressed, kind: result.kind,
      blanked: !!result.blanked, downsampled: !!result.downsampled,
    });
    onImage({ xref: i, width, height, oldBytes, ...result });
  });

  // Per-page breakdown: map each page to the base images it draws (through nested
  // Form XObjects) and tally their outcomes. Done before save, while xrefs are
  // still in their original numbering.
  const pageXrefs = collectPageImageXrefs(doc);
  for (let p = 0; p < doc.countPages(); p++) {
    const row = { page: p, total: 0, changed: 0, jpeg: 0, lossless: 0, blanked: 0, downsampled: 0 };
    for (const x of pageXrefs.get(p) || []) {
      const o = outcome.get(x);
      if (!o) continue; // not a base image we processed (e.g. an alpha mask)
      row.total++;
      if (!o.changed) continue;
      row.changed++;
      if (o.kind === "jpeg") row.jpeg++; else if (o.kind === "lossless") row.lossless++;
      if (o.blanked) row.blanked++;
      if (o.downsampled) row.downsampled++;
    }
    stats.pages.push(row);
  }

  const out = doc.saveToBuffer("garbage=compact,compress-images=no,compress-fonts=yes");
  return { bytes: out.asUint8Array(), stats };
}

async function processImage(doc, o, ctx) {
  const { width, height, bpc, oldBytes, quality, subsampling, codecs,
    targetDPI, displaySizes, minRatio, minBytes, vectorBpp, placements } = ctx;

  if (bpc !== 8) return { skip: `bpc=${bpc}` };

  const cls = classifyColorSpace(doc, o);
  if (cls.skip) return { skip: cls.skip };
  const channels = cls.channels;
  if (channels === 4) return { skip: "cmyk" }; // CMYK raw isn't representable here; keep lossless

  // Placement-aware downsample decision (needs the analyze walk; stays here on the
  // mupdf side). The actual resize happens in the pixel pipeline.
  let downsampleTo = null;
  if (targetDPI && displaySizes) {
    const disp = displaySizes.get(`${width}x${height}`);
    if (disp) {
      const ppi = effectivePPI(width, height, disp.ptW, disp.ptH);
      if (ppi > targetDPI) {
        const scale = targetDPI / ppi;
        downsampleTo = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
      }
    }
  }

  // Tiny images aren't worth re-encoding (avoids churn/artifacts on small assets).
  if (!downsampleTo && oldBytes < minBytes) return { skip: "tiny" };

  // Read the image stream and hand the pixel work to the codec. The browser codec
  // wants the *compressed* bytes (it inflates natively in the worker, in parallel);
  // the Node codec wants decoded samples. Copy out of mupdf's wasm memory before
  // any await (concurrency safety + transfer to a worker).
  const job = { width, height, channels, oldBytes, quality, subsampling, downsampleTo, placements, vectorBpp, minRatio };
  if (codecs.wantsCompressed && isSimpleFlate(o)) {
    try { job.compressed = Uint8Array.from(o.readRawStream().asUint8Array()); } catch { return { skip: "decode-fail" }; }
  } else {
    try { job.samples = Uint8Array.from(o.readStream().asUint8Array()); } catch { return { skip: "decode-fail" }; }
  }

  const r = await codecs.processImage(job);
  if (r.skip) return { skip: r.skip };
  if (!r.recompressed) return { recompressed: false, newBytes: oldBytes };

  o.put("Filter", doc.newName(r.filter));
  o.delete("DecodeParms");
  if (r.downsampled) { o.put("Width", r.newW); o.put("Height", r.newH); }
  o.writeRawStream(r.bytes);
  return { recompressed: true, kind: r.kind, downsampled: r.downsampled, blanked: r.blanked, newBytes: r.bytes.length, newW: r.newW, newH: r.newH };
}

// True when an image stream is plain zlib Flate with no predictor — the case the
// browser worker can inflate natively. Anything else falls back to mupdf decoding.
function isSimpleFlate(o) {
  const f = o.get("Filter");
  let name = null;
  if (f.isName()) name = f.asName();
  else if (f.isArray() && f.length === 1 && f.get(0).isName()) name = f.get(0).asName();
  if (name !== "FlateDecode") return false;
  return o.get("DecodeParms").isNull();
}

/**
 * Cheap pre-flight scan: open the PDF and gather per-image metadata WITHOUT
 * decoding pixels or encoding anything. Used by the web UI to show stats the
 * moment a file is dropped, and to drive a (rough) size projection that reacts to
 * the options live. The same page-analysis as optimize() feeds DPI/crop awareness.
 *
 * @returns {{ fileBytes, pageCount, imageBytes, images: Array<{
 *   w, h, pixels, channels, bpc, oldBytes, bpp, kind: "photo"|"flat"|"skip",
 *   skip: string|null, ppi: number|null, visibleFraction: number }> }}
 */
export function probe(input, opts = {}) {
  const vectorBpp = opts.vectorBpp ?? 0.2;
  const onAnalyze = opts.onAnalyze ?? (() => {});

  const doc = mupdf.PDFDocument.openDocument(input, "application/pdf");
  const pageCount = doc.countPages();
  const { displaySizes, dimsToPlacements, rotatedDims } = analyzePages(doc, {
    onPage: (page, total) => onAnalyze({ page, total }),
  });

  const n = doc.countObjects();

  // SMask (alpha) xrefs — never counted as base images, same as optimize().
  const smaskRefs = new Set();
  for (let i = 1; i < n; i++) {
    const o = doc.newIndirect(i);
    if (!o.isStream()) continue;
    const sm = o.get("SMask");
    if (sm.isIndirect()) smaskRefs.add(sm.asIndirect());
  }

  // Which base-image xrefs share each pixel dimension (blanking only fires when a
  // dimension maps to exactly one image — mirrors optimize()).
  const dimsToXrefs = new Map();
  for (let i = 1; i < n; i++) {
    const o = doc.newIndirect(i);
    if (!o.isStream()) continue;
    const st = o.get("Subtype");
    if (!st.isName() || st.asName() !== "Image" || smaskRefs.has(i)) continue;
    const key = `${o.get("Width").asNumber()}x${o.get("Height").asNumber()}`;
    let s = dimsToXrefs.get(key);
    if (!s) dimsToXrefs.set(key, (s = new Set()));
    s.add(i);
  }

  const images = [];
  let imageBytes = 0;
  for (let i = 1; i < n; i++) {
    const o = doc.newIndirect(i);
    if (!o.isStream()) continue;
    const st = o.get("Subtype");
    if (!st.isName() || st.asName() !== "Image" || smaskRefs.has(i)) continue;

    const w = o.get("Width").asNumber();
    const h = o.get("Height").asNumber();
    const pixels = Math.max(1, w * h);
    const bpcObj = o.get("BitsPerComponent");
    const bpc = bpcObj.isNumber() ? bpcObj.asNumber() : 0;
    let oldBytes = 0;
    try { oldBytes = o.readRawStream().length; } catch { /* ignore */ }
    imageBytes += oldBytes;

    // Same gates as processImage(): non-8-bit, CMYK and Indexed/Separation/Lab/etc.
    // are passed through untouched.
    let kind = "skip", skip = null, channels = 0;
    if (bpc !== 8) {
      skip = `bpc=${bpc}`;
    } else {
      const cls = classifyColorSpace(doc, o);
      if (cls.skip) skip = cls.skip;
      else if (cls.channels === 4) skip = "cmyk";
      else { channels = cls.channels; kind = oldBytes / pixels < vectorBpp ? "flat" : "photo"; }
    }

    const key = `${w}x${h}`;
    const disp = displaySizes.get(key);
    const ppi = disp ? effectivePPI(w, h, disp.ptW, disp.ptH) : null;

    let visibleFraction = 1;
    if (!rotatedDims.has(key) && dimsToXrefs.get(key)?.size === 1) {
      const pls = dimsToPlacements.get(key);
      if (pls && pls.length) visibleFraction = visibleFractionOf(w, h, pls);
    }

    images.push({ w, h, pixels, channels, bpc, oldBytes, bpp: oldBytes / pixels, kind, skip, ppi, visibleFraction });
  }

  // Stats are plain JS (no wasm-backed views), so release the parsed document now
  // — frees the input's footprint before the caller re-opens it for optimize().
  const result = { fileBytes: input.length, pageCount, imageBytes, images };
  try { doc.destroy(); } catch { /* older mupdf builds may lack destroy() */ }
  return result;
}

// Fraction of an image's pixels that are ever visible (drawn on-page), using the
// same rectangle geometry as blank.js but rasterized onto a coarse grid — exact
// pixels aren't needed for a fraction. Rotated/degenerate placements are treated
// as fully visible (the engine leaves those images intact).
function visibleFractionOf(W, H, placements) {
  const GW = Math.min(W, 256), GH = Math.min(H, 256);
  const cell = new Uint8Array(GW * GH);
  for (const pl of placements) {
    const m = pl.ctm;
    if (isRotated(m)) return 1;
    const a = m[0], d = m[3], e = m[4], f = m[5];
    if (a === 0 || d === 0) return 1;
    const pg = pl.page;
    let ul = (pg.x0 - e) / a, ur = (pg.x1 - e) / a; if (ul > ur) { const t = ul; ul = ur; ur = t; }
    let vl = (pg.y0 - f) / d, vr = (pg.y1 - f) / d; if (vl > vr) { const t = vl; vl = vr; vr = t; }
    ul = Math.max(0, ul); ur = Math.min(1, ur); vl = Math.max(0, vl); vr = Math.min(1, vr);
    if (ur <= ul || vr <= vl) continue;
    const c0 = Math.floor(ul * GW), c1 = Math.ceil(ur * GW);
    const r0 = Math.floor(vl * GH), r1 = Math.ceil(vr * GH);
    for (let r = r0; r < r1; r++) cell.fill(1, r * GW + c0, r * GW + c1);
  }
  let vis = 0;
  for (let i = 0; i < cell.length; i++) if (cell[i]) vis++;
  return vis / cell.length;
}
