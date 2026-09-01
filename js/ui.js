// Renders the sidebar, the inspector and the viewport overlays from the parsed document.
// Mirrors LayerSidebar.swift and PartInspector.swift.

import { toWorld } from './btlx-parser.js';
import { layerSummary } from './layer-classifier.js';
import { processingDisplayName } from './btlx-parser.js';
import { crossSection, kg, listLabel, mm, point } from './format.js';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Length x build-up depth x height, measured in the element's own frame. */
const elementSize = (doc) => ({
  length: doc.frameBounds.h[1] - doc.frameBounds.h[0],
  depth: doc.frameBounds.n[1] - doc.frameBounds.n[0],
  height: doc.frameBounds.v[1] - doc.frameBounds.v[0],
});

const cssColour = (rgb) =>
  `rgb(${Math.round(rgb[0] * 255)} ${Math.round(rgb[1] * 255)} ${Math.round(rgb[2] * 255)})`;

/** A definition list of label/value pairs; empty values render as an em dash. */
function attributeList(pairs) {
  const list = el('dl', 'attrs');
  for (const [label, value] of pairs) {
    if (value === null || value === undefined) continue;
    const row = el('div', 'attr');
    row.append(el('dt', null, label), el('dd', null, String(value).length ? String(value) : '—'));
    list.append(row);
  }
  return list;
}

function section(title, body) {
  const fragment = document.createDocumentFragment();
  fragment.append(el('h3', 'section-title', title), body);
  return fragment;
}

// MARK: - Sidebar

export function renderLayers(container, doc, state, actions, expanded) {
  container.textContent = '';
  if (!doc) return;

  for (const layer of doc.layers) {
    const summary = layerSummary(layer, doc);
    const visible = state.visibleLayers.has(layer.id);
    const isOpen = expanded.has(layer.id);

    const row = el('div', `layer-row${visible ? '' : ' hidden-layer'}`);

    const head = el('div', 'layer-head');
    const eye = el('button', `eye${visible ? '' : ' off'}`, visible ? '👁' : '🚫');
    eye.title = visible ? `Schicht ${layer.id} ausblenden` : `Schicht ${layer.id} einblenden`;
    eye.setAttribute('aria-label', eye.title);
    eye.addEventListener('click', () => actions.toggleLayer(layer));

    const swatch = el('span', 'swatch');
    swatch.style.background = cssColour(layer.colour);

    const title = el('div', 'layer-title');
    title.append(el('div', 'layer-code', layer.id), el('div', 'layer-name', layer.name));
    title.addEventListener('click', () => actions.toggleLayer(layer));

    const disclosure = el('button', 'disclosure', isOpen ? '▾' : '▸');
    disclosure.title = isOpen ? 'Bauteile ausblenden' : 'Bauteile anzeigen';
    disclosure.addEventListener('click', () => actions.toggleExpanded(layer));

    head.append(eye, swatch, title, disclosure);

    const metrics = el('div', 'metrics');
    for (const [label, value] of [
      ['Bauteile', String(summary.partCount)],
      ['Dicke', `${mm(layer.thickness)} mm`],
      ['Gewicht', kg(summary.totalWeight)],
    ]) {
      const metric = el('div');
      metric.append(el('span', 'metric-label', label), el('span', 'metric-value', value));
      metrics.append(metric);
    }

    row.append(head, metrics);

    if (summary.materials.length) {
      row.append(el('div', 'layer-materials', summary.materials.join(' · ')));
    }

    const actionsRow = el('div', 'layer-actions');
    const only = el('button', 'chip-button', 'Nur diese');
    only.addEventListener('click', () => actions.isolateLayer(layer));
    actionsRow.append(
      only,
      el('span', 'layer-range', `Lage ${mm(layer.normalRange[0])} … ${mm(layer.normalRange[1])} mm`),
    );
    row.append(actionsRow);

    if (isOpen) {
      const list = el('ul', 'part-list');
      for (const part of doc.parts.filter((candidate) => candidate.layerID === layer.id)) {
        const item = el('li', `part-row${state.selectedPartID === part.id ? ' selected' : ''}`);
        const text = el('div');
        text.append(
          el('div', 'part-name', part.designation),
          el('div', 'part-dims', `${crossSection(part)} · ${mm(part.length)} mm`),
        );
        item.append(el('span', 'part-number', part.singleMemberNumber), text);
        item.addEventListener('click', () => actions.selectPart(part.id, layer));
        list.append(item);
      }
      row.append(list);
    }

    container.append(row);
  }
}

export function renderModelInfo(container, doc) {
  container.textContent = '';
  if (!doc) return;

  const size = elementSize(doc);

  container.append(
    section(
      'Modell',
      attributeList([
        ['Datei', doc.fileName],
        ['Projekt', doc.projectName || null],
        ['BTLX-Version', doc.version],
        ['Bauteile', String(doc.parts.length)],
        ['Gesamtgewicht', kg(doc.totalWeight)],
        ['Länge', `${mm(size.length)} mm`],
        ['Höhe', `${mm(size.height)} mm`],
        ['Aufbaudicke', `${mm(size.depth)} mm`],
      ]),
    ),
  );

  const history = doc.history;
  const provenance = [
    ['CAD', history.programName ? `${history.programName} ${history.programVersion}`.trim() : null],
    ['Hersteller', history.companyName || null],
    ['Benutzer', history.userName || null],
    ['Export', history.date ? `${history.date} ${history.time}`.trim() : null],
  ].filter(([, value]) => value);

  if (provenance.length) container.append(section('Herkunft', attributeList(provenance)));
}

export function layerNote(doc) {
  if (!doc) return '';
  const thickness = doc.frameBounds.n[1] - doc.frameBounds.n[0];
  return `Schichten sind aus der Bauteillage entlang der Elementnormale (${doc.frame.description}, Aufbau ${mm(thickness)} mm) abgeleitet. Mehrere Schichten können gleichzeitig sichtbar sein.`;
}

// MARK: - Viewport overlays

export function renderChips(container, doc, state) {
  container.textContent = '';
  if (!doc) return;
  const active = doc.layers.filter((layer) => state.visibleLayers.has(layer.id));
  if (!active.length) {
    container.append(el('span', 'chip empty', 'keine Schicht'));
    return;
  }
  for (const layer of active) {
    const chip = el('span', 'chip');
    const dot = el('span', 'dot');
    dot.style.background = cssColour(layer.colour);
    chip.append(dot, el('span', null, layer.id));
    container.append(chip);
  }
}

export function renderLegend(container, doc) {
  container.textContent = '';
  if (!doc) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const size = elementSize(doc);
  container.append(
    el('div', 'legend-title', doc.projectName || doc.fileName),
    el('div', 'legend-line', `${mm(size.length)} × ${mm(size.depth)} × ${mm(size.height)} mm`),
    el(
      'div',
      'legend-line',
      `${doc.parts.length} Bauteile · ${kg(doc.totalWeight)} · BTLX ${doc.version}`,
    ),
  );
}

// MARK: - Inspector

export function renderInspector(container, doc, part) {
  container.textContent = '';
  if (!part || !doc) {
    container.append(
      el('p', 'placeholder', 'Bauteil im 3D-Modell antippen oder in der Schichtliste auswählen.'),
    );
    return;
  }

  const layer = doc.layers.find((candidate) => candidate.id === part.layerID);

  const head = el('div', 'part-head');
  const swatch = el('span', 'swatch');
  swatch.style.background = cssColour(layer ? layer.colour : part.colour || [0.7, 0.7, 0.7]);
  const headText = el('div');
  headText.append(
    el('div', 'part-head-title', part.designation),
    el('div', 'part-head-sub', `Pos. ${part.singleMemberNumber} · ${part.material}`),
  );
  head.append(swatch, headText);

  const tags = el('div', 'tags');
  const layerTag = el('span', 'tag layer', part.layerID);
  tags.append(
    layerTag,
    el('span', 'tag', `${mm(part.length)} mm`),
    el('span', 'tag', crossSection(part)),
    el('span', 'tag', kg(part.weight)),
  );

  container.append(head, tags);

  container.append(
    section(
      'Identifikation',
      attributeList([
        ['Produktionslisten-Nr.', part.singleMemberNumber],
        ['Bezeichnung', part.designation],
        ['Material', part.material],
        ['Elementnummer', part.elementNumber],
        ['Baugruppe', part.assemblyNumber],
        ['Auftragsnummer', part.orderNumber],
        ['Geschoss', part.storey],
        ['Stückzahl', String(part.count)],
        ['Schicht', `${part.layerID} · ${layer ? layer.name : '—'}`],
      ]),
    ),
  );

  container.append(
    section(
      'Abmessungen',
      attributeList([
        ['Länge', `${mm(part.length)} mm`],
        ['Breite', `${mm(part.width)} mm`],
        ['Höhe', `${mm(part.height)} mm`],
        ['Querschnitt', crossSection(part)],
        ['Gewicht', kg(part.weight)],
        part.count > 1 ? ['Gewicht gesamt', kg(part.weight * part.count)] : null,
      ].filter(Boolean)),
    ),
  );

  container.append(
    section(
      'Lage im Modell',
      attributeList([
        ['Bezugspunkt', point(part.origin)],
        ['X-Achse', point(part.xAxis)],
        ['Y-Achse', point(part.yAxis)],
        ['Z-Achse', point(part.zAxis)],
        part.centerOfGravity ? ['Schwerpunkt', point(toWorld(part, part.centerOfGravity))] : null,
        ['Bounding Box von', point(part.worldBounds.min)],
        ['Bounding Box bis', point(part.worldBounds.max)],
        part.referenceSide
          ? [
              'Bezugsseite',
              `Seite ${part.referenceSide}${part.referenceSideAlign ? `, Align ${part.referenceSideAlign}` : ''}`,
            ]
          : null,
        part.guid ? ['GUID', part.guid] : null,
      ].filter(Boolean)),
    ),
  );

  container.append(
    section(
      'Geometrie',
      attributeList([
        ['Eckpunkte', String(part.mesh.points.length)],
        ['Flächen', String(part.mesh.faces.length)],
      ]),
    ),
  );

  if (!part.processings.length) {
    container.append(section('Bearbeitungen', el('p', 'placeholder', 'Keine Bearbeitungen')));
    return;
  }

  const list = el('div');
  for (const processing of part.processings) {
    const details = el('details', 'processing');
    const summary = el('summary');
    summary.append(
      document.createTextNode(processing.name || processingDisplayName(processing.type)),
      el(
        'div',
        'processing-sub',
        `${processing.type} · ID ${processing.processID} · Bezugsebene ${processing.referencePlaneID}${
          processing.isActive ? '' : ' · inaktiv'
        }`,
      ),
    );
    details.append(
      summary,
      attributeList([
        processing.quality ? ['Qualität', processing.quality] : null,
        ...processing.parameters,
      ].filter(Boolean)),
    );
    list.append(details);
  }
  container.append(section(`Bearbeitungen (${part.processings.length})`, list));
}

export { listLabel };
