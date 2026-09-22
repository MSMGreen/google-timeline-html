/* ------------------------------------------------------------------ *
 * Core helpers: compact integer decoding, projection, geodesy.
 * ------------------------------------------------------------------ */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const DIGIT = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DIGIT[ALPHABET.charCodeAt(i)] = i;

/** Decode the zigzag varint strings produced by tools/build_assets.py. */
function decodeInts(str) {
  const out = [];
  let i = 0;
  const n = str.length;
  while (i < n) {
    let result = 0;
    let shift = 0;
    let digit;
    do {
      digit = DIGIT[str.charCodeAt(i++)];
      result += (digit & 31) * Math.pow(2, shift);
      shift += 5;
    } while (digit & 32);
    out.push(result % 2 ? -(result + 1) / 2 : result / 2);
  }
  return out;
}

const EARTH_RADIUS_KM = 6371.0088;
const DEG = Math.PI / 180;

function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* Web Mercator, in unit space: x and y both run 0..1 over the whole world. */
const MERCATOR_MAX_LAT = 85.05112878;

function lonToX(lon) {
  return (lon + 180) / 360;
}

function latToY(lat) {
  const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const s = Math.sin(clamped * DEG);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

function xToLon(x) {
  return x * 360 - 180;
}

function yToLat(y) {
  return 90 - 360 * Math.atan(Math.exp((y - 0.5) * 2 * Math.PI)) / Math.PI;
}

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

/** Local-time fields for a UTC instant given an offset in minutes. */
function localParts(ms, offsetMinutes) {
  const d = new Date(ms + offsetMinutes * 60000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    weekday: d.getUTCDay(),
    dayIndex: Math.floor((ms + offsetMinutes * 60000) / DAY_MS),
  };
}

/** Whole days since the epoch in local time -- the key for "days spent" sums. */
function localDayIndex(ms, offsetMinutes) {
  return Math.floor((ms + offsetMinutes * 60000) / DAY_MS);
}

function dayIndexToDate(dayIndex) {
  return new Date(dayIndex * DAY_MS);
}

function formatKm(km) {
  if (km >= 100000) return (km / 1000).toFixed(0) + 'k km';
  if (km >= 1000) return km.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' km';
  if (km >= 10) return km.toFixed(0) + ' km';
  if (km >= 1) return km.toFixed(1) + ' km';
  return (km * 1000).toFixed(0) + ' m';
}

function formatCount(n) {
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* Travel modes, in the order the worker emits them. */
const MODES = [
  { key: 'unknown', label: 'Unknown', color: '#6b7a99' },
  { key: 'walk', label: 'On foot', color: '#67e8c3' },
  { key: 'run', label: 'Running', color: '#4fd1c5' },
  { key: 'cycle', label: 'Cycling', color: '#7bd88f' },
  { key: 'car', label: 'Car', color: '#f2b544' },
  { key: 'bus', label: 'Bus', color: '#e8845f' },
  { key: 'train', label: 'Train', color: '#9d8cf5' },
  { key: 'metro', label: 'Metro / tram', color: '#7aa2f7' },
  { key: 'flight', label: 'Flight', color: '#ff7ba9' },
  { key: 'boat', label: 'Boat', color: '#56c8e8' },
  { key: 'motorcycle', label: 'Motorcycle', color: '#d98c5f' },
  { key: 'still', label: 'Stationary', color: '#44506b' },
];
