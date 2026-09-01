// Minimal vector helpers, so parsing and layer derivation stay independent of three.js.

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const length = (a) => Math.hypot(a[0], a[1], a[2]);

export function normalize(a) {
  const l = length(a);
  return l > 0 ? scale(a, 1 / l) : [0, 0, 0];
}

export const distance = (a, b) => length(sub(a, b));
