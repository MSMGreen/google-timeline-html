/* ------------------------------------------------------------------ *
 * Wiring: file in, map and panels out.
 * ------------------------------------------------------------------ */

const app = {
  map: null,
  basemap: null,
  cities: null,
  data: null,
  analysis: null,
  worker: null,
  months: [],
  monthIndex: 0,
  windowMode: 'all',
  playing: 0,
  tiles: null,
};

function $(id) {
  return document.getElementById(id);
}

function show(node, visible) {
  node.hidden = !visible;
}

/* ---------------------------------------------------------- loading */

function parse(file) {
  if (app.worker) {
    app.worker.terminate();
    app.worker = null;
  }

  const status = $('status');
  const bar = $('progress-bar');
  bar.style.width = '0%';
  show($('loader'), true);
  $('error').hidden = true;

  const fail = (message) => {
    show($('loader'), false);
    const error = $('error');
    error.textContent = message;
    error.hidden = false;
  };

  const handle = (message) => {
    if (message.type === 'progress') {
      const fraction = message.total ? message.loaded / message.total : 0;
      bar.style.width = (message.phase === 'sorting' ? 100 : fraction * 96) + '%';
      status.textContent = message.phase === 'sorting'
        ? `Sorting ${formatCount(message.points)} points…`
        : `Reading ${file.name} — ${(message.loaded / 1048576).toFixed(0)} of ` +
          `${(message.total / 1048576).toFixed(0)} MB, ${formatCount(message.points || 0)} points`;
    } else if (message.type === 'error') {
      fail(message.message);
    } else if (message.type === 'done') {
      bar.style.width = '100%';
      status.textContent = 'Drawing…';
      setTimeout(() => finish(message, file), 16);
    }
  };

  let worker = null;
  try {
    const blob = new Blob([PARSER_SOURCE], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    worker = new Worker(url);
    URL.revokeObjectURL(url);
  } catch (err) {
    worker = null;
  }

  if (worker) {
    app.worker = worker;
    worker.onmessage = (event) => handle(event.data);
    worker.onerror = (event) => fail('The parser failed: ' + (event.message || 'unknown error'));
    worker.postMessage({ file: file });
    return;
  }

  // Some browsers refuse to start a worker from a blob on a file:// page.
  // Run the same parser on this thread instead: the page freezes while it
  // reads, but it still works.
  status.textContent = 'Reading (this browser will not run the parser in the background)…';
  setTimeout(() => {
    const scope = {};
    try {
      new Function('self', 'postMessage', PARSER_SOURCE)(scope, handle);
      scope.onmessage({ data: { file: file } });
    } catch (err) {
      fail('Could not read that file: ' + (err && err.message ? err.message : err));
    }
  }, 32);
}

function finish(message, file) {
  const prepared = prepareRenderData(message);
  app.data = prepared;
  app.map.setData(prepared);
  app.map.fitTo(
    prepared.core.minLat, prepared.core.minLon,
    prepared.core.maxLat, prepared.core.maxLon,
  );

  const analysis = analyse(prepared, app.basemap, app.cities);
  app.analysis = analysis;
  app.months = analysis.months;
  app.monthIndex = analysis.months.length - 1;

  buildScrubber();
  applyWindow();
  renderPanels(file);

  show($('loader'), false);
  show($('intro'), false);
  show($('results'), true);
  document.body.classList.add('loaded');
  app.map.resize();
}

/* --------------------------------------------------------- the window */

function monthBounds(key) {
  const year = Math.floor(key / 12);
  const month = key - year * 12;
  return [Date.UTC(year, month, 1), Date.UTC(year, month + 1, 1) - 1];
}

function lowerBound(array, value, n) {
  let low = 0;
  let high = n;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (array[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function applyWindow() {
  if (!app.data) return;
  const months = app.months;
  let t0 = -Infinity;
  let t1 = Infinity;
  let label = 'Everything';
  let strip = null;

  if (months.length && app.windowMode !== 'all') {
    const selected = months[Math.max(0, Math.min(months.length - 1, app.monthIndex))];
    const bounds = monthBounds(selected.key);
    const year = Math.floor(selected.key / 12);
    const monthName = MONTH_NAMES[selected.key - year * 12];
    if (app.windowMode === 'cumulative') {
      t0 = -Infinity;
      t1 = bounds[1];
      label = `Up to ${monthName} ${year}`;
      strip = [months[0].key, selected.key];
    } else if (app.windowMode === 'month') {
      t0 = bounds[0];
      t1 = bounds[1];
      label = `${monthName} ${year}`;
      strip = [selected.key, selected.key];
    } else if (app.windowMode === 'year') {
      t0 = monthBounds(selected.key - 11)[0];
      t1 = bounds[1];
      label = `12 months to ${monthName} ${year}`;
      strip = [selected.key - 11, selected.key];
    }
  }

  const n = app.data.n;
  const i0 = t0 === -Infinity ? 0 : lowerBound(app.data.t, t0, n);
  const i1 = t1 === Infinity ? n : lowerBound(app.data.t, t1, n);
  app.map.setRange({ i0: i0, i1: i1, t0: t0, t1: t1 });
  $('window-label').textContent = label;
  $('window-count').textContent = `${formatCount(i1 - i0)} points`;
  drawMonthStrip($('month-strip'), months, null, strip);
  $('month-slider').disabled = app.windowMode === 'all';
  $('play').disabled = app.windowMode === 'all';
}

function buildScrubber() {
  const slider = $('month-slider');
  slider.min = '0';
  slider.max = String(Math.max(0, app.months.length - 1));
  slider.value = String(app.monthIndex);
}

function togglePlay() {
  if (app.playing) {
    clearInterval(app.playing);
    app.playing = 0;
    $('play').textContent = '▶ Play';
    return;
  }
  if (app.windowMode === 'all') {
    app.windowMode = 'cumulative';
    $('window-mode').value = 'cumulative';
  }
  if (app.monthIndex >= app.months.length - 1) app.monthIndex = 0;
  $('play').textContent = '❚❚ Pause';
  app.playing = setInterval(() => {
    app.monthIndex++;
    if (app.monthIndex >= app.months.length) {
      app.monthIndex = app.months.length - 1;
      togglePlay();
      return;
    }
    $('month-slider').value = String(app.monthIndex);
    applyWindow();
  }, 260);
}

/* -------------------------------------------------------- the panels */

function statTile(label, value, note) {
  const tile = el('div', 'stat');
  tile.appendChild(el('span', 'stat-label', label));
  tile.appendChild(el('span', 'stat-value', value));
  if (note) tile.appendChild(el('span', 'stat-note', note));
  return tile;
}

function renderPanels(file) {
  const analysis = app.analysis;
  const data = app.data;
  const start = new Date(analysis.span.t0);
  const end = new Date(analysis.span.t1);
  const yearsCovered = (analysis.span.t1 - analysis.span.t0) / (365.25 * DAY_MS);

  const stats = $('stats');
  clear(stats);
  stats.appendChild(statTile('Recorded', `${formatCount(data.n)} points`,
    `${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`));
  stats.appendChild(statTile('Covering', `${yearsCovered.toFixed(1)} years`,
    `${formatCount(analysis.days.length)} days with data`));
  stats.appendChild(statTile('Travelled', formatKm(analysis.totalKm),
    analysis.distanceSource === 'segments' ? 'from Google’s own trip segments' : 'measured between fixes'));
  stats.appendChild(statTile('Countries', formatCount(analysis.countries.length),
    analysis.cities.length ? `${formatCount(analysis.cities.length)} towns and cities` : ''));
  stats.appendChild(statTile('Nights away', formatCount(analysis.nightsAway),
    analysis.nightsCounted ? `of ${formatCount(analysis.nightsCounted)} nights placed` : ''));
  const flights = data.arcs.length;
  stats.appendChild(statTile('Long hops', formatCount(flights),
    analysis.longestArc ? `longest ${formatKm(analysis.longestArc.km)}` : ''));

  /* where you lived */
  const homes = $('homes');
  clear(homes);
  const table = el('table', 'table');
  const head = el('tr');
  for (const heading of ['Year', 'Slept mostly in', 'Nights there', 'Days recorded', 'Distance', 'Nights away', 'Countries']) {
    head.appendChild(el('th', null, heading));
  }
  table.appendChild(el('thead')).appendChild(head);
  const body = el('tbody');
  for (const year of analysis.years) {
    const row = el('tr');
    row.appendChild(el('td', 'num', String(year.year)));
    row.appendChild(el('td', null, year.home || '—'));
    row.appendChild(el('td', 'num', year.homeNights ? formatCount(year.homeNights) : '—'));
    row.appendChild(el('td', 'num', formatCount(year.days)));
    row.appendChild(el('td', 'num', year.km ? formatKm(year.km) : '—'));
    row.appendChild(el('td', 'num', formatCount(year.nightsAway)));
    row.appendChild(el('td', 'num', formatCount(year.countries.size)));
    body.appendChild(row);
  }
  table.appendChild(body);
  homes.appendChild(table);

  /* distance by mode */
  const modeRows = [];
  for (let i = 0; i < MODES.length; i++) {
    const km = analysis.distanceByMode[i];
    if (!(km > 0.5)) continue;
    modeRows.push({
      label: MODES[i].label,
      value: km,
      display: formatKm(km),
      muted: MODES[i].key === 'unknown' || MODES[i].key === 'still',
      title: `${(km / analysis.totalKm * 100).toFixed(1)}% of all distance`,
    });
  }
  modeRows.sort((a, b) => b.value - a.value);
  barList($('modes'), modeRows, { empty: 'No distance could be worked out from this export.' });
  $('modes-note').textContent = analysis.distanceSource === 'segments'
    ? 'Distances come from the trip segments in the export, which carry Google’s own mode labels.'
    : (analysis.hasActivityLabels
      ? 'Distances measured between consecutive fixes; modes come from the activity labels on each fix.'
      : 'This export has no activity labels, so modes are inferred from speed.');

  /* when you move */
  heatmapGrid($('heatmap'), analysis.heat);
  $('heat-note').textContent = analysis.hasOffsets
    ? 'Local time, from the UTC offsets stored in the export.'
    : 'Local time, estimated from longitude — this export stores timestamps in UTC only.';

  /* countries and cities */
  barList($('countries'), analysis.countries.slice(0, 18).map((c) => ({
    label: c.name,
    value: c.days,
    display: c.days === 1 ? '1 day' : `${formatCount(c.days)} days`,
  })), { empty: 'No days could be placed in a country.' });
  $('countries-note').textContent = analysis.countries.length > 18
    ? `Top 18 of ${analysis.countries.length} countries.`
    : `${analysis.countries.length} countries in total.`;

  barList($('cities'), analysis.cities.slice(0, 18).map((c) => ({
    label: c.country ? `${c.name}, ${c.country}` : c.name,
    value: c.days,
    display: c.days === 1 ? '1 day' : `${formatCount(c.days)} days`,
    title: c.nights ? `${formatCount(c.nights)} nights slept here` : undefined,
  })), { empty: 'No days could be placed in a city.' });
  $('cities-note').textContent = analysis.cities.length > 18
    ? `Top 18 of ${analysis.cities.length} places, nearest town or city to where the day was spent.`
    : 'Nearest town or city to where each day was spent.';

  /* nights away */
  barList($('away'), analysis.years.map((year) => ({
    label: String(year.year),
    value: year.nightsAway,
    display: formatCount(year.nightsAway),
    title: year.home ? `Home that year: ${year.home}` : undefined,
  })), { empty: 'No nights could be placed.' });
  $('away-note').textContent =
    `A night counts as away when you slept more than ${HOME_RADIUS_KM} km from that year’s home.`;

  /* notable */
  const notable = $('notable');
  clear(notable);
  const items = [];
  if (analysis.longestArc) {
    const arc = analysis.longestArc;
    const from = nearestCity(app.cities, arc.from[0], arc.from[1], 120);
    const to = nearestCity(app.cities, arc.to[0], arc.to[1], 120);
    items.push(['Longest hop',
      `${formatKm(arc.km)} — ${from ? from.name : 'somewhere'} to ${to ? to.name : 'somewhere'}`,
      new Date(arc.t).toISOString().slice(0, 10)]);
  }
  if (analysis.furthest) {
    const place = nearestCity(app.cities, analysis.furthest.day.lat, analysis.furthest.day.lon, 120);
    items.push(['Furthest from home',
      `${formatKm(analysis.furthest.km)} — ${place ? place.name : 'an unnamed place'}`,
      dayIndexToDate(analysis.furthest.day.day).toISOString().slice(0, 10)]);
  }
  if (analysis.busiestDay) {
    items.push(['Most places in a day', `${analysis.busiestDay.places} separate places`,
      dayIndexToDate(analysis.busiestDay.day).toISOString().slice(0, 10)]);
  }
  if (data.visits && data.visits.length) {
    items.push(['Visits in the export', formatCount(data.visits.length),
      `${formatCount(data.trips.length)} trip segments`]);
  }
  for (const [label, value, note] of items) notable.appendChild(statTile(label, value, note));

  /* legend */
  $('legend-from').textContent = start.getUTCFullYear();
  $('legend-to').textContent = end.getUTCFullYear();
  $('file-name').textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB`;
}

/* ------------------------------------------------------------- start */

function init() {
  app.basemap = buildBasemap(BASEMAP_DATA);
  app.cities = buildCityIndex(CITY_DATA);
  app.map = createMap($('map'), app.basemap);
  app.map.resize();
  app.map.fitTo(-55, -170, 72, 175, 0);

  const readout = $('readout');
  app.map.onHover((latLon) => {
    const city = nearestCity(app.cities, latLon[0], latLon[1], 60);
    readout.textContent =
      `${Math.abs(latLon[0]).toFixed(4)}°${latLon[0] >= 0 ? 'N' : 'S'} ` +
      `${Math.abs(latLon[1]).toFixed(4)}°${latLon[1] >= 0 ? 'E' : 'W'}` +
      (city ? `  ·  near ${city.name}` : '');
  });

  window.addEventListener('resize', () => app.map.resize());

  const input = $('file');
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) parse(input.files[0]);
  });

  const dropTarget = document.body;
  ['dragenter', 'dragover'].forEach((type) => {
    dropTarget.addEventListener(type, (event) => {
      event.preventDefault();
      document.body.classList.add('dropping');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    dropTarget.addEventListener(type, (event) => {
      event.preventDefault();
      if (type === 'drop') {
        const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
        if (file) parse(file);
      }
      document.body.classList.remove('dropping');
    });
  });

  $('month-slider').addEventListener('input', (event) => {
    app.monthIndex = +event.target.value;
    applyWindow();
  });
  $('window-mode').addEventListener('change', (event) => {
    app.windowMode = event.target.value;
    applyWindow();
  });
  $('play').addEventListener('click', togglePlay);

  for (const [id, option] of [['toggle-points', 'showPoints'], ['toggle-arcs', 'showArcs'], ['toggle-trails', 'showTrails']]) {
    $(id).addEventListener('change', (event) => app.map.setOption(option, event.target.checked));
  }
  $('toggle-streets').addEventListener('change', (event) => {
    if (event.target.checked) {
      if (!app.tiles) app.tiles = createTileLayer(() => app.map.invalidate(false));
      app.map.setTiles(app.tiles);
    } else {
      app.map.setTiles(null);
    }
  });
  $('exposure').addEventListener('input', (event) => {
    app.map.setOption('exposure', Math.pow(10, +event.target.value));
  });

  $('zoom-in').addEventListener('click', () => app.map.zoomBy(1.8));
  $('zoom-out').addEventListener('click', () => app.map.zoomBy(1 / 1.8));
  $('zoom-fit').addEventListener('click', () => {
    if (app.data) {
      app.map.fitTo(app.data.bounds.minLat, app.data.bounds.minLon,
        app.data.bounds.maxLat, app.data.bounds.maxLon);
    } else {
      app.map.fitTo(-55, -170, 72, 175, 0);
    }
  });
  $('save-png').addEventListener('click', () => {
    $('map').toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'timeline.png';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
