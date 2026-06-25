import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { existsSync, createReadStream } from "node:fs";

const projectRoot = dirname(fileURLToPath(import.meta.url));

// In dev, mupdf and jsquash fetch their .wasm by URL (relative to their module in
// node_modules). Vite's dev server otherwise answers those with index.html, so the
// wasm never loads (and the worker hangs). Serve any .wasm request as the raw file.
function serveWasm() {
  return {
    name: "serve-wasm-raw",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url || "").split("?")[0];
        if (!path.endsWith(".wasm")) return next();
        const file = normalize(join(projectRoot, decodeURIComponent(path)));
        if (file.startsWith(projectRoot) && existsSync(file)) {
          res.setHeader("Content-Type", "application/wasm");
          createReadStream(file).pipe(res);
        } else {
          next();
        }
      });
    },
  };
}

// The browser build shares the same engine as the CLI (src/optimize.js); only the
// codecs differ (src/codecs.web.js). mupdf + jsquash ship their own wasm and locate
// it via import.meta.url, so they must stay out of dependency pre-bundling.
export default defineConfig({
  root: "web",
  // Relative base so the built site works under the gh-pages project subpath
  // (https://<user>.github.io/pdf-optimizer/) as well as at a domain root.
  base: "./",
  plugins: [serveWasm()],
  optimizeDeps: { exclude: ["mupdf", "@jsquash/jpeg", "@jsquash/resize"] },
  server: { fs: { allow: [".."] } }, // allow importing ../src and node_modules
  // ES-format workers so the orchestrator worker can code-split its nested encode pool.
  worker: { format: "es" },
  build: { outDir: "../dist", emptyOutDir: true, target: "esnext" },
});
