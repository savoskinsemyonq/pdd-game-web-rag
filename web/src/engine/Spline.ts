import type { Spline, SplineKey } from "../types";

export interface SampleResult {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const EPS = 1e-6;

function hermiteSegment(
  k0: SplineKey,
  k1: SplineKey,
  s: number
): { x: number; y: number; vx: number; vy: number } {
  const dt = Math.max(EPS, k1.t - k0.t);
  const u = Math.min(1, Math.max(0, s));
  const u2 = u * u;
  const u3 = u2 * u;

  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;

  const x = h00 * k0.dx + h10 * k0.tx + h01 * k1.dx + h11 * k1.tx;
  const y = h00 * k0.dy + h10 * k0.ty + h01 * k1.dy + h11 * k1.ty;

  const dh00 = (6 * u2 - 6 * u) / dt;
  const dh10 = (3 * u2 - 4 * u + 1) / dt;
  const dh01 = (-6 * u2 + 6 * u) / dt;
  const dh11 = (3 * u2 - 2 * u) / dt;

  const vx = dh00 * k0.dx + dh10 * k0.tx + dh01 * k1.dx + dh11 * k1.tx;
  const vy = dh00 * k0.dy + dh10 * k0.ty + dh01 * k1.dy + dh11 * k1.ty;

  return { x, y, vx, vy };
}

export function sampleSpline(spline: Spline, tMs: number): SampleResult {
  const keys = [...spline.keys].sort((a, b) => a.t - b.t);
  if (keys.length === 0) return { x: 0, y: 0, vx: 0, vy: 0 };
  if (keys.length === 1) {
    return { x: keys[0].dx, y: keys[0].dy, vx: keys[0].tx, vy: keys[0].ty };
  }
  const tMin = keys[0].t;
  const tMax = keys[keys.length - 1].t;
  const tauRaw = tMs + Math.min(0, tMin);
  const tau = Math.max(tMin, Math.min(tMax, tauRaw));

  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t < tau) i++;
  if (i >= keys.length - 1) {
    const last = keys[keys.length - 1];
    return { x: last.dx, y: last.dy, vx: last.tx, vy: last.ty };
  }
  const k0 = keys[i];
  const k1 = keys[i + 1];
  const span = Math.max(EPS, k1.t - k0.t);
  const u = (tau - k0.t) / span;
  const seg = hermiteSegment(k0, k1, u);
  return seg;
}

export function splineDuration(spline: Spline): number {
  const keys = [...spline.keys].sort((a, b) => a.t - b.t);
  if (keys.length <= 1) return 0;
  const tMin = keys[0].t;
  const tMax = keys[keys.length - 1].t;
  const elapsedToReachTauMax =
    tMin > 0 ? tMax : tMax - Math.min(0, tMin);
  return Math.max(0, elapsedToReachTauMax);
}

export function splineStartTime(spline: Spline): number {
  const keys = [...spline.keys].sort((a, b) => a.t - b.t);
  if (keys.length === 0) return 0;
  return keys[0].t;
}
