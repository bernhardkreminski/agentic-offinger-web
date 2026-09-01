// BTLX reader. Mirrors BTLxParser.swift from the iPad app.
//
// BTLX is namespaced XML (https://www.design2machine.com). Everything here matches on
// local element names only, so files written with any prefix — or none — parse identically.

import { add, cross, normalize, scale, sub, length as vecLength, dot } from './vec3.js';
import { classifyLayers } from './layer-classifier.js';
import { deriveElementFrame, frameExtentsOf } from './element-frame.js';

export class BTLxParseError extends Error {}

const PROCESSING_NAMES = {
  JackRafterCut: 'Abschnitt',
  Lap: 'Blatt',
  DoubleCut: 'Doppelschnitt',
  Drilling: 'Bohrung',
  Mortise: 'Zapfenloch',
  Tenon: 'Zapfen',
  House: 'Versatz',
  Pocket: 'Tasche',
  Slot: 'Schlitz',
  Marking: 'Anriss',
  Text: 'Beschriftung',
  FrenchRidgeLap: 'Französisches Blatt',
  ScarfJoint: 'Stoß',
  StepJoint: 'Versatz',
  LongitudinalCut: 'Längsschnitt',
};

export function processingDisplayName(type) {
  return PROCESSING_NAMES[type] || type;
}

const num = (value) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const attr = (element, name) => (element && element.getAttribute(name)) || '';

/** Direct children of `element` whose local name matches. */
const kids = (element, localName) =>
  element ? Array.from(element.children).filter((child) => child.localName === localName) : [];

const kid = (element, localName) => kids(element, localName)[0] || null;

const vector = (element) =>
  element ? [num(element.getAttribute('X')), num(element.getAttribute('Y')), num(element.getAttribute('Z'))] : [0, 0, 0];

export const emptyBounds = () => ({
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
});

export const boundsIsEmpty = (b) => b.min[0] > b.max[0];
export const boundsSize = (b) => (boundsIsEmpty(b) ? [0, 0, 0] : sub(b.max, b.min));
export const boundsCentre = (b) =>
  boundsIsEmpty(b) ? [0, 0, 0] : scale(add(b.min, b.max), 0.5);

export function expandBounds(b, p) {
  for (let i = 0; i < 3; i += 1) {
    if (p[i] < b.min[i]) b.min[i] = p[i];
    if (p[i] > b.max[i]) b.max[i] = p[i];
  }
}

export function unionBounds(b, other) {
  if (boundsIsEmpty(other)) return;
  expandBounds(b, other.min);
  expandBounds(b, other.max);
}

/** `"0 1 2 3 -1 1 0 4 5 -1"` -> `[[0,1,2,3],[1,0,4,5]]` */
export function parseFaces(text) {
  const faces = [];
  let face = [];
  for (const token of text.split(/\s+/)) {
    if (!token) continue;
    const index = Number.parseInt(token, 10);
    if (!Number.isFinite(index)) continue;
    if (index < 0) {
      if (face.length >= 3) faces.push(face);
      face = [];
    } else {
      face.push(index);
    }
  }
  if (face.length >= 3) faces.push(face); // tolerate a missing trailing -1
  return faces;
}

/** `"10 0 80 10 200 80"` -> `[[10,0,80],[10,200,80]]` */
export function parsePoints(text) {
  const values = [];
  for (const token of text.split(/\s+/)) {
    if (token) values.push(num(token));
  }
  const points = [];
  for (let i = 0; i + 2 < values.length; i += 3) {
    points.push([values[i], values[i + 1], values[i + 2]]);
  }
  return points;
}

function readProcessings(partElement) {
  const container = kid(partElement, 'Processings');
  if (!container) return [];
  return Array.from(container.children).map((operation) => {
    const parameters = [];
    for (const child of operation.children) {
      for (const a of Array.from(child.attributes).sort((x, y) => x.name.localeCompare(y.name))) {
        parameters.push([`${child.localName}.${a.name}`, a.value]);
      }
      const text = (child.textContent || '').trim();
      if (text && child.children.length === 0) parameters.push([child.localName, text]);
    }
    return {
      type: operation.localName,
      name: attr(operation, 'Name'),
      processID: attr(operation, 'ProcessID'),
      referencePlaneID: attr(operation, 'ReferencePlaneID'),
      quality: attr(operation, 'ProcessingQuality'),
      isActive: (attr(operation, 'Process') || 'yes') === 'yes',
      parameters,
    };
  });
}

function readPart(partElement, id) {
  // <Position> also appears under <UserReferencePlane>; only the one directly inside
  // <Transformation> defines the part placement.
  const transformation = kid(kid(partElement, 'Transformations'), 'Transformation');
  const position = kid(transformation, 'Position');

  const origin = vector(kid(position, 'ReferencePoint'));
  let xAxis = vector(kid(position, 'XVector'));
  let yAxis = vector(kid(position, 'YVector'));
  if (vecLength(xAxis) < 1e-9) xAxis = [1, 0, 0];
  if (vecLength(yAxis) < 1e-9) yAxis = [0, 1, 0];
  xAxis = normalize(xAxis);
  // Re-orthogonalise so a slightly off YVector cannot shear the mesh.
  yAxis = normalize(sub(yAxis, scale(xAxis, dot(xAxis, yAxis))));
  const zAxis = cross(xAxis, yAxis);

  const faceSet = kid(kid(partElement, 'Shape'), 'IndexedFaceSet');
  const mesh = {
    points: faceSet ? parsePoints(attr(kid(faceSet, 'Coordinate'), 'point')) : [],
    faces: faceSet ? parseFaces(attr(faceSet, 'coordIndex')) : [],
  };

  const bounds = emptyBounds();
  const worldPoints = new Float64Array(mesh.points.length * 3);
  mesh.points.forEach((p, index) => {
    const world = add(add(origin, scale(xAxis, p[0])), add(scale(yAxis, p[1]), scale(zAxis, p[2])));
    expandBounds(bounds, world);
    worldPoints[index * 3] = world[0];
    worldPoints[index * 3 + 1] = world[1];
    worldPoints[index * 3 + 2] = world[2];
  });

  const colourElement = kid(partElement, 'Colour');
  let colour = null;
  if (colourElement) {
    // BTLX writes 0...255 channels and a 0...100 transparency percentage.
    const transparency = Math.min(Math.max(num(attr(colourElement, 'Transparency')), 0), 100);
    colour = [
      num(attr(colourElement, 'Red')) / 255,
      num(attr(colourElement, 'Green')) / 255,
      num(attr(colourElement, 'Blue')) / 255,
      1 - transparency / 100,
    ];
  }

  const cog = kid(partElement, 'CenterOfGravity');
  const referenceSide = kid(partElement, 'ReferenceSide');

  return {
    id,
    singleMemberNumber: attr(partElement, 'SingleMemberNumber'),
    designation: attr(partElement, 'Designation') || '—',
    material: attr(partElement, 'Material'),
    elementNumber: attr(partElement, 'ElementNumber'),
    assemblyNumber: attr(partElement, 'AssemblyNumber'),
    orderNumber: attr(partElement, 'OrderNumber'),
    storey: attr(partElement, 'Storey'),
    count: Number.parseInt(attr(partElement, 'Count') || '1', 10) || 1,
    guid: attr(transformation, 'GUID').replace(/[{}]/g, ''),
    length: num(attr(partElement, 'Length')),
    width: num(attr(partElement, 'Width')),
    height: num(attr(partElement, 'Height')),
    weight: num(attr(partElement, 'Weight')),
    origin,
    xAxis,
    yAxis,
    zAxis,
    centerOfGravity: cog ? vector(cog) : null,
    colour,
    referenceSide: referenceSide ? attr(referenceSide, 'Side') : '',
    referenceSideAlign: referenceSide ? attr(referenceSide, 'Align') : '',
    mesh,
    processings: readProcessings(partElement),
    worldBounds: bounds,
    worldPoints,
    /** [min, max] along the element normal / horizontal / vertical. Filled in below. */
    frameSpan: null,
    layerID: '',
  };
}

/** Part-local point -> world millimetres. */
export function toWorld(part, p) {
  return add(
    add(part.origin, scale(part.xAxis, p[0])),
    add(scale(part.yAxis, p[1]), scale(part.zAxis, p[2])),
  );
}

export function parseBTLx(text, fileName) {
  const dom = new DOMParser().parseFromString(text, 'application/xml');
  const failure = dom.querySelector('parsererror');
  if (failure) {
    throw new BTLxParseError(`Die BTLX-Datei ist fehlerhaft. (${failure.textContent.trim().split('\n')[0]})`);
  }

  const root = dom.documentElement;
  if (!root || root.localName !== 'BTLx') {
    throw new BTLxParseError('Die Datei ist keine BTLX-Datei.');
  }

  const partElements = Array.from(root.getElementsByTagNameNS('*', 'Part'));
  if (partElements.length === 0) {
    throw new BTLxParseError('Die BTLX-Datei enthält keine Bauteile.');
  }

  const parts = partElements.map(readPart);
  const bounds = emptyBounds();
  for (const part of parts) unionBounds(bounds, part.worldBounds);

  const project = root.getElementsByTagNameNS('*', 'Project')[0] || null;
  const exportInfo = root.getElementsByTagNameNS('*', 'InitialExportProgram')[0] || null;

  const frame = deriveElementFrame(parts);
  for (const part of parts) part.frameSpan = frameExtentsOf(part, frame);
  // The world points were only needed to measure the frame; drop them again.
  for (const part of parts) part.worldPoints = null;

  const layers = classifyLayers(parts, frame);

  // Overall extent in the element's own frame: length, height and build-up depth.
  const frameBounds = { h: [Infinity, -Infinity], v: [Infinity, -Infinity], n: [Infinity, -Infinity] };
  for (const part of parts) {
    for (const key of ['h', 'v', 'n']) {
      frameBounds[key][0] = Math.min(frameBounds[key][0], part.frameSpan[key][0]);
      frameBounds[key][1] = Math.max(frameBounds[key][1], part.frameSpan[key][1]);
    }
  }

  return {
    fileName,
    version: attr(root, 'Version'),
    language: attr(root, 'Language'),
    projectName: attr(project, 'Name'),
    sourceFile: attr(project, 'SourceFile'),
    history: {
      programName: attr(exportInfo, 'ProgramName'),
      programVersion: attr(exportInfo, 'ProgramVersion'),
      companyName: attr(exportInfo, 'CompanyName'),
      userName: attr(exportInfo, 'UserName'),
      computerName: attr(exportInfo, 'ComputerName'),
      date: attr(exportInfo, 'Date'),
      time: attr(exportInfo, 'Time'),
      sourceFileName: attr(exportInfo, 'FileName'),
      comment: attr(exportInfo, 'Comment'),
    },
    parts,
    layers,
    frame,
    frameBounds,
    bounds,
    get totalWeight() {
      return this.parts.reduce((sum, part) => sum + part.weight * part.count, 0);
    },
  };
}

