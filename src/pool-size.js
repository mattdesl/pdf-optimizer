// Default encode-worker-pool size, in its own dependency-free module so the UI
// can read it without pulling in mupdf/the engine. Capped low: each busy worker
// holds a full decoded image (raw RGB), so more workers means higher peak memory
// — on hundreds-of-MB PDFs that's what hangs the tab. The orchestrator's
// concurrency (see main.js) never exceeds this, so a higher cap would only spawn
// idle workers.
export const POOL_SIZE = Math.max(
  2,
  Math.min(4, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4),
);
