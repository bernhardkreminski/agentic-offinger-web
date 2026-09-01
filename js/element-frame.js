// Derives the element's own coordinate frame from the parts' orientations.
//
// A wall is rarely aligned with the world axes — as soon as it runs at an angle in plan,
// its axis-aligned bounding box says nothing useful about its thickness. Every band, every
// dimension chain and every standard view therefore works in the element's frame:
//
//   normal      across the build-up (the true element thickness)
//   vertical    in-plane, as close to world up as the geometry allows
//   horizontal  in-plane, along the length
//
// The candidate directions come from the parts themselves: whatever a wall is rotated by,
// its studs and panels are still built on its own axes.

import { cross, dot, length as vecLength, normalize, scale, sub } from './vec3.js';

/** Two directions this aligned are treated as one candidate. */
const PARALLEL = 0.9999;
/** A candidate counts as in-plane when its component along the normal is under this. */
const PERPENDICULAR = 0.02;
/** Beyond this the element is treated as free-form and the search is capped. */
const MAX_CANDIDATES = 32;
/** Under this a direction counts as a world axis, and gets the friendlier label. */
const AXIS_TOLERANCE = 1e-4;

const WORLD_AXES = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** Collapses a direction and its opposite onto one representative. */
function canonical(v) {
  const [x, y, z] = v;
  if (x < -1e-9) return [-x, -y, -z];
  if (Math.abs(x) <= 1e-9 && y < -1e-9) return [-x, -y, -z];
  if (Math.abs(x) <= 1e-9 && Math.abs(y) <= 1e-9 && z < 0) return [-x, -y, -z];
  return [x, y, z];
}

/**
 * Directions worth testing, most-used first: every distinct part axis, plus the world
 * axes so an element with no usable orientation still gets a sensible answer.
 */
function candidateDirections(parts) {
  const found = [];
  const bump = (axis) => {
    const direction = canonical(normalize(axis));
    if (!Number.isFinite(direction[0])) return;
    const existing = found.find((entry) => Math.abs(dot(direction, entry.direction)) > PARALLEL);
    if (existing) existing.weight += 1;
    else found.push({ direction, weight: 1 });
  };

  for (const part of parts) {
    bump(part.xAxis);
    bump(part.yAxis);
    bump(part.zAxis);
  }
  for (const axis of WORLD_AXES) bump(axis);

  found.sort((a, b) => b.weight - a.weight);
  return found.slice(0, MAX_CANDIDATES).map((entry) => entry.direction);
}

/** Extent of every part's geometry projected onto one direction. */
function extentAlong(parts, direction) {
  let min = Infinity;
  let max = -Infinity;
  for (const part of parts) {
    const points = part.worldPoints;
    for (let i = 0; i < points.length; i += 3) {
      const d = points[i] * direction[0] + points[i + 1] * direction[1] + points[i + 2] * direction[2];
      if (d < min) min = d;
      if (d > max) max = d;
    }
  }
  return max - min;
}

const isWorldAxis = (v) =>
  WORLD_AXES.findIndex((axis) => Math.abs(Math.abs(dot(v, axis)) - 1) < AXIS_TOLERANCE);

export function deriveElementFrame(parts) {
  const fallback = {
    normal: [0, 1, 0],
    vertical: [0, 0, 1],
    horizontal: [1, 0, 0],
    thickness: 0,
    axisAligned: true,
    description: 'Achse Y',
  };
  if (!parts.length) return fallback;

  const candidates = candidateDirections(parts);
  if (!candidates.length) return fallback;

  // The build-up direction is simply the one the element is thinnest along.
  let normal = candidates[0];
  let thickness = Infinity;
  for (const direction of candidates) {
    const extent = extentAlong(parts, direction);
    if (extent < thickness) {
      thickness = extent;
      normal = direction;
    }
  }

  // In-plane and as upright as the geometry allows, so elevations read the right way up.
  let vertical = null;
  let bestUp = -1;
  for (const direction of candidates) {
    if (Math.abs(dot(direction, normal)) > PERPENDICULAR) continue;
    const upness = Math.abs(direction[2]);
    if (upness > bestUp) {
      bestUp = upness;
      vertical = direction;
    }
  }
  if (!vertical) {
    // Nothing usable in the candidate set: strip the normal out of world up instead.
    const up = Math.abs(normal[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    vertical = normalize(sub(up, scale(normal, dot(normal, up))));
  }
  if (vertical[2] < -1e-9) vertical = scale(vertical, -1);

  const horizontal = normalize(cross(normal, vertical));
  const axisIndex = isWorldAxis(normal);

  return {
    normal,
    vertical,
    horizontal,
    thickness,
    axisAligned: axisIndex >= 0,
    description:
      axisIndex >= 0
        ? `Achse ${'XYZ'[axisIndex]}`
        : `Normale ${normal.map((n) => n.toFixed(3)).join(' / ')}`,
  };
}

/** Where a part sits in the element frame: [min, max] along each of the three directions. */
export function frameExtentsOf(part, frame) {
  const points = part.worldPoints;
  const span = { n: [Infinity, -Infinity], h: [Infinity, -Infinity], v: [Infinity, -Infinity] };
  const dirs = [
    ['n', frame.normal],
    ['h', frame.horizontal],
    ['v', frame.vertical],
  ];
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    const z = points[i + 2];
    for (const [key, dir] of dirs) {
      const d = x * dir[0] + y * dir[1] + z * dir[2];
      const range = span[key];
      if (d < range[0]) range[0] = d;
      if (d > range[1]) range[1] = d;
    }
  }
  return span;
}

/** Rebuilds a world point from frame coordinates. */
export function framePoint(frame, h, v, n) {
  return [
    frame.horizontal[0] * h + frame.vertical[0] * v + frame.normal[0] * n,
    frame.horizontal[1] * h + frame.vertical[1] * v + frame.normal[1] * n,
    frame.horizontal[2] * h + frame.vertical[2] * v + frame.normal[2] * n,
  ];
}

/**
 * Re-aligns the frame so its horizontal follows the longest member of the load-bearing
 * layer — the wall's own long side, which is what the element is set out from. The
 * candidate search above only bootstraps the frame; this pins it to the Riegelwerk.
 */
export function alignToFraming(framingParts, frame, allParts) {
  let longest = null;
  let longestExtent = 0;
  for (const part of framingParts) {
    for (const axis of [part.xAxis, part.yAxis, part.zAxis]) {
      const extent = extentAlong([part], axis);
      if (extent > longestExtent) {
        longestExtent = extent;
        longest = axis;
      }
    }
  }
  if (!longest) return frame;

  const along = normalize(longest);
  const worldUp = [0, 0, 1];
  let vertical = sub(worldUp, scale(along, dot(along, worldUp)));
  vertical = vecLength(vertical) < 1e-6 ? frame.vertical : normalize(vertical);

  // Canonicalising the normal makes the result independent of which way round the
  // member happens to be modelled.
  const normal = canonical(normalize(cross(vertical, along)));
  const horizontal = normalize(cross(normal, vertical));
  const axisIndex = isWorldAxis(normal);

  return {
    normal,
    vertical,
    horizontal,
    thickness: extentAlong(allParts, normal),
    axisAligned: axisIndex >= 0,
    description:
      axisIndex >= 0
        ? `Achse ${'XYZ'[axisIndex]}`
        : `Normale ${normal.map((n) => n.toFixed(3)).join(' / ')}`,
  };
}
