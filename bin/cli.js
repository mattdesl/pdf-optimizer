#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { optimize } from "../src/index.js";
import { compare } from "../src/verify.js";

const HELP = `pdf-optimize — shrink image-heavy PDFs (e.g. Figma exports) by recompressing
images in place, without touching color, vectors, masks or text.

Usage:
  pdf-optimize <input.pdf> [options]

Options:
  -o, --output <file>     output path (default: <input>.optimized.pdf)
  -q, --quality <n>       JPEG quality 1-100 (default: 80)
      --dpi <n>           downsample images displayed above this effective PPI
                          (per-image, placement-aware; default: 300; 0 = off)
      --subsampling <s>   chroma subsampling: 4:4:4 | 4:2:2 | 4:2:0 (default: 4:4:4)
      --no-blank-offpage  keep pixels drawn off the page (blanking is on by default)
      --min-ratio <r>     only replace an image if new/old size <= r (default: 1.0)
      --min-bytes <n>     leave images smaller than n bytes untouched (default: 4096)
      --vector-threshold <b>  Flate bytes/pixel below which an image is treated as
                          flat/vector-like and kept lossless, never JPEG'd (default: 0.2)
      --verify            render every page before/after and report pixel diffs
      --quiet             suppress per-image progress (keep summary + per-page report)
      --silent            no output at all
  -h, --help              show this help

Examples:
  pdf-optimize deck.pdf
  pdf-optimize deck.pdf -q 85 --dpi 200 -o deck.min.pdf
  pdf-optimize deck.pdf --dpi 0 --no-blank-offpage   # recompress only, nothing else
  pdf-optimize deck.pdf --verify
`;

function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + " KB";
  return n + " B";
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        output: { type: "string", short: "o" },
        quality: { type: "string", short: "q" },
        dpi: { type: "string" },
        subsampling: { type: "string" },
        "no-blank-offpage": { type: "boolean" },
        "min-ratio": { type: "string" },
        "min-bytes": { type: "string" },
        "vector-threshold": { type: "string" },
        verify: { type: "boolean" },
        quiet: { type: "boolean" },
        silent: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    console.error(e.message + "\n");
    process.stderr.write(HELP);
    process.exit(2);
  }

  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const input = positionals[0];
  const output = values.output ||
    `${input.slice(0, input.length - extname(input).length)}.optimized.pdf`;
  const quality = values.quality ? Number(values.quality) : 80;
  // --dpi defaults to 300; --dpi 0 (or negative) disables downsampling.
  const dpiRaw = values.dpi != null ? Number(values.dpi) : 300;
  const dpi = Number.isFinite(dpiRaw) && dpiRaw > 0 ? dpiRaw : null;
  const subsampling = values.subsampling || "4:4:4";
  const blankOffPage = !values["no-blank-offpage"];
  const minRatio = values["min-ratio"] ? Number(values["min-ratio"]) : 1.0;
  const minBytes = values["min-bytes"] ? Number(values["min-bytes"]) : 4096;
  const vectorBpp = values["vector-threshold"] ? Number(values["vector-threshold"]) : 0.2;
  const silent = !!values.silent;
  const quiet = !!values.quiet || silent;

  if (!Number.isFinite(quality) || quality < 1 || quality > 100) {
    console.error(`invalid --quality: ${values.quality}`); process.exit(2);
  }
  if (values.dpi != null && !Number.isFinite(dpiRaw)) {
    console.error(`invalid --dpi: ${values.dpi}`); process.exit(2);
  }

  let bytes;
  try { bytes = readFileSync(input); }
  catch (e) { console.error(`cannot read ${input}: ${e.message}`); process.exit(1); }
  const before = bytes.length; // capture now: mupdf detaches the buffer on open

  const t0 = Date.now();
  if (!quiet) {
    console.error(`optimizing ${basename(input)} (${fmtBytes(before)}) ` +
      `q=${quality} subsampling=${subsampling}${dpi ? ` dpi=${dpi}` : ""}` +
      `${blankOffPage ? " blank-offpage" : ""}`);
  }

  let count = 0;
  const { bytes: out, stats } = await optimize(bytes, {
    quality, dpi, subsampling, minRatio, minBytes, vectorBpp, blankOffPage,
    onImage: quiet ? undefined : (m) => {
      count++;
      if (m.recompressed) {
        const tag = m.downsampled ? `↓${m.newW}×${m.newH} ` : "";
        const kind = m.kind === "lossless" ? "lossless " : "";
        process.stderr.write(
          `  [${count}] ${m.width}×${m.height} ${kind}${tag}${fmtBytes(m.oldBytes)} → ${fmtBytes(m.newBytes)}\r`
        );
      }
    },
  });
  if (!quiet) process.stderr.write("\n");

  writeFileSync(output, out);
  const after = statSync(output).size;
  if (silent) return;

  console.log(`\n${basename(input)} → ${basename(output)}`);
  console.log(`  size      : ${fmtBytes(before)} → ${fmtBytes(after)}  (${(100 * after / before).toFixed(1)}% of original, ${fmtBytes(before - after)} saved)`);
  console.log(`  images    : ${stats.images} total · ${stats.jpeg} jpeg · ${stats.lossless} lossless` +
    `${stats.downsampled ? ` · ${stats.downsampled} downsampled` : ""}` +
    `${stats.blanked ? ` · ${stats.blanked} off-page blanked` : ""}` +
    ` · ${stats.keptOriginal} kept · ${stats.skipped} skipped`);
  if (stats.skipped) {
    const detail = Object.entries(stats.skips).map(([k, v]) => `${k}×${v}`).join(", ");
    console.log(`  skipped   : ${detail}`);
  }
  console.log(`  time      : ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Per-page report: how many images changed on each page.
  const pad = String(stats.pages.length).length;
  console.log(`\n  per page (${stats.pages.filter((p) => p.changed).length}/${stats.pages.length} pages affected):`);
  for (const p of stats.pages) {
    const label = `    page ${String(p.page + 1).padStart(pad)}`;
    if (p.total === 0) { console.log(`${label}: no images`); continue; }
    const parts = [];
    if (p.jpeg) parts.push(`${p.jpeg} jpeg`);
    if (p.lossless) parts.push(`${p.lossless} lossless`);
    if (p.downsampled) parts.push(`${p.downsampled} downsampled`);
    if (p.blanked) parts.push(`${p.blanked} off-page blanked`);
    const detail = parts.length ? ` (${parts.join(", ")})` : "";
    console.log(`${label}: ${p.changed}/${p.total} image${p.total === 1 ? "" : "s"} changed${detail}`);
  }

  if (values.verify) {
    console.log(`\n  verifying (rendering every page before/after)…`);
    // Re-read fresh buffers from disk: mupdf detached the originals on open.
    const results = compare(readFileSync(input), readFileSync(output), { scale: 0.25 });
    let worst = 0, worstPage = -1;
    for (const r of results) {
      if (r.mismatch) { console.log(`    page ${r.page}: SIZE MISMATCH ${r.mismatch}`); worst = Infinity; continue; }
      if (r.mean > worst) { worst = r.mean; worstPage = r.page; }
    }
    const meanAll = results.reduce((s, r) => s + (r.mean || 0), 0) / results.length;
    console.log(`    avg pixel diff/channel: ${meanAll.toFixed(3)}   worst page: ${worstPage} (${worst === Infinity ? "mismatch" : worst.toFixed(2)})`);
    console.log(`    (small diffs = JPEG quantization; ~0 = identical; large = investigate)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
