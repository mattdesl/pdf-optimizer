import { blankInvisible } from "./blank.js";

const DCT = "DCTDecode";
const FLATE = "FlateDecode";

// Shared per-image pixel pipeline: blank never-visible pixels, optionally
// downsample, then route to JPEG (photographic) or lossless Flate (flat/vector).
// Runs inline under Node and inside the encode worker in the browser — same code,
// same decisions, so both platforms produce matching output.
//
// `samples` — decoded interleaved 8-bit samples (mutated in place by blanking).
// `params`  — { width, height, channels, oldBytes, quality, subsampling,
//               downsampleTo: {width,height}|null, placements, vectorBpp, minRatio }
// `codecs`  — { encodeJpeg, resizeRaw, deflate }
//
// Returns { recompressed:true, kind, filter, bytes, downsampled, blanked, newW, newH }
//      or { recompressed:false } (keep original) or { skip:<reason> }.
export async function processPixels(samples, params, codecs) {
  const { width, height, channels, oldBytes, quality, subsampling,
    downsampleTo, placements, vectorBpp, minRatio } = params;

  if (samples.length !== width * height * channels) return { skip: "sample-mismatch" };

  // Flatten never-visible (off-page) pixels before encoding so they compress away.
  let blanked = false;
  if (placements && placements.length) {
    if (blankInvisible(samples, width, height, channels, placements)) blanked = true;
  }

  let w = width, h = height, downsampled = false;
  if (downsampleTo) {
    w = downsampleTo.width; h = downsampleTo.height; downsampled = true;
    try { samples = await codecs.resizeRaw({ data: samples, width, height, channels, newWidth: w, newHeight: h }); }
    catch { return { skip: "resize-fail" }; }
  }

  // Route by how compressible the source already is (Figma stores everything as
  // Flate; flat/vector art compresses hard, photos barely).
  const bpp = oldBytes / (width * height);
  const threshold = oldBytes * Math.min(minRatio, 1);

  if (bpp < vectorBpp) {
    let flate;
    try { flate = await codecs.deflate(samples); } catch { return { skip: "deflate-fail" }; }
    if (!downsampled && flate.length >= threshold) return { recompressed: false };
    return { recompressed: true, kind: "lossless", filter: FLATE, bytes: flate, downsampled, blanked, newW: w, newH: h };
  }

  let jpeg;
  try { jpeg = await codecs.encodeJpeg({ data: samples, width: w, height: h, channels, quality, subsampling }); }
  catch { return { skip: "encode-fail" }; }
  if (!downsampled && jpeg.length >= threshold) return { recompressed: false };
  return { recompressed: true, kind: "jpeg", filter: DCT, bytes: jpeg, downsampled, blanked, newW: w, newH: h };
}
