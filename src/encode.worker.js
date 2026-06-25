// Image worker: inflates the image's Flate stream natively (DecompressionStream —
// faster than wasm and parallel across the pool), then runs the shared pixel
// pipeline (blank → resize → encode) with jsquash MozJPEG + pako. Doing the decode
// here is the win: it was the serial bottleneck on the orchestrator thread.
import { processPixels } from "./process-pixels.js";
import { encode as jpegEncode } from "@jsquash/jpeg";
import resize from "@jsquash/resize";
import pako from "pako";

// interleaved N-channel <-> RGBA ImageData (what jsquash speaks)
function toImageData(u8, width, height, channels) {
  const n = width * height;
  const rgba = new Uint8ClampedArray(n * 4);
  if (channels === 4) {
    rgba.set(u8);
  } else if (channels === 3) {
    for (let i = 0, j = 0; i < n; i++) { rgba[j++] = u8[i * 3]; rgba[j++] = u8[i * 3 + 1]; rgba[j++] = u8[i * 3 + 2]; rgba[j++] = 255; }
  } else {
    for (let i = 0; i < n; i++) { const v = u8[i]; rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; }
  }
  return { data: rgba, width, height };
}
function fromImageData({ data, width, height }, channels) {
  const n = width * height;
  const out = new Uint8Array(n * channels);
  if (channels === 4) out.set(data);
  else if (channels === 3) { for (let i = 0, j = 0; i < n; i++) { out[j++] = data[i * 4]; out[j++] = data[i * 4 + 1]; out[j++] = data[i * 4 + 2]; } }
  else { for (let i = 0; i < n; i++) out[i] = data[i * 4]; }
  return out;
}

const JCS_GRAYSCALE = 1, JCS_YCbCr = 3;

const impls = {
  async deflate(data) {
    return pako.deflate(data, { level: 9 });
  },
  async encodeJpeg({ data, width, height, channels, quality, subsampling }) {
    const buf = await jpegEncode(toImageData(data, width, height, channels), {
      quality,
      auto_subsample: false,
      chroma_subsample: subsampling === "4:4:4" ? 1 : 2, // 1 = 4:4:4, 2 = 4:2:0
      color_space: channels === 1 ? JCS_GRAYSCALE : JCS_YCbCr,
    });
    return new Uint8Array(buf);
  },
  async resizeRaw({ data, width, height, channels, newWidth, newHeight }) {
    const out = await resize(toImageData(data, width, height, channels), { width: newWidth, height: newHeight });
    return fromImageData(out, channels);
  },
};

// Native zlib inflate (PDF FlateDecode = zlib). Falls back to pako for edge cases.
async function inflate(compressed) {
  try {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return pako.inflate(compressed);
  }
}

self.onmessage = async (e) => {
  const { id, job } = e.data;
  try {
    const samples = job.compressed ? await inflate(new Uint8Array(job.compressed)) : new Uint8Array(job.samples);
    const result = await processPixels(samples, job, impls);
    self.postMessage({ id, result }, result.bytes ? [result.bytes.buffer] : []);
  } catch (err) {
    self.postMessage({ id, error: err && err.message });
  }
};
