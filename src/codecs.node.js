// Node codec: runs the shared pixel pipeline inline, with sharp (libvips + mozjpeg)
// for JPEG/resize and node:zlib for deflate. mupdf already decoded the samples, so
// there's nothing to inflate here (wantsCompressed:false).
import sharp from "sharp";
import zlib from "node:zlib";
import { processPixels } from "./process-pixels.js";

const impls = {
  async deflate(data) {
    return zlib.deflateSync(Buffer.from(data), { level: 9 });
  },
  async encodeJpeg({ data, width, height, channels, quality, subsampling }) {
    return sharp(Buffer.from(data), { raw: { width, height, channels } })
      .jpeg({ quality, chromaSubsampling: subsampling, mozjpeg: true })
      .toBuffer();
  },
  async resizeRaw({ data, width, height, channels, newWidth, newHeight }) {
    return sharp(Buffer.from(data), { raw: { width, height, channels } })
      .resize(newWidth, newHeight, { kernel: "lanczos3" })
      .raw()
      .toBuffer();
  },
};

export const codecs = {
  wantsCompressed: false,
  async processImage(job) {
    return processPixels(job.samples, job, impls);
  },
};
