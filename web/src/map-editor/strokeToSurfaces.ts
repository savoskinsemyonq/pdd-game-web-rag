import type { SurfaceKind, SurfaceShape } from "../state/compositeStore";

/** Minimum sampling step along pointer drag (world px) — avoids huge vertex counts. */
export const STROKE_SAMPLE_STEP_WORLD = 5;

/** Ignore segments shorter than this (world px). */
const MIN_SEGMENT_LEN = 0.5;

/** Merge almost-duplicate vertices from dense sampling (world px). */
const DEDUPE_EPS = 0.12;

/** Sides for round caps / joint discs (fills gaps between segment quads). */
const JOINT_DISC_SIDES = 20;

function dedupeVertices(points: readonly [number, number][], eps: number): [number, number][] {
  const out: [number, number][] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= eps) {
      out.push([p[0], p[1]]);
    }
  }
  return out;
}

/** Regular polygon approximating a filled disc (road cap / joint). */
function discPolygon(cx: number, cy: number, r: number, sides: number): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i < sides; i++) {
    const a = (-Math.PI / 2) + (i / sides) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/**
 * Turn a polyline into corridor geometry: segment quads plus a disc at each vertex
 * so corners and ends match round-cap stroke previews (no wedges / clipped ends).
 */
export function polylineStrokeToSurfaces(
  points: readonly [number, number][],
  widthWorld: number,
  kind: SurfaceKind,
): SurfaceShape[] {
  const hw = Math.max(4, widthWorld / 2);
  const cleaned = dedupeVertices(points, DEDUPE_EPS);
  if (cleaned.length === 0) return [];

  if (cleaned.length === 1) {
    const [x, y] = cleaned[0]!;
    return [{ kind, points: discPolygon(x, y, hw, JOINT_DISC_SIDES) }];
  }

  const out: SurfaceShape[] = [];

  for (let i = 0; i < cleaned.length - 1; i++) {
    const [x1, y1] = cleaned[i]!;
    const [x2, y2] = cleaned[i + 1]!;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < MIN_SEGMENT_LEN) continue;
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy * hw;
    const py = ux * hw;
    const quad: number[][] = [
      [x1 - px, y1 - py],
      [x1 + px, y1 + py],
      [x2 + px, y2 + py],
      [x2 - px, y2 - py],
    ];
    out.push({ kind, points: quad });
  }

  for (let i = 0; i < cleaned.length; i++) {
    const [x, y] = cleaned[i]!;
    out.push({ kind, points: discPolygon(x, y, hw, JOINT_DISC_SIDES) });
  }

  return out;
}
