// Off-diagonal CTM terms small relative to the scale => axis-aligned placement.
// (Image placements are gathered in placement.js's single analyze walk.)
export function isRotated(m) {
  return Math.abs(m[1]) > 1e-3 * Math.abs(m[0]) + 1e-6 ||
         Math.abs(m[2]) > 1e-3 * Math.abs(m[3]) + 1e-6;
}

// Given an image's raw interleaved samples and the list of on-page placements,
// set every pixel that is never visible (off every page it's drawn on) to the
// mean color of the visible pixels. This keeps dimensions, placement, masks and
// content streams untouched — only never-rendered pixels change, and they then
// compress to almost nothing.
//
// Returns { fraction } (blanked fraction) or null if nothing was blanked.
// Mutates `samples` in place; pass a JS-owned copy.
export function blankInvisible(samples, W, H, channels, placements, minFraction = 0.02) {
  const visible = new Uint8Array(W * H); // 0 = never visible
  for (const pl of placements) {
    const m = pl.ctm;
    if (isRotated(m)) return null; // can't reason simply; leave the whole image intact
    const [a, , , d, e, f] = m;
    if (a === 0 || d === 0) return null;
    const pg = pl.page;
    // mupdf image space and run-device space are both y-down with a top-left
    // origin, so the unit square maps directly: col u = x in [0,1], row v = y in
    // [0,1] (no flip). Find the u,v ranges that land inside the page rectangle.
    let [ul, ur] = ordered((pg.x0 - e) / a, (pg.x1 - e) / a);
    ul = Math.max(0, ul); ur = Math.min(1, ur);
    let [vl, vr] = ordered((pg.y0 - f) / d, (pg.y1 - f) / d);
    vl = Math.max(0, vl); vr = Math.min(1, vr);
    if (ur <= ul || vr <= vl) continue; // this placement shows nothing on-page
    const c0 = clamp(Math.floor(ul * W), 0, W);
    const c1 = clamp(Math.ceil(ur * W), 0, W);
    const r0 = clamp(Math.floor(vl * H), 0, H);
    const r1 = clamp(Math.ceil(vr * H), 0, H);
    for (let r = r0; r < r1; r++) visible.fill(1, r * W + c0, r * W + c1);
  }

  let visN = 0;
  for (let i = 0; i < visible.length; i++) if (visible[i]) visN++;
  const invisible = visible.length - visN;
  if (visN === 0 || invisible / visible.length < minFraction) return null;

  // Fill colour = mean of the visible pixels (a low-contrast boundary so JPEG
  // ringing doesn't bleed into the visible area).
  const sum = new Float64Array(channels);
  for (let i = 0; i < visible.length; i++) {
    if (!visible[i]) continue;
    const o = i * channels;
    for (let ch = 0; ch < channels; ch++) sum[ch] += samples[o + ch];
  }
  const fill = new Uint8Array(channels);
  for (let ch = 0; ch < channels; ch++) fill[ch] = Math.round(sum[ch] / visN);

  for (let i = 0; i < visible.length; i++) {
    if (visible[i]) continue;
    const o = i * channels;
    for (let ch = 0; ch < channels; ch++) samples[o + ch] = fill[ch];
  }
  return { fraction: invisible / visible.length };
}

function ordered(a, b) { return a <= b ? [a, b] : [b, a]; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
