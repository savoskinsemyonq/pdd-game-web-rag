import { create } from "zustand";
import { canUseEditors } from "../lib/editorAccess";
import { useAuthStore } from "./authStore";

export type MapRenderMode = "atlas" | "composite";

export interface CompositeWorld {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Drawable terrain types, in painter z-order — lowest first.
 *  Anything not in this list is treated as `road` for color purposes.
 *  `trolleybus_rails` sits on top of road (twin dark stripes embedded in
 *  asphalt), and `rails` is the railway corridor with sleepers — both have
 *  dedicated repeating textures in the renderer. `tram_tracks` is kept for
 *  backwards compatibility with older saves; new extractions emit
 *  `trolleybus_rails` instead. `grass` is editor-painted lawn (same idea as scene background). */
export type SurfaceKind =
  | "water"
  | "sand"
  | "sidewalk"
  | "road"
  | "trolleybus_rails"
  | "tram_tracks"
  | "rails"
  | "grass";

/** Lowest → drawn first (underneath). `grass` last so painted patches cover road/textures. */
export const SURFACE_DRAW_ORDER: readonly SurfaceKind[] = [
  "water",
  "sand",
  "sidewalk",
  "road",
  "trolleybus_rails",
  "tram_tracks",
  "rails",
  "grass",
];

export const SURFACE_DEFAULT_COLOR: Record<SurfaceKind, string> = {
  water: "#3a76b8",
  sand: "#c3b35f",
  sidewalk: "#8d867e",
  road: "#454445",
  trolleybus_rails: "#454546",
  tram_tracks: "#1a1a1a",
  rails: "#707071",
  /** Matches typical composite `background` (mission2); blends with void areas. */
  grass: "#639424",
};

export interface SurfaceShape {
  kind: SurfaceKind;
  /** Outer polygon ring in world coordinates. */
  points: number[][];
  /** Optional holes (e.g. roundabout grass island). */
  holes?: number[][][];
  /** Optional override over the kind's default colour. */
  color?: string;
}

export type MarkingShape =
  | {
      type: "line";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      color?: string;
      width?: number;
      dash?: number[];
      lineCap?: "butt" | "round";
    }
  | {
      type: "crosswalk";
      x: number;
      y: number;
      w: number;
      h: number;
      orient?: "h" | "v";
      color?: string;
      /** White stripe thickness along crossing axis (world px); default matches renderer atlas scale. */
      stripeWidth?: number;
      /** Gap between stripes (world px). */
      gapWidth?: number;
    }
  | { type: "polygon"; points: number[][]; holes?: number[][][]; color?: string }
  | {
      type: "tram_track";
      /** Center path of the tram corridor (world px). */
      points: number[][];
      /** Per-rail stroke width (world px). */
      railWidth?: number;
      /** Lateral offsets from centerline for each rail (world px); default four rails in two pairs. */
      railOffsets?: number[];
      /** Stroke colour (default dark rail). */
      color?: string;
    };

export interface CompositeSprite {
  /** Stable id used by the editor to track moves/deletes across reloads. */
  id?: string;
  file: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle?: number;
}

export interface CompositeScene {
  version: number;
  world: CompositeWorld;
  background: string;
  surfaces: SurfaceShape[];
  markings: MarkingShape[];
  sprites: CompositeSprite[];
}

/** User-authored deltas merged on top of the auto-extracted scene. */
export interface CompositeOverrides {
  spriteOverrides?: Record<
    string,
    { deleted?: true; cx?: number; cy?: number; angle?: number; w?: number; h?: number }
  >;
  addedSurfaces?: SurfaceShape[];
  addedSprites?: CompositeSprite[];
  /** Extra SVG markings merged after base scene markings (lines, crosswalks, polygons). */
  addedMarkings?: MarkingShape[];
  /** Indices into base scene `markings` hidden by the eraser (persisted). */
  hiddenBaseMarkingIndices?: number[];
  /** Indices into base scene `surfaces` hidden by the eraser. */
  hiddenBaseSurfaceIndices?: number[];
}

/** Stroke pattern preset for line markings (dash lengths are in world / SVG units). */
export type MarkingDashPreset = "solid" | "dash_long" | "dash_short" | "dash_center";

export function markingDashArrayFromPreset(preset: MarkingDashPreset): number[] | undefined {
  switch (preset) {
    case "solid":
      return undefined;
    case "dash_long":
      return [44, 30];
    case "dash_short":
      return [16, 20];
    case "dash_center":
      return [14, 36];
    default:
      return undefined;
  }
}

export type EditorTool =
  | "select"
  | "paint"
  | "stroke"
  | "marking_tram"
  | "marking_line"
  | "marking_crosswalk"
  | "marking_zone"
  | "erase";

const MAX_UNDO = 50;

function cloneOverrides(o: CompositeOverrides): CompositeOverrides {
  return structuredClone(o) as CompositeOverrides;
}

/** Stable JSON string for deduping markings regardless of key insertion order. */
function stableStringifyDedupe(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringifyDedupe(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${stableStringifyDedupe(v)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Drops duplicate `addedSprites` (same `id` or `file`, **last** wins) and duplicate `addedMarkings`
 * (identical geometry/style). Merging localStorage with repo overrides used to concatenate arrays,
 * which multiplied identical entries on every reload.
 */
export function dedupeCompositeOverrides(o: CompositeOverrides): CompositeOverrides {
  const next: CompositeOverrides = { ...o };
  let changed = false;

  const sprites = o.addedSprites;
  if (sprites?.length) {
    const seenIds = new Set<string>();
    const out: CompositeSprite[] = [];
    for (let i = sprites.length - 1; i >= 0; i--) {
      const sp = sprites[i]!;
      const id = sp.id ?? sp.file;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      out.push(sp);
    }
    out.reverse();
    if (out.length !== sprites.length) {
      changed = true;
      if (out.length === 0) delete next.addedSprites;
      else next.addedSprites = out;
    }
  }

  const markings = o.addedMarkings;
  if (markings?.length) {
    const seenKeys = new Set<string>();
    const out: MarkingShape[] = [];
    for (const m of markings) {
      const key = stableStringifyDedupe(m);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      out.push(m);
    }
    if (out.length !== markings.length) {
      changed = true;
      if (out.length === 0) delete next.addedMarkings;
      else next.addedMarkings = out;
    }
  }

  return changed ? next : o;
}

export interface PaintPreview {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Polyline preview while drawing a stroke surface (world coordinates). */
export interface StrokePreview {
  points: [number, number][];
}

/** Preview for line markings (world coordinates). */
export interface MarkingLinePreview {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface CompositeStoreState {
  mapMode: MapRenderMode;
  /** Mission whose scene is currently loaded (used as overrides storage key). */
  missionId: string | null;
  /** Base scene as loaded from `mission2-composite.json`. */
  baseScene: CompositeScene | null;
  /** Editor deltas applied on top of `baseScene` (loaded from localStorage / overrides.json). */
  overrides: CompositeOverrides;
  spriteBaseUrl: string | null;
  /** Editor-only: id of the currently selected sprite, or null. */
  editorEnabled: boolean;
  selectedSpriteId: string | null;
  editorTool: EditorTool;
  paintKind: SurfaceKind;
  paintPreview: PaintPreview | null;
  /** Corridor half-width ×2 for stroke tool (world px). */
  strokeWidthWorld: number;
  strokePreview: StrokePreview | null;
  markingRectPreview: PaintPreview | null;
  /** Rectangle preview for eraser tool (world px). */
  erasePreview: PaintPreview | null;
  markingLinePreview: MarkingLinePreview | null;
  /** Stroke half-ish thickness for line markings (world px). */
  markingLineWidthWorld: number;
  markingDashPreset: MarkingDashPreset;
  markingColor: string;
  /** Strip orientation for new crosswalks (`h` = stripes along X). */
  crosswalkOrient: "h" | "v";
  /** Increments when the user cancels a gesture (Escape); overlay reacts to undo sprite drag / release capture. */
  drawingCancelGeneration: number;
  /** True while pointer is down for sprite move or surface draw (used for Escape handling). */
  editorGestureBusy: boolean;
  undoStack: CompositeOverrides[];
  redoStack: CompositeOverrides[];

  setMode: (mode: MapRenderMode) => void;
  setScene: (
    scene: CompositeScene | null,
    spriteBaseUrl: string | null,
    overrides?: CompositeOverrides,
    missionId?: string | null,
  ) => void;
  /** Replace overrides; by default clears undo/redo (use `resetHistory: false` after `snapshotUndo` for undoable import/clear). */
  setOverrides: (overrides: CompositeOverrides, options?: { resetHistory?: boolean }) => void;
  /** Mutate overrides via a callback; persists to localStorage automatically. */
  updateOverrides: (mutator: (current: CompositeOverrides) => CompositeOverrides) => void;
  setEditorEnabled: (on: boolean) => void;
  setSelectedSprite: (id: string | null) => void;
  setEditorTool: (tool: EditorTool) => void;
  setPaintKind: (kind: SurfaceKind) => void;
  setPaintPreview: (preview: PaintPreview | null) => void;
  setStrokeWidthWorld: (w: number) => void;
  setStrokePreview: (preview: StrokePreview | null) => void;
  setMarkingRectPreview: (preview: PaintPreview | null) => void;
  setErasePreview: (preview: PaintPreview | null) => void;
  setMarkingLinePreview: (preview: MarkingLinePreview | null) => void;
  setMarkingLineWidthWorld: (w: number) => void;
  setMarkingDashPreset: (preset: MarkingDashPreset) => void;
  setMarkingColor: (color: string) => void;
  setCrosswalkOrient: (o: "h" | "v") => void;
  setEditorGestureBusy: (busy: boolean) => void;
  /** Push current overrides onto the undo stack before the next mutation (one call per user gesture). */
  snapshotUndo: () => void;
  /** Uniform scale for the selected sprite (> 1 enlarges). Uses merged scene size as baseline. */
  scaleSelectedSprite: (factor: number) => void;
  undo: () => void;
  redo: () => void;
  cancelCompositeGesture: () => void;
  reset: () => void;
}

export const useCompositeStore = create<CompositeStoreState>((set, get) => ({
  mapMode: "atlas",
  missionId: null,
  baseScene: null,
  overrides: {},
  spriteBaseUrl: null,
  editorEnabled: false,
  selectedSpriteId: null,
  editorTool: "select",
  paintKind: "road",
  paintPreview: null,
  strokeWidthWorld: 96,
  strokePreview: null,
  markingRectPreview: null,
  erasePreview: null,
  markingLinePreview: null,
  markingLineWidthWorld: 14,
  markingDashPreset: "solid",
  markingColor: "#ffffff",
  crosswalkOrient: "h",
  drawingCancelGeneration: 0,
  editorGestureBusy: false,
  undoStack: [],
  redoStack: [],

  setMode: (mapMode) => set({ mapMode }),
  setScene: (scene, spriteBaseUrl, overrides, missionId) =>
    set({
      baseScene: scene,
      spriteBaseUrl,
      overrides: dedupeCompositeOverrides(overrides ?? {}),
      missionId: missionId ?? null,
      selectedSpriteId: null,
      paintPreview: null,
      strokePreview: null,
      markingRectPreview: null,
      erasePreview: null,
      markingLinePreview: null,
      undoStack: [],
      redoStack: [],
      drawingCancelGeneration: 0,
      editorGestureBusy: false,
    }),
  setOverrides: (overrides, options) => {
    const cleaned = dedupeCompositeOverrides(overrides);
    const resetHistory = options?.resetHistory ?? true;
    if (resetHistory) set({ overrides: cleaned, undoStack: [], redoStack: [] });
    else set({ overrides: cleaned });
    const id = get().missionId;
    if (id) saveOverrides(id, cleaned);
  },
  updateOverrides: (mutator) => {
    const next = dedupeCompositeOverrides(mutator(get().overrides));
    set({ overrides: next });
    const id = get().missionId;
    if (id) saveOverrides(id, next);
  },
  setEditorEnabled: (editorEnabled) => {
    if (editorEnabled && !canUseEditors(useAuthStore.getState().user)) return;
    set({ editorEnabled });
  },
  setSelectedSprite: (selectedSpriteId) => set({ selectedSpriteId }),
  setEditorTool: (tool) =>
    set((s) => ({
      editorTool: tool,
      paintPreview: tool === "paint" ? s.paintPreview : null,
      strokePreview: tool === "stroke" || tool === "marking_tram" ? s.strokePreview : null,
      markingRectPreview:
        tool === "marking_crosswalk" || tool === "marking_zone" ? s.markingRectPreview : null,
      erasePreview: tool === "erase" ? s.erasePreview : null,
      markingLinePreview: tool === "marking_line" ? s.markingLinePreview : null,
    })),
  setPaintKind: (paintKind) => set({ paintKind }),
  setPaintPreview: (paintPreview) => set({ paintPreview }),
  setStrokeWidthWorld: (strokeWidthWorld) =>
    set({ strokeWidthWorld: Math.max(8, Math.min(1200, strokeWidthWorld)) }),
  setStrokePreview: (strokePreview) => set({ strokePreview }),
  setMarkingRectPreview: (markingRectPreview) => set({ markingRectPreview }),
  setErasePreview: (erasePreview) => set({ erasePreview }),
  setMarkingLinePreview: (markingLinePreview) => set({ markingLinePreview }),
  setMarkingLineWidthWorld: (markingLineWidthWorld) =>
    set({ markingLineWidthWorld: Math.max(2, Math.min(80, markingLineWidthWorld)) }),
  setMarkingDashPreset: (markingDashPreset) => set({ markingDashPreset }),
  setMarkingColor: (markingColor) => set({ markingColor }),
  setCrosswalkOrient: (crosswalkOrient) => set({ crosswalkOrient }),
  setEditorGestureBusy: (editorGestureBusy) => set({ editorGestureBusy }),
  snapshotUndo: () => {
    const { overrides, undoStack } = get();
    const copy = cloneOverrides(overrides);
    const last = undoStack[undoStack.length - 1];
    if (last && JSON.stringify(last) === JSON.stringify(copy)) return;
    set({
      undoStack: [...undoStack.slice(-(MAX_UNDO - 1)), copy],
      redoStack: [],
    });
  },
  scaleSelectedSprite: (factor) => {
    const id = get().selectedSpriteId;
    const base = get().baseScene;
    const overrides = get().overrides;
    if (!id || !base || !(factor > 0) || !Number.isFinite(factor)) return;
    const scene = applyOverrides(base, overrides);
    const sp = scene.sprites.find((s) => (s.id ?? s.file) === id);
    if (!sp || sp.w < 1 || sp.h < 1) return;
    const nw = Math.max(4, Math.min(4096, Math.round(sp.w * factor)));
    const nh = Math.max(4, Math.min(4096, Math.round(sp.h * factor)));
    if (nw === sp.w && nh === sp.h) return;
    get().updateOverrides((cur) => ({
      ...cur,
      spriteOverrides: {
        ...(cur.spriteOverrides ?? {}),
        [id]: { ...(cur.spriteOverrides?.[id] ?? {}), w: nw, h: nh },
      },
    }));
  },
  undo: () => {
    const { undoStack, redoStack, overrides, missionId } = get();
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1]!;
    const newUndo = undoStack.slice(0, -1);
    const curCopy = cloneOverrides(overrides);
    const next = dedupeCompositeOverrides(cloneOverrides(prev));
    set({
      overrides: next,
      undoStack: newUndo,
      redoStack: [...redoStack.slice(-(MAX_UNDO - 1)), curCopy],
    });
    if (missionId) saveOverrides(missionId, next);
  },
  redo: () => {
    const { undoStack, redoStack, overrides, missionId } = get();
    if (redoStack.length === 0) return;
    const forward = redoStack[redoStack.length - 1]!;
    const newRedo = redoStack.slice(0, -1);
    const curCopy = cloneOverrides(overrides);
    const next = dedupeCompositeOverrides(cloneOverrides(forward));
    set({
      overrides: next,
      undoStack: [...undoStack.slice(-(MAX_UNDO - 1)), curCopy],
      redoStack: newRedo,
    });
    if (missionId) saveOverrides(missionId, next);
  },
  cancelCompositeGesture: () =>
    set((s) => ({
      drawingCancelGeneration: s.drawingCancelGeneration + 1,
      paintPreview: null,
      strokePreview: null,
      markingRectPreview: null,
      erasePreview: null,
      markingLinePreview: null,
    })),
  reset: () =>
    set({
      mapMode: "atlas",
      missionId: null,
      baseScene: null,
      overrides: {},
      spriteBaseUrl: null,
      editorEnabled: false,
      selectedSpriteId: null,
      editorTool: "select",
      paintPreview: null,
      strokeWidthWorld: 96,
      strokePreview: null,
      markingRectPreview: null,
      erasePreview: null,
      markingLinePreview: null,
      markingLineWidthWorld: 14,
      markingDashPreset: "solid",
      markingColor: "#ffffff",
      crosswalkOrient: "h",
      undoStack: [],
      redoStack: [],
      drawingCancelGeneration: 0,
      editorGestureBusy: false,
    }),
}));

function mergeSpriteWithOverrides(
  sp: CompositeSprite,
  stableId: string,
  ov?: {
    deleted?: true;
    cx?: number;
    cy?: number;
    angle?: number;
    w?: number;
    h?: number;
  },
): CompositeSprite {
  if (!ov) return { ...sp, id: stableId };
  const touched =
    typeof ov.cx === "number" ||
    typeof ov.cy === "number" ||
    typeof ov.angle === "number" ||
    typeof ov.w === "number" ||
    typeof ov.h === "number";
  if (!touched) return { ...sp, id: stableId };
  return {
    ...sp,
    id: stableId,
    cx: typeof ov.cx === "number" ? ov.cx : sp.cx,
    cy: typeof ov.cy === "number" ? ov.cy : sp.cy,
    angle: typeof ov.angle === "number" ? ov.angle : sp.angle,
    w: typeof ov.w === "number" ? ov.w : sp.w,
    h: typeof ov.h === "number" ? ov.h : sp.h,
  };
}

/** Apply overrides on top of the base scene. Used by the renderer + editor preview. */
export function applyOverrides(
  scene: CompositeScene,
  overrides: CompositeOverrides,
): CompositeScene {
  const sprites: CompositeSprite[] = [];
  const so = overrides.spriteOverrides ?? {};
  for (const sp of scene.sprites) {
    const id = sp.id ?? sp.file;
    const ov = so[id];
    if (ov?.deleted) continue;
    sprites.push(mergeSpriteWithOverrides(sp, id, ov));
  }
  for (const added of overrides.addedSprites ?? []) {
    const id = added.id ?? added.file;
    const ov = so[id];
    if (ov?.deleted) continue;
    sprites.push(mergeSpriteWithOverrides(added, id, ov));
  }

  const hideSurf = new Set(overrides.hiddenBaseSurfaceIndices ?? []);
  const surfaces = [
    ...scene.surfaces.filter((_, i) => !hideSurf.has(i)),
    ...(overrides.addedSurfaces ?? []),
  ];

  const hideMark = new Set(overrides.hiddenBaseMarkingIndices ?? []);
  const markings = [
    ...scene.markings.filter((_, i) => !hideMark.has(i)),
    ...(overrides.addedMarkings ?? []),
  ];
  return { ...scene, surfaces, sprites, markings };
}

/**
 * Resolve the active map render mode. Override priority:
 *   1. URL `?map=atlas|composite`
 *   2. `localStorage.mapMode`
 *   3. The mission meta's `renderMode` field
 *   4. Default `atlas`
 */
export function resolveMapMode(metaRenderMode: string | undefined): MapRenderMode {
  if (typeof window !== "undefined") {
    try {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get("map");
      if (fromUrl === "atlas" || fromUrl === "composite") return fromUrl;
    } catch {
      // ignore malformed URLs
    }
    try {
      const fromLs = window.localStorage.getItem("mapMode");
      if (fromLs === "atlas" || fromLs === "composite") return fromLs;
    } catch {
      // ignore storage failures (e.g. private mode)
    }
  }
  if (metaRenderMode === "composite" || metaRenderMode === "atlas") return metaRenderMode;
  return "atlas";
}

const OVERRIDES_KEY_PREFIX = "compositeOverrides::";

export function overridesStorageKey(missionId: string): string {
  return `${OVERRIDES_KEY_PREFIX}${missionId}`;
}

/** Demo tram polyline that was briefly shipped in `mission2-composite.overrides.json` — strip from saved edits. */
const SHIPPED_DEMO_TRAM_POLYLINES: readonly number[][][] = [
  [
    [4100, 5580],
    [4680, 5460],
    [5280, 5510],
    [5880, 5780],
    [6480, 6220],
    [7080, 6620],
  ],
];

function polylinePointsEqual(a: number[][], b: number[][]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (p.length < 2 || q.length < 2) return false;
    if (Math.round(p[0]!) !== Math.round(q[0]!) || Math.round(p[1]!) !== Math.round(q[1]!)) return false;
  }
  return true;
}

function isShippedDemoTramMarking(m: MarkingShape): boolean {
  if (m.type !== "tram_track") return false;
  return SHIPPED_DEMO_TRAM_POLYLINES.some((demo) => polylinePointsEqual(m.points, demo));
}

/** Remove legacy demo `tram_track` markings so localStorage matches dropped repo file. */
export function withoutShippedDemoTramMarkings(o: CompositeOverrides): {
  next: CompositeOverrides;
  changed: boolean;
} {
  const list = o.addedMarkings;
  if (!list?.length) return { next: o, changed: false };
  const filtered = list.filter((m) => !isShippedDemoTramMarking(m));
  if (filtered.length === list.length) return { next: o, changed: false };
  const next: CompositeOverrides = { ...o };
  if (filtered.length === 0) delete next.addedMarkings;
  else next.addedMarkings = filtered;
  return { next, changed: true };
}

export function loadOverrides(missionId: string): CompositeOverrides {
  try {
    const raw = localStorage.getItem(overridesStorageKey(missionId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as CompositeOverrides;
    if (!parsed || typeof parsed !== "object") return {};
    const { next: stripped, changed: strippedChanged } = withoutShippedDemoTramMarkings(parsed);
    const deduped = dedupeCompositeOverrides(stripped);
    if (strippedChanged || deduped !== stripped) saveOverrides(missionId, deduped);
    return deduped;
  } catch {
    return {};
  }
}

export function saveOverrides(missionId: string, overrides: CompositeOverrides): void {
  try {
    const cleaned = dedupeCompositeOverrides(overrides);
    localStorage.setItem(overridesStorageKey(missionId), JSON.stringify(cleaned));
  } catch (e) {
    console.warn("[composite] не удалось сохранить правки в localStorage (квота или приватный режим):", e);
  }
}
