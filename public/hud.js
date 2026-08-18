/* =============================================================================
 *  HOLO-HUD ENGINE
 *  A holographic graph renderer on plain Canvas 2D. No libraries.
 *
 *  The engine knows nothing about the subject. What to draw, it asks the scene:
 *  the scene hands over nodes, edges, and hooks for the leaf elements (their
 *  summary, their movement, their detail card). One machine therefore serves
 *  both a network of agents and a map of business logic.
 *
 *  The frame pipeline:
 *      scene (offscreen)
 *        -> bright-pass (brightness squared)
 *        -> down/upsample pyramid = bloom
 *        -> anamorphic horizontal streak
 *        -> RGB split + radial chromatic aberration
 *        -> scanlines, sweep, grain, vignette
 *        -> screen
 *
 *  Sections of this file:
 *      1  maths and utilities
 *      2  palette
 *      3  connecting the scene
 *      4  the text engine
 *      5  geometry and layout
 *      6  camera
 *      7  render targets
 *      8  shape primitives
 *      9  background
 *     10  edges
 *     11  nodes
 *     12  the on-screen HUD
 *     13  post-processing
 *     14  input
 *     15  the main loop
 * ========================================================================== */

/**
 * Mounts the HUD renderer onto a canvas inside a panel.
 *
 *   const hud = HUD_MOUNT(canvasEl, scene, { onPick });
 *   hud.destroy();
 *
 * `scene` is either the scene object or a factory taking the engine API. Every
 * mount is independent: its own graph, camera, buffers and listeners, so two
 * views can be on screen at once without sharing state.
 */
window.HUD_MOUNT = function (view, SCENE_INPUT, OPTS) {
'use strict';
OPTS = OPTS || {};
let stopped = false;
const teardown = [];
const on = (target, type, fn, opts) => {
  target.addEventListener(type, fn, opts);
  teardown.push(() => target.removeEventListener(type, fn, opts));
};

/* =============================================================================
 * 1. MATHS AND UTILITIES
 * ========================================================================== */

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const invLerp = (a, b, v) => (b === a ? 0 : clamp((v - a) / (b - a), 0, 1));
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Frame-rate independent approach to a target: rate is stiffness, in 1/sec.
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

// A deterministic PRNG, so the picture is reproducible between runs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth 1D value noise, for the hologram's shimmer and its live readings.
function makeNoise1D(seed) {
  const rnd = mulberry32(seed);
  const N = 512;
  const tab = new Float32Array(N);
  for (let i = 0; i < N; i++) tab[i] = rnd() * 2 - 1;
  return (x) => {
    const i = Math.floor(x);
    const f = x - i;
    const a = tab[((i % N) + N) % N];
    const b = tab[(((i + 1) % N) + N) % N];
    const u = f * f * (3 - 2 * f);
    return a + (b - a) * u;
  };
}

const noiseA = makeNoise1D(1337);
const noiseB = makeNoise1D(9001);
const noiseC = makeNoise1D(4242);

/* =============================================================================
 * 2. PALETTE
 * ========================================================================== */

const C = {
  cyan:  [ 96, 232, 255],
  ice:   [186, 246, 255],
  blue:  [ 72, 150, 255],
  deep:  [ 32,  92, 168],
  amber: [255, 178,  78],
  gold:  [255, 214, 130],
  red:   [255,  92, 110],
  green: [ 96, 246, 176],
  paper: [214, 248, 255],
};

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (c1, c2, t) => [
  Math.round(lerp(c1[0], c2[0], t)),
  Math.round(lerp(c1[1], c2[1], t)),
  Math.round(lerp(c1[2], c2[2], t)),
];

// Node kinds: colour plus how much glow each carries.
const KIND = {
  core:    { color: C.amber, accent: C.gold,  glow: 1.35 },
  primary: { color: C.cyan,  accent: C.ice,   glow: 1.00 },
  sub:     { color: C.blue,  accent: C.cyan,  glow: 0.82 },
  data:    { color: C.green, accent: C.ice,   glow: 0.88 },
  alert:   { color: C.red,   accent: C.gold,  glow: 1.10 },
};

/* =============================================================================
 * 3. CONNECTING THE SCENE
 *    A scene provides:
 *      title, subtitle, ticker[]      — the HUD's own captions
 *      nodes[], edges[]               — the top-level graph
 *      groupRows()                    — summary rows for a container node
 *      leaf.init(src, rnd)            — leaf data, or null for an empty leaf
 *      leaf.rows(data)                — summary rows for a leaf
 *      leaf.step(data, dt)            — the leaf's per-frame movement
 *      leaf.stats(data)               — what the leaf contributes to its container
 *      leaf.progress(data)            — 0..1 for a row drawn as a bar
 *      resolveRow(node, row)          — the live value behind a row
 *      detail: { w, h, draw(...) }    — the opened card for a leaf
 *      labels                         — show edge labels by default
 * ========================================================================== */

const HUD_API = {};                  // filled in below, before the scene is built
let SCENE = null;

/* =============================================================================
 * 4. THE TEXT ENGINE
 *    Monospace plus manual tracking — letterSpacing is not everywhere.
 * ========================================================================== */

const FONT_STACK = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

const HAS_LETTER_SPACING = (() => {
  try {
    const c = document.createElement('canvas').getContext('2d');
    return 'letterSpacing' in c;
  } catch (e) { return false; }
})();

const measureCache = new Map();
const measureCtx = document.createElement('canvas').getContext('2d');

function fontString(size, weight) {
  return `${weight} ${size.toFixed(2)}px ${FONT_STACK}`;
}

function applyFont(ctx, size, weight, tracking) {
  ctx.font = fontString(size, weight);
  if (HAS_LETTER_SPACING) ctx.letterSpacing = `${tracking.toFixed(3)}px`;
}

/**
 * The width a tracked string will actually occupy when drawn.
 * Native letterSpacing adds a gap after the last character too, so subtract
 * it — otherwise right-alignment drifts.
 */
function textWidth(str, size, weight, tracking) {
  const key = `${size}|${weight}|${tracking}|${str}`;
  const cached = measureCache.get(key);
  if (cached !== undefined) return cached;

  measureCtx.font = fontString(size, weight);
  let w;
  if (HAS_LETTER_SPACING && tracking !== 0) {
    measureCtx.letterSpacing = `${tracking.toFixed(3)}px`;
    w = measureCtx.measureText(str).width - tracking;
    measureCtx.letterSpacing = '0px';
  } else {
    w = measureCtx.measureText(str).width + tracking * Math.max(0, str.length - 1);
  }
  if (measureCache.size < 8000) measureCache.set(key, w);
  return w;
}

/* --- deferred text ------------------------------------------------------- *
 * Glow here comes from bloom, and bloom reads brightness straight off the
 * frame. Text is the brightest thing on a panel, so a halo swelled around
 * every letter and made it swim. So text is not drawn as it is asked for:
 * the calls queue up, bloom is computed on a frame with no letters in it, and
 * only then does the text land on top, perfectly sharp. The queue keeps the
 * matrix, alpha and clip so replaying is indistinguishable from drawing directly.
 */
const textQueue = [];
let deferText = true;
let textClip = null;          // {x, y, w, h} — the panel's rect, or null

function flushText(ctx) {
  if (!textQueue.length) return;
  const wasDeferred = deferText;
  deferText = false;
  for (const it of textQueue) {
    ctx.save();
    ctx.setTransform(it.m);
    ctx.globalAlpha = it.alpha;
    if (it.clip) {
      ctx.beginPath();
      ctx.rect(it.clip.x, it.clip.y, it.clip.w, it.clip.h);
      ctx.clip();
    }
    drawText(ctx, it.str, it.x, it.y, it.opt);
    ctx.restore();
  }
  textQueue.length = 0;
  deferText = wasDeferred;
}

/**
 * Draws tracked text. align: 'left' | 'center' | 'right'.
 * Returns the width, available immediately even when drawing is deferred.
 */
function drawText(ctx, str, x, y, opt) {
  const size = opt.size;
  const weight = opt.weight || 400;
  const tracking = opt.tracking || 0;
  const align = opt.align || 'left';
  const w = textWidth(str, size, weight, tracking);

  if (deferText) {
    textQueue.push({
      str, x, y,
      opt: opt.color ? opt : { ...opt, color: ctx.fillStyle },
      m: ctx.getTransform(),
      alpha: ctx.globalAlpha,
      clip: textClip,
    });
    return w;
  }

  let sx = x;
  if (align === 'center') sx = x - w / 2;
  else if (align === 'right') sx = x - w;

  applyFont(ctx, size, weight, tracking);
  ctx.textAlign = 'left';
  ctx.textBaseline = opt.baseline || 'middle';
  if (opt.color) ctx.fillStyle = opt.color;

  if (HAS_LETTER_SPACING || tracking === 0) {
    ctx.fillText(str, sx, y);
  } else {
    // Fallback: character by character, so tracking behaves the same everywhere.
    measureCtx.font = fontString(size, weight);
    let cx = sx;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      ctx.fillText(ch, cx, y);
      cx += measureCtx.measureText(ch).width + tracking;
    }
  }
  if (HAS_LETTER_SPACING) ctx.letterSpacing = '0px';
  return w;
}

/* =============================================================================
 * 5. NODE GEOMETRY AND LAYOUT
 * ========================================================================== */

// Below this scale a row of card text is under 6 screen pixels — present, and
// unreadable. Under it a card shows the one thing worth reading, its name, at a
// size that does not shrink with the view.
const LOD_ROWS = 0.62;

// How present an edge is when nothing is pointed at.
const EDGE_REST = 0.42;

// How much a card grows under the pointer, in world units. The drawing and the
// container that has to make room for it both read these. Two copies of the
// number is how a card ended up spilling out through its container's frame.
const HOVER_GROW_W = 58;
const HOVER_GROW_H = 30;

const METRIC = {
  padX: 14,
  headerH: 26,
  titleLH: 13,        // extra height per wrapped title line
  rowH: 15,
  footerH: 16,
  minW: 168,
  maxW: 260,
  hardMaxW: 380,     // a card may pass maxW only to keep one long word whole
  titleSize: 11.5,
  titleTrack: 1.6,
  tagSize: 8,
  tagTrack: 1.0,
  rowSize: 8.8,
  rowTrack: 0.7,
  // The gaps have to hold a label, not just keep the cards apart: a chip runs
  // up to ~90px wide and 18px tall, and with less room than that the writing on
  // the lines has nowhere to go but on top of a card.
  colGap: 170,
  rowGap: 66,
};

// Padding for a nested level inside an opened node.
const NEST = {
  padX: 26,
  padTop: 34,      // below the container's own header
  padBottom: 42,   // generous: bypass arcs dip below the panels
  colGap: 132,     // inside a container, panels sit closer than at the top level
  rowGap: 54,
};

const root = { nodes: [], edges: [], cols: null, w: 0, h: 0, parent: null };
const nodes = root.nodes;      // the root level, which most of this code works on
const edges = root.edges;
const allNodes = [];           // every node of every level, flat
const allEdges = [];

function buildLevel(nodeSpecs, edgeSpecs, rnd, parent) {
  const level = {
    nodes: [], edges: [], cols: null, w: 0, h: 0, parent,
    gapX: parent ? NEST.colGap : METRIC.colGap,
    gapY: parent ? NEST.rowGap : METRIC.rowGap,
  };
  const byId = new Map();

  for (const src of nodeSpecs) {
    const kind = KIND[src.kind] || KIND.primary;
    // A leaf gets its rows from its own state; a container gets them from an
    // aggregate over its children, filled in below.
    const leafData = SCENE.leaf.init(src, rnd);
    const rawRows = src.rows || (leafData ? SCENE.leaf.rows(leafData) : SCENE.groupRows());

    // Width follows the longest thing inside, up to a cap. Past the cap a card
    // cannot get wider, so anything longer has to move down instead of being
    // cut off: text wraps and the card grows taller for it.
    let w = METRIC.minW;
    const tagW = textWidth(src.tag, METRIC.tagSize, 400, METRIC.tagTrack);
    // +2 of slack over what the wrapper subtracts back out. Without it the width
    // lands exactly on the title's own length and rounding decides whether the
    // last character wraps — which is how "REFUNDORDER" became "REFUNDORDE / R".
    w = Math.max(w, textWidth(src.title, METRIC.titleSize, 600, METRIC.titleTrack)
                  + tagW + METRIC.padX * 2 + 28);
    for (const r of rawRows) {
      const lw = textWidth(r[0], METRIC.rowSize, 400, METRIC.rowTrack);
      const rw = textWidth(r[1] || '', METRIC.rowSize, 600, METRIC.rowTrack);
      w = Math.max(w, lw + rw + METRIC.padX * 2 + 36);
    }
    w = Math.min(METRIC.maxW, Math.round(w));

    // A word with nowhere to break — an id, a route — would be split mid-token
    // and read as nonsense. The card is allowed past the usual cap for those,
    // up to a hard ceiling, before wrapping is asked to do anything clever.
    let longest = 0;
    for (const word of String(src.title).split(/\s+/))
      longest = Math.max(longest, textWidth(word, METRIC.titleSize, 600, METRIC.titleTrack)
                                  + tagW + METRIC.padX * 2 + 28);
    for (const r of rawRows)
      for (const word of String(r[0] == null ? '' : r[0]).split(/\s+/))
        longest = Math.max(longest, textWidth(word, METRIC.rowSize, 400, METRIC.rowTrack)
                                    + textWidth(r[1] || '', METRIC.rowSize, 600, METRIC.rowTrack)
                                    + METRIC.padX * 2 + 36);
    if (longest > w) w = Math.round(Math.min(METRIC.hardMaxW, longest));

    // The title gets as many lines as it needs; the tag keeps the first one.
    const titleLines = wrapToWidth(src.title, METRIC.titleSize, 600, METRIC.titleTrack,
      w - METRIC.padX * 2 - 26 - tagW, w - METRIC.padX * 2 - 26);
    const headH = METRIC.headerH + (titleLines.length - 1) * METRIC.titleLH;

    // Rows the same: a long label continues on the next line, and its value
    // stays with the first.
    const rows = [];
    for (const r of rawRows) {
      const valW = textWidth(r[1] || '', METRIC.rowSize, 600, METRIC.rowTrack);
      const parts = wrapToWidth(String(r[0] == null ? '' : r[0]),
        METRIC.rowSize, 400, METRIC.rowTrack,
        w - METRIC.padX * 2 - 34 - valW, w - METRIC.padX * 2 - 34);
      parts.forEach((s2, i) => rows.push(i === 0 ? [s2, r[1], r[2]] : [s2, '', r[2] === 'bar' ? null : r[2]]));
    }

    const h = headH + rows.length * METRIC.rowH + METRIC.footerH;

    const n = {
      // Keep the scene node itself: it carries the model id, and a click has to
      // be answerable with "which object of the product is this".
      src,
      id: src.id,
      kind: src.kind,
      // A layer's reading for this node, 0..1, or null when no layer is on.
      heat: (src.heat == null ? null : clamp(+src.heat || 0, 0, 1)),
      title: src.title,
      titleLines,
      headH,
      tag: src.tag,
      rows,
      color: kind.color,
      accent: kind.accent,
      glowK: kind.glow,
      // baseW/baseH is the collapsed size; w/h is current and grows when opened.
      baseW: w, baseH: h,
      openW: w, openH: h,
      w, h,
      lx: 0, ly: 0,        // local coordinates within its own level
      ltx: 0, lty: 0,      // where those local coordinates are travelling to
      x: 0, y: 0,          // absolute world coordinates, recomputed every frame
      depth: 0,
      col: 0,
      level: null,         // the level this node belongs to
      sub: null,           // the nested level, if any
      expanded: false,
      expandT: 0,          // 0..1 — how far open
      boot: 0,             // 0..1 — how far assembled
      bootDelay: 0,
      hover: 0,            // 0..1 — smoothed highlight
      select: 0,
      dim: 1,              // dimming when out of focus
      seed: rnd() * 1000,
      load: rnd(),
      inEdges: [],
      outEdges: [],
      // Assembly particles, converging on the outline as the node appears.
      motes: Array.from({ length: 14 }, () => {
        const a = rnd() * TAU;
        const d = 180 + rnd() * 320;
        return { ax: Math.cos(a) * d, ay: Math.sin(a) * d, t: rnd() * 0.35, s: 0.6 + rnd() * 0.8 };
      }),
    };
    n.level = level;
    n.leaf = leafData;
    level.nodes.push(n);
    allNodes.push(n);
    byId.set(n.id, n);

    // The nested level is built and laid out immediately: its size decides the
    // container's size, which this level's own layout needs.
    if (src.children && src.children.nodes && src.children.nodes.length) {
      n.sub = buildLevel(src.children.nodes, src.children.edges || [], rnd, n);
      layoutLevel(n.sub, 1.5);
      n.openW = Math.max(n.baseW, n.sub.w + NEST.padX * 2);
      n.openH = n.sub.h + NEST.padTop + NEST.padBottom;
    }
  }

  for (const [from, to, label] of (edgeSpecs || [])) {
    const a = byId.get(from);
    const b = byId.get(to);
    if (!a || !b) continue;
    const e = {
      a, b,
      label: label || '',
      pts: [],            // polyline approximation of the curve
      cum: [],            // cumulative length along those points
      len: 0,
      dirty: true,
      boot: 0,
      hover: 0,
      dim: 1,
      // Data packets running along the edge.
      packets: Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => ({
        t: rnd(),
        speed: 0.10 + rnd() * 0.16,
        size: 0.7 + rnd() * 0.7,
      })),
      seed: rnd() * 1000,
      level,
    };
    level.edges.push(e);
    allEdges.push(e);
    a.outEdges.push(e);
    b.inEdges.push(e);
  }

  return level;
}

function buildGraph() {
  const rnd = mulberry32(20250803);
  const built = buildLevel(SCENE.nodes, SCENE.edges, rnd, null);
  root.nodes.push(...built.nodes);
  root.edges.push(...built.edges);
  root.cols = built.cols;
  // Root-level nodes must point at root, not at the temporary object.
  for (const n of root.nodes) n.level = root;
  for (const e of root.edges) e.level = root;
}

/**
 * Breaks a string into lines that fit. The first line may be narrower than the
 * rest — a value or a tag shares it — which is why two widths go in.
 * A word longer than a whole line is broken rather than allowed to overflow:
 * an id like `sf-refund-order-status` has nowhere to break politely.
 */
function wrapToWidth(text, size, weight, tracking, firstW, restW) {
  const s = String(text == null ? '' : text);
  if (!s) return [''];
  const fits = (str, width) => textWidth(str, size, weight, tracking) <= width;
  if (fits(s, Math.max(8, firstW))) return [s];

  const out = [];
  let rest = s;
  let width = Math.max(8, firstW);
  let guard = 0;
  while (rest && guard++ < 40) {
    if (fits(rest, width)) { out.push(rest); break; }
    // Longest prefix that fits, preferring a break at a space.
    let cut = rest.length;
    while (cut > 1 && !fits(rest.slice(0, cut), width)) cut--;
    let at = rest.lastIndexOf(' ', cut);
    if (at <= 0) at = cut;                       // no space to break on
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
    width = Math.max(8, restW);
  }
  return out.length ? out : [s];
}

/** Layered layout: depth along edges, then barycentric ordering. */
function layoutLevel(level, aspectOverride) {
  const nodes = level.nodes;
  const edges = level.edges;
  if (!nodes.length) return level;
  // --- feedback edges.
  // A graph has cycles (telemetry -> controller). Depth cannot be counted
  // through them — it would grow without end — so the closing edges are left
  // out of the along-flow coordinate. They are still drawn; they simply run
  // against the current.
  //
  // A naive DFS marks whichever cycle edge it meets first, and the picture
  // spreads into columns it does not need. So: the Eades-Lin-Smyth heuristic,
  // which builds an order of nodes with as few edges as possible running
  // backwards. Those few are the feedback edges.
  const outDeg = new Map();
  const inDeg = new Map();
  const alive = new Set(nodes);
  for (const n of nodes) { outDeg.set(n, 0); inDeg.set(n, 0); }
  for (const e of edges) {
    if (e.a === e.b) continue;
    outDeg.set(e.a, outDeg.get(e.a) + 1);
    inDeg.set(e.b, inDeg.get(e.b) + 1);
  }

  const drop = (n) => {
    alive.delete(n);
    for (const e of n.outEdges) if (e.a !== e.b && alive.has(e.b)) inDeg.set(e.b, inDeg.get(e.b) - 1);
    for (const e of n.inEdges) if (e.a !== e.b && alive.has(e.a)) outDeg.set(e.a, outDeg.get(e.a) - 1);
  };

  const head = [];   // sources, which go to the front of the order
  const tail = [];   // sinks, which go to the back
  while (alive.size) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const n of Array.from(alive)) {
        if (alive.has(n) && outDeg.get(n) === 0) { tail.unshift(n); drop(n); moved = true; }
      }
      for (const n of Array.from(alive)) {
        if (alive.has(n) && inDeg.get(n) === 0) { head.push(n); drop(n); moved = true; }
      }
    }
    if (!alive.size) break;
    // A cycle is left: sacrifice the node with the largest outgoing surplus.
    let best = null;
    let bestVal = -Infinity;
    for (const n of alive) {
      const v = outDeg.get(n) - inDeg.get(n);
      if (v > bestVal) { bestVal = v; best = n; }
    }
    head.push(best);
    drop(best);
  }

  const pos = new Map();
  head.concat(tail).forEach((n, i) => pos.set(n, i));
  for (const e of edges) e.back = e.a === e.b || pos.get(e.a) > pos.get(e.b);

  // --- depth: the longest path along forward edges (now acyclic)
  for (const n of nodes) n.depth = 0;
  for (let it = 0; it < nodes.length; it++) {
    let changed = false;
    for (const e of edges) {
      if (e.back || e.a === e.b) continue;
      if (e.b.depth < e.a.depth + 1) { e.b.depth = e.a.depth + 1; changed = true; }
    }
    if (!changed) break;
  }

  // --- capping column height.
  // Without it a wide level stretches the picture into a vertical ribbon, and
  // once fitted to the screen the text is unreadable. Capacity is chosen so
  // the graph's proportions tend towards the window's; an overflowing node
  // moves right, which keeps the left-to-right reading along forward edges.
  const avgW = nodes.reduce((s, n) => s + n.baseW, 0) / nodes.length + (level.gapX || METRIC.colGap);
  const avgH = nodes.reduce((s, n) => s + n.baseH, 0) / nodes.length + (level.gapY || METRIC.rowGap);
  const aspect = aspectOverride
    || Math.max(0.6, (cssW || 1600) / (cssH || 900));
  const capacity = Math.max(3, Math.round(Math.sqrt((nodes.length * avgW) / (avgH * aspect))));

  const topo = nodes.slice().sort((p, q) => p.depth - q.depth);   // a valid topological order
  const fill = [];
  for (const n of topo) {
    let cand = 0;
    for (const e of n.inEdges) {
      if (e.back || e.a === n) continue;
      cand = Math.max(cand, e.a.depth + 1);
    }
    while ((fill[cand] || 0) >= capacity) cand++;
    n.depth = cand;
    fill[cand] = (fill[cand] || 0) + 1;
  }

  // --- grouping into columns
  const cols = [];
  for (const n of nodes) {
    (cols[n.depth] || (cols[n.depth] = [])).push(n);
    n.col = n.depth;
  }

  // The barycentric passes need a starting arrangement to improve on.
  placeLevel(level, cols, true);

  // --- barycentric passes, which cut down edge crossings
  const bary = (n, side) => {
    const list = side === 'in' ? n.inEdges : n.outEdges;
    if (!list.length) return n.lty;
    let s = 0;
    for (const e of list) s += (side === 'in' ? e.a.lty : e.b.lty);
    return s / list.length;
  };

  for (let pass = 0; pass < 6; pass++) {
    const forward = pass % 2 === 0;
    for (let i = 0; i < cols.length; i++) {
      const c = forward ? i : cols.length - 1 - i;
      const list = cols[c];
      if (!list || list.length < 2) continue;
      const key = new Map();
      for (const n of list) key.set(n, bary(n, forward ? 'in' : 'out'));
      list.sort((p, q) => key.get(p) - key.get(q));
      placeLevel(level, cols, true);
    }
  }

  level.cols = cols;

  // --- assembly order: left to right, top to bottom
  const order = nodes.slice().sort((p, q) => (p.col - q.col) || (p.lty - q.lty));
  order.forEach((n, i) => { n.bootDelay = n.col * 0.18 + i * 0.05; });

  return level;
}

/**
 * Places a level's nodes in columns from their CURRENT sizes. Called again
 * every time a node opens or closes — this is where the picture's habit of
 * spreading apart comes from: the targets move, and the nodes travel smoothly
 * to them. snap=true puts them there at once, for the first computation.
 */
function placeLevel(level, cols, snap) {
  cols = cols || level.cols;
  if (!cols) return;

  // Column x: a column is as wide as its widest node.
  const gapX = level.gapX || METRIC.colGap;
  const gapY = level.gapY || METRIC.rowGap;

  const colW = [];
  for (let c = 0; c < cols.length; c++) {
    colW[c] = (cols[c] || []).reduce((m, n) => Math.max(m, n.w), METRIC.minW);
  }

  // --- folding a long run into bands.
  //
  // A product whose areas form a chain — content feeds broadcast feeds devices —
  // lays out as one row six columns wide. Fitted to a window that picture scales
  // down to the floor and leaves the lower half empty: six words in a field of
  // grid, which is what the reader gets to look at. Fold the run instead. The
  // reading stays left to right, it carries on below, and the cards keep a size
  // somebody can read. Only at the top level: inside an opened container the
  // panel sets the width, not the window.
  let perBand = cols.length;
  if (!level.parent && cols.length >= 4) {
    const totalW = colW.reduce((s, w) => s + w + gapX, 0) - gapX;
    const avail = Math.max(320, (cssW || 1400) - 180);
    // Below this a card is a coloured tile with a name on it; folding buys back
    // the scale that keeps its rows readable.
    const READABLE = 0.82;
    if (totalW * READABLE > avail) {
      // How many columns fit across at a readable scale. The first run is the
      // answer: every band after it gets the same count, and the last one is
      // simply shorter.
      const budget = avail / READABLE;
      let per = 0, run = 0;
      for (let c = 0; c < cols.length; c++) {
        const next = run ? run + gapX + colW[c] : colW[c];
        if (run && next > budget) break;
        run = next; per++;
      }
      perBand = Math.max(2, Math.min(cols.length, per));
    }
  }

  // Column x within its band, and the band's own vertical offset.
  const colX = [], bandOf = [];
  const bandH = [];
  for (let c = 0; c < cols.length; c++) bandOf[c] = Math.floor(c / perBand);
  for (let b = 0; b <= bandOf[cols.length - 1]; b++) {
    let x = 0, h = 0;
    for (let c = b * perBand; c < Math.min(cols.length, (b + 1) * perBand); c++) {
      colX[c] = x + colW[c] / 2;
      x += colW[c] + gapX;
      const list = cols[c] || [];
      let total = 0;
      for (const n of list) total += n.h + gapY;
      h = Math.max(h, total - gapY);
    }
    bandH[b] = h;
  }
  // Bands are separated by more than a row gap: the eye has to know it reached the
  // end of one and started the next, and a plain row gap reads as the same run.
  const bandY = [];
  let yAcc = 0;
  for (let b = 0; b < bandH.length; b++) { bandY[b] = yAcc + bandH[b] / 2; yAcc += bandH[b] + gapY * 2.2; }

  for (let c = 0; c < cols.length; c++) {
    const list = cols[c];
    if (!list) continue;
    let total = 0;
    for (const n of list) total += n.h + gapY;
    total -= gapY;
    let y = bandY[bandOf[c]] - total / 2;
    for (const n of list) {
      n.ltx = colX[c];
      n.lty = y + n.h / 2;
      y += n.h + gapY;
    }
  }

  // Centre the level on its own origin.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of level.nodes) {
    minX = Math.min(minX, n.ltx - n.w / 2); maxX = Math.max(maxX, n.ltx + n.w / 2);
    minY = Math.min(minY, n.lty - n.h / 2); maxY = Math.max(maxY, n.lty + n.h / 2);
  }
  const ox = (minX + maxX) / 2, oy = (minY + maxY) / 2;
  for (const n of level.nodes) { n.ltx -= ox; n.lty -= oy; }

  level.w = maxX - minX;
  level.h = maxY - minY;

  if (snap) for (const n of level.nodes) { n.lx = n.ltx; n.ly = n.lty; }
}

/* --- edge routing -------------------------------------------------------- */

const EDGE_SEGMENTS = 44;

/** Attachment points, horizontal or vertical, whichever is the shorter run. */
function edgeAnchors(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const horizontal = Math.abs(dx) > Math.abs(dy) * 0.75;

  if (horizontal) {
    const s = dx >= 0 ? 1 : -1;
    return {
      p1x: a.x + (s * a.w) / 2, p1y: a.y, d1x: s, d1y: 0,
      p2x: b.x - (s * b.w) / 2, p2y: b.y, d2x: -s, d2y: 0,
    };
  }
  const s = dy >= 0 ? 1 : -1;
  return {
    p1x: a.x, p1y: a.y + (s * a.h) / 2, d1x: 0, d1y: s,
    p2x: b.x, p2y: b.y - (s * b.h) / 2, d2x: 0, d2y: -s,
  };
}

function rebuildEdge(e) {
  let an, k;

  if (e.back) {
    // A feedback edge runs against the flow. Routed straight, it would stitch
    // through every panel between its ends, so it is taken underneath instead —
    // a separate bus that skirts the picture along the bottom.
    an = {
      p1x: e.a.x, p1y: e.a.y + e.a.h / 2, d1x: 0, d1y: 1,
      p2x: e.b.x, p2y: e.b.y + e.b.h / 2, d2x: 0, d2y: 1,
    };
    k = clamp(Math.abs(e.b.x - e.a.x) * 0.34 + 60, 110, 210);
  } else {
    an = edgeAnchors(e.a, e.b);
    const dist = Math.hypot(an.p2x - an.p1x, an.p2y - an.p1y);
    k = clamp(dist * 0.42, 46, 210);
  }

  const c1x = an.p1x + an.d1x * k, c1y = an.p1y + an.d1y * k;
  const c2x = an.p2x + an.d2x * k, c2y = an.p2y + an.d2y * k;

  const pts = e.pts;
  pts.length = 0;
  for (let i = 0; i <= EDGE_SEGMENTS; i++) {
    const t = i / EDGE_SEGMENTS;
    const u = 1 - t;
    const w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
    pts.push({
      x: w0 * an.p1x + w1 * c1x + w2 * c2x + w3 * an.p2x,
      y: w0 * an.p1y + w1 * c1y + w2 * c2y + w3 * an.p2y,
    });
  }

  const cum = e.cum;
  cum.length = 0;
  cum.push(0);
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    cum.push(total);
  }
  e.len = total;
  e.endDirX = an.d2x; e.endDirY = an.d2y;

  // Bypass arcs reach well beyond the panels, so remember their extent or
  // fitting to the screen would cut them off.
  if (e.back) {
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { if (p.y < lo) lo = p.y; if (p.y > hi) hi = p.y; }
    e.minY = lo; e.maxY = hi;
  } else {
    e.minY = e.maxY = null;
  }
  e.dirty = false;
}

/** A point at 0..1 along an edge by length, not by curve parameter. */
function pointAtLen(e, s) {
  const target = clamp(s, 0, 1) * e.len;
  const cum = e.cum;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= target) lo = mid; else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1;
  const t = (target - cum[lo]) / seg;
  const p = e.pts[lo], q = e.pts[hi];
  return { x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t), dx: q.x - p.x, dy: q.y - p.y };
}

/* =============================================================================
 * 6. CAMERA
 * ========================================================================== */

const cam = {
  x: 0, y: 0, scale: 1,
  tx: 0, ty: 0, tscale: 1,   // the targets it eases towards
};

let cssW = 1, cssH = 1;

function worldToScreen(wx, wy) {
  return {
    x: (wx - cam.x) * cam.scale + cssW / 2,
    y: (wy - cam.y) * cam.scale + cssH / 2,
  };
}

function screenToWorld(sx, sy) {
  return {
    x: (sx - cssW / 2) / cam.scale + cam.x,
    y: (sy - cssH / 2) / cam.scale + cam.y,
  };
}

function graphBounds(pad = 0) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.w / 2); maxX = Math.max(maxX, n.x + n.w / 2);
    minY = Math.min(minY, n.y - n.h / 2); maxY = Math.max(maxY, n.y + n.h / 2);
  }
  // Bypass arcs dip far below the panels. Count them only partly, or the
  // picture is pushed to the edge of the screen to make room for empty space.
  let bowTop = minY, bowBot = maxY;
  for (const e of edges) {
    if (e.maxY == null) continue;
    bowTop = Math.min(bowTop, e.minY);
    bowBot = Math.max(bowBot, e.maxY);
  }
  minY += (bowTop - minY) * 0.4;
  maxY += (bowBot - maxY) * 0.4;
  return { minX: minX - pad, maxX: maxX + pad, minY: minY - pad, maxY: maxY + pad };
}

function fitView(instant = false) {
  const b = graphBounds(90);
  const w = b.maxX - b.minX, h = b.maxY - b.minY;

  // A scene may take part of the screen for its own panels: fit into what is
  // left, or the graph slides underneath them.
  const ins = (SCENE && SCENE.viewInset) || {};
  const availW = Math.max(200, cssW - (ins.left || 0) - (ins.right || 0));
  const availH = Math.max(200, cssH - (ins.top || 0) - (ins.bottom || 0));
  // Fitting everything is not the goal — being able to read it is. Below the
  // floor a card is a coloured tile with a name on it and nothing else, so
  // shrinking further buys no information; the view stops there and the rest is
  // one drag away.
  const floor = (SCENE && SCENE.fitFloor != null) ? SCENE.fitFloor : 0.55;
  const s = clamp(Math.min(availW / w, availH / h), floor, 1.6);

  // The centre of the free area, in world coordinates.
  const shiftX = ((ins.left || 0) - (ins.right || 0)) / 2 / s;
  const shiftY = ((ins.top || 0) - (ins.bottom || 0)) / 2 / s;
  cam.tx = (b.minX + b.maxX) / 2 - shiftX;
  cam.ty = (b.minY + b.maxY) / 2 - shiftY;
  cam.tscale = s;
  if (instant) { cam.x = cam.tx; cam.y = cam.ty; cam.scale = cam.tscale; }
}

/* =============================================================================
 * 7. RENDER TARGETS
 * ========================================================================== */

const out = view.getContext('2d', { alpha: false, desynchronized: true });

let DPR = 1, W = 1, H = 1;

function makeRT(w, h, alpha = false) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w | 0);
  c.height = Math.max(1, h | 0);
  const x = c.getContext('2d', { alpha });
  return { c, x, w: c.width, h: c.height };
}

const RT = {
  scene: null,
  levels: [],     // the bloom pyramid
  tint: [],       // R/G/B copies for chromatic aberration
  chroma: null,   // those channels merged back into one layer
  half: null,     // the bright-pass intermediate
  streak: null,   // the anamorphic horizontal flare
  overlay: null,  // the static layer: scanlines and vignette
};

const BLOOM_LEVELS = 6;

function resize() {
  // The panel decides the size, not the window: this canvas is one element on a
  // page, and CSS may give it any box at all.
  const box = view.parentNode && view.parentNode.getBoundingClientRect
    ? view.parentNode.getBoundingClientRect() : null;
  cssW = Math.max(1, Math.round((box && box.width) || view.clientWidth || 800));
  cssH = Math.max(1, Math.round((box && box.height) || view.clientHeight || 500));
  DPR = clamp(window.devicePixelRatio || 1, 1, 2);
  W = Math.round(cssW * DPR);
  H = Math.round(cssH * DPR);

  view.width = W;
  view.height = H;
  view.style.width = cssW + 'px';
  view.style.height = cssH + 'px';

  RT.scene = makeRT(W, H);

  RT.levels.length = 0;
  let lw = Math.max(2, W >> 1), lh = Math.max(2, H >> 1);
  for (let i = 0; i < BLOOM_LEVELS; i++) {
    RT.levels.push(makeRT(lw, lh));
    lw = Math.max(2, lw >> 1);
    lh = Math.max(2, lh >> 1);
  }

  // Aberration channels are taken at quarter resolution: bloom is blurred
  // anyway, and three full-size tints would cost a visible slice of the frame.
  const l0 = RT.levels[0];
  const l1 = RT.levels[1];
  const l2 = RT.levels[2];
  RT.tint = [makeRT(l2.w, l2.h), makeRT(l2.w, l2.h), makeRT(l2.w, l2.h)];
  RT.chroma = makeRT(l1.w, l1.h);
  RT.half = makeRT(l0.w, l0.h);
  RT.streak = makeRT(RT.levels[3].w, RT.levels[3].h);
  RT.overlay = makeRT(W, H, true);

  buildGrainTiles();
  buildOverlay();
}

/**
 * The vignette never changes, so it is baked into its own layer: one
 * drawImage per frame instead of a full-screen gradient.
 *
 * There are deliberately no global scanlines: a dark grille over the whole
 * frame ate the readability of the text in the panels. The sense of a sweep
 * comes from moving lines inside the panels instead — light, not smothering.
 */
function buildOverlay() {
  const o = RT.overlay;
  const x = o.x;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalCompositeOperation = 'source-over';
  x.globalAlpha = 1;
  x.clearRect(0, 0, o.w, o.h);

  const vg = x.createRadialGradient(o.w / 2, o.h / 2, Math.min(o.w, o.h) * 0.30,
                                    o.w / 2, o.h / 2, Math.max(o.w, o.h) * 0.78);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(0.7, 'rgba(0,0,0,0.28)');
  vg.addColorStop(1, 'rgba(0,0,0,0.74)');
  x.fillStyle = vg;
  x.fillRect(0, 0, o.w, o.h);
}

/* =============================================================================
 * 8. SHAPE PRIMITIVES
 * ========================================================================== */

/** A chamfered rectangle: the basic shape of a HUD panel. */
function chamferPath(ctx, x, y, w, h, c, corners) {
  const tl = !corners || corners[0], tr = !corners || corners[1];
  const br = !corners || corners[2], bl = !corners || corners[3];
  const cc = Math.min(c, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + (tl ? cc : 0), y);
  ctx.lineTo(x + w - (tr ? cc : 0), y);
  if (tr) ctx.lineTo(x + w, y + cc);
  ctx.lineTo(x + w, y + h - (br ? cc : 0));
  if (br) ctx.lineTo(x + w - cc, y + h);
  ctx.lineTo(x + (bl ? cc : 0), y + h);
  if (bl) ctx.lineTo(x, y + h - cc);
  ctx.lineTo(x, y + (tl ? cc : 0));
  if (tl) ctx.lineTo(x + cc, y);
  ctx.closePath();
}

/** Corner brackets, the targeting marks around a panel. */
function cornerBrackets(ctx, x, y, w, h, len, gap) {
  const L = Math.min(len, w / 2 - 2, h / 2 - 2);
  const X0 = x - gap, Y0 = y - gap, X1 = x + w + gap, Y1 = y + h + gap;
  ctx.beginPath();
  ctx.moveTo(X0, Y0 + L); ctx.lineTo(X0, Y0); ctx.lineTo(X0 + L, Y0);
  ctx.moveTo(X1 - L, Y0); ctx.lineTo(X1, Y0); ctx.lineTo(X1, Y0 + L);
  ctx.moveTo(X1, Y1 - L); ctx.lineTo(X1, Y1); ctx.lineTo(X1 - L, Y1);
  ctx.moveTo(X0 + L, Y1); ctx.lineTo(X0, Y1); ctx.lineTo(X0, Y1 - L);
  ctx.stroke();
}

/** Intersection of clip rectangles, for text on nested levels. */
function clipIntersect(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** The dotted leader between a label and its value. */
function leaderDots(ctx, x0, x1, y, step, color) {
  if (x1 - x0 < step) return;
  ctx.fillStyle = color;
  for (let x = x0; x < x1; x += step) ctx.fillRect(x, y, 1, 1);
}

/* --- pre-rendered glow --------------------------------------------------- */

// A radial gradient per glowing point is far too expensive — there are close
// to a hundred in a frame. Keep ready-made sprites per colour instead; the
// colour is quantised, so the cache stays tiny.
const glowCache = new Map();

function glowSprite(c) {
  const key = `${c[0] >> 4}|${c[1] >> 4}|${c[2] >> 4}`;
  let sprite = glowCache.get(key);
  if (sprite) return sprite;

  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const x = cv.getContext('2d');
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, `rgba(255,255,255,1)`);
  g.addColorStop(0.14, rgba(mix(c, C.paper, 0.7), 0.85));
  g.addColorStop(0.34, rgba(c, 0.38));
  g.addColorStop(0.62, rgba(c, 0.10));
  g.addColorStop(1, rgba(c, 0));
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);

  glowCache.set(key, cv);
  return cv;
}

/**
 * A glowing dot of radius r. Expects 'lighter' composition.
 * Alpha multiplies with the current one rather than replacing it: nested
 * levels fade in through the global alpha, and resetting it would flare them.
 */
function drawGlow(ctx, x, y, r, color, alpha) {
  if (r <= 0 || alpha <= 0.004) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;
  ctx.drawImage(glowSprite(color), x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = prev;
}

/* =============================================================================
 * 9. BACKGROUND
 * ========================================================================== */

function drawBackground(ctx, t) {
  // Base fill plus a soft light in the middle.
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#02060b';
  ctx.fillRect(0, 0, cssW, cssH);

  const g = ctx.createRadialGradient(
    cssW * 0.5, cssH * 0.52, 0,
    cssW * 0.5, cssH * 0.52, Math.max(cssW, cssH) * 0.72
  );
  g.addColorStop(0, 'rgba(18,64,104,0.42)');
  g.addColorStop(0.45, 'rgba(9,32,58,0.20)');
  g.addColorStop(1, 'rgba(2,6,11,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, cssW, cssH);
}

/** A world grid with an adaptive step, which anchors the sense of scale. */
function drawGrid(ctx, t) {
  if (!FLAGS.grid) return;

  let step = 40;
  while (step * cam.scale < 22) step *= 4;
  const major = step * 5;

  const tl = screenToWorld(0, 0);
  const br = screenToWorld(cssW, cssH);

  const x0 = Math.floor(tl.x / step) * step;
  const y0 = Math.floor(tl.y / step) * step;

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.lineWidth = 1;

  // The fine grid.
  ctx.beginPath();
  for (let wx = x0; wx <= br.x; wx += step) {
    const sx = Math.round((wx - cam.x) * cam.scale + cssW / 2) + 0.5;
    ctx.moveTo(sx, 0); ctx.lineTo(sx, cssH);
  }
  for (let wy = y0; wy <= br.y; wy += step) {
    const sy = Math.round((wy - cam.y) * cam.scale + cssH / 2) + 0.5;
    ctx.moveTo(0, sy); ctx.lineTo(cssW, sy);
  }
  ctx.strokeStyle = 'rgba(70,168,214,0.055)';
  ctx.stroke();

  // The coarse grid.
  ctx.beginPath();
  const mx0 = Math.floor(tl.x / major) * major;
  const my0 = Math.floor(tl.y / major) * major;
  for (let wx = mx0; wx <= br.x; wx += major) {
    const sx = Math.round((wx - cam.x) * cam.scale + cssW / 2) + 0.5;
    ctx.moveTo(sx, 0); ctx.lineTo(sx, cssH);
  }
  for (let wy = my0; wy <= br.y; wy += major) {
    const sy = Math.round((wy - cam.y) * cam.scale + cssH / 2) + 0.5;
    ctx.moveTo(0, sy); ctx.lineTo(cssW, sy);
  }
  ctx.strokeStyle = 'rgba(88,200,255,0.10)';
  ctx.stroke();
}

/** Concentric rings and turning ticks: the projector's table. */
function drawRings(ctx, t) {
  if (!FLAGS.grid) return;
  const c = worldToScreen(0, 0);
  const base = 320 * cam.scale;

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.save();
  ctx.translate(c.x, c.y);

  for (let i = 0; i < 4; i++) {
    const r = base * (0.55 + i * 0.42);
    if (r < 12 || r > Math.max(cssW, cssH) * 1.6) continue;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.strokeStyle = `rgba(90,200,255,${0.05 - i * 0.008})`;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Ticks around the ring.
    const dir = i % 2 === 0 ? 1 : -1;
    const rot = t * 0.055 * dir + i;
    const count = 48;
    ctx.beginPath();
    for (let k = 0; k < count; k++) {
      const a = rot + (k / count) * TAU;
      const long = k % 6 === 0;
      const r1 = r, r2 = r + (long ? 8 : 3);
      ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
    }
    ctx.strokeStyle = `rgba(96,232,255,${0.07 - i * 0.012})`;
    ctx.stroke();
  }
  ctx.restore();
}

/* --- atmospheric dust ----------------------------------------------------- */

const dust = (() => {
  const rnd = mulberry32(7777);
  const arr = [];
  for (let i = 0; i < 260; i++) {
    arr.push({
      x: (rnd() * 2 - 1) * 2400,
      y: (rnd() * 2 - 1) * 1500,
      z: 0.35 + rnd() * 0.9,           // parallax depth
      s: 0.5 + rnd() * 1.6,
      ph: rnd() * TAU,
      sp: 0.1 + rnd() * 0.35,
    });
  }
  return arr;
})();

function drawDust(ctx, t) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  for (const d of dust) {
    const wy = d.y + Math.sin(t * d.sp + d.ph) * 26;
    const wx = d.x + Math.cos(t * d.sp * 0.7 + d.ph) * 18;
    // Parallax: distant motes move with the camera more slowly.
    const sx = (wx - cam.x * d.z) * cam.scale + cssW / 2;
    const sy = (wy - cam.y * d.z) * cam.scale + cssH / 2;
    if (sx < -20 || sx > cssW + 20 || sy < -20 || sy > cssH + 20) continue;
    const a = 0.10 + 0.16 * (Math.sin(t * 1.6 + d.ph) * 0.5 + 0.5);
    ctx.fillStyle = `rgba(140,225,255,${a * d.z * 0.8})`;
    const s = d.s * clamp(cam.scale, 0.5, 1.4);
    ctx.fillRect(sx, sy, s, s);
  }
}

/* =============================================================================
 * 10. EDGES
 * ========================================================================== */

function drawEdge(ctx, e, t) {
  const p = e.boot;
  if (p <= 0.001) return;

  const pts = e.pts;
  const n = pts.length;
  const shown = Math.max(2, Math.ceil((n - 1) * easeOutCubic(p)) + 1);

  const focus = e.hover;
  const dim = e.dim;
  const ca = e.a.color, cb = e.b.color;

  const s1 = worldToScreen(pts[0].x, pts[0].y);
  const s2 = worldToScreen(pts[n - 1].x, pts[n - 1].y);

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // The path is built once and stroked three times — core plus halo — which
  // avoids an expensive shadowBlur. The coordinate transform is inlined by
  // hand: a frame carries close to a thousand points, and the objects
  const kx = cam.scale;
  const offX = cssW / 2 - cam.x * kx;
  const offY = cssH / 2 - cam.y * kx;

  ctx.beginPath();
  ctx.moveTo(pts[0].x * kx + offX, pts[0].y * kx + offY);
  for (let i = 1; i < shown; i++) {
    ctx.lineTo(pts[i].x * kx + offX, pts[i].y * kx + offY);
  }

  const flick = 0.9 + 0.1 * noiseA(t * 2.2 + e.seed);
  const mid = mix(ca, cb, 0.5);

  // 1) the wide halo
  ctx.strokeStyle = rgba(mid, 0.16 * dim * flick * (1 + focus));
  ctx.lineWidth = (3.4 + focus * 3.2) * clamp(cam.scale, 0.5, 1.5);
  ctx.stroke();

  // 2) the middle layer
  ctx.strokeStyle = rgba(mid, 0.42 * dim * (0.7 + focus * 0.5));
  ctx.lineWidth = (1.5 + focus * 1.1) * clamp(cam.scale, 0.55, 1.4);
  ctx.stroke();

  // 3) the bright core, where a gradient is visible and so is kept
  const grad = ctx.createLinearGradient(s1.x, s1.y, s2.x, s2.y);
  grad.addColorStop(0, rgba(mix(ca, C.ice, 0.55), (0.55 + focus * 0.45) * dim));
  grad.addColorStop(1, rgba(mix(cb, C.ice, 0.55), (0.55 + focus * 0.45) * dim));
  ctx.strokeStyle = grad;
  ctx.lineWidth = 0.85 * clamp(cam.scale, 0.6, 1.3);
  ctx.stroke();

  // A running dash on top, for the sense of flow.
  if (cam.scale > 0.4) {
    ctx.save();
    ctx.setLineDash([2.5, 9]);
    ctx.lineDashOffset = -t * 34 - e.seed;
    ctx.strokeStyle = rgba(C.ice, 0.30 * dim * (0.5 + focus));
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.restore();
  }

  if (p < 0.999) return;

  // The arrowhead.
  const tip = pointAtLen(e, 1);
  const tp = worldToScreen(tip.x, tip.y);
  const ang = Math.atan2(-e.endDirY, -e.endDirX);
  const size = (6 + focus * 3) * clamp(cam.scale, 0.5, 1.3);
  ctx.save();
  ctx.translate(tp.x, tp.y);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(2, 0);
  ctx.lineTo(-size, -size * 0.5);
  ctx.lineTo(-size * 0.62, 0);
  ctx.lineTo(-size, size * 0.5);
  ctx.closePath();
  ctx.fillStyle = rgba(mix(cb, C.ice, 0.4), (0.75 + focus * 0.25) * dim);
  ctx.fill();
  ctx.restore();

  // The edge label. Two things were wrong with it: 7.5 screen pixels, which is
  // present rather than readable, and always at the exact middle of the line —
  // which on a laid-out graph lands on a card about as often as not, so it
  // either vanished under one or sat across its text.
  const labelZoom = FLAGS.labels ? 0.42 : 0.72;
  if (e.label && cam.scale > labelZoom && (focus > 0.02 || FLAGS.labels)) {
    const a = (FLAGS.labels ? 0.72 : 0.34) + focus * 0.28;
    const size = 10.5;
    // "POST /api/v1/media/:id/broadcast" is wider than the gap between two
    // neighbouring cards, so at full length it can only ever be printed across
    // one of them. Cut it to what the gap holds — a shortened label still names
    // the thing, a label lying over a card's rows destroys both.
    const gap = Math.abs(worldToScreen(e.b.x, e.b.y).x - worldToScreen(e.a.x, e.a.y).x)
      - (e.a.w + e.b.w) / 2 * cam.scale;
    const room = Math.max(64, gap - 14);
    let label = e.label;
    if (textWidth(label, size, 600, 0.5) > room) {
      while (label.length > 6 && textWidth(label + '…', size, 600, 0.5) > room) label = label.slice(0, -1);
      label = label.length > 6 ? label + '…' : e.label;   // too tight to shorten usefully
    }
    const tw = textWidth(label, size, 600, 0.5);
    const hw = tw / 2 + 6, hh = 9;

    // Somewhere along the line that is clear of the cards and of the labels
    // already placed. Two labels on the same spot is mush — three "reads" stacked
    // on each other say less than one. Sitting on a card is survivable, since the
    // chip is opaque; sitting on another label is not, so that is the rule that
    // never bends.
    const AT = [0.5, 0.44, 0.56, 0.38, 0.62, 0.32, 0.68, 0.26, 0.74, 0.2, 0.8, 0.14, 0.86];
    let mp = null;
    for (const at of AT) {
      const q = pointAtLen(e, at);
      const s = worldToScreen(q.x, q.y);
      if (!boxHitsLabel(s.x - hw, s.y - hh, hw * 2, hh * 2)
          && !boxHitsNode(s.x - hw, s.y - hh, hw * 2, hh * 2)) { mp = s; break; }
    }
    // An edge that spans several layers passes over every card between its ends,
    // so on a flat chain no point along the line is ever clear. Step off the line
    // instead: the band above and below it is empty, and a label a few pixels off
    // its own edge still reads as belonging to it.
    if (!mp) {
      const OFF = [-1, 1].flatMap((s) => [hh * 2.4, hh * 4.2, hh * 6].map((d) => s * d));
      outer:
      for (const at of [0.5, 0.38, 0.62, 0.28, 0.72]) {
        const q = pointAtLen(e, at);
        const s = worldToScreen(q.x, q.y);
        for (const dy of OFF) {
          if (!boxHitsLabel(s.x - hw, s.y + dy - hh, hw * 2, hh * 2)
              && !boxHitsNode(s.x - hw, s.y + dy - hh, hw * 2, hh * 2)) {
            mp = { x: s.x, y: s.y + dy }; break outer;
          }
        }
      }
    }
    // Nowhere clear at all. Saying nothing beats printing it across a card: the
    // card's own name is the more useful of the two, and one unreadable word on
    // top of another is worse than either alone.
    if (!mp) return;
    // Queued, not drawn: panels are painted after the edges, so a label drawn
    // here would end up underneath one.
    edgeLabels.push({ x: mp.x, y: mp.y, hw, hh, size, text: label, a: a * dim, cb });
  }
}

// Edge labels, held back until the panels are down.
const edgeLabels = [];
function boxHitsLabel(x, y, w, h) {
  for (const L of edgeLabels) {
    if (x < L.x + L.hw && x + w > L.x - L.hw && y < L.y + L.hh && y + h > L.y - L.hh) return true;
  }
  return false;
}
function flushEdgeLabels(ctx) {
  for (const L of edgeLabels) {
    // Opaque, always. The alpha belongs to the text: a backing that fades lets the
    // card underneath print through, which is exactly the mush this is here to stop.
    ctx.fillStyle = 'rgba(3,9,17,0.97)';
    ctx.fillRect(L.x - L.hw, L.y - L.hh, L.hw * 2, L.hh * 2);
    ctx.strokeStyle = rgba(L.cb, 0.5 * L.a);
    ctx.lineWidth = 1;
    ctx.strokeRect(L.x - L.hw + 0.5, L.y - L.hh + 0.5, L.hw * 2 - 1, L.hh * 2 - 1);
    drawText(ctx, L.text, L.x, L.y, {
      size: L.size, weight: 600, tracking: 0.5, align: 'center',
      color: rgba(C.ice, Math.min(1, 0.95 * L.a + 0.2)),
    });
  }
  edgeLabels.length = 0;
}

/**
 * Does this screen-space box land on a card? The two the edge belongs to do not
 * count — a label near its own ends is exactly where it should be.
 */
function boxHitsNode(x, y, w, h, skipA, skipB) {
  for (const n of allNodes) {
    if (n === skipA || n === skipB) continue;
    if (n.boot < 0.4 || n.dim < 0.15) continue;
    // An opened container is a frame, not a surface. Counting its box as solid
    // marked every point inside it as taken, so no label inside one could ever
    // find a free spot and they all fell back to landing on the cards.
    if (n.expanded || n.expandT > 0.5) continue;
    const c = worldToScreen(n.x, n.y);
    const s = cam.scale;
    const nx = c.x - (n.w / 2) * s, ny = c.y - (n.h / 2) * s;
    const nw = n.w * s, nh = n.h * s;
    if (x < nx + nw && x + w > nx && y < ny + nh && y + h > ny) return true;
  }
  return false;
}

/** Data packets: glowing segments that run along the edges. */
function drawPackets(ctx, e, t, dt) {
  if (e.boot < 0.999 || e.len < 1) return;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.lineCap = 'round';

  for (const pk of e.packets) {
    pk.t += (pk.speed * dt * (1 + e.hover * 1.2)) / Math.max(0.35, e.len / 260);
    if (pk.t > 1) pk.t -= 1 + Math.random() * 0.4;
    if (pk.t < 0) continue;

    const tail = 0.06;
    const t0 = clamp(pk.t - tail, 0, 1);
    const t1 = clamp(pk.t, 0, 1);
    if (t1 - t0 < 0.002) continue;

    const steps = 7;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const s = lerp(t0, t1, i / steps);
      const p = pointAtLen(e, s);
      const sp = worldToScreen(p.x, p.y);
      if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
    }
    const head = pointAtLen(e, t1);
    const hp = worldToScreen(head.x, head.y);

    const col = mix(e.a.color, e.b.color, t1);
    const k = clamp(cam.scale, 0.5, 1.4) * pk.size * e.dim;

    ctx.strokeStyle = rgba(mix(col, C.ice, 0.5), 0.55 * e.dim);
    ctx.lineWidth = 2.2 * k;
    ctx.stroke();

    ctx.strokeStyle = rgba(C.paper, 0.9 * e.dim);
    ctx.lineWidth = 0.9 * k;
    ctx.stroke();

    // The packet's leading edge, with its glow.
    const r = 2.6 * k;
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, hp.x, hp.y, r * 4, col, 0.85 * e.dim);
    ctx.globalCompositeOperation = 'source-over';
  }
}

/* =============================================================================
 * 11. NODES
 * ========================================================================== */

/**
 * A node assembles in phases, like a hologram unfolding:
 *   0.00-0.30  a horizontal line opens from the centre
 *   0.20-0.55  the frame gains height
 *   0.45-0.75  fill, header and dividers appear
 *   0.62-1.00  the text types itself in, line by line
 */
function drawNode(ctx, n, t, dt) {
  const p = n.boot;
  if (p <= 0.001) return;

  const pa = easeOutCubic(invLerp(0.00, 0.30, p));
  const pb = easeOutCubic(invLerp(0.20, 0.55, p));
  const pc = invLerp(0.45, 0.75, p);
  const pd = invLerp(0.62, 1.00, p);

  // A node the active layer does not reach is pushed back, though never out of
  // sight — it is still part of the product, just not part of the answer.
  // Out of the layer's reach is a step back, not a disappearance — the words on
  // those cards still have to be readable, or the picture answers one question
  // by destroying every other one.
  // What the layer does not reach recedes hard. This was softened once because a
  // layer left everything unreadable — but that was when dimming faded a card to
  // transparent. A card dims by darkening now, so it stays legible while clearly
  // being outside the answer, and "what does this reach" is a question whose
  // answer has to be visible without reading a single label.
  const dim = n.dim * (n.heat != null && n.heat <= 0.001 ? 0.45 : 1);
  const foc = Math.max(n.hover, n.select);

  // The node's holographic breathing. Kept at the edge of noticeable: any
  // stronger and the text inside starts to tremble as you read it.
  const jx = noiseA(t * 0.55 + n.seed) * 0.28;
  const jy = noiseB(t * 0.65 + n.seed) * 0.28;
  const flick = 0.955 + 0.045 * (noiseC(t * 1.5 + n.seed) * 0.5 + 0.5);

  const cw = n.w * pa;
  const ch = n.h * pb;

  const c = worldToScreen(n.x + jx, n.y + jy);
  const s = cam.scale;
  // Hovering opens room inside the card for its own controls, rather than
  // loading two meanings onto one click. Everything drawn below derives from
  // x/y/w/h, so widening them here widens the whole card with no other change.
  // An opened container is a frame around a picture, not a card. Growing it on
  // hover the way a collapsed card grows makes it jump, and everything laid out
  // inside it jumps with it.
  const grow = (n.expanded || n.expandT > 0.02) ? 0 : easeOutCubic(n.hover);
  // Detail is dropped for the crowd, not for the one being looked at: the card
  // under the pointer shows itself in full, controls included. Without this the
  // controls were unreachable on exactly the diagrams that need them — a dense
  // one fits at 55%, which is under the threshold.
  const compact = s < LOD_ROWS && n.hover < 0.5;
  const gw = grow * HOVER_GROW_W * s;
  const gh = grow * HOVER_GROW_H * s;
  const x = c.x - (cw * s + gw) / 2;
  const y = c.y - (ch * s + gh) / 2;
  const w = cw * s + gw;
  const h = ch * s + gh;

  // Clip to the screen.
  if (x > cssW + 200 || x + w < -200 || y > cssH + 200 || y + h < -200) return;

  const col = n.color;
  const acc = n.accent;
  const alpha = dim * flick;

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.lineJoin = 'miter';

  // --- phase 1: the opening line
  if (pb < 0.02) {
    ctx.beginPath();
    ctx.moveTo(c.x - (w / 2), c.y);
    ctx.lineTo(c.x + (w / 2), c.y);
    ctx.strokeStyle = rgba(acc, 0.9 * alpha);
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.strokeStyle = rgba(col, 0.28 * alpha);
    ctx.lineWidth = 5;
    ctx.stroke();
    return;
  }

  const ch1 = Math.min(11 * s, h / 2, w / 2);

  // An opened container is a frame around a nested picture, not a glowing
  // panel. Its own fill and halo are damped, or a plate that size pushes
  // bloom into blowout and drowns what is inside it.
  const openK = (n.sub || n.leaf) ? easeInOutCubic(n.expandT) : 0;
  const fillK = 1 - openK * 0.74;

  // Glow is damped as the view pulls back. At a distance the halo of every card
  // merges with its neighbours' into one wash, and the edge of a node stops
  // being visible before its name does.
  const glowScale = clamp((s - 0.28) / 0.5, 0.25, 1);

  // --- backing: a soft glow beneath the panel
  if ((foc > 0.01 || n.kind === 'core') && openK < 0.98) {
    const k = (n.kind === 'core' ? 0.5 : 0) + foc * 1.5;
    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, c.x, c.y, Math.max(w, h) * 0.85, col,
             0.20 * k * alpha * n.glowK * glowScale * (1 - openK));
    ctx.globalCompositeOperation = 'source-over';
  }

  // --- the body.
  // A dense dark backing first: edges pass beneath the panels, and without it
  // they show through the rows of data and strike the text out. Some light
  // still gets through — a panel should stay glass rather than become card.
  chamferPath(ctx, x, y, w, h, ch1, [true, false, true, false]);
  // Opaque, always. Dimming used to fade this out, which let the edges running
  // beneath the card show straight through it — a dimmed card should be darker,
  // not see-through. So the colour goes darker with dim while the fill stays solid.
  // Dark enough for light text to sit on. Everything laid over this — the hue
  // wash, the sheen, the scanlines, the header band — adds brightness, and they
  // add up: the card ended up bright enough to fight the words on it.
  const bd = Math.round(2 + 3 * dim), bg2 = Math.round(6 + 3 * dim), bb = Math.round(12 + 5 * dim);
  ctx.fillStyle = `rgba(${bd},${bg2},${bb},${0.99 * pc})`;
  ctx.fill();

  const body = ctx.createLinearGradient(0, y, 0, y + h);
  body.addColorStop(0, rgba(col, (0.075 + foc * 0.07) * pc * alpha * fillK));
  body.addColorStop(0.5, rgba(col, (0.022 + foc * 0.035) * pc * alpha * fillK));
  body.addColorStop(1, rgba(col, (0.045 + foc * 0.05) * pc * alpha * fillK));
  ctx.fillStyle = body;
  ctx.fill();

  // The layer's wash. The reading has to be the picture, not a word in a row:
  // bright where the layer lands, and the untouched cards step back so the
  // shape of what it reaches is visible without reading anything.
  if (n.heat != null) {
    // A wash bright enough to be read as intensity is also bright enough to
    // swallow the labels sitting on it — the first attempt left ORDERS showing
    // its numbers and none of the words. So the fill stays faint and in the
    // card's own hue, and the reading is carried by a bar down the edge, which
    // has no text on it to ruin.
    chamferPath(ctx, x, y, w, h, ch1, [true, false, true, false]);
    ctx.fillStyle = rgba(col, (0.02 + n.heat * 0.085) * pc * alpha);
    ctx.fill();
    if (n.heat > 0.001) {
      ctx.save();
      chamferPath(ctx, x, y, w, h, ch1, [true, false, true, false]);
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      const barW = Math.max(3, 4.5 * s);   // legible when zoomed out, where the answer is read
      ctx.fillStyle = rgba(acc, (0.42 + n.heat * 0.58) * pc * alpha);
      ctx.fillRect(x, y, barW, h);
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
    }
  }

  // A thin inner film: the glassy highlight along the top edge.
  ctx.save();
  ctx.clip();
  const sheen = ctx.createLinearGradient(x, y, x + w * 0.4, y + h);
  sheen.addColorStop(0, rgba(C.ice, 0.045 * pc * alpha * fillK));
  sheen.addColorStop(0.4, rgba(C.ice, 0));
  ctx.fillStyle = sheen;
  ctx.fillRect(x, y, w, h);

  // Inner scanlines, crawling slowly upwards.
  if (s > 0.35) {
    const period = 4 * s;
    const off = ((-t * 22 * s) % period + period) % period;
    ctx.fillStyle = rgba(col, 0.028 * pc * alpha * fillK);
    for (let yy = y + off; yy < y + h; yy += period) {
      ctx.fillRect(x, Math.round(yy), w, Math.max(1, s * 0.9));
    }
  }

  // A wave of light passing over, as if the panel were being scanned.
  const wavePos = ((t * 0.42 + n.seed * 0.37) % 2.2) / 2.2;
  if (wavePos < 1) {
    const wy = y + h * wavePos;
    const wg = ctx.createLinearGradient(0, wy - 22 * s, 0, wy + 22 * s);
    wg.addColorStop(0, rgba(acc, 0));
    wg.addColorStop(0.5, rgba(acc, 0.16 * pc * alpha * fillK));
    wg.addColorStop(1, rgba(acc, 0));
    ctx.fillStyle = wg;
    ctx.fillRect(x, wy - 22 * s, w, 44 * s);
  }
  ctx.restore();

  // --- the frame
  chamferPath(ctx, x, y, w, h, ch1, [true, false, true, false]);
  // The wide stroke is the frame's own halo. Its width is in screen pixels, so
  // pulled back it stops being an outline and becomes the loudest thing in the
  // picture — thirty of them merge into a single glare.
  ctx.strokeStyle = rgba(col, (0.30 + foc * 0.35) * alpha * glowScale);
  ctx.lineWidth = 1.4 + 1.8 * glowScale;
  ctx.stroke();
  ctx.strokeStyle = rgba(mix(col, acc, 0.6), (0.85 + foc * 0.15) * alpha);
  ctx.lineWidth = 1.15;
  ctx.stroke();

  // --- corner brackets
  ctx.strokeStyle = rgba(acc, (0.45 + foc * 0.55) * alpha * pb);
  ctx.lineWidth = 1.3;
  cornerBrackets(ctx, x, y, w, h, 12 * s, (3 + foc * 4) * s);

  // A scene may mark a node over its frame — a trace of what an agent did.
  if (SCENE.decorateNode) SCENE.decorateNode(ctx, n, { x, y, w, h, s, alpha }, t);

  // The outer targeting outline on hover.
  if (foc > 0.01) {
    const g2 = (10 + Math.sin(t * 3) * 2) * s * foc;
    ctx.strokeStyle = rgba(acc, 0.30 * foc * alpha);
    ctx.lineWidth = 1;
    cornerBrackets(ctx, x, y, w, h, 20 * s, g2 + 5 * s);
  }

  if (pc <= 0.02 || s < 0.16) return;

  const openT = n.expandT;

  // --- an opened leaf: the summary gives way to a full card
  if (openT > 0.10 && n.leaf && !n.sub) {
    ctx.save();
    chamferPath(ctx, x, y, w, h, ch1, [true, false, true, false]);
    ctx.clip();
    const prevClip = textClip;
    textClip = clipIntersect(prevClip, { x, y, w, h });
    ctx.globalAlpha *= easeOutCubic(clamp((openT - 0.2) / 0.8, 0, 1));
    SCENE.detail.draw(ctx, n, x, y, w, h, s, alpha, t);
    textClip = prevClip;
    ctx.restore();

    chamferPath(ctx, x, y, w, h, ch1, [true, false, true, false]);
    ctx.strokeStyle = rgba(mix(col, acc, 0.6), (0.85 + foc * 0.15) * alpha);
    ctx.lineWidth = 1.15;
    ctx.stroke();
    return;
  }

  // --- an opened container: rows of data give way to the nested graph
  if (openT > 0.10 && n.sub) {
    ctx.save();
    chamferPath(ctx, x, y, w, h, ch1, [true, false, true, false]);
    ctx.clip();

    const prevClip = textClip;
    textClip = clipIntersect(prevClip, { x, y, w, h });

    // The container's header stays put while its contents fade in.
    const headH = (n.headH || METRIC.headerH) * s;
    ctx.fillStyle = rgba(col, 0.085 * pc * alpha);
    ctx.fillRect(x, y, w, headH);
    ctx.beginPath();
    ctx.moveTo(x, y + headH + 0.5);
    ctx.lineTo(x + w, y + headH + 0.5);
    ctx.strokeStyle = rgba(mix(col, acc, 0.5), 0.65 * pc * alpha);
    ctx.lineWidth = 1;
    ctx.stroke();

    const padX = METRIC.padX * s;
    drawText(ctx, n.title, x + padX + 8 * s, y + headH / 2 + 0.5 * s, {
      size: METRIC.titleSize * s, weight: 600, tracking: METRIC.titleTrack * s,
      color: rgba(mix(C.paper, acc, 0.25), 0.95 * pc * alpha),
    });
    drawText(ctx, `${n.sub.nodes.length} SUBSYSTEMS`, x + w - padX, y + headH / 2 + 0.5 * s, {
      size: METRIC.tagSize * s, weight: 400, tracking: METRIC.tagTrack * s,
      align: 'right', color: rgba(col, 0.66 * pc * alpha),
    });

    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * easeOutCubic(clamp((openT - 0.28) / 0.72, 0, 1));
    drawLevel(ctx, n.sub, t, dt);
    ctx.globalAlpha = prevAlpha;

    textClip = prevClip;
    ctx.restore();

    // Outline over the contents, so nested panels do not cut the frame.
    chamferPath(ctx, x, y, w, h, ch1, [true, false, true, false]);
    ctx.strokeStyle = rgba(mix(col, acc, 0.6), (0.85 + foc * 0.15) * alpha);
    ctx.lineWidth = 1.15;
    ctx.stroke();
    return;
  }

  // --- the contents
  ctx.save();
  chamferPath(ctx, x, y, w, h, ch1, [true, false, true, false]);
  ctx.clip();
  // The deferred text needs the same clip: a panel can be narrower than what
  // is in it, and rows must not escape the body. Intersect with the outer
  // clip and restore it afterwards — clearing it would let a panel inside a
  // container lift the clip from everything drawn after it.
  const outerClip = textClip;
  textClip = clipIntersect(outerClip, { x, y, w, h });

  const padX = METRIC.padX * s;
  const headH = (n.headH || METRIC.headerH) * s;

  // The header. It separates a title from the rows under it — and when there are
  // no rows, it separates the title from nothing and reads as an empty strip
  // above the only word on the card.
  if (!compact) {
    ctx.fillStyle = rgba(col, 0.085 * pc * alpha);
    ctx.fillRect(x, y, w, headH);
    ctx.beginPath();
    ctx.moveTo(x, y + headH + 0.5);
    ctx.lineTo(x + w, y + headH + 0.5);
    ctx.strokeStyle = rgba(mix(col, acc, 0.5), 0.65 * pc * alpha);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // The status light, blinking on its own phase.
  if (!compact) {
  const blink = 0.55 + 0.45 * Math.sin(t * 2.6 + n.seed);
  const ledX = x + padX * 0.62;
  const ledY = y + headH / 2;
  const ledR = 2.6 * s;
  ctx.globalCompositeOperation = 'lighter';
  drawGlow(ctx, ledX, ledY, ledR * 5, acc, 0.85 * blink * pc * alpha);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = rgba(C.paper, 0.95 * pc * alpha);
  ctx.beginPath();
  ctx.arc(ledX, ledY, ledR * 0.75, 0, TAU);
  ctx.fill();
  }

  // The title. Zoomed out it is all that is drawn, so it stops shrinking with
  // the view: a name at 4 screen pixels is a smear, and thirty of them are one
  // smear. It is centred in the whole card, since nothing else is in there, and
  // cut to what the card can hold at that size.
  const tcol = rgba(mix(C.paper, acc, 0.25), (0.92 + foc * 0.08) * pc * alpha);
  if (compact) {
    // Zoomed out the name is all there is, so it is wrapped to the card and, if
    // the wrapped block still will not fit the box, shrunk until it does. Text
    // that has to be there is never cut — it gets smaller or it takes a line.
    const avail = w - 12 * s;
    let size = clamp(METRIC.titleSize * s, 8.4, METRIC.titleSize);
    let lines = wrapToWidth(n.title, size, 600, 0.8, avail, avail);
    let guard = 0;
    while (guard++ < 14 && (lines.length * size * 1.25 > h - 6 * s
           || textWidth(lines[0], size, 600, 0.8) > avail)) {
      size *= 0.86;
      if (size < 3) break;
      lines = wrapToWidth(n.title, size, 600, 0.8, avail, avail);
    }
    const lh = size * 1.25;
    let ty = y + h / 2 - (lines.length - 1) * lh / 2;
    for (const line of lines) {
      drawText(ctx, line, x + w / 2, ty, { size, weight: 600, tracking: 0.8, align: 'center', color: tcol });
      ty += lh;
    }
  } else {
    // Each title line appears in turn, the way one long line used to type itself in.
    const lines = n.titleLines || [n.title];
    const shown = clamp(pd * 1.6, 0, 1);
    const lh = METRIC.titleLH * s;
    let ty = y + METRIC.headerH * s / 2 + 0.5 * s;
    for (const line of lines) {
      drawText(ctx, line.slice(0, Math.ceil(line.length * shown)), x + padX + 8 * s, ty, {
        size: METRIC.titleSize * s, weight: 600, tracking: METRIC.titleTrack * s, color: tcol,
      });
      ty += lh;
    }

    // The tag keeps the first line, beside the title.
    drawText(ctx, n.tag, x + w - padX, y + METRIC.headerH * s / 2 + 0.5 * s, {
      size: METRIC.tagSize * s,
      weight: 400,
      tracking: METRIC.tagTrack * s,
      align: 'right',
      color: rgba(col, 0.62 * pc * alpha),
    });
  }

  // The ticked scale down the left: a decorative rule.
  if (!compact) {
    const bodyTop = y + headH + 4 * s;
    const bodyBot = y + h - METRIC.footerH * s;
    ctx.beginPath();
    for (let yy = bodyTop; yy < bodyBot; yy += 4 * s) {
      const long = Math.round((yy - bodyTop) / (4 * s)) % 4 === 0;
      ctx.moveTo(x + 4 * s, yy);
      ctx.lineTo(x + (long ? 8 : 6) * s, yy);
    }
    ctx.strokeStyle = rgba(col, 0.30 * pc * alpha);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Rows of data.
  if (!compact) {
    const rowH = METRIC.rowH * s;
    let ry = y + headH + rowH * 0.72;
    const lx = x + padX + 4 * s;
    const rx = x + w - padX;

    for (let i = 0; i < n.rows.length; i++) {
      const rowP = clamp((pd - i * 0.10) / 0.5, 0, 1);
      if (rowP <= 0) break;
      const row = n.rows[i];
      const type = row[2];
      const ra = rowP * pc * alpha;

      if (type === 'bar') {
        // A load bar with a live value.
        const label = row[0];
        drawText(ctx, label, lx, ry, {
          size: METRIC.rowSize * s, weight: 400, tracking: METRIC.rowTrack * s,
          color: rgba(col, 0.62 * ra),
        });
        const val = n.leaf && SCENE.leaf.progress
          ? SCENE.leaf.progress(n.leaf)
          : clamp(n.load + noiseA(t * 0.55 + n.seed) * 0.16, 0.05, 0.99);
        const bx = lx + textWidth(label, METRIC.rowSize * s, 400, METRIC.rowTrack * s) + 8 * s;
        const bw = rx - bx - 26 * s;
        const bh = 3.6 * s;
        const by = ry - bh / 2;
        if (bw > 8) {
          ctx.fillStyle = rgba(col, 0.16 * ra);
          ctx.fillRect(bx, by, bw, bh);
          const fillW = bw * val * rowP;
          const bg = ctx.createLinearGradient(bx, 0, bx + bw, 0);
          bg.addColorStop(0, rgba(col, 0.7 * ra));
          bg.addColorStop(1, rgba(acc, 0.95 * ra));
          ctx.fillStyle = bg;
          ctx.fillRect(bx, by, fillW, bh);
          // Notches along the bar.
          ctx.fillStyle = `rgba(2,8,14,${0.6 * ra})`;
          for (let k = 1; k < 8; k++) ctx.fillRect(bx + (bw * k) / 8, by, 1, bh);
          drawText(ctx, `${Math.round(val * 100)}%`, rx, ry, {
            size: METRIC.rowSize * s, weight: 600, tracking: METRIC.rowTrack * s,
            align: 'right', color: rgba(acc, 0.9 * ra),
          });
        }
      } else {
        const label = row[0];
        // A value may be live: tokens spent, tasks counted, activity.
        const resolved = SCENE.resolveRow(n, row);
        const value = resolved.value;
        const shownValue = value.slice(0, Math.ceil(value.length * clamp(rowP * 1.5, 0, 1)));

        const lw = drawText(ctx, label, lx, ry, {
          size: METRIC.rowSize * s, weight: 400, tracking: METRIC.rowTrack * s,
          color: rgba(col, 0.60 * ra),
        });

        const vk = resolved.kind;
        let vc = C.paper;
        if (vk === 'ok') vc = C.green;
        else if (vk === 'warn') vc = C.amber;
        else if (vk === 'bad') vc = C.red;

        const vw = textWidth(shownValue, METRIC.rowSize * s, 600, METRIC.rowTrack * s);
        leaderDots(ctx, lx + lw + 5 * s, rx - vw - 5 * s, ry, 3.4 * s, rgba(col, 0.28 * ra));

        drawText(ctx, shownValue, rx, ry, {
          size: METRIC.rowSize * s, weight: 600, tracking: METRIC.rowTrack * s,
          align: 'right', color: rgba(vc, 0.95 * ra),
        });

        // The status dot.
        if (vk === 'ok' || vk === 'warn' || vk === 'bad') {
          const mx = rx - vw - 10 * s;
          ctx.fillStyle = rgba(vc, 0.85 * ra * (vk === 'bad' ? 0.5 + 0.5 * Math.sin(t * 7) : 1));
          ctx.fillRect(mx - 1.5 * s, ry - 1.5 * s, 3 * s, 3 * s);
        }
      }
      ry += rowH;
    }
  }

  // The controls, in the room the hover just opened. Two plain things: go in,
  // or ask what this is. Neither is guessed from where you clicked.
  n.actBtns = null;
  if (grow > 0.35 && !compact) {
    const acts = [];
    if (canOpen(n) || n.expanded) acts.push([n.expanded ? 'CLOSE' : 'OPEN', 'open']);
    acts.push(['CONTEXT', 'context']);
    const bh = 15 * s;
    const by = y + h - METRIC.footerH * s - bh - 5 * s;
    const gap = 6 * s;
    const bw = (w - padX * 1.4 - gap * (acts.length - 1)) / acts.length;
    let bx = x + padX * 0.7;
    n.actBtns = [];
    for (const [label, act] of acts) {
      const on = n.hotBtn === act;
      ctx.fillStyle = rgba(col, (on ? 0.30 : 0.13) * grow * alpha);
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeStyle = rgba(acc, (on ? 0.85 : 0.42) * grow * alpha);
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
      drawText(ctx, label, bx + bw / 2, by + bh / 2 + 0.5 * s, {
        size: Math.max(6, 7.4 * s), weight: 600, tracking: 1.1 * s, align: 'center',
        color: rgba(mix(C.paper, acc, 0.2), (on ? 1 : 0.82) * grow * alpha),
      });
      n.actBtns.push({ x: bx, y: by, w: bw, h: bh, act });
      bx += bw + gap;
    }
  }

  // The footer: the id strip and a barcode.
  if (!compact) {
    const fy = y + h - METRIC.footerH * s / 2;
    ctx.beginPath();
    ctx.moveTo(x + padX * 0.5, y + h - METRIC.footerH * s);
    ctx.lineTo(x + w - padX * 0.5, y + h - METRIC.footerH * s);
    ctx.strokeStyle = rgba(col, 0.22 * pc * alpha);
    ctx.lineWidth = 1;
    ctx.stroke();

    // The id and the barcode share one strip, and on a narrow card the id ran
    // straight through the bars. The barcode is decoration and gives way first;
    // only if the id still does not fit is it cut, and then it says so.
    const idText = `NODE·${n.id}`;
    const idW = textWidth(idText, 7 * s, 400, 1.0 * s);
    const room = w - padX * 1.4;
    const showBar = idW + 42 * s + 8 * s <= room;
    let idShown = idText;
    if (idW > room) {
      while (idShown.length > 4 && textWidth(idShown + '…', 7 * s, 400, 1.0 * s) > room) idShown = idShown.slice(0, -1);
      idShown += '…';
    }
    drawText(ctx, idShown, x + padX * 0.7, fy, {
      size: 7 * s, weight: 400, tracking: 1.0 * s,
      color: rgba(col, 0.5 * pc * alpha),
    });

    // A pseudo-barcode on the right, deterministic from the node's seed.
    const bcW = showBar ? 42 * s : 0;
    let bx = x + w - padX * 0.7 - bcW;
    const rnd = mulberry32(Math.floor(n.seed * 1000));
    ctx.fillStyle = rgba(col, 0.42 * pc * alpha);
    while (bx < x + w - padX * 0.7) {
      const bw = (rnd() < 0.35 ? 1.8 : 0.9) * s;
      ctx.fillRect(bx, fy - 3 * s, bw, 6 * s);
      bx += bw + (0.8 + rnd() * 1.6) * s;
    }
  }

  ctx.restore();
  textClip = outerClip;

  // The selection mark above the panel.
  if (n.select > 0.02 && s > 0.3) {
    const ly = y - 10 * s;
    drawText(ctx, '◂ SELECTED ▸', c.x, ly, {
      size: 7.5 * s, weight: 600, tracking: 1.6 * s, align: 'center',
      color: rgba(acc, 0.85 * n.select * alpha),
    });
  }
}

/** Particles converging on a node as it assembles. */
function drawNodeMotes(ctx, n, t) {
  const p = n.boot;
  if (p <= 0 || p >= 1) return;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const s = cam.scale;

  for (const m of n.motes) {
    const mp = clamp((p - m.t) / (1 - m.t), 0, 1);
    if (mp <= 0) continue;
    const e = easeOutQuint(mp);
    const wx = n.x + m.ax * (1 - e);
    const wy = n.y + m.ay * (1 - e);
    const sp = worldToScreen(wx, wy);
    const a = (1 - mp) * 0.9 * n.dim;
    const r = (1.2 + m.s * 1.6) * clamp(s, 0.4, 1.4);

    ctx.globalCompositeOperation = 'lighter';
    drawGlow(ctx, sp.x, sp.y, r * 4, n.color, a);
    ctx.globalCompositeOperation = 'source-over';

    // A tracer tail towards the target.
    const tail = worldToScreen(n.x + m.ax * (1 - e) * 1.12, n.y + m.ay * (1 - e) * 1.12);
    ctx.strokeStyle = rgba(n.accent, a * 0.4);
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(sp.x, sp.y);
    ctx.lineTo(tail.x, tail.y);
    ctx.stroke();
  }
}

/* =============================================================================
 * 12. THE ON-SCREEN HUD
 * ========================================================================== */

function pad2(v) { return v < 10 ? '0' + v : '' + v; }

function drawOverlay(ctx, t, fps) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  const chrome = SCENE.chrome !== false;   // a scene may draw its own interface
  const M = 22;                       // margin from the edge
  const ink = rgba(C.cyan, 0.72);
  const inkDim = rgba(C.cyan, 0.36);

  if (!chrome) {
    // The scene draws the interface; all it wants from here is the breadcrumb.
    drawBreadcrumbs(ctx, t);
    if (SCENE.minimap !== false) drawMinimap(ctx, t);
    if (SCENE.overlay) SCENE.overlay(ctx, t, { cssW, cssH, drillPath, hovered, selected });
    // The drawn crosshair duplicates the real cursor and lands on top of whatever
  // card you are reading, coordinates and all.
  if (SCENE.reticle !== false) drawReticle(ctx, t);
    return;
  }

  // --- the screen border, broken at the corners
  ctx.strokeStyle = rgba(C.cyan, 0.20);
  ctx.lineWidth = 1;
  ctx.beginPath();
  const gapT = 210, gapB = 150;
  ctx.moveTo(M + gapT, M + 0.5); ctx.lineTo(cssW - M - gapT, M + 0.5);
  ctx.moveTo(M + gapB, cssH - M - 0.5); ctx.lineTo(cssW - M - gapB, cssH - M - 0.5);
  ctx.moveTo(M + 0.5, M + 90); ctx.lineTo(M + 0.5, cssH - M - 90);
  ctx.moveTo(cssW - M - 0.5, M + 90); ctx.lineTo(cssW - M - 0.5, cssH - M - 90);
  ctx.stroke();

  // The screen's corner brackets.
  ctx.strokeStyle = rgba(C.cyan, 0.55);
  ctx.lineWidth = 1.4;
  const L = 28;
  ctx.beginPath();
  ctx.moveTo(M, M + L); ctx.lineTo(M, M); ctx.lineTo(M + L, M);
  ctx.moveTo(cssW - M - L, M); ctx.lineTo(cssW - M, M); ctx.lineTo(cssW - M, M + L);
  ctx.moveTo(cssW - M, cssH - M - L); ctx.lineTo(cssW - M, cssH - M); ctx.lineTo(cssW - M - L, cssH - M);
  ctx.moveTo(M + L, cssH - M); ctx.lineTo(M, cssH - M); ctx.lineTo(M, cssH - M - L);
  ctx.stroke();

  // --- the title, top left
  drawText(ctx, SCENE.title, M + 8, M + 16, {
    size: 15, weight: 600, tracking: 5.2, color: rgba(C.ice, 0.92),
  });
  drawText(ctx, SCENE.subtitle, M + 8, M + 34, {
    size: 8.5, weight: 400, tracking: 2.6, color: inkDim,
  });

  // The slider beneath the title.
  const barW = 168;
  ctx.fillStyle = rgba(C.cyan, 0.16);
  ctx.fillRect(M + 8, M + 44, barW, 2);
  const sweep = (t * 0.35) % 1;
  const sg = ctx.createLinearGradient(M + 8, 0, M + 8 + barW, 0);
  sg.addColorStop(Math.max(0, sweep - 0.16), rgba(C.cyan, 0));
  sg.addColorStop(clamp(sweep, 0, 1), rgba(C.ice, 0.95));
  sg.addColorStop(Math.min(1, sweep + 0.16), rgba(C.cyan, 0));
  ctx.fillStyle = sg;
  ctx.fillRect(M + 8, M + 44, barW, 2);

  // --- telemetry, top right
  if (SCENE.telemetry !== false) {
  const now = new Date();
  const clock = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  const right = cssW - M - 8;
  const stats = [
    ['SYS TIME', clock],
    ['NODES', `${nodes.length}`],
    ['LINKS', `${edges.length}`],
    ['ZOOM', `${(cam.scale * 100).toFixed(0)}%`],
    ['FPS', `${fps.toFixed(0)}`],
  ];
  let sy = M + 14;
  for (const [k, v] of stats) {
    drawText(ctx, k, right - 74, sy, { size: 8, weight: 400, tracking: 1.6, align: 'right', color: inkDim });
    drawText(ctx, v, right, sy, { size: 9, weight: 600, tracking: 1.4, align: 'right', color: ink });
    sy += 13;
  }

  }

  // --- the ticker along the bottom
  const tickY = cssH - M - 16;
  ctx.fillStyle = 'rgba(4,14,24,0.55)';
  ctx.fillRect(M + 1, tickY - 8, cssW - M * 2 - 2, 16);
  ctx.save();
  ctx.beginPath();
  ctx.rect(M + 10, tickY - 8, cssW - M * 2 - 20, 16);
  ctx.clip();
  const ticker = SCENE.ticker;
  const tw = textWidth(ticker, 8, 400, 2.2) + 120;
  let off = -((t * 46) % tw);
  for (let i = 0; i < 2; i++) {
    drawText(ctx, ticker, M + 14 + off + i * tw, tickY, {
      size: 8, weight: 400, tracking: 2.2, color: rgba(C.cyan, 0.5),
    });
  }
  ctx.restore();

  // The blinking dot before it.
  ctx.fillStyle = rgba(C.green, 0.4 + 0.6 * (Math.sin(t * 4) * 0.5 + 0.5));
  ctx.fillRect(M + 4, tickY - 2, 4, 4);

  // --- the control hints
  // Returning early here also skipped the breadcrumb, the minimap and the
  // inspector, which are not chrome — they are how you know where you are.
  if (SCENE.hints !== false) {
    const help = 'CLICK ▸ OPEN / CLOSE · [ESC] BACK · DRAG ORBIT · WHEEL ZOOM · [F] FIT  [R] REBUILD  [G] GRID  [B] BLOOM  [L] LABELS  [SPACE] PAUSE';
    drawText(ctx, help, M + 8, cssH - M - 32, {
      size: 7.5, weight: 400, tracking: 1.5, color: rgba(C.cyan, 0.30),
    });
  }

  drawBreadcrumbs(ctx, t);

  if (SCENE.minimap !== false) drawMinimap(ctx, t);
  if (SCENE.overlay) SCENE.overlay(ctx, t, { cssW, cssH, drillPath, hovered, selected });
  // The inspector redraws the selected card in the corner — a second copy of
  // something already on screen, in the way of the thing it copies.
  else if (SCENE.inspector !== false) drawInspector(ctx, t);
  if (SCENE.reticle !== false) drawReticle(ctx, t);   // the scene may rely on the real cursor
}

/**
 * Breadcrumbs for the current path. They say which level you are on and how
 * deep it goes; without them, drilling down is disorienting.
 */
function drawBreadcrumbs(ctx, t) {
  // In presentation mode the crumbs matter only once you are inside something.
  if (SCENE.chrome === false && !drillPath.length && SCENE.hideEmptyCrumbs) return;
  const M = 22;
  let x = M + 8;
  const y = SCENE.chrome === false ? (SCENE.crumbY || 92) : M + 62;

  const step = (label, active, color) => {
    const size = active ? 9 : 8.5;
    const w = textWidth(label, size, active ? 600 : 400, 1.8);
    if (active) {
      ctx.fillStyle = rgba(color, 0.16);
      ctx.fillRect(x - 5, y - 8, w + 10, 16);
      ctx.strokeStyle = rgba(color, 0.55);
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 5.5, y - 8.5, w + 11, 17);
    }
    drawText(ctx, label, x, y, {
      size, weight: active ? 600 : 400, tracking: 1.8,
      color: rgba(active ? C.ice : C.cyan, active ? 0.95 : 0.45),
    });
    x += w + 10;
    return w;
  };

  step('TOP', drillPath.length === 0, C.cyan);
  for (let i = 0; i < drillPath.length; i++) {
    drawText(ctx, '▸', x, y, { size: 8, weight: 400, tracking: 0, color: rgba(C.cyan, 0.35) });
    x += 12;
    const n = drillPath[i];
    step(n.title, i === drillPath.length - 1, n.accent);
  }

  if (drillPath.length) {
    drawText(ctx, '[ESC] BACK', x + 8, y, {
      size: 7.5, weight: 400, tracking: 1.4,
      color: rgba(C.cyan, 0.30 + 0.18 * (Math.sin(t * 2.4) * 0.5 + 0.5)),
    });
  }
}

/** The minimap, bottom right, with a box for the visible area. */
function drawMinimap(ctx, t) {
  const w = 176, h = 116;
  const x = cssW - 22 - 8 - w;
  const y = cssH - 22 - 46 - h;

  const b = graphBounds(70);
  const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
  const s = Math.min((w - 14) / bw, (h - 14) / bh);
  const ox = x + w / 2 - ((b.minX + b.maxX) / 2) * s;
  const oy = y + h / 2 - ((b.minY + b.maxY) / 2) * s;

  ctx.fillStyle = 'rgba(4,14,24,0.5)';
  chamferPath(ctx, x, y, w, h, 8, [true, false, true, false]);
  ctx.fill();
  ctx.strokeStyle = rgba(C.cyan, 0.35);
  ctx.lineWidth = 1;
  ctx.stroke();

  drawText(ctx, 'TOPOLOGY MAP', x + 8, y + 10, {
    size: 7, weight: 500, tracking: 1.8, color: rgba(C.cyan, 0.5),
  });

  // Edges.
  ctx.strokeStyle = rgba(C.cyan, 0.22);
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  for (const e of edges) {
    ctx.moveTo(ox + e.a.x * s, oy + e.a.y * s);
    ctx.lineTo(ox + e.b.x * s, oy + e.b.y * s);
  }
  ctx.stroke();

  // Nodes.
  for (const n of nodes) {
    const nx = ox + (n.x - n.w / 2) * s;
    const ny = oy + (n.y - n.h / 2) * s;
    const a = 0.35 + Math.max(n.hover, n.select) * 0.65;
    ctx.fillStyle = rgba(n.color, a * n.boot);
    ctx.fillRect(nx, ny, Math.max(2, n.w * s), Math.max(1.5, n.h * s));
  }

  // The visible area.
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(cssW, cssH);
  ctx.strokeStyle = rgba(C.ice, 0.55);
  ctx.lineWidth = 1;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 1, y + 1, w - 2, h - 2);
  ctx.clip();
  ctx.strokeRect(ox + tl.x * s, oy + tl.y * s, (br.x - tl.x) * s, (br.y - tl.y) * s);
  ctx.restore();
}

/** The detail panel for the selected node, bottom left. */
function drawInspector(ctx, t) {
  const n = selected;
  inspectorAlpha = approach(inspectorAlpha, n ? 1 : 0, 9, 1 / 60);
  if (inspectorAlpha < 0.01 || !lastSelected) return;

  const node = lastSelected;
  const w = 232;
  const rows = node.rows.length;
  const h = 62 + rows * 14;
  const x = 22 + 8;
  const y = cssH - 22 - 46 - h;
  const a = easeOutCubic(inspectorAlpha);

  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate((1 - a) * -18, 0);

  chamferPath(ctx, x, y, w, h, 10, [true, false, true, false]);
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, rgba(node.color, 0.14));
  g.addColorStop(1, rgba(node.color, 0.04));
  ctx.fillStyle = 'rgba(4,14,24,0.62)';
  ctx.fill();
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = rgba(node.color, 0.6);
  ctx.lineWidth = 1.1;
  ctx.stroke();

  ctx.strokeStyle = rgba(node.accent, 0.55);
  ctx.lineWidth = 1;
  cornerBrackets(ctx, x, y, w, h, 12, 4);

  drawText(ctx, node.title, x + 12, y + 16, {
    size: 11, weight: 600, tracking: 2.2, color: rgba(C.paper, 0.95),
  });
  drawText(ctx, node.tag, x + w - 12, y + 16, {
    size: 8, weight: 400, tracking: 1.2, align: 'right', color: rgba(node.color, 0.7),
  });

  ctx.beginPath();
  ctx.moveTo(x + 10, y + 26.5); ctx.lineTo(x + w - 10, y + 26.5);
  ctx.strokeStyle = rgba(node.color, 0.35);
  ctx.stroke();

  let ry = y + 40;
  for (const r of node.rows) {
    const label = r[0];
    const val = r[2] === 'bar' ? `${Math.round(clamp(node.load, 0, 1) * 100)}%` : String(r[1] || '');
    let vc = C.paper;
    if (r[2] === 'ok') vc = C.green;
    else if (r[2] === 'warn') vc = C.amber;
    else if (r[2] === 'bad') vc = C.red;
    const lw = drawText(ctx, label, x + 12, ry, {
      size: 8.5, weight: 400, tracking: 1.1, color: rgba(node.color, 0.62),
    });
    const vw = textWidth(val, 8.5, 600, 1.1);
    leaderDots(ctx, x + 12 + lw + 5, x + w - 12 - vw - 5, ry, 3.4, rgba(node.color, 0.3));
    drawText(ctx, val, x + w - 12, ry, {
      size: 8.5, weight: 600, tracking: 1.1, align: 'right', color: rgba(vc, 0.95),
    });
    ry += 14;
  }

  const deg = node.inEdges.length + node.outEdges.length;
  drawText(ctx, `LINKS ${deg}  ·  IN ${node.inEdges.length}  ·  OUT ${node.outEdges.length}`,
    x + 12, y + h - 12, { size: 7.5, weight: 400, tracking: 1.4, color: rgba(C.cyan, 0.45) });

  ctx.restore();
}

/** The targeting crosshair at the cursor. */
function drawReticle(ctx, t) {
  if (!pointer.inside) return;
  const x = pointer.x, y = pointer.y;
  const a = hovered ? 0.75 : 0.32;
  const r = hovered ? 13 : 8;

  ctx.strokeStyle = rgba(C.cyan, a);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - r - 7, y); ctx.lineTo(x - 4, y);
  ctx.moveTo(x + 4, y); ctx.lineTo(x + r + 7, y);
  ctx.moveTo(x, y - r - 7); ctx.lineTo(x, y - 4);
  ctx.moveTo(x, y + 4); ctx.lineTo(x, y + r + 7);
  ctx.stroke();

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(t * 0.9);
  ctx.strokeStyle = rgba(C.cyan, a * 0.8);
  ctx.strokeRect(-r * 0.55, -r * 0.55, r * 1.1, r * 1.1);
  ctx.restore();

  const w = screenToWorld(x, y);
  drawText(ctx, `X ${w.x.toFixed(0)}  Y ${w.y.toFixed(0)}`, x + 16, y + 18, {
    size: 7, weight: 400, tracking: 1.1, color: rgba(C.cyan, 0.4),
  });
}

/* =============================================================================
 * 13. POST-PROCESSING
 * ========================================================================== */

const FLAGS = { grid: true, bloom: true, post: true, labels: false, paused: false };

const grainTiles = [];

function buildGrainTiles() {
  grainTiles.length = 0;
  const S = 128;
  const rnd = mulberry32(31337);
  for (let k = 0; k < 4; k++) {
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const x = c.getContext('2d');
    const img = x.createImageData(S, S);
    const d = img.data;
    for (let i = 0; i < S * S; i++) {
      const v = rnd();
      const lum = v < 0.5 ? 0 : 255;
      d[i * 4] = lum;
      d[i * 4 + 1] = lum;
      d[i * 4 + 2] = lum;
      d[i * 4 + 3] = Math.floor(v * 46);
    }
    x.putImageData(img, 0, 0);
    grainTiles.push(out.createPattern(c, 'repeat'));
  }
}

function tintChannel(dst, src, color) {
  const x = dst.x;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalCompositeOperation = 'source-over';
  x.globalAlpha = 1;
  x.fillStyle = '#000';
  x.fillRect(0, 0, dst.w, dst.h);
  x.drawImage(src.c, 0, 0, dst.w, dst.h);
  x.globalCompositeOperation = 'multiply';
  x.fillStyle = color;
  x.fillRect(0, 0, dst.w, dst.h);
  x.globalCompositeOperation = 'source-over';
}

/** Builds the bloom pyramid from the scene. */
function buildBloom() {
  const levels = RT.levels;
  const l0 = levels[0];

  // Bright-pass: halve the scene, then multiply the result by itself. Squaring
  // brightness kills the background (0.05 -> 0.0025) and keeps the glow.
  // The full frame is read exactly once; the second factor comes from half.
  const half = RT.half;
  half.x.setTransform(1, 0, 0, 1, 0, 0);
  half.x.globalCompositeOperation = 'source-over';
  half.x.globalAlpha = 1;
  half.x.imageSmoothingEnabled = true;
  half.x.drawImage(RT.scene.c, 0, 0, half.w, half.h);

  l0.x.setTransform(1, 0, 0, 1, 0, 0);
  l0.x.globalCompositeOperation = 'source-over';
  l0.x.globalAlpha = 1;
  l0.x.imageSmoothingEnabled = true;
  l0.x.drawImage(half.c, 0, 0, l0.w, l0.h);
  l0.x.globalCompositeOperation = 'multiply';
  l0.x.drawImage(half.c, 0, 0, l0.w, l0.h);
  l0.x.globalCompositeOperation = 'source-over';

  // Downsample: each level halves, and bilinear filtering does the blurring.
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1], b = levels[i];
    b.x.setTransform(1, 0, 0, 1, 0, 0);
    b.x.globalCompositeOperation = 'source-over';
    b.x.globalAlpha = 1;
    b.x.fillStyle = '#000';
    b.x.fillRect(0, 0, b.w, b.h);
    b.x.drawImage(a.c, 0, 0, b.w, b.h);
  }

  // The anamorphic flare is taken from a small level, which is where it wants
  // to come from: it is wide and soft, and detail only hurts it.
  const st = RT.streak;
  const src = levels[3];
  st.x.setTransform(1, 0, 0, 1, 0, 0);
  st.x.globalCompositeOperation = 'source-over';
  st.x.globalAlpha = 1;
  st.x.fillStyle = '#000';
  st.x.fillRect(0, 0, st.w, st.h);
  st.x.globalCompositeOperation = 'lighter';
  for (let i = -3; i <= 3; i++) {
    st.x.globalAlpha = (1 - Math.abs(i) / 4) * 0.34;
    st.x.drawImage(src.c, i * 5, 0, st.w, st.h);
  }
  st.x.globalAlpha = 1;
  st.x.globalCompositeOperation = 'source-over';

  // Upsample and accumulate: bottom up, this builds the wide soft halo.
  // Stop at quarter resolution: there is no point going further, since the
  // final stretch to the screen is bilinear anyway.
  for (let i = levels.length - 1; i > 1; i--) {
    const a = levels[i], b = levels[i - 1];
    b.x.globalCompositeOperation = 'lighter';
    b.x.globalAlpha = 0.66;
    b.x.drawImage(a.c, 0, 0, b.w, b.h);
    b.x.globalAlpha = 1;
    b.x.globalCompositeOperation = 'source-over';
  }

  // The sharp part of the glow is mixed in straight from the half level: that
  // is what gives thin lines their dense halo.
  const l1 = levels[1];
  l1.x.globalCompositeOperation = 'lighter';
  l1.x.globalAlpha = 0.55;
  l1.x.drawImage(l0.c, 0, 0, l1.w, l1.h);
  l1.x.globalAlpha = 1;
  l1.x.globalCompositeOperation = 'source-over';
}

/** Draws a layer centred at scale k: the basis of the radial aberration. */
function drawScaledCentered(ctx, rt, dw, dh, k, alpha) {
  const w = dw * k, h = dh * k;
  ctx.globalAlpha = alpha;
  ctx.drawImage(rt.c, (dw - w) / 2, (dh - h) / 2, w, h);
  ctx.globalAlpha = 1;
}

function composite(t) {
  const scene = RT.scene;

  out.setTransform(1, 0, 0, 1, 0, 0);
  out.globalCompositeOperation = 'source-over';
  out.globalAlpha = 1;
  out.imageSmoothingEnabled = true;
  out.drawImage(scene.c, 0, 0);

  if (!FLAGS.post) return;

  if (FLAGS.bloom) {
    // The pyramid was built in frame(), before any text landed on the scene.
    const bloomRT = RT.levels[1];                // where the pyramid ended up
    const ab = 0.0016;                           // chromatic aberration amplitude

    tintChannel(RT.tint[0], bloomRT, '#ff2a2a');
    tintChannel(RT.tint[1], bloomRT, '#2aff5a');
    tintChannel(RT.tint[2], bloomRT, '#2a6aff');

    // The channels are merged into one half-resolution buffer and only then
    // stretched to the screen: three full-screen scalings become one. The
    // radial shift does not suffer, being proportional.
    const ch = RT.chroma;
    ch.x.setTransform(1, 0, 0, 1, 0, 0);
    ch.x.globalCompositeOperation = 'source-over';
    ch.x.globalAlpha = 1;
    ch.x.fillStyle = '#000';
    ch.x.fillRect(0, 0, ch.w, ch.h);
    ch.x.globalCompositeOperation = 'lighter';
    drawScaledCentered(ch.x, RT.tint[0], ch.w, ch.h, 1 + ab, 1);
    drawScaledCentered(ch.x, RT.tint[1], ch.w, ch.h, 1, 1);
    drawScaledCentered(ch.x, RT.tint[2], ch.w, ch.h, 1 - ab, 1);
    // The anamorphic flare is mixed in here too.
    ch.x.globalAlpha = 0.55;
    ch.x.drawImage(RT.streak.c, 0, 0, ch.w, ch.h);
    ch.x.globalAlpha = 1;
    ch.x.globalCompositeOperation = 'source-over';

    // Bloom is added light, and it lands inside the cards as much as around
    // them — a card's own frame lifts its interior, which is where the text is.
    // Enough of it to keep the hologram, not enough to grey out the words.
    out.globalCompositeOperation = 'lighter';
    out.globalAlpha = 0.34;
    out.drawImage(ch.c, 0, 0, W, H);
    out.globalAlpha = 1;
    out.globalCompositeOperation = 'source-over';
  }

  // --- the sweeping band
  const sweepY = ((t * 0.16) % 1.35) * H;
  const sg = out.createLinearGradient(0, sweepY - 90 * DPR, 0, sweepY + 90 * DPR);
  sg.addColorStop(0, 'rgba(120,220,255,0)');
  sg.addColorStop(0.5, 'rgba(120,220,255,0.035)');
  sg.addColorStop(1, 'rgba(120,220,255,0)');
  out.globalCompositeOperation = 'lighter';
  out.fillStyle = sg;
  out.fillRect(0, sweepY - 90 * DPR, W, 180 * DPR);
  out.globalCompositeOperation = 'source-over';

  // --- grain
  if (grainTiles.length) {
    const tile = grainTiles[(frameCount >> 1) % grainTiles.length];
    out.globalCompositeOperation = 'lighter';
    out.globalAlpha = 0.03;
    out.fillStyle = tile;
    out.save();
    out.translate((frameCount * 7) % 128, (frameCount * 13) % 128);
    out.fillRect(-128, -128, W + 256, H + 256);
    out.restore();
    out.globalAlpha = 1;
    out.globalCompositeOperation = 'source-over';
  }

  // --- the baked layer: scanlines and vignette in one pass
  if (RT.overlay) {
    out.globalCompositeOperation = 'source-over';
    out.drawImage(RT.overlay.c, 0, 0);
  }
}

/* =============================================================================
 * 14. INPUT
 * ========================================================================== */

const pointer = { x: 0, y: 0, inside: false, down: false, moved: false };
let dragNode = null;
let dragOffX = 0, dragOffY = 0;
let panning = false;
let panStartX = 0, panStartY = 0, panCamX = 0, panCamY = 0;

let hovered = null;
let selected = null;
let pointerConsumed = false;   // the click went to the scene's modal layer

// Pointer coordinates have to be local to the canvas. This engine was written
// for a canvas filling the viewport, where clientX/clientY already were local.
// Inside a panel the canvas sits at an offset — and the page scrolls under it —
// so every hit test, the crosshair and zoom-to-cursor were wrong by exactly
// that offset. Read the rect per event: it changes on scroll, and one
// getBoundingClientRect for one element is cheaper than being wrong.
function localX(ev) { return ev.clientX - view.getBoundingClientRect().left; }
function localY(ev) { return ev.clientY - view.getBoundingClientRect().top; }
function localXY(ev) { const r = view.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; }
let lastSelected = null;
let inspectorAlpha = 0;

/** Finds the node under a point, descending into opened containers. */
function hitLevel(level, wx, wy) {
  // Reverse draw order: whatever was drawn last catches the click first.
  for (let i = level.nodes.length - 1; i >= 0; i--) {
    const n = level.nodes[i];
    if (n.boot < 0.3) continue;
    if (Math.abs(wx - n.x) > n.w / 2 || Math.abs(wy - n.y) > n.h / 2) continue;
    if (n.sub && n.expandT > 0.5) {
      const inner = hitLevel(n.sub, wx, wy);
      if (inner) return inner;
    }
    return n;
  }
  return null;
}

/** A control under the pointer, if the hovered card is showing any. */
function buttonAt(sx, sy) {
  for (const n of allNodes) {
    if (!n.actBtns) continue;
    for (const b of n.actBtns) {
      if (sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h) return { node: n, act: b.act };
    }
  }
  return null;
}

function nodeAt(sx, sy) {
  const w = screenToWorld(sx, sy);
  return hitLevel(root, w.x, w.y);
}

/* --- drilling through levels ---------------------------------------------- */

// Design mode: the picture becomes a place to declare things rather than only to
// read them. Dragging from a card pulls a link; clicking empty space asks for a new
// element there. Positions are still never stored — the click only says where the
// question was asked, and the layout is recomputed from what was declared.
let designMode = false;
let linkFrom = null;          // the card a link is being pulled from
let linkOver = null;          // the card the pointer is over while pulling

const drillPath = [];        // the chain of opened containers, outermost first
let autoFrame = null;        // framing held until the animation finishes

/** Starts a level assembling again from nothing. */
function bootLevel(level) {
  level.bootStart = time;
  for (const n of level.nodes) {
    n.boot = 0;
    n.expanded = false;
    n.expandT = 0;
    if (n.sub) { n.w = n.baseW; n.h = n.baseH; }
  }
  for (const e of level.edges) e.boot = 0;
  placeLevel(level, null, true);
  for (const e of level.edges) e.dirty = true;
}

/**
 * Points the camera at an opened container, leaving generous room around it.
 * Fitted tightly, its neighbours leave the screen and the only way to another
 * subsystem is to close this one first.
 */
function focusCamera(n) {
  const pad = 300;
  const ins = (SCENE && SCENE.viewInset) || {};
  const availW = Math.max(200, cssW - (ins.left || 0) - (ins.right || 0));
  const availH = Math.max(200, cssH - (ins.top || 0) - (ins.bottom || 0));
  const s = clamp(Math.min(availW / (n.openW + pad), availH / (n.openH + pad)), 0.2, 1.9);
  cam.tscale = s;
  cam.tx = n.x - ((ins.left || 0) - (ins.right || 0)) / 2 / s;
  cam.ty = n.y + (NEST.padTop - NEST.padBottom) / 2 - ((ins.top || 0) - (ins.bottom || 0)) / 2 / s;
}

/** A node opens if it holds a level inside, or a card of its own. */
function canOpen(n) {
  return !!(n && (n.sub || n.leaf));
}

function drillInto(n) {
  if (SCENE.onDrill) setTimeout(() => SCENE.onDrill(drillPath.map((x) => x.src || x)), 0);
  if (!canOpen(n) || n.expanded) return false;

  // Only one container per level is open at a time, or the picture turns to
  // porridge and the target positions jump about.
  for (const s of n.level.nodes) if (s !== n && s.expanded) collapse(s);

  // Trim the path back to the container n sits in. Without this, moving to a
  // sibling would leave an already-closed container in the chain, and Esc
  // would take you somewhere you had not been.
  const host = n.level.parent || null;
  const idx = host ? drillPath.indexOf(host) : -1;
  drillPath.length = idx + 1;

  n.expanded = true;
  if (n.sub) bootLevel(n.sub);
  drillPath.push(n);
  selected = null;
  autoFrame = { node: n };
  focusCamera(n);
  return true;
}

function collapse(n) {
  n.expanded = false;
  if (n.sub) for (const c of n.sub.nodes) if (c.expanded) collapse(c);
}

/** Closes one container and lifts navigation back to its level. */
function collapseNode(n) {
  if (!n || !n.expanded) return false;
  collapse(n);
  const idx = drillPath.indexOf(n);
  if (idx >= 0) drillPath.length = idx;
  selected = null;
  hovered = null;
  const parent = drillPath[drillPath.length - 1];
  autoFrame = parent ? { node: parent } : { fit: true };
  if (parent) focusCamera(parent);
  else fitView();
  return true;
}

/** Back up one level. */
function drillOut() {
  return collapseNode(drillPath[drillPath.length - 1]);
}

function setCursor(cls) {
  view.className = cls || '';
}

on(view, 'pointerdown', (ev) => {
  // A scene may hold a modal layer over the graph and take the clicks itself.
  const [lx0, ly0] = localXY(ev);
  if (SCENE.onPointer && SCENE.onPointer(lx0, ly0)) {
    pointerConsumed = true;
    return;
  }
  pointerConsumed = false;
  view.setPointerCapture(ev.pointerId);
  pointer.down = true;
  pointer.moved = false;
  // Always remember where the press landed: it is how a click is told from a drag.
  panStartX = lx0;
  panStartY = ly0;

  // Dragging moves the view, never a node. Pressing a node used to pick it up,
  // and once you zoom inside an opened container it covers the whole viewport —
  // there is no empty background left to grab, so the picture could not be moved
  // at all. Positions here are computed from the graph anyway; dragging one node
  // out of place says nothing and loses the layout's meaning.
  // In design mode a press landing on a card starts a link instead of a pan. Empty
  // background still pans, so the picture never becomes untouchable.
  if (designMode && !buttonAt(lx0, ly0)) {
    const nd = nodeAt(lx0, ly0);
    if (nd) { linkFrom = nd; linkOver = null; panning = false; setCursor('pointing'); return; }
  }

  panning = true;
  panCamX = cam.tx;
  panCamY = cam.ty;
  autoFrame = null;            // a hand on the picture outranks automatic framing
  setCursor('grabbing');
});

on(view, 'pointermove', (ev) => {
  const [lx, ly] = localXY(ev);
  pointer.x = lx;
  pointer.y = ly;
  pointer.inside = true;

  if (pointer.down) {
    const dx = lx - panStartX, dy = ly - panStartY;
    if (Math.abs(dx) + Math.abs(dy) > 3) pointer.moved = true;
  }

  if (dragNode) {
    const w = screenToWorld(lx, ly);
    dragNode.x = w.x + dragOffX;
    dragNode.y = w.y + dragOffY;
    for (const e of edges) if (e.a === dragNode || e.b === dragNode) e.dirty = true;
    pointer.moved = true;
    return;
  }

  if (linkFrom) {
    const over = nodeAt(lx, ly);
    linkOver = over && over !== linkFrom ? over : null;
    setCursor('pointing');
    return;
  }

  if (panning) {
    cam.tx = panCamX - (lx - panStartX) / cam.scale;
    cam.ty = panCamY - (ly - panStartY) / cam.scale;
    cam.x = cam.tx; cam.y = cam.ty;      // panning without inertia feels more exact
    return;
  }

  if (SCENE.onHover && SCENE.onHover(lx, ly)) {
    hovered = null;
    setCursor('pointing');
    return;
  }
  const hb = buttonAt(lx, ly);
  const n = hb ? hb.node : nodeAt(lx, ly);
  // The controls sit in the room the hover opened, and some of them reach past
  // the card's own box — losing the hover there would make them unclickable.
  for (const q of allNodes) q.hotBtn = null;
  if (hb) hb.node.hotBtn = hb.act;
  hovered = n;
  setCursor(n ? 'pointing' : '');
});

const endPointer = (ev) => {
  if (pointerConsumed) { pointerConsumed = false; return; }

  if (linkFrom) {
    const [lxl, lyl] = ev && ev.clientX != null ? localXY(ev) : [pointer.x, pointer.y];
    const to = nodeAt(lxl, lyl);
    const from = linkFrom;
    linkFrom = null; linkOver = null;
    pointer.down = false; panning = false;
    if (to && to !== from && SCENE.onLink) {
      SCENE.onLink(from.src && from.src.modelId, to.src && to.src.modelId);
    } else if ((!to || to === from) && !pointer.moved && SCENE.onNodeSelect) {
      // Press and release on one card still means "what is this", mode or no mode.
      selected = from;
      SCENE.onNodeSelect(from);
    }
    setCursor('');
    return;
  }
  if (pointer.down && !pointer.moved) {
    // pointerleave fires this without an event of its own, so fall back to the
    // last position the pointer was known to be at.
    const [lxu, lyu] = ev && ev.clientX != null ? localXY(ev) : [pointer.x, pointer.y];
    // A control decides what happens; nothing is inferred from where you hit
    // the card. Loading both meanings onto one click meant a single press both
    // opened a group and threw a dialog over it.
    const hitBtn = buttonAt(lxu, lyu);
    const n = hitBtn ? hitBtn.node : nodeAt(lxu, lyu);
    if (hitBtn) {
      lastSelected = n;
      if (hitBtn.act === 'open') {
        if (n.expanded) collapseNode(n); else if (canOpen(n)) drillInto(n);
      } else {
        selected = n;
        if (SCENE.onNodeSelect) SCENE.onNodeSelect(n);
      }
    } else if (n) {
      // The body of a card asks what it is — the thing people came to do. A
      // group is opened from its own OPEN control, not by hitting it anywhere.
      lastSelected = n;
      selected = n;
      if (SCENE.onNodeSelect) SCENE.onNodeSelect(n);
    } else if (selected) {
      selected = null;
    } else {
      // A click on empty background means back up a level — unless this is the mode
      // for declaring things, where it means "put a new one about here".
      if (designMode && SCENE.onAddAt) {
        const w = screenToWorld(lxu, lyu);
        SCENE.onAddAt(w.x, w.y, lxu, lyu);
      } else drillOut();
    }
  }
  pointer.down = false;
  panning = false;
  dragNode = null;
  setCursor(hovered ? 'pointing' : '');
};

on(view, 'pointerup', endPointer);
on(view, 'pointercancel', () => {
  pointer.down = false; panning = false; dragNode = null; setCursor('');
});
on(view, 'pointerleave', () => { pointer.inside = false; hovered = null; });

on(view, 'wheel', (ev) => {
  ev.preventDefault();
  autoFrame = null;
  const k = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.012 : 0.0022));
  const next = clamp(cam.tscale * k, 0.18, 3.2);

  // Zoom towards whatever is under the cursor.
  const [lxw, lyw] = localXY(ev);
  const before = screenToWorld(lxw, lyw);
  cam.tscale = next;
  cam.scale = next;
  const after = screenToWorld(lxw, lyw);
  cam.tx += before.x - after.x;
  cam.ty += before.y - after.y;
  cam.x = cam.tx; cam.y = cam.ty;
}, { passive: false });

on(view, 'dblclick', () => fitView());

on(window, 'keydown', (ev) => {
  // This canvas shares the page with text fields and other views. A hotkey that
  // fires while someone is typing, or while the panel is not even on screen,
  // belongs to somebody else.
  const el = ev.target;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  if (!view.isConnected || !view.offsetParent) return;
  const k = ev.key.toLowerCase();
  if (SCENE.onKey && SCENE.onKey(k, ev)) return;          // the scene took the key
  if (k === 'f') fitView();
  else if (k === 'r') startBoot();
  else if (k === 'g') FLAGS.grid = !FLAGS.grid;
  else if (k === 'b') FLAGS.bloom = !FLAGS.bloom;
  else if (k === 'p') FLAGS.post = !FLAGS.post;
  else if (k === 'l') FLAGS.labels = !FLAGS.labels;
  else if (k === 'escape' || k === 'backspace') {
    // Clear the selection first, then step up a level.
    ev.preventDefault();
    if (selected) selected = null;
    else drillOut();
  }
  else if (k === 'enter') {
    const n = selected || hovered;
    if (n) drillInto(n);
  }
  else if (ev.code === 'Space') { ev.preventDefault(); FLAGS.paused = !FLAGS.paused; }
});

// Only the diagram someone is actually looking at should be drawing.
let onScreen = true;
if (typeof IntersectionObserver === 'function') {
  const io = new IntersectionObserver((es) => { onScreen = es.some((e) => e.isIntersecting); },
    { rootMargin: '120px' });
  io.observe(view);
  teardown.push(() => io.disconnect());
}

// A panel is resized by layout far more often than a window is: watch the box.
if (typeof ResizeObserver === 'function' && view.parentNode) {
  const ro = new ResizeObserver(() => { if (!stopped) { resize(); fitView(); } });
  ro.observe(view.parentNode);
  teardown.push(() => ro.disconnect());
} else {
  on(window, 'resize', () => { resize(); fitView(); });
}

/* =============================================================================
 * 15. THE MAIN LOOP
 * ========================================================================== */


let frameCount = 0;
let time = 0;

function startBoot() {
  drillPath.length = 0;
  selected = null;
  hovered = null;
  bootLevel(root);
  autoFrame = { fit: true };
  fitView();
}

/** Everything connected to the active node, for the focus mode. */
function updateFocus(dt) {
  const active = hovered || selected;
  const related = new Set();
  if (active) {
    related.add(active);
    for (const e of active.level.edges) {
      if (e.a === active) related.add(e.b);
      if (e.b === active) related.add(e.a);
    }
  }

  // The level currently inside. Everything above it in the tree is dimmed, or
  // at depth the neighbours from higher levels compete for attention with what
  // you are looking at. The containers on the path itself must stay lit: they
  // are the frame, and they show where you came from.
  const host = drillPath[drillPath.length - 1] || null;
  const activeLevel = host ? host.sub : root;
  const onPath = new Set(drillPath);

  for (const n of allNodes) {
    const isHover = n === hovered;
    const isSel = n === selected;
    n.hover = approach(n.hover, isHover ? 1 : 0, 12, dt);
    n.select = approach(n.select, isSel ? 1 : 0, 10, dt);

    // Dim only siblings on the same level: the container the active node sits
    // in must not be dimmed, since it is what is showing it.
    const sameLevel = active && n.level === active.level;
    // Pointing at a card is a question about that card. What it is not connected
    // to steps well back — the answer should be visible without reading, and a
    // card darkened by colour rather than faded is still legible if you look.
    let target = !active || !sameLevel ? 1 : (related.has(n) ? 1 : 0.30);
    if (n.level !== activeLevel && !onPath.has(n)) target = Math.min(target, 0.28);
    n.dim = approach(n.dim, target, 8, dt);
  }

  for (const e of allEdges) {
    const on = active && (e.a === active || e.b === active);
    const sameLevel = active && e.level === active.level;
    e.hover = approach(e.hover, on ? 1 : 0, 11, dt);
    // At rest the lines sit back. Every edge at full strength turns the picture
    // into a web with cards floating in it — the cards are what is being read,
    // and the lines matter once you ask about one of them. Point at a card and
    // its own lines come up to full.
    let target = !active ? EDGE_REST : (!sameLevel ? 1 : (on ? 1 : 0.14));
    if (e.level !== activeLevel) target = Math.min(target, 0.12);
    e.dim = approach(e.dim, target, 8, dt);
  }
}

/**
 * Updates one level: assembly, opening, and travel towards target positions.
 * Returns true while anything is still moving, which is the signal to redo
 * the arrangement and the edge geometry.
 */
function updateLevel(level, dt) {
  let moving = false;
  const elapsed = time - (level.bootStart || 0);

  // Nodes assemble on the level's own schedule.
  for (const n of level.nodes) {
    const target = clamp((elapsed - n.bootDelay) / 1.05, 0, 1);
    if (target > n.boot) { n.boot = target; moving = true; }
  }
  // An edge only grows once both of its nodes are assembled enough to hold it.
  for (const e of level.edges) {
    if (e.boot < 1 && e.a.boot > 0.55 && e.b.boot > 0.35) {
      e.boot = clamp(e.boot + dt * 1.35, 0, 1);
    }
  }

  // Opening: the node's size travels from collapsed to container-sized.
  for (const n of level.nodes) {
    const target = n.expanded ? 1 : 0;
    if (Math.abs(n.expandT - target) > 0.0015) {
      n.expandT = approach(n.expandT, target, 5.5, dt);
      moving = true;
    } else {
      n.expandT = target;
    }
    if (n.sub) {
      // A nested level lives as long as its container is even slightly open.
      if (n.expandT > 0.002 && updateLevel(n.sub, dt)) moving = true;
      // The container's size comes from the CURRENT layout of its contents:
      // when a node inside opens too, the subgraph grows, and the container
      // must grow with it or the frame cuts its own contents off.
      //
      // Room for a hovered child is held permanently, not opened when the mouse
      // arrives. A child grows at draw time and the layout never hears about it,
      // so the space has to be there already — otherwise the container resizes
      // every time the pointer crosses into it, and its whole contents shift.
      n.openW = Math.max(n.baseW, n.sub.w + NEST.padX * 2 + HOVER_GROW_W);
      n.openH = n.sub.h + NEST.padTop + NEST.padBottom + HOVER_GROW_H;
      const k = easeInOutCubic(n.expandT);
      n.w = lerp(n.baseW, n.openW, k);
      n.h = lerp(n.baseH, n.openH, k);
    } else if (n.leaf) {
      // A leaf opens into a card rather than a subgraph. The scene may size it
      // to what it holds: an empty bottom third looks like a mistake.
      const size = SCENE.detail.size ? SCENE.detail.size(n) : SCENE.detail;
      n.openW = Math.max(n.baseW, size.w);
      n.openH = Math.max(n.baseH, size.h);
      const k = easeInOutCubic(n.expandT);
      n.w = lerp(n.baseW, n.openW, k);
      n.h = lerp(n.baseH, n.openH, k);
    }
  }

  // Sizes changed, so recompute the targets and let the neighbours move aside.
  if (moving) placeLevel(level, null, false);

  for (const n of level.nodes) {
    const nx = approach(n.lx, n.ltx, 7, dt);
    const ny = approach(n.ly, n.lty, 7, dt);
    if (Math.abs(nx - n.lx) > 0.002 || Math.abs(ny - n.ly) > 0.002) moving = true;
    n.lx = nx; n.ly = ny;
  }

  if (moving) for (const e of level.edges) e.dirty = true;
  return moving;
}

/** Turns a level's local coordinates into world ones, down the tree. */
function syncAbsolute(level, ox, oy) {
  for (const n of level.nodes) {
    n.x = ox + n.lx;
    n.y = oy + n.ly;
    if (n.sub && n.expandT > 0.002) {
      // A container's contents sit lower down: its header keeps the top.
      syncAbsolute(n.sub, n.x, n.y + (NEST.padTop - NEST.padBottom) / 2);
    }
  }
}

function update(dt) {
  const moving = updateLevel(root, dt);
  syncAbsolute(root, 0, 0);

  // While the picture is spreading or collapsing its extent changes every
  // frame, so the framing has to be recomputed until the animation ends, or
  // the camera settles on some half-inflated intermediate state.
  if (autoFrame) {
    if (autoFrame.fit) fitView();
    else if (autoFrame.node) focusCamera(autoFrame.node);
    if (!moving) autoFrame = null;
  }

  updateFocus(dt);

  // The camera eases towards its targets. The frame deliberately does not
  // shake: projector wobble and sweep glitches got in the way of reading.
  cam.scale = approach(cam.scale, cam.tscale, 9, dt);
  cam.x = approach(cam.x, cam.tx, 9, dt);
  cam.y = approach(cam.y, cam.ty, 9, dt);

  if (SCENE.tick) SCENE.tick(dt);

  // Rebuild edge geometry after dragging and opening.
  for (const e of allEdges) if (e.dirty) rebuildEdge(e);

  // The whole graph runs, not only the visible part: what is inside a closed
  // group is still doing its work.
  for (const n of allNodes) {
    if (n.leaf) SCENE.leaf.step(n.leaf, dt);
    else n.load = clamp(n.load + (Math.random() - 0.5) * dt * 0.06, 0.08, 0.97);
  }
  computeStats(root);
}

/** A summary over a subtree, aggregated from its leaves. */
function computeStats(level) {
  let agents = 0, tokens = 0, active = 0;
  for (const n of level.nodes) {
    if (n.leaf) {
      n.stats = SCENE.leaf.stats(n.leaf);
    } else if (n.sub) {
      n.stats = computeStats(n.sub);
    } else {
      n.stats = { agents: 0, tokens: 0, active: 0 };
    }
    agents += n.stats.agents;
    tokens += n.stats.tokens;
    active += n.stats.active;
  }
  return { agents, tokens, active };
}

function renderScene(t, dt, fps) {
  const ctx = RT.scene.x;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  drawBackground(ctx, t);
  drawGrid(ctx, t);
  drawRings(ctx, t);
  drawDust(ctx, t);

  drawLevel(ctx, root, t, dt);
  drawOverlay(ctx, t, fps);
}

/**
 * Draws one level. Nested levels arrive here recursively from drawNode: an
 * opened node's contents are its own subgraph.
 */
function drawLevel(ctx, level, t, dt) {
  // Edges go under the panels.
  for (const e of level.edges) drawEdge(ctx, e, t);
  for (const e of level.edges) drawPackets(ctx, e, t, dt);

  // Assembly particles, then the panels themselves.
  for (const n of level.nodes) drawNodeMotes(ctx, n, t);

  // The active node is drawn last so that it sits above the rest.
  const active = hovered || selected;
  let deferred = null;
  for (const n of level.nodes) {
    if (n === active) { deferred = n; continue; }
    drawNode(ctx, n, t, dt);
  }
  if (deferred) drawNode(ctx, deferred, t, dt);

  // Now that the panels are down, the labels go on top of them.
  // The link being pulled, drawn over the cards so it is never lost behind one.
  if (linkFrom) {
    const p0 = worldToScreen(linkFrom.x, linkFrom.y);
    const p1 = linkOver ? worldToScreen(linkOver.x, linkOver.y) : { x: pointer.x, y: pointer.y };
    ctx.save();
    ctx.strokeStyle = rgba(linkOver ? C.green : C.cyan, linkOver ? 0.95 : 0.6);
    ctx.lineWidth = 2;
    ctx.setLineDash(linkOver ? [] : [6, 5]);
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(p1.x, p1.y, linkOver ? 6 : 4, 0, Math.PI * 2);
    ctx.fillStyle = rgba(linkOver ? C.green : C.cyan, 0.9); ctx.fill();
    ctx.restore();
  }

  flushEdgeLabels(ctx);
}

let lastTime = 0;
let fps = 60;
let bootHidden = false;

function frame(now) {
  if (stopped) return;
  // Whoever removed this canvas from the page is not obliged to have told us.
  if (!view.isConnected) { HUD_API.destroy(); return; }
  requestAnimationFrame(frame);
  // Tabs here are switched by hiding, not by removing. A panel nobody is looking
  // at still costs a bloom pyramid per frame, so keep the loop and skip the work.
  // Same for a diagram scrolled off: a page of journeys holds one canvas each.
  if (!view.offsetParent || !onScreen) { lastTime = 0; return; }

  const nowSec = now / 1000;
  let dt = lastTime ? nowSec - lastTime : 1 / 60;
  lastTime = nowSec;
  dt = Math.min(dt, 1 / 20);            // guards against the jump after a background tab

  fps = lerp(fps, 1 / Math.max(dt, 1e-4), 0.08);

  if (!FLAGS.paused) {
    time += dt;
    update(dt);
  }

  // The order matters: the scene is drawn without text, bloom is computed from
  // it, and only then does the text land on top — so letters gain no halo.
  renderScene(time, FLAGS.paused ? 0 : dt, fps);
  if (FLAGS.post && FLAGS.bloom) buildBloom();
  flushText(RT.scene.x);

  // The scene's own layer goes over everything, the node text included: HUD
  // panels and modal screens would otherwise end up under the graph's labels.
  if (SCENE.overlayTop) {
    const ctx = RT.scene.x;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const wasDeferred = deferText;
    deferText = false;
    SCENE.overlayTop(ctx, time, { cssW, cssH, dt, drillPath, hovered, selected });
    deferText = wasDeferred;
  }

  composite(time);

  frameCount++;

  if (!bootHidden && frameCount > 2) {
    bootHidden = true;
    const el = OPTS.bootEl || null;
    if (el) {
      el.classList.add('hidden');
      setTimeout(() => el.remove(), 600);
    }
  }
}

/* --- start ---------------------------------------------------------------- */

// The utilities a scene uses to draw its own cards.
Object.assign(HUD_API, {
  C, KIND, rgba, mix, clamp, lerp, invLerp,
  allNodes, findNode: (id) => allNodes.find((n) => n.id === id),
  fit: () => { autoFrame = { fit: true }; fitView(); },
  focus: (n) => { autoFrame = { node: n }; focusCamera(n); },
  // Opening under program control, which a presentation needs.
  open: (id) => { const n = allNodes.find((x) => x.id === id); return n ? drillInto(n) : false; },
  closeAll: () => { while (drillPath.length) drillOut(); },
  path: () => drillPath.slice(),
  camTo: (x, y, scale) => {
    autoFrame = null;
    cam.tx = x; cam.ty = y;
    if (scale) cam.tscale = clamp(scale, 0.15, 3);
  },
  cam,
  easeOutCubic, easeOutQuint, easeInOutCubic, approach,
  mulberry32, makeNoise1D, noise: noiseA,
  drawText, textWidth, drawGlow, chamferPath, cornerBrackets, leaderDots,
  TAU,
});

if (!SCENE_INPUT) throw new Error('HUD_MOUNT: no scene given.');
SCENE = typeof SCENE_INPUT === 'function' ? SCENE_INPUT(HUD_API) : SCENE_INPUT;
FLAGS.labels = !!SCENE.labels;
if (SCENE.kinds) Object.assign(KIND, SCENE.kinds);        // the scene's own node kinds
if (SCENE.metric) Object.assign(METRIC, SCENE.metric);   // the scene's layout density

buildGraph();
computeStats(root);
layoutLevel(root);
syncAbsolute(root, 0, 0);
for (const e of allEdges) rebuildEdge(e);
resize();
fitView(true);
startBoot();
requestAnimationFrame(frame);

Object.assign(HUD_API, {
  // The panel draws its own toolbar, so it needs the same switches the keyboard has.
  flags: FLAGS,
  back: () => drillOut(),
  // Functions, not getters: Object.assign copies the value a getter returns at
  // copy time, which froze this at zero and made it useless as a probe.
  frames: () => frameCount,
  running: () => !stopped,
  // Enough to check the aim from outside: where the engine thinks the pointer is,
  // and what it believes is under it.
  pointer: () => ({ x: pointer.x, y: pointer.y, inside: pointer.inside }),
  hovered: () => hovered,
  destroy() {
    if (stopped) return;
    stopped = true;
    while (teardown.length) { try { teardown.pop()(); } catch (e) {} }
    if (OPTS.onDestroy) { try { OPTS.onDestroy(); } catch (e) {} }
  },
  resize() { resize(); fitView(); },
  // Declaring mode, switched from the panel beside the canvas. Nothing about the
  // layout changes with it — only what a press means.
  design(on) { designMode = !!on; if (!on) { linkFrom = null; linkOver = null; } },
  designing() { return designMode; },
});
return HUD_API;
};
