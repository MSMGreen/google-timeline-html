/* ------------------------------------------------------------------ *
 * Optional street map. Everything else in this file works offline; this
 * is the one layer that reaches the network, so it is off by default and
 * only ever loads tiles once you have zoomed past a city block or two.
 * ------------------------------------------------------------------ */

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_MIN_ZOOM = 9;
const TILE_MAX_ZOOM = 18;
const TILE_BUDGET = 80;

function createTileLayer(onTileLoaded) {
  const cache = new Map();
  let inFlight = 0;

  function get(z, x, y) {
    const key = z + '/' + x + '/' + y;
    const hit = cache.get(key);
    if (hit) return hit;
    if (inFlight > 8) return null;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    const entry = { image: image, ready: false, failed: false };
    cache.set(key, entry);
    inFlight++;
    image.onload = () => {
      entry.ready = true;
      inFlight--;
      onTileLoaded();
    };
    image.onerror = () => {
      entry.failed = true;
      inFlight--;
    };
    image.src = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    return entry;
  }

  return {
    draw: function (ctx, view) {
      const ideal = Math.log2(view.scale / 256);
      const z = Math.round(Math.max(TILE_MIN_ZOOM, Math.min(TILE_MAX_ZOOM, ideal)));
      if (ideal < TILE_MIN_ZOOM - 0.5) return;
      const tiles = 1 << z;
      const size = view.scale / tiles;
      const x0 = Math.max(0, Math.floor(view.x * tiles));
      const x1 = Math.min(tiles - 1, Math.floor((view.x + view.width / view.scale) * tiles));
      const y0 = Math.max(0, Math.floor(view.y * tiles));
      const y1 = Math.min(tiles - 1, Math.floor((view.y + view.height / view.scale) * tiles));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > TILE_BUDGET) return;

      // Fade in over one zoom level so the outlines hand over gently.
      const alpha = Math.max(0, Math.min(1, ideal - (TILE_MIN_ZOOM - 0.5)));
      ctx.save();
      ctx.globalAlpha = alpha * 0.85;
      if (typeof ctx.filter === 'string') {
        ctx.filter = 'grayscale(1) invert(1) brightness(0.62) contrast(1.15) sepia(0.45) hue-rotate(168deg) saturate(1.6)';
      }
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const entry = get(z, x, y);
          if (!entry || !entry.ready) continue;
          ctx.drawImage(
            entry.image,
            Math.floor((x / tiles - view.x) * view.scale),
            Math.floor((y / tiles - view.y) * view.scale),
            Math.ceil(size) + 1, Math.ceil(size) + 1,
          );
        }
      }
      ctx.restore();
    },
    clear: function () { cache.clear(); },
  };
}
