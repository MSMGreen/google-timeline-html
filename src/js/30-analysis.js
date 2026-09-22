/* ------------------------------------------------------------------ *
 * Everything under the map: where you slept, how far you went and by
 * what, when in the week you move, and how long you spent in each
 * country and city.
 *
 * All of it is derived from the points, so it works the same whether the
 * export was a decade of Records.json or last year's Timeline.json.
 * ------------------------------------------------------------------ */

const HOME_RADIUS_KM = 40;       // beyond this, a night counts as away
const HOME_WINDOW_DAYS = 45;     // half-width of the window that decides where home is
const CLUSTER_RADIUS_KM = 5;     // how far apart two places-in-a-day can be
const MAX_DWELL_MS = 4 * HOUR_MS;
const FLIGHT_MIN_KM = 350;
const ARC_SEGMENTS = 48;

/** Speeds used only when the export has no activity labels at all. */
function modeFromSpeed(kmh) {
  if (kmh < 1) return 11;
  if (kmh < 7) return 1;
  if (kmh < 25) return 3;
  if (kmh < 120) return 4;
  if (kmh < 250) return 6;
  return 8;
}

/* -------------------------------------------------- render preparation */

function greatCirclePath(lat1, lon1, lat2, lon2, steps) {
  const p1 = lat1 * DEG;
  const l1 = lon1 * DEG;
  const p2 = lat2 * DEG;
  const l2 = lon2 * DEG;
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  const out = [];
  for (let i = 0; i < steps; i++) {
    const f = i / (steps - 1);
    let lat;
    let lon;
    if (d < 1e-9) {
      lat = lat1;
      lon = lon1;
    } else {
      const a = Math.sin((1 - f) * d) / Math.sin(d);
      const b = Math.sin(f * d) / Math.sin(d);
      const x = a * Math.cos(p1) * Math.cos(l1) + b * Math.cos(p2) * Math.cos(l2);
      const y = a * Math.cos(p1) * Math.sin(l1) + b * Math.cos(p2) * Math.sin(l2);
      const z = a * Math.sin(p1) + b * Math.sin(p2);
      lat = Math.atan2(z, Math.hypot(x, y)) / DEG;
      lon = Math.atan2(y, x) / DEG;
    }
    out.push(lat, lon);
  }
  return out;
}

/** Project an arc, keeping longitude continuous, and split it in two if it
 *  runs off one edge of the map and back on at the other. */
function arcPaths(latLons) {
  const xs = [];
  const ys = [];
  let previous = latLons[1];
  let wrap = 0;
  for (let i = 0; i < latLons.length; i += 2) {
    let lon = latLons[i + 1];
    if (lon - previous > 180) wrap -= 360;
    else if (lon - previous < -180) wrap += 360;
    previous = lon;
    lon += wrap;
    xs.push(lonToX(lon));
    ys.push(latToY(latLons[i]));
  }
  const paths = [];
  const push = (shift) => {
    const path = new Float64Array(xs.length * 2);
    for (let i = 0; i < xs.length; i++) {
      path[i * 2] = xs[i] + shift;
      path[i * 2 + 1] = ys[i];
    }
    paths.push(path);
  };
  push(0);
  const min = Math.min.apply(null, xs);
  const max = Math.max.apply(null, xs);
  if (max > 1) push(-1);
  else if (min < 0) push(1);
  return paths;
}

/**
 * Project every point once, work out its colour, and find the long hops
 * that deserve an arc.
 */
function prepareRenderData(data) {
  const n = data.n;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const colour = new Uint8Array(n);
  const t = data.t;
  const t0 = t[0];
  const span = Math.max(1, t[n - 1] - t0);

  for (let i = 0; i < n; i++) {
    x[i] = lonToX(data.lon[i] / 1e7);
    y[i] = latToY(data.lat[i] / 1e7);
    colour[i] = ((t[i] - t0) / span) * 255;
  }

  // Long hops come from two places: a big jump between consecutive fixes
  // (the usual shape of a flight in Records.json, where the phone is off),
  // and any trip segment long enough to be a flight. Exports that record
  // the whole cruise have no jump to find, so both are needed.
  const arcs = [];
  const seen = new Set();
  const addArc = (at, lat0, lon0, lat1, lon1, shade) => {
    const km = haversineKm(lat0, lon0, lat1, lon1);
    if (km < FLIGHT_MIN_KM) return;
    const key = Math.round(at / HOUR_MS) + ':' + Math.round(lat0) + ':' + Math.round(lon0) +
      ':' + Math.round(lat1) + ':' + Math.round(lon1);
    if (seen.has(key)) return;
    seen.add(key);
    arcs.push({
      t: at,
      km: km,
      shade: shade,
      weight: Math.min(1, km / 8000),
      from: [lat0, lon0],
      to: [lat1, lon1],
      paths: arcPaths(greatCirclePath(lat0, lon0, lat1, lon1, ARC_SEGMENTS)),
    });
  };

  const covered = [];
  for (const trip of data.trips) {
    const before = arcs.length;
    addArc(trip.t0, trip.lat0, trip.lon0, trip.lat1, trip.lon1,
      Math.max(0, Math.min(1, (trip.t0 - t0) / span)));
    if (arcs.length > before) covered.push([trip.t0, Math.max(trip.t1, trip.t0)]);
  }

  // A run of fixes labelled as flying is one hop, however many fixes it
  // holds.
  for (let i = 0; i < n; i++) {
    if (data.mode[i] !== 8) continue;
    let end = i;
    while (end + 1 < n && data.mode[end + 1] === 8 && t[end + 1] - t[end] < 3 * HOUR_MS) end++;
    if (end > i) {
      addArc(t[i], data.lat[i] / 1e7, data.lon[i] / 1e7,
        data.lat[end] / 1e7, data.lon[end] / 1e7, colour[i] / 255);
      covered.push([t[i], t[end]]);
    }
    i = end;
  }

  // Finally, jumps between consecutive fixes -- but not inside a hop that
  // one of the passes above already drew, or a sparsely recorded flight
  // becomes a row of overlapping part-arcs.
  for (let i = 1; i < n; i++) {
    const dt = t[i] - t[i - 1];
    if (dt < 15 * 60000 || dt > 36 * HOUR_MS) continue;
    let inside = false;
    for (const [from, to] of covered) {
      if (t[i] >= from - HOUR_MS && t[i - 1] <= to + HOUR_MS) { inside = true; break; }
    }
    if (inside) continue;
    addArc(t[i], data.lat[i - 1] / 1e7, data.lon[i - 1] / 1e7,
      data.lat[i] / 1e7, data.lon[i] / 1e7, colour[i] / 255);
  }
  arcs.sort((a, b) => a.t - b.t);

  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  for (let i = 0; i < n; i++) {
    const lat = data.lat[i] / 1e7;
    const lon = data.lon[i] / 1e7;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }

  // A second, tighter frame that ignores the outermost half percent, so one
  // bad fix in the middle of the ocean cannot force the whole world into view.
  const step = Math.max(1, Math.floor(n / 20000));
  const sampleLat = [];
  const sampleLon = [];
  for (let i = 0; i < n; i += step) {
    sampleLat.push(data.lat[i] / 1e7);
    sampleLon.push(data.lon[i] / 1e7);
  }
  sampleLat.sort((a, b) => a - b);
  sampleLon.sort((a, b) => a - b);
  const low = Math.floor(sampleLat.length * 0.005);
  const high = Math.min(sampleLat.length - 1, Math.ceil(sampleLat.length * 0.995));

  return {
    n: n, t: t, lat: data.lat, lon: data.lon, mode: data.mode, tz: data.tz,
    x: x, y: y, colour: colour, arcs: arcs,
    bounds: { minLat: minLat, maxLat: maxLat, minLon: minLon, maxLon: maxLon },
    core: {
      minLat: sampleLat[low], maxLat: sampleLat[high],
      minLon: sampleLon[low], maxLon: sampleLon[high],
    },
    trips: data.trips, visits: data.visits, counts: data.counts,
  };
}

/* --------------------------------------------------------- the analysis */

function placeKey(lat, lon) {
  return Math.round(lat * 20) + ':' + Math.round(lon * 20);
}

function analyse(data, basemap, cities) {
  const n = data.n;
  const t = data.t;
  const lat = data.lat;
  const lon = data.lon;
  const tz = data.tz;

  let hasOffsets = false;
  for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 4000))) {
    if (tz[i] !== 0) { hasOffsets = true; break; }
  }
  const offsetAt = hasOffsets
    ? (i) => tz[i]
    : (i) => Math.round(lon[i] / 1e7 / 15) * 60;

  /* --- per point dwell, distance, mode ---------------------------- */

  const heat = new Float32Array(7 * 24);
  const kmByMode = new Float64Array(MODES.length);
  const monthly = new Map();
  let totalPointKm = 0;
  let labelled = 0;

  for (let i = 1; i < n; i++) {
    const dt = t[i] - t[i - 1];
    if (dt <= 0 || dt > 2 * HOUR_MS) continue;
    const km = haversineKm(lat[i - 1] / 1e7, lon[i - 1] / 1e7, lat[i] / 1e7, lon[i] / 1e7);
    if (km > 1500) continue;                 // a teleport, not a journey
    const kmh = km / (dt / HOUR_MS);
    if (kmh > 1100) continue;
    totalPointKm += km;
    const parts = localParts(t[i], offsetAt(i));
    heat[parts.weekday * 24 + parts.hour] += km;
    let mode = data.mode[i];
    if (mode === 0 || mode === 11) {
      mode = mode === 11 && km < 0.05 ? 11 : modeFromSpeed(kmh);
    } else {
      labelled++;
    }
    kmByMode[mode] += km;
    const monthKey = parts.year * 12 + parts.month;
    let month = monthly.get(monthKey);
    if (!month) monthly.set(monthKey, month = { key: monthKey, km: 0, points: 0 });
    month.km += km;
  }

  /* --- distances from trips, when the export has them -------------- */

  const tripKmByMode = new Float64Array(MODES.length);
  let tripKm = 0;
  for (const trip of data.trips) {
    const km = trip.km != null && trip.km > 0
      ? trip.km
      : haversineKm(trip.lat0, trip.lon0, trip.lat1, trip.lon1);
    if (!(km > 0) || km > 20000) continue;
    tripKmByMode[trip.mode] += km;
    tripKm += km;
  }
  // Google's own segments are better than anything we can infer, as long as
  // there are enough of them to cover the period.
  const useTrips = data.trips.length > 50 && tripKm > totalPointKm * 0.35;
  const distanceByMode = useTrips ? tripKmByMode : kmByMode;
  const totalKm = useTrips ? tripKm : totalPointKm;

  /* --- day by day -------------------------------------------------- */

  const placeCache = new Map();
  function placeAt(latitude, longitude) {
    const key = placeKey(latitude, longitude);
    let place = placeCache.get(key);
    if (place === undefined) {
      const city = nearestCity(cities, latitude, longitude, 40);
      place = {
        country: countryAt(basemap, latitude, longitude) ||
          nearestCountry(basemap, latitude, longitude, 30) ||
          (city ? city.country : null),
        city: city ? city.name : null,
        cityLat: city ? city.lat : latitude,
        cityLon: city ? city.lon : longitude,
      };
      placeCache.set(key, place);
    }
    return place;
  }

  const days = [];
  let buffer = [];
  let currentDay = null;

  function flushDay() {
    if (!buffer.length) return;
    // Cluster the day's fixes and keep the one you spent longest in.
    const clusters = [];
    for (const i of buffer) {
      const la = lat[i] / 1e7;
      const lo = lon[i] / 1e7;
      const dwell = Math.min(MAX_DWELL_MS, i + 1 < n ? Math.max(0, t[i + 1] - t[i]) : HOUR_MS);
      let found = null;
      for (const cluster of clusters) {
        if (haversineKm(cluster.lat, cluster.lon, la, lo) < CLUSTER_RADIUS_KM) { found = cluster; break; }
      }
      if (!found) {
        clusters.push({ lat: la, lon: lo, weight: dwell + 1, count: 1 });
      } else {
        found.weight += dwell + 1;
        found.count++;
        found.lat += (la - found.lat) / found.count;
        found.lon += (lo - found.lon) / found.count;
      }
    }
    clusters.sort((a, b) => b.weight - a.weight);
    const main = clusters[0];

    // The fix nearest 04:00 local is where you slept.
    let night = null;
    let bestDistance = Infinity;
    for (const i of buffer) {
      const hour = localParts(t[i], offsetAt(i)).hour;
      const distance = Math.min(Math.abs(hour - 4), Math.abs(hour + 24 - 4), Math.abs(hour - 28));
      if (distance < bestDistance && distance <= 4) {
        bestDistance = distance;
        night = i;
      }
    }

    days.push({
      day: currentDay,
      lat: main.lat,
      lon: main.lon,
      places: clusters.length,
      nightLat: night == null ? null : lat[night] / 1e7,
      nightLon: night == null ? null : lon[night] / 1e7,
      points: buffer.length,
    });
    buffer = [];
  }

  for (let i = 0; i < n; i++) {
    const day = localDayIndex(t[i], offsetAt(i));
    if (day !== currentDay) {
      flushDay();
      currentDay = day;
    }
    buffer.push(i);
  }
  flushDay();

  /* --- roll days up into places, years and nights ------------------ */

  const countryDays = new Map();
  const cityDays = new Map();
  const cityNights = new Map();
  const yearStats = new Map();

  for (const day of days) {
    const place = placeAt(day.lat, day.lon);
    day.country = place.country;
    day.city = place.city;
    const date = dayIndexToDate(day.day);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();

    let month_ = monthly.get(year * 12 + month);
    if (!month_) monthly.set(year * 12 + month, month_ = { key: year * 12 + month, km: 0, points: 0 });
    month_.points += day.points;

    let stats = yearStats.get(year);
    if (!stats) {
      yearStats.set(year, stats = {
        year: year, days: 0, km: 0, nights: new Map(), countries: new Set(),
        cities: new Set(), nightsAway: 0, points: 0,
      });
    }
    stats.days++;
    stats.points += day.points;
    if (day.country) {
      countryDays.set(day.country, (countryDays.get(day.country) || 0) + 1);
      stats.countries.add(day.country);
    }
    if (day.city) {
      const key = day.city + (place.country ? ', ' + place.country : '');
      let entry = cityDays.get(key);
      if (!entry) cityDays.set(key, entry = { name: day.city, country: place.country, days: 0, nights: 0, lat: place.cityLat, lon: place.cityLon });
      entry.days++;
      stats.cities.add(key);
    }

    if (day.nightLat != null) {
      const nightPlace = placeAt(day.nightLat, day.nightLon);
      const key = nightPlace.city
        ? nightPlace.city + (nightPlace.country ? ', ' + nightPlace.country : '')
        : placeKey(day.nightLat, day.nightLon);
      day.nightKey = key;
      day.nightPlace = nightPlace;
      stats.nights.set(key, (stats.nights.get(key) || 0) + 1);
      const entry = cityNights.get(key);
      if (entry) entry.nights++;
      else cityNights.set(key, {
        name: nightPlace.city || 'Unnamed place',
        country: nightPlace.country, nights: 1,
        lat: day.nightLat, lon: day.nightLon,
      });
    }
  }

  // Per-year distance, using whichever distance source we trust.
  const yearKm = new Map();
  if (useTrips) {
    for (const trip of data.trips) {
      const km = trip.km != null && trip.km > 0
        ? trip.km : haversineKm(trip.lat0, trip.lon0, trip.lat1, trip.lon1);
      if (!(km > 0) || km > 20000) continue;
      const year = new Date(trip.t0).getUTCFullYear();
      yearKm.set(year, (yearKm.get(year) || 0) + km);
    }
  } else {
    for (let i = 1; i < n; i++) {
      const dt = t[i] - t[i - 1];
      if (dt <= 0 || dt > 2 * HOUR_MS) continue;
      const km = haversineKm(lat[i - 1] / 1e7, lon[i - 1] / 1e7, lat[i] / 1e7, lon[i] / 1e7);
      if (km > 1500 || km / (dt / HOUR_MS) > 1100) continue;
      const year = localParts(t[i], offsetAt(i)).year;
      yearKm.set(year, (yearKm.get(year) || 0) + km);
    }
  }

  /* --- home, and nights away from it ------------------------------- */

  const years = [...yearStats.values()].sort((a, b) => a.year - b.year);
  for (const stats of years) {
    let home = null;
    let most = 0;
    for (const [key, count] of stats.nights) {
      if (count > most) { most = count; home = key; }
    }
    stats.home = home;
    stats.homeNights = most;
    stats.km = yearKm.get(stats.year) || 0;
  }

  const homeByYear = new Map();
  for (const stats of years) {
    if (!stats.home) continue;
    const sample = days.find((d) => d.nightKey === stats.home && dayIndexToDate(d.day).getUTCFullYear() === stats.year);
    if (sample) homeByYear.set(stats.year, { key: stats.home, lat: sample.nightLat, lon: sample.nightLon, place: sample.nightPlace });
  }

  // "Away" is measured against where you were living at the time, not
  // against a home per calendar year: otherwise moving house in July makes
  // the rest of the year look like one long holiday.
  const nights = days.filter((day) => day.nightLat != null);
  let nightsAway = 0;
  let nightsCounted = 0;
  let windowStart = 0;
  let windowEnd = 0;
  const tally = new Map();
  for (const night of nights) {
    while (windowEnd < nights.length && nights[windowEnd].day <= night.day + HOME_WINDOW_DAYS) {
      tally.set(nights[windowEnd].nightKey, (tally.get(nights[windowEnd].nightKey) || 0) + 1);
      windowEnd++;
    }
    while (nights[windowStart].day < night.day - HOME_WINDOW_DAYS) {
      const key = nights[windowStart].nightKey;
      const count = tally.get(key) - 1;
      if (count > 0) tally.set(key, count);
      else tally.delete(key);
      windowStart++;
    }
    let base = null;
    let most = 0;
    for (const [key, count] of tally) {
      if (count > most) { most = count; base = key; }
    }
    night.homeKey = base;
    if (base == null) continue;
    // Any night at that place fixes the coordinates to compare against.
    const anchor = nights.find((other) => other.nightKey === base &&
      Math.abs(other.day - night.day) <= HOME_WINDOW_DAYS);
    if (!anchor) continue;
    nightsCounted++;
    night.away = haversineKm(night.nightLat, night.nightLon, anchor.nightLat, anchor.nightLon) > HOME_RADIUS_KM;
    if (night.away) {
      nightsAway++;
      const stats = yearStats.get(dayIndexToDate(night.day).getUTCFullYear());
      if (stats) stats.nightsAway++;
    }
  }

  /* --- headline numbers -------------------------------------------- */

  const months = [...monthly.values()].sort((a, b) => a.key - b.key);
  const sortedCountries = [...countryDays.entries()]
    .map(([name, dayCount]) => ({ name: name, days: dayCount }))
    .sort((a, b) => b.days - a.days);
  const sortedCities = [...cityDays.values()].sort((a, b) => b.days - a.days);
  for (const city of sortedCities) {
    const nights = cityNights.get(city.name + (city.country ? ', ' + city.country : ''));
    if (nights) city.nights = nights.nights;
  }

  const longestArc = data.arcs.length
    ? data.arcs.reduce((best, arc) => (arc.km > best.km ? arc : best))
    : null;

  let furthest = null;
  const lastHome = homeByYear.get(years.length ? years[years.length - 1].year : 0);
  if (lastHome) {
    let bestKm = 0;
    for (const day of days) {
      const km = haversineKm(day.lat, day.lon, lastHome.lat, lastHome.lon);
      if (km > bestKm) { bestKm = km; furthest = { km: km, day: day }; }
    }
  }

  const busiestDay = days.length
    ? days.reduce((best, day) => (day.places > best.places ? day : best))
    : null;

  return {
    days: days,
    years: years,
    months: months,
    heat: heat,
    distanceByMode: distanceByMode,
    distanceSource: useTrips ? 'segments' : 'points',
    totalKm: totalKm,
    countries: sortedCountries,
    cities: sortedCities,
    nightCities: [...cityNights.values()].sort((a, b) => b.nights - a.nights),
    homeByYear: homeByYear,
    nightsAway: nightsAway,
    nightsCounted: nightsCounted,
    hasActivityLabels: labelled > n * 0.02,
    hasOffsets: hasOffsets,
    longestArc: longestArc,
    furthest: furthest,
    busiestDay: busiestDay,
    span: { t0: t[0], t1: t[n - 1] },
  };
}
