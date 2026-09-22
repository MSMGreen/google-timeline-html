/* Loads the built page in a real browser, feeds it a sample export and
 * checks that the map and the panels come out with sensible numbers.
 *
 *   python3 tools/make_sample.py --out sample && python3 build.py
 *   node tests/e2e.mjs [sampleDir] [--headed]
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

/* playwright is often installed globally rather than in the project. */
function loadPlaywright() {
  const candidates = [
    'playwright',
    process.env.PLAYWRIGHT_MODULE,
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'playwright'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (err) {
      if (err.code !== 'MODULE_NOT_FOUND') throw err;
    }
  }
  throw new Error('playwright not found -- npm i -D playwright, or set PLAYWRIGHT_MODULE');
}

const { chromium } = loadPlaywright();

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sampleDir = path.resolve(process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2] : path.join(root, 'sample'));
const outDir = path.join(root, 'test-output');
mkdirSync(outDir, { recursive: true });

const CASES = [
  'Records.json',
  'Semantic-Location-History.json',
  'Timeline.json',
  'location-history.json',
];

const collected = [];
let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? ' -- ' + detail : ''}`); }
}

const browser = await chromium.launch();

for (const file of CASES) {
  console.log(`\n${file}`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(String(error)));
  // The page must work with no network at all.
  await page.route(/^https?:\/\//, (route) => route.abort());

  await page.goto('file://' + path.join(root, 'index.html'));
  await page.setInputFiles('#file', path.join(sampleDir, file));
  await page.waitForSelector('#results:not([hidden])', { timeout: 60000 });
  await page.waitForTimeout(1500);

  await page.addScriptTag({ content: `
    function countLit() {
      const canvas = document.getElementById('map');
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] + data[i + 1] + data[i + 2] > 260) lit++;
      }
      return lit;
    }` });

  // Turning the point layer off must visibly empty the map: that is the
  // difference between "the basemap drew" and "the data drew".
  const withPoints = await page.evaluate(() => countLit());
  await page.uncheck('#toggle-points');
  await page.uncheck('#toggle-trails');
  await page.uncheck('#toggle-arcs');
  await page.waitForTimeout(700);
  const withoutPoints = await page.evaluate(() => countLit());
  await page.check('#toggle-points');
  await page.check('#toggle-trails');
  await page.check('#toggle-arcs');
  await page.waitForTimeout(700);

  const summary = await page.evaluate(() => ({
    stats: [...document.querySelectorAll('#stats .stat')].map((s) => ({
      label: s.querySelector('.stat-label').textContent,
      value: s.querySelector('.stat-value').textContent,
      note: s.querySelector('.stat-note') ? s.querySelector('.stat-note').textContent : '',
    })),
    years: [...document.querySelectorAll('#homes tbody tr')].map((r) =>
      [...r.querySelectorAll('td')].map((c) => c.textContent)),
    modes: [...document.querySelectorAll('#modes .bar-row')].map((r) => r.textContent),
    countries: [...document.querySelectorAll('#countries .bar-row .bar-label')].map((r) => r.textContent),
    cities: [...document.querySelectorAll('#cities .bar-row .bar-label')].map((r) => r.textContent),
    heatCells: document.querySelectorAll('#heatmap .heat-cell').length,
    litPixels: countLit(),
  }));

  console.log('  ' + summary.stats.map((s) => `${s.label}: ${s.value}`).join(' | '));
  console.log('  years: ' + summary.years.map((y) => `${y[0]} ${y[1]}`).join(' | '));
  console.log('  modes: ' + summary.modes.join(' · '));
  console.log('  top countries: ' + summary.countries.slice(0, 4).join(', '));
  console.log('  top cities: ' + summary.cities.slice(0, 5).join(', '));

  check('no console errors', problems.length === 0, problems.slice(0, 3).join(' / '));
  check('the data is what lights the map', withPoints > withoutPoints * 2,
    `${withPoints} lit with points, ${withoutPoints} without`);
  check('layers can be turned off and back on', summary.litPixels >= withPoints * 0.9,
    `${summary.litPixels} vs ${withPoints}`);
  check('three years listed', summary.years.length >= 3, `${summary.years.length}`);
  check('home is Bristol then London',
    summary.years.some((y) => /Bristol/.test(y[1])) && summary.years.some((y) => /London/.test(y[1])),
    summary.years.map((y) => y[1]).join(' / '));
  check('United Kingdom is the top country', /United Kingdom/.test(summary.countries[0] || ''),
    summary.countries[0]);
  check('holiday destinations show up',
    ['Barcelona', 'Edinburgh', 'New York', 'Lisbon', 'Tokyo', 'Reykjav'].filter(
      (city) => summary.cities.some((c) => c.includes(city))).length >= 2,
    summary.cities.slice(0, 12).join(', '));
  check('distance by mode is populated', summary.modes.length >= 3, `${summary.modes.length} modes`);
  check('heatmap is complete', summary.heatCells === 168, `${summary.heatCells} cells`);

  const number = (label) => {
    const stat = summary.stats.find((s) => s.label.toLowerCase() === label);
    return stat ? Number(stat.value.replace(/[^0-9.]/g, '')) : NaN;
  };
  collected.push({
    file: file,
    km: number('travelled'),
    countries: number('countries'),
    away: number('nights away'),
    hops: number('long hops'),
    homes: summary.years.map((y) => y[1]).join(' / '),
  });

  await page.screenshot({ path: path.join(outDir, file.replace(/\.json$/, '') + '.png'), fullPage: true });
  await page.locator('.map-wrap').screenshot({ path: path.join(outDir, file.replace(/\.json$/, '') + '-map.png') });
  await context.close();
}

/* Some browsers refuse to start a worker from a blob on a file:// page.
 * The page must still parse, on the main thread. */
console.log('\nfallback when workers are unavailable');
{
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.route(/^https?:\/\//, (route) => route.abort());
  await page.addInitScript(() => { window.Worker = function () { throw new Error('blocked'); }; });
  await page.goto('file://' + path.join(root, 'index.html'));
  await page.setInputFiles('#file', path.join(sampleDir, 'Timeline.json'));
  await page.waitForSelector('#results:not([hidden])', { timeout: 120000 });
  const points = await page.evaluate(() => document.querySelector('#stats .stat-value').textContent);
  check('parses on the main thread instead', /[0-9],[0-9]{3}/.test(points), points);
  await context.close();
}

await browser.close();

/* The four files describe the same three years. However differently they
 * are shaped, the numbers underneath should agree. */
console.log('\nagreement across the four export formats');
if (collected.length > 1) {
  const spread = (key) => {
    const values = collected.map((c) => c[key]).filter((v) => isFinite(v));
    const min = Math.min.apply(null, values);
    const max = Math.max.apply(null, values);
    return { min: min, max: max, ratio: min > 0 ? max / min : Infinity };
  };
  for (const [key, tolerance] of [['km', 1.02], ['countries', 1.2], ['away', 1.35], ['hops', 1.35]]) {
    const { min, max, ratio } = spread(key);
    check(`${key} agrees across formats`, ratio <= tolerance, `${min} … ${max}`);
  }
  check('same home in every format',
    new Set(collected.map((c) => c.homes)).size === 1,
    collected.map((c) => `${c.file}: ${c.homes}`).join(' | '));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
