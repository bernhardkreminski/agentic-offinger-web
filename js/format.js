// Number formatting shared by the drawing overlay and the inspector.

export function mm(value) {
  return Math.abs(Math.round(value) - value) < 0.0005
    ? String(Math.round(value))
    : value.toFixed(1);
}

export const kg = (value) => `${value.toFixed(2)} kg`;

export const point = (p) => `X ${mm(p[0])}  Y ${mm(p[1])}  Z ${mm(p[2])}`;

export const crossSection = (part) => `${mm(part.width)} × ${mm(part.height)} mm`;

export const listLabel = (part) =>
  part.singleMemberNumber ? `${part.singleMemberNumber} · ${part.designation}` : part.designation;
