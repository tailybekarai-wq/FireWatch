// Colour classes for the regions map, shared by the server page (legend, list) and the map.
export const REGION_RAMP = ["#1A2630", "#5A4A2E", "#B9772E", "#FF7A3D", "#FF4D5E"];

/** Upper bounds of the 1st, 2nd and 3rd quartile of the non-zero values (classes 1..4). */
export function quartiles(values: number[]) {
  const v = values.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return [0, 0, 0];
  return [0.25, 0.5, 0.75].map((q) => v[Math.min(v.length - 1, Math.floor(q * (v.length - 1)))]);
}

/** Class of a value: 0 for zero, then 1..4 by the quartile upper bounds in `breaks`. */
export function regionClass(v: number, breaks: number[]) {
  if (v <= 0) return 0;
  const i = breaks.findIndex((b) => v <= b);
  return i < 0 ? REGION_RAMP.length - 1 : Math.min(REGION_RAMP.length - 1, i + 1);
}
