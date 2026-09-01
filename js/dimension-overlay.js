// Shop-drawing dimension overlay. Mirrors DimensionOverlay.swift.
//
// The overlay is a flat drawing laid into the plane of the element, just in front of its
// outer face, so it stays aligned with the geometry while the model is orbited. It carries
// what a production drawing carries: a dimension chain along each in-plane axis with a tick
// at every part boundary, the overall dimension outside it, and a label per part with its
// position number, designation and visible face size.

import * as THREE from 'three';
import { boundsCentre, boundsSize, emptyBounds, unionBounds } from './btlx-parser.js';
import { listLabel, mm } from './format.js';

// Colours follow the reference drawing: dimensioning in graphite, part labels in cyan.
const LINE_COLOUR = 0x2e2e2e;
const EXTENSION_COLOUR = 0x8f8f8f;
const TEXT_COLOUR = '#1f1f1f';
const LABEL_COLOUR = '#0099d4';

/** Boundaries closer together than this are treated as one station, in millimetres. */
const STATION_TOLERANCE = 0.5;

/** Pixel height the label canvases are rendered at before being scaled to world size. */
const TEXT_RESOLUTION = 64;
const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

// MARK: - Line building

/** Accumulates segments so the whole drawing costs one draw call rather than one per line. */
class LineBuilder {
  constructor() {
    this.positions = [];
  }

  add(a, b) {
    this.positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }

  addDashed(a, b, dash) {
    const total = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (total <= 0 || dash <= 0) return;
    const steps = Math.max(Math.floor(total / (dash * 2)), 1);
    const step = 1 / steps;
    const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    for (let i = 0; i < steps; i += 1) {
      const t0 = i * step;
      this.add(at(t0), at(t0 + step * 0.55));
    }
  }

  build(colour) {
    if (!this.positions.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    const material = new THREE.LineBasicMaterial({ color: colour, depthWrite: false });
    const lines = new THREE.LineSegments(geometry, material);
    lines.renderOrder = 20;
    lines.userData.overlay = true;
    return lines;
  }
}

// MARK: - Text

function drawTextTexture(text, colour, weight) {
  const lines = text.split('\n');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `${weight} ${TEXT_RESOLUTION}px ${FONT_STACK}`;

  ctx.font = font;
  const widest = Math.max(...lines.map((line) => ctx.measureText(line).width));
  const lineHeight = TEXT_RESOLUTION * 1.22;

  canvas.width = Math.max(Math.ceil(widest) + 8, 8);
  canvas.height = Math.max(Math.ceil(lineHeight * lines.length) + 8, 8);

  // Re-apply after resizing: changing canvas dimensions resets the 2D context.
  ctx.font = font;
  ctx.fillStyle = colour;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((line, index) => {
    ctx.fillText(line, canvas.width / 2, (index + 0.5) * lineHeight + 4);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  return { texture, width: canvas.width, height: canvas.height };
}

/**
 * A text label lying in the drawing plane.
 * `size` is the world height of one text line, in millimetres.
 */
function textMesh({ text, size, colour, weight = '500', position, plane, rotated, occludable }) {
  const { texture, width, height } = drawTextTexture(text, colour, weight);
  const perPixel = size / TEXT_RESOLUTION;

  const geometry = new THREE.PlaneGeometry(width * perPixel, height * perPixel);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: occludable,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.quaternion.copy(plane.orientation);
  if (rotated) mesh.rotateZ(Math.PI / 2);
  mesh.renderOrder = occludable ? 15 : 25;
  mesh.userData.overlay = true;
  return mesh;
}

// MARK: - Plane

/**
 * The drawing plane, plus the basis that makes text read correctly when the element is
 * seen from its outer face.
 */
function makePlane(hAxis, vAxis, normalAxis, coordinate) {
  const unit = (axis) => {
    const v = new THREE.Vector3();
    v.setComponent(axis, 1);
    return v;
  };
  const n = unit(normalAxis);
  const up = unit(vAxis);
  // Viewed from the outer face, this is the direction text runs.
  const right = new THREE.Vector3().crossVectors(up, n);
  const orientation = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, up, n),
  );

  return {
    hAxis,
    vAxis,
    normalAxis,
    coordinate,
    orientation,
    point(h, v, depth = coordinate) {
      const p = [0, 0, 0];
      p[hAxis] = h;
      p[vAxis] = v;
      p[normalAxis] = depth;
      return p;
    },
  };
}

// MARK: - Chains

function stationsOf(parts, axis) {
  const values = [];
  for (const part of parts) {
    values.push(part.worldBounds.min[axis], part.worldBounds.max[axis]);
  }
  values.sort((a, b) => a - b);
  const merged = [];
  for (const value of values) {
    if (!merged.length || value - merged[merged.length - 1] > STATION_TOLERANCE) merged.push(value);
  }
  return merged;
}

/**
 * A dimension chain: extension lines out to the dimension line, a tick at every station
 * and the distance between neighbouring stations written above the segment.
 */
function addChain({ stations, edge, gap, tick, fontSize, horizontal, plane, group, lines, dashes }) {
  if (stations.length < 2) return;
  const line = edge + gap;
  const at = (station, offset) =>
    horizontal ? plane.point(station, offset) : plane.point(offset, station);

  lines.add(at(stations[0], line), at(stations[stations.length - 1], line));

  for (const station of stations) {
    dashes.addDashed(at(station, edge), at(station, line + (gap > 0 ? tick : -tick)), tick * 1.2);
    // 45° slash tick, the way a dimension line is ticked on a shop drawing.
    lines.add(at(station - tick * 0.5, line - tick * 0.5), at(station + tick * 0.5, line + tick * 0.5));
  }

  for (let i = 0; i < stations.length - 1; i += 1) {
    const span = stations[i + 1] - stations[i];
    if (span <= STATION_TOLERANCE) continue;
    const middle = (stations[i] + stations[i + 1]) / 2;
    const offset = line + (gap > 0 ? fontSize * 0.62 : -fontSize * 0.62);
    group.add(
      textMesh({
        text: mm(span),
        size: fontSize * (span < fontSize * 2.2 ? 0.62 : 1),
        colour: TEXT_COLOUR,
        position: at(middle, offset),
        plane,
        rotated: !horizontal,
        occludable: false,
      }),
    );
  }
}

function addOverall({ start, end, offset, tick, fontSize, horizontal, plane, group, lines }) {
  const at = (station, across) =>
    horizontal ? plane.point(station, across) : plane.point(across, station);

  lines.add(at(start, offset), at(end, offset));
  for (const station of [start, end]) {
    lines.add(at(station - tick * 0.5, offset - tick * 0.5), at(station + tick * 0.5, offset + tick * 0.5));
  }
  group.add(
    textMesh({
      text: mm(end - start),
      size: fontSize * 1.15,
      colour: TEXT_COLOUR,
      weight: '600',
      position: at((start + end) / 2, offset + (horizontal ? 1 : -1) * fontSize * 0.7),
      plane,
      rotated: !horizontal,
      occludable: false,
    }),
  );
}

// MARK: - Part labels

function addLabel({ part, hAxis, vAxis, normalAxis, lift, fontSize, plane, group }) {
  const width = part.worldBounds.max[hAxis] - part.worldBounds.min[hAxis];
  const height = part.worldBounds.max[vAxis] - part.worldBounds.min[vAxis];
  if (Math.min(width, height) <= 1) return;

  // Narrow members carry their label turned along their length, as on the drawing; the
  // caption keeps its size and is allowed to overhang a slender stud rather than shrinking
  // to something unreadable.
  const centre = (axis) => (part.worldBounds.min[axis] + part.worldBounds.max[axis]) / 2;
  group.add(
    textMesh({
      text: `${listLabel(part)}\n${mm(width)} × ${mm(height)} mm`,
      size: fontSize * 0.8,
      colour: LABEL_COLOUR,
      weight: '600',
      position: plane.point(centre(hAxis), centre(vAxis), part.worldBounds.max[normalAxis] + lift),
      plane,
      rotated: height > width,
      occludable: true,
    }),
  );
}

// MARK: - Entry point

export function buildDimensionOverlay(doc, visibleLayers) {
  const group = new THREE.Group();
  group.name = 'dimensions';

  const parts = doc.parts.filter((part) => visibleLayers.has(part.layerID));
  if (!parts.length) return group;

  const bounds = emptyBounds();
  for (const part of parts) unionBounds(bounds, part.worldBounds);
  const size = boundsSize(bounds);

  // Drawing plane: spanned by the two in-plane axes, offset off the outer face.
  const normal = doc.normalAxis;
  const inPlane = [0, 1, 2].filter((axis) => axis !== normal);
  const hAxis = size[inPlane[0]] >= size[inPlane[1]] ? inPlane[0] : inPlane[1];
  const vAxis = inPlane[0] === hAxis ? inPlane[1] : inPlane[0];

  const span = Math.max(size[hAxis], size[vAxis], 1);
  const plane = makePlane(hAxis, vAxis, normal, bounds.max[normal] + span * 0.012);

  const fontSize = span / 48;
  const chainGap = span * 0.055; // model edge -> part chain
  const overallGap = span * 0.125; // model edge -> overall dimension
  const tick = fontSize * 0.55;

  const lines = new LineBuilder();
  const dashes = new LineBuilder();

  // Horizontal chain, above the element.
  addChain({
    stations: stationsOf(parts, hAxis),
    edge: bounds.max[vAxis],
    gap: chainGap,
    tick, fontSize, horizontal: true, plane, group, lines, dashes,
  });

  // Vertical chain, to the leading side of the element.
  addChain({
    stations: stationsOf(parts, vAxis),
    edge: bounds.min[hAxis],
    gap: -chainGap,
    tick, fontSize, horizontal: false, plane, group, lines, dashes,
  });

  // Overall dimensions outside both chains.
  addOverall({
    start: bounds.min[hAxis], end: bounds.max[hAxis],
    offset: bounds.max[vAxis] + overallGap,
    tick, fontSize, horizontal: true, plane, group, lines,
  });
  addOverall({
    start: bounds.min[vAxis], end: bounds.max[vAxis],
    offset: bounds.min[hAxis] - overallGap,
    tick, fontSize, horizontal: false, plane, group, lines,
  });

  // One label per visible part.
  for (const part of parts) {
    addLabel({ part, hAxis, vAxis, normalAxis: normal, lift: span * 0.003, fontSize, plane, group });
  }

  const solidLines = lines.build(LINE_COLOUR);
  if (solidLines) group.add(solidLines);
  const dashedLines = dashes.build(EXTENSION_COLOUR);
  if (dashedLines) group.add(dashedLines);

  return group;
}

/** Frees the GPU resources of an overlay built above. */
export function disposeOverlay(group) {
  group.traverse((object) => {
    if (object.geometry) object.geometry.dispose();
    const material = object.material;
    if (!material) return;
    if (material.map) material.map.dispose();
    material.dispose();
  });
}
