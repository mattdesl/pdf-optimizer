// Node entry point: the shared engine wired with Node codecs (sharp + node:zlib).
import { optimize as engine } from "./optimize.js";
import { codecs } from "./codecs.node.js";

export function optimize(input, opts = {}) {
  return engine(input, { codecs, ...opts });
}

export { compare } from "./verify.js";
export { analyzePages, effectivePPI } from "./placement.js";
export { blankInvisible } from "./blank.js";
