// Derives build-up layers (Schichtaufbau) from part geometry.
//
// BTLX has no layer attribute describing the build-up, so layers are reconstructed the way
// a timber element is actually built: parts are projected onto the element normal and
// grouped into bands of overlapping extent. The normal comes from the element's own frame,
// not from a world axis, so a wall rotated in plan is read correctly.
//
// The band holding the structural framing becomes RW (Rahmenwerk). Bands stacked outwards
// from it become BS1, BS2 … (Beplankung Seite 1 …), bands on the opposite face
// IS1, IS2 … (Innenseite …).

/** Two bands are merged when they overlap by more than this, in millimetres. */
const OVERLAP_TOLERANCE = 1.0;

const FRAME_COLOUR = [0.78, 0.58, 0.33];
const SHEATHING_COLOURS = [
  [0.42, 0.62, 0.76],
  [0.55, 0.72, 0.52],
  [0.8, 0.55, 0.55],
  [0.66, 0.58, 0.78],
  [0.85, 0.72, 0.4],
  [0.5, 0.74, 0.74],
];

/**
 * Designations that mark a load-bearing member. Thickness alone is not enough to find the
 * framing: a ventilated facade's battens and cladding can span a deeper band than the studs
 * they are fixed to, so the structural members themselves have to be recognised.
 */
const FRAMING_PATTERN =
  /st(ä|ae|a)nder|stiel|st(ü|ue)tze|pfosten|r(ä|ae)hm|schwelle|riegel|sturz|br(ü|ue)stung|unterzug|(ü|ue)berzug|balken|tr(ä|ae)ger|pfette|sparren|fusspfette|rippe/i;

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
 * load-bearing members it contains, then by weight, and only as a last resort by thickness.
 */
function frameBandIndex(bands, parts) {
  const byID = new Map(parts.map((part) => [part.id, part]));

  // Ranked lexicographically: structural members first, then weight, then thickness.
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

export function classifyLayers(parts, frame) {
  if (!parts.length) return [];

  const bands = bandsFor(parts);
  if (!bands.length) return [];

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
