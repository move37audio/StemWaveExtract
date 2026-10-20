'use strict';
// StemWave Extract UI. analyze_waveform (src-tauri/src/waveform.rs) returns per 160-sample
// bin: peak and RMS (sqrt-encoded), a six-band spectral colour, and the plug-in's three-band levels.
// Presets choose how those are drawn; the RGB DJ colouring is the plug-in's ui/app.js
// rgbForBin (Serato-matched, from ITCH SYNC UI serato-waveform-display.js).
const BIN_SAMPLES = 160, BINS_PER_SECOND = 44100 / BIN_SAMPLES, FIELDS = 8;
const GRID_SAMPLES = 512, GRID_RATE = 44100 / GRID_SAMPLES; // beat-estimator frame
const OUTPUTS = ['acapella', 'instrumental', 'vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
const STEMS = OUTPUTS.slice(2);
const SOURCES = ['original', ...OUTPUTS, 'remainder'];
const MODEL_STEMS = ['bass', 'drums', 'other', 'vocals', 'guitar', 'piano'];
const LABELS = {remainder: 'Remaining mix', original: 'Original', acapella: 'Acapella', instrumental: 'Instrumental', vocals: 'Vocals', drums: 'Drums', bass: 'Bass', guitar: 'Guitar', piano: 'Piano', other: 'Other'};
const ZOOM_BARS = [1, 2, 4, 8, 16, 32, 64];
// All modes use the same model; additional passes increase processing time.
const MODES = {
  fast: 'Fast: fewer overlapping chunks for quicker previews; may reduce separation quality.',
  standard: 'Standard: the bundled Hugging Face checkpoint and its original 2× overlap settings, with equivalent optimized attention.',
  hq: 'HQ: the same checkpoint with 4× overlap and three averaged views. Roughly six times Standard’s inference work; no upscaling.',
};
// Stem identity colours for the lane dots (the waveforms carry the spectral colour).
const DOTS = {original: '#c9ced6', acapella: '#f2c94c', instrumental: '#7fb3d5', vocals: '#f2c94c', drums: '#5fbf7f', bass: '#4aa3df', guitar: '#e5736f', piano: '#b49ddb', other: '#8fa1b3', remainder: '#9aa5b1'};
const PLAYHEAD = 0.5; // playhead at the exact centre of each lane

function duration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '—';
  const value = Math.ceil(seconds);
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${value % 60}s`;
  return `${Math.floor(value / 3600)}h ${Math.floor(value % 3600 / 60)}m`;
}
function clock(seconds) {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const mmss = `${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mmss}` : mmss;
}
function percent(value) { return Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100); }
function filename(path) { return String(path).split(/[\\/]/).pop() || path; }
const trackTitle = path => filename(path).replace(/\.[^.]+$/, '');
function dirname(path) { return String(path).replace(/[\\/][^\\/]*$/, '') || '/'; }
function stageLabel(stage) {
  return String(stage || 'Working').replace(/[_-]/g, ' ').replace(/^./, c => c.toUpperCase());
}
// Mirrors worker.plan(): Acapella already is the Vocals stem, so it is written once. The
// "Everything but …" mix of unpicked stems is only added when asked for.
function exportPlan(selected, remainder = false) {
  const set = new Set(selected), files = [], covered = new Set();
  if (set.has('acapella')) { files.push('Acapella'); covered.add('vocals'); }
  if (set.has('instrumental')) { files.push('Instrumental'); MODEL_STEMS.filter(s => s !== 'vocals').forEach(s => covered.add(s)); }
  for (const s of MODEL_STEMS) if (set.has(s)) {
    covered.add(s);
    if (!(s === 'vocals' && set.has('acapella'))) files.push(LABELS[s]);
  }
  if (remainder && covered.size && covered.size < MODEL_STEMS.length) files.push('Everything but ' + MODEL_STEMS.filter(s => covered.has(s)).map(s => LABELS[s]).join(' and '));
  return files;
}
function outputLabel(path) {
  const name = filename(path).replace(/\.wav$/i, '');
  return name.match(/\(([^()]*)\)$/)?.[1] || name;
}
function sourceOf(path) {
  if (!/\.wav$/i.test(path)) return null;
  const label = outputLabel(path), id = label.toLowerCase();
  if (/^Everything but (Bass|Drums|Other|Vocals|Guitar|Piano)( and (Bass|Drums|Other|Vocals|Guitar|Piano))*$/.test(label)) return 'remainder';
  return OUTPUTS.includes(id) ? id : null;
}
// Estimate a steady pulse from amplitude rises; bar one remains a user alignment.
const level = q => (q / 255) ** 2;
function estimateBeatGrid(data) {
  // Tuned on 512-sample peak frames; fold the 160-sample bins into those.
  const bins = Math.floor(data.length / FIELDS), count = Math.floor(bins * BIN_SAMPLES / GRID_SAMPLES);
  const amps = new Float32Array(count), onset = new Float32Array(count);
  for (let i = 0; i < bins; i++) {
    const j = Math.floor(i * BIN_SAMPLES / GRID_SAMPLES);
    if (j < count) amps[j] = Math.max(amps[j], level(data[i * FIELDS]));
  }
  let previous = 0, energy = 0, events = 0;
  for (let i = 0; i < count; i++) {
    const amp = amps[i];
    onset[i] = Math.max(0, amp - previous - .025);
    previous = amp; energy += onset[i] ** 2;
    if (onset[i] > .08) events++;
  }
  if (events < 8 || energy < .1) return null;
  let best = 0, bestLag = 0;
  for (let lag = Math.ceil(GRID_RATE * 60 / 180); lag <= GRID_RATE * 60 / 70; lag++) {
    let score = 0;
    // Adjacent bins accommodate the quantisation of a beat between bins.
    for (let i = lag + 1; i < count - 1; i++) score += onset[i] * Math.max(onset[i - lag - 1], onset[i - lag], onset[i - lag + 1]);
    score /= energy;
    score *= 1 - Math.abs(120 - 60 * GRID_RATE / lag) * .0005;
    if (score > best) { best = score; bestLag = lag; }
  }
  if (best < .2) return null;
  // Refine the lag with onset pairs so rounding does not accumulate over a song.
  let distance = 0, weight = 0;
  for (let i = bestLag + 2; i < count; i++) {
    if (onset[i] < .08) continue;
    let match = 0, delta = 0;
    for (let d = bestLag - 2; d <= bestLag + 2; d++) {
      if (onset[i - d] > match) { match = onset[i - d]; delta = d; }
    }
    const w = onset[i] * match; distance += delta * w; weight += w;
  }
  const period = weight ? distance / weight : bestLag;
  let phase = 0, phaseScore = 0;
  for (let p = 0; p < Math.ceil(period); p++) {
    let score = 0;
    for (let t = p; t < count; t += period) score += onset[Math.round(t)] || 0;
    if (score > phaseScore) { phaseScore = score; phase = p; }
  }
  return {bpm: Math.round(60 * GRID_RATE / period * 100) / 100, offset: phase / GRID_RATE};
}
function beatLabelStride(width, seconds, bpm) {
  return 2 ** Math.max(0, Math.ceil(Math.log2(45 * seconds * bpm / (240 * width))));
}
function beatLines(start, end, bpm, offset) {
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 240 || !Number.isFinite(offset)) return [];
  const step = 60 / bpm, result = [];
  for (let n = Math.ceil((start - offset) / step); offset + n * step <= end; n++) {
    const time = offset + n * step;
    if (time >= 0) result.push({time, downbeat: ((n % 4) + 4) % 4 === 0, bar: Math.floor(n / 4) + 1});
  }
  return result;
}
// Waveform presets, picked from the shootout (README): what colours a bar and whether it has a lighter RMS core.
const PRESETS = {
  spectral: {label: 'Spectral', colour: 'spectral', core: true},
  rgb: {label: 'RGB DJ', colour: 'rgb', core: false},
  mono: {label: 'Mono', colour: 'mono', core: true},
};
// Exported file names (worker.NAMING).
const NAMING = {paren: (t, s) => `${t} (${s}).wav`, dash: (t, s) => `${t} - ${s}.wav`, stem: (t, s) => `${s}.wav`};
// Shared vertical scale: the original's track peak (spec floor 0.01), so stems show their level in the mix.
function trackPeak(data) {
  let peak = 0;
  for (let o = 0; o < data.length; o += FIELDS) if (data[o] > peak) peak = data[o];
  return Math.max(0.01, level(peak));
}
const band = b => 2 * (b / 255) ** 2;
// The plug-in's 99.2th-percentile band peaks, skipping near-silence (rgbForBin's normalisation).
function bandPeaks(data) {
  const h = [0, 1, 2].map(() => new Uint32Array(256));
  for (let o = 0; o < data.length; o += FIELDS) {
    if (level(data[o]) * 255 < 3) continue;
    h[0][data[o + 5]]++; h[1][data[o + 6]]++; h[2][data[o + 7]]++;
  }
  const pct = hist => {
    let total = 0, above = 0;
    for (const n of hist) total += n;
    for (let b = 255; b > 0; b--) if ((above += hist[b]) > total * 0.008) return b;
    return 0;
  };
  return {low: Math.max(0.002, band(pct(h[0]))), mid: Math.max(0.002, band(pct(h[1]))), high: Math.max(0.002, band(pct(h[2])))};
}
// rgbForBin from the plug-in renderer: red bass, green mids, blue highs, each against the mix's band peaks.
function rgbForBands(lo, md, hi, pk) {
  const l = Math.min(1, band(lo) / pk.low * 1.6), m = Math.min(1, band(md) / pk.mid * 1.6), h = Math.min(1, band(hi) / pk.high * 1.6);
  return [Math.min(255, l * 255 + m * 10 + h * 10), Math.min(255, l * 10 + m * 255 + h * 40), Math.min(255, l * 10 + m * 50 + h * 255)];
}
// look: {colour, core, peak, bands, colorScale, coreColour: [r, g, b, alpha], mono: [r, g, b]}.
function columnColour(data, at, b0, b1, look) {
  if (look.colour === 'mono') return look.mono;
  if (look.colour === 'spectral') return [data[at + 2], data[at + 3], data[at + 4]];
  let lo = 0, md = 0, hi = 0;
  for (let o = b0 * FIELDS; o < b1 * FIELDS; o += FIELDS) {
    if (data[o + 5] > lo) lo = data[o + 5];
    if (data[o + 6] > md) md = data[o + 6];
    if (data[o + 7] > hi) hi = data[o + 7];
  }
  return rgbForBands(lo, md, hi, look.bands);
}
// Per pixel column: the loudest bin as a peak bar, optionally with a lighter RMS core.
// Written into one pixel buffer and composited once: thousands of fillRect calls with
// fresh colour strings per lane per frame were the playback hot path.
function drawWave(ctx, data, look, w, h, startBin, binsPerPx, scale) {
  if (w <= 0 || h <= 0) return;
  // Write to the lane itself: no shared mutable canvas for WebKit to composite later.
  const image = ctx.createImageData(w, h), px = image.data;
  const bins = data.length / FIELDS, mid = h / 2, height = h * scale / look.peak, k = look.colorScale ?? 1;
  const [cr, cg, cb, ca] = look.core ? look.coreColour : [0, 0, 0, 0];
  const colour = (r, g, b) => [Math.round(r), Math.round(g), Math.round(b), 255];
  for (let x = 0; x < w; x++) {
    const raw = Math.floor(startBin + x * binsPerPx);
    const b0 = Math.max(0, raw), b1 = Math.min(bins, Math.max(raw + 1, Math.floor(startBin + (x + 1) * binsPerPx)));
    if (b0 >= b1) continue; // before the start or past the end
    let top = -1, rms = 0, at = b0 * FIELDS;
    for (let o = b0 * FIELDS; o < b1 * FIELDS; o += FIELDS) {
      if (data[o] > top) { top = data[o]; at = o; }
      if (data[o + 1] > rms) rms = data[o + 1];
    }
    const p = Math.max(0.5, Math.min(mid, level(top) * height)), r = look.core ? Math.min(mid, level(rms) * height) : 0;
    const [red, green, blue] = columnColour(data, at, b0, b1, look).map(v => v * k);
    const edge = colour(red, green, blue);
    const inner = colour(red + (cr - red) * ca, green + (cg - green) * ca, blue + (cb - blue) * ca);
    for (let y = Math.floor(mid - p), end = Math.ceil(mid + p); y < end; y++) {
      px.set(Math.abs(y + .5 - mid) < r ? inner : edge, (y * w + x) * 4);
    }
  }
  ctx.putImageData(image, 0, 0);
}
// Overview: loudness (RMS) bars against the track's loudest bin, so song sections stay readable;
// colour blended across the column by loudness.
function drawOverviewWave(ctx, data, look, w, h) {
  const bins = data.length / FIELDS, binsPerPx = bins / w, mid = h / 2, k = look.colorScale ?? 1;
  let loudest = 1;
  for (let o = 1; o < data.length; o += FIELDS) if (data[o] > loudest) loudest = data[o];
  for (let x = 0; x < w; x++) {
    const b0 = Math.floor(x * binsPerPx), b1 = Math.min(bins, Math.max(b0 + 1, Math.floor((x + 1) * binsPerPx)));
    let rms = 0, red = 0, green = 0, blue = 0, weight = 0;
    for (let b = b0; b < b1; b++) {
      const o = b * FIELDS, v = level(data[o + 1]), [cr, cg, cb] = columnColour(data, o, b, b + 1, look);
      if (data[o + 1] > rms) rms = data[o + 1];
      red += cr * v; green += cg * v; blue += cb * v; weight += v;
    }
    const r = mid * 0.94 * level(rms) / level(loudest), f = k / (weight || 1);
    ctx.fillStyle = `rgb(${Math.round(red * f)}, ${Math.round(green * f)}, ${Math.round(blue * f)})`;
    ctx.fillRect(x, mid - r, 1, Math.max(0.5, 2 * r));
  }
}
// Which lanes are heard: soloed lanes if any lane is soloed, otherwise the lanes in the mix; never muted ones.
function audibleIds(available, mix, muted, soloed) {
  const anySolo = available.some(id => soloed.has(id));
  return new Set(available.filter(id => !muted.has(id) && (anySolo ? soloed.has(id) : mix.has(id))));
}
// Nearest beat on the grid (or the nearest quarter second without one).
function snapToBeat(t, grid) {
  if (!grid) return Math.round(t * 4) / 4;
  const spb = 60 / grid.bpm;
  return grid.offset + Math.round((t - grid.offset) / spb) * spb;
}
// Nearest bar line (downbeat) of a 4/4 grid; nearest second without one.
function snapToBar(t, grid) {
  if (!grid) return Math.round(t);
  const bar = 240 / grid.bpm;
  return grid.offset + Math.round((t - grid.offset) / bar) * bar;
}
// A loop from a click or drag on the bar ruler. A click loops from the playhead to the clicked
// beat (at least one bar); a drag loops the dragged span. Edges snap to beats.
function loopRegion(playhead, from, to, dragged, grid, length) {
  const beat = grid ? 60 / grid.bpm : 0.5;
  let a = snapToBeat(dragged ? Math.min(from, to) : Math.min(playhead, to), grid);
  let b = snapToBeat(dragged ? Math.max(from, to) : Math.max(playhead, to), grid);
  if (b - a < beat / 2) b = a + (dragged ? beat : 4 * beat);
  a = Math.max(0, a); b = Math.min(length || b, b);
  return b - a > 0.01 ? {start: a, end: b} : null;
}
// "bars 5-8" for a loop on the grid, otherwise whole seconds.
function loopLabel(loop, grid) {
  if (!grid) return `${Math.floor(loop.start)}-${Math.ceil(loop.end)} sec`;
  const bar = t => Math.max(1, Math.floor((t - grid.offset) / (240 / grid.bpm) + 1e-6) + 1); // a pickup before bar 1 counts as bar 1
  const first = bar(loop.start), last = bar(loop.end - 1e-3);
  return first === last ? `bar ${first}` : `bars ${first}-${last}`;
}
// A grid's offset is its first bar line at or after 0 s, so bars count from the track start.
function normalizeGrid(grid) {
  const bar = 240 / grid.bpm;
  return {bpm: grid.bpm, offset: ((grid.offset % bar) + bar) % bar};
}
// Tempo field: accepts "128", "128.5", "128,5".
function parseBpm(text) {
  const bpm = Number(String(text).trim().replace(',', '.'));
  return bpm >= 40 && bpm <= 240 ? Math.round(bpm * 100) / 100 : null;
}
if (typeof module !== 'undefined') module.exports = {duration, clock, percent, filename, dirname, stageLabel, exportPlan, sourceOf, trackPeak, bandPeaks, rgbForBands, drawWave, PRESETS, OUTPUTS, estimateBeatGrid, beatLines, beatLabelStride, audibleIds, parseBpm, snapToBeat, snapToBar, loopRegion, loopLabel, normalizeGrid};
if (typeof document !== 'undefined') initialize();

async function initialize() {
  const $ = id => document.getElementById(id);
  const api = window.__TAURI__;
  let input = '', output = '', outputChosen = false, busy = false, choosing = false, cancelling = false, lastOutput = '';
  let ready = false; // first-run setup (Python, FFmpeg, models) has finished
  let lastStatus = null, receivedAt = performance.now();
  // Sources: id -> {path, data, peak, bands, overview, error, buffer, loading}. waveCache is keyed by path.
  const sources = new Map(), waveCache = new Map();
  const selected = new Set();                    // stems for the next extraction
  let remainder = false;
  const mix = new Set(), muted = new Set(), soloed = new Set();
  let grid = null, gridManual = false, gridVisible = true, beatToken = 0;
  let zoom = 3, originalFolded = false, artUrl = '', dirty = true, light = false, preset = 'spectral', volume = 0.9, lastFrame = 0;
  const store = {
    get: key => { try { return window.localStorage?.getItem(key); } catch (_) { return null; } },
    set: (key, value) => { try { window.localStorage?.setItem(key, value); } catch (_) { /* Session only. */ } },
  };
  const h = (tag, props = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v; else el.setAttribute(k, v);
    for (const child of children) if (child) el.appendChild(child);
    return el;
  };


  // ---- Theme and waveform look ----
  function applyTheme(theme) {
    light = theme === 'light';
    document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
    $(`theme-${light ? 'light' : 'dark'}`).checked = true;
    for (const src of sources.values()) src.overview = null;
    dirty = true;
  }
  applyTheme(store.get('stemwave-theme') === 'light' ? 'light' : 'dark');
  for (const theme of ['dark', 'light']) $(`theme-${theme}`).addEventListener('change', () => { applyTheme(theme); store.set('stemwave-theme', theme); });
  function setPreset(value) {
    preset = PRESETS[value] ? value : 'spectral';
    $(`wave-${preset}`).checked = true;
    store.set('stemwave-waveform', preset);
    for (const src of sources.values()) src.overview = null;
    dirty = true;
  }
  setPreset(store.get('stemwave-waveform'));
  const pk = () => sources.get('original')?.peak ?? 1;
  // Zoom is in 4/4 bars at the grid tempo (120 BPM until one is known).
  const span = () => ZOOM_BARS[zoom] * 4 * 60 / (grid?.bpm || 120);
  const look = src => {
    const p = PRESETS[preset], original = sources.get('original');
    return {colour: p.colour, core: p.core, peak: pk(), bands: original?.bands ?? src.bands,
      colorScale: light ? .78 : 1, coreColour: light ? [0, 0, 0, .14] : [255, 255, 255, .18], mono: light ? [42, 48, 54] : [200, 206, 214]};
  };

  // ---- Flat menus (dropdowns, add stem, right-click) ----
  let openMenu = null;
  function closeMenu() {
    if (!openMenu) return;
    openMenu.anchor?.setAttribute('aria-expanded', 'false');
    openMenu.el.remove(); openMenu = null;
  }
  // items: [{label, value, selected?, heading?}] ; at: {x, y} or anchor element.
  function showMenu(anchor, items, onPick, at) {
    closeMenu();
    const role = at ? 'menu' : 'listbox', el = h('div', {class: 'menu', role});
    for (const item of items) {
      if (item.heading) { el.appendChild(h('div', {class: 'menu-label', text: item.heading})); continue; }
      if (item.empty) { el.appendChild(h('div', {class: 'empty-item', text: item.empty})); continue; }
      const button = h('button', {type: 'button', role: role === 'menu' ? 'menuitem' : 'option', 'aria-selected': String(Boolean(item.selected)), text: item.label});
      button.addEventListener('click', () => { closeMenu(); onPick(item.value); });
      el.appendChild(button);
    }
    document.body.appendChild(el);
    // Below the anchor (or pointer), flipped above when it would run off the window.
    const r = at ? {left: at.x, top: at.y, bottom: at.y} : anchor.getBoundingClientRect();
    const height = el.offsetHeight || 0, width = el.offsetWidth || 0, vh = window.innerHeight || Infinity, vw = window.innerWidth || Infinity;
    const top = r.bottom + 4 + height > vh ? Math.max(4, r.top - 4 - height) : r.bottom + 4;
    el.style.left = `${Math.round(Math.max(4, Math.min(r.left, vw - width - 4)))}px`;
    el.style.top = `${Math.round(top)}px`;
    anchor?.setAttribute('aria-expanded', 'true');
    openMenu = {el, anchor};
    el.querySelector?.('button')?.focus?.();
  }
  document.addEventListener('pointerdown', e => { if (openMenu && !openMenu.el.contains(e.target) && e.target !== openMenu.anchor && !openMenu.anchor?.contains?.(e.target)) closeMenu(); });
  for (const value of Object.keys(PRESETS)) $(`wave-${value}`).addEventListener('change', () => setPreset(value));
  // Settings panel: waveform style, beat grid, save folder.
  const settingsOpen = open => {
    $('settings').hidden = !open;
    $('settings-toggle').setAttribute('aria-expanded', String(open));
  };
  $('export-diagnostics').addEventListener('click', async () => {
    if (!api) { $('message').textContent = 'Diagnostics are available in the desktop app.'; return; }
    try {
      if (await api.core.invoke('export_diagnostics')) $('message').textContent = 'Diagnostic report saved. You can share it for troubleshooting.';
    } catch (error) { $('message').textContent = String(error?.message || error); }
  });
  $('settings-toggle').addEventListener('click', () => settingsOpen($('settings').hidden));
  document.addEventListener('pointerdown', e => {
    if (!$('settings').hidden && !$('settings').contains(e.target) && !$('settings-toggle').contains(e.target)) settingsOpen(false);
  });

  // ---- File settings: name pattern, folder per extraction ----
  let naming = NAMING[store.get('stemwave-naming')] ? store.get('stemwave-naming') : 'paren';
  let subfolder = store.get('stemwave-subfolder') !== 'off';
  function fileSettingsChanged() {
    $(`naming-${naming}`).checked = true;
    $('subfolder').setAttribute('aria-pressed', String(subfolder));
    $('naming-example').textContent = `e.g. ${NAMING[naming](input ? trackTitle(input) : 'Track', 'Drums')}${subfolder ? ', in a new folder' : ''}`;
    store.set('stemwave-naming', naming); store.set('stemwave-subfolder', subfolder ? 'on' : 'off');
  }
  for (const value of Object.keys(NAMING)) $(`naming-${value}`).addEventListener('change', () => { naming = value; fileSettingsChanged(); });
  $('subfolder').addEventListener('click', () => { subfolder = !subfolder; fileSettingsChanged(); });
  function showOutput() {
    const label = outputChosen ? output : output ? `${output} (track’s folder)` : 'Track’s folder';
    $('output-name').textContent = label; $('output-name').title = output;
    $('save-to-name').textContent = output ? filename(output) : 'Track’s folder'; $('save-to').title = output ? `Stems are saved to ${output}` : 'Where stems are saved';
  }

  // ---- Stem selection ----
  const mode = () => Object.keys(MODES).find(m => $(`mode-${m}`).checked) || 'standard';
  if (MODES[store.get('stemwave-mode-v2')]) $(`mode-${store.get('stemwave-mode-v2')}`).checked = true;
  for (const m of Object.keys(MODES)) {
    $(`mode-${m}`).parentElement.title = MODES[m];
    $(`mode-${m}`).addEventListener('change', () => store.set('stemwave-mode-v2', mode()));
  }
  const plan = () => exportPlan([...selected], remainder);
  function selectionChanged() { showLanes(); controls(); }
  const present = id => selected.has(id) || sources.has(id);
  function addMenu() {
    // Only what isn't on screen yet. Acapella and Vocals are the same audio, so either hides the other.
    const vocalsShown = present('vocals') || present('acapella');
    const quick = ['acapella', 'instrumental'].filter(id => !present(id) && !(id === 'acapella' && vocalsShown));
    const stems = STEMS.filter(id => !present(id) && !(id === 'vocals' && vocalsShown));
    const items = [];
    if (quick.length) items.push({heading: 'Quick'}, ...quick.map(id => ({label: LABELS[id], value: id})));
    if (stems.length) items.push({heading: 'Stems'}, ...stems.map(id => ({label: LABELS[id], value: id})), ...(stems.length > 1 ? [{label: 'All remaining stems', value: 'all'}] : []));
    if (!remainder && !sources.has('remainder')) items.push({heading: 'Mix'}, {label: 'Everything else', value: 'remainder'});
    return items.length ? items : [{empty: 'Everything is already added'}];
  }
  function pickFromMenu(value) {
    if (busy) return;
    if (value === 'remainder') remainder = true;
    else for (const id of value === 'all' ? STEMS.filter(id => !present(id) && !(id === 'vocals' && present('acapella'))) : [value]) selected.add(id);
    selectionChanged();
  }
  const addRow = h('div', {class: 'add-lane'});
  const addButton = h('button', {id: 'add-stem', type: 'button', 'aria-haspopup': 'menu', text: '+  Add stem'});
  addRow.appendChild(addButton);
  addButton.addEventListener('click', () => {
    if (openMenu?.anchor === addButton) return closeMenu();
    showMenu(addButton, addMenu(), pickFromMenu);
  });

  // ---- Lanes ----
  const lanes = new Map();
  const available = () => SOURCES.filter(id => sources.get(id)?.buffer);
  const heard = () => audibleIds(available(), mix, muted, soloed);
  // What the user asked to hear, including lanes still decoding.
  const wanted = () => audibleIds(SOURCES.filter(id => sources.has(id) && !sources.get(id).error), mix, muted, soloed);
  function pendingIds() {
    if (!input) return [];
    const files = plan();
    const ids = OUTPUTS.filter(id => files.includes(LABELS[id]));
    if (files.some(f => f.startsWith('Everything but '))) ids.push('remainder');
    return ids.filter(id => !sources.has(id));
  }
  function laneFor(id) {
    if (lanes.has(id)) return lanes.get(id);
    const name = h('span', {class: 'lane-name'}), state = h('span', {class: 'lane-state'});
    const dot = h('span', {class: 'lane-dot'});
    dot.style.setProperty('--dot', DOTS[id]);
    const pick = h('button', {class: 'lane-pick', type: 'button'}, dot, h('span', {class: 'lane-text'}, name, state));
    const mute = h('button', {class: 'ms mute', type: 'button', 'aria-pressed': 'false', title: 'Mute', text: 'M'});
    const solo = h('button', {class: 'ms solo', type: 'button', 'aria-pressed': 'false', title: 'Solo', text: 'S'});
    const remove = h('button', {class: 'remove', type: 'button', title: 'Remove', 'aria-label': `Remove ${LABELS[id]}`, text: '×'});
    const fold = h('button', {class: 'fold', type: 'button', title: 'Minimize', 'aria-label': 'Minimize original', text: '–'});
    const canvas = h('canvas');
    const el = h('div', {class: 'lane'}, h('div', {class: 'lane-head'}, pick, mute, solo, id === 'original' ? fold : remove), canvas);
    fold.addEventListener('click', () => { originalFolded = !originalFolded; showLanes(); });
    pick.addEventListener('click', e => listen(id, e.metaKey || e.ctrlKey));
    mute.addEventListener('click', () => { toggle(muted, id); mixChanged(); });
    solo.addEventListener('click', () => { toggle(soloed, id); mixChanged(); });
    remove.addEventListener('click', () => removeLane(id));
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      const src = sources.get(id);
      if (!src) return;
      const name = id === 'remainder' ? 'Everything else' : LABELS[id], items = [];
      if (id !== 'original') items.push({label: `Export ${name}…`, value: 'whole'});
      if (loop) items.push({label: `Export ${name}, ${loopLabel(loop, grid)}…`, value: 'loop'}, {label: `Export ${loopLabel(loop, grid)} of all lanes…`, value: 'all'});
      if (!items.length) return;
      showMenu(null, items, value => (value === 'all' ? exportLoop() : exportStem(id, value === 'loop')), {x: e.clientX, y: e.clientY});
    });
    let drag = null;
    canvas.addEventListener('pointerdown', e => { if (!sources.has(id)) return; drag = {x: e.clientX, t: position(), moved: false, add: e.metaKey || e.ctrlKey}; canvas.setPointerCapture?.(e.pointerId); });
    canvas.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      if (drag.moved) seek(drag.t - dx * span() / (canvas.clientWidth || 1));
    });
    canvas.addEventListener('pointerup', () => { if (drag && !drag.moved) listen(id, drag.add); drag = null; });
    const lane = {el, name, state, pick, mute, solo, remove, fold, canvas};
    lanes.set(id, lane);
    return lane;
  }
  const toggle = (set, id) => (set.has(id) ? set.delete(id) : set.add(id));
  function showLanes() {
    const pending = pendingIds(), shown = SOURCES.filter(id => sources.has(id) || pending.includes(id)), audible = wanted();
    for (const [id, lane] of lanes) if (!shown.includes(id)) { lane.el.remove(); lanes.delete(id); }
    const stemsShown = shown.length > 1;
    for (const id of shown) {
      const lane = laneFor(id), src = sources.get(id);
      $('lanes').appendChild(lane.el); // keeps SOURCES order
      if (id === 'original') {
        const folded = originalFolded && stemsShown;
        lane.el.classList.toggle('collapsed', folded);
        lane.fold.hidden = !stemsShown;
        lane.fold.textContent = folded ? '+' : '–';
        lane.fold.title = folded ? 'Expand' : 'Minimize';
      }
      lane.el.classList.toggle('pending', !src);
      lane.el.classList.toggle('audible', audible.has(id));
      lane.name.textContent = id === 'remainder' ? (src ? outputLabel(src.path) : plan().find(f => f.startsWith('Everything but '))) : LABELS[id];
      lane.state.textContent = !src ? 'Ready to extract' : src.error || (!src.data ? 'Analysing…' : src.loading && !src.buffer ? 'Loading audio…' : '');
      lane.state.classList.toggle('error', Boolean(src?.error));
      lane.pick.disabled = !src;
      lane.mute.hidden = lane.solo.hidden = !src;
      lane.mute.setAttribute('aria-pressed', String(muted.has(id)));
      lane.solo.setAttribute('aria-pressed', String(soloed.has(id)));
      lane.remove.hidden = id === 'original';
      lane.remove.disabled = busy;
    }
    if (input) { if ($('lanes').firstChild !== ruler) $('lanes').insertBefore(ruler, $('lanes').firstChild); $('lanes').appendChild(addRow); }
    else { ruler.remove(); addRow.remove(); }
    const names = [...audible].map(id => id === 'remainder' ? 'Everything else' : LABELS[id]);
    const loading = [...audible].some(id => !sources.get(id).buffer);
    $('now-source').textContent = names.length ? names.join(' + ') + (loading ? ' (loading)' : '') : soloed.size || mix.size ? 'Nothing (muted)' : '—';
    dirty = true;
  }
  function removeLane(id) {
    if (busy) return;
    selected.delete(id);
    if (id === 'remainder') remainder = false;
    const src = sources.get(id);
    if (src) {
      stopVoice(id); waveCache.delete(src.path); sources.delete(id);
      mix.delete(id); muted.delete(id); soloed.delete(id);
      if (!mix.size && sources.has('original')) mix.add('original');
    }
    selectionChanged(); mixChanged();
  }

  // ---- Playback: Web Audio, every loaded lane runs sample-locked; the mix only changes gains ----
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let ctx = null, master = null, playing = false, startedAt = 0, startPos = 0, pausedPos = 0;
  let loop = null, looping = false, extractRegion = null;   // loop region {start, end}; looping plays it gaplessly
  const inLoop = t => loop && t >= loop.start && t < loop.end;
  const voices = new Map();
  function audio() {
    if (!ctx) { ctx = new AudioCtx(); master = ctx.createGain(); master.gain.value = volume; master.connect(ctx.destination); }
    return ctx;
  }
  function length() {
    const buffer = sources.get('original')?.buffer, data = sources.get('original')?.data;
    return buffer ? buffer.duration : data ? data.length / FIELDS / BINS_PER_SECOND : 0;
  }
  function position() {
    if (!playing) return pausedPos;
    const t = startPos + ctx.currentTime - startedAt;
    // Web Audio wraps at loopEnd on its own; mirror that for the playhead.
    if (looping && loop && startPos < loop.end && t >= loop.end) return loop.start + (t - loop.start) % (loop.end - loop.start);
    return Math.min(length() || Infinity, t);
  }
  function loadBuffer(id) {
    const src = sources.get(id);
    if (!src || src.buffer || src.loading || src.error) return;
    src.loading = fetch(api.core.convertFileSrc(src.path))
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then(bytes => audio().decodeAudioData(bytes))
      .then(buffer => {
        if (sources.get(id) !== src) return;
        src.buffer = buffer;
        if (playing) startVoice(id, position());
      }, error => {
        if (sources.get(id) !== src) return;
        src.error = 'Can’t play';
        $('message').textContent = id === 'original' ? 'This file’s format can’t be played here. Extraction still works.' : `${LABELS[id]} couldn’t be loaded for playback.`;
        console.warn(error);
      })
      .finally(() => { showLanes(); controls(); });
    showLanes();
  }
  function startVoice(id, at) {
    const src = sources.get(id), local = at - (src?.offset || 0);
    if (!src?.buffer || voices.has(id) || local >= src.buffer.duration) return;
    const node = ctx.createBufferSource(), gain = ctx.createGain();
    node.buffer = src.buffer;
    if (looping && loop) {
      const a = Math.max(0, loop.start - src.offset), b = Math.min(src.buffer.duration, loop.end - src.offset);
      if (b > a) { node.loop = true; node.loopStart = a; node.loopEnd = b; }
    }
    gain.gain.value = heard().has(id) ? 1 : 0;
    node.connect(gain); gain.connect(master);
    // A lane that starts later on the timeline is scheduled to come in on time.
    if (local < 0) node.start(ctx.currentTime - local, 0); else node.start(0, local);
    voices.set(id, {node, gain});
  }
  function stopVoice(id) {
    const voice = voices.get(id);
    if (!voice) return;
    try { voice.node.stop(); } catch (_) { /* Already ended. */ }
    voice.node.disconnect(); voice.gain.disconnect(); voices.delete(id);
  }
  const stopVoices = () => { for (const id of [...voices.keys()]) stopVoice(id); };
  function mixChanged() {
    const audible = heard();
    for (const [id, voice] of voices) voice.gain.gain.setTargetAtTime(audible.has(id) ? 1 : 0, ctx.currentTime, 0.008);
    // Decode lanes as soon as they're wanted; undecoded lanes join when ready.
    for (const id of SOURCES) if (sources.has(id) && !muted.has(id) && (soloed.size ? soloed.has(id) : mix.has(id))) loadBuffer(id);
    showLanes(); controls();
  }
  function listen(id, combine) {
    if (!sources.has(id)) return;
    if (combine) toggle(mix, id); else { mix.clear(); mix.add(id); soloed.clear(); muted.delete(id); }
    mixChanged();
  }
  function play() {
    if (!heard().size) return;
    audio().resume?.();
    startPos = looping && !inLoop(pausedPos) ? loop.start : pausedPos >= length() ? 0 : pausedPos;
    startedAt = ctx.currentTime; playing = true;
    for (const id of available()) startVoice(id, startPos);
    playState();
  }
  function pause() { pausedPos = position(); playing = false; stopVoices(); playState(); dirty = true; }
  const togglePlay = () => (playing ? pause() : play());
  function seek(seconds) {
    let t = Math.max(0, Math.min(length() || 0, seconds));
    if (looping && !inLoop(t)) t = loop.start; // stay inside the loop while it's on
    if (playing) { stopVoices(); startPos = t; startedAt = ctx.currentTime; for (const id of available()) startVoice(id, t); }
    else pausedPos = t;
    dirty = true;
  }
  function restartVoices() { if (playing) { const t = position(); stopVoices(); startPos = t; startedAt = ctx.currentTime; for (const id of available()) startVoice(id, t); } }
  function loopChanged() {
    $('loop').hidden = !(looping && loop);
    $('loop').title = loop ? `Loop ${loopLabel(loop, grid)}` : 'Loop';
    $('zoom').setAttribute('aria-pressed', String(looping));
    controls();
    if (looping && playing && !inLoop(position())) { stopVoices(); startPos = loop.start; startedAt = ctx.currentTime; for (const id of available()) startVoice(id, loop.start); }
    else restartVoices();
    dirty = true;
  }
  function setLoop(region) {
    if (!region) return;
    loop = region; looping = true;
    if (!playing && !inLoop(pausedPos)) pausedPos = loop.start;
    loopChanged();
  }
  const barSeconds = () => (grid ? 240 / grid.bpm : 2);
  $('zoom').addEventListener('click', () => {
    if (!input) return;
    // Bar-count loops start on the nearest downbeat.
    let start = snapToBar(position(), grid);
    if (start < 0) start += barSeconds();
    const end = Math.min(length() || Infinity, start + ZOOM_BARS[zoom] * barSeconds());
    if (end - start > 0.01) setLoop({start, end});
  });
  // The loop icon sits beside Play only while a loop is on; clicking it ends the loop.
  $('loop').addEventListener('click', () => { looping = false; loop = null; loopChanged(); });
  function playState() {
    $('play-icon').firstChild?.setAttribute?.('href', `#i-${playing ? 'pause' : 'play'}`);
    $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    $('play').title = playing ? 'Pause (Space)' : 'Play (Space)';
  }

  // ---- Sources ----
  function addSource(id, path, offset = 0) {
    const src = {path, offset, data: null, error: '', overview: null, buffer: null, loading: null};
    sources.set(id, src);
    if (!waveCache.has(path)) waveCache.set(path, api.core.invoke('analyze_waveform', {path}).then(buffer => new Uint8Array(buffer)));
    const analysis = waveCache.get(path);
    analysis.then(data => {
      if (sources.get(id) !== src) return;
      src.data = data; src.peak = trackPeak(data); src.bands = bandPeaks(data);
      if (id === 'original') { $('length').textContent = clock(length()); if (!grid && beatsFailed) useEstimate(); }
    }, error => {
      if (waveCache.get(path) === analysis) waveCache.delete(path);
      if (sources.get(id) === src) src.error = 'No waveform';
      console.warn(error);
    }).finally(showLanes);
    showLanes();
  }
  // ---- Beat grid: beat_this in the backend; the waveform estimate only if that fails ----
  let beatsFailed = false;
  function gridChanged(status) {
    $('grid-bpm').value = grid ? String(grid.bpm) : '';
    $('bpm-readout').textContent = grid ? `${grid.bpm} BPM${status ? ` · ${status}` : ''}` : status || '— BPM';
    $('tempo-value').textContent = grid ? `${grid.bpm} BPM` : '— BPM';
    for (const id of ['tempo-half', 'tempo-double', 'downbeat']) $(id).disabled = !grid;
    if (grid && gridManual && input) store.set(`stemwave-grid:${input}`, JSON.stringify(grid)); // remembered per track
    if (loop) $('loop').title = `Loop ${loopLabel(loop, grid)}`;
    $('grid-visible').setAttribute('aria-pressed', String(gridVisible));
    dirty = true;
  }
  function useEstimate() {
    const data = sources.get('original')?.data;
    grid = data ? estimateBeatGrid(data) : null;
    gridChanged(grid ? 'Rough estimate' : 'Set BPM');
  }
  async function detectBeats(path) {
    const token = ++beatToken;
    try {
      const saved = JSON.parse(store.get(`stemwave-grid:${path}`) || 'null');
      if (saved && parseBpm(saved.bpm) && Number.isFinite(saved.offset)) { grid = normalizeGrid(saved); gridManual = true; gridChanged('Saved grid'); return; }
    } catch (_) { /* Ignore a corrupt saved grid. */ }
    beatsFailed = false; gridChanged('Finding beats…');
    try {
      const result = await api.core.invoke('analyze_beats', {path});
      if (token !== beatToken || gridManual) return;
      if (result && parseBpm(result.bpm)) { grid = {bpm: result.bpm, offset: result.offset}; gridChanged(result.confidence < 0.3 ? 'Check the grid' : ''); }
      else { beatsFailed = true; useEstimate(); }
    } catch (error) {
      if (token !== beatToken || gridManual) return;
      beatsFailed = true; useEstimate(); console.warn(error);
    }
  }
  $('grid-visible').addEventListener('click', () => { gridVisible = !gridVisible; gridChanged(); });
  $('grid-bpm').addEventListener('change', () => {
    const bpm = parseBpm($('grid-bpm').value);
    if (!bpm) { gridChanged('BPM 40–240'); return; }
    grid = {bpm, offset: grid?.offset ?? 0}; gridManual = true; gridChanged();
  });
  // Double-click the tempo between ½ and 2× to type one.
  $('tempo-value').addEventListener('dblclick', () => {
    if (!grid) return;
    const field = h('input', {class: 'tempo-edit', type: 'text', inputmode: 'decimal', 'aria-label': 'Tempo in BPM'});
    field.value = String(grid.bpm);
    const label = $('tempo-value');
    let done = false;
    const finish = commit => {
      if (done) return; done = true;
      const bpm = commit && parseBpm(field.value);
      field.remove(); label.hidden = false;
      if (bpm) { grid = {bpm, offset: grid.offset}; gridManual = true; gridChanged(); }
    };
    field.addEventListener('keydown', e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); e.stopPropagation?.(); });
    field.addEventListener('blur', () => finish(true));
    label.hidden = true; label.parentElement.insertBefore(field, label); field.focus(); field.select?.();
  });
  // Downbeat: a bar line exactly at the playhead.
  $('downbeat').addEventListener('click', () => {
    if (!grid) return;
    grid = normalizeGrid({bpm: grid.bpm, offset: position()}); gridManual = true; gridChanged();
    if (loop) loopChanged();
  });
  for (const [id, factor] of [['tempo-half', 0.5], ['tempo-double', 2]]) $(id).addEventListener('click', () => {
    const bpm = grid && parseBpm(grid.bpm * factor);
    if (!bpm) { gridChanged('BPM 40–240'); return; }
    grid = {bpm, offset: grid.offset}; gridManual = true; gridChanged();
  });
  $('grid-bpm').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur?.(); });

  // ---- Drawing ----
  function fit(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr), h2 = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h2) { canvas.width = w; canvas.height = h2; return true; }
    return false;
  }
  function drawOverview(t, total) {
    const canvas = $('overview'), resized = fit(canvas);
    // The overview spans the whole track, so lanes extracted from a loop don't drive it.
    const first = [...heard()].find(id => !sources.get(id).offset), src = sources.get(first) || sources.get('original');
    const ctx2 = canvas.getContext('2d'), w = canvas.width, hgt = canvas.height;
    ctx2.clearRect(0, 0, w, hgt);
    if (!src?.data || !w) return;
    if (resized || !src.overview || src.overview.width !== w || src.overview.height !== hgt) {
      src.overview = document.createElement('canvas');
      src.overview.width = w; src.overview.height = hgt;
      drawOverviewWave(src.overview.getContext('2d'), src.data, look(src), w, hgt);
    }
    ctx2.drawImage(src.overview, 0, 0);
    const x = total ? Math.round(t / total * w) : 0;
    ctx2.fillStyle = 'rgba(0,0,0,0.45)'; ctx2.fillRect(0, 0, x, hgt);
    ctx2.fillStyle = '#ff5b92'; ctx2.fillRect(x - 1, 0, 2 * (window.devicePixelRatio || 1), hgt);
  }
  function drawLane(id, index, t, audible) {
    const lane = lanes.get(id), src = sources.get(id);
    if (!lane) return;
    const canvas = lane.canvas;
    fit(canvas);
    const c = canvas.getContext('2d'), w = canvas.width, hgt = canvas.height, dpr = window.devicePixelRatio || 1;
    c.clearRect(0, 0, w, hgt);
    if (!w) return;
    const binsPerPx = span() * BINS_PER_SECOND / w, startBin = t * BINS_PER_SECOND - w * PLAYHEAD * binsPerPx;
    const showGrid = grid && gridVisible;
    if (src?.data) drawWave(c, src.data, look(src), w, hgt, startBin - (src.offset || 0) * BINS_PER_SECOND, binsPerPx, 0.44);
    if (!showGrid) {
      const step = [1, 2, 5, 10, 15, 30, 60].find(s => s * BINS_PER_SECOND / binsPerPx >= 70 * dpr) || 60;
      c.font = `${10 * dpr}px -apple-system, sans-serif`;
      for (let s = Math.ceil(startBin / BINS_PER_SECOND / step) * step; ; s += step) {
        const x = Math.round((s * BINS_PER_SECOND - startBin) / binsPerPx) + 0.5;
        if (x > w) break;
        if (s < 0) continue;
        c.fillStyle = light ? 'rgba(0,0,0,.08)' : 'rgba(255,255,255,.07)'; c.fillRect(x, 0, 1, hgt);
      }
    }
    c.fillStyle = light ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.12)'; c.fillRect(0, hgt / 2, w, 1);
    if (!audible) { c.fillStyle = light ? 'rgba(236,235,230,.45)' : 'rgba(16,20,25,.5)'; c.fillRect(0, 0, w, hgt); }
    if (showGrid) {
      c.font = `${10 * dpr}px -apple-system, sans-serif`;
      const start = startBin / BINS_PER_SECOND;
      for (const beat of beatLines(start, start + span(), grid.bpm, grid.offset)) {
        const x = Math.round((beat.time - start) / span() * w);
        c.fillStyle = light ? (beat.downbeat ? 'rgba(20,28,32,.6)' : 'rgba(20,28,32,.18)') : (beat.downbeat ? 'rgba(183,244,226,.65)' : 'rgba(215,231,235,.2)');
        c.fillRect(x, 0, beat.downbeat ? 1.5 * dpr : dpr, hgt);
      }
    }
    shadeLoop(c, t, w, hgt, dpr);
    c.fillStyle = '#ff5b92'; c.fillRect(Math.round(w * PLAYHEAD), 0, Math.max(1, dpr), hgt);
  }
  const xOf = (time, t, w) => Math.round(((time - t) / span() + PLAYHEAD) * w);
  function shadeLoop(c, t, w, hgt, dpr) {
    if (!loop) return;
    const a = Math.max(0, xOf(loop.start, t, w)), b = Math.min(w, xOf(loop.end, t, w));
    if (b <= 0 || a >= w) return;
    // Blue tint over the loop, solid blue edges.
    c.fillStyle = looping ? (light ? 'rgba(40,110,230,.14)' : 'rgba(70,140,255,.16)') : (light ? 'rgba(40,110,230,.06)' : 'rgba(70,140,255,.06)');
    c.fillRect(a, 0, b - a, hgt);
    c.fillStyle = looping ? (light ? 'rgba(30,90,210,.9)' : 'rgba(110,170,255,.95)') : 'rgba(110,150,220,.4)';
    c.fillRect(a, 0, dpr, hgt); c.fillRect(b - dpr, 0, dpr, hgt);
  }
  // The bar ruler above the lanes: bar numbers (or seconds), the loop region, the playhead.
  const ruler = h('div', {class: 'ruler'}), rulerCanvas = h('canvas', {'aria-label': 'Bar ruler. Click to loop from the playhead, or drag to loop a span.'});
  ruler.appendChild(h('div', {class: 'ruler-head'})); ruler.appendChild(rulerCanvas);
  function drawRuler(t) {
    fit(rulerCanvas);
    const c = rulerCanvas.getContext('2d'), w = rulerCanvas.width, hgt = rulerCanvas.height, dpr = window.devicePixelRatio || 1;
    c.clearRect(0, 0, w, hgt);
    if (!w) return;
    c.font = `600 ${10 * dpr}px -apple-system, sans-serif`;
    const start = t - span() * PLAYHEAD;
    shadeLoop(c, t, w, hgt, dpr);
    if (grid) {
      const stride = beatLabelStride(w / dpr, span(), grid.bpm);
      for (const beat of beatLines(start, start + span(), grid.bpm, grid.offset)) {
        const x = xOf(beat.time, t, w);
        c.fillStyle = beat.downbeat ? (light ? 'rgba(20,28,32,.55)' : 'rgba(255,255,255,.45)') : (light ? 'rgba(20,28,32,.15)' : 'rgba(255,255,255,.15)');
        c.fillRect(x, beat.downbeat ? 0 : hgt * .6, dpr, beat.downbeat ? hgt : hgt * .4);
        if (beat.downbeat && (beat.bar - 1) % stride === 0) { c.fillStyle = light ? '#222a2b' : '#c9ced6'; c.fillText(String(beat.bar), x + 4 * dpr, hgt * .62); }
      }
    } else {
      for (let s = Math.max(0, Math.ceil(start)); s < start + span(); s++) {
        const x = xOf(s, t, w);
        c.fillStyle = light ? 'rgba(20,28,32,.3)' : 'rgba(255,255,255,.25)'; c.fillRect(x, hgt * .5, dpr, hgt * .5);
        if (s % 2 === 0) { c.fillStyle = light ? '#222a2b' : '#9a9aa2'; c.fillText(clock(s), x + 4 * dpr, hgt * .62); }
      }
    }
    c.fillStyle = '#ff5b92'; c.fillRect(Math.round(w * PLAYHEAD), 0, Math.max(1, dpr), hgt);
  }
  let rulerDrag = null;
  const timeAtRuler = clientX => {
    const r = rulerCanvas.getBoundingClientRect();
    return position() + ((clientX - r.left) / (r.width || 1) - PLAYHEAD) * span();
  };
  rulerCanvas.addEventListener('pointerdown', e => { if (!input) return; rulerDrag = {x: e.clientX, from: timeAtRuler(e.clientX)}; rulerCanvas.setPointerCapture?.(e.pointerId); });
  rulerCanvas.addEventListener('pointermove', e => {
    if (!rulerDrag || Math.abs(e.clientX - rulerDrag.x) < 4) return;
    rulerDrag.moved = true;
    loop = loopRegion(position(), rulerDrag.from, timeAtRuler(e.clientX), true, grid, length()) || loop; dirty = true; // live preview
  });
  rulerCanvas.addEventListener('pointerup', e => {
    if (!rulerDrag) return;
    const {from, moved} = rulerDrag; rulerDrag = null;
    setLoop(loopRegion(position(), from, timeAtRuler(e.clientX), Boolean(moved), grid, length()));
  });
  function render(now = 0) {
    if (playing && !looping && position() >= length()) { pause(); pausedPos = length(); }
    if (dirty || (playing && now - lastFrame >= 1000 / 30)) {
      lastFrame = now; dirty = false;
      // The playhead marks what is coming out of the speakers, not what was just scheduled.
      const t = playing ? Math.max(0, position() - (ctx.outputLatency || ctx.baseLatency || 0)) : position(), total = length(), audible = heard();
      $('time').textContent = clock(t);
      $('remaining').textContent = `-${clock(Math.max(0, total - t))}`;
      drawOverview(t, total);
      if (input) drawRuler(t);
      let index = 0;
      for (const id of SOURCES) if (lanes.has(id)) drawLane(id, index++, t, audible.has(id));
    }
    requestAnimationFrame(render);
  }

  // ---- Transport ----
  let scrubbing = false;
  const overviewSeek = e => { const r = $('overview').getBoundingClientRect(); seek((e.clientX - r.left) / (r.width || 1) * length()); };
  $('overview').addEventListener('pointerdown', e => { scrubbing = true; $('overview').setPointerCapture?.(e.pointerId); overviewSeek(e); });
  $('overview').addEventListener('pointermove', e => { if (scrubbing) overviewSeek(e); });
  $('overview').addEventListener('pointerup', () => { scrubbing = false; });
  $('play').addEventListener('click', togglePlay);
  const setZoom = next => { zoom = Math.max(0, Math.min(ZOOM_BARS.length - 1, next)); $('zoom').textContent = `${ZOOM_BARS[zoom]} bar${ZOOM_BARS[zoom] > 1 ? 's' : ''}`; dirty = true; };
  $('zoom-in').addEventListener('click', () => setZoom(zoom - 1));
  $('zoom-out').addEventListener('click', () => setZoom(zoom + 1));
  const setVolume = () => {
    volume = Number($('volume').value);
    if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.01);
    $('volume-value').textContent = `${Math.round(volume * 100)}%`;
    $('volume').style.setProperty('--fill', `${volume * 100}%`);
  };
  $('volume').addEventListener('input', setVolume);
  window.addEventListener?.('resize', () => { dirty = true; closeMenu(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeMenu(); settingsOpen(false); return; }
    if (['BUTTON', 'SELECT'].includes(e.target?.tagName) && e.code === 'Space') return;
    if (e.target?.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'radio') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); seek(position() + (e.key === 'ArrowLeft' ? -5 : 5)); }
    else if (/^[1-9]$/.test(e.key)) { const id = SOURCES.filter(s => sources.has(s))[Number(e.key) - 1]; if (id) listen(id, e.metaKey || e.ctrlKey); }
  });

  // ---- Controls and extraction ----
  function controls() {
    const none = selected.size === 0;
    addButton.disabled = busy;
    for (const id of ['choose-input', 'choose-output', 'save-to']) $(id).disabled = busy || choosing || !ready;
    for (const m of Object.keys(MODES)) $(`mode-${m}`).disabled = busy;
    $('extract').disabled = busy || choosing || !input || !output || !api || none || !ready;
    $('extract').classList.toggle('busy', busy);
    $('extract-label').textContent = busy ? 'Extracting…' : looping && loop ? 'Extract loop' : 'Extract';
    $('extract').title = none ? 'Add a stem first' : !input ? 'Open a track first' : '';
    $('cancel').hidden = !busy;
    $('cancel').disabled = cancelling;
    $('cancel').textContent = cancelling ? 'Cancelling…' : 'Cancel';
    $('reveal').hidden = !lastOutput || busy;
    const canPlay = [...heard()].length > 0;
    $('play').disabled = !canPlay && !playing;
  }
  function timing() {
    if (!lastStatus) return;
    const elapsed = Number(lastStatus.elapsed_seconds);
    $('elapsed').textContent = duration(Number.isFinite(elapsed) ? elapsed + (busy ? (performance.now() - receivedAt) / 1000 : 0) : null);
    $('eta').textContent = lastStatus.status === 'complete' ? 'Done' : busy ? (lastStatus.eta_seconds == null ? 'Estimating…' : `~ ${duration(Math.max(1, lastStatus.eta_seconds - (performance.now() - receivedAt) / 1000))}`) : '—';
  }
  function feedback(status) {
    if (!status || typeof status !== 'object') return;
    lastStatus = status; receivedAt = performance.now();
    busy = status.status === 'running';
    if (!busy) cancelling = false;
    const value = status.status === 'complete' ? 100 : percent(status.progress);
    const measurable = !busy || status.stage === 'separating' || status.stage === 'exporting';
    $('feedback').className = `status-bar ${['running', 'complete', 'cancelled', 'error'].includes(status.status) ? status.status : 'idle'}`;
    $('stage').textContent = status.status === 'complete' ? 'Stems ready' : status.status === 'cancelled' ? 'Cancelled' : status.status === 'error' ? 'Couldn’t finish' : status.status === 'idle' ? 'Ready' : stageLabel(status.stage);
    if (measurable) { $('progress').value = value; $('progress').textContent = `${value}%`; }
    else $('progress').removeAttribute('value');
    $('percentage').textContent = measurable && status.status !== 'idle' ? `${value}%` : '';
    $('message').textContent = status.message || '';
    if (status.status === 'complete' && status.output_path) {
      lastOutput = status.output_path;
      const files = (status.files || []).filter(sourceOf);
      for (const path of files) addSource(sourceOf(path), path, extractRegion?.start || 0);
      if (files.length) $('message').textContent = `${files.length} file${files.length > 1 ? 's' : ''} saved. Click a lane to listen, ⌘-click to combine.`;
    }
    timing(); controls(); showLanes();
  }
  function fail(error) {
    feedback({status: 'error', stage: 'error', progress: lastStatus?.progress || 0, elapsed_seconds: lastStatus?.elapsed_seconds || 0, eta_seconds: null, message: String(error?.message || error)});
  }
  function dropOutputs() {
    for (const id of [...OUTPUTS, 'remainder']) {
      const src = sources.get(id);
      if (!src) continue;
      stopVoice(id); mix.delete(id); muted.delete(id); soloed.delete(id);
      if (src.path !== sources.get('original')?.path) waveCache.delete(src.path);
      sources.delete(id);
    }
    if (!mix.size && sources.has('original')) mix.add('original');
    mixChanged();
  }
  function loadTrack(path) {
    if (playing) pause();
    stopVoices(); pausedPos = 0;
    input = path; lastOutput = '';
    $('meta-line').hidden = false;
    $('input-name').textContent = trackTitle(path); $('input-name').title = path; $('length').textContent = '—';
    if (!outputChosen) output = dirname(path);
    showOutput(); fileSettingsChanged();
    sources.clear(); waveCache.clear(); mix.clear(); muted.clear(); soloed.clear();
    grid = null; gridManual = false; loop = null; looping = false; loopChanged();
    addSource('original', path); mix.add('original'); mixChanged();
    detectBeats(path);
    if (!busy) feedback({status: 'idle', progress: 0, elapsed_seconds: NaN, message: ''});
    showCover(path);
    selectionChanged();
  }
  async function showCover(path) {
    if (artUrl) { URL.revokeObjectURL?.(artUrl); artUrl = ''; }
    $('art-img').hidden = true; $('choose-input').classList.remove('has-art');
    try {
      const bytes = new Uint8Array(await api.core.invoke('cover_art', {path}));
      if (!bytes.length || input !== path) return;
      artUrl = URL.createObjectURL(new Blob([bytes], {type: bytes[0] === 0x89 ? 'image/png' : 'image/jpeg'}));
      $('art-img').src = artUrl; $('art-img').hidden = false; $('choose-input').classList.add('has-art');
    } catch (error) { console.warn(error); }
  }
  async function choose(kind) {
    choosing = true; controls();
    try {
      const path = await api.core.invoke(kind === 'input' ? 'choose_input' : 'choose_output');
      if (!path) return;
      if (kind === 'output') { output = path; outputChosen = true; showOutput(); return; }
      loadTrack(path);
    } catch (error) { fail(error); }
    finally { choosing = false; controls(); }
  }
  // The loop in a lane's own file time (a loop-extracted stem starts at its loop).
  const fileRange = src => ({start: Math.max(0, loop.start - (src.offset || 0)), end: Math.min(src.buffer?.duration ?? Infinity, loop.end - (src.offset || 0))});
  async function exportLoop() {
    if (!loop) return;
    const parts = SOURCES.filter(id => sources.has(id)).map(id => ({path: sources.get(id).path, ...fileRange(sources.get(id))})).filter(p => p.end > p.start);
    try {
      const folder = await api.core.invoke('export_loop', {parts, label: loopLabel(loop, grid)});
      if (folder) $('message').textContent = `Saved ${parts.length} loop file${parts.length > 1 ? 's' : ''} to ${filename(folder)}`;
    } catch (error) { $('message').textContent = String(error?.message || error); }
  }
  async function exportStem(id, onlyLoop = false) {
    const src = sources.get(id);
    if (!src) return;
    try {
      const range = onlyLoop && loop ? {...fileRange(src), label: loopLabel(loop, grid)} : {};
      const saved = await api.core.invoke('export_stem', {path: src.path, ...range});
      if (saved) $('message').textContent = `Saved ${filename(saved)}`;
    } catch (error) { $('message').textContent = String(error?.message || error); }
  }
  $('choose-input').addEventListener('click', () => choose('input'));
  $('choose-output').addEventListener('click', () => choose('output'));
  $('save-to').addEventListener('click', () => choose('output'));
  $('extract').addEventListener('click', async () => {
    if (busy || !input || !output || !selected.size) return;
    lastOutput = ''; cancelling = false;
    dropOutputs();
    feedback({status: 'running', stage: 'Preparing audio', progress: 0, elapsed_seconds: 0, eta_seconds: null, message: 'Starting. Time left appears once speed is known.'});
    // With a loop on, only that section is separated: much faster, and the stems land at the loop.
    extractRegion = looping && loop ? {...loop} : null;
    const region = extractRegion ? {start: extractRegion.start, end: extractRegion.end, tag: loopLabel(extractRegion, grid)} : {};
    try { await api.core.invoke('start_extraction', {input, output, outputs: OUTPUTS.filter(id => selected.has(id)), mode: mode(), remainder, naming, subfolder, ...region}); }
    catch (error) { fail(error); }
  });
  $('cancel').addEventListener('click', async () => {
    if (!busy || cancelling) return;
    cancelling = true; controls(); $('message').textContent = 'Stopping and cleaning up…';
    try { await api.core.invoke('cancel_extraction'); }
    catch (error) { cancelling = false; $('message').textContent = `Couldn’t cancel: ${String(error)}`; controls(); }
  });
  $('reveal').addEventListener('click', async () => {
    try { await api.core.invoke('reveal_output', {path: lastOutput}); }
    catch (error) { $('message').textContent = `Couldn’t open Finder: ${String(error)}`; }
  });

  // ---- First run: install Python, FFmpeg and the models into the app's support folder ----
  async function ensureRuntime() {
    ready = await api.core.invoke('runtime_status');
    if (ready) { controls(); return; }
    $('retry-setup').hidden = true;
    feedback({status: 'running', stage: 'Setting up', progress: 0, elapsed_seconds: 0, eta_seconds: null, message: 'First launch: downloading what separation needs (about 1.3 GB, once).'});
    try {
      await api.core.invoke('setup_runtime');
      ready = true;
      feedback({status: 'idle', progress: 0, elapsed_seconds: NaN, message: ''});
      $('stage').textContent = 'Ready'; $('message').textContent = 'Open a track or drop one on the window.';
      $('feedback').className = 'status-bar complete';
    } catch (error) {
      fail(error); $('retry-setup').hidden = false;
    }
    controls();
  }
  $('retry-setup').addEventListener('click', ensureRuntime);

  setVolume(); setZoom(zoom); fileSettingsChanged(); showOutput(); selectionChanged(); gridChanged(''); requestAnimationFrame(render);
  if (!api) { $('message').textContent = 'Open StemWave Extract.app to use this.'; controls(); return; }
  try {
    await api.event.listen('extraction-progress', event => feedback(event.payload));
    await api.event.listen('setup-progress', event => {
      const step = String(event.payload).match(/^STEP (\d+)\/(\d+) (.*)$/);
      if (!step) return;
      const value = Math.round((step[1] - 1) / step[2] * 100);
      $('progress').value = value; $('percentage').textContent = `${value}%`;
      $('message').textContent = `${step[3]} · step ${step[1]} of ${step[2]}`;
    });
    // Files dropped anywhere on the window open as the track.
    await api.event.listen('tauri://drag-enter', () => { if (!busy) $('drop-overlay').hidden = false; });
    await api.event.listen('tauri://drag-leave', () => { $('drop-overlay').hidden = true; });
    await api.event.listen('tauri://drag-drop', async event => {
      $('drop-overlay').hidden = true;
      const path = event.payload?.paths?.[0];
      if (!path) return;
      if (!ready) return;
      if (busy) { $('message').textContent = 'Wait for the extraction to finish before opening another track.'; return; }
      try { loadTrack(await api.core.invoke('open_audio', {path})); } catch (error) { $('message').textContent = String(error?.message || error); }
    });
    await ensureRuntime();
    const status = await api.core.invoke('get_status');
    if (status && status.status === 'running') feedback(status);
  } catch (error) { fail(error); }
  controls(); setInterval(timing, 1000);
}
