import type { Camera } from "./Camera";
import { visualForActor } from "./AssetMap";
import type { ActorKind, TLColor, TrafficLightDef } from "../types";
import {
  getTile,
  mapLayer1,
  TILE_SIZE,
} from "../data/cityMapData.js";

/** Desktop city.map world size (192 × 64 px). Must match cityMapData. */
export const WORLD_W = 12288;
export const WORLD_H = 12288;
export const TILE_PX = TILE_SIZE;

const CITY_TILE_IDS: readonly number[] = (() => {
  const s = new Set<number>();
  for (let i = 0; i < mapLayer1.length; i++) s.add(mapLayer1[i]!);
  return [...s];
})();

const ROAD_BLOCK = 256;
const TILE_GRASS = "#264f2a";
const TILE_GRASS_ALT = "#22482b";
const ROAD_FILL = "#1f1f24";
const ROAD_LINE = "#f4cc3a";
const ROAD_EDGE = "#3a3a44";
const ROAD_HALF = 64;
const ROAD_LANE = 32;

const TILEMAP_KIND_COLORS: Record<string, string> = {
  grass: "#3aa454",
  road: "#3a3a44",
  road_marking: "#f4cc3a",
  sidewalk: "#b0a48a",
  building: "#c83232",
  unknown: "#8050c0",
};

export interface CityDecorItem {
  kind: "house" | "trafficLight" | "other";
  sprite: string;
  xPx: number;
  yPx: number;
}

export interface CityObjectsPayload {
  version: number;
  worldWidthPx: number;
  worldHeightPx: number;
  tileSizePx: number;
  itemCount: number;
  items: CityDecorItem[];
}

export interface RenderableActor {
  id: string;
  kind: ActorKind;
  sprite: string;
  x: number;
  y: number;
  angle: number;
  visible?: boolean;
}

export interface RenderState {
  actors: RenderableActor[];
  hudText?: string;
}

/** `/maps/<missionId>/<missionId>-map.meta.json` — world-aligned stitched atlas. */
export interface MissionAtlasMeta {
  missionId: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  widthPx: number;
  heightPx: number;
  viewportW: number;
  viewportH: number;
  atlasFile: string;
  atlasMissing: boolean;
  tilemapFile?: string;
}

export type TilemapKind =
  | "empty"
  | "grass"
  | "road"
  | "road_marking"
  | "sidewalk"
  | "building"
  | "unknown";

export interface TilemapCell {
  col: number;
  row: number;
  tileId: number | null;
  kind: TilemapKind;
  passable: boolean;
  confidence: number;
}

/** `/maps/mission1/mission1-tilemap.json` — semantic 64×64 grid over the atlas. */
export interface MissionTilemap {
  missionId: string;
  tileSize: number;
  cols: number;
  rows: number;
  originWorld: { x: number; y: number };
  cells: TilemapCell[];
}

export class Renderer {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;

  /**
   * In "composite" map mode the world (grass/roads/markings/sprites) is rendered by a
   * DOM/SVG overlay sitting BEHIND the canvas. The canvas must therefore be transparent
   * each frame so the overlay shows through; only actors + traffic lights + HUD are
   * drawn here. Toggled via `setTransparentBackground(true)` in `Game.startMission`.
   */
  private transparentBackground = false;

  /** When set, `drawBackground` uses this atlas for mission1 world bounds instead of city tiles. */
  private missionAtlas: {
    missionId: string;
    meta: MissionAtlasMeta;
    image: HTMLImageElement;
  } | null = null;

  /** Optional structural tilemap aligned to the mission atlas (collisions, debug overlay). */
  missionTilemap: MissionTilemap | null = null;

  /** Toggle drawn over the atlas via `setTilemapDebug(true)` (e.g. hotkey in dev). */
  private tilemapDebug = false;

  bgImage: HTMLImageElement | null = null;
  decor: CityDecorItem[] = [];
  /** True after loadCity resolves successfully with JSON (image may still be missing). */
  cityDataLoaded = false;

  /** Preloaded `/city/tiles/tile_XXX.png` keyed by tile type id. */
  private tileImages = new Map<number, HTMLImageElement>();
  /** True when every tile id used on the map loaded successfully. */
  private tilesReady = false;

  private cityPromise: Promise<void> | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D context");
    this.ctx = ctx;
    this.width = canvas.width;
    this.height = canvas.height;
  }

  /**
   * Loads `/city/city-objects.json`, optional `/city/city-bg.png`, and tiled map PNGs.
   * Safe to call multiple times.
   */
  async loadCity(): Promise<void> {
    if (this.cityPromise) return this.cityPromise;

    this.cityPromise = (async () => {
      try {
        const res = await fetch("/city/city-objects.json");
        if (!res.ok) throw new Error(`city-objects.json ${res.status}`);
        const data = (await res.json()) as CityObjectsPayload;
        this.decor = Array.isArray(data.items) ? data.items : [];
        this.cityDataLoaded = true;

        await Promise.all([
          this.preloadCityTiles(),
          new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => {
              this.bgImage = img;
              resolve();
            };
            img.onerror = () => {
              this.bgImage = null;
              resolve();
            };
            img.src = "/city/city-bg.png";
          }),
        ]);
      } catch (e) {
        console.warn(
          "[Renderer] City map assets not available, using procedural background:",
          e,
        );
        this.decor = [];
        this.bgImage = null;
        this.cityDataLoaded = false;
        this.tileImages.clear();
        this.tilesReady = false;
      }
    })();

    return this.cityPromise;
  }

  /**
   * Load stitched map for a mission (`/maps/<missionId>/`), or clear when missionId is null.
   * Idempotent; safe to call before `loadCity` finishes.
   */
  loadMissionAtlas(missionId: string | null): Promise<void> {
    if (!missionId) {
      this.missionAtlas = null;
      this.missionTilemap = null;
      return Promise.resolve();
    }
    if (
      this.missionAtlas?.missionId === missionId &&
      this.missionAtlas?.image.complete &&
      this.missionAtlas.image.naturalWidth > 0
    ) {
      return Promise.resolve();
    }
    return (async () => {
      try {
        const base = `/maps/${missionId}/`;
        const res = await fetch(`${base}${missionId}-map.meta.json`);
        if (!res.ok) throw new Error(`mission meta ${res.status}`);
        const meta = (await res.json()) as MissionAtlasMeta;
        if (meta.atlasMissing) throw new Error("atlas marked missing");
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = () => reject(new Error("mission atlas image"));
          im.src = `${base}${meta.atlasFile}`;
        });
        this.missionAtlas = { missionId, meta, image: img };

        if (meta.tilemapFile) {
          try {
            const tmRes = await fetch(`${base}${meta.tilemapFile}`);
            if (tmRes.ok) {
              this.missionTilemap = (await tmRes.json()) as MissionTilemap;
              this.preloadMissionTiles(this.missionTilemap);
            } else {
              this.missionTilemap = null;
            }
          } catch (tmErr) {
            console.warn(`[Renderer] ${missionId} tilemap unavailable:`, tmErr);
            this.missionTilemap = null;
          }
        }
      } catch (e) {
        console.warn(
          `[Renderer] ${missionId} atlas unavailable, using city background:`,
          e,
        );
        this.missionAtlas = null;
        this.missionTilemap = null;
      }
    })();
  }

  /** World-space bounds of the loaded mission atlas, or null if not loaded. */
  getMissionAtlasBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (!this.missionAtlas) return null;
    const { meta } = this.missionAtlas;
    return { minX: meta.minX, minY: meta.minY, maxX: meta.maxX, maxY: meta.maxY };
  }

  setTilemapDebug(on: boolean) {
    this.tilemapDebug = on;
  }

  toggleTilemapDebug(): boolean {
    this.tilemapDebug = !this.tilemapDebug;
    return this.tilemapDebug;
  }

  private preloadCityTiles(): Promise<void> {
    this.tileImages.clear();
    this.tilesReady = false;
    const loaders = CITY_TILE_IDS.map(
      (id) =>
        new Promise<boolean>((resolve) => {
          const img = new Image();
          img.onload = () => {
            this.tileImages.set(id, img);
            resolve(true);
          };
          img.onerror = () => resolve(false);
          img.src = `/city/tiles/tile_${String(id).padStart(3, "0")}.png`;
        }),
    );
    return Promise.all(loaders).then((results) => {
      this.tilesReady =
        results.length > 0 && results.every((ok) => ok === true);
      if (!this.tilesReady && results.some((ok) => ok)) {
        console.warn(
          "[Renderer] Some city tiles failed to load; falling back to city-bg or procedural background.",
        );
      }
    });
  }

  clear() {
    if (this.transparentBackground) {
      this.ctx.clearRect(0, 0, this.width, this.height);
      return;
    }
    this.ctx.fillStyle = "#0c0c10";
    this.ctx.fillRect(0, 0, this.width, this.height);
  }

  /** Composite map mode: skip canvas fills so the DOM overlay behind it stays visible. */
  setTransparentBackground(on: boolean) {
    this.transparentBackground = on;
  }

  drawBackground(camera: Camera) {
    if (this.transparentBackground) return;
    // Prefer stitched atlas PNG over semantic tilemap so mission1-map.png is the visible course art.
    if (this.missionAtlas?.image?.complete && this.missionAtlas.image.naturalWidth > 0) {
      this.drawMissionAtlasBackground(camera);
      if (this.tilemapDebug && this.missionTilemap) {
        this.drawTilemapDebugOverlay(camera);
      }
    } else if (this.missionTilemap) {
      this.drawMission1TileBackground(camera);
      if (this.tilemapDebug) {
        this.drawTilemapDebugOverlay(camera);
      }
    } else if (this.tilesReady) {
      this.drawTiledCityBackground(camera);
    } else if (
      this.bgImage &&
      this.bgImage.complete &&
      this.bgImage.naturalWidth > 0
    ) {
      this.drawCityImageBackground(camera);
    } else {
      this.drawProceduralBackground(camera);
    }
  }

  /** Loads tile images for mission tilemap cells not already in tileImages. */
  private preloadMissionTiles(tilemap: MissionTilemap): void {
    const ids = new Set<number>();
    for (const cell of tilemap.cells) {
      if (cell.tileId !== null) ids.add(cell.tileId);
    }
    for (const id of ids) {
      if (this.tileImages.has(id)) continue;
      const img = new Image();
      img.onload = () => this.tileImages.set(id, img);
      img.src = `/city/tiles/tile_${String(id).padStart(3, "0")}.png`;
    }
  }

  /** Renders mission1 map by drawing individual 64×64 tiles from the tilemap. */
  private drawMission1TileBackground(camera: Camera): void {
    const tm = this.missionTilemap!;
    const { ctx } = this;
    const view = camera.view();
    const zoom = camera.zoom;
    const viewLeft = view.cx - view.width / 2;
    const viewTop = view.cy - view.height / 2;
    const ox = tm.originWorld.x;
    const oy = tm.originWorld.y;
    const TS = tm.tileSize;

    const c0 = Math.max(0, Math.floor((viewLeft - ox) / TS));
    const c1 = Math.min(tm.cols - 1, Math.ceil((viewLeft + view.width - ox) / TS));
    const r0 = Math.max(0, Math.floor((viewTop - oy) / TS));
    const r1 = Math.min(tm.rows - 1, Math.ceil((viewTop + view.height - oy) / TS));

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = tm.cells[r * tm.cols + c];
        if (!cell || cell.kind === "empty") continue;
        const { x: sx, y: sy } = camera.worldToScreen(ox + c * TS, oy + r * TS);
        if (cell.tileId !== null) {
          const img = this.tileImages.get(cell.tileId);
          if (img?.complete && img.naturalWidth > 0) {
            ctx.drawImage(img, sx, sy, TS * zoom, TS * zoom);
            continue;
          }
        }
        ctx.fillStyle = "#1e1e1e";
        ctx.fillRect(sx, sy, TS * zoom, TS * zoom);
      }
    }
  }

  /** Draws translucent kind-coloured squares over the atlas; toggled by debug flag. */
  private drawTilemapDebugOverlay(camera: Camera) {
    const tm = this.missionTilemap;
    if (!tm) return;
    const { ctx } = this;
    const view = camera.view();
    const zoom = camera.zoom;
    const viewLeft = view.cx - view.width / 2;
    const viewTop = view.cy - view.height / 2;
    const ts = tm.tileSize;
    const ox = tm.originWorld.x;
    const oy = tm.originWorld.y;

    const startCol = Math.max(0, Math.floor((viewLeft - ox) / ts));
    const startRow = Math.max(0, Math.floor((viewTop - oy) / ts));
    const endCol = Math.min(tm.cols, Math.ceil((viewLeft + view.width - ox) / ts));
    const endRow = Math.min(tm.rows, Math.ceil((viewTop + view.height - oy) / ts));

    ctx.save();
    ctx.globalAlpha = 0.35;
    for (let row = startRow; row < endRow; row++) {
      for (let col = startCol; col < endCol; col++) {
        const cell = tm.cells[row * tm.cols + col];
        if (!cell || cell.kind === "empty") continue;
        ctx.fillStyle = TILEMAP_KIND_COLORS[cell.kind] ?? "#888888";
        const { x: sx, y: sy } = camera.worldToScreen(ox + col * ts, oy + row * ts);
        ctx.fillRect(sx, sy, ts * zoom, ts * zoom);
      }
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    for (let col = startCol; col <= endCol; col++) {
      const { x } = camera.worldToScreen(ox + col * ts, 0);
      const { y: y0 } = camera.worldToScreen(0, oy + startRow * ts);
      const { y: y1 } = camera.worldToScreen(0, oy + endRow * ts);
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      ctx.stroke();
    }
    for (let row = startRow; row <= endRow; row++) {
      const { y } = camera.worldToScreen(0, oy + row * ts);
      const { x: x0 } = camera.worldToScreen(ox + startCol * ts, 0);
      const { x: x1 } = camera.worldToScreen(ox + endCol * ts, 0);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Stitched mission PNG; fills areas outside the atlas with procedural background. */
  private drawMissionAtlasBackground(camera: Camera) {
    const { ctx } = this;
    const { meta, image } = this.missionAtlas!;
    const view = camera.view();
    const zoom = camera.zoom;

    const viewLeft = view.cx - view.width / 2;
    const viewTop = view.cy - view.height / 2;
    const viewRight = viewLeft + view.width;
    const viewBottom = viewTop + view.height;

    // Fill entire viewport with procedural background first, then overlay atlas on top.
    this.drawProceduralBackground(camera);

    const worldLeft = meta.minX;
    const worldTop = meta.minY;
    const worldRight = meta.maxX;
    const worldBottom = meta.maxY;

    const interLeft = Math.max(viewLeft, worldLeft);
    const interTop = Math.max(viewTop, worldTop);
    const interRight = Math.min(viewRight, worldRight);
    const interBottom = Math.min(viewBottom, worldBottom);

    if (interLeft >= interRight || interTop >= interBottom) return;

    const srcX = interLeft - worldLeft;
    const srcY = interTop - worldTop;
    const srcW = interRight - interLeft;
    const srcH = interBottom - interTop;

    // Convert world coords of the intersection to screen coords for destination rect.
    const dst = camera.worldToScreen(interLeft, interTop);
    ctx.drawImage(image, srcX, srcY, srcW, srcH, dst.x, dst.y, srcW * zoom, srcH * zoom);
  }

  // TODO: cityMapData is incorrect for all missions — replace per-mission once tile maps are built
  private drawTiledCityBackground(camera: Camera) {
    const { ctx } = this;
    const view = camera.view();
    const zoom = camera.zoom;
    const viewLeft = view.cx - view.width / 2;
    const viewTop = view.cy - view.height / 2;

    const startCol = Math.floor(viewLeft / TILE_SIZE) - 1;
    const startRow = Math.floor(viewTop / TILE_SIZE) - 1;
    const endCol = Math.ceil((viewLeft + view.width) / TILE_SIZE) + 1;
    const endRow = Math.ceil((viewTop + view.height) / TILE_SIZE) + 1;

    const fallback = this.tileImages.get(0);

    for (let row = startRow; row < endRow; row++) {
      for (let col = startCol; col < endCol; col++) {
        const wx = col * TILE_SIZE;
        const wy = row * TILE_SIZE;
        const { x: sx, y: sy } = camera.worldToScreen(wx, wy);
        const id = getTile(col, row);
        const img = this.tileImages.get(id) ?? fallback;
        if (!img || !img.complete || img.naturalWidth <= 0) continue;
        ctx.drawImage(img, sx, sy, TILE_SIZE * zoom, TILE_SIZE * zoom);
      }
    }
  }

  /** Clipped blit of the 12288×12288 city texture for the current camera view. */
  private drawCityImageBackground(camera: Camera) {
    const { ctx } = this;
    const img = this.bgImage!;
    const view = camera.view();
    const zoom = camera.zoom;

    const viewLeft = view.cx - view.width / 2;
    const viewTop = view.cy - view.height / 2;

    const interLeft = Math.max(viewLeft, 0);
    const interTop = Math.max(viewTop, 0);
    const interRight = Math.min(viewLeft + view.width, WORLD_W);
    const interBottom = Math.min(viewTop + view.height, WORLD_H);

    if (interLeft < interRight && interTop < interBottom) {
      const srcX = interLeft;
      const srcY = interTop;
      const srcW = interRight - interLeft;
      const srcH = interBottom - interTop;
      const dst = camera.worldToScreen(interLeft, interTop);
      ctx.drawImage(img, srcX, srcY, srcW, srcH, dst.x, dst.y, srcW * zoom, srcH * zoom);
    }
  }

  /** Original placeholder grid (fallback). */
  private drawProceduralBackground(camera: Camera) {
    const { ctx, width, height } = this;
    const view = camera.view();
    const zoom = camera.zoom;
    const left = view.cx - view.width / 2;
    const top = view.cy - view.height / 2;

    const tileX0 = Math.floor(left / ROAD_BLOCK) - 1;
    const tileY0 = Math.floor(top / ROAD_BLOCK) - 1;
    const tileX1 = Math.ceil((left + view.width) / ROAD_BLOCK) + 1;
    const tileY1 = Math.ceil((top + view.height) / ROAD_BLOCK) + 1;

    for (let ty = tileY0; ty <= tileY1; ty++) {
      for (let tx = tileX0; tx <= tileX1; tx++) {
        const wx = tx * ROAD_BLOCK;
        const wy = ty * ROAD_BLOCK;
        const { x: sx, y: sy } = camera.worldToScreen(wx, wy);
        ctx.fillStyle = (tx + ty) % 2 === 0 ? TILE_GRASS : TILE_GRASS_ALT;
        ctx.fillRect(sx, sy, ROAD_BLOCK * zoom, ROAD_BLOCK * zoom);
      }
    }

    for (let ty = tileY0; ty <= tileY1; ty++) {
      const wy = ty * ROAD_BLOCK;
      const { y: sy } = camera.worldToScreen(0, wy);
      ctx.fillStyle = ROAD_FILL;
      ctx.fillRect(0, sy - ROAD_HALF * zoom, width, ROAD_HALF * 2 * zoom);
      ctx.fillStyle = ROAD_EDGE;
      ctx.fillRect(0, sy - ROAD_HALF * zoom, width, 2);
      ctx.fillRect(0, sy + ROAD_HALF * zoom - 2, width, 2);
    }
    for (let tx = tileX0; tx <= tileX1; tx++) {
      const wx = tx * ROAD_BLOCK;
      const { x: sx } = camera.worldToScreen(wx, 0);
      ctx.fillStyle = ROAD_FILL;
      ctx.fillRect(sx - ROAD_HALF * zoom, 0, ROAD_HALF * 2 * zoom, height);
      ctx.fillStyle = ROAD_EDGE;
      ctx.fillRect(sx - ROAD_HALF * zoom, 0, 2, height);
      ctx.fillRect(sx + ROAD_HALF * zoom - 2, 0, 2, height);
    }

    const dashW = 16 * zoom;
    const dashStep = 32 * zoom;
    ctx.fillStyle = ROAD_LINE;
    for (let ty = tileY0; ty <= tileY1; ty++) {
      const wy = ty * ROAD_BLOCK;
      const { y: sy } = camera.worldToScreen(0, wy);
      for (let dx = 0; dx < width + dashStep; dx += dashStep) {
        ctx.fillRect(dx, sy - 1, dashW, 2);
      }
    }
    for (let tx = tileX0; tx <= tileX1; tx++) {
      const wx = tx * ROAD_BLOCK;
      const { x: sx } = camera.worldToScreen(wx, 0);
      for (let dy = 0; dy < height + dashStep; dy += dashStep) {
        ctx.fillRect(sx - 1, dy, 2, dashW);
      }
    }

    void ROAD_LANE;
  }

  drawDecor(camera: Camera) {
    const { ctx } = this;
    const sorted = [...this.decor].sort((a, b) => a.yPx - b.yPx);
    for (const d of sorted) {
      if (d.kind === "other") continue;
      const { x, y } = camera.worldToScreen(d.xPx, d.yPx);
      if (x < -120 || y < -160 || x > this.width + 120 || y > this.height + 160)
        continue;

      ctx.save();
      ctx.translate(x, y);

      if (d.kind === "house") {
        const hw = 80;
        const hh = 80;
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(-hw / 2 + 3, -hh / 2 + 5, hw, hh);
        ctx.fillStyle = "#3d3548";
        ctx.strokeStyle = "#2a2533";
        ctx.lineWidth = 2;
        ctx.fillRect(-hw / 2, -hh / 2, hw, hh);
        ctx.strokeRect(-hw / 2, -hh / 2, hw, hh);
        ctx.fillStyle = "#c9b896";
        ctx.fillRect(-hw / 2 + 10, -hh / 2 + 12, hw - 20, 18);
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("⌂", 0, 6);
      } else if (d.kind === "trafficLight") {
        ctx.fillStyle = "#2a2a2e";
        ctx.fillRect(-3, -36, 6, 40);
        ctx.fillStyle = "#111";
        ctx.fillRect(-10, -42, 20, 28);
        ctx.fillStyle = "#c83232";
        ctx.beginPath();
        ctx.arc(0, -34, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#e8c940";
        ctx.beginPath();
        ctx.arc(0, -22, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#3dab4a";
        ctx.beginPath();
        ctx.arc(0, -10, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  drawActor(actor: RenderableActor, camera: Camera) {
    if (actor.visible === false) return;
    const v = visualForActor(actor.kind, actor.sprite);
    if (v.shape === "none") return;
    const { x, y } = camera.worldToScreen(actor.x, actor.y);
    if (x < -120 || y < -140 || x > this.width + 120 || y > this.height + 140) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(actor.angle + Math.PI / 2);
    this.drawShape(ctx, v);
    ctx.restore();
  }

  private drawShape(ctx: CanvasRenderingContext2D, v: ReturnType<typeof visualForActor>) {
    const { color: C, accent: A, width: W, height: H } = v;
    const hw = W / 2;
    const hh = H / 2;

    switch (v.shape) {
      // ── sedan (regular car, top-down view) ──────────────────────────────
      case "sedan": {
        // shadow
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(-hw + 3, -hh + 5, W, H);
        // body
        ctx.fillStyle = C;
        this.roundRect(-hw, -hh, W, H, 5);
        ctx.fill();
        // windshield (front)
        ctx.fillStyle = "rgba(180,230,255,0.75)";
        ctx.fillRect(-hw + 5, -hh + 5, W - 10, Math.round(H * 0.22));
        // rear window
        ctx.fillStyle = "rgba(140,200,240,0.55)";
        ctx.fillRect(-hw + 5, hh - 5 - Math.round(H * 0.16), W - 10, Math.round(H * 0.16));
        // roof panel
        ctx.fillStyle = "rgba(0,0,0,0.12)";
        const roofTop = -hh + 5 + Math.round(H * 0.22) + 2;
        const roofBot = hh - 5 - Math.round(H * 0.16) - 2;
        ctx.fillRect(-hw + 6, roofTop, W - 12, roofBot - roofTop);
        // headlights
        ctx.fillStyle = "#fffbe0";
        ctx.fillRect(-hw + 3, -hh + 3, 5, 4);
        ctx.fillRect(hw - 8, -hh + 3, 5, 4);
        // tail lights
        ctx.fillStyle = "#e83030";
        ctx.fillRect(-hw + 3, hh - 7, 5, 4);
        ctx.fillRect(hw - 8, hh - 7, 5, 4);
        // wheels
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(-hw - 2, -hh + 7, 4, 10);
        ctx.fillRect(hw - 2, -hh + 7, 4, 10);
        ctx.fillRect(-hw - 2, hh - 17, 4, 10);
        ctx.fillRect(hw - 2, hh - 17, 4, 10);
        break;
      }

      // ── sedan_sport (player car — sleeker, brighter) ─────────────────────
      case "sedan_sport": {
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(-hw + 3, -hh + 5, W, H);
        ctx.fillStyle = C;
        this.roundRect(-hw, -hh, W, H, 6);
        ctx.fill();
        // racing stripe
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.fillRect(-3, -hh + 2, 6, H - 4);
        // windshield
        ctx.fillStyle = "rgba(180,235,255,0.82)";
        ctx.fillRect(-hw + 5, -hh + 5, W - 10, Math.round(H * 0.22));
        // rear window
        ctx.fillStyle = "rgba(150,210,250,0.62)";
        ctx.fillRect(-hw + 5, hh - 5 - Math.round(H * 0.15), W - 10, Math.round(H * 0.15));
        // headlights (wider, DRL style)
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(-hw + 3, -hh + 3, 6, 3);
        ctx.fillRect(hw - 9, -hh + 3, 6, 3);
        // tail lights
        ctx.fillStyle = "#ff2020";
        ctx.fillRect(-hw + 3, hh - 6, 6, 3);
        ctx.fillRect(hw - 9, hh - 6, 6, 3);
        // wheels
        ctx.fillStyle = "#151515";
        ctx.fillRect(-hw - 2, -hh + 7, 4, 9);
        ctx.fillRect(hw - 2, -hh + 7, 4, 9);
        ctx.fillRect(-hw - 2, hh - 16, 4, 9);
        ctx.fillRect(hw - 2, hh - 16, 4, 9);
        break;
      }

      // ── driving school (Russian "У" — учебная машина) ────────────────────
      case "driving_school": {
        // shadow
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(-hw + 3, -hh + 5, W, H);
        // body
        ctx.fillStyle = C;
        this.roundRect(-hw, -hh, W, H, 6);
        ctx.fill();
        // windshield
        ctx.fillStyle = "rgba(180,235,255,0.82)";
        ctx.fillRect(-hw + 5, -hh + 5, W - 10, Math.round(H * 0.22));
        // rear window
        ctx.fillStyle = "rgba(150,210,250,0.62)";
        ctx.fillRect(-hw + 5, hh - 5 - Math.round(H * 0.15), W - 10, Math.round(H * 0.15));
        // headlights
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(-hw + 3, -hh + 3, 6, 3);
        ctx.fillRect(hw - 9, -hh + 3, 6, 3);
        // tail lights
        ctx.fillStyle = "#ff2020";
        ctx.fillRect(-hw + 3, hh - 6, 6, 3);
        ctx.fillRect(hw - 9, hh - 6, 6, 3);
        // wheels
        ctx.fillStyle = "#151515";
        ctx.fillRect(-hw - 2, -hh + 7, 4, 9);
        ctx.fillRect(hw - 2, -hh + 7, 4, 9);
        ctx.fillRect(-hw - 2, hh - 16, 4, 9);
        ctx.fillRect(hw - 2, hh - 16, 4, 9);

        // === Driving-school decals ===

        // Side "У" letters on the doors (white pill with red letter)
        const sideY = 0;
        const sidePadW = 8;
        const sidePadH = 9;
        for (const sx of [-hw + 2, hw - sidePadW - 2]) {
          ctx.fillStyle = "#ffffff";
          this.roundRect(sx, sideY - sidePadH / 2, sidePadW, sidePadH, 2);
          ctx.fill();
          ctx.fillStyle = "#d62828";
          ctx.font = "bold 8px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("У", sx + sidePadW / 2, sideY + 0.5);
        }

        // Roof sign: red-bordered triangle with bold "У" (classic учебный знак)
        const roofCX = 0;
        const roofCY = -hh + Math.round(H * 0.42);
        const triR = 8;
        // sign mount/base
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(roofCX - triR - 2, roofCY + triR - 1, (triR + 2) * 2, 3);
        // triangle (point up) — white fill, red border
        ctx.beginPath();
        ctx.moveTo(roofCX, roofCY - triR);
        ctx.lineTo(roofCX + triR, roofCY + triR);
        ctx.lineTo(roofCX - triR, roofCY + triR);
        ctx.closePath();
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#d62828";
        ctx.stroke();
        // "У" letter inside the triangle
        ctx.fillStyle = "#1a1a1a";
        ctx.font = "bold 9px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("У", roofCX, roofCY + 3);

        // reset text baseline so it doesn't leak into other shapes
        ctx.textBaseline = "alphabetic";
        break;
      }

      // ── police ───────────────────────────────────────────────────────────
      case "police": {
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(-hw + 3, -hh + 5, W, H);
        ctx.fillStyle = C;
        this.roundRect(-hw, -hh, W, H, 5);
        ctx.fill();
        // white/blue checker stripe
        const stripeH = 6;
        const stripeY = -hh + Math.round(H * 0.38);
        const sqW = 5;
        for (let i = 0; i < Math.ceil(W / sqW); i++) {
          ctx.fillStyle = i % 2 === 0 ? "#ffffff" : "#1a3a9a";
          ctx.fillRect(-hw + i * sqW, stripeY, sqW, stripeH);
        }
        // windshield
        ctx.fillStyle = "rgba(180,230,255,0.75)";
        ctx.fillRect(-hw + 5, -hh + 5, W - 10, Math.round(H * 0.2));
        // light bar on roof
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(-hw + 6, -hh + Math.round(H * 0.28), W - 12, 5);
        ctx.fillStyle = "#2060ff";
        ctx.fillRect(-hw + 7, -hh + Math.round(H * 0.28) + 1, Math.round((W - 14) / 2) - 1, 3);
        ctx.fillStyle = "#ff2020";
        ctx.fillRect(-hw + 7 + Math.round((W - 14) / 2) + 1, -hh + Math.round(H * 0.28) + 1, Math.round((W - 14) / 2) - 1, 3);
        // headlights
        ctx.fillStyle = "#fffbe0";
        ctx.fillRect(-hw + 3, -hh + 3, 5, 4);
        ctx.fillRect(hw - 8, -hh + 3, 5, 4);
        // tail lights
        ctx.fillStyle = "#e83030";
        ctx.fillRect(-hw + 3, hh - 7, 5, 4);
        ctx.fillRect(hw - 8, hh - 7, 5, 4);
        // wheels
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(-hw - 2, -hh + 7, 4, 10);
        ctx.fillRect(hw - 2, -hh + 7, 4, 10);
        ctx.fillRect(-hw - 2, hh - 17, 4, 10);
        ctx.fillRect(hw - 2, hh - 17, 4, 10);
        break;
      }

      // ── emergency (ambulance / fire) ─────────────────────────────────────
      case "emergency": {
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(-hw + 3, -hh + 5, W, H);
        ctx.fillStyle = C;
        this.roundRect(-hw, -hh, W, H, 5);
        ctx.fill();
        // cross symbol
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fillRect(-3, -hh + Math.round(H * 0.3), 6, Math.round(H * 0.3));
        ctx.fillRect(-hw + Math.round(W * 0.2), -hh + Math.round(H * 0.38), Math.round(W * 0.6), Math.round(H * 0.14));
        // windshield
        ctx.fillStyle = "rgba(180,230,255,0.75)";
        ctx.fillRect(-hw + 4, -hh + 4, W - 8, Math.round(H * 0.18));
        // light bar
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(-hw + 5, -hh + Math.round(H * 0.25), W - 10, 4);
        ctx.fillStyle = "#ff2020";
        ctx.fillRect(-hw + 6, -hh + Math.round(H * 0.25) + 1, Math.round((W - 12) / 2) - 1, 2);
        ctx.fillStyle = "#2060ff";
        ctx.fillRect(-hw + 6 + Math.round((W - 12) / 2) + 1, -hh + Math.round(H * 0.25) + 1, Math.round((W - 12) / 2) - 1, 2);
        // headlights
        ctx.fillStyle = "#fffbe0";
        ctx.fillRect(-hw + 3, -hh + 3, 5, 4);
        ctx.fillRect(hw - 8, -hh + 3, 5, 4);
        // tail lights
        ctx.fillStyle = "#e83030";
        ctx.fillRect(-hw + 3, hh - 7, 5, 4);
        ctx.fillRect(hw - 8, hh - 7, 5, 4);
        // wheels
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(-hw - 2, -hh + 7, 4, 10);
        ctx.fillRect(hw - 2, -hh + 7, 4, 10);
        ctx.fillRect(-hw - 2, hh - 17, 4, 10);
        ctx.fillRect(hw - 2, hh - 17, 4, 10);
        break;
      }

      // ── taxi ─────────────────────────────────────────────────────────────
      case "taxi": {
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(-hw + 3, -hh + 5, W, H);
        ctx.fillStyle = C;
        this.roundRect(-hw, -hh, W, H, 5);
        ctx.fill();
        // taxi sign on roof
        ctx.fillStyle = "#333";
        ctx.fillRect(-7, -hh + Math.round(H * 0.28) - 4, 14, 6);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(-6, -hh + Math.round(H * 0.28) - 3, 12, 4);
        // black checker stripe
        const txSqW = 4;
        const txStripeY = -hh + Math.round(H * 0.38);
        for (let i = 0; i < Math.ceil(W / txSqW); i++) {
          ctx.fillStyle = i % 2 === 0 ? "#111" : C;
          ctx.fillRect(-hw + i * txSqW, txStripeY, txSqW, 5);
        }
        // windshield
        ctx.fillStyle = "rgba(180,230,255,0.75)";
        ctx.fillRect(-hw + 5, -hh + 5, W - 10, Math.round(H * 0.2));
        // headlights
        ctx.fillStyle = "#fffbe0";
        ctx.fillRect(-hw + 3, -hh + 3, 5, 4);
        ctx.fillRect(hw - 8, -hh + 3, 5, 4);
        // tail lights
        ctx.fillStyle = "#e83030";
        ctx.fillRect(-hw + 3, hh - 7, 5, 4);
        ctx.fillRect(hw - 8, hh - 7, 5, 4);
        // wheels
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(-hw - 2, -hh + 7, 4, 10);
        ctx.fillRect(hw - 2, -hh + 7, 4, 10);
        ctx.fillRect(-hw - 2, hh - 17, 4, 10);
        ctx.fillRect(hw - 2, hh - 17, 4, 10);
        break;
      }

      // ── truck_modern ─────────────────────────────────────────────────────
      case "truck_modern": {
        const cabH = Math.round(H * 0.3);
        const cargoH = H - cabH - 3;
        // shadow
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.fillRect(-hw + 3, -hh + 5, W, H);
        // cargo box
        ctx.fillStyle = C;
        this.roundRect(-hw, -hh + cabH + 3, W, cargoH, 3);
        ctx.fill();
        // cargo ribs
        ctx.fillStyle = "rgba(0,0,0,0.15)";
        for (let i = 1; i <= 4; i++) {
          const ry = -hh + cabH + 3 + (i * cargoH) / 5;
          ctx.fillRect(-hw + 3, ry - 1, W - 6, 2);
        }
        ctx.fillStyle = "rgba(0,0,0,0.22)";
        ctx.fillRect(-hw + 4, -hh + cabH + 5, 2, cargoH - 8);
        ctx.fillRect(hw - 6, -hh + cabH + 5, 2, cargoH - 8);
        // cab
        ctx.fillStyle = C;
        this.roundRect(-hw, -hh, W, cabH, 5);
        ctx.fill();
        // cab windshield
        ctx.fillStyle = "rgba(170,225,255,0.78)";
        ctx.fillRect(-hw + 4, -hh + 4, W - 8, Math.round(cabH * 0.48));
        // grille
        ctx.fillStyle = A;
        ctx.fillRect(-hw + 3, -hh + cabH - 6, W - 6, 5);
        // headlights
        ctx.fillStyle = "#fffde0";
        ctx.fillRect(-hw + 3, -hh + cabH - 9, 5, 5);
        ctx.fillRect(hw - 8, -hh + cabH - 9, 5, 5);
        // rear lights
        ctx.fillStyle = "#e82222";
        ctx.fillRect(-hw + 2, hh - 6, 6, 4);
        ctx.fillRect(hw - 8, hh - 6, 6, 4);
        // wheels (6: 2 front + 4 rear dual)
        ctx.fillStyle = "#1a1a1a";
        const wFront = -hh + cabH - 3;
        ctx.fillRect(-hw - 3, wFront - 6, 5, 12);
        ctx.fillRect(hw - 2, wFront - 6, 5, 12);
        ctx.fillRect(-hw - 3, hh - 20, 5, 9);
        ctx.fillRect(-hw - 3, hh - 9, 5, 9);
        ctx.fillRect(hw - 2, hh - 20, 5, 9);
        ctx.fillRect(hw - 2, hh - 9, 5, 9);
        break;
      }

      // ── bus ──────────────────────────────────────────────────────────────
      case "bus": {
        ctx.fillStyle = "rgba(0,0,0,0.38)";
        ctx.fillRect(-hw + 3, -hh + 5, W, H);
        ctx.fillStyle = C;
        this.roundRect(-hw, -hh, W, H, 4);
        ctx.fill();
        // windows strip (top)
        ctx.fillStyle = "rgba(180,230,255,0.7)";
        ctx.fillRect(-hw + 3, -hh + 4, W - 6, Math.round(H * 0.12));
        // windows strip (bottom)
        ctx.fillRect(-hw + 3, hh - 4 - Math.round(H * 0.12), W - 6, Math.round(H * 0.12));
        // side windows row
        ctx.fillStyle = "rgba(160,215,250,0.6)";
        const winH = Math.round(H * 0.09);
        const winY0 = -hh + 4 + Math.round(H * 0.12) + 3;
        const winY1 = hh - 4 - Math.round(H * 0.12) - 3 - winH;
        const nWin = 3;
        const winW = Math.round((W - 10) / nWin) - 2;
        for (let i = 0; i < nWin; i++) {
          const wx = -hw + 5 + i * (winW + 2);
          ctx.fillRect(wx, winY0, winW, winH);
          ctx.fillRect(wx, winY1, winW, winH);
        }
        // destination board
        ctx.fillStyle = A;
        ctx.fillRect(-hw + 4, -hh + 4 + Math.round(H * 0.12) + 3 + winH + 2, W - 8, 5);
        // headlights
        ctx.fillStyle = "#fffbe0";
        ctx.fillRect(-hw + 3, -hh + 3, 5, 4);
        ctx.fillRect(hw - 8, -hh + 3, 5, 4);
        // tail lights
        ctx.fillStyle = "#e83030";
        ctx.fillRect(-hw + 3, hh - 7, 5, 4);
        ctx.fillRect(hw - 8, hh - 7, 5, 4);
        // wheels (4)
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(-hw - 2, -hh + 8, 4, 12);
        ctx.fillRect(hw - 2, -hh + 8, 4, 12);
        ctx.fillRect(-hw - 2, hh - 20, 4, 12);
        ctx.fillRect(hw - 2, hh - 20, 4, 12);
        break;
      }

      // ── minibus (gazel / van) ─────────────────────────────────────────────
      case "minibus": {
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(-hw + 3, -hh + 5, W, H);
        ctx.fillStyle = C;
        this.roundRect(-hw, -hh, W, H, 5);
        ctx.fill();
        // windshield (tall van-style)
        ctx.fillStyle = "rgba(180,230,255,0.75)";
        ctx.fillRect(-hw + 4, -hh + 4, W - 8, Math.round(H * 0.25));
        // side windows
        ctx.fillStyle = "rgba(160,215,250,0.6)";
        const mbWinH = Math.round(H * 0.14);
        const mbWinY = -hh + 4 + Math.round(H * 0.25) + 3;
        ctx.fillRect(-hw + 4, mbWinY, Math.round((W - 10) / 2) - 1, mbWinH);
        ctx.fillRect(-hw + 4 + Math.round((W - 10) / 2) + 2, mbWinY, Math.round((W - 10) / 2) - 1, mbWinH);
        // rear window
        ctx.fillStyle = "rgba(140,200,240,0.55)";
        ctx.fillRect(-hw + 4, hh - 4 - Math.round(H * 0.18), W - 8, Math.round(H * 0.18));
        // headlights
        ctx.fillStyle = "#fffbe0";
        ctx.fillRect(-hw + 3, -hh + 3, 5, 4);
        ctx.fillRect(hw - 8, -hh + 3, 5, 4);
        // tail lights
        ctx.fillStyle = "#e83030";
        ctx.fillRect(-hw + 3, hh - 7, 5, 4);
        ctx.fillRect(hw - 8, hh - 7, 5, 4);
        // wheels
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(-hw - 2, -hh + 7, 4, 10);
        ctx.fillRect(hw - 2, -hh + 7, 4, 10);
        ctx.fillRect(-hw - 2, hh - 17, 4, 10);
        ctx.fillRect(hw - 2, hh - 17, 4, 10);
        break;
      }

      // ── motorcycle ────────────────────────────────────────────────────────
      case "motorcycle": {
        // shadow
        ctx.fillStyle = "rgba(0,0,0,0.3)";
        ctx.fillRect(-hw + 2, -hh + 3, W, H);
        // frame
        ctx.fillStyle = C;
        this.roundRect(-hw + 1, -hh + 4, W - 2, H - 8, 3);
        ctx.fill();
        // fuel tank (center bulge)
        ctx.fillStyle = A;
        this.roundRect(-hw + 2, -hh + Math.round(H * 0.3), W - 4, Math.round(H * 0.22), 2);
        ctx.fill();
        // handlebars (front)
        ctx.fillStyle = "#555";
        ctx.fillRect(-hw - 1, -hh + 3, W + 2, 3);
        // headlight
        ctx.fillStyle = "#fffde0";
        ctx.fillRect(-hw + 2, -hh + 1, W - 4, 4);
        // tail light
        ctx.fillStyle = "#e83030";
        ctx.fillRect(-hw + 2, hh - 5, W - 4, 3);
        // wheels
        ctx.fillStyle = "#1a1a1a";
        ctx.beginPath();
        ctx.arc(0, -hh + 5, hw, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#555";
        ctx.beginPath();
        ctx.arc(0, -hh + 5, hw - 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#1a1a1a";
        ctx.beginPath();
        ctx.arc(0, hh - 5, hw, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#555";
        ctx.beginPath();
        ctx.arc(0, hh - 5, hw - 2, 0, Math.PI * 2);
        ctx.fill();
        break;
      }

      // ── tram / train ─────────────────────────────────────────────────────
      case "tram": {
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.fillRect(-hw + 4, -hh + 6, W, H);
        ctx.fillStyle = C;
        this.roundRect(-hw, -hh, W, H, 4);
        ctx.fill();
        // accent stripe
        ctx.fillStyle = A;
        ctx.fillRect(-hw, -hh + Math.round(H * 0.08), W, Math.round(H * 0.06));
        ctx.fillRect(-hw, hh - Math.round(H * 0.08) - Math.round(H * 0.06), W, Math.round(H * 0.06));
        // windows
        ctx.fillStyle = "rgba(180,230,255,0.7)";
        const tramWinH = Math.round(H * 0.08);
        const tramWinCount = 4;
        const tramWinW = Math.round((W - 12) / tramWinCount) - 2;
        const tramWinYTop = -hh + Math.round(H * 0.18);
        const tramWinYBot = hh - Math.round(H * 0.18) - tramWinH;
        for (let i = 0; i < tramWinCount; i++) {
          const twx = -hw + 6 + i * (tramWinW + 2);
          ctx.fillRect(twx, tramWinYTop, tramWinW, tramWinH);
          ctx.fillRect(twx, tramWinYBot, tramWinW, tramWinH);
        }
        // front/rear panels
        ctx.fillStyle = "rgba(0,0,0,0.2)";
        ctx.fillRect(-hw + 3, -hh + 3, W - 6, Math.round(H * 0.06));
        ctx.fillRect(-hw + 3, hh - 3 - Math.round(H * 0.06), W - 6, Math.round(H * 0.06));
        // headlights
        ctx.fillStyle = "#fffbe0";
        ctx.fillRect(-hw + 4, -hh + 3, 5, 4);
        ctx.fillRect(hw - 9, -hh + 3, 5, 4);
        ctx.fillRect(-hw + 4, hh - 7, 5, 4);
        ctx.fillRect(hw - 9, hh - 7, 5, 4);
        // rails
        ctx.fillStyle = "#888";
        ctx.fillRect(-hw + 2, -hh, 2, H);
        ctx.fillRect(hw - 4, -hh, 2, H);
        break;
      }

      // ── tractor ───────────────────────────────────────────────────────────
      case "tractor": {
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(-hw + 3, -hh + 5, W, H);
        // body
        ctx.fillStyle = C;
        this.roundRect(-hw, -hh + Math.round(H * 0.25), W, Math.round(H * 0.55), 4);
        ctx.fill();
        // cabin (smaller, front)
        ctx.fillStyle = C;
        this.roundRect(-hw + 4, -hh, W - 8, Math.round(H * 0.35), 4);
        ctx.fill();
        // cabin window
        ctx.fillStyle = "rgba(180,230,255,0.75)";
        ctx.fillRect(-hw + 7, -hh + 3, W - 14, Math.round(H * 0.2));
        // exhaust pipe
        ctx.fillStyle = "#444";
        ctx.fillRect(hw - 6, -hh + 2, 3, Math.round(H * 0.18));
        // accent (engine hood)
        ctx.fillStyle = A;
        ctx.fillRect(-hw + 4, -hh + Math.round(H * 0.35), W - 8, 4);
        // large rear wheels
        ctx.fillStyle = "#1a1a1a";
        ctx.beginPath(); ctx.arc(-hw, hh - Math.round(H * 0.2), Math.round(H * 0.2), 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(hw, hh - Math.round(H * 0.2), Math.round(H * 0.2), 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#444";
        ctx.beginPath(); ctx.arc(-hw, hh - Math.round(H * 0.2), Math.round(H * 0.2) - 3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(hw, hh - Math.round(H * 0.2), Math.round(H * 0.2) - 3, 0, Math.PI * 2); ctx.fill();
        // small front wheels
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(-hw + 3, -hh + Math.round(H * 0.28) - 4, 6, 8);
        ctx.fillRect(hw - 9, -hh + Math.round(H * 0.28) - 4, 6, 8);
        break;
      }

      // ── horse ─────────────────────────────────────────────────────────────
      case "horse": {
        ctx.fillStyle = "rgba(0,0,0,0.28)";
        ctx.fillRect(-hw + 2, -hh + 4, W, H);
        // body (oval)
        ctx.fillStyle = C;
        ctx.beginPath();
        ctx.ellipse(0, 0, hw, hh * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
        // head (front)
        ctx.fillStyle = A;
        ctx.beginPath();
        ctx.ellipse(0, -hh * 0.6, hw * 0.55, hh * 0.28, 0, 0, Math.PI * 2);
        ctx.fill();
        // mane
        ctx.fillStyle = "#3a2010";
        ctx.fillRect(-2, -hh * 0.88, 4, hh * 0.3);
        // legs (4 small rects)
        ctx.fillStyle = "#4a3020";
        ctx.fillRect(-hw + 1, hh * 0.35, 4, hh * 0.4);
        ctx.fillRect(-hw + 7, hh * 0.35, 4, hh * 0.4);
        ctx.fillRect(hw - 11, hh * 0.35, 4, hh * 0.4);
        ctx.fillRect(hw - 5, hh * 0.35, 4, hh * 0.4);
        // tail
        ctx.fillStyle = "#3a2010";
        ctx.fillRect(-2, hh * 0.5, 4, hh * 0.4);
        break;
      }

      // ── bicycle ───────────────────────────────────────────────────────────
      case "bicycle": {
        ctx.fillStyle = "rgba(0,0,0,0.25)";
        ctx.fillRect(-hw + 1, -hh + 3, W + 2, H);
        // wheels
        ctx.strokeStyle = "#1a1a1a";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, -hh + hw, hw, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, hh - hw, hw, 0, Math.PI * 2); ctx.stroke();
        // frame
        ctx.strokeStyle = A;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, -hh + hw);
        ctx.lineTo(-hw + 2, hh - hw);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, -hh + hw);
        ctx.lineTo(hw - 2, hh - hw);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-hw + 2, hh - hw);
        ctx.lineTo(hw - 2, hh - hw);
        ctx.stroke();
        // handlebar
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#555";
        ctx.beginPath();
        ctx.moveTo(-hw, -hh + hw - 2);
        ctx.lineTo(hw, -hh + hw - 2);
        ctx.stroke();
        break;
      }

      // ── pedestrian ────────────────────────────────────────────────────────
      case "ped": {
        // shadow
        ctx.fillStyle = "rgba(0,0,0,0.28)";
        ctx.beginPath();
        ctx.ellipse(2, 2, W / 2, W / 2 * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
        // body (torso)
        ctx.fillStyle = C;
        ctx.beginPath();
        ctx.ellipse(0, 1, W / 2 - 1, W / 2, 0, 0, Math.PI * 2);
        ctx.fill();
        // head
        ctx.fillStyle = "#e8c8a0";
        ctx.beginPath();
        ctx.arc(0, -W / 2 + 1, W / 3, 0, Math.PI * 2);
        ctx.fill();
        // legs
        ctx.fillStyle = A;
        ctx.fillRect(-W / 2 + 2, W / 4, W / 2 - 2, 4);
        ctx.fillRect(2, W / 4, W / 2 - 2, 4);
        break;
      }

      // ── traffic light (actor sprite, not world TL) ─────────────────────
      case "tl": {
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(-hw - 2, -hh - 2, W + 4, H + 4);
        ctx.fillStyle = v.color;
        ctx.fillRect(-hw, -hh, W, H);
        break;
      }

      default:
        break;
    }
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /** Per-barrier: tracks when it started opening/closing for smooth animation. */
  private barrierTimes = new Map<number, { openTime: number; closeTime: number; prevColor: string }>();

  private getBarrierAngle(id: number, color: string, now: number): number {
    const ANIM_MS = 1200;
    let b = this.barrierTimes.get(id);
    if (!b) {
      b = { openTime: color !== "red" ? now - ANIM_MS : -Infinity, closeTime: color === "red" ? now - ANIM_MS : -Infinity, prevColor: color };
      this.barrierTimes.set(id, b);
    }
    if (color !== b.prevColor) {
      if (color === "red") b.closeTime = now;
      else b.openTime = now;
      b.prevColor = color;
    }
    if (color === "red") {
      return Math.max(0, 90 - Math.min(1, (now - b.closeTime) / ANIM_MS) * 90);
    }
    return Math.min(90, Math.min(1, (now - b.openTime) / ANIM_MS) * 90);
  }

  drawTrafficLights(
    lights: TrafficLightDef[],
    tlColors: Record<number, TLColor>,
    camera: Camera,
    now: number
  ) {
    const { ctx } = this;
    const TL_COLOR_MAP: Record<TLColor, string | null> = {
      red:        "#e23a3a",
      yellow:     "#f4cc3a",
      green:      "#3ac24a",
      yellowblink: "#f4cc3a",
      whiteblink:  "#f0f0f0",
      off:        null,
    };
    const blink = Math.floor(now / 500) % 2 === 0;

    for (const tl of lights) {
      const { x: sx, y: sy } = camera.worldToScreen(tl.x, tl.y);
      if (sx < -40 || sy < -100 || sx > this.width + 40 || sy > this.height + 40) continue;

      const color = tlColors[tl.id] ?? "off";

      // --- Barrier ---
      if (tl.type === "barrier") {
        const angleDeg = this.getBarrierAngle(tl.id, color, now);
        const angleRad = angleDeg * Math.PI / 180;
        const ARM = 135 * camera.zoom;
        const visLen = ARM * Math.cos(angleRad);
        const POST_H = 36 * camera.zoom;
        const POST_W = 5 * camera.zoom;
        ctx.save();
        ctx.translate(sx, sy);
        if (tl.rotation) ctx.rotate((tl.rotation * Math.PI) / 180);

        // Base plate
        ctx.fillStyle = "#333";
        ctx.fillRect(-POST_W * 1.6, 0, POST_W * 3.2, POST_W * 1.4);

        // Post body (gradient-like: dark sides)
        ctx.fillStyle = "#666";
        ctx.fillRect(-POST_W / 2, -POST_H, POST_W, POST_H);
        ctx.fillStyle = "#888";
        ctx.fillRect(-POST_W / 2 + 1, -POST_H + 2, POST_W - 2, POST_H - 4);

        // Post top cap
        ctx.fillStyle = "#444";
        ctx.beginPath();
        ctx.arc(0, -POST_H, POST_W * 0.8, 0, Math.PI * 2);
        ctx.fill();

        // Arm stripes (red/white) — horizontal, foreshortened
        if (visLen > 1) {
          const ARM_H = 6 * camera.zoom;
          const STRIPES = 6;
          const sw = visLen / STRIPES;
          // Arm shadow
          ctx.fillStyle = "rgba(0,0,0,0.3)";
          ctx.fillRect(0, -POST_H - ARM_H / 2 + 2, visLen, ARM_H);
          for (let i = 0; i < STRIPES; i++) {
            ctx.fillStyle = i % 2 === 0 ? "#e23a3a" : "#f0f0f0";
            ctx.fillRect(i * sw, -POST_H - ARM_H / 2, sw, ARM_H);
          }
          // Arm border
          ctx.strokeStyle = "#333";
          ctx.lineWidth = 0.8;
          ctx.strokeRect(0, -POST_H - ARM_H / 2, visLen, ARM_H);
        }

        // Tip cap
        ctx.fillStyle = "#e23a3a";
        ctx.beginPath();
        ctx.arc(visLen, -POST_H, 4 * camera.zoom, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
        continue;
      }

      const isBlinking = color === "yellowblink" || color === "whiteblink";

      // Determine active color string for glow
      const activeColorStr: string | null =
        color === "red" ? TL_COLOR_MAP.red :
        color === "yellow" ? TL_COLOR_MAP.yellow :
        color === "green" ? TL_COLOR_MAP.green :
        isBlinking && blink ? TL_COLOR_MAP[color] : null;

      ctx.save();
      ctx.translate(sx, sy);
      if (tl.rotation) ctx.rotate((tl.rotation * Math.PI) / 180);
      if (tl.flipY) ctx.scale(1, -1);

      // Shared geometry
      const poleW = 5;
      const poleH = 34;
      const boxW = 22;
      const boxH = 76;
      const boxX = -boxW / 2;
      const boxY = -(poleH + boxH);
      const r = 4; // corner radius of housing

      if (tl.sideView) {
        // Side-on: thin vertical slice of the housing + pole
        ctx.fillStyle = "#3a3a3e";
        ctx.fillRect(-2, -poleH, 4, poleH);
        ctx.fillStyle = "#222226";
        ctx.fillRect(-3, boxY, 6, boxH);
        // subtle highlight
        ctx.fillStyle = "rgba(255,255,255,0.07)";
        ctx.fillRect(-3, boxY, 2, boxH);
        if (activeColorStr) {
          ctx.shadowColor = activeColorStr;
          ctx.shadowBlur = 16;
          ctx.fillStyle = activeColorStr;
          ctx.globalAlpha = 0.3;
          ctx.fillRect(-3, boxY, 6, boxH);
          ctx.globalAlpha = 1;
          ctx.shadowBlur = 0;
        }
      } else if (tl.backView) {
        // Back side: pole + housing back panel, faint glow bleed
        ctx.fillStyle = "#3a3a3e";
        ctx.fillRect(-poleW / 2, -poleH, poleW, poleH);
        // housing back (slightly darker, no lamps)
        ctx.fillStyle = "#1c1c20";
        this.roundRect(boxX, boxY, boxW, boxH, r);
        ctx.fill();
        // back ridge detail
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(boxX + 2, boxY + 4, 2, boxH - 8);
        ctx.fillRect(boxX + boxW - 4, boxY + 4, 2, boxH - 8);
        if (activeColorStr) {
          ctx.shadowColor = activeColorStr;
          ctx.shadowBlur = 20;
          ctx.fillStyle = activeColorStr;
          ctx.globalAlpha = 0.18;
          this.roundRect(boxX, boxY, boxW, boxH, r);
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.shadowBlur = 0;
        }
      } else {
        // ── Front view ───────────────────────────────────────────────────
        // Pole (aluminium)
        const poleGrad = ctx.createLinearGradient(-poleW / 2, 0, poleW / 2, 0);
        poleGrad.addColorStop(0, "#3a3a3e");
        poleGrad.addColorStop(0.4, "#5a5a60");
        poleGrad.addColorStop(1, "#2a2a2e");
        ctx.fillStyle = poleGrad;
        ctx.fillRect(-poleW / 2, -poleH, poleW, poleH);

        // Housing shadow
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        this.roundRect(boxX + 3, boxY + 4, boxW, boxH, r);
        ctx.fill();

        // Housing body
        const bodyGrad = ctx.createLinearGradient(boxX, 0, boxX + boxW, 0);
        bodyGrad.addColorStop(0, "#1e1e22");
        bodyGrad.addColorStop(0.15, "#2e2e34");
        bodyGrad.addColorStop(0.85, "#232328");
        bodyGrad.addColorStop(1, "#18181c");
        ctx.fillStyle = bodyGrad;
        this.roundRect(boxX, boxY, boxW, boxH, r);
        ctx.fill();

        // Housing edge highlight (left rim)
        ctx.fillStyle = "rgba(255,255,255,0.08)";
        this.roundRect(boxX, boxY, 3, boxH, r);
        ctx.fill();

        // Lamp positions (top=red, mid=yellow, bot=green)
        const lampR = 7;
        const lamps: Array<{ dy: number; offColor: string; lit: string | null }> = [
          { dy: boxY + 16, offColor: "#3a1010", lit: color === "red"    ? TL_COLOR_MAP.red    : null },
          { dy: boxY + 38, offColor: "#2e2500", lit: color === "yellow" ? TL_COLOR_MAP.yellow : (isBlinking && blink ? TL_COLOR_MAP[color] : null) },
          { dy: boxY + 60, offColor: "#0e2a10", lit: color === "green"  ? TL_COLOR_MAP.green  : null },
        ];

        for (const lamp of lamps) {
          // visor (small shelf above lamp)
          ctx.fillStyle = "#111114";
          ctx.fillRect(boxX + 2, lamp.dy - lampR - 3, boxW - 4, 3);

          // lamp recess ring
          ctx.fillStyle = "#111";
          ctx.beginPath();
          ctx.arc(0, lamp.dy, lampR + 2, 0, Math.PI * 2);
          ctx.fill();

          // lamp face
          if (lamp.lit) {
            ctx.shadowColor = lamp.lit;
            ctx.shadowBlur = 18;
            ctx.fillStyle = lamp.lit;
            ctx.beginPath();
            ctx.arc(0, lamp.dy, lampR, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
            // specular glint
            ctx.fillStyle = "rgba(255,255,255,0.35)";
            ctx.beginPath();
            ctx.arc(-2, lamp.dy - 2, lampR * 0.35, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.fillStyle = lamp.offColor;
            ctx.beginPath();
            ctx.arc(0, lamp.dy, lampR, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // Bottom bolt detail
        ctx.fillStyle = "#444";
        ctx.beginPath();
        ctx.arc(0, boxY + boxH - 5, 2, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    }
  }

  render(camera: Camera, state: RenderState) {
    this.clear();
    this.drawBackground(camera);
    const atlasBg =
      this.missionAtlas?.image?.complete && this.missionAtlas.image.naturalWidth > 0;
    // Composite map mode: world art lives in the DOM/SVG overlay behind the canvas.
    // Without an atlas image `atlasBg` is false, but we must NOT draw legacy city
    // decor (houses / placeholder traffic lights from city-objects.json) — those are
    // wrong coordinates and duplicate/mangle the real map art.
    if (!atlasBg && !this.transparentBackground) this.drawDecor(camera);
    for (const a of state.actors) this.drawActor(a, camera);
  }
}
