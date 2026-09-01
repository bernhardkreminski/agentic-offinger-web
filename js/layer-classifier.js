// Derives build-up layers (Schichtaufbau) from part geometry.
// Mirrors LayerClassifier.swift.
//
// BTLX has no layer attribute, so layers are reconstructed the way a timber-frame element
// is actually built: parts are projected onto the element normal — the thinnest of the
// three world axes — and grouped into bands of overlapping extent.
//
// The band holding the structural framing (the thickest band) becomes RW (Rahmenwerk).
// Bands stacked outwards from it become BS1, BS2 … (Beplankung Seite 1 …), bands on the
// opposite face IS1, IS2 … (Innenseite …).

/** Two bands are merged when they overlap by more than this, in millimetres. */
const OVERLAP_TOLERANCE = 1.0;

const FRAME_COLOUR = [0.78, 0.58, 0.33];
const SHEATHING_COLOURS = [
  [0.42, 0.62, 0.76],
  [0.55, 0.72, 0.52],
  [0.8, 0.55, 0.55],
  [0.66, 0.58, 0.78],
];

/** The element normal is the world axis the model is thinnest along. */
function normalAxisOf(bounds) {
  const size = [0, 1, 2].map((i) => bounds.max[i] - bounds.min[i]);
  let axis = 0;
  for (let i = 1; i < 3; i += 1) if (size[i] < size[axis]) axis = i;
  return axis;
}

/** Sweep the parts along the normal and merge those whose extents overlap. */
function bandsFor(parts, axis) {
  const sorted = [...parts].sort((a, b) => a.worldBounds.min[axis] - b.worldBounds.min[axis]);
  const bands = [];
  for (const part of sorted) {
    const lower = part.worldBounds.min[axis];
    const upper = part.worldBounds.max[axis];
    const last = bands[bands.length - 1];
    if (last && lower < last.upper - OVERLAP_TOLERANCE) {
      last.upper = Math.max(last.upper, upper);
      last.partIDs.push(part.id);
    } else {
      bands.push({ lower, upper, partIDs: [part.id] });
    }
  }
  return bands;
}

/**
 * The framing band is the thickest one — sheathing and insulation are always thinner
 * than the studs they are fixed to. Ties break on total weight.
 */
function frameBandIndex(bands, parts) {
  const weights = new Map(parts.map((part) => [part.id, part.weight]));
  let best = 0;
  let bestThickness = -Infinity;
  let bestWeight = -Infinity;
  bands.forEach((band, index) => {
    const thickness = band.upper - band.lower;
    const weight = band.partIDs.reduce((sum, id) => sum + (weights.get(id) || 0), 0);
    if (
      thickness > bestThickness + 0.5 ||
      (Math.abs(thickness - bestThickness) <= 0.5 && weight > bestWeight)
    ) {
      best = index;
      bestThickness = thickness;
      bestWeight = weight;
    }
  });
  return best;
}

export function classifyLayers(parts, bounds) {
  if (parts.length === 0 || bounds.min[0] > bounds.max[0]) {
    return { layers: [], normalAxis: 1 };
  }

  const normalAxis = normalAxisOf(bounds);
  const bands = bandsFor(parts, normalAxis);
  if (bands.length === 0) return { layers: [], normalAxis };

  const frameIndex = frameBandIndex(bands, parts);

  const layers = bands.map((band, index) => {
    let id;
    let name;
    if (index === frameIndex) {
      id = 'RW';
      name = 'Rahmenwerk';
    } else if (index > frameIndex) {
      const n = index - frameIndex;
      id = `BS${n}`;
      name = `Beplankung Seite ${n}`;
    } else {
      const n = frameIndex - index;
      id = `IS${n}`;
      name = `Innenseite ${n}`;
    }
    return {
      id,
      name,
      partIDs: [...band.partIDs].sort((a, b) => a - b),
      normalRange: [band.lower, band.upper],
      thickness: band.upper - band.lower,
      colour: id === 'RW' ? FRAME_COLOUR : SHEATHING_COLOURS[index % SHEATHING_COLOURS.length],
    };
  });

  const byPart = new Map();
  for (const layer of layers) {
    for (const partID of layer.partIDs) byPart.set(partID, layer.id);
  }
  for (const part of parts) part.layerID = byPart.get(part.id) || '';

  return { layers, normalAxis };
}

export function layerSummary(layer, doc) {
  const parts = doc.parts.filter((part) => part.layerID === layer.id);
  return {
    partCount: parts.length,
    totalWeight: parts.reduce((sum, part) => sum + part.weight * part.count, 0),
    materials: [...new Set(parts.map((part) => part.material))].filter(Boolean).sort(),
    designations: [...new Set(parts.map((part) => part.designation))].sort(),
  };
}
