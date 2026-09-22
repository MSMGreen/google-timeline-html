/* ------------------------------------------------------------------ *
 * The map. Plain canvas, no libraries.
 *
 * Points are not drawn as shapes: they are added into a floating point
 * accumulation buffer (one channel for how much landed on a pixel, one
 * for the average timestamp of what landed there) which is then tone
 * mapped. That is what gives dense places a white-hot core and keeps a
 * single overnight fix visible as a faint dot.
 * ------------------------------------------------------------------ */

const THEME = {
  ocean: '#070b17',
  land: '#151d33',
  border: 'rgba(125,163,224,0.30)',
  graticule: 'rgba(120,150,210,0.055)',
};

/* Teal for the oldest points through to amber for the newest. */
const RAMP_STOPS = [
  [0.00, 0x19, 0xc8, 0xc0],
  [0.25, 0x56, 0xd8, 0xb0],
  [0.50, 0xcf, 0xe0, 0x9a],
  [0.75, 0xff, 0xc1, 0x65],
  [1.00, 0xff, 0x91, 0x30],
];

function buildRamp() {
  const r = new Uint8Array(256);
  const g = new Uint8Array(256);
  const b = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let s = 0;
    while (s < RAMP_STOPS.length - 2 && t > RAMP_STOPS[s + 1][0]) s++;
    const a = RAMP_STOPS[s];
    const c = RAMP_STOPS[s + 1];
    const f = (t - a[0]) / (c[0] - a[0]);
    r[i] = a[1] + (c[1] - a[1]) * f;
    g[i] = a[2] + (c[2] - a[2]) * f;
    b[i] = a[3] + (c[3] - a[3]) * f;
  }
  return { r: r, g: g, b: b };
}

const RAMP = buildRamp();

function rampCss(t) {
  const i = Math.max(0, Math.min(255, Math.round(t * 255)));
  return `rgb(${RAMP.r[i]},${RAMP.g[i]},${RAMP.b[i]})`;
}

function createMap(canvas, basemap) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const baseCanvas = document.createElement('canvas');
  const baseCtx = baseCanvas.getContext('2d', { alpha: false });
  const glowCanvas = document.createElement('canvas');
  const glowCtx = glowCanvas.getContext('2d');
  const lineCanvas = document.createElement('canvas');
  const lineCtx = lineCanvas.getContext('2d');
  const arcCanvas = document.createElement('canvas');
  const arcCtx = arcCanvas.getContext('2d');

  const view = { x: 0, y: 0, scale: 256, width: 1, height: 1, dpr: 1 };
  const state = {
    data: null,
    range: null,
    arcs: [],
    showArcs: true,
    showTrails: true,
    showPoints: true,
    exposure: 1.1,
    glowView: null,
    pending: null,
    idleTimer: 0,
    interacting: false,
    tiles: null,
    onViewChange: null,
    onHover: null,
  };

  let acc = new Float32Array(1);
  let tsum = new Float32Array(1);
  let image = null;

  /* ------------------------------------------------------------ sizing */

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (width === view.width && height === view.height && dpr === view.dpr) return false;
    view.width = width;
    view.height = height;
    view.dpr = dpr;
    for (const c of [canvas, baseCanvas, glowCanvas, lineCanvas, arcCanvas]) {
      c.width = width;
      c.height = height;
    }
    acc = new Float32Array(width * height);
    tsum = new Float32Array(width * height);
    image = ctx.createImageData(width, height);
    const data = image.data;
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    return true;
  }

  /* ----------------------------------------------------------- helpers */

  function clampView() {
    const minScale = Math.min(view.width, view.height) * 0.55;
    const maxScale = 1 << 26;
    view.scale = Math.max(minScale, Math.min(maxScale, view.scale));
    const worldHeight = view.height / view.scale;
    if (worldHeight >= 1) {
      view.y = 0.5 - worldHeight / 2;
    } else {
      view.y = Math.max(0, Math.min(1 - worldHeight, view.y));
    }
    const worldWidth = view.width / view.scale;
    if (worldWidth >= 1) {
      view.x = 0.5 - worldWidth / 2;
    } else {
      view.x = Math.max(0, Math.min(1 - worldWidth, view.x));
    }
  }

  function fitTo(minLat, minLon, maxLat, maxLon, padding) {
    const pad = padding == null ? 0.12 : padding;
    const x0 = lonToX(minLon);
    const x1 = lonToX(maxLon);
    const y0 = latToY(maxLat);
    const y1 = latToY(minLat);
    const spanX = Math.max(1e-6, (x1 - x0) * (1 + pad * 2));
    const spanY = Math.max(1e-6, (y1 - y0) * (1 + pad * 2));
    view.scale = Math.min(view.width / spanX, view.height / spanY);
    view.x = (x0 + x1) / 2 - view.width / view.scale / 2;
    view.y = (y0 + y1) / 2 - view.height / view.scale / 2;
    clampView();
    invalidate(true);
  }

  function screenToLatLon(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * view.dpr;
    const py = (clientY - rect.top) * view.dpr;
    return [yToLat(view.y + py / view.scale), xToLon(view.x + px / view.scale)];
  }

  /* ------------------------------------------------------- point layer */

  function clearAccumulation() {
    acc.fill(0);
    tsum.fill(0);
    lineCtx.clearRect(0, 0, view.width, view.height);
  }

  function splatRadius() {
    // Even at world zoom a lone fix gets a soft cross, or a single night in
    // a city you visited once would be invisible next to thirteen years of
    // commuting.
    if (view.scale > (1 << 19)) return 2;
    return 1;
  }

  function accumulate(from, to, radius) {
    const data = state.data;
    const x = data.x;
    const y = data.y;
    const colour = data.colour;
    const width = view.width;
    const height = view.height;
    const scale = view.scale;
    const viewX = view.x;
    const viewY = view.y;
    for (let i = from; i < to; i++) {
      const px = (x[i] - viewX) * scale;
      if (px < 0 || px >= width) continue;
      const py = (y[i] - viewY) * scale;
      if (py < 0 || py >= height) continue;
      const cx = px | 0;
      const cy = py | 0;
      const c = colour[i];
      const p = cy * width + cx;
      acc[p] += 1;
      tsum[p] += c;
      if (radius === 0) continue;
      const side = 0.35;
      if (cx > 0) { acc[p - 1] += side; tsum[p - 1] += c * side; }
      if (cx < width - 1) { acc[p + 1] += side; tsum[p + 1] += c * side; }
      if (cy > 0) { acc[p - width] += side; tsum[p - width] += c * side; }
      if (cy < height - 1) { acc[p + width] += side; tsum[p + width] += c * side; }
      if (radius > 1) {
        const corner = 0.18;
        if (cx > 0 && cy > 0) { acc[p - width - 1] += corner; tsum[p - width - 1] += c * corner; }
        if (cx < width - 1 && cy > 0) { acc[p - width + 1] += corner; tsum[p - width + 1] += c * corner; }
        if (cx > 0 && cy < height - 1) { acc[p + width - 1] += corner; tsum[p + width - 1] += c * corner; }
        if (cx < width - 1 && cy < height - 1) { acc[p + width + 1] += corner; tsum[p + width + 1] += c * corner; }
      }
    }
  }

  /** Short hops drawn as lines: at street level your own tracks draw the
   *  roads, which is the only street detail a self-contained file can have. */
  function drawTrails(from, to) {
    const data = state.data;
    const x = data.x;
    const y = data.y;
    const t = data.t;
    const colour = data.colour;
    const width = view.width;
    const height = view.height;
    // Join two fixes only when they are close both in time and on the
    // ground: a few minutes and about a kilometre. Anything looser turns a
    // dropped signal into a spoke straight across the city.
    const maxGap = 6 * 60000;
    const maxUnits = 1.2 / 40075;
    const maxPixels = 400;
    // The trails fade in over a couple of zoom levels rather than appearing
    // all at once.
    const fade = Math.max(0, Math.min(1, (Math.log2(view.scale) - 16) / 3));
    lineCtx.lineWidth = Math.max(1, view.dpr * 0.75);
    lineCtx.lineCap = 'round';
    for (let i = Math.max(1, from); i < to; i++) {
      if (t[i] - t[i - 1] > maxGap) continue;
      const ax = (x[i - 1] - view.x) * view.scale;
      const ay = (y[i - 1] - view.y) * view.scale;
      const bx = (x[i] - view.x) * view.scale;
      const by = (y[i] - view.y) * view.scale;
      if ((ax < 0 && bx < 0) || (ax > width && bx > width)) continue;
      if ((ay < 0 && by < 0) || (ay > height && by > height)) continue;
      const du = x[i] - x[i - 1];
      const dv = y[i] - y[i - 1];
      if (du * du + dv * dv > maxUnits * maxUnits) continue;
      const dx = bx - ax;
      const dy = by - ay;
      if (dx * dx + dy * dy > maxPixels * maxPixels) continue;
      lineCtx.strokeStyle = rampCss(colour[i] / 255);
      lineCtx.globalAlpha = 0.1 + 0.22 * fade;
      lineCtx.beginPath();
      lineCtx.moveTo(ax, ay);
      lineCtx.lineTo(bx, by);
      lineCtx.stroke();
    }
    lineCtx.globalAlpha = 1;
  }

  function tonemap() {
    const pixels = image.data;
    const exposure = state.exposure;
    const n = view.width * view.height;
    const r = RAMP.r;
    const g = RAMP.g;
    const b = RAMP.b;
    for (let p = 0; p < n; p++) {
      const a = acc[p];
      const o = p * 4;
      if (a === 0) {
        pixels[o] = 0;
        pixels[o + 1] = 0;
        pixels[o + 2] = 0;
        continue;
      }
      const shade = (tsum[p] / a) | 0;
      const exposed = a * exposure;
      const brightness = 1 - Math.exp(-exposed);
      // Only genuinely crowded pixels bleach towards white, the way a long
      // exposure blows out a city centre but not a single passing fix.
      const white = exposed > 3 ? Math.min(1, (exposed - 3) / 12) : 0;
      const cr = r[shade];
      const cg = g[shade];
      const cb = b[shade];
      pixels[o] = (cr + (255 - cr) * white) * brightness;
      pixels[o + 1] = (cg + (255 - cg) * white) * brightness;
      pixels[o + 2] = (cb + (255 - cb) * white) * brightness;
    }
    glowCtx.putImageData(image, 0, 0);
  }

  /* -------------------------------------------------------- flight arcs */

  /** Arcs go onto their own canvas and are blended in once. Drawing them
   *  straight onto the map with additive blending turns a route flown fifty
   *  times into a white line; this way it just gets solid. */
  function drawArcs() {
    arcCtx.clearRect(0, 0, view.width, view.height);
    if (!state.showArcs || !state.arcs.length || !state.range) return;
    const range = state.range;
    const target = arcCtx;
    target.save();
    target.lineWidth = Math.max(1, view.dpr * 0.8);
    for (const arc of state.arcs) {
      if (arc.t < range.t0 || arc.t > range.t1) continue;
      target.strokeStyle = rampCss(arc.shade);
      target.globalAlpha = 0.16 + 0.16 * arc.weight;
      // An arc that crosses the date line is stored as two paths.
      for (const path of arc.paths) {
        let visible = false;
        for (let i = 0; i < path.length; i += 2) {
          const px = (path[i] - view.x) * view.scale;
          const py = (path[i + 1] - view.y) * view.scale;
          if (px > -50 && px < view.width + 50 && py > -50 && py < view.height + 50) { visible = true; break; }
        }
        if (!visible) continue;
        target.beginPath();
        for (let i = 0; i < path.length; i += 2) {
          const px = (path[i] - view.x) * view.scale;
          const py = (path[i + 1] - view.y) * view.scale;
          if (i === 0) target.moveTo(px, py);
          else target.lineTo(px, py);
        }
        target.stroke();
      }
    }
    target.restore();
  }

  /* ------------------------------------------------------- compositing */

  function composite() {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.drawImage(baseCanvas, 0, 0);
    if (!state.data) return;

    const source = state.glowView;
    ctx.globalCompositeOperation = 'lighter';
    if (source) {
      // While the user is dragging we reuse the last render, shifted and
      // scaled into place, rather than recomputing millions of points.
      const ratio = view.scale / source.scale;
      const dx = (source.x - view.x) * view.scale;
      const dy = (source.y - view.y) * view.scale;
      const w = view.width * ratio;
      const h = view.height * ratio;
      if (ratio === 1 && dx === 0 && dy === 0) {
        if (state.showTrails) ctx.drawImage(lineCanvas, 0, 0);
        if (state.showPoints) ctx.drawImage(glowCanvas, 0, 0);
      } else {
        ctx.globalAlpha = 0.75;
        if (state.showTrails) ctx.drawImage(lineCanvas, dx, dy, w, h);
        if (state.showPoints) ctx.drawImage(glowCanvas, dx, dy, w, h);
        ctx.globalAlpha = 1;
      }
    }
    drawArcs();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.95;
    ctx.drawImage(arcCanvas, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function renderBase() {
    drawBasemap(baseCtx, basemap, view, THEME);
    if (state.tiles) state.tiles.draw(baseCtx, view);
  }

  /** Redraw the point cloud in slices so the page stays responsive. */
  function startPointRender() {
    if (!state.data || !state.range) {
      state.glowView = null;
      composite();
      return;
    }
    if (state.pending) cancelAnimationFrame(state.pending.handle);
    clearAccumulation();
    const radius = splatRadius();
    const job = {
      i: state.range.i0,
      end: state.range.i1,
      radius: radius,
      chunk: 120000,
      handle: 0,
      since: performance.now(),
    };
    state.pending = job;
    state.glowView = { x: view.x, y: view.y, scale: view.scale };

    const step = () => {
      const started = performance.now();
      while (job.i < job.end && performance.now() - started < 12) {
        const to = Math.min(job.end, job.i + job.chunk);
        if (state.showPoints) accumulate(job.i, to, job.radius);
        if (state.showTrails && view.scale > 60000) drawTrails(job.i, to);
        job.i = to;
      }
      tonemap();
      composite();
      if (job.i < job.end) {
        job.handle = requestAnimationFrame(step);
      } else {
        state.pending = null;
      }
    };
    step();
  }

  function invalidate(immediate) {
    renderBase();
    composite();
    clearTimeout(state.idleTimer);
    if (immediate) {
      startPointRender();
    } else {
      state.idleTimer = setTimeout(startPointRender, 140);
    }
    if (state.onViewChange) state.onViewChange(view);
  }

  /* ------------------------------------------------------- interaction */

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let moved = false;

  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    moved = false;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('dragging');
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) {
      if (state.onHover) state.onHover(screenToLatLon(event.clientX, event.clientY), event);
      return;
    }
    const dx = (event.clientX - lastX) * view.dpr;
    const dy = (event.clientY - lastY) * view.dpr;
    if (Math.abs(dx) + Math.abs(dy) < 1) return;
    moved = true;
    lastX = event.clientX;
    lastY = event.clientY;
    view.x -= dx / view.scale;
    view.y -= dy / view.scale;
    clampView();
    invalidate(false);
  });

  function endDrag(event) {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('dragging');
    if (event && canvas.hasPointerCapture && canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  }

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  function zoomBy(factor, clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const px = clientX == null ? view.width / 2 : (clientX - rect.left) * view.dpr;
    const py = clientY == null ? view.height / 2 : (clientY - rect.top) * view.dpr;
    const beforeX = view.x + px / view.scale;
    const beforeY = view.y + py / view.scale;
    view.scale *= factor;
    clampView();
    view.x = beforeX - px / view.scale;
    view.y = beforeY - py / view.scale;
    clampView();
    invalidate(false);
  }

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    zoomBy(Math.pow(2, -delta / 420), event.clientX, event.clientY);
  }, { passive: false });

  canvas.addEventListener('dblclick', (event) => {
    event.preventDefault();
    zoomBy(2, event.clientX, event.clientY);
  });

  let pinch = null;
  canvas.addEventListener('touchstart', (event) => {
    if (event.touches.length === 2) {
      const [a, b] = event.touches;
      pinch = { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
      dragging = false;
    }
  }, { passive: true });

  canvas.addEventListener('touchmove', (event) => {
    if (pinch && event.touches.length === 2) {
      event.preventDefault();
      const [a, b] = event.touches;
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      zoomBy(distance / pinch.distance, (a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
      pinch.distance = distance;
    }
  }, { passive: false });

  canvas.addEventListener('touchend', () => { pinch = null; });

  /* ------------------------------------------------------------- public */

  return {
    view: view,
    resize: function () {
      if (resize()) invalidate(true);
    },
    setData: function (data) {
      state.data = data;
      state.arcs = data ? data.arcs : [];
      state.range = data ? { i0: 0, i1: data.n, t0: -Infinity, t1: Infinity } : null;
    },
    setRange: function (range) {
      state.range = range;
      invalidate(true);
    },
    setOption: function (key, value) {
      state[key] = value;
      invalidate(true);
    },
    getOption: function (key) { return state[key]; },
    setTiles: function (tiles) {
      state.tiles = tiles;
      invalidate(false);
    },
    onViewChange: function (fn) { state.onViewChange = fn; },
    onHover: function (fn) { state.onHover = fn; },
    zoomBy: zoomBy,
    fitTo: fitTo,
    invalidate: invalidate,
    screenToLatLon: screenToLatLon,
    moved: function () { return moved; },
  };
}
