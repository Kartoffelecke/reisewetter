'use strict';

// ---- CONSTANTS ----

const COLOR_PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab',
];

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Day-of-year each month starts on (non-leap-year basis), converted to the week-bin
// (1-52) it falls into, so the weekly x-axis can show month names as tick labels
// instead of week numbers.
const MONTH_START_DOY = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
const MONTH_TICK_VALUES = MONTH_START_DOY.map((doy) => Math.min(51, Math.floor((doy - 1) / 7)) + 1);

const CHART_SPECS = [
  { id: 'chart-tmax', metric: 'maxTemp', yTitle: '°C' },
  { id: 'chart-tmin', metric: 'minTemp', yTitle: '°C' },
  { id: 'chart-raindays', metric: 'rainDays', yTitle: 'days' },
  { id: 'chart-rainmm', metric: 'rainMm', yTitle: 'mm' },
];

const POWER_API_BASE = 'https://power.larc.nasa.gov/api/temporal/daily/point';

// ---- STATE ----

let markers = [];
let colorIndex = 0;
let rainThresholdMm = 1.0;
const rawCache = new Map(); // "lat,lon" (rounded) -> parsed daily records[]

function nextColor() {
  const c = COLOR_PALETTE[colorIndex % COLOR_PALETTE.length];
  colorIndex++;
  return c;
}

// ---- MAP ----

const map = L.map('map').setView([20, 10], 2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

function buildIcon(marker) {
  return L.divIcon({
    className: '',
    html: `<div class="marker-pin status-${marker.status}" style="background:${marker.color}"></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 19],
    popupAnchor: [0, -18],
  });
}

// ---- POPUP ----

function buildPopupContent(marker) {
  const container = L.DomUtil.create('div', 'popup-content');
  const coords = L.DomUtil.create('div', 'popup-coords', container);
  const status = L.DomUtil.create('div', 'popup-status', container);
  const removeBtn = L.DomUtil.create('button', 'popup-remove', container);
  removeBtn.type = 'button';
  removeBtn.textContent = '× Remove';
  removeBtn.addEventListener('click', () => removeMarker(marker));

  marker._popupEls = { coords, status };
  refreshPopupContent(marker);
  return container;
}

function refreshPopupContent(marker) {
  const els = marker._popupEls;
  if (!els) return;
  els.coords.textContent = `${marker.lat.toFixed(4)}, ${marker.lon.toFixed(4)}`;
  els.status.classList.toggle('error', marker.status === 'error');
  if (marker.status === 'loading') {
    els.status.textContent = 'Loading…';
  } else if (marker.status === 'error') {
    els.status.textContent = 'Error: ' + marker.errorMessage;
  } else {
    els.status.textContent = 'Ready';
  }
}

function updateMarkerVisual(marker) {
  marker.leafletMarker.setIcon(buildIcon(marker));
  refreshPopupContent(marker);
  updateLegend();
}

// ---- MARKER LIFECYCLE ----

let markerIdCounter = 0;

function createMarker(lat, lon) {
  const marker = {
    id: 'm' + (markerIdCounter++),
    lat, lon,
    color: nextColor(),
    status: 'loading',
    errorMessage: null,
    raw: null,
    weeklyStats: null,
  };

  const leafletMarker = L.marker([lat, lon], { draggable: true, icon: buildIcon(marker) }).addTo(map);
  marker.leafletMarker = leafletMarker;
  leafletMarker.bindPopup(buildPopupContent(marker));

  leafletMarker.on('dragend', (e) => {
    const pos = e.target.getLatLng();
    marker.lat = pos.lat;
    marker.lon = pos.lng;
    marker.status = 'loading';
    marker.errorMessage = null;
    marker.raw = null;
    marker.weeklyStats = null;
    updateMarkerVisual(marker);
    loadMarkerData(marker);
  });

  markers.push(marker);
  updateMarkerVisual(marker);
  loadMarkerData(marker);
  return marker;
}

function removeMarker(marker) {
  map.removeLayer(marker.leafletMarker);
  markers = markers.filter((m) => m.id !== marker.id);
  updateLegend();
  renderAllCharts();
}

map.on('click', (e) => {
  createMarker(e.latlng.lat, e.latlng.lng);
});

// ---- FETCH / CACHE ----

function formatDateYYYYMMDD(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function cacheKey(lat, lon) {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

function powerUrl(lat, lon) {
  const params = new URLSearchParams({
    parameters: 'T2M_MAX,T2M_MIN,PRECTOTCORR',
    community: 'RE',
    longitude: String(lon),
    latitude: String(lat),
    start: '19810101',
    end: formatDateYYYYMMDD(new Date()),
    format: 'JSON',
  });
  return `${POWER_API_BASE}?${params.toString()}`;
}

async function fetchPowerData(lat, lon) {
  const key = cacheKey(lat, lon);
  if (rawCache.has(key)) return rawCache.get(key);

  const res = await fetch(powerUrl(lat, lon));
  if (!res.ok) throw new Error(`NASA POWER API returned HTTP ${res.status}`);
  const data = await res.json();
  const params = data && data.properties && data.properties.parameter;
  if (!params || !params.T2M_MAX) throw new Error('Unexpected API response shape');

  const tmax = params.T2M_MAX, tmin = params.T2M_MIN, precip = params.PRECTOTCORR;
  const records = [];
  for (const dateKey of Object.keys(tmax)) {
    const vMax = tmax[dateKey], vMin = tmin[dateKey], vPrecip = precip[dateKey];
    if (vMax < -900 || vMin < -900 || vPrecip < -900) continue; // fill-value (-999) days

    const year = Number(dateKey.slice(0, 4));
    const month0 = Number(dateKey.slice(4, 6)) - 1;
    const day = Number(dateKey.slice(6, 8));
    const doy = Math.floor((Date.UTC(year, month0, day) - Date.UTC(year, 0, 1)) / 86400000) + 1;

    records.push({ year, month0, doy, tmax: vMax, tmin: vMin, precip: vPrecip });
  }

  if (records.length === 0) throw new Error('No valid data returned for this location');
  rawCache.set(key, records);
  return records;
}

async function loadMarkerData(marker) {
  try {
    const records = await fetchPowerData(marker.lat, marker.lon);
    marker.raw = records;
    recomputeStats(marker);
    marker.status = 'ready';
    marker.errorMessage = null;
  } catch (err) {
    marker.status = 'error';
    marker.errorMessage = err.message || 'Fetch failed';
  }
  updateMarkerVisual(marker);
  renderAllCharts();
}

// ---- AGGREGATION ----

function weekBin(r) {
  // Folds the trailing days of the year (day 358+) into the final bin (51),
  // giving 52 bins of ~7 days each.
  return Math.min(51, Math.floor((r.doy - 1) / 7));
}

function meanStdPerBin(valueArrays) {
  const mean = [], std = [];
  for (const arr of valueArrays) {
    if (arr.length === 0) {
      mean.push(0);
      std.push(0);
      continue;
    }
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    let variance = 0;
    if (arr.length > 1) {
      variance = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1);
    }
    mean.push(m);
    std.push(Math.sqrt(variance));
  }
  return { mean, std };
}

// Temperature stats pool every matching day (across all years) into one distribution
// per bin. Rain days/rain mm are inherently *weekly-total* quantities, so those are
// first summarized per (year, bin) and only then averaged across years -- pooling
// individual days for rain would conflate day-to-day and year-to-year variance and
// make "rain days per week" meaningless.
function computeStats(records, binCount, getBin, rainThreshold) {
  const tempMaxByBin = Array.from({ length: binCount }, () => []);
  const tempMinByBin = Array.from({ length: binCount }, () => []);
  const yearBinMap = new Map(); // "year_bin" -> { bin, rainDayCount, rainMmSum }

  for (const r of records) {
    const bin = getBin(r);
    tempMaxByBin[bin].push(r.tmax);
    tempMinByBin[bin].push(r.tmin);

    const key = r.year + '_' + bin;
    let entry = yearBinMap.get(key);
    if (!entry) {
      entry = { bin, rainDayCount: 0, rainMmSum: 0 };
      yearBinMap.set(key, entry);
    }
    if (r.precip >= rainThreshold) entry.rainDayCount++;
    entry.rainMmSum += r.precip;
  }

  const rainDaysByBin = Array.from({ length: binCount }, () => []);
  const rainMmByBin = Array.from({ length: binCount }, () => []);
  for (const entry of yearBinMap.values()) {
    rainDaysByBin[entry.bin].push(entry.rainDayCount);
    rainMmByBin[entry.bin].push(entry.rainMmSum);
  }

  return {
    maxTemp: meanStdPerBin(tempMaxByBin),
    minTemp: meanStdPerBin(tempMinByBin),
    rainDays: meanStdPerBin(rainDaysByBin),
    rainMm: meanStdPerBin(rainMmByBin),
  };
}

function recomputeStats(marker) {
  if (!marker.raw) return;
  marker.weeklyStats = computeStats(marker.raw, 52, weekBin, rainThresholdMm);
}

// ---- LEGEND ----

function updateLegend() {
  const el = document.getElementById('marker-legend');
  el.innerHTML = '';
  for (const m of markers) {
    const item = document.createElement('div');
    item.className = 'legend-item';

    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = m.color;
    item.appendChild(swatch);

    const label = document.createElement('span');
    label.textContent = `${m.lat.toFixed(2)}, ${m.lon.toFixed(2)}`;
    item.appendChild(label);

    if (m.status !== 'ready') {
      const statusSpan = document.createElement('span');
      statusSpan.className = 'legend-status';
      statusSpan.textContent = m.status === 'loading' ? '(loading)' : '(error)';
      item.appendChild(statusSpan);
    }

    const removeBtn = document.createElement('span');
    removeBtn.className = 'legend-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove this location';
    removeBtn.addEventListener('click', () => removeMarker(m));
    item.appendChild(removeBtn);

    el.appendChild(item);
  }
}

// ---- CHARTS ----

function hexToRgba(hex, alpha) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function buildTracePair(marker, xs, stats) {
  const upper = stats.mean.map((v, i) => v + stats.std[i]);
  const lower = stats.mean.map((v, i) => v - stats.std[i]);
  const bandX = xs.concat(xs.slice().reverse());
  const bandY = upper.concat(lower.slice().reverse());
  const label = `${marker.lat.toFixed(2)}, ${marker.lon.toFixed(2)}`;

  return [
    {
      type: 'scatter',
      x: bandX, y: bandY,
      fill: 'toself',
      fillcolor: hexToRgba(marker.color, 0.15),
      line: { color: 'transparent' },
      hoverinfo: 'skip',
      showlegend: false,
      name: label + ' (±std)',
    },
    {
      type: 'scatter',
      x: xs, y: stats.mean,
      mode: 'lines',
      line: { color: marker.color, width: 2 },
      name: label,
    },
  ];
}

function chartLayout(spec) {
  return {
    margin: { l: 50, r: 10, t: 10, b: 30 },
    xaxis: {
      tickmode: 'array',
      tickvals: MONTH_TICK_VALUES,
      ticktext: MONTH_LABELS,
    },
    yaxis: { title: spec.yTitle },
    hovermode: 'x unified',
    showlegend: false,
  };
}

function initCharts() {
  for (const spec of CHART_SPECS) {
    Plotly.newPlot(spec.id, [], chartLayout(spec), { responsive: true, displayModeBar: false });
  }
}

function renderAllCharts() {
  const readyMarkers = markers.filter((m) => m.status === 'ready');
  const xs = Array.from({ length: 52 }, (_, i) => i + 1);

  for (const spec of CHART_SPECS) {
    const traces = [];
    for (const m of readyMarkers) {
      traces.push(...buildTracePair(m, xs, m.weeklyStats[spec.metric]));
    }
    Plotly.react(spec.id, traces, chartLayout(spec), { responsive: true, displayModeBar: false });
  }
}

// ---- CONTROLS ----

let thresholdDebounceTimer = null;
document.getElementById('threshold-input').addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  if (Number.isNaN(val) || val < 0) return;
  clearTimeout(thresholdDebounceTimer);
  thresholdDebounceTimer = setTimeout(() => {
    rainThresholdMm = val;
    for (const m of markers) {
      if (m.status === 'ready') recomputeStats(m);
    }
    renderAllCharts();
  }, 150);
});

// ---- BOOTSTRAP ----

initCharts();

let resizeDebounceTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeDebounceTimer);
  resizeDebounceTimer = setTimeout(() => map.invalidateSize(), 150);
});
