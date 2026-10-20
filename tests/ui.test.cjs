const assert = require('node:assert/strict');
const {duration, clock, percent, filename, dirname, stageLabel, exportPlan, sourceOf, trackPeak, bandPeaks, rgbForBands, drawWave, PRESETS, OUTPUTS, estimateBeatGrid, beatLines, beatLabelStride, audibleIds, parseBpm, snapToBeat, snapToBar, loopRegion, loopLabel, normalizeGrid} = require('../ui/app.js');
assert.equal(duration(null), '—'); assert.equal(duration(NaN), '—'); assert.equal(duration(-1), '—');
assert.equal(duration(0), '0s'); assert.equal(duration(60), '1m 0s'); assert.equal(duration(3601), '1h 0m');
assert.equal(clock(0), '00:00'); assert.equal(clock(204.9), '03:24'); assert.equal(clock(3725), '1:02:05'); assert.equal(clock(NaN), '00:00');
assert.equal(percent(-1), 0); assert.equal(percent(2), 100); assert.equal(percent(NaN), 0); assert.equal(percent(.425), 43);
assert.equal(filename('/Music/My track.wav'), 'My track.wav'); assert.equal(dirname('/Music/My track.wav'), '/Music');
assert.equal(stageLabel('loading_model'), 'Loading model');
// Selection combinations mirror worker.plan().
// Selection mirrors worker.plan(): a stem alone unless "everything else" is asked for.
assert.deepEqual(exportPlan([]), []);
assert.deepEqual(exportPlan(['drums']), ['Drums'], 'a stem can be extracted by itself');
assert.deepEqual(exportPlan(['acapella']), ['Acapella']);
assert.deepEqual(exportPlan(['instrumental']), ['Instrumental']);
assert.deepEqual(exportPlan(['acapella'], true), ['Acapella', 'Everything but Vocals']);
assert.deepEqual(exportPlan(['instrumental'], true), ['Instrumental', 'Everything but Bass and Drums and Other and Guitar and Piano']);
assert.deepEqual(exportPlan(['acapella', 'instrumental'], true), ['Acapella', 'Instrumental']);
assert.deepEqual(exportPlan(['acapella', 'vocals'], true), ['Acapella', 'Everything but Vocals']);
assert.deepEqual(exportPlan(['vocals', 'drums'], true), ['Drums', 'Vocals', 'Everything but Drums and Vocals']);
assert.equal(exportPlan(OUTPUTS, true).length, 7);
assert.equal(sourceOf('/x/Stems/Acapella.wav'), 'acapella'); assert.equal(sourceOf('/x/Extraction.json'), null);
// Records are [peak, rms, r, g, b, low, mid, high]: sqrt-encoded levels, six-band colour, plug-in bands.
assert.equal(trackPeak(new Uint8Array([255, 200, 1, 2, 3, 0, 0, 0, 128, 90, 1, 2, 3, 0, 0, 0])), 1);
assert.ok(Math.abs(trackPeak(new Uint8Array([128, 90, 0, 0, 0, 0, 0, 0])) - (128 / 255) ** 2) < 1e-9);
assert.equal(trackPeak(new Uint8Array(16)), .01, 'silence keeps the spec floor');
assert.deepEqual(Object.keys(PRESETS), ['spectral', 'rgb', 'mono']);
{
  const pk = bandPeaks(new Uint8Array([255, 0, 0, 0, 0, 200, 200, 200]));
  const [r, g, b] = rgbForBands(200, 0, 0, pk), [r2, , b2] = rgbForBands(0, 0, 200, pk);
  assert.ok(r > 200 && g < 20 && b < 20, 'RGB DJ: bass is red');
  assert.ok(b2 > 200 && r2 < 20, 'RGB DJ: highs are blue');
}
// Lane pixels for each look: spectral edge + white-blended RMS core, RGB DJ without core, mono.
{
  let image = null, blits = 0;
  const sctx = {createImageData: (w, h) => ({data: new Uint8ClampedArray(w * h * 4)}), putImageData: i => { image = i; }};
  globalThis.document = {createElement: () => ({getContext: () => sctx})};
  const data = new Uint8Array([255, 128, 200, 40, 10, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const base = {peak: 1, bands: bandPeaks(data), coreColour: [255, 255, 255, .18], mono: [101, 223, 176]};
  const pixel = (x, y) => Array.from(image.data.slice((y * 2 + x) * 4, (y * 2 + x) * 4 + 4));
  drawWave({drawImage: () => blits++}, data, {...base, colour: 'spectral', core: true}, 2, 20, 0, 1, .25);
  assert.deepEqual(pixel(0, 5), [200, 40, 10, 255], 'peak edge keeps the spectral colour');
  assert.deepEqual(pixel(0, 10), [210, 79, 54, 255], 'RMS core is blended 18% toward white');
  assert.deepEqual(pixel(0, 0), [0, 0, 0, 0], 'outside the peak stays transparent');
  assert.deepEqual(pixel(1, 9), [0, 0, 0, 255], 'silent bin keeps a hairline');
  drawWave({drawImage: () => blits++}, data, {...base, colour: 'rgb', core: false}, 2, 20, 0, 1, .25);
  assert.deepEqual(pixel(0, 10), pixel(0, 5), 'no core in RGB DJ');
  assert.ok(pixel(0, 5)[0] > 200 && pixel(0, 5)[2] < 30, 'RGB DJ bass bin is red');
  drawWave({drawImage: () => blits++}, data, {...base, colour: 'mono', core: false, peak: 4}, 2, 20, 0, 1, .25);
  assert.deepEqual(pixel(0, 9), [101, 223, 176, 255], 'mono colour');
  assert.deepEqual(pixel(0, 7), [0, 0, 0, 0], 'a larger shared peak draws the bar shorter');
  assert.equal(blits, 3);
  delete globalThis.document;
}
// A quantised pulse train must recover tempo and phase without inventing beats in silence.
assert.equal(estimateBeatGrid(new Uint8Array(1000 * 8)), null);
for (const bpm of [90, 120, 128, 174]) {
  const binsPerSecond = 44100 / 160, data = new Uint8Array(Math.floor(binsPerSecond * 30) * 8);
  for (let t = .2; t < 30; t += 60 / bpm) data[Math.round(t * binsPerSecond) * 8] = 255;
  const grid = estimateBeatGrid(data);
  assert.ok(Math.abs(grid.bpm - bpm) < .1, `pulse tempo ${bpm}: ${grid.bpm}`);
  assert.ok(Math.abs(grid.offset - .2) < 512 / 44100);
}
assert.deepEqual(beatLines(-1, 2.2, 120, .2).map(b => [Number(b.time.toFixed(1)), b.downbeat]), [[.2, true], [.7, false], [1.2, false], [1.7, false], [2.2, true]]);
assert.equal(beatLabelStride(620, 64, 128), 4, 'wide zoom keeps bar labels at least 45 CSS pixels apart');
assert.equal(beatLabelStride(620, 16, 128), 1);
assert.deepEqual(beatLines(0, 10, 0, 0), []);
assert.deepEqual(beatLines(0, 10, NaN, 0), []);
assert.equal(beatLines(0, 2, 120, 2)[0].bar, 0, 'beats before aligned bar one remain correctly numbered');
assert.deepEqual(exportPlan(['drums'], true), ['Drums', 'Everything but Drums']);
assert.deepEqual(exportPlan(['bass', 'drums'], true), ['Bass', 'Drums', 'Everything but Bass and Drums']);
assert.equal(sourceOf('/Music/Puerto Rico (The Original Mix) (Drums).wav'), 'drums');
assert.equal(sourceOf('/Music/Puerto Rico (The Original Mix) (Everything but Drums).wav'), 'remainder');
assert.equal(sourceOf('/Music/Track (Everything but Unknown).wav'), null);
console.log('UI format, selection, peak and beat-grid checks passed');

// Solo/mute/mix: solo wins over the mix, mute wins over everything, unloaded lanes are never heard.
{
  const S = (...a) => new Set(a), all = ['original', 'vocals', 'drums', 'bass'];
  assert.deepEqual([...audibleIds(all, S('original'), S(), S())], ['original']);
  assert.deepEqual([...audibleIds(all, S('vocals', 'drums'), S(), S())], ['vocals', 'drums'], 'cmd-click combines');
  assert.deepEqual([...audibleIds(all, S('vocals', 'drums'), S('drums'), S())], ['vocals'], 'mute');
  assert.deepEqual([...audibleIds(all, S('original'), S(), S('bass'))], ['bass'], 'solo overrides the mix');
  assert.deepEqual([...audibleIds(all, S('original'), S('bass'), S('bass'))], [], 'muted solo stays silent');
  assert.deepEqual([...audibleIds(['original'], S('original', 'drums'), S(), S('drums'))], ['original'], 'solo on an unloaded lane is ignored');
}
assert.equal(parseBpm('128'), 128); assert.equal(parseBpm(' 99,5 '), 99.5); assert.equal(parseBpm('30'), null); assert.equal(parseBpm('abc'), null);
// Loops snap to beats: 120 BPM, bar one at 0.5 s (beats every 0.5 s, bars every 2 s).
{
  const g = {bpm: 120, offset: 0.5}, near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(snapToBeat(1.74, g), 1.5) && near(snapToBeat(1.76, g), 2.0) && near(snapToBeat(0.13, null), 0.25));
  assert.ok(near(snapToBar(3.4, g), 2.5) && near(snapToBar(3.6, g), 4.5) && near(snapToBar(1.4, null), 1), 'bar lines every 2 s from 0.5 s');
  const click = loopRegion(4.1, 9.0, 9.0, false, g, 60);
  assert.ok(near(click.start, 4.0) && near(click.end, 9.0), 'click: playhead to clicked beat');
  const back = loopRegion(9.1, 4.0, 4.3, false, g, 60);
  assert.ok(near(back.start, 4.5) && near(back.end, 9.0), 'click before the playhead loops back to it');
  const tiny = loopRegion(4.0, 4.1, 4.1, false, g, 60);
  assert.ok(near(tiny.start, 4.0) && near(tiny.end, 6.0), 'a click at the playhead loops one bar');
  const drag = loopRegion(0, 6.6, 2.4, true, g, 60);
  assert.ok(near(drag.start, 2.5) && near(drag.end, 6.5), 'drag loops the span, either direction');
  assert.ok(near(loopRegion(59, 59, 59, false, g, 60).end, 60), 'clamped to the track');
  assert.equal(loopLabel({start: 2.5, end: 10.5}, g), 'bars 2-5');
  assert.equal(loopLabel({start: 2.5, end: 4.5}, g), 'bar 2');
  assert.equal(loopLabel({start: 3.2, end: 7.9}, null), '3-8 sec');
  assert.ok(near(normalizeGrid({bpm: 120, offset: 50.5}).offset, 0.5) && near(normalizeGrid({bpm: 120, offset: -1.5}).offset, 0.5), 'downbeat keeps phase, bars count from 0 s');
}
console.log('UI selection, solo/mute, BPM parsing and loop checks passed');

// ---- Lifecycle with a fake DOM, Web Audio and backend ----
const vm = require('node:vm');
const fs = require('node:fs');
class El {
  constructor(tag, id) {
    Object.assign(this, {tagName: tag.toUpperCase(), id, children: [], parentElement: null, attrs: {}, handlers: {}, style: {setProperty() {}},
      textContent: '', value: '', checked: false, disabled: false, hidden: false, title: '', width: 0, height: 0, clientWidth: 400, clientHeight: 80});
    const classes = new Set();
    this.classList = {toggle: (c, on) => (on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c), add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c)};
  }
  set className(v) { v.split(' ').forEach(c => this.classList.add(c)); }
  get firstChild() { return this.children[0]; }
  insertBefore(c, ref) { if (!ref) return this.appendChild(c); c.parentElement?.children.splice(c.parentElement.children.indexOf(c), 1); c.parentElement = this; this.children.splice(this.children.indexOf(ref), 0, c); return c; }
  appendChild(c) { c.parentElement?.children.splice(c.parentElement.children.indexOf(c), 1); c.parentElement = this; this.children.push(c); return c; }
  remove() { if (this.parentElement) { this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; } }
  contains(n) { return n === this || this.children.some(c => c.contains(n)); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; if (k === 'value') this.value = undefined; }
  addEventListener(e, f) { (this.handlers[e] ||= []).push(f); }
  async fire(e, arg = {}) { for (const f of this.handlers[e] || []) await f({target: this, preventDefault() {}, clientX: 10, clientY: 10, pointerId: 1, ...arg}); }
  querySelector(sel) { return this.all().find(n => n !== this && n.tagName === sel.toUpperCase()); }
  all() { return [this, ...this.children.flatMap(c => c.all())]; }
  find(fn) { return this.all().find(fn); }
  getContext() { return ctx2d; }
  getBoundingClientRect() { return {left: 0, bottom: 20, width: 400}; }
  setPointerCapture() {} focus() {} blur() {}
}
const ctx2d = new Proxy({createImageData: (w, h) => ({data: new Uint8ClampedArray(w * h * 4)})}, {get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; }});
const byId = new Map(), body = new El('body'), docHandlers = {};
const $ = id => { if (!byId.has(id)) { const el = new El('div', id); new El('label').appendChild(el); byId.set(id, el); if (id.startsWith('mode-')) el.tagName = 'INPUT'; } return byId.get(id); };
$('mode-fast').checked = true; $('volume').value = '0.9';
$('play-icon').appendChild(new El('use'));
const document = {getElementById: $, createElement: t => new El(t), createElementNS: (_, t) => new El(t), body, documentElement: new El('html'),
  addEventListener: (e, f) => { (docHandlers[e] ||= []).push(f); }};
const voices = [];
class FakeAudio {
  constructor() { this.currentTime = 0; this.destination = {}; }
  createGain() { return {gain: {value: 1, setTargetAtTime(v) { this.value = v; }}, connect() {}, disconnect() {}}; }
  createBufferSource() { const v = {connect() {}, disconnect() {}, start(_, off) { this.offset = off; }, stop() { this.stopped = true; }}; voices.push(v); return v; }
  async decodeAudioData() { return {duration: 200}; }
  resume() {}
}
const calls = [], listeners = {};
let startError = null, runtimeReady = false, setupFails = true, setupProgress = '';
const api = {core: {
  convertFileSrc: p => `asset://localhost/${encodeURIComponent(p)}`,
  async invoke(name, args) {
    calls.push([name, args]);
    if (name === 'runtime_status') return runtimeReady;
    if (name === 'setup_runtime') { listeners['setup-progress']({payload: 'STEP 3/5 Downloading the separation model (700 MB)'}); setupProgress = $('message').textContent; if (setupFails) { setupFails = false; throw new Error('Setup failed: no connection'); } runtimeReady = true; return null; }
    if (name === 'choose_input') return '/Music/Track.mp3';
    if (name === 'choose_output') return '/Music/Exports';
    if (name === 'analyze_waveform') return new Uint8Array(1378 * 8).fill(128).buffer;
    if (name === 'analyze_beats') return {bpm: 128, offset: 0.5, confidence: 0.9};
    if (name === 'open_audio') return args.path;
    if (name === 'cover_art') return new Uint8Array([0xff, 0xd8, 0xff]).buffer;
    if (name === 'export_stem') return '/tmp/export/Track (Drums).wav';
    if (name === 'export_loop') return '/tmp/export';
    if (name === 'start_extraction' && startError) throw new Error(startError);
    return null;
  }},
  event: {async listen(name, handler) { listeners[name] = handler; }}};
const flush = () => new Promise(setImmediate);
vm.runInNewContext(fs.readFileSync(require.resolve('../ui/app.js'), 'utf8'), {document, window: {__TAURI__: api, devicePixelRatio: 2, AudioContext: FakeAudio, addEventListener() {}, localStorage: (() => { const m = new Map(); return {getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k)}; })()},
  fetch: async () => ({ok: true, arrayBuffer: async () => new ArrayBuffer(8)}), performance: {now: () => 0}, setInterval: () => {}, requestAnimationFrame: () => {},
  URL: {createObjectURL: () => 'blob:art', revokeObjectURL() {}}, Blob, module: {exports: {}}, console});
const lane = name => $('lanes').children.find(l => l.find(n => n.classList.contains('lane-name') && n.textContent === name));
const part = (l, cls) => l.find(n => n.classList.contains(cls));
(async () => {
  await flush(); await flush();
  // First launch: setup runs automatically; a failure offers Try again; opening waits until ready.
  assert.match(setupProgress, /Downloading the separation model .* step 3 of 5/);
  assert.equal($('stage').textContent, 'Couldn’t finish'); assert.equal($('retry-setup').hidden, false);
  assert.equal($('choose-input').disabled, true, 'nothing to open until setup is done');
  await $('retry-setup').fire('click'); await flush();
  assert.equal($('stage').textContent, 'Ready'); assert.equal($('choose-input').disabled, false);
  assert.equal($('extract').disabled, true);
  // Load: original lane, beats from the backend, playable once decoded.
  await $('choose-input').fire('click'); await flush(); await flush();
  assert.ok(lane('Original'));
  assert.equal($('bpm-readout').textContent, '128 BPM'); assert.equal($('grid-bpm').value, '128');
  assert.equal($('play').disabled, false);
  assert.equal($('now-source').textContent, 'Original');
  assert.equal($('art-img').src, 'blob:art'); assert.equal($('art-img').hidden, false, 'embedded cover art shown');
  await $('play').fire('click');
  assert.equal(voices.length, 1); assert.equal(voices[0].offset, 0);
  await $('play').fire('click'); assert.ok(voices[0].stopped, 'pause stops voices');
  // Selection: nothing by default; one "+ Add stem" row under the lanes opens the menu.
  const addStem = () => $('lanes').find(n => n.attrs.id === 'add-stem');
  const openAdd = async () => { await addStem().fire('click'); const m = body.children.at(-1); return {menu: m, labels: m.children.filter(c => c.tagName === 'BUTTON').map(c => c.textContent)}; };
  const pick = async label => { const {menu} = await openAdd(); await menu.children.find(c => c.textContent === label).fire('click'); return menu; };
  assert.equal($('lanes').children.length, 3, 'ruler, Original and the add row only');
  assert.equal($('extract').disabled, true, 'nothing to extract yet');
  let {labels} = await openAdd();
  assert.deepEqual(labels, ['Acapella', 'Instrumental', 'Vocals', 'Drums', 'Bass', 'Guitar', 'Piano', 'Other', 'All remaining stems', 'Everything else']);
  docHandlers.pointerdown.forEach(f => f({target: body}));
  const menu = await pick('Acapella');
  assert.equal(body.children.includes(menu), false, 'menu closes on pick');
  assert.equal(part(lane('Acapella'), 'lane-state').textContent, 'Ready to extract');
  ({labels} = await openAdd());
  assert.ok(!labels.includes('Acapella') && !labels.includes('Vocals') && labels.includes('Drums'), 'covered stems are hidden');
  docHandlers.pointerdown.forEach(f => f({target: body}));
  await pick('Drums');
  await pick('Everything else');
  assert.ok(lane('Everything but Drums and Vocals'));
  await part(lane('Everything but Drums and Vocals'), 'remove').fire('click');
  assert.ok(!lane('Everything but Drums and Vocals'), 'pending mix can be removed');
  await pick('Everything else');
  // Original minimises once stems are shown.
  await part(lane('Original'), 'fold').fire('click');
  assert.ok(lane('Original').classList.contains('collapsed'));
  await part(lane('Original'), 'fold').fire('click');
  assert.ok(!lane('Original').classList.contains('collapsed'));
  // Theme lives in settings now; the save folder is back in the bottom bar.
  await $('theme-light').fire('change'); assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
  await $('theme-dark').fire('change'); assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal($('save-to-name').textContent, 'Music');
  await $('save-to').fire('click'); await flush(); assert.equal(calls.at(-1)[0], 'choose_output');
  assert.equal($('save-to-name').textContent, 'Exports');
  // Settings: opens from the gear, waveform style by radio, closes on Escape.
  await $('settings-toggle').fire('click'); assert.equal($('settings').hidden, false);
  await $('wave-rgb').fire('change');
  assert.equal($('wave-rgb').checked, true);
  docHandlers.keydown.forEach(f => f({key: 'Escape', target: body, preventDefault() {}}));
  assert.equal($('settings').hidden, true);
  // File settings: name pattern and folder-per-extraction travel with the extraction.
  $('naming-paren').checked = false; $('naming-dash').checked = true; await $('naming-dash').fire('change');
  assert.equal($('naming-example').textContent, 'e.g. Track - Drums.wav, in a new folder');
  await $('subfolder').fire('click');
  assert.equal($('subfolder').getAttribute('aria-pressed'), 'false');
  assert.equal($('naming-example').textContent, 'e.g. Track - Drums.wav');
  // Zoom counts bars.
  assert.equal($('zoom').textContent, '8 bars'); await $('zoom-in').fire('click'); await $('zoom-in').fire('click'); await $('zoom-in').fire('click'); await $('zoom-in').fire('click');
  assert.equal($('zoom').textContent, '1 bar');
  // Extract with Quality and the remainder.
  $('mode-fast').checked = false; $('mode-quality').checked = true;
  await $('extract').fire('click');
  const start = calls.filter(([n]) => n === 'start_extraction').at(-1)[1];
  assert.deepEqual(JSON.parse(JSON.stringify(start)), {input: '/Music/Track.mp3', output: '/Music/Exports', outputs: ['acapella', 'drums'], mode: 'quality', remainder: true, naming: 'dash', subfolder: false});
  assert.equal(addStem().disabled, true, 'selection locked while extracting');
  listeners['extraction-progress']({payload: {status: 'running', stage: 'loading', progress: .08, elapsed_seconds: 3, eta_seconds: null, message: 'Loading'}});
  assert.equal($('progress').value, undefined, 'indeterminate before speed is known');
  const files = ['Acapella', 'Drums', 'Everything but Drums and Vocals'].map(n => `/Music/Track - Stems x/Track (${n}).wav`);
  listeners['extraction-progress']({payload: {status: 'complete', progress: 1, elapsed_seconds: 20, output_path: '/Music/Track - Stems x', message: 'Saved', files}});
  await flush(); await flush();
  assert.equal($('stage').textContent, 'Stems ready'); assert.equal($('reveal').hidden, false);
  const afterMenu = (await openAdd()).labels;
  assert.ok(!afterMenu.includes('Drums') && !afterMenu.includes('Vocals') && afterMenu.includes('Bass'), 'extracted stems are not offered again');
  docHandlers.pointerdown.forEach(f => f({target: body}));
  // Listen, combine, mute, solo. Voices for every loaded lane; only heard ones have gain.
  await $('play').fire('click');
  await part(lane('Drums'), 'lane-pick').fire('click'); await flush(); await flush();
  assert.equal($('now-source').textContent, 'Drums');
  await part(lane('Acapella'), 'lane-pick').fire('click', {metaKey: true}); await flush(); await flush();
  assert.equal($('now-source').textContent, 'Acapella + Drums', '⌘-click combines');
  await part(lane('Drums'), 'mute').fire('click');
  assert.equal($('now-source').textContent, 'Acapella');
  await part(lane('Original'), 'solo').fire('click');
  assert.equal($('now-source').textContent, 'Original', 'solo overrides the mix');
  await part(lane('Original'), 'solo').fire('click'); await part(lane('Drums'), 'mute').fire('click');
  assert.equal($('now-source').textContent, 'Acapella + Drums');
  // Bar ruler: a click loops from the playhead (snapped) and turns loop mode on; the loop button toggles it.
  const rulerCanvas = $('lanes').children[0].children[1];
  assert.equal($('lanes').children[0].classList.contains('ruler'), true, 'ruler sits above the lanes');
  await rulerCanvas.fire('pointerdown', {clientX: 300}); await rulerCanvas.fire('pointerup', {clientX: 300});
  assert.equal($('loop').hidden, false, 'loop icon appears beside Play once a loop is set');
  assert.match($('loop').title, /^Loop bar/);
  await $('loop').fire('click'); assert.equal($('loop').hidden, true, 'clicking it ends the loop');
  await rulerCanvas.fire('pointerdown', {clientX: 300}); await rulerCanvas.fire('pointerup', {clientX: 300});
  assert.equal($('loop').hidden, false);
  assert.ok(voices.at(-1).loop, 'voices loop natively while playing');
  await lane('Drums').fire('contextmenu');
  const loopMenu = body.children.at(-1).children.map(c => c.textContent);
  assert.equal(loopMenu.length, 3); assert.match(loopMenu[1], /^Export Drums, bar/); assert.match(loopMenu[2], /of all lanes…$/);
  await body.children.at(-1).children[2].fire('click'); await flush();
  const exp = calls.at(-1);
  assert.equal(exp[0], 'export_loop'); assert.equal(exp[1].parts.length, 4, 'original plus the three stems');
  assert.ok(exp[1].parts.every(p => p.end > p.start));
  await lane('Drums').fire('contextmenu'); await body.children.at(-1).children[1].fire('click'); await flush();
  assert.equal(calls.at(-1)[0], 'export_stem'); assert.ok(calls.at(-1)[1].start >= 0 && calls.at(-1)[1].label);
  await $('loop').fire('click');
  // Clicking the bar count loops that many bars (8 bars at 128 BPM = 15 s) from the playhead.
  for (let i = 0; i < 3; i++) await $('zoom-out').fire('click');
  assert.equal($('zoom').textContent, '8 bars');
  await $('zoom').fire('click');
  assert.equal($('loop').hidden, false); assert.match($('loop').title, /^Loop bars \d+-\d+$/);
  const [first, last] = $('loop').title.match(/(\d+)-(\d+)/).slice(1).map(Number);
  assert.equal(last - first + 1, 8, 'eight bars');
  assert.equal($('extract-label').textContent, 'Extract loop');
  // Half / double tempo, in the main row.
  await $('tempo-half').fire('click'); assert.equal($('bpm-readout').textContent, '64 BPM'); assert.equal($('tempo-value').textContent, '64 BPM');
  await $('tempo-double').fire('click'); assert.equal($('bpm-readout').textContent, '128 BPM');
  // Double-click the tempo to type one.
  await $('tempo-value').fire('dblclick');
  const tempoField = $('tempo-value').parentElement.find(n => n.classList.contains('tempo-edit'));
  assert.ok(tempoField && $('tempo-value').hidden);
  tempoField.value = '100'; await tempoField.fire('keydown', {key: 'Enter'});
  assert.equal($('tempo-value').textContent, '100 BPM'); assert.equal($('tempo-value').hidden, false);
  $('grid-bpm').value = '128'; await $('grid-bpm').fire('change');
  // Downbeat puts a bar line at the playhead.
  await $('downbeat').fire('click');
  assert.match($('loop').title, /^Loop bars? \d/);
  // Extracting while looping separates only the loop; the new stem sits at the loop on the timeline.
  await $('extract').fire('click');
  const regionCall = calls.filter(([n]) => n === 'start_extraction').at(-1)[1];
  assert.ok(regionCall.end > regionCall.start && /^bars \d+-\d+$/.test(regionCall.tag), 'region and label sent');
  listeners['extraction-progress']({payload: {status: 'complete', progress: 1, elapsed_seconds: 3, output_path: '/Music/Track - Stems y', message: 'Saved',
    files: [`/Music/Track - Stems y/Track (${regionCall.tag}) (Drums).wav`]}});
  await flush(); await flush();
  const before = voices.length;
  await part(lane('Drums'), 'lane-pick').fire('click'); await flush(); await flush();
  assert.ok(voices.length > before, 'region stem plays');
  await $('loop').fire('click');
  assert.equal($('extract-label').textContent, 'Extract');
  // Restore the full-track stems for the export checks below.
  listeners['extraction-progress']({payload: {status: 'complete', progress: 1, elapsed_seconds: 20, output_path: '/Music/Track - Stems x', message: 'Saved', files}});
  await flush(); await flush();
  // Right-click a stem: export just that file.
  await lane('Drums').fire('contextmenu');
  const ctxMenu = body.children.at(-1);
  assert.equal(ctxMenu.children[0].textContent, 'Export Drums…');
  await ctxMenu.children[0].fire('click'); await flush();
  assert.equal(calls.at(-1)[0], 'export_stem'); assert.equal(calls.at(-1)[1].path, files[1]);
  assert.equal($('message').textContent, 'Saved Track (Drums).wav');
  // Manual BPM, then drag-and-drop a new track.
  $('grid-bpm').value = '99,5'; await $('grid-bpm').fire('change');
  assert.equal($('bpm-readout').textContent, '99.5 BPM');
  await listeners['tauri://drag-enter'](); assert.equal($('drop-overlay').hidden, false);
  await listeners['tauri://drag-drop']({payload: {paths: ['/Music/Other Song.wav']}}); await flush(); await flush();
  assert.equal($('drop-overlay').hidden, true);
  assert.equal($('input-name').textContent, 'Other Song', 'title has no file extension');
  assert.equal(part(lane('Drums'), 'lane-state').textContent, 'Ready to extract', 'old stems cleared; the selection carries over');
  assert.equal($('now-source').textContent, 'Original');
  assert.equal($('bpm-readout').textContent, '128 BPM', 'new track re-detects beats');
  // A corrected tempo is remembered for that track.
  await $('tempo-half').fire('click');
  await listeners['tauri://drag-drop']({payload: {paths: ['/Music/Track.mp3']}}); await flush(); await flush();
  assert.equal($('bpm-readout').textContent, '99.5 BPM · Saved grid', 'each track keeps its own corrected grid');
  await listeners['tauri://drag-drop']({payload: {paths: ['/Music/Other Song.wav']}}); await flush(); await flush();
  assert.equal($('bpm-readout').textContent, '64 BPM · Saved grid');
  // Error recovery.
  startError = 'Worker unavailable';
  await $('extract').fire('click'); await flush();
  assert.equal($('stage').textContent, 'Couldn’t finish'); assert.match($('message').textContent, /Worker unavailable/);
  assert.equal($('extract').disabled, false);
  console.log('UI load/beats/selection/extract/listen/combine/mute/solo/export/drop/error checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
