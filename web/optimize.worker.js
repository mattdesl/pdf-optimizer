// Orchestrator worker: runs the whole optimize() — mupdf + the engine — off the
// main thread. It uses a DYNAMIC import for the engine so this worker registers
// its message handler immediately (before mupdf's 9.9 MB wasm loads), which both
// keeps it responsive and lets us pinpoint exactly where startup stalls via the
// `log` messages surfaced in the UI.
//
// Two commands: `probe` (cheap pre-flight scan for on-drop stats) and `optimize`
// (the full recompress). Both share the same lazily-loaded engine module.
function log(msg) {
  try { console.log("[optimize.worker]", msg); } catch { /* ignore */ }
  self.postMessage({ type: "log", msg });
}

log("worker module loaded");

let enginePromise = null;
function loadEngine() {
  if (!enginePromise) enginePromise = import("../src/browser.js");
  return enginePromise;
}

self.onmessage = async (e) => {
  const { cmd, bytes, opts } = e.data;
  if (cmd === "probe") return runProbe(bytes);
  return runOptimize(bytes, opts);
};

async function runProbe(bytes) {
  try {
    log("scanning PDF…");
    const { probe } = await loadEngine();
    const result = probe(new Uint8Array(bytes), {
      onAnalyze: ({ page, total }) => self.postMessage({ type: "probe-analyze", page, total }),
    });
    self.postMessage({ type: "probe", result });
  } catch (err) {
    self.postMessage({ type: "probe-error", message: err && err.message });
  }
}

async function runOptimize(bytes, opts) {
  try {
    log("received PDF — loading engine + mupdf wasm…");
    const { optimize } = await loadEngine();
    log("engine ready — opening document…");

    let done = 0;
    const result = await optimize(new Uint8Array(bytes), {
      ...opts,
      onAnalyze: ({ page, total }) => self.postMessage({ type: "analyze", page, total }),
      onStart: ({ totalImages }) => {
        log(`processing ${totalImages} images…`);
        self.postMessage({ type: "start", total: totalImages });
      },
      onImage: (m) => {
        done++;
        self.postMessage({
          type: "progress", done,
          recompressed: !!m.recompressed, oldBytes: m.oldBytes, newBytes: m.newBytes,
          blanked: !!m.blanked, downsampled: !!m.downsampled, newW: m.newW, newH: m.newH,
        });
      },
    });

    log("saving…");
    const out = result.bytes.slice(); // copy out of wasm memory so it can transfer
    self.postMessage({ type: "done", bytes: out.buffer, stats: result.stats }, [out.buffer]);
  } catch (err) {
    log("ERROR: " + (err && err.message));
    self.postMessage({ type: "error", message: err && err.message });
  }
}
