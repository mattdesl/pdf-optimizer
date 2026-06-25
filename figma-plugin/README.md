# PDF Optimizer — Figma plugin (prototype)

A thin Figma wrapper around the existing web app. It does **not** re-bundle the
engine. The plugin UI is just a bootstrap that redirects the plugin iframe to the
real app on its own origin (dev server or gh-pages), so the orchestrator worker,
encode-worker pool, and mupdf/jsquash WASM all resolve exactly as in the web build.

```
figma-plugin/
  manifest.json   # plugin manifest (points at code.js + ui.html, declares networkAccess)
  code.js         # sandbox side: opens the window, relays messages (no DOM/WASM/workers)
  ui.html         # bootstrap: navigates the iframe to <app-origin>/?figma
```

## Why a redirect instead of bundling

Inlined plugin UIs run at an **opaque (null) origin** — no base URL. That breaks
`new URL('./x.worker.js', import.meta.url)`, wasm located via `import.meta.url`, and
ES-module-worker nested imports, which is the entire loading strategy here. Pointing
the iframe at a real https origin sidesteps all of it with zero engine changes. (The
offline alternative — blob-URL workers + base64-inlined ~10MB mupdf wasm — is a much
bigger rewrite; do it only if true offline operation is required.)

## Test it

1. `npm run dev` (Vite serves the app at http://localhost:5173).
2. Confirm http://localhost:5173/?figma loads in a normal browser tab first.
3. In the Figma **desktop** app: Plugins → Development → **Import plugin from manifest…**
   and pick `figma-plugin/manifest.json`.
4. Run it: Plugins → Development → **PDF Optimizer**.

### What to verify (the real unknowns)

- **WASM / workers:** does a PDF actually optimize inside the iframe? (Open the
  plugin's devtools: Plugins → Development → **Open console**.)
- **Drag-drop:** drop a PDF onto the window — likely unreliable (Figma's canvas may
  eat the event). Click-to-choose via the file input is the dependable path.
- **Download:** click Download — works in most Figma builds via the blob + `<a download>`
  trick; if a build's iframe sandbox blocks it, fall back to routing bytes through
  `figma.ui.postMessage`.

## Publishing

Flip `ui.html` from `DEV` to `PROD`, keep the prod domain in
`manifest.json` → `networkAccess.allowedDomains`, and tighten `["*"]`-style entries.
