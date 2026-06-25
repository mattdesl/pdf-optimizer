import "hack-font/build/web/hack.css";

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const tick = (s) => `<span class="tick">${s}</span>`; // accented inline figure

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + " KB";
  return n + " B";
}

function escapeHtml(s) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const fullyVisible = (el) => {
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight;
};
const intersectsViewport = (el) => {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight;
};
// Scroll `el` to sit `offset`px below the viewport top (so its label isn't pinned
// tight to the edge), respecting reduced-motion.
function scrollToward(el, offset = 40) {
  const top = Math.max(0, el.getBoundingClientRect().top + window.scrollY - offset);
  window.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
}

// Element refs used in more than one place.
const go = $("go");
const quality = $("quality");
const drop = $("drop");
const fileInput = $("file");
const statusEl = $("status");
const statEstimate = $("statEstimate");

const setStatus = (html) => { statusEl.innerHTML = html; };

// The dropped File. Bytes are read fresh per probe/run via File.arrayBuffer() and
// transferred to the worker, so the main thread never holds — or synchronously
// copies — the whole multi-hundred-MB PDF (that copy was the worst UI jank).
let currentFile = null;
let currentFileId = 0; // bumped per dropped file; lets the worker match a cached scan
let pdfName = "document.pdf";

// Read every size-affecting control once. run() maps `crop` onto the engine's
// option name; renderEstimate() uses these as-is.
function readControls() {
  const dpi = Number($("dpi").value);
  return {
    quality: Number(quality.value),
    dpi: dpi > 0 ? dpi : null,
    subsampling: $("subsampling").value,
    crop: $("blank").checked,
  };
}

/* ------------------------------------------------------------------ *
 * Worker — the whole optimize (mupdf + engine + encode pool) runs here so the
 * main thread stays pure UI. Created lazily and reused across runs. Parallelism
 * is left to the engine default (the encode-pool size, 2–4; see pool-size.js) —
 * enough to keep the pool busy without ballooning memory on a huge PDF.
 * ------------------------------------------------------------------ */

let orchestrator = null;
function getOrchestrator() {
  if (!orchestrator) orchestrator = new Worker(new URL("./optimize.worker.js", import.meta.url), { type: "module" });
  return orchestrator;
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

// Quality slider mirrors its value into the readout; every size-affecting control
// re-runs the (cheap, local) projection.
quality.addEventListener("input", () => { $("qualityVal").textContent = quality.value; renderEstimate(); });
$("dpi").addEventListener("input", renderEstimate);
$("subsampling").addEventListener("change", renderEstimate);
$("blank").addEventListener("change", renderEstimate);

// DPI preset buttons populate the number box.
document.querySelectorAll(".presets [data-dpi]").forEach((btn) =>
  btn.addEventListener("click", () => { $("dpi").value = btn.dataset.dpi; renderEstimate(); }));

/* ------------------------------------------------------------------ *
 * File selection (click + drag/drop)
 * ------------------------------------------------------------------ */

// Swap the drop box's contents, keeping the hidden file input alive so
// click-to-choose keeps working after an innerHTML replace.
function setDrop(html, loaded = false) {
  drop.classList.toggle("loaded", loaded);
  drop.innerHTML = html;
  drop.appendChild(fileInput);
}

drop.addEventListener("click", () => fileInput.click());
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener("change", (e) => setFile(e.target.files[0]));

// The whole window is a drop target: a PDF dropped anywhere loads it, even if it
// misses the box — and we preventDefault everywhere so a stray drop can never
// navigate the page away (which would lose the loaded file). A full-screen
// overlay appears while dragging to signal "drop anywhere".
let dragDepth = 0;
const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");

window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add("dragging");
});
window.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", () => {
  if (!document.body.classList.contains("dragging")) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove("dragging");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  setFile(e.dataTransfer?.files?.[0]);
});

function setFile(file) {
  if (!file) return;
  if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name || "")) {
    // Ignore non-PDF drops; only surface the error when nothing is loaded yet, so
    // a stray drop never clobbers a file you already have.
    if (!currentFile) setDrop(
      `<span class="big">Drop a PDF here</span>` +
      `<span class="sub"><span class="err">“${escapeHtml(file.name || "that file")}” isn’t a PDF</span></span>`
    );
    return;
  }
  currentFile = file;
  currentFileId++;
  pdfName = file.name || "document.pdf";
  // file.size is known without reading — no need to slurp the whole PDF here.
  setDrop(
    `<span class="big file-name">${escapeHtml(pdfName)}</span>` +
    `<span class="file-meta">${fmt(file.size)} · click to replace</span>`,
    true,
  );
  go.disabled = false;
  $("progress").hidden = true;
  $("results").hidden = true;
  probeFile();
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

let running = false;
let cancelRun = null; // set to a cancel fn while a run is in flight

// One button, two jobs: start a run, or cancel the one in progress.
go.addEventListener("click", () => {
  if (running) cancelRun?.();
  else run();
});

// Toggle the primary button between Optimize and its red Cancel state.
function setCancelMode(on) {
  go.textContent = on ? "Cancel" : "Optimize";
  go.classList.toggle("cancel", on);
}

async function run() {
  if (!currentFile || running) return;
  running = true;
  setCancelMode(true);
  $("results").hidden = true;

  const c = readControls();
  const opts = {
    quality: c.quality,
    dpi: c.dpi,
    subsampling: c.subsampling,
    blankOffPage: c.crop,
  };

  const before = currentFile.size;
  const fileId = currentFileId; // bind to the bytes we're about to read
  const t0 = performance.now();

  const bar = $("bar");
  const fill = $("barFill");
  $("progress").hidden = false;
  fill.style.width = ""; // let the .indeterminate rule drive width (clears a prior run's 100%)
  bar.classList.add("indeterminate");
  setStatus("Analyzing document…");

  // Bring the working section into view, but only if the progress bar isn't
  // already fully on screen (don't yank the page when it's visible).
  if (!fullyVisible(bar)) scrollToward($("progress"));

  // Cancel = terminate the orchestrator worker. That instantly stops mupdf and the
  // whole encode pool (its child workers die with it) and frees their memory; the
  // next run lazily spins up a fresh worker. settle() unwinds run() so the UI resets.
  let cancelled = false;
  let settle = () => {};
  cancelRun = () => {
    cancelled = true;
    if (orchestrator) { orchestrator.terminate(); orchestrator = null; }
    settle();
  };

  try {
    const buf = await currentFile.arrayBuffer(); // off-main-thread read; no sync memcpy
    if (cancelled) return; // cancelled during the read

    await new Promise((resolve) => {
      settle = resolve;
      const worker = getOrchestrator();
      const fail = (msg) => { setStatus("⚠ " + msg); bar.classList.remove("indeterminate"); resolve(); };
      worker.onerror = (e) => fail("worker error: " + (e.message || "failed to load (check the console)"));
      worker.onmessageerror = () => fail("worker message error");

      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === "log") {
          setStatus(m.msg);
        } else if (m.type === "analyze") {
          setStatus(`Analyzing pages… ${tick(`${m.page} / ${m.total}`)}`);
        } else if (m.type === "start") {
          bar.classList.remove("indeterminate");
          bar.dataset.total = m.total || 1;
          fill.style.width = "0%";
          setStatus(`${tick(`0 / ${m.total}`)} images`);
        } else if (m.type === "progress") {
          const total = Number(bar.dataset.total) || 1;
          fill.style.width = (100 * m.done) / total + "%";
          const tag = m.recompressed
            ? ` — ${fmt(m.oldBytes)} → ${fmt(m.newBytes)}${m.blanked ? " (cropped)" : ""}${m.downsampled ? ` (↓${m.newW}×${m.newH})` : ""}`
            : " — kept as-is";
          setStatus(`${tick(`${m.done} / ${total}`)} images${tag}`);
        } else if (m.type === "done") {
          const secs = ((performance.now() - t0) / 1000).toFixed(1);
          fill.style.width = "100%";
          setStatus(`Done in ${tick(secs + "s")}.`);
          showResult(m.stats, before, new Uint8Array(m.bytes));
          resolve();
        } else if (m.type === "error") {
          fail("error: " + m.message);
        }
      };

      worker.postMessage({ cmd: "optimize", bytes: buf, opts, fileId }, [buf]);
    });
  } catch (err) {
    setStatus("⚠ couldn't read file: " + (err?.message || err));
    bar.classList.remove("indeterminate");
  } finally {
    cancelRun = null;
    running = false;
    setCancelMode(false);
    if (cancelled) {
      bar.classList.remove("indeterminate");
      fill.style.width = "0%";
      setStatus("Cancelled.");
    }
  }
}

/* ------------------------------------------------------------------ *
 * Pre-flight probe (on drop) — image stats + a rough size projection
 * ------------------------------------------------------------------ */

let probeData = null;
let probeToken = 0; // guards against a newer file landing mid-scan

async function probeFile() {
  if (!currentFile) return;
  const token = ++probeToken;
  const fileId = currentFileId; // bind the cached analysis to this exact file
  probeData = null;
  $("stats").hidden = false;
  $("statFacts").innerHTML = "";
  $("statBreakdown").textContent = "";
  statEstimate.innerHTML = `<div class="note">Scanning…</div>`;

  const worker = getOrchestrator();
  worker.onerror = (e) => { if (token === probeToken) scanFailed(e.message); };
  worker.onmessage = (e) => {
    if (token !== probeToken) return; // stale scan, a newer file replaced it
    const m = e.data;
    if (m.type === "probe-analyze") {
      statEstimate.innerHTML = `<div class="note">Scanning pages… ${m.page} / ${m.total}</div>`;
    } else if (m.type === "probe") {
      renderStats(m.result);
    } else if (m.type === "probe-error") {
      scanFailed(m.message);
    }
  };

  let buf;
  try {
    buf = await currentFile.arrayBuffer();
  } catch (err) {
    if (token === probeToken) scanFailed(err?.message);
    return;
  }
  if (token !== probeToken) return; // a newer file replaced this one mid-read
  worker.postMessage({ cmd: "probe", bytes: buf, fileId }, [buf]);
}

function scanFailed(msg) {
  statEstimate.innerHTML = `<div class="note">Couldn’t scan this file${msg ? ": " + escapeHtml(msg) : ""}. You can still optimize it.</div>`;
}

function statCard(num, cap) {
  return `<div class="stat"><div class="num">${num}</div><div class="cap">${cap}</div></div>`;
}

function renderStats(probe) {
  probeData = probe;
  const count = (k) => probe.images.filter((i) => i.kind === k).length;
  const imgPct = probe.fileBytes ? Math.round((100 * probe.imageBytes) / probe.fileBytes) : 0;

  $("statFacts").innerHTML =
    statCard(probe.images.length, "images") +
    statCard(fmt(probe.imageBytes), `image data · ${imgPct}% of file`) +
    statCard(probe.pageCount, `page${probe.pageCount === 1 ? "" : "s"}`);

  const parts = [];
  const photo = count("photo"), flat = count("flat"), skip = count("skip");
  if (photo) parts.push(`${photo} photographic → JPEG`);
  if (flat) parts.push(`${flat} flat/vector → kept lossless`);
  if (skip) parts.push(`${skip} unsupported → passed through`);
  $("statBreakdown").textContent = parts.join(" · ");

  renderEstimate();
}

function renderEstimate() {
  if (!probeData) return;
  const est = estimateBytes(probeData, readControls());
  const pct = probeData.fileBytes ? Math.round((100 * est) / probeData.fileBytes) : 0;
  statEstimate.innerHTML =
    `<div class="proj"><span class="approx">≈ ${fmt(est)}</span> projected ` +
    `<span class="pct">· ~${pct}% of original</span></div>` +
    `<div class="note">rough estimate — JPEG size depends on image content, so actuals will vary</div>`;
}

/* ------------------------------------------------------------------ *
 * Size projection (pure arithmetic over the probe metadata)
 *
 * Mirrors the engine's decisions: photo→JPEG / flat→lossless routing, DPI
 * downsampling, off-page cropping, and "keep the original if it's not smaller".
 * Absolute JPEG size is content-dependent, so this is directional, not exact.
 * ------------------------------------------------------------------ */

const MIN_BYTES = 4096; // engine default; images below this are left untouched

function estimateBytes(probe, opts) {
  let images = 0;
  for (const im of probe.images) images += estimateImage(im, opts);
  const nonImage = Math.max(0, probe.fileBytes - probe.imageBytes);
  return Math.round(nonImage + images);
}

function estimateImage(im, opts) {
  if (im.kind === "skip") return im.oldBytes; // CMYK / indexed / non-8-bit: untouched

  // Placement-aware DPI downsample (area scales with the linear ratio squared).
  let scale = 1;
  if (opts.dpi && im.ppi && im.ppi > opts.dpi) scale = opts.dpi / im.ppi;
  const downsampled = scale < 1;
  const pixels = Math.max(1, Math.round(im.pixels * scale * scale));

  // Tiny images are left alone unless they're being downsampled (engine rule).
  if (!downsampled && im.oldBytes < MIN_BYTES) return im.oldBytes;

  // Cropping flattens off-page pixels; only the visible region carries detail.
  let visFrac = 1;
  if (opts.crop && im.visibleFraction < 0.98) visFrac = im.visibleFraction;
  const complexPixels = Math.max(1, Math.round(pixels * visFrac));

  if (im.kind === "photo") {
    let est = estJpegBytes(complexPixels, im.channels, opts.quality, opts.subsampling);
    if (!downsampled) est = Math.min(est, im.oldBytes); // engine keeps the smaller stream
    return est;
  }
  // flat / vector → re-deflated. oldBytes already reflects its Flate density; scale
  // by the surviving pixel area, with a small gain from max-level deflate, and an
  // extra win when cropping flattens part of it.
  let est = im.oldBytes * (pixels / im.pixels) * (visFrac < 1 ? 0.2 + 0.8 * visFrac : 0.92);
  if (!downsampled && visFrac === 1) est = Math.min(est, im.oldBytes);
  return est;
}

// Rough mozjpeg output size. The 0.28 coefficient is calibrated against real
// Figma-export output (~0.2 B/px for 3-channel at q80 / 4:4:4); the q^1.6 curve
// and chroma factors fit both q80/4:4:4 and q45/4:2:0 to within a few percent on
// that corpus. Real output is content-dependent, so this stays a projection.
function estJpegBytes(pixels, channels, quality, subsampling) {
  const q = clamp(quality, 1, 100) / 100;
  let bpp = 0.28 * Math.pow(q, 1.6);
  if (channels === 1) bpp *= 0.42; // grayscale: no chroma planes
  if (subsampling === "4:2:0") bpp *= 0.78;
  else if (subsampling === "4:2:2") bpp *= 0.88;
  return Math.round(pixels * bpp) + 700; // ~header/table overhead
}

/* ------------------------------------------------------------------ *
 * Result + text report
 * ------------------------------------------------------------------ */

function showResult(stats, before, bytes) {
  const after = bytes.length;
  const name = pdfName.replace(/\.pdf$/i, "") + ".optimized.pdf";
  const a = $("download");
  a.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  a.download = name;
  const pct = ((100 * after) / before).toFixed(1);
  a.innerHTML = `↓ Download optimized PDF<span class="meta">${escapeHtml(name)} · ${fmt(after)} · ${pct}% of original</span>`;
  $("report").textContent = report(stats, before, after);
  $("results").hidden = false;

  // Reveal the result, but only if the report isn't already on screen.
  if (!intersectsViewport($("report"))) scrollToward($("results"));
}

function report(stats, before, after) {
  const lines = [
    `SIZE     ${fmt(before)}  ->  ${fmt(after)}`,
    `         ${((100 * after) / before).toFixed(1)}% of original · ${fmt(before - after)} saved`,
    "",
    `IMAGES   ${stats.images} total · ${stats.jpeg} jpeg · ${stats.lossless} lossless` +
      (stats.downsampled ? ` · ${stats.downsampled} downsampled` : "") +
      (stats.blanked ? ` · ${stats.blanked} cropped` : "") +
      ` · ${stats.keptOriginal} kept · ${stats.skipped} skipped`,
    "",
    `PER PAGE (${stats.pages.filter((p) => p.changed).length}/${stats.pages.length} affected)`,
  ];

  const pad = String(stats.pages.length).length;
  for (const p of stats.pages) {
    const label = `  page ${String(p.page + 1).padStart(pad)}`;
    if (p.total === 0) { lines.push(`${label}  no images`); continue; }
    const parts = [];
    if (p.jpeg) parts.push(`${p.jpeg} jpeg`);
    if (p.lossless) parts.push(`${p.lossless} lossless`);
    if (p.downsampled) parts.push(`${p.downsampled} downsampled`);
    if (p.blanked) parts.push(`${p.blanked} cropped`);
    const detail = parts.length ? ` (${parts.join(", ")})` : "";
    lines.push(`${label}  ${p.changed}/${p.total} image${p.total === 1 ? "" : "s"} changed${detail}`);
  }
  return lines.join("\n");
}
