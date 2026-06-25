// Browser entry point: the same engine wired with WASM codecs (jsquash + pako)
// running in a worker pool. `concurrency` defaults to the pool size so the pool
// stays fed; pass `concurrency` in opts to override (e.g. lower it for very large
// files on memory-constrained devices).
import { optimize as engine } from "./optimize.js";
import { codecs, POOL_SIZE } from "./codecs.web.js";

export function optimize(input, opts = {}) {
  return engine(input, { codecs, concurrency: POOL_SIZE, ...opts });
}

export { probe } from "./optimize.js";
export { POOL_SIZE };
export { compare } from "./verify.js";
