/** Dark twin-track tram rails (top-down), world px. */
export const DEFAULT_TRAM_RAIL_COLOR = "#1c1c1f";
export const DEFAULT_TRAM_RAIL_WIDTH = 2.5;
/** Two close pairs with a wider gap between pairs (matches thin parallel rails look). */
export const DEFAULT_TRAM_RAIL_OFFSETS: readonly number[] = [-11.5, -4, 4, 11.5];

function unitTangentAt(pts: [number, number][], i: number): { tx: number; ty: number } {
  if (pts.length < 2) return { tx: 1, ty: 0 };
  if (i === 0) {
    const dx = pts[1]![0] - pts[0]![0];
    const dy = pts[1]![1] - pts[0]![1];
    const len = Math.hypot(dx, dy);
    return len > 1e-9 ? { tx: dx / len, ty: dy / len } : { tx: 1, ty: 0 };
  }
  if (i === pts.length - 1) {
    const dx = pts[i]![0] - pts[i - 1]![0];
    const dy = pts[i]![1] - pts[i - 1]![1];
    const len = Math.hypot(dx, dy);
    return len > 1e-9 ? { tx: dx / len, ty: dy / len } : { tx: 1, ty: 0 };
  }
  const dx1 = pts[i]![0] - pts[i - 1]![0];
  const dy1 = pts[i]![1] - pts[i - 1]![1];
  const dx2 = pts[i + 1]![0] - pts[i]![0];
  const dy2 = pts[i + 1]![1] - pts[i]![1];
  const l1 = Math.hypot(dx1, dy1);
  const l2 = Math.hypot(dx2, dy2);
  if (l1 < 1e-9 && l2 < 1e-9) return { tx: 1, ty: 0 };
  let tx = (l1 > 1e-9 ? dx1 / l1 : 0) + (l2 > 1e-9 ? dx2 / l2 : 0);
  let ty = (l1 > 1e-9 ? dy1 / l1 : 0) + (l2 > 1e-9 ? dy2 / l2 : 0);
  const len = Math.hypot(tx, ty);
  if (len < 1e-9) return unitTangentAt(pts, i - 1);
  return { tx: tx / len, ty: ty / len };
}

/** Offset polyline along averaged vertex normals (works for smooth curved paths). */
export function offsetPolylineParallel(pts: [number, number][], offset: number): [number, number][] {
  if (pts.length < 2 || Math.abs(offset) < 1e-9) return pts.map((p) => [p[0], p[1]]);
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const { tx, ty } = unitTangentAt(pts, i);
    const nx = -ty;
    const ny = tx;
    out.push([pts[i]![0] + nx * offset, pts[i]![1] + ny * offset]);
  }
  return out;
}

export function tramTrackRailPolylines(
  centerline: [number, number][],
  offsets: readonly number[] = DEFAULT_TRAM_RAIL_OFFSETS,
): [number, number][][] {
  return offsets.map((o) => offsetPolylineParallel(centerline, o));
}

export function polylinePointsAttr(pts: [number, number][]): string {
  return pts.map((p) => `${p[0]},${p[1]}`).join(" ");
}

export function polylineWorldLength(pts: [number, number][]): number {
  let sum = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    sum += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return sum;
}
