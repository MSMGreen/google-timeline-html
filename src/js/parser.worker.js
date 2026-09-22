/* ------------------------------------------------------------------ *
 * Takeout parser. Runs in a worker so a 90 MB+ export never blocks the
 * page, and reads the file in slices so we never hold the whole thing
 * in memory as one parsed object graph.
 *
 * Understands every Timeline export Google has shipped:
 *   Records.json                 { "locations": [...] }
 *   Semantic Location History    { "timelineObjects": [...] }
 *   Timeline.json (Android)      { "semanticSegments": [...], "rawSignals": [...] }
 *   location-history.json (iOS)  [ { "startTime": ..., "visit": {...} }, ... ]
 * ------------------------------------------------------------------ */

const CHUNK_BYTES = 4 << 20;
const ROOT_ARRAYS = new Set([
  'locations', 'timelineObjects', 'semanticSegments', 'rawSignals', 'signals',
]);

const MIN_TIME = Date.UTC(2005, 0, 1);
const MAX_TIME = Date.now() + 366 * 86400000;

/* -------------------------------------------------------------- growable */

function Column(Type, capacity) {
  this.data = new Type(capacity);
  this.length = 0;
}

Column.prototype.push = function (value) {
  if (this.length === this.data.length) {
    const bigger = new this.data.constructor(this.data.length * 2);
    bigger.set(this.data);
    this.data = bigger;
  }
  this.data[this.length++] = value;
};

Column.prototype.trimmed = function () {
  return this.data.slice(0, this.length);
};

/* ----------------------------------------------------------- value parsing */

function fixE7(value) {
  // Some old exports store negative E7 coordinates as unsigned 32-bit ints.
  return value > 1800000000 ? value - 4294967296 : value;
}

function parseCoordString(str) {
  let s = str;
  if (s.charCodeAt(0) === 103 && s.lastIndexOf('geo:', 0) === 0) s = s.slice(4);
  const comma = s.indexOf(',');
  if (comma < 0) return null;
  const lat = parseFloat(s);
  const lng = parseFloat(s.slice(comma + 1));
  if (!isFinite(lat) || !isFinite(lng)) return null;
  return [lat, lng];
}

/** Pull a [lat, lng] pair out of any of the shapes Google uses. */
function coordOf(value) {
  if (value == null) return null;
  if (typeof value === 'string') return parseCoordString(value);
  if (typeof value !== 'object') return null;
  if (value.latitudeE7 != null && value.longitudeE7 != null) {
    return [fixE7(value.latitudeE7) / 1e7, fixE7(value.longitudeE7) / 1e7];
  }
  if (value.latE7 != null && value.lngE7 != null) {
    return [fixE7(value.latE7) / 1e7, fixE7(value.lngE7) / 1e7];
  }
  if (value.latitude != null && value.longitude != null) {
    return [+value.latitude, +value.longitude];
  }
  if (value.latLng != null) return coordOf(value.latLng);
  if (value.LatLng != null) return coordOf(value.LatLng);
  if (value.placeLocation != null) return coordOf(value.placeLocation);
  if (value.location != null) return coordOf(value.location);
  if (value.point != null) return coordOf(value.point);
  if (value.lat != null) {
    const lng = value.lng != null ? value.lng : (value.lon != null ? value.lon : value.long);
    if (lng != null) return [+value.lat, +lng];
  }
  return null;
}

/* Timestamps. The newer exports carry a UTC offset, which is the only
 * trustworthy source of local time; we keep it per point. */
let lastOffsetMinutes = 0;

function parseTimeString(s) {
  const n = s.length;
  if (n < 19) {
    const asNumber = +s;
    if (isFinite(asNumber) && asNumber > 1e11) {
      lastOffsetMinutes = 0;
      return asNumber;
    }
    return NaN;
  }
  const c = (i) => s.charCodeAt(i) - 48;
  const year = c(0) * 1000 + c(1) * 100 + c(2) * 10 + c(3);
  const month = c(5) * 10 + c(6);
  const day = c(8) * 10 + c(9);
  const hour = c(11) * 10 + c(12);
  const minute = c(14) * 10 + c(15);
  const second = c(17) * 10 + c(18);
  if (!(year > 1970 && month >= 1 && month <= 12 && day >= 1 && day <= 31)) {
    const fallback = Date.parse(s);
    lastOffsetMinutes = 0;
    return fallback;
  }
  let ms = 0;
  let i = 19;
  if (s.charCodeAt(19) === 46) { // '.'
    i = 20;
    let scale = 100;
    while (i < n && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) {
      if (scale >= 1) ms += (s.charCodeAt(i) - 48) * scale;
      scale /= 10;
      i++;
    }
  }
  let offset = 0;
  const sign = s.charCodeAt(i);
  if (sign === 43 || sign === 45) { // '+' or '-'
    offset = (c(i + 1) * 10 + c(i + 2)) * 60 + (c(i + 4) * 10 + c(i + 5));
    if (sign === 45) offset = -offset;
  }
  lastOffsetMinutes = offset;
  return Date.UTC(year, month - 1, day, hour, minute, second, ms) - offset * 60000;
}

/** Returns epoch ms, and leaves the UTC offset in lastOffsetMinutes. */
function parseTime(value) {
  lastOffsetMinutes = 0;
  if (value == null) return NaN;
  if (typeof value === 'number') return value > 1e11 ? value : value * 1000;
  if (typeof value === 'string') return parseTimeString(value);
  if (typeof value === 'object') {
    if (value.timestamp != null) return parseTime(value.timestamp);
    if (value.timestampMs != null) return parseTime(value.timestampMs);
    if (value.startTimestamp != null) return parseTime(value.startTimestamp);
    if (value.startTime != null) return parseTime(value.startTime);
  }
  return NaN;
}

function modeCode(type) {
  if (!type || typeof type !== 'string') return 0;
  switch (type.toUpperCase().replace(/[\s-]+/g, '_')) {
    case 'WALKING': case 'ON_FOOT': case 'WALKING_NORDIC': case 'HIKING': return 1;
    case 'RUNNING': case 'JOGGING': return 2;
    case 'CYCLING': case 'ON_BICYCLE': case 'IN_BICYCLE': return 3;
    case 'IN_PASSENGER_VEHICLE': case 'IN_VEHICLE': case 'DRIVING': case 'IN_CAR':
    case 'IN_TAXI': case 'IN_RIDESHARE': return 4;
    case 'IN_BUS': return 5;
    case 'IN_TRAIN': case 'RAIL': case 'IN_VEHICLE_TRAIN': return 6;
    case 'IN_SUBWAY': case 'IN_TRAM': case 'IN_LIGHT_RAIL': case 'IN_FUNICULAR':
    case 'IN_CABLECAR': case 'IN_GONDOLA_LIFT': return 7;
    case 'FLYING': case 'IN_FLIGHT': case 'IN_AIRPLANE': return 8;
    case 'IN_FERRY': case 'BOATING': case 'SAILING': case 'IN_BOAT': case 'KAYAKING': return 9;
    case 'MOTORCYCLING': case 'ON_MOTORCYCLE': return 10;
    case 'STILL': case 'TILTING': return 11;
    default: return 0;
  }
}

function topActivityType(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value.topCandidate) return topActivityType(value.topCandidate);
  if (value.type) return value.type;
  if (value.activityType) return value.activityType;
  if (Array.isArray(value)) {
    // Records.json: [{ activity: [{ type, confidence }], timestamp }]
    let best = null;
    let bestConfidence = -1;
    for (const entry of value) {
      const inner = entry && entry.activity;
      if (Array.isArray(inner)) {
        for (const candidate of inner) {
          const confidence = candidate.confidence == null ? 0 : +candidate.confidence;
          if (confidence > bestConfidence) {
            bestConfidence = confidence;
            best = candidate.type;
          }
        }
      } else if (entry && entry.type) {
        const confidence = entry.confidence == null ? 0 : +entry.confidence;
        if (confidence > bestConfidence) {
          bestConfidence = confidence;
          best = entry.type;
        }
      }
    }
    return best;
  }
  return null;
}

/* ---------------------------------------------------------- the collector */

const MAX_ACCURACY_M = 5000;
const VISIT_SAMPLE_MS = 3 * 3600000;
const VISIT_SAMPLE_LIMIT = 120;

const point = {
  t: new Column(Float64Array, 1 << 16),
  lat: new Column(Int32Array, 1 << 16),
  lon: new Column(Int32Array, 1 << 16),
  mode: new Column(Uint8Array, 1 << 16),
  tz: new Column(Int16Array, 1 << 16),
};
const trips = [];
const visits = [];
const counts = { records: 0, segments: 0, visits: 0, activities: 0, rawSignals: 0, skipped: 0 };

function addPoint(t, lat, lng, mode, offsetMinutes) {
  if (!(t >= MIN_TIME && t <= MAX_TIME)) { counts.skipped++; return; }
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) { counts.skipped++; return; }
  if (lat === 0 && lng === 0) { counts.skipped++; return; }
  point.t.push(t);
  point.lat.push(Math.round(lat * 1e7));
  point.lon.push(Math.round(lng * 1e7));
  point.mode.push(mode);
  point.tz.push(offsetMinutes);
}

function addVisitSamples(t0, t1, lat, lng, offsetMinutes) {
  addPoint(t0, lat, lng, 11, offsetMinutes);
  if (!(t1 > t0)) return;
  const step = Math.max(VISIT_SAMPLE_MS, (t1 - t0) / VISIT_SAMPLE_LIMIT);
  for (let t = t0 + step; t < t1; t += step) addPoint(t, lat, lng, 11, offsetMinutes);
  addPoint(t1, lat, lng, 11, offsetMinutes);
}

function addTrip(t0, t1, from, to, distanceMeters, mode) {
  trips.push({
    t0: t0, t1: t1,
    lat0: from[0], lon0: from[1], lat1: to[0], lon1: to[1],
    km: distanceMeters != null && isFinite(distanceMeters) ? +distanceMeters / 1000 : null,
    mode: mode,
  });
  counts.activities++;
}

function addVisit(t0, t1, lat, lng, name, semanticType, offsetMinutes) {
  visits.push({
    t0: t0, t1: t1, lat: lat, lon: lng,
    name: name || null,
    semantic: semanticType || null,
    tz: offsetMinutes,
  });
  counts.visits++;
}

/* --------------------------------------------------------------- handlers */

function handleLocationRecord(o) {
  const coord = coordOf(o);
  if (!coord) { counts.skipped++; return; }
  const accuracy = o.accuracy != null ? +o.accuracy : (o.accuracyMeters != null ? +o.accuracyMeters : null);
  if (accuracy != null && accuracy > MAX_ACCURACY_M) { counts.skipped++; return; }
  const t = parseTime(o.timestamp != null ? o.timestamp : o.timestampMs);
  const offset = lastOffsetMinutes;
  addPoint(t, coord[0], coord[1], modeCode(topActivityType(o.activity)), offset);
  counts.records++;
}

function handleRawSignal(o) {
  const position = o.position || o;
  const coord = coordOf(position);
  if (!coord) { counts.skipped++; return; }
  const accuracy = position.accuracyMeters != null ? +position.accuracyMeters : null;
  if (accuracy != null && accuracy > MAX_ACCURACY_M) { counts.skipped++; return; }
  const t = parseTime(position.timestamp);
  const offset = lastOffsetMinutes;
  addPoint(t, coord[0], coord[1], 0, offset);
  counts.rawSignals++;
}

function handleTimelineObject(o) {
  if (o.placeVisit) {
    const visit = o.placeVisit;
    const coord = coordOf(visit.location || visit);
    const t0 = parseTime(visit.duration);
    const offset = lastOffsetMinutes;
    const t1 = parseTime(visit.duration && visit.duration.endTimestamp);
    if (coord && t0 >= MIN_TIME) {
      const location = visit.location || {};
      addVisit(t0, t1 > t0 ? t1 : t0, coord[0], coord[1], location.name || location.address || null, null, offset);
      addVisitSamples(t0, t1 > t0 ? t1 : t0, coord[0], coord[1], offset);
    }
    return;
  }
  if (o.activitySegment) {
    const segment = o.activitySegment;
    const t0 = parseTime(segment.duration);
    const offset = lastOffsetMinutes;
    const t1 = parseTime(segment.duration && segment.duration.endTimestamp);
    const mode = modeCode(segment.activityType || topActivityType(segment.activities));
    const from = coordOf(segment.startLocation);
    const to = coordOf(segment.endLocation);
    const distance = segment.distance != null ? segment.distance : segment.distanceMeters;
    if (from && to && t0 >= MIN_TIME) addTrip(t0, t1 > t0 ? t1 : t0, from, to, distance, mode);
    if (from) addPoint(t0, from[0], from[1], mode, offset);
    if (to && t1 >= MIN_TIME) addPoint(t1, to[0], to[1], mode, offset);

    const raw = segment.simplifiedRawPath && segment.simplifiedRawPath.points;
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i++) {
        const coord = coordOf(raw[i]);
        if (!coord) continue;
        const t = parseTime(raw[i].timestamp != null ? raw[i].timestamp : raw[i].timestampMs);
        addPoint(isFinite(t) ? t : t0, coord[0], coord[1], mode, offset);
      }
    }
    const waypoints = segment.waypointPath && segment.waypointPath.waypoints;
    if (Array.isArray(waypoints) && waypoints.length && t1 > t0) {
      // Waypoints have no timestamps; spread them across the segment.
      for (let i = 0; i < waypoints.length; i++) {
        const coord = coordOf(waypoints[i]);
        if (!coord) continue;
        addPoint(t0 + (t1 - t0) * (i + 1) / (waypoints.length + 1), coord[0], coord[1], mode, offset);
      }
    }
    counts.segments++;
  }
}

function handleSegment(o) {
  const t0 = parseTime(o.startTime != null ? o.startTime : o.startTimestamp);
  const offset = lastOffsetMinutes;
  let t1 = parseTime(o.endTime != null ? o.endTime : o.endTimestamp);
  if (!(t1 > t0)) t1 = t0;

  if (Array.isArray(o.timelinePath)) {
    for (let i = 0; i < o.timelinePath.length; i++) {
      const step = o.timelinePath[i];
      const coord = coordOf(step.point != null ? step.point : step);
      if (!coord) continue;
      let t;
      if (step.time != null) {
        t = parseTime(step.time);
      } else if (step.durationMinutesOffsetFromStartTime != null) {
        t = t0 + (+step.durationMinutesOffsetFromStartTime) * 60000;
      } else {
        t = t0 + (t1 - t0) * (i / Math.max(1, o.timelinePath.length - 1));
      }
      addPoint(t, coord[0], coord[1], 0, offset);
    }
    counts.segments++;
  }

  if (o.visit) {
    const candidate = o.visit.topCandidate || o.visit;
    const coord = coordOf(candidate.placeLocation != null ? candidate.placeLocation : candidate);
    if (coord && t0 >= MIN_TIME) {
      addVisit(t0, t1, coord[0], coord[1], candidate.placeId || null, candidate.semanticType || null, offset);
      addVisitSamples(t0, t1, coord[0], coord[1], offset);
    }
  }

  if (o.activity) {
    const activity = o.activity;
    const from = coordOf(activity.start);
    const to = coordOf(activity.end);
    const mode = modeCode(topActivityType(activity));
    if (from && to && t0 >= MIN_TIME) {
      addTrip(t0, t1, from, to, activity.distanceMeters != null ? +activity.distanceMeters : null, mode);
      addPoint(t0, from[0], from[1], mode, offset);
      addPoint(t1, to[0], to[1], mode, offset);
    }
  }

  if (o.timelineMemory || o.placeAggregates) return; // nothing positional to take
}

/** Route one array element to the right handler, by shape rather than by
 *  which key of the export it came from. */
function handleElement(o) {
  if (!o || typeof o !== 'object') return;
  if (o.placeVisit || o.activitySegment) { handleTimelineObject(o); return; }
  if (o.position || o.activityRecord || o.wifiScan) { handleRawSignal(o); return; }
  if (o.visit || o.timelinePath ||
      (o.activity && (o.activity.start || o.activity.topCandidate))) {
    handleSegment(o);
    return;
  }
  if (o.latitudeE7 != null || o.latitudeE7 === 0 || o.timestampMs != null ||
      (o.timestamp != null && (o.latitude != null || o.latLng != null))) {
    handleLocationRecord(o);
    return;
  }
  // Last resort: anything with a coordinate and a time is a point.
  const coord = coordOf(o);
  if (coord) {
    const t = parseTime(o.timestamp != null ? o.timestamp : o.startTime);
    if (isFinite(t)) addPoint(t, coord[0], coord[1], 0, lastOffsetMinutes);
  }
}

/* ---------------------------------------------------------------- scanner */

/**
 * A character-level JSON scanner. It never builds the whole document: it
 * finds the arrays we recognise and hands back one complete element at a
 * time, so memory stays flat no matter how big the export is.
 */
function Scanner(onElement) {
  this.onElement = onElement;
  this.carry = '';
  this.depth = 0;
  this.inString = false;
  this.escaped = false;
  this.capturing = false;
  this.elementDepth = 0;
  this.elementStart = -1;
  this.key = '';
  this.readingKey = false;
  this.started = false;
  // How much of the next buffer was already scanned as part of the carry.
  this.scanned = 0;
}

Scanner.prototype.feed = function (chunk) {
  const buf = this.carry.length ? this.carry + chunk : chunk;
  const n = buf.length;
  let i = this.scanned;
  this.scanned = 0;

  while (i < n) {
    const code = buf.charCodeAt(i);

    if (this.inString) {
      if (this.escaped) {
        this.escaped = false;
      } else if (code === 92) { // backslash
        this.escaped = true;
      } else if (code === 34) { // quote
        this.inString = false;
        this.readingKey = false;
      } else if (this.readingKey && this.key.length < 64) {
        this.key += buf[i];
      }
      i++;
      continue;
    }

    switch (code) {
      case 34: // opening quote
        this.inString = true;
        if (!this.capturing && this.depth === 1) {
          this.key = '';
          this.readingKey = true;
        }
        break;
      case 123: // {
      case 91: // [
        if (!this.started) {
          this.started = true;
          if (code === 91) {
            // A bare array of segments: every element is ours.
            this.capturing = true;
            this.elementDepth = 1;
          }
        } else if (!this.capturing && code === 91 && this.depth === 1 && ROOT_ARRAYS.has(this.key)) {
          this.capturing = true;
          this.elementDepth = 2;
        } else if (this.capturing && this.elementStart < 0 && this.depth === this.elementDepth) {
          this.elementStart = i;
        }
        this.depth++;
        break;
      case 125: // }
      case 93: // ]
        this.depth--;
        if (this.capturing) {
          if (this.elementStart >= 0 && this.depth === this.elementDepth) {
            const text = buf.slice(this.elementStart, i + 1);
            this.elementStart = -1;
            this.onElement(text);
          } else if (this.depth === this.elementDepth - 1) {
            this.capturing = false;
            this.key = '';
          }
        }
        break;
      default:
        break;
    }
    i++;
  }

  // Keep whatever belongs to a half-read element for the next chunk.
  if (this.capturing && this.elementStart >= 0) {
    this.carry = buf.slice(this.elementStart);
    this.scanned = this.carry.length;
    this.elementStart = 0;
  } else {
    this.carry = '';
  }
};

/* ------------------------------------------------------------------- main */

function sortByTime(n) {
  const t = point.t.data;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  // Uint32Array#sort with a comparator is a stable, in-place index sort.
  order.sort((a, b) => t[a] - t[b]);
  return order;
}

async function parseFile(file) {
  const total = file.size;
  let read = 0;
  let elements = 0;
  const decoder = new TextDecoder('utf-8');
  const scanner = new Scanner((text) => {
    elements++;
    try {
      handleElement(JSON.parse(text));
    } catch (err) {
      counts.skipped++;
    }
  });

  postMessage({ type: 'progress', phase: 'reading', loaded: 0, total: total });

  while (read < total) {
    const end = Math.min(read + CHUNK_BYTES, total);
    const buffer = await file.slice(read, end).arrayBuffer();
    scanner.feed(decoder.decode(buffer, { stream: end < total }));
    read = end;
    postMessage({
      type: 'progress', phase: 'reading', loaded: read, total: total,
      points: point.t.length,
    });
  }

  if (!point.t.length) {
    postMessage({
      type: 'error',
      message: elements
        ? 'That file parsed, but held no location points. Is it a Timeline export?'
        : 'No Timeline data found in that file. Expected Records.json, Timeline.json, ' +
          'location-history.json or a Semantic Location History file.',
    });
    return;
  }

  postMessage({ type: 'progress', phase: 'sorting', loaded: total, total: total, points: point.t.length });

  const n = point.t.length;
  const order = sortByTime(n);
  const t = new Float64Array(n);
  const lat = new Int32Array(n);
  const lon = new Int32Array(n);
  const mode = new Uint8Array(n);
  const tz = new Int16Array(n);
  const srcT = point.t.data;
  const srcLat = point.lat.data;
  const srcLon = point.lon.data;
  const srcMode = point.mode.data;
  const srcTz = point.tz.data;

  let out = 0;
  for (let i = 0; i < n; i++) {
    const j = order[i];
    // The newer exports repeat the same fix in several sections; drop exact
    // duplicates so dwell time is not counted twice.
    if (out > 0 && srcT[j] === t[out - 1] && srcLat[j] === lat[out - 1] && srcLon[j] === lon[out - 1]) {
      continue;
    }
    t[out] = srcT[j];
    lat[out] = srcLat[j];
    lon[out] = srcLon[j];
    mode[out] = srcMode[j];
    tz[out] = srcTz[j];
    out++;
  }

  trips.sort((a, b) => a.t0 - b.t0);
  visits.sort((a, b) => a.t0 - b.t0);

  const result = {
    type: 'done',
    n: out,
    t: t.subarray(0, out).slice(),
    lat: lat.subarray(0, out).slice(),
    lon: lon.subarray(0, out).slice(),
    mode: mode.subarray(0, out).slice(),
    tz: tz.subarray(0, out).slice(),
    trips: trips,
    visits: visits,
    counts: counts,
    duplicates: n - out,
    bytes: total,
  };
  postMessage(result, [result.t.buffer, result.lat.buffer, result.lon.buffer, result.mode.buffer, result.tz.buffer]);
}

self.onmessage = function (event) {
  const file = event.data && event.data.file;
  if (!file) return;
  parseFile(file).catch((err) => {
    postMessage({ type: 'error', message: 'Could not read that file: ' + (err && err.message ? err.message : err) });
  });
};
