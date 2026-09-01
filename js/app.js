// Application state and wiring. Mirrors AppModel.swift and ContentView.swift.

import { parseBTLx } from './btlx-parser.js';
import { ModelScene, VIEW_PRESETS } from './model-scene.js';
import {
  layerNote,
  renderChips,
  renderInspector,
  renderLayers,
  renderLegend,
  renderModelInfo,
} from './ui.js';

/** The file shipped with the site, loaded on first visit and via "Beispiel laden". */
const SAMPLE_URL = 'data/testfile.btlx';

const dom = {
  canvas: document.getElementById('scene'),
  sidebar: document.getElementById('sidebar'),
  layout: document.querySelector('.layout'),
  layerList: document.getElementById('layer-list'),
  layerNote: document.getElementById('layer-note'),
  modelInfo: document.getElementById('model-info'),
  toggleAllLayers: document.getElementById('toggle-all-layers'),
  presetBar: document.getElementById('preset-bar'),
  chips: document.getElementById('visible-chips'),
  legend: document.getElementById('legend'),
  inspector: document.getElementById('inspector'),
  inspectorBody: document.getElementById('inspector-body'),
  fileName: document.getElementById('file-name'),
  fileInput: document.getElementById('file-input'),
  emptyState: document.getElementById('empty-state'),
  error: document.getElementById('error'),
  errorText: document.getElementById('error-text'),
  optEdges: document.getElementById('opt-edges'),
  optGhost: document.getElementById('opt-ghost'),
  optDimensions: document.getElementById('opt-dimensions'),
  optExplode: document.getElementById('opt-explode'),
};

const state = {
  visibleLayers: new Set(),
  selectedPartID: null,
  showEdges: true,
  ghostHiddenLayers: false,
  showDimensions: false,
  explode: 0,
};

let doc = null;
let preset = 'iso';
const expandedLayers = new Set();
const scene = new ModelScene(dom.canvas);

// MARK: - Loading

function adopt(parsed) {
  doc = parsed;
  // Every layer on by default — RW and BS1 are meant to be readable together.
  state.visibleLayers = new Set(parsed.layers.map((layer) => layer.id));
  state.selectedPartID = null;
  state.explode = 0;
  dom.optExplode.value = '0';
  expandedLayers.clear();
  if (parsed.layers.length) expandedLayers.add(parsed.layers[0].id);

  preset = 'iso';
  scene.load(parsed);
  scene.apply(state);
  scene.moveTo(preset);
  setInspectorOpen(false);
  refresh();
}

function showError(message) {
  dom.errorText.textContent = message;
  dom.error.hidden = false;
}

async function loadSample() {
  try {
    const response = await fetch(SAMPLE_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    adopt(parseBTLx(await response.text(), SAMPLE_URL.split('/').pop()));
  } catch (error) {
    showError(`Die Beispieldatei konnte nicht geladen werden. (${error.message})`);
  }
}

async function loadFile(file) {
  try {
    adopt(parseBTLx(await file.text(), file.name));
  } catch (error) {
    showError(error.message);
  }
}

// MARK: - Rendering

function refresh() {
  const actions = { toggleLayer, isolateLayer, toggleExpanded, selectPart };
  renderLayers(dom.layerList, doc, state, actions, expandedLayers);
  renderModelInfo(dom.modelInfo, doc);
  renderChips(dom.chips, doc, state);
  renderLegend(dom.legend, doc);
  renderInspector(dom.inspectorBody, doc, selectedPart());
  dom.layerNote.textContent = layerNote(doc);
  dom.fileName.textContent = doc ? doc.fileName : '—';
  dom.emptyState.hidden = Boolean(doc);

  const allVisible = doc && doc.layers.length && state.visibleLayers.size === doc.layers.length;
  dom.toggleAllLayers.textContent = allVisible ? `Nur ${doc.layers[0].id}` : 'Alle';
  dom.toggleAllLayers.disabled = !doc || !doc.layers.length;

  for (const button of dom.presetBar.children) {
    button.classList.toggle('active', button.dataset.preset === preset);
  }
}

const selectedPart = () =>
  doc && state.selectedPartID !== null
    ? doc.parts.find((part) => part.id === state.selectedPartID) || null
    : null;

function applyAndRefresh() {
  scene.apply(state);
  refresh();
}

// MARK: - Layers

function toggleLayer(layer) {
  if (state.visibleLayers.has(layer.id)) {
    state.visibleLayers.delete(layer.id);
    // Do not leave a selection stranded on a switched-off layer.
    const part = selectedPart();
    if (part && part.layerID === layer.id) {
      state.selectedPartID = null;
      setInspectorOpen(false);
    }
  } else {
    state.visibleLayers.add(layer.id);
  }
  applyAndRefresh();
}

/** Show this layer only — the "Einzelschicht" case. */
function isolateLayer(layer) {
  state.visibleLayers = new Set([layer.id]);
  const part = selectedPart();
  if (part && part.layerID !== layer.id) {
    state.selectedPartID = null;
    setInspectorOpen(false);
  }
  applyAndRefresh();
  scene.moveTo(preset);
}

function toggleExpanded(layer) {
  if (expandedLayers.has(layer.id)) expandedLayers.delete(layer.id);
  else expandedLayers.add(layer.id);
  refresh();
}

function selectPart(partID, layer) {
  if (layer && !state.visibleLayers.has(layer.id)) state.visibleLayers.add(layer.id);
  state.selectedPartID = partID;
  setInspectorOpen(partID !== null);
  applyAndRefresh();
}

function setInspectorOpen(open) {
  dom.inspector.hidden = !open;
  dom.layout.classList.toggle('with-inspector', open);
  document.getElementById('toggle-inspector').setAttribute('aria-pressed', String(open));
}

// MARK: - Wiring

for (const [key, config] of Object.entries(VIEW_PRESETS)) {
  const button = document.createElement('button');
  button.className = 'preset';
  button.dataset.preset = key;
  button.textContent = config.label;
  button.addEventListener('click', () => {
    preset = key;
    scene.moveTo(key);
    refresh();
  });
  dom.presetBar.append(button);
}

dom.toggleAllLayers.addEventListener('click', () => {
  if (!doc || !doc.layers.length) return;
  const allVisible = state.visibleLayers.size === doc.layers.length;
  state.visibleLayers = allVisible
    ? new Set([doc.layers[0].id])
    : new Set(doc.layers.map((layer) => layer.id));
  applyAndRefresh();
  scene.moveTo(preset);
});

dom.optEdges.addEventListener('change', () => {
  state.showEdges = dom.optEdges.checked;
  applyAndRefresh();
});

dom.optGhost.addEventListener('change', () => {
  state.ghostHiddenLayers = dom.optGhost.checked;
  applyAndRefresh();
});

dom.optDimensions.addEventListener('change', () => {
  // Switching dimensioning changes how much space the drawing needs, so refit.
  state.showDimensions = dom.optDimensions.checked;
  applyAndRefresh();
  scene.moveTo(preset);
});

dom.optExplode.addEventListener('input', () => {
  state.explode = Number.parseFloat(dom.optExplode.value);
  scene.apply(state);
});

document.getElementById('import').addEventListener('click', () => dom.fileInput.click());
dom.fileInput.addEventListener('change', () => {
  const file = dom.fileInput.files && dom.fileInput.files[0];
  if (file) loadFile(file);
  dom.fileInput.value = '';
});

document.getElementById('load-sample').addEventListener('click', loadSample);
document.getElementById('refit').addEventListener('click', () => scene.moveTo(preset));
document.getElementById('toggle-inspector').addEventListener('click', () =>
  setInspectorOpen(dom.inspector.hidden),
);
document.getElementById('close-inspector').addEventListener('click', () => setInspectorOpen(false));
document.getElementById('toggle-sidebar').addEventListener('click', () =>
  dom.layout.classList.toggle('no-sidebar'),
);
document.getElementById('error-dismiss').addEventListener('click', () => {
  dom.error.hidden = true;
});

// Drag and drop anywhere on the page imports a BTLX file.
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer && event.dataTransfer.files[0];
  if (file) loadFile(file);
});

// A click picks a part; a drag orbits, so only treat a short, still pointer as a tap.
let pointerStart = null;
dom.canvas.addEventListener('pointerdown', (event) => {
  pointerStart = { x: event.clientX, y: event.clientY, time: performance.now() };
});
dom.canvas.addEventListener('pointerup', (event) => {
  if (!pointerStart) return;
  const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
  const elapsed = performance.now() - pointerStart.time;
  pointerStart = null;
  if (moved > 5 || elapsed > 500) return;
  selectPart(scene.pick(event.clientX, event.clientY), null);
});

if (window.matchMedia('(max-width: 900px)').matches) {
  dom.layout.classList.add('no-sidebar');
}

refresh();
loadSample();
