/* ------------------------------------------------------------------ *
 * Basemap: Natural Earth 1:50m country outlines, decoded once into
 * unit-Mercator coordinates and drawn straight onto a canvas.
 * ------------------------------------------------------------------ */

function buildBasemap(raw) {
  const sx = raw.transform[0];
  const sy = raw.transform[1];
  const tx = raw.transform[2];
  const ty = raw.transform[3];

  const lengths = decodeInts(raw.arcLengths);
  const flat = decodeInts(raw.arcs);

  // TopoJSON arcs are delta encoded; undo that and project as we go.
  const arcs = new Array(lengths.length);
  let cursor = 0;
  let vertices = 0;
  for (let a = 0; a < lengths.length; a++) {
    const count = lengths[a];
    const xy = new Float64Array(count * 2);
    let qx = 0;
    let qy = 0;
    for (let i = 0; i < count; i++) {
      qx += flat[cursor++];
      qy += flat[cursor++];
      xy[i * 2] = lonToX(qx * sx + tx);
      xy[i * 2 + 1] = latToY(qy * sy + ty);
    }
    arcs[a] = xy;
    vertices += count;
  }

  const countries = raw.countries.map((entry) => {
    const ids = decodeInts(entry.a);
    const rings = [];
    let at = 0;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let wraps = false;
    for (const ringLength of entry.r) {
      const ring = ids.slice(at, at + ringLength);
      at += ringLength;
      rings.push(ring);
      // Russia, Fiji and Antarctica have rings that run over the date line.
      // Left alone they would be drawn as a stripe across the whole map.
      let previous = NaN;
      for (const id of ring) {
        const reversed = id < 0;
        const xy = arcs[reversed ? ~id : id];
        const count = xy.length / 2;
        for (let k = 0; k < count; k++) {
          const i = reversed ? count - 1 - k : k;
          const px = xy[i * 2];
          const py = xy[i * 2 + 1];
          if (!isNaN(previous) && Math.abs(px - previous) > 0.5) wraps = true;
          previous = px;
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
      }
    }
    return {
      name: entry.n,
      rings: rings,
      wraps: wraps,
      bbox: wraps ? [0, minY, 1, maxY] : [minX, minY, maxX, maxY],
    };
  });

  return { arcs: arcs, countries: countries, vertices: vertices };
}

/** Append one ring (a list of signed arc ids) to a canvas path, dropping
 *  vertices that would land on the same pixel as the last one. */
function traceRing(ctx, basemap, ring, view, tolerance, shift) {
  let started = false;
  let lastX = 0;
  let lastY = 0;
  let previous = NaN;
  let wrap = shift || 0;
  for (let r = 0; r < ring.length; r++) {
    const id = ring[r];
    const reversed = id < 0;
    const xy = basemap.arcs[reversed ? ~id : id];
    const count = xy.length / 2;
    for (let k = 0; k < count; k++) {
      const i = reversed ? count - 1 - k : k;
      const raw = xy[i * 2];
      if (!isNaN(previous)) {
        if (raw - previous > 0.5) wrap -= 1;
        else if (raw - previous < -0.5) wrap += 1;
      }
      previous = raw;
      const px = (raw + wrap - view.x) * view.scale;
      const py = (xy[i * 2 + 1] - view.y) * view.scale;
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else if (Math.abs(px - lastX) + Math.abs(py - lastY) > tolerance ||
                 (r === ring.length - 1 && k === count - 1)) {
        ctx.lineTo(px, py);
      } else {
        continue;
      }
      lastX = px;
      lastY = py;
    }
  }
  if (started) ctx.closePath();
}

function drawBasemap(ctx, basemap, view, theme) {
  const width = view.width;
  const height = view.height;
  ctx.save();
  ctx.fillStyle = theme.ocean;
  ctx.fillRect(0, 0, width, height);

  // Graticule, barely there -- it just stops the ocean reading as a void.
  ctx.strokeStyle = theme.graticule;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = view.scale > 4000 ? 1 : view.scale > 1200 ? 5 : 10;
  for (let lon = -180; lon <= 180; lon += step) {
    const px = (lonToX(lon) - view.x) * view.scale;
    if (px < -1 || px > width + 1) continue;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
  }
  for (let lat = -80; lat <= 80; lat += step) {
    const py = (latToY(lat) - view.y) * view.scale;
    if (py < -1 || py > height + 1) continue;
    ctx.moveTo(0, py);
    ctx.lineTo(width, py);
  }
  ctx.stroke();

  // One path per country, filled and stroked on its own. Filling them all
  // as a single even-odd path would make overlapping countries cancel out.
  const tolerance = 0.7;
  const left = view.x - 8 / view.scale;
  const right = view.x + (width + 8) / view.scale;
  const top = view.y - 8 / view.scale;
  const bottom = view.y + (height + 8) / view.scale;

  ctx.fillStyle = theme.land;
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 1;
  for (const country of basemap.countries) {
    const box = country.bbox;
    if (box[2] < left || box[0] > right || box[3] < top || box[1] > bottom) continue;
    // A country that crosses the date line is drawn either side of it too.
    const shifts = country.wraps ? [0, -1, 1] : [0];
    for (const shift of shifts) {
      ctx.beginPath();
      for (const ring of country.rings) traceRing(ctx, basemap, ring, view, tolerance, shift);
      // Even-odd within a country so lakes and enclaves stay punched out.
      ctx.fill('evenodd');
      ctx.stroke();
    }
  }
  ctx.restore();
}

/* ------------------------------------------------ point in which country */

function ringContains(basemap, ring, x, y) {
  // Ray casting across every vertex of the ring, arc by arc.
  let inside = false;
  let firstX = NaN;
  let firstY = NaN;
  let prevX = NaN;
  let prevY = NaN;
  let previous = NaN;
  let wrap = 0;
  for (let r = 0; r < ring.length; r++) {
    const id = ring[r];
    const reversed = id < 0;
    const xy = basemap.arcs[reversed ? ~id : id];
    const count = xy.length / 2;
    for (let k = 0; k < count; k++) {
      const i = reversed ? count - 1 - k : k;
      const raw = xy[i * 2];
      if (!isNaN(previous)) {
        if (raw - previous > 0.5) wrap -= 1;
        else if (raw - previous < -0.5) wrap += 1;
      }
      previous = raw;
      const cx = raw + wrap;
      const cy = xy[i * 2 + 1];
      if (isNaN(prevX)) {
        firstX = cx;
        firstY = cy;
      } else if ((cy > y) !== (prevY > y) &&
                 x < (prevX - cx) * (y - cy) / (prevY - cy) + cx) {
        inside = !inside;
      }
      prevX = cx;
      prevY = cy;
    }
  }
  if (!isNaN(prevX) && (firstY > y) !== (prevY > y) &&
      x < (prevX - firstX) * (y - firstY) / (prevY - firstY) + firstX) {
    inside = !inside;
  }
  return inside;
}

function countryAt(basemap, lat, lon) {
  const x = lonToX(lon);
  const y = latToY(lat);
  for (const country of basemap.countries) {
    const box = country.bbox;
    if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
    const shifts = country.wraps ? [0, -1, 1] : [0];
    for (const shift of shifts) {
      let inside = false;
      for (const ring of country.rings) {
        if (ringContains(basemap, ring, x + shift, y)) inside = !inside;
      }
      if (inside) return country.name;
    }
  }
  return null;
}

/**
 * At 1:50m a harbour city can sit just outside its own coastline, and a
 * ferry or a beach really is offshore. When no polygon contains the point,
 * fall back to the nearest bit of coast or border within maxKm.
 */
function buildCoastIndex(basemap) {
  const lats = [];
  const lons = [];
  const owners = [];
  const cells = new Map();
  basemap.countries.forEach((country, index) => {
    const seen = new Set();
    for (const ring of country.rings) {
      for (const id of ring) {
        const arcId = id < 0 ? ~id : id;
        if (seen.has(arcId)) continue;
        seen.add(arcId);
        const xy = basemap.arcs[arcId];
        for (let i = 0; i < xy.length; i += 2) {
          const lat = yToLat(xy[i + 1]);
          const lon = xToLon(xy[i]);
          const at = lats.length;
          lats.push(lat);
          lons.push(lon);
          owners.push(index);
          const key = (Math.floor(lat) + 90) * 360 + (Math.floor(lon) + 180);
          let bucket = cells.get(key);
          if (!bucket) cells.set(key, bucket = []);
          bucket.push(at);
        }
      }
    }
  });
  return {
    lat: Float32Array.from(lats),
    lon: Float32Array.from(lons),
    owner: Uint16Array.from(owners),
    cells: cells,
  };
}

function nearestCountry(basemap, lat, lon, maxKm) {
  if (!basemap.coast) basemap.coast = buildCoastIndex(basemap);
  const coast = basemap.coast;
  const limit = maxKm == null ? 30 : maxKm;
  const span = Math.min(4, Math.ceil(limit / 80) + 1);
  const latCell = Math.floor(lat);
  const lonCell = Math.floor(lon);
  let best = -1;
  let bestKm = limit;
  for (let dLat = -span; dLat <= span; dLat++) {
    for (let dLon = -span; dLon <= span; dLon++) {
      let cellLon = lonCell + dLon;
      if (cellLon < -180) cellLon += 360;
      if (cellLon > 179) cellLon -= 360;
      const bucket = coast.cells.get((latCell + dLat + 90) * 360 + (cellLon + 180));
      if (!bucket) continue;
      for (const i of bucket) {
        const km = haversineKm(lat, lon, coast.lat[i], coast.lon[i]);
        if (km < bestKm) {
          bestKm = km;
          best = i;
        }
      }
    }
  }
  return best < 0 ? null : basemap.countries[coast.owner[best]].name;
}

/* ------------------------------------------------------- nearest city */

function buildCityIndex(raw) {
  const lons = decodeInts(raw.lon);
  const lats = decodeInts(raw.lat);
  const pops = decodeInts(raw.pop);
  const countryIds = decodeInts(raw.cityCountries);
  const names = raw.names.split('\t');
  const precision = raw.precision;

  const n = names.length;
  const lat = new Float32Array(n);
  const lon = new Float32Array(n);
  const population = new Int32Array(n);
  let runningLon = 0;
  let runningLat = 0;
  for (let i = 0; i < n; i++) {
    runningLon += lons[i];
    runningLat += lats[i];
    lon[i] = runningLon / precision;
    lat[i] = runningLat / precision;
    population[i] = pops[i] * 1000;
  }

  // One-degree buckets: good enough to shortlist candidates for a nearest
  // search without a real spatial tree.
  const cells = new Map();
  for (let i = 0; i < n; i++) {
    const key = (Math.floor(lat[i]) + 90) * 360 + (Math.floor(lon[i]) + 180);
    let bucket = cells.get(key);
    if (!bucket) cells.set(key, bucket = []);
    bucket.push(i);
  }

  return {
    count: n, lat: lat, lon: lon, population: population, names: names,
    countries: raw.countries, countryIds: countryIds, cells: cells,
  };
}

/** The most notable city within maxKm, trading distance off against size so
 *  a suburb does not out-rank the city it belongs to. */
function nearestCity(index, lat, lon, maxKm) {
  const limit = maxKm == null ? 35 : maxKm;
  const latCell = Math.floor(lat);
  const lonCell = Math.floor(lon);
  const span = Math.min(6, Math.ceil(limit / 80) + 1);
  let best = -1;
  let bestScore = Infinity;
  let bestKm = Infinity;
  for (let dLat = -span; dLat <= span; dLat++) {
    for (let dLon = -span; dLon <= span; dLon++) {
      let cellLon = lonCell + dLon;
      if (cellLon < -180) cellLon += 360;
      if (cellLon > 179) cellLon -= 360;
      const bucket = index.cells.get((latCell + dLat + 90) * 360 + (cellLon + 180));
      if (!bucket) continue;
      for (const i of bucket) {
        const km = haversineKm(lat, lon, index.lat[i], index.lon[i]);
        if (km > limit) continue;
        // A city ten times the size may sit a little further away.
        const score = km / (1 + Math.log10(Math.max(1, index.population[i] / 20000)));
        if (score < bestScore) {
          bestScore = score;
          bestKm = km;
          best = i;
        }
      }
    }
  }
  if (best < 0) return null;
  return {
    name: index.names[best],
    country: index.countries[index.countryIds[best]],
    lat: index.lat[best],
    lon: index.lon[best],
    population: index.population[best],
    km: bestKm,
  };
}
