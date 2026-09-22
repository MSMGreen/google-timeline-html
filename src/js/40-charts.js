/* ------------------------------------------------------------------ *
 * Small chart builders. Everything is plain DOM rather than canvas, so
 * the numbers stay selectable, hoverable and readable by a screen
 * reader. Magnitude is always one hue -- category is carried by the
 * label next to the mark, never by colour alone.
 * ------------------------------------------------------------------ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Horizontal bars: one hue, value at the end of each bar, rows labelled
 * on the left. Used for distance by mode, days per country, and so on.
 */
function barList(container, rows, options) {
  const opts = options || {};
  clear(container);
  if (!rows.length) {
    container.appendChild(el('p', 'empty', opts.empty || 'Nothing to show.'));
    return;
  }
  const max = Math.max.apply(null, rows.map((r) => r.value));
  const list = el('div', 'bars');
  for (const row of rows) {
    const item = el('div', 'bar-row');
    item.appendChild(el('span', 'bar-label', row.label));
    const track = el('span', 'bar-track');
    const fill = el('span', 'bar-fill');
    fill.style.width = (max > 0 ? Math.max(1.5, (row.value / max) * 100) : 0) + '%';
    if (row.muted) fill.classList.add('muted');
    track.appendChild(fill);
    item.appendChild(track);
    item.appendChild(el('span', 'bar-value', row.display != null ? row.display : formatCount(row.value)));
    item.title = row.title ? `${row.label} — ${row.title}` : row.label;
    list.appendChild(item);
  }
  container.appendChild(list);
}

/**
 * Hour-by-weekday heatmap. Sequential single hue, dark to bright,
 * because the value is a magnitude.
 */
function heatmapGrid(container, values, options) {
  const opts = options || {};
  clear(container);
  let max = 0;
  for (let i = 0; i < values.length; i++) max = Math.max(max, values[i]);
  const grid = el('div', 'heatmap');

  grid.appendChild(el('span', 'heat-corner', ''));
  for (let hour = 0; hour < 24; hour++) {
    const label = el('span', 'heat-hour', hour % 6 === 0 ? String(hour).padStart(2, '0') : '');
    grid.appendChild(label);
  }
  for (let day = 0; day < 7; day++) {
    grid.appendChild(el('span', 'heat-day', WEEKDAY_NAMES[day]));
    for (let hour = 0; hour < 24; hour++) {
      const value = values[day * 24 + hour];
      const cell = el('span', 'heat-cell');
      // Square root keeps the quiet hours visible next to a commute spike.
      const intensity = max > 0 ? Math.sqrt(value / max) : 0;
      cell.style.background = intensity < 0.02
        ? 'rgba(255,255,255,0.035)'
        : `rgba(${Math.round(30 + 225 * intensity)},${Math.round(190 + 25 * intensity)},${Math.round(200 - 60 * intensity)},${0.18 + 0.82 * intensity})`;
      cell.title = `${WEEKDAY_NAMES[day]} ${String(hour).padStart(2, '0')}:00 — ${opts.format ? opts.format(value) : formatKm(value)}`;
      grid.appendChild(cell);
    }
  }
  container.appendChild(grid);
  if (max > 0) {
    const scale = el('div', 'heat-scale');
    scale.appendChild(el('span', null, 'less'));
    const ramp = el('span', 'heat-ramp');
    scale.appendChild(ramp);
    scale.appendChild(el('span', null, `more (peak ${opts.format ? opts.format(max) : formatKm(max)})`));
    container.appendChild(scale);
  }
}

/** The month histogram behind the scrubber. */
function drawMonthStrip(canvas, months, activeKey, range) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  if (!months.length) return;
  const max = Math.max.apply(null, months.map((m) => m.points)) || 1;
  const first = months[0].key;
  const last = months[months.length - 1].key;
  const span = Math.max(1, last - first + 1);
  const slot = width / span;
  for (const month of months) {
    const x = (month.key - first) * slot;
    const h = Math.max(1, (Math.sqrt(month.points / max)) * (height - 2));
    const inRange = !range || (month.key >= range[0] && month.key <= range[1]);
    ctx.fillStyle = inRange ? rampCss((month.key - first) / span) : 'rgba(150,170,205,0.16)';
    ctx.globalAlpha = inRange ? 0.85 : 1;
    ctx.fillRect(x, height - h, Math.max(1, slot - dpr), h);
  }
  ctx.globalAlpha = 1;
}
