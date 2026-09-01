// Turns BTLX polygon soup into three.js geometry. Mirrors GeometryFactory.swift.
//
// Faces arrive as arbitrary planar index loops, so they are triangulated by ear clipping
// in the face plane. Vertices are written out per triangle rather than shared, which gives
// every face its own normal — the flat, hard-edged shading a shop drawing needs, with no
// smoothing across the corners of a stud.

import * as THREE from 'three';

/** Newell's method: robust for any planar polygon, convex or not. */
function newellNormal(loop) {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(nx, ny, nz);
  return l > 0 ? [nx / l, ny / l, nz / l] : [0, 0, 0];
}

function dominantAxis(v) {
  const a = [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])];
  if (a[0] >= a[1] && a[0] >= a[2]) return 0;
  return a[1] >= a[2] ? 1 : 2;
}

const cross2 = (u, v) => u[0] * v[1] - u[1] * v[0];

function pointInTriangle(p, a, b, c) {
  const d1 = cross2([b[0] - a[0], b[1] - a[1]], [p[0] - a[0], p[1] - a[1]]);
  const d2 = cross2([c[0] - b[0], c[1] - b[1]], [p[0] - b[0], p[1] - b[1]]);
  const d3 = cross2([a[0] - c[0], a[1] - c[1]], [p[0] - c[0], p[1] - c[1]]);
  return d1 >= -1e-12 && d2 >= -1e-12 && d3 >= -1e-12;
}

function triangulate(loop, normal) {
  if (loop.length === 3) return [loop];

  // Project onto the plane by dropping the axis the normal points most strongly along.
  const drop = dominantAxis(normal);
  const flip = normal[drop] < 0;
  const flatten = (p) => {
    switch (drop) {
      case 0:
        return flip ? [p[2], p[1]] : [p[1], p[2]];
      case 1:
        return flip ? [p[0], p[2]] : [p[2], p[0]];
      default:
        return flip ? [p[1], p[0]] : [p[0], p[1]];
    }
  };

  const flat = loop.map(flatten);
  let remaining = loop.map((_, i) => i);
  const triangles = [];
  let guard = 0;

  const isEar = (a, b, c) => {
    const pa = flat[a];
    const pb = flat[b];
    const pc = flat[c];
    const area = cross2([pb[0] - pa[0], pb[1] - pa[1]], [pc[0] - pa[0], pc[1] - pa[1]]);
    if (area <= 1e-9) return false; // reflex or collinear
    return !remaining.some(
      (index) => index !== a && index !== b && index !== c && pointInTriangle(flat[index], pa, pb, pc),
    );
  };

  while (remaining.length > 3 && guard < loop.length * loop.length) {
    guard += 1;
    let clipped = false;
    for (let i = 0; i < remaining.length; i += 1) {
      const prev = remaining[(i + remaining.length - 1) % remaining.length];
      const curr = remaining[i];
      const next = remaining[(i + 1) % remaining.length];
      if (!isEar(prev, curr, next)) continue;
      triangles.push([loop[prev], loop[curr], loop[next]]);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }
    // Degenerate or self-intersecting outline: fall back to a fan below so the face is
    // still drawn rather than silently dropped.
    if (!clipped) break;
  }

  if (remaining.length === 3) {
    triangles.push([loop[remaining[0]], loop[remaining[1]], loop[remaining[2]]]);
  } else if (remaining.length > 3) {
    for (let i = 1; i < remaining.length - 1; i += 1) {
      triangles.push([loop[remaining[0]], loop[remaining[i]], loop[remaining[i + 1]]]);
    }
  }
  return triangles;
}

export function solidGeometry(mesh) {
  if (!mesh.points.length || !mesh.faces.length) return null;

  const positions = [];
  const normals = [];

  for (const face of mesh.faces) {
    const loop = face.filter((i) => i < mesh.points.length).map((i) => mesh.points[i]);
    if (loop.length < 3) continue;
    const normal = newellNormal(loop);
    if (Math.hypot(normal[0], normal[1], normal[2]) < 1e-12) continue;

    for (const triangle of triangulate(loop, normal)) {
      for (const p of triangle) {
        positions.push(p[0], p[1], p[2]);
        normals.push(normal[0], normal[1], normal[2]);
      }
    }
  }
  if (!positions.length) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return geometry;
}

/**
 * The face boundaries as a line set, drawn over the solid so parts read as discrete
 * members instead of one shaded mass.
 */
export function edgeGeometry(mesh) {
  if (!mesh.points.length || !mesh.faces.length) return null;

  const seen = new Set();
  const positions = [];

  for (const face of mesh.faces) {
    if (face.length < 2) continue;
    for (let i = 0; i < face.length; i += 1) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      if (a >= mesh.points.length || b >= mesh.points.length || a === b) continue;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pa = mesh.points[a];
      const pb = mesh.points[b];
      positions.push(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]);
    }
  }
  if (!positions.length) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}
