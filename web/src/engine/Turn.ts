import type { Turn } from "../types";

export function angleFromMotion(vx: number, vy: number, fallback = 0): number {
  if (Math.abs(vx) < 1e-4 && Math.abs(vy) < 1e-4) return fallback;
  return Math.atan2(vy, vx);
}

export function smoothAngle(prev: number, target: number, alpha: number): number {
  let delta = target - prev;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return prev + delta * Math.min(1, Math.max(0, alpha));
}

export function sampleTurn(turn: Turn, _tMs: number): number | null {
  if (turn.keys.length === 0) return null;
  return null;
}
