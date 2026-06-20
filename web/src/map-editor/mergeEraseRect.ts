import type {
  CompositeOverrides,
  CompositeScene,
  CompositeSprite,
  MarkingShape,
  SurfaceShape,
} from "../state/compositeStore";

interface Aabb {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

type Pt = [number, number];

/** Décor / окно: целиком стираем при любом реальном пересечении с ластиком. */
const SMALL_POLY_AREA = 22_000;
/** Крупный полигон удаляем только если доля площади внутри ластика ≥ этого порога. */
const LARGE_POLY_MIN_OVERLAP_FRAC = 0.24;

function aabbIntersect(a: Aabb, b: Aabb): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

function ringBBox(points: number[][]): Aabb | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.length < 2) continue;
    minX = Math.min(minX, p[0]!);
    maxX = Math.max(maxX, p[0]!);
    minY = Math.min(minY, p[1]!);
    maxY = Math.max(maxY, p[1]!);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function shoelaceArea(ring: number[][]): number {
  const n = ring.length;
  if (n < 3) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += ring[i]![0]! * ring[j]![1]! - ring[j]![0]! * ring[i]![1]!;
  }
  return Math.abs(s / 2);
}

function pointInRect(px: number, py: number, r: Aabb): boolean {
  return px >= r.minX && px <= r.maxX && py >= r.minY && py <= r.maxY;
}

function pointInPolygon(px: number, py: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    const denom = yj - yi + 1e-18;
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / denom + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Liang–Barsky: отрезок пересекает замкнутый прямоугольник. */
function segmentIntersectsAabb(ax: number, ay: number, bx: number, by: number, r: Aabb): boolean {
  let u1 = 0;
  let u2 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) return q >= -1e-9;
    const t = q / p;
    if (p < 0) {
      if (t > u2) return false;
      if (t > u1) u1 = t;
    } else {
      if (t < u1) return false;
      if (t < u2) u2 = t;
    }
    return true;
  };
  if (!clip(-dx, ax - r.minX)) return false;
  if (!clip(dx, r.maxX - ax)) return false;
  if (!clip(-dy, ay - r.minY)) return false;
  if (!clip(dy, r.maxY - ay)) return false;
  return u1 <= u2 + 1e-9;
}

function polygonGeometricIntersectsRect(ring: number[][], rect: Aabb): boolean {
  if (ring.length === 0) return false;
  for (const p of ring) {
    if (p.length >= 2 && pointInRect(p[0]!, p[1]!, rect)) return true;
  }
  const corners: Pt[] = [
    [rect.minX, rect.minY],
    [rect.maxX, rect.minY],
    [rect.maxX, rect.maxY],
    [rect.minX, rect.maxY],
  ];
  for (const c of corners) {
    if (pointInPolygon(c[0], c[1], ring)) return true;
  }
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.length < 2 || b.length < 2) continue;
    if (segmentIntersectsAabb(a[0]!, a[1]!, b[0]!, b[1]!, rect)) return true;
  }
  return false;
}

function intersectSegVertical(s: Pt, e: Pt, x: number): Pt | null {
  const dx = e[0] - s[0];
  if (Math.abs(dx) < 1e-12) return null;
  const t = (x - s[0]) / dx;
  if (t < -1e-9 || t > 1 + 1e-9) return null;
  return [x, s[1] + t * (e[1] - s[1])];
}

function intersectSegHorizontal(s: Pt, e: Pt, y: number): Pt | null {
  const dy = e[1] - s[1];
  if (Math.abs(dy) < 1e-12) return null;
  const t = (y - s[1]) / dy;
  if (t < -1e-9 || t > 1 + 1e-9) return null;
  return [s[0] + t * (e[0] - s[0]), y];
}

function clipPolygonToRect(poly: number[][], r: Aabb): Pt[] {
  const clip = (
    pts: Pt[],
    inside: (p: Pt) => boolean,
    intersect: (s: Pt, e: Pt) => Pt | null,
  ): Pt[] => {
    const out: Pt[] = [];
    if (pts.length === 0) return out;
    let prev = pts[pts.length - 1]!;
    let prevIn = inside(prev);
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i]!;
      const curIn = inside(cur);
      if (curIn) {
        if (!prevIn) {
          const ix = intersect(prev, cur);
          if (ix) out.push(ix);
        }
        out.push(cur);
      } else if (prevIn) {
        const ix = intersect(prev, cur);
        if (ix) out.push(ix);
      }
      prev = cur;
      prevIn = curIn;
    }
    return out;
  };

  let pts: Pt[] = poly.map((p) => [p[0]!, p[1]!]);
  if (pts.length < 3) return [];

  pts = clip(pts, (p) => p[0] >= r.minX, (s, e) => intersectSegVertical(s, e, r.minX));
  pts = clip(pts, (p) => p[0] <= r.maxX, (s, e) => intersectSegVertical(s, e, r.maxX));
  pts = clip(pts, (p) => p[1] >= r.minY, (s, e) => intersectSegHorizontal(s, e, r.minY));
  pts = clip(pts, (p) => p[1] <= r.maxY, (s, e) => intersectSegHorizontal(s, e, r.maxY));

  return pts;
}

function polygonEraseDecision(ring: number[][], er: Aabb): boolean {
  if (!polygonGeometricIntersectsRect(ring, er)) return false;
  const polyArea = shoelaceArea(ring);
  const clipped = clipPolygonToRect(ring, er);
  const clippedArea = shoelaceArea(clipped.map((p) => [p[0], p[1]]));
  if (clippedArea < 1e-6) return false;
  if (polyArea <= SMALL_POLY_AREA) return true;
  return clippedArea / polyArea >= LARGE_POLY_MIN_OVERLAP_FRAC;
}

function crosswalkAsRing(m: Extract<MarkingShape, { type: "crosswalk" }>): number[][] {
  return [
    [m.x, m.y],
    [m.x + m.w, m.y],
    [m.x + m.w, m.y + m.h],
    [m.x, m.y + m.h],
  ];
}

function lineStrokeHitsRect(m: Extract<MarkingShape, { type: "line" }>, er: Aabb): boolean {
  const hw = (m.width ?? 6) / 2 + 0.5;
  const inflated: Aabb = {
    minX: er.minX - hw,
    maxX: er.maxX + hw,
    minY: er.minY - hw,
    maxY: er.maxY + hw,
  };
  return segmentIntersectsAabb(m.x1, m.y1, m.x2, m.y2, inflated);
}

/** Центральная линия трамвая + запас под ширину рельсов */
function tramTrackHitsRect(m: Extract<MarkingShape, { type: "tram_track" }>, er: Aabb): boolean {
  const pts = m.points.filter((p) => p.length >= 2);
  if (pts.length < 2) return false;
  const pad = Math.max(12, (m.railWidth ?? 2.5) * 5 + 10);
  const inflate: Aabb = {
    minX: er.minX - pad,
    maxX: er.maxX + pad,
    minY: er.minY - pad,
    maxY: er.maxY + pad,
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i]![0]!;
    const ay = pts[i]![1]!;
    const bx = pts[i + 1]![0]!;
    const by = pts[i + 1]![1]!;
    if (segmentIntersectsAabb(ax, ay, bx, by, inflate)) return true;
  }
  for (const p of pts) {
    if (pointInRect(p[0]!, p[1]!, inflate)) return true;
  }
  return false;
}

function markingShouldErase(m: MarkingShape, er: Aabb): boolean {
  switch (m.type) {
    case "polygon":
      return polygonEraseDecision(m.points, er);
    case "crosswalk":
      return polygonEraseDecision(crosswalkAsRing(m), er);
    case "line":
      return lineStrokeHitsRect(m, er);
    case "tram_track":
      return tramTrackHitsRect(m, er);
    default:
      return false;
  }
}

function surfaceShouldErase(s: SurfaceShape, er: Aabb): boolean {
  return polygonEraseDecision(s.points, er);
}

function spriteWorldAabb(
  sp: CompositeSprite,
  ov?: { cx?: number; cy?: number; w?: number; h?: number },
): Aabb {
  const cx = typeof ov?.cx === "number" ? ov.cx : sp.cx;
  const cy = typeof ov?.cy === "number" ? ov.cy : sp.cy;
  const w = typeof ov?.w === "number" ? ov.w : sp.w;
  const h = typeof ov?.h === "number" ? ov.h : sp.h;
  return {
    minX: cx - w / 2,
    minY: cy - h / 2,
    maxX: cx + w / 2,
    maxY: cy + h / 2,
  };
}

/**
 * Базовые спрайты — только если прямоугольник спрайта пересекает ластик по площади заметно,
 * иначе касание по диагонали огромного bbox не удаляет спрайт.
 */
function spriteShouldErase(sp: CompositeSprite, ov: { cx?: number; cy?: number; w?: number; h?: number } | undefined, er: Aabb): boolean {
  const bb = spriteWorldAabb(sp, ov);
  if (!aabbIntersect(bb, er)) return false;
  const iw = Math.max(0, Math.min(bb.maxX, er.maxX) - Math.max(bb.minX, er.minX));
  const ih = Math.max(0, Math.min(bb.maxY, er.maxY) - Math.max(bb.minY, er.minY));
  const interArea = iw * ih;
  const spriteArea = Math.max(1e-6, (bb.maxX - bb.minX) * (bb.maxY - bb.minY));
  const frac = interArea / spriteArea;
  if (spriteArea <= SMALL_POLY_AREA) return frac > 0.02;
  return frac >= LARGE_POLY_MIN_OVERLAP_FRAC;
}

/**
 * Стереть объекты, которые реально пересекаются с прямоугольником ластика (не только общий bbox).
 * Крупные полигоны/спрайты — только при достаточной доле пересечения по площади.
 */
export function mergeEraseIntoOverrides(
  baseScene: CompositeScene,
  cur: CompositeOverrides,
  rect: { x: number; y: number; w: number; h: number },
): CompositeOverrides {
  const er: Aabb = {
    minX: rect.x,
    minY: rect.y,
    maxX: rect.x + rect.w,
    maxY: rect.y + rect.h,
  };

  const hideM = new Set(cur.hiddenBaseMarkingIndices ?? []);
  baseScene.markings.forEach((m, i) => {
    if (markingShouldErase(m, er)) hideM.add(i);
  });

  const hideS = new Set(cur.hiddenBaseSurfaceIndices ?? []);
  baseScene.surfaces.forEach((s, i) => {
    if (surfaceShouldErase(s, er)) hideS.add(i);
  });

  const addedMarkings = (cur.addedMarkings ?? []).filter((m) => !markingShouldErase(m, er));

  const addedSurfaces = (cur.addedSurfaces ?? []).filter((s) => !surfaceShouldErase(s, er));

  const addedSprites = (cur.addedSprites ?? []).filter((sp) => {
    const id = sp.id ?? sp.file;
    const ov = cur.spriteOverrides?.[id];
    return !spriteShouldErase(sp, ov, er);
  });

  const spriteOverrides = { ...(cur.spriteOverrides ?? {}) };
  for (const sp of baseScene.sprites) {
    const id = sp.id ?? sp.file;
    const ov = spriteOverrides[id];
    if (ov?.deleted) continue;
    if (spriteShouldErase(sp, ov, er)) {
      spriteOverrides[id] = { ...ov, deleted: true };
    }
  }

  const next: CompositeOverrides = {
    ...cur,
    spriteOverrides,
  };
  if (hideM.size > 0) next.hiddenBaseMarkingIndices = [...hideM].sort((a, b) => a - b);
  else delete next.hiddenBaseMarkingIndices;

  if (hideS.size > 0) next.hiddenBaseSurfaceIndices = [...hideS].sort((a, b) => a - b);
  else delete next.hiddenBaseSurfaceIndices;

  if (addedMarkings.length > 0) next.addedMarkings = addedMarkings;
  else delete next.addedMarkings;

  if (addedSurfaces.length > 0) next.addedSurfaces = addedSurfaces;
  else delete next.addedSurfaces;

  if (addedSprites.length > 0) next.addedSprites = addedSprites;
  else delete next.addedSprites;

  return next;
}
