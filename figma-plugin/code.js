// Plugin sandbox (QuickJS) — NO DOM, WASM, or Web Workers here. All real work
// (mupdf + the encode pool) happens in the UI iframe; see ui.html. This side only
// opens the window and relays messages.
//
// Future hook: this is where you'd read figma.currentPage.selection, export selected
// frames to PDF bytes with node.exportAsync({ format: "PDF" }), and figma.ui.postMessage
// them into the optimizer — i.e. "optimize the current selection" without leaving Figma.

figma.showUI(__html__, { width: 460, height: 600, title: "PDF Optimizer" });

figma.ui.onmessage = (msg) => {
  if (!msg) return;
  // Let the app grow/shrink the window to fit its compact layout.
  if (msg.type === "resize" && Number.isFinite(msg.height)) {
    figma.ui.resize(460, Math.max(360, Math.min(900, msg.height | 0)));
  }
  if (msg.type === "close") figma.closePlugin();
};
