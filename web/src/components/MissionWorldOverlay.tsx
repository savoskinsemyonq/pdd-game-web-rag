import { useEffect, useMemo, useRef } from "react";
import { cameraSignal } from "../state/cameraSignal";
import {
  applyOverrides,
  markingDashArrayFromPreset,
  SURFACE_DEFAULT_COLOR,
  SURFACE_DRAW_ORDER,
  useCompositeStore,
  type CompositeScene,
  type CompositeSprite,
  type EditorTool,
  type MarkingShape,
  type SurfaceShape,
  type SurfaceKind,
} from "../state/compositeStore";
import sidewalkUrl from "../../assets/sidewalk.png";
import railsUrl from "../../assets/rails.png";
import trolleybusUrl from "../../assets/trolleybus_rails.png";
import { polylineStrokeToSurfaces, STROKE_SAMPLE_STEP_WORLD } from "../map-editor/strokeToSurfaces";
import {
  DEFAULT_TRAM_RAIL_COLOR,
  DEFAULT_TRAM_RAIL_OFFSETS,
  DEFAULT_TRAM_RAIL_WIDTH,
  polylinePointsAttr,
  polylineWorldLength,
  tramTrackRailPolylines,
} from "../map-editor/tramTrackGeometry";
import { mergeEraseIntoOverrides } from "../map-editor/mergeEraseRect";

const DEFAULT_GRASS = "#3aa454";
const DEFAULT_MARKING = "#ffffff";
const FAR_PAD = 4000;

/** Zebra: fixed stripe / gap in world px (≈ atlas pixels), centered in the drawn rect — не фиксированное «6 полос». */
const CROSSWALK_STRIPE_WORLD_PX = 42;
const CROSSWALK_GAP_WORLD_PX = 42;

function layoutEqualStripes(
  extent: number,
  stripeTarget: number,
  gapTarget: number,
): { starts: number[]; stripe: number; gap: number } {
  if (extent <= 0 || stripeTarget <= 0) return { starts: [], stripe: 0, gap: 0 };
  const unit = stripeTarget + gapTarget;
  let count = Math.floor((extent + gapTarget) / unit);
  count = Math.max(1, Math.min(count, 48));
  let stripe = stripeTarget;
  let gap = gapTarget;
  let total = count * stripe + (count - 1) * gap;
  if (total > extent) {
    const scale = extent / total;
    stripe *= scale;
    gap *= scale;
    total = count * stripe + (count - 1) * gap;
  }
  const pad = Math.max(0, (extent - total) / 2);
  const starts: number[] = [];
  let pos = pad;
  for (let i = 0; i < count; i++) {
    starts.push(pos);
    pos += stripe + gap;
  }
  return { starts, stripe, gap };
}
/** World-space minimum distance between stroke samples (prevents huge polyline / quota issues when zoomed in). */
const STROKE_SAMPLE_MIN_WORLD = 2;
/** Upper bound on stroke vertices per gesture (safety). */
const STROKE_MAX_VERTICES = 6000;

/** Native pixel size of each texture asset — used to set the SVG pattern tile
 *  size so the texture is tiled at 1:1, never stretched. Must match the actual
 *  dimensions of the imported PNGs. */
const TEXTURE_TILES: Record<string, { url: string; w: number; h: number }> = {
  sidewalk: { url: sidewalkUrl, w: 217, h: 208 },
  rails: { url: railsUrl, w: 397, h: 1300 },
  trolleybus_rails: { url: trolleybusUrl, w: 129, h: 123 },
};

const PATTERN_KINDS = new Set<SurfaceKind>([
  "sidewalk",
  "rails",
  "trolleybus_rails",
]);

function patternId(kind: SurfaceKind): string {
  return `mission-pat-${kind}`;
}

function surfaceFill(kind: SurfaceKind, override?: string): string {
  if (override) return override;
  if (PATTERN_KINDS.has(kind)) return `url(#${patternId(kind)})`;
  return SURFACE_DEFAULT_COLOR[kind] ?? "#666";
}

/** Convert a screen coordinate (relative to the .mission-stage container) to world space. */
function screenToWorld(screenX: number, screenY: number) {
  const { cx, cy, zoom, viewW, viewH } = cameraSignal;
  return {
    x: (screenX - viewW / 2) / zoom + cx,
    y: (screenY - viewH / 2) / zoom + cy,
  };
}

/** Shift while painting a rectangle → square from the start corner. */
function constrainPaintRect(
  startWX: number,
  startWY: number,
  world: { x: number; y: number },
  shiftKey: boolean,
): { x: number; y: number; w: number; h: number } {
  let cx = world.x;
  let cy = world.y;
  if (shiftKey) {
    const dx = world.x - startWX;
    const dy = world.y - startWY;
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    const sx = dx >= 0 ? 1 : -1;
    const sy = dy >= 0 ? 1 : -1;
    cx = startWX + sx * side;
    cy = startWY + sy * side;
  }
  const x = Math.min(startWX, cx);
  const y = Math.min(startWY, cy);
  const w = Math.abs(cx - startWX);
  const h = Math.abs(cy - startWY);
  return { x, y, w, h };
}

/** Shift while stroking → horizontal / vertical segments from the last vertex. */
function orthoStrokeWorld(
  anchor: [number, number],
  world: { x: number; y: number },
  shiftKey: boolean,
): { x: number; y: number } {
  if (!shiftKey) return world;
  const dx = world.x - anchor[0];
  const dy = world.y - anchor[1];
  if (Math.abs(dx) >= Math.abs(dy)) return { x: world.x, y: anchor[1] };
  return { x: anchor[0], y: world.y };
}

/** Shift while drawing a straight marking line → horizontal / vertical from the start point. */
function orthoLineFromStart(
  startWX: number,
  startWY: number,
  world: { x: number; y: number },
  shiftKey: boolean,
): { x: number; y: number } {
  if (!shiftKey) return world;
  const dx = world.x - startWX;
  const dy = world.y - startWY;
  if (Math.abs(dx) >= Math.abs(dy)) return { x: world.x, y: startWY };
  return { x: startWX, y: world.y };
}

function isDrawCrosshairTool(t: EditorTool): boolean {
  return (
    t === "paint" ||
    t === "stroke" ||
    t === "marking_tram" ||
    t === "marking_line" ||
    t === "marking_crosswalk" ||
    t === "marking_zone" ||
    t === "erase"
  );
}

export function MissionWorldOverlay() {
  const baseScene = useCompositeStore((s) => s.baseScene);
  const overrides = useCompositeStore((s) => s.overrides);
  const spriteBaseUrl = useCompositeStore((s) => s.spriteBaseUrl);
  const mapMode = useCompositeStore((s) => s.mapMode);
  const editorEnabled = useCompositeStore((s) => s.editorEnabled);
  const selectedSpriteId = useCompositeStore((s) => s.selectedSpriteId);
  const editorTool = useCompositeStore((s) => s.editorTool);
  const paintKind = useCompositeStore((s) => s.paintKind);
  const paintPreview = useCompositeStore((s) => s.paintPreview);
  const strokeWidthWorld = useCompositeStore((s) => s.strokeWidthWorld);
  const strokePreview = useCompositeStore((s) => s.strokePreview);
  const markingRectPreview = useCompositeStore((s) => s.markingRectPreview);
  const erasePreview = useCompositeStore((s) => s.erasePreview);
  const markingLinePreview = useCompositeStore((s) => s.markingLinePreview);
  const markingLineWidthWorld = useCompositeStore((s) => s.markingLineWidthWorld);
  const markingDashPreset = useCompositeStore((s) => s.markingDashPreset);
  const markingColor = useCompositeStore((s) => s.markingColor);
  const setSelectedSprite = useCompositeStore((s) => s.setSelectedSprite);
  const setPaintPreview = useCompositeStore((s) => s.setPaintPreview);
  const setStrokePreview = useCompositeStore((s) => s.setStrokePreview);
  const setMarkingRectPreview = useCompositeStore((s) => s.setMarkingRectPreview);
  const setErasePreview = useCompositeStore((s) => s.setErasePreview);
  const setMarkingLinePreview = useCompositeStore((s) => s.setMarkingLinePreview);
  const updateOverrides = useCompositeStore((s) => s.updateOverrides);
  const drawingCancelGeneration = useCompositeStore((s) => s.drawingCancelGeneration);
  const snapshotUndo = useCompositeStore((s) => s.snapshotUndo);
  const setEditorGestureBusy = useCompositeStore((s) => s.setEditorGestureBusy);

  const worldRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number>(0);
  const cancelGenHandledRef = useRef(0);
  const dragRef = useRef<
    | {
        kind: "sprite";
        pointerId: number;
        spriteId: string;
        startWX: number;
        startWY: number;
        origCx: number;
        origCy: number;
      }
    | { kind: "paint"; pointerId: number; startWX: number; startWY: number }
    | {
        kind: "stroke";
        pointerId: number;
        points: [number, number][];
        commitAs: "surface_corridor" | "tram_track";
      }
    | { kind: "marking_line"; pointerId: number; startWX: number; startWY: number }
    | { kind: "marking_rect"; pointerId: number; startWX: number; startWY: number }
    | { kind: "erase"; pointerId: number; startWX: number; startWY: number }
    | null
  >(null);

  const scene = useMemo<CompositeScene | null>(
    () => (baseScene ? applyOverrides(baseScene, overrides) : null),
    [baseScene, overrides],
  );

  useEffect(() => {
    if (mapMode !== "composite" || !scene) return;
    const tick = () => {
      const el = worldRef.current;
      if (el) {
        const { cx, cy, zoom, viewW, viewH } = cameraSignal;
        const tx = viewW / 2 - cx * zoom;
        const ty = viewH / 2 - cy * zoom;
        el.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${zoom})`;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [mapMode, scene]);

  useEffect(() => {
    if (editorEnabled && mapMode === "composite") {
      cancelGenHandledRef.current = useCompositeStore.getState().drawingCancelGeneration;
    }
  }, [editorEnabled, mapMode]);

  useEffect(() => {
    if (!editorEnabled || mapMode !== "composite") return;
    if (drawingCancelGeneration === cancelGenHandledRef.current) return;
    cancelGenHandledRef.current = drawingCancelGeneration;

    const drag = dragRef.current;
    const container = containerRef.current;
    if (drag?.kind === "sprite") {
      useCompositeStore.getState().undo();
    }
    if (drag && container && "pointerId" in drag) {
      try {
        if (container.hasPointerCapture(drag.pointerId)) {
          container.releasePointerCapture(drag.pointerId);
        }
      } catch {
        /* ignore */
      }
    }
    dragRef.current = null;
    setEditorGestureBusy(false);
  }, [drawingCancelGeneration, editorEnabled, mapMode, setEditorGestureBusy]);

  const svgGeometry = useMemo(() => (scene ? renderSvgGeometry(scene) : null), [scene]);

  /** Reverse-lookup of sprite id → CompositeSprite, used during drag for origCx/origCy. */
  const spriteById = useMemo(() => {
    const map = new Map<string, CompositeSprite>();
    if (scene)
      for (const sp of scene.sprites) {
        map.set(sp.id ?? sp.file, sp);
      }
    return map;
  }, [scene]);

  // Container-level pointer handling. Sprite click/drag uses event.target;
  // empty-space click+drag in paint mode draws a rect.
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!editorEnabled) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = screenToWorld(sx, sy);

    const target = e.target as HTMLElement;
    const spriteId = target?.dataset?.spriteId;
    if (spriteId) {
      e.preventDefault();
      setSelectedSprite(spriteId);
      const sp = spriteById.get(spriteId);
      if (sp) {
        snapshotUndo();
        setEditorGestureBusy(true);
        dragRef.current = {
          kind: "sprite",
          pointerId: e.pointerId,
          spriteId,
          startWX: world.x,
          startWY: world.y,
          origCx: sp.cx,
          origCy: sp.cy,
        };
        container.setPointerCapture(e.pointerId);
      }
      return;
    }
    if (editorTool === "paint") {
      e.preventDefault();
      snapshotUndo();
      setEditorGestureBusy(true);
      dragRef.current = { kind: "paint", pointerId: e.pointerId, startWX: world.x, startWY: world.y };
      setPaintPreview({ x: world.x, y: world.y, w: 0, h: 0 });
      container.setPointerCapture(e.pointerId);
    } else if (editorTool === "stroke" || editorTool === "marking_tram") {
      e.preventDefault();
      snapshotUndo();
      setEditorGestureBusy(true);
      const p: [number, number] = [world.x, world.y];
      dragRef.current = {
        kind: "stroke",
        pointerId: e.pointerId,
        points: [p],
        commitAs: editorTool === "marking_tram" ? "tram_track" : "surface_corridor",
      };
      setStrokePreview({ points: [p] });
      container.setPointerCapture(e.pointerId);
    } else if (editorTool === "marking_line") {
      e.preventDefault();
      setSelectedSprite(null);
      snapshotUndo();
      setEditorGestureBusy(true);
      dragRef.current = {
        kind: "marking_line",
        pointerId: e.pointerId,
        startWX: world.x,
        startWY: world.y,
      };
      setMarkingLinePreview({ x1: world.x, y1: world.y, x2: world.x, y2: world.y });
      container.setPointerCapture(e.pointerId);
    } else if (editorTool === "marking_crosswalk" || editorTool === "marking_zone") {
      e.preventDefault();
      setSelectedSprite(null);
      snapshotUndo();
      setEditorGestureBusy(true);
      dragRef.current = {
        kind: "marking_rect",
        pointerId: e.pointerId,
        startWX: world.x,
        startWY: world.y,
      };
      setMarkingRectPreview({ x: world.x, y: world.y, w: 0, h: 0 });
      container.setPointerCapture(e.pointerId);
    } else if (editorTool === "erase") {
      e.preventDefault();
      setSelectedSprite(null);
      snapshotUndo();
      setEditorGestureBusy(true);
      dragRef.current = {
        kind: "erase",
        pointerId: e.pointerId,
        startWX: world.x,
        startWY: world.y,
      };
      setErasePreview({ x: world.x, y: world.y, w: 0, h: 0 });
      container.setPointerCapture(e.pointerId);
    } else if (editorTool === "select") {
      setSelectedSprite(null);
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = screenToWorld(sx, sy);
    if (drag.kind === "sprite") {
      const dx = world.x - drag.startWX;
      const dy = world.y - drag.startWY;
      const id = drag.spriteId;
      const newCx = drag.origCx + dx;
      const newCy = drag.origCy + dy;
      updateOverrides((cur) => ({
        ...cur,
        spriteOverrides: {
          ...(cur.spriteOverrides ?? {}),
          [id]: { ...(cur.spriteOverrides?.[id] ?? {}), cx: newCx, cy: newCy },
        },
      }));
    } else if (drag.kind === "paint") {
      const { x, y, w, h } = constrainPaintRect(drag.startWX, drag.startWY, world, e.shiftKey);
      setPaintPreview({ x, y, w, h });
    } else if (drag.kind === "marking_rect") {
      const { x, y, w, h } = constrainPaintRect(drag.startWX, drag.startWY, world, e.shiftKey);
      setMarkingRectPreview({ x, y, w, h });
    } else if (drag.kind === "erase") {
      const { x, y, w, h } = constrainPaintRect(drag.startWX, drag.startWY, world, e.shiftKey);
      setErasePreview({ x, y, w, h });
    } else if (drag.kind === "marking_line") {
      const end = orthoLineFromStart(drag.startWX, drag.startWY, world, e.shiftKey);
      setMarkingLinePreview({
        x1: drag.startWX,
        y1: drag.startWY,
        x2: end.x,
        y2: end.y,
      });
    } else if (drag.kind === "stroke") {
      const pts = drag.points;
      if (pts.length >= STROKE_MAX_VERTICES) return;
      const last = pts[pts.length - 1]!;
      const snapped = orthoStrokeWorld(last, world, e.shiftKey);
      const step = Math.max(
        STROKE_SAMPLE_MIN_WORLD,
        STROKE_SAMPLE_STEP_WORLD / Math.max(0.25, cameraSignal.zoom),
      );
      const d = Math.hypot(snapped.x - last[0], snapped.y - last[1]);
      if (d >= step) {
        pts.push([snapped.x, snapped.y]);
        setStrokePreview({ points: [...pts] });
      }
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    const container = containerRef.current;
    if (container && container.hasPointerCapture(e.pointerId)) {
      container.releasePointerCapture(e.pointerId);
    }
    setEditorGestureBusy(false);

    if (drag?.kind === "paint") {
      const cont = containerRef.current;
      if (cont) {
        const rect = cont.getBoundingClientRect();
        const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
        const { x, y, w, h } = constrainPaintRect(drag.startWX, drag.startWY, world, e.shiftKey);
        if (w > 4 && h > 4) {
          const points: number[][] = [
            [x, y],
            [x + w, y],
            [x + w, y + h],
            [x, y + h],
          ];
          updateOverrides((cur) => ({
            ...cur,
            addedSurfaces: [
              ...(cur.addedSurfaces ?? []),
              { kind: paintKind, points },
            ],
          }));
        }
      }
    }
    if (drag?.kind === "stroke") {
      const cs = useCompositeStore.getState();
      const pts: [number, number][] = [...drag.points];
      const cont = containerRef.current;
      if (cont) {
        const rect = cont.getBoundingClientRect();
        let endWorld = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
        const last = pts[pts.length - 1];
        if (last) {
          endWorld = orthoStrokeWorld(last, endWorld, e.shiftKey);
          const tailDist = Math.hypot(endWorld.x - last[0], endWorld.y - last[1]);
          if (tailDist > 0.25) pts.push([endWorld.x, endWorld.y]);
        }
      }
      if (drag.commitAs === "tram_track") {
        if (pts.length >= 2 && polylineWorldLength(pts) > 6) {
          updateOverrides((cur) => ({
            ...cur,
            addedMarkings: [
              ...(cur.addedMarkings ?? []),
              {
                type: "tram_track" as const,
                points: pts.map((p) => [p[0], p[1]]),
              },
            ],
          }));
        }
      } else {
        const patches = polylineStrokeToSurfaces(pts, cs.strokeWidthWorld, cs.paintKind);
        if (patches.length > 0) {
          updateOverrides((cur) => ({
            ...cur,
            addedSurfaces: [...(cur.addedSurfaces ?? []), ...patches],
          }));
        }
      }
    }
    if (drag?.kind === "marking_line") {
      const cs = useCompositeStore.getState();
      const cont = containerRef.current;
      let x2 = drag.startWX;
      let y2 = drag.startWY;
      if (cont) {
        const rect = cont.getBoundingClientRect();
        let endWorld = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
        endWorld = orthoLineFromStart(drag.startWX, drag.startWY, endWorld, e.shiftKey);
        x2 = endWorld.x;
        y2 = endWorld.y;
      }
      const len = Math.hypot(x2 - drag.startWX, y2 - drag.startWY);
      if (len > 3) {
        const dash = markingDashArrayFromPreset(cs.markingDashPreset);
        const marking = {
          type: "line" as const,
          x1: drag.startWX,
          y1: drag.startWY,
          x2,
          y2,
          width: cs.markingLineWidthWorld,
          color: cs.markingColor,
          lineCap: "butt" as const,
          ...(dash ? { dash } : {}),
        };
        updateOverrides((cur) => ({
          ...cur,
          addedMarkings: [...(cur.addedMarkings ?? []), marking],
        }));
      }
    }
    if (drag?.kind === "marking_rect") {
      const cs = useCompositeStore.getState();
      const cont = containerRef.current;
      if (cont) {
        const rect = cont.getBoundingClientRect();
        const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
        const { x, y, w, h } = constrainPaintRect(drag.startWX, drag.startWY, world, e.shiftKey);
        if (w > 4 && h > 4) {
          if (cs.editorTool === "marking_crosswalk") {
            const marking = {
              type: "crosswalk" as const,
              x,
              y,
              w,
              h,
              orient: cs.crosswalkOrient,
              color: cs.markingColor,
            };
            updateOverrides((cur) => ({
              ...cur,
              addedMarkings: [...(cur.addedMarkings ?? []), marking],
            }));
          } else {
            const marking = {
              type: "polygon" as const,
              color: cs.markingColor,
              points: [
                [x, y],
                [x + w, y],
                [x + w, y + h],
                [x, y + h],
              ],
            };
            updateOverrides((cur) => ({
              ...cur,
              addedMarkings: [...(cur.addedMarkings ?? []), marking],
            }));
          }
        }
      }
    }
    if (drag?.kind === "erase") {
      const base = useCompositeStore.getState().baseScene;
      const cont = containerRef.current;
      if (base && cont) {
        const rect = cont.getBoundingClientRect();
        const world = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
        const { x, y, w, h } = constrainPaintRect(drag.startWX, drag.startWY, world, e.shiftKey);
        if (w > 4 && h > 4) {
          updateOverrides((cur) => mergeEraseIntoOverrides(base, cur, { x, y, w, h }));
        }
      }
    }
    setPaintPreview(null);
    setStrokePreview(null);
    setMarkingRectPreview(null);
    setErasePreview(null);
    setMarkingLinePreview(null);
  }

  if (mapMode !== "composite" || !scene) return null;

  const { world } = scene;
  const farLeft = world.minX - FAR_PAD;
  const farTop = world.minY - FAR_PAD;
  const farW = world.maxX - world.minX + FAR_PAD * 2;
  const farH = world.maxY - world.minY + FAR_PAD * 2;

  return (
    <div
      ref={containerRef}
      className="mission-overlay"
      aria-hidden={!editorEnabled}
      style={{
        pointerEvents: editorEnabled ? "auto" : "none",
        zIndex: editorEnabled ? 2 : 0,
        cursor: editorEnabled ? (isDrawCrosshairTool(editorTool) ? "crosshair" : "default") : "default",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        ref={worldRef}
        className="mission-overlay__world"
        style={{ transformOrigin: "0 0" }}
      >
        <svg
          className="mission-overlay__svg"
          width={farW}
          height={farH}
          viewBox={`${farLeft} ${farTop} ${farW} ${farH}`}
          style={{ position: "absolute", left: farLeft, top: farTop, pointerEvents: "none" }}
          shapeRendering="geometricPrecision"
        >
          {svgGeometry}
          {paintPreview && (
            <rect
              x={paintPreview.x}
              y={paintPreview.y}
              width={paintPreview.w}
              height={paintPreview.h}
              fill={SURFACE_DEFAULT_COLOR[paintKind]}
              fillOpacity={0.55}
              stroke="#ffe66b"
              strokeWidth={2}
              strokeDasharray="8 6"
            />
          )}
          {strokePreview && strokePreview.points.length > 0 && editorTool === "stroke" && (
            <polyline
              fill="none"
              stroke={SURFACE_DEFAULT_COLOR[paintKind]}
              strokeOpacity={0.65}
              strokeWidth={strokeWidthWorld}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="10 6"
              points={strokePreview.points.map((p) => `${p[0]},${p[1]}`).join(" ")}
            />
          )}
          {strokePreview && strokePreview.points.length > 0 && editorTool === "marking_tram" && (
            <g opacity={0.88}>
              {tramTrackRailPolylines(strokePreview.points).map((rail, ri) => (
                <polyline
                  key={`tram-preview-${ri}`}
                  fill="none"
                  stroke={DEFAULT_TRAM_RAIL_COLOR}
                  strokeWidth={DEFAULT_TRAM_RAIL_WIDTH}
                  strokeLinecap="butt"
                  strokeLinejoin="round"
                  points={polylinePointsAttr(rail)}
                />
              ))}
            </g>
          )}
          {markingRectPreview && markingRectPreview.w > 0 && markingRectPreview.h > 0 && (
            <rect
              x={markingRectPreview.x}
              y={markingRectPreview.y}
              width={markingRectPreview.w}
              height={markingRectPreview.h}
              fill={markingColor}
              fillOpacity={editorTool === "marking_zone" ? 0.35 : 0.2}
              stroke="#ffe66b"
              strokeWidth={2}
              strokeDasharray="6 5"
            />
          )}
          {erasePreview && erasePreview.w > 0 && erasePreview.h > 0 && (
            <rect
              x={erasePreview.x}
              y={erasePreview.y}
              width={erasePreview.w}
              height={erasePreview.h}
              fill="#ef4444"
              fillOpacity={0.22}
              stroke="#f87171"
              strokeWidth={2}
              strokeDasharray="7 5"
            />
          )}
          {markingLinePreview && (
            <line
              x1={markingLinePreview.x1}
              y1={markingLinePreview.y1}
              x2={markingLinePreview.x2}
              y2={markingLinePreview.y2}
              stroke={markingColor}
              strokeOpacity={0.85}
              strokeWidth={markingLineWidthWorld}
              strokeLinecap="butt"
              strokeDasharray={markingDashArrayFromPreset(markingDashPreset)?.join(" ")}
            />
          )}
        </svg>
        {scene.sprites.map((sp, i) => {
          const id = sp.id ?? sp.file;
          const isSelected = editorEnabled && id === selectedSpriteId;
          return (
            <img
              key={`${id}#${i}`}
              data-sprite-id={id}
              src={spriteBaseUrl ? `${spriteBaseUrl}${sp.file}` : sp.file}
              alt=""
              draggable={false}
              style={{
                position: "absolute",
                left: sp.cx - sp.w / 2,
                top: sp.cy - sp.h / 2,
                width: sp.w,
                height: sp.h,
                transform: sp.angle ? `rotate(${sp.angle}rad)` : undefined,
                transformOrigin: "center",
                imageRendering: "pixelated",
                pointerEvents: editorEnabled ? "auto" : "none",
                userSelect: "none",
                outline: isSelected ? "2px solid #ffe66b" : undefined,
                outlineOffset: 2,
                cursor: editorEnabled ? "move" : "default",
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function renderSvgGeometry(scene: CompositeScene) {
  const { world, surfaces, markings, background } = scene;
  const farLeft = world.minX - FAR_PAD;
  const farTop = world.minY - FAR_PAD;
  const farW = world.maxX - world.minX + FAR_PAD * 2;
  const farH = world.maxY - world.minY + FAR_PAD * 2;

  // Group surfaces by kind so we render in fixed z-order regardless of input ordering.
  const byKind = new Map<string, SurfaceShape[]>();
  for (const s of surfaces) {
    const arr = byKind.get(s.kind) ?? [];
    arr.push(s);
    byKind.set(s.kind, arr);
  }

  return (
    <>
      <defs>
        {(Object.keys(TEXTURE_TILES) as SurfaceKind[]).map((kind) => {
          const tile = TEXTURE_TILES[kind];
          return (
            <pattern
              key={kind}
              id={patternId(kind)}
              patternUnits="userSpaceOnUse"
              width={tile.w}
              height={tile.h}
              x={world.minX}
              y={world.minY}
            >
              <image
                href={tile.url}
                width={tile.w}
                height={tile.h}
                preserveAspectRatio="none"
              />
            </pattern>
          );
        })}
      </defs>
      <rect
        x={farLeft}
        y={farTop}
        width={farW}
        height={farH}
        fill={background || DEFAULT_GRASS}
      />
      {SURFACE_DRAW_ORDER.flatMap((kind) =>
        (byKind.get(kind) ?? []).map((s, i) => renderSurface(s, `${kind}-${i}`)),
      )}
      {markings.map((m, i) => renderMarking(m, i))}
    </>
  );
}

function toSubpath(points: number[][]): string {
  if (points.length === 0) return "";
  const head = `M ${points[0][0]} ${points[0][1]}`;
  const tail = points.slice(1).map((p) => `L ${p[0]} ${p[1]}`).join(" ");
  return `${head} ${tail} Z`;
}

function renderSurface(s: SurfaceShape, key: string) {
  const fill = surfaceFill(s.kind, s.color);
  if (s.holes && s.holes.length > 0) {
    const d = toSubpath(s.points) + " " + s.holes.map(toSubpath).join(" ");
    return <path key={key} d={d} fill={fill} fillRule="evenodd" />;
  }
  return (
    <polygon
      key={key}
      points={s.points.map((p) => `${p[0]},${p[1]}`).join(" ")}
      fill={fill}
    />
  );
}

function renderMarking(m: MarkingShape, key: number) {
  const stroke = m.color ?? DEFAULT_MARKING;
  if (m.type === "polygon") {
    if (m.holes && m.holes.length > 0) {
      const d = toSubpath(m.points) + " " + m.holes.map(toSubpath).join(" ");
      return <path key={key} d={d} fill={stroke} fillRule="evenodd" />;
    }
    return (
      <polygon
        key={key}
        points={m.points.map((p) => `${p[0]},${p[1]}`).join(" ")}
        fill={stroke}
      />
    );
  }
  if (m.type === "line") {
    const cap = m.lineCap ?? "butt";
    return (
      <line
        key={key}
        x1={m.x1}
        y1={m.y1}
        x2={m.x2}
        y2={m.y2}
        stroke={stroke}
        strokeWidth={m.width ?? 6}
        strokeDasharray={m.dash?.join(" ")}
        strokeLinecap={cap}
      />
    );
  }
  if (m.type === "tram_track") {
    const pts = m.points
      .filter((p) => p.length >= 2)
      .map((p) => [p[0]!, p[1]!] as [number, number]);
    if (pts.length < 2) return null;
    const offsets =
      m.railOffsets && m.railOffsets.length > 0 ? m.railOffsets : DEFAULT_TRAM_RAIL_OFFSETS;
    const width = m.railWidth ?? DEFAULT_TRAM_RAIL_WIDTH;
    const col = m.color ?? DEFAULT_TRAM_RAIL_COLOR;
    const rails = tramTrackRailPolylines(pts, offsets);
    return (
      <g key={key}>
        {rails.map((rail, ri) => (
          <polyline
            key={`${key}-rail-${ri}`}
            fill="none"
            stroke={col}
            strokeWidth={width}
            strokeLinecap="butt"
            strokeLinejoin="round"
            points={polylinePointsAttr(rail)}
          />
        ))}
      </g>
    );
  }
  const stripeTarget = m.stripeWidth ?? CROSSWALK_STRIPE_WORLD_PX;
  const gapTarget = m.gapWidth ?? CROSSWALK_GAP_WORLD_PX;
  const orient = m.orient ?? "h";
  const fill = m.color ?? DEFAULT_MARKING;
  const out: JSX.Element[] = [];

  if (orient === "h") {
    const { starts, stripe } = layoutEqualStripes(m.w, stripeTarget, gapTarget);
    for (let i = 0; i < starts.length; i++) {
      const sx = m.x + starts[i]!;
      out.push(
        <rect
          key={`${key}-${i}`}
          x={sx}
          y={m.y}
          width={stripe}
          height={m.h}
          fill={fill}
          shapeRendering="crispEdges"
        />,
      );
    }
  } else {
    const { starts, stripe } = layoutEqualStripes(m.h, stripeTarget, gapTarget);
    for (let i = 0; i < starts.length; i++) {
      const sy = m.y + starts[i]!;
      out.push(
        <rect
          key={`${key}-${i}`}
          x={m.x}
          y={sy}
          width={m.w}
          height={stripe}
          fill={fill}
          shapeRendering="crispEdges"
        />,
      );
    }
  }
  return (
    <g key={key} shapeRendering="crispEdges">
      {out}
    </g>
  );
}
