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

// Page analysis from the most recent probe, kept here so an optimize for the same
// file can reuse it instead of walking the pages again. Keyed by a per-file id.
let cachedAnalysis = null; // { fileId, analysis }

// Serialize jobs through a promise chain. onmessage is async, so without this a
// later `optimize` could start (and read cachedAnalysis) while an earlier `probe`
// is still mid-await and hasn't cached its analysis yet — a race. Chaining makes
// each job await the previous one to completion.
let jobChain = Promise.resolve();
self.onmessage = (e) => {
  const data = e.data;
  jobChain = jobChain
    .then(() => (data.cmd === "probe" ? runProbe(data) : runOptimize(data)))
    .catch(() => {}); // a job's own try/catch reports errors; never break the chain
};

async function runProbe({ bytes, fileId }) {
  try {
    log("scanning PDF…");
    const { probe } = await loadEngine();
    const result = probe(new Uint8Array(bytes), {
      onAnalyze: ({ page, total }) => self.postMessage({ type: "probe-analyze", page, total }),
    });
    // Keep the page walk here for reuse; ship only the stats to the main thread.
    const { analysis, ...stats } = result;
    cachedAnalysis = { fileId, analysis };
    self.postMessage({ type: "probe", result: stats });
  } catch (err) {
    self.postMessage({ type: "probe-error", message: err && err.message });
  }
}

async function runOptimize({ bytes, opts, fileId }) {
  try {
    log("received PDF — loading engine + mupdf wasm…");
    const { optimize } = await loadEngine();
    // Reuse the scan's page walk when it's for this same file.
    const analysis = cachedAnalysis && cachedAnalysis.fileId === fileId ? cachedAnalysis.analysis : undefined;
    log(analysis ? "engine ready — reusing scan analysis…" : "engine ready — opening document…");

    let done = 0;
    const result = await optimize(new Uint8Array(bytes), {
      ...opts,
      analysis,
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
