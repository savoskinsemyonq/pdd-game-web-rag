import { Camera } from "./Camera";
import { Renderer, type RenderableActor } from "./Renderer";
import {
  SceneRunner,
  type AnimationTarget,
  type CalibrationTarget,
  type NpcTweak,
  type RunnerState,
  type SplineOverride,
} from "./SceneRunner";
import type { Mission, MissionsData, SplineKey, TrafficLightDef } from "../types";
import { setCameraSignal } from "../state/cameraSignal";
import {
  loadOverrides,
  resolveMapMode,
  useCompositeStore,
  type CompositeScene,
  type CompositeOverrides,
} from "../state/compositeStore";

export interface GameOptions {
  canvas: HTMLCanvasElement;
  onState: (state: RunnerState) => void;
}

export class Game {
  canvas: HTMLCanvasElement;
  renderer: Renderer;
  camera = new Camera(800, 600, 1 / 1.2);
  runner = new SceneRunner();
  raf = 0;
  running = false;
  onState: (s: RunnerState) => void;
  trafficLights: TrafficLightDef[] = [];
  onTrafficLightsLoaded: ((lights: TrafficLightDef[]) => void) | null = null;

  constructor(opts: GameOptions) {
    this.canvas = opts.canvas;
    this.renderer = new Renderer(this.canvas);
    this.onState = opts.onState;
    this.runner.notify = (s) => this.onState(s);
    void this.loadTrafficLights();
  }

  private async loadTrafficLights(): Promise<void> {
    try {
      const res = await fetch("/trafficlights.json");
      if (!res.ok) return;
      const data = await res.json() as { lights: TrafficLightDef[] };
      this.trafficLights = data.lights ?? [];
      this.onTrafficLightsLoaded?.(this.trafficLights);
    } catch {
      // file missing or malformed — silently ignore
    }
  }

  setMissionsData(data: MissionsData) {
    this.runner.setTLStateTable(data.tlStates ?? {});
  }

  /** Preload city map assets (idempotent). Call before first frame. */
  async ready(): Promise<void> {
    await this.renderer.loadCity();
  }

  async startMission(mission: Mission) {
    await this.ready();
    await this.loadMissionMap(mission);
    this.runner.startMission(mission);
    if (this.runner.player) {
      const camOffsetY = -(this.camera.height * 0.2 / this.camera.zoom);
      this.camera.centerOn(this.runner.player.x, this.runner.player.y + camOffsetY);
      this.clampCameraToAtlas();
    }
    if (!this.running) this.start();
  }

  /**
   * Decide whether to render the mission via the legacy stitched PNG atlas or the
   * composite (DOM/SVG primitives + transparent sprites) overlay, then load whichever
   * assets that mode needs. URL `?map=…` and `localStorage.mapMode` override the meta.
   */
  private async loadMissionMap(mission: Mission): Promise<void> {
    const compositeStore = useCompositeStore.getState();

    let metaRenderMode: string | undefined;
    let compositeBounds: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
    try {
      const res = await fetch(`/maps/${mission.id}/${mission.id}-map.meta.json`);
      if (res.ok) {
        const meta = (await res.json()) as { renderMode?: string; minX?: number; minY?: number; maxX?: number; maxY?: number };
        metaRenderMode = meta.renderMode;
        if (
          typeof meta.minX === "number" && typeof meta.minY === "number" &&
          typeof meta.maxX === "number" && typeof meta.maxY === "number"
        ) {
          compositeBounds = { minX: meta.minX, minY: meta.minY, maxX: meta.maxX, maxY: meta.maxY };
        }
      }
    } catch {
      // meta missing — falls back to atlas mode below
    }

    const mode = resolveMapMode(metaRenderMode);
    compositeStore.setMode(mode);

    if (mode === "composite") {
      const base = `/maps/${mission.id}/`;
      let scene: CompositeScene | null = null;
      try {
        const res = await fetch(`${base}${mission.id}-composite.json`);
        if (res.ok) scene = (await res.json()) as CompositeScene;
      } catch {
        scene = null;
      }
      if (scene) {
        // Merge: localStorage edits + optional committed `*-overrides.json` (file wins on conflict).
        const local = loadOverrides(mission.id);
        let fileOverrides: CompositeOverrides | null = null;
        try {
          const ovRes = await fetch(`${base}${mission.id}-composite.overrides.json`);
          if (ovRes.ok) fileOverrides = (await ovRes.json()) as CompositeOverrides;
        } catch {
          fileOverrides = null;
        }
        const overrides: CompositeOverrides = fileOverrides
          ? (() => {
              const hiddenMarks = [
                ...new Set([
                  ...(local.hiddenBaseMarkingIndices ?? []),
                  ...(fileOverrides.hiddenBaseMarkingIndices ?? []),
                ]),
              ].sort((a, b) => a - b);
              const hiddenSurfs = [
                ...new Set([
                  ...(local.hiddenBaseSurfaceIndices ?? []),
                  ...(fileOverrides.hiddenBaseSurfaceIndices ?? []),
                ]),
              ].sort((a, b) => a - b);
              return {
                spriteOverrides: { ...local.spriteOverrides, ...fileOverrides.spriteOverrides },
                addedSprites: [...(local.addedSprites ?? []), ...(fileOverrides.addedSprites ?? [])],
                addedSurfaces: [...(local.addedSurfaces ?? []), ...(fileOverrides.addedSurfaces ?? [])],
                addedMarkings: [...(local.addedMarkings ?? []), ...(fileOverrides.addedMarkings ?? [])],
                ...(hiddenMarks.length > 0 ? { hiddenBaseMarkingIndices: hiddenMarks } : {}),
                ...(hiddenSurfs.length > 0 ? { hiddenBaseSurfaceIndices: hiddenSurfs } : {}),
              };
            })()
          : local;
        compositeStore.setScene(scene, base, overrides, mission.id);
        this.renderer.setTransparentBackground(true);
        this.compositeBounds = scene.world;
        await this.renderer.loadMissionAtlas(null);
        return;
      }
      // Composite mode requested but data missing → fall back to atlas so the user still sees something.
      console.warn(`[Game] composite scene missing for ${mission.id}, falling back to atlas`);
      compositeStore.setMode("atlas");
    }

    compositeStore.setScene(null, null);
    this.renderer.setTransparentBackground(false);
    this.compositeBounds = compositeBounds;
    await this.renderer.loadMissionAtlas(mission.id);
  }

  /** Camera-clamp bounds in composite mode (no atlas image, but meta still has world rect). */
  private compositeBounds: { minX: number; minY: number; maxX: number; maxY: number } | null = null;

  /** Keep the camera viewport within the mission atlas (PNG) bounds so the area outside is never visible. */
  private clampCameraToAtlas() {
    const bounds = this.renderer.getMissionAtlasBounds() ?? this.compositeBounds;
    if (!bounds) return;
    const halfW = this.camera.visibleHalfW;
    const halfH = this.camera.visibleHalfH;
    const mapW = bounds.maxX - bounds.minX;
    const mapH = bounds.maxY - bounds.minY;
    this.camera.cx = mapW <= halfW * 2
      ? (bounds.minX + bounds.maxX) / 2
      : Math.min(Math.max(this.camera.cx, bounds.minX + halfW), bounds.maxX - halfW);
    this.camera.cy = mapH <= halfH * 2
      ? (bounds.minY + bounds.maxY) / 2
      : Math.min(Math.max(this.camera.cy, bounds.minY + halfH), bounds.maxY - halfH);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    void this.renderer.loadMissionAtlas(null);
    this.renderer.setTransparentBackground(false);
    this.compositeBounds = null;
    useCompositeStore.getState().reset();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      const now = performance.now();
      this.runner.update(now);
      if (this.runner.player) {
        const camOffsetY = -(this.camera.height * 0.2 / this.camera.zoom);
        this.camera.follow(this.runner.player.x, this.runner.player.y + camOffsetY, 0.18);
        this.clampCameraToAtlas();
      }

      const renderable: RenderableActor[] = [...this.runner.actors]
        .sort((a, b) => {
          if (a.isPlayer && !b.isPlayer) return 1;
          if (!a.isPlayer && b.isPlayer) return -1;
          return a.y - b.y;
        })
        .map((a) => ({
          id: a.key,
          kind: a.kind,
          sprite: a.sprite,
          x: a.x,
          y: a.y,
          angle: a.angle,
        }));

      setCameraSignal({
        cx: this.camera.cx,
        cy: this.camera.cy,
        zoom: this.camera.zoom,
        viewW: this.camera.width,
        viewH: this.camera.height,
      });

      this.renderer.render(this.camera, { actors: renderable });
      const missionId = this.runner.mission?.id;
      const visibleLights = this.trafficLights.filter(l => !l.missionId || l.missionId === missionId);
      this.renderer.drawTrafficLights(visibleLights, this.runner.state.tlColors, this.camera, now);
      this.notifyIfStateChanged();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private lastEmittedPhase: string | null = null;
  private lastEmittedTime = 0;
  private notifyIfStateChanged() {
    const now = performance.now();
    if (now - this.lastEmittedTime > 200) {
      this.lastEmittedTime = now;
      this.lastEmittedPhase = this.runner.state.phase;
      this.onState({ ...this.runner.state });
    } else if (this.runner.state.phase !== this.lastEmittedPhase) {
      this.lastEmittedPhase = this.runner.state.phase;
      this.lastEmittedTime = now;
      this.onState({ ...this.runner.state });
    }
  }

  pick(caseIdx: number) {
    this.runner.pickCase(caseIdx, performance.now());
  }

  resize(w: number, h: number) {
    this.canvas.width = w;
    this.canvas.height = h;
    this.camera.width = w;
    this.camera.height = h;
    this.renderer.width = w;
    this.renderer.height = h;
    const ctx = this.canvas.getContext("2d");
    if (ctx) this.renderer.ctx = ctx;
    this.clampCameraToAtlas();
  }

  jumpToNode(nodeIndex: number) {
    const seam = this.runner.computeSeamForNode(nodeIndex);
    this.runner.enterNode(nodeIndex, performance.now(), seam);
    if (this.runner.player) {
      const camOffsetY = -(this.camera.height * 0.2 / this.camera.zoom);
      this.camera.centerOn(this.runner.player.x, this.runner.player.y + camOffsetY);
      this.clampCameraToAtlas();
    }
  }

  getNodeList(): Array<{ index: number; nodeId: string }> {
    return (this.runner.mission?.nodes ?? []).map((n, i) => ({
      index: i,
      nodeId: n.nodeId,
    }));
  }

  closeError() {
    this.runner.closeErrorPopup(performance.now());
  }

  getCalibrationTargets(): CalibrationTarget[] {
    return this.runner.getCalibrationTargets();
  }

  getCalibrationTweak(key: string): NpcTweak {
    return this.runner.getCalibrationTweak(key);
  }

  adjustCalibration(key: string, dx: number, dy: number) {
    this.runner.adjustCalibrationTweak(key, dx, dy);
  }

  clearCalibration(key: string) {
    this.runner.clearCalibrationFor(key);
  }

  exportCalibrationJson(): string {
    return this.runner.exportCalibrationJson();
  }

  exportMergedCalibrationJson(): string {
    return this.runner.exportMergedCalibrationJson();
  }

  importCalibrationJson(raw: string): { ok: boolean; message: string } {
    return this.runner.importCalibrationJson(raw);
  }

  getAnimationTargets(): AnimationTarget[] {
    return this.runner.getAnimationTargets();
  }

  getAnimationOverride(key: string): SplineOverride | null {
    return this.runner.getAnimationOverride(key);
  }

  getActiveOverride(key: string): SplineOverride | null {
    return this.runner.getActiveOverride(key);
  }

  getOriginalSplineKeys(key: string): SplineKey[] {
    return this.runner.getOriginalSplineKeys(key);
  }

  setAnimationOverride(key: string, keys: SplineKey[]) {
    this.runner.setAnimationOverride(key, keys);
  }

  clearAnimationOverride(key: string) {
    this.runner.clearAnimationOverride(key);
  }

  exportAnimationJson(): string {
    return this.runner.exportAnimationJson();
  }

  importAnimationJson(raw: string): { ok: boolean; message: string } {
    return this.runner.importAnimationJson(raw);
  }
}
