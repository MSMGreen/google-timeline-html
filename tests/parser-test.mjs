/* Runs the worker's parser under node against the synthetic exports from
 * tools/make_sample.py, once per Takeout format.
 *
 *   python3 tools/make_sample.py --years 3 --out sample
 *   node tests/parser-test.mjs sample
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sampleDir = path.resolve(process.argv[2] || path.join(root, 'sample'));

const FILES = [
  ['Records.json', 'records'],
  ['Semantic-Location-History.json', 'semantic location history'],
  ['Timeline.json', 'timeline (android)'],
  ['location-history.json', 'location-history (ios)'],
];

const workerSource = readFileSync(path.join(root, 'src/js/parser.worker.js'), 'utf8');

function runWorker(bytes, chunkBytes) {
  const source = chunkBytes
    ? workerSource.replace(/const CHUNK_BYTES = .*;/, `const CHUNK_BYTES = ${chunkBytes};`)
    : workerSource;
  return new Promise((resolve, reject) => {
    const scope = {};
    const messages = [];
    const postMessage = (msg) => {
      messages.push(msg);
      if (msg.type === 'done') resolve({ result: msg, messages });
      if (msg.type === 'error') reject(new Error(msg.message));
    };
    scope.postMessage = postMessage;
    // eslint-disable-next-line no-new-func
    const factory = new Function('self', 'postMessage', `${source}\nreturn self;`);
    factory(scope, postMessage);
    scope.onmessage({ data: { file: new Blob([bytes]) } });
  });
}

let failures = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ' -- ' + detail : ''}`);
  }
}

for (const [filename, label] of FILES) {
  const full = path.join(sampleDir, filename);
  console.log(`\n${label} (${filename})`);
  let bytes;
  try {
    bytes = readFileSync(full);
  } catch {
    console.log(`  SKIP missing ${full}`);
    continue;
  }
  const started = Date.now();
  const { result } = await runWorker(bytes);
  const elapsed = Date.now() - started;
  const years = new Set();
  for (let i = 0; i < result.n; i += Math.max(1, Math.floor(result.n / 5000))) {
    years.add(new Date(result.t[i]).getUTCFullYear());
  }
  let ordered = true;
  let valid = true;
  let offItinerary = 0;
  for (let i = 1; i < result.n; i++) {
    if (result.t[i] < result.t[i - 1]) { ordered = false; break; }
  }
  for (let i = 0; i < result.n; i++) {
    const lat = result.lat[i] / 1e7;
    const lon = result.lon[i] / 1e7;
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) { valid = false; break; }
    // The itinerary never leaves the northern hemisphere between the US and Japan.
    if (!(lat > 20 && lat < 82 && lon > -80 && lon < 145)) offItinerary++;
  }
  console.log(`  ${result.n.toLocaleString()} points, ${result.trips.length} trips, ` +
    `${result.visits.length} visits, ${result.duplicates} dupes, ${elapsed} ms, ` +
    `${(bytes.length / 1048576 / (elapsed / 1000)).toFixed(1)} MB/s`);
  check('found points', result.n > 1000, `${result.n}`);
  check('time-ordered', ordered);
  check('valid coordinates', valid);
  check('matches the simulated itinerary', offItinerary === 0, `${offItinerary} stray points`);
  check('covers three years', years.size >= 3, [...years].join(','));
  const modes = new Set(Array.from({ length: result.n }, (_, i) => result.mode[i]));
  check('has travel modes', filename === 'location-history.json' || modes.size > 1, [...modes].join(','));
  if (filename !== 'Records.json') {
    check('has visits or trips', result.visits.length + result.trips.length > 100,
      `${result.visits.length}/${result.trips.length}`);
  }
}

// Re-parse one export with a tiny read size, to prove the scanner survives
// chunk boundaries landing anywhere -- mid-string, mid-number, mid-element.
console.log('\nchunk boundary stress (Timeline.json, 997-byte reads)');
try {
  const bytes = readFileSync(path.join(sampleDir, 'Timeline.json'));
  const whole = (await runWorker(bytes)).result;
  const split = (await runWorker(bytes, 997)).result;
  check('same point count', whole.n === split.n, `${whole.n} vs ${split.n}`);
  let identical = whole.n === split.n;
  for (let i = 0; identical && i < whole.n; i++) {
    identical = whole.t[i] === split.t[i] && whole.lat[i] === split.lat[i] && whole.lon[i] === split.lon[i];
  }
  check('identical points', identical);
  check('same trips and visits',
    whole.trips.length === split.trips.length && whole.visits.length === split.visits.length);
} catch (err) {
  if (err.code === 'ENOENT') console.log('  SKIP missing Timeline.json');
  else throw err;
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
