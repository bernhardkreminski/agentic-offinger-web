// Determines the build-up layers (Schichtaufbau) of an element.
//
// Preferred source is the file itself: cadwork exports <Composites><Layers> with one
// <Layer> per build-up layer, and every <Part> carries the matching layer number. That is
// the authoritative Schichtzuordnung and is used whenever it is present.
//
// Files without that block (plain part lists) fall back to geometry: parts are projected
// onto the element normal and grouped into bands of overlapping extent.
//
// Codes follow the cadwork naming: RW for the Riegelwerk / Tragschicht (layer 0),
// BS n for the Bundseitenschichten (positive) and GS n for the Gegenseitenschichten
// (negative).

/** Two bands are merged when they overlap by more than this, in millimetres. */
const OVERLAP_TOLERANCE = 1.0;

const FRAME_COLOUR = [0.78, 0.58, 0.33];
const UNASSIGNED_COLOUR = [0.62, 0.62, 0.66];
const LAYER_COLOURS = [
  [0.42, 0.62, 0.76],
  [0.55, 0.72, 0.52],
  [0.8, 0.55, 0.55],
  [0.66, 0.58, 0.78],
  [0.85, 0.72, 0.4],
  [0.5, 0.74, 0.74],
  [0.76, 0.6, 0.72],
];

/**
 * Designations that mark a load-bearing member. Thickness alone cannot find the framing:
 * a ventilated facade's battens can span a deeper band than the studs they are fixed to.
 */
const FRAMING_PATTERN =
  /st(ä|ae|a)nder|stiel|st(ü|ue)tze|pfosten|r(ä|ae)hm|schwelle|riegel|sturz|br(ü|ue)stung|unterzug|(ü|ue)berzug|balken|tr(ä|ae)ger|pfette|sparren|rippe/i;

const codeFor = (number) => {
  if (number === 0) return 'RW';
  return number > 0 ? `BS${number}` : `GS${-number}`;
};

const colourFor = (number, index) =>
  number === 0 ? FRAME_COLOUR : LAYER_COLOURS[Math.abs(index) % LAYER_COLOURS.length];

// MARK: - Declared layers

/** True when the file states its own build-up and the parts reference it. */
export function hasDeclaredLayers(declared, parts) {
  return declared.length > 0 && parts.some((part) => part.layerNumber !== null);
}

function fromDeclared(declared, parts) {
  const byNumber = new Map(declared.map((layer) => [layer.number, layer]));
  const grouped = new Map();

  for (const part of parts) {
    const number = part.layerNumber;
    if (number === null || !byNumber.has(number)) continue;
    if (!grouped.has(number)) grouped.set(number, []);
    grouped.get(number).push(part.id);
  }

  const layers = [...grouped.entries()].map(([number, partIDs], index) => {
    const declaration = byNumber.get(number);
    return {
      id: codeFor(number),
      name: declaration.designation || codeFor(number),
      number,
      partIDs: partIDs.sort((a, b) => a - b),
      declaredThickness: declaration.height,
      colour: colourFor(number, index),
    };
  });

  // Parts the file leaves out of the build-up — fittings, infill, trims — stay visible
  // as their own group rather than being silently invented into a layer.
  const spare = parts.filter((part) => part.layerNumber === null || !byNumber.has(part.layerNumber));
  if (spare.length) {
    layers.push({
      id: 'NZ',
      name: 'Nicht zugeordnet',
      number: null,
      partIDs: spare.map((part) => part.id).sort((a, b) => a - b),
      declaredThickness: null,
      colour: UNASSIGNED_COLOUR,
    });
  }
  return layers;
}

// MARK: - Geometric fallback

/** Sweep the parts along the normal and merge those whose extents overlap. */
function bandsFor(parts) {
  const sorted = [...parts].sort((a, b) => a.frameSpan.n[0] - b.frameSpan.n[0]);
  const bands = [];
  for (const part of sorted) {
    const [lower, upper] = part.frameSpan.n;
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
 * The framing band is the one that actually carries the element: first by how many
 * load-bearing members it holds, then by weight, and only as a last resort by thickness.
 */
function frameBandIndex(bands, parts) {
  const byID = new Map(parts.map((part) => [part.id, part]));

  const outranks = (a, b) => {
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] > b[i] + 1e-9) return true;
      if (a[i] < b[i] - 1e-9) return false;
    }
    return false;
  };

  let best = 0;
  let bestScore = null;

  bands.forEach((band, index) => {
    const members = band.partIDs.map((id) => byID.get(id)).filter(Boolean);
    const score = [
      members.filter((part) => FRAMING_PATTERN.test(part.designation)).length,
      members.reduce((sum, part) => sum + part.weight * part.count, 0),
      band.upper - band.lower,
    ];
    if (!bestScore || outranks(score, bestScore)) {
      best = index;
      bestScore = score;
    }
  });
  return best;
}

function fromGeometry(parts) {
  const bands = bandsFor(parts);
  if (!bands.length) return [];
  const frameIndex = frameBandIndex(bands, parts);

  return bands.map((band, index) => {
    const number = index - frameIndex;
    return {
      id: codeFor(number),
      name:
        number === 0
          ? 'Riegelwerk'
          : number > 0
            ? `Bundseitenschicht ${number}`
            : `Gegenseitenschicht ${-number}`,
      number,
      partIDs: [...band.partIDs].sort((a, b) => a - b),
      declaredThickness: null,
      colour: colourFor(number, index),
    };
  });
}

// MARK: - Entry point

export function classifyLayers(parts, declared) {
  if (!parts.length) return [];
  const stated = hasDeclaredLayers(declared, parts);
  const layers = stated ? fromDeclared(declared, parts) : fromGeometry(parts);
  layers.source = stated ? 'declared' : 'geometry';

  const byPart = new Map();
  for (const layer of layers) {
    for (const partID of layer.partIDs) byPart.set(partID, layer.id);
  }
  for (const part of parts) part.layerID = byPart.get(part.id) || '';
  return layers;
}

/** Fills in each layer's position across the build-up, once the frame is settled. */
export function measureLayers(layers, parts) {
  const byID = new Map(parts.map((part) => [part.id, part]));
  for (const layer of layers) {
    let lower = Infinity;
    let upper = -Infinity;
    for (const id of layer.partIDs) {
      const part = byID.get(id);
      if (!part) continue;
      lower = Math.min(lower, part.frameSpan.n[0]);
      upper = Math.max(upper, part.frameSpan.n[1]);
    }
    layer.normalRange = [lower, upper];
    layer.thickness = Number.isFinite(upper - lower) ? upper - lower : 0;
  }
  // Present them in build-up order. Where the file states the layer numbers those are
  // authoritative — partial layers can otherwise sort out of sequence by geometry alone.
  const source = layers.source;
  layers.sort((a, b) => {
    if (a.number === null) return 1;
    if (b.number === null) return -1;
    return source === 'declared' ? b.number - a.number : a.normalRange[0] - b.normalRange[0];
  });
  layers.source = source;
  return layers;
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
