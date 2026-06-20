import type {
  Actor,
  CaseAction,
  Mission,
  Scene,
  SceneNode,
  Spline,
  SplineKey,
  TLColor,
} from "../types";
import { buildErrorChatContext, buildErrorContextKey } from "../lib/errorChatContext";
import mission2SplineDefaultsJson from "../data/defaultSplineOverrides.mission2.json";
import mission3SplineDefaultsJson from "../data/defaultSplineOverrides.mission3.json";
import mission4SplineDefaultsJson from "../data/defaultSplineOverrides.mission4.json";
import mission5SplineDefaultsJson from "../data/defaultSplineOverrides.mission5.json";
import mission6SplineDefaultsJson from "../data/defaultSplineOverrides.mission6.json";
import mission7SplineDefaultsJson from "../data/defaultSplineOverrides.mission7.json";
import mission8SplineDefaultsJson from "../data/defaultSplineOverrides.mission8.json";
import mission9SplineDefaultsJson from "../data/defaultSplineOverrides.mission9.json";
import { sampleSpline, splineDuration } from "./Spline";
import { angleFromMotion, smoothAngle } from "./Turn";

export type RunnerPhase =
  | "idle"
  | "approach"
  | "question"
  | "answering"
  | "errorPopup"
  | "transitioning"
  | "missionResult";

/** World pose handed off across scene cuts (MY_CAR seam). */
export interface SceneSeam {
  x: number;
  y: number;
  /** Heading in rad from previous scene; avoids reset to 0 on spawn. */
  angle?: number;
}

export interface RuntimeActor {
  key: string;
  actorId: string;
  kind: Actor["kind"];
  sprite: string;
  baseX: number;
  baseY: number;
  x: number;
  y: number;
  angle: number;
  prevX: number;
  prevY: number;
  spline?: Spline;
  splineStart: number;
  splineDuration: number;
  isPlayer: boolean;
}

export interface MissionHistoryEntry {
  nodeId: string;
  sceneId: string;
  pickedCase: number;
  isCorrect: boolean;
  fine: number;
  licenseRevokeMonths: number | null;
  lostTime: number;
  errorInfo: string | null;
  topics: string[];
}

export interface RunnerState {
  phase: RunnerPhase;
  missionId: string | null;
  missionIndex: number;
  nodeIndex: number;
  /** Индекс варианта сцены из missions.json (для калибровки NPC при нескольких variants). */
  sceneVariantIndex: number;
  totalNodes: number;
  currentNodeId: string | null;
  scene: Scene | null;
  questionTimeRemaining: number;
  totalFine: number;
  totalLostTime: number;
  totalLicenseRevokeMonths: number;
  history: MissionHistoryEntry[];
  errorInfoText: string | null;
  errorChatContext: string | null;
  errorContextKey: string | null;
  errorMeta: { fine: number; licenseRevokeMonths: number | null; lostTime: number } | null;
  /** Current color of each traffic light by id. */
  tlColors: Record<number, TLColor>;
}

export interface NpcTweak {
  x: number;
  y: number;
}

/** Разбор ключа калибровки `nodeId:v{n}:sprite` или legacy `nodeId:sprite`. */
function parseCalibrationNpcKey(key: string): { nodeId: string; variantIndex: number | null; sprite: string } | null {
  const scoped = key.match(/^(.+):v(\d+):([^:]+)$/);
  if (scoped) {
    return {
      nodeId: scoped[1]!,
      variantIndex: Number(scoped[2]),
      sprite: scoped[3]!.toLowerCase(),
    };
  }
  const idx = key.indexOf(":");
  if (idx <= 0 || idx >= key.length - 1) return null;
  return { nodeId: key.slice(0, idx), variantIndex: null, sprite: key.slice(idx + 1).toLowerCase() };
}

export interface CalibrationTarget {
  key: string;
  sprite: string;
  label: string;
}

/** Extracts the upper bound of "от X до Y месяцев" from a C_ERRORINFO string. */
function parseLicenseRevokeMonths(errorInfo: string | null): number | null {
  if (!errorInfo) return null;
  const m = errorInfo.match(/от\s+(\d+)\s+до\s+(\d+)\s+месяц/i);
  if (m) return parseInt(m[2], 10);
  const range = errorInfo.match(/(\d+)\s*[-–]\s*(\d+)\s+месяц/i);
  if (range) return parseInt(range[2], 10);
  const single = errorInfo.match(/на\s+срок\s+(\d+)\s+месяц/i);
  if (single) return parseInt(single[1], 10);
  return null;
}

const RNG_SEED_BASE = 1337;
const CALIBRATION_STORAGE_KEY = "pdd-web::npc-calibration";
const ANIMATION_STORAGE_KEY = "pdd-web::anim-overrides";

export interface SplineOverride {
  keys: SplineKey[];
}

const MISSION2_SPLINE_DEFAULTS =
  mission2SplineDefaultsJson as Record<string, SplineOverride>;

const MISSION3_SPLINE_DEFAULTS =
  mission3SplineDefaultsJson as Record<string, SplineOverride>;

const MISSION4_SPLINE_DEFAULTS =
  mission4SplineDefaultsJson as Record<string, SplineOverride>;

const MISSION5_SPLINE_DEFAULTS =
  mission5SplineDefaultsJson as Record<string, SplineOverride>;

const MISSION6_SPLINE_DEFAULTS =
  mission6SplineDefaultsJson as Record<string, SplineOverride>;

const MISSION7_SPLINE_DEFAULTS =
  mission7SplineDefaultsJson as Record<string, SplineOverride>;

const MISSION8_SPLINE_DEFAULTS =
  mission8SplineDefaultsJson as Record<string, SplineOverride>;

const MISSION9_SPLINE_DEFAULTS =
  mission9SplineDefaultsJson as Record<string, SplineOverride>;

export interface AnimationTarget {
  key: string;
  sprite: string;
  label: string;
  hasSpline: boolean;
  // Если это post-answer анимация: номер варианта ответа (0-based) и флаг
  caseIndex?: number;
  isCorrect?: boolean;
}
const DEFAULT_SPLINE_OVERRIDES: Record<string, SplineOverride> = {
  // 2-0_InitMis2 (single variant → v0)
  "2-0_InitMis2:v0:our_car": { keys: [{ t: 0, dx: 0, dy: -1, tx: 0, ty: 0 }, { t: 1000, dx: 0, dy: 0, tx: 0, ty: 0 }] },
  ...MISSION3_SPLINE_DEFAULTS,
  ...MISSION4_SPLINE_DEFAULTS,
  ...MISSION5_SPLINE_DEFAULTS,
  ...MISSION6_SPLINE_DEFAULTS,
  ...MISSION7_SPLINE_DEFAULTS,
  ...MISSION8_SPLINE_DEFAULTS,
  ...MISSION9_SPLINE_DEFAULTS,
  ...MISSION2_SPLINE_DEFAULTS,
  // 1-1_2 (v0=base, v1=alternate intro)
  "1-1_2:v1:our_car": { keys: [{ t: 0, dx: 0, dy: 0, tx: 0, ty: -1 }, { t: 1000, dx: 0, dy: -101, tx: 0, ty: -10 }] },
  "1-1_2:v0:case1:truck": { keys: [{ t: 0, dx: 0, dy: 0, tx: -10, ty: 0 }, { t: 1000, dx: -331, dy: -1, tx: 0, ty: 0 }, { t: 2000, dx: -378, dy: -43, tx: 0, ty: -120 }, { t: 3000, dx: -377, dy: -533, tx: 0, ty: 0 }] },
  "1-1_2:v0:case2:truck": { keys: [{ t: 3000, dx: 0, dy: 0, tx: -10, ty: 0 }, { t: 3000, dx: -331, dy: -1, tx: 0, ty: 0 }, { t: 4000, dx: -378, dy: -43, tx: 0, ty: -120 }, { t: 5000, dx: -377, dy: -533, tx: 0, ty: 0 }] },
  // 1-1_3 (single variant → v0)
  "1-1_3:v0:tractor": { keys: [{ t: -1000, dx: 150, dy: 0, tx: -133, ty: 0 }, { t: 0, dx: 0, dy: 0, tx: -10, ty: 0 }] },
  "1-1_3:v0:our_car": { keys: [{ t: 0, dx: 0, dy: 0, tx: -44, ty: 0 }, { t: 1000, dx: -150, dy: 0, tx: 0, ty: 0 }] },
  "1-1_3:v0:case1:player": { keys: [{ t: 0, dx: 0, dy: 0, tx: -48, ty: 0 }, { t: 2000, dx: -283, dy: 0, tx: -64, ty: -4 }, { t: 3000, dx: -350, dy: -63, tx: -4, ty: -200 }, { t: 4000, dx: -350, dy: -200, tx: 0, ty: 0 }] },
  "1-1_3:v0:case2:player": { keys: [{ t: 0, dx: 0, dy: 0, tx: -48, ty: 0 }, { t: 2000, dx: -283, dy: 0, tx: -64, ty: -4 }, { t: 3000, dx: -350, dy: -63, tx: -4, ty: -200 }, { t: 4000, dx: -350, dy: -200, tx: 0, ty: 0 }] },
  "1-1_3:v0:case1:tractor": { keys: [{ t: 0, dx: 0, dy: 0, tx: -48, ty: 0 }, { t: 1000, dx: -185, dy: 0, tx: -68, ty: 0 }, { t: 2000, dx: -239, dy: -64, tx: -4, ty: -200 }, { t: 3000, dx: -241, dy: -342, tx: 0, ty: -68 }, { t: 4000, dx: -173, dy: -532, tx: 4, ty: -228 }] },
  "1-1_3:v0:case2:tractor": { keys: [{ t: 0, dx: 0, dy: 0, tx: -48, ty: 0 }, { t: 1000, dx: -185, dy: 0, tx: -68, ty: 0 }, { t: 2000, dx: -239, dy: -64, tx: -4, ty: -200 }, { t: 3000, dx: -241, dy: -342, tx: 0, ty: -68 }, { t: 4000, dx: -173, dy: -532, tx: 4, ty: -228 }] },
  // 1-1_4 (single variant → v0)
  "1-1_4:v0:our_car": { keys: [{ t: 0, dx: 0, dy: 0, tx: 0, ty: -64 }, { t: 1000, dx: 1, dy: -600, tx: 0, ty: -204 }] },
  "1-1_4:v0:case1:player": { keys: [{ t: 0, dx: 0, dy: 0, tx: 12, ty: -36 }, { t: 1000, dx: 22, dy: -46, tx: 16, ty: -36 }, { t: 3000, dx: 31, dy: -83, tx: 0, ty: -1 }, { t: 4000, dx: 31, dy: -86, tx: 0, ty: -1 }, { t: 5000, dx: 15, dy: -125, tx: -16, ty: -28 }, { t: 6000, dx: 3, dy: -174, tx: 0, ty: -44 }, { t: 7000, dx: 3, dy: -473, tx: 0, ty: 0 }] },
  "1-1_4:v0:case2:player": { keys: [{ t: 0, dx: 0, dy: 0, tx: 0, ty: -64 }, { t: 1000, dx: 62, dy: -168, tx: 0, ty: -20 }, { t: 3000, dx: 62, dy: -176, tx: 0, ty: 0 }, { t: 4000, dx: -1, dy: -473, tx: 0, ty: -128 }] },
  // 1-1_5 (single variant → v0)
  "1-1_5:v0:case1:player": { keys: [{ t: 1000, dx: 0, dy: 0, tx: 0, ty: -84 }, { t: 1500, dx: 82, dy: -232, tx: 312, ty: 0 }, { t: 2500, dx: 555, dy: -232, tx: 0, ty: 0 }, { t: 3000, dx: 622, dy: -282, tx: 0, ty: 0 }, { t: 3500, dx: 622, dy: -409, tx: 0, ty: -204 }] },
  "1-1_5:v0:case2:player": { keys: [{ t: 1000, dx: 0, dy: 0, tx: 0, ty: -84 }, { t: 1500, dx: 82, dy: -232, tx: 312, ty: 0 }, { t: 3000, dx: 555, dy: -232, tx: 0, ty: 0 }, { t: 4000, dx: 622, dy: -282, tx: 0, ty: -100 }, { t: 4500, dx: 622, dy: -409, tx: 0, ty: -204 }] },
  "1-1_5:v0:case3:player": { keys: [{ t: 0, dx: 0, dy: 0, tx: 0, ty: -84 }, { t: 1000, dx: 82, dy: -232, tx: 312, ty: 0 }, { t: 2000, dx: 555, dy: -232, tx: 0, ty: 0 }, { t: 3000, dx: 622, dy: -282, tx: 0, ty: 0 }, { t: 3500, dx: 622, dy: -409, tx: 0, ty: -204 }] },
  "1-1_5:v0:case1:pedestrian": { keys: [{ t: 0, dx: 0, dy: 0, tx: 68, ty: 0 }, { t: 1000, dx: 227, dy: 0, tx: 0, ty: 0 }, { t: 2000, dx: 250, dy: 34, tx: 0, ty: 104 }, { t: 3000, dx: 250, dy: 202, tx: -12, ty: 24 }] },
  "1-1_5:v0:case2:pedestrian": { keys: [{ t: 0, dx: 0, dy: 0, tx: 68, ty: 0 }, { t: 1000, dx: 227, dy: 0, tx: 0, ty: 0 }, { t: 2000, dx: 250, dy: 34, tx: 0, ty: 104 }, { t: 3000, dx: 250, dy: 202, tx: -12, ty: 24 }] },
  "1-1_5:v0:case3:pedestrian": { keys: [{ t: 1000, dx: 0, dy: 0, tx: 68, ty: 0 }, { t: 2000, dx: 227, dy: 0, tx: 0, ty: 0 }, { t: 3000, dx: 250, dy: 34, tx: 0, ty: 104 }, { t: 4000, dx: 250, dy: 202, tx: -12, ty: 24 }] },
  "1-1_5:v0:case2:ford": { keys: [{ t: 0, dx: 0, dy: 0, tx: 68, ty: 0 }, { t: 1500, dx: 588, dy: 0, tx: 52, ty: 4 }, { t: 2000, dx: 802, dy: -54, tx: 0, ty: -164 }, { t: 4000, dx: 802, dy: -733, tx: 0, ty: -24 }] },
  // 1-1_6 (single variant → v0)
  "1-1_6:v0:case1:player": { keys: [{ t: 0, dx: 0, dy: 0, tx: 4, ty: -12 }, { t: 1000, dx: 38, dy: -50, tx: 20, ty: -36 }, { t: 2000, dx: 44, dy: -95, tx: 0, ty: -1 }, { t: 4000, dx: 44, dy: -99, tx: 0, ty: -1 }, { t: 5000, dx: 17, dy: -166, tx: -32, ty: -36 }, { t: 6500, dx: 3, dy: -553, tx: 0, ty: -192 }] },
  "1-1_6:v0:case2:player": { keys: [{ t: 0, dx: 0, dy: 0, tx: 0, ty: -10 }, { t: 1000, dx: -2, dy: -241, tx: 8, ty: -28 }, { t: 2000, dx: 25, dy: -291, tx: 16, ty: -24 }, { t: 4000, dx: 33, dy: -339, tx: 0, ty: -1 }, { t: 6000, dx: 33, dy: -342, tx: 0, ty: -1 }, { t: 7000, dx: 20, dy: -393, tx: -16, ty: -28 }, { t: 8000, dx: -4, dy: -553, tx: 0, ty: -40 }] },
  // 1-1_7 (single variant → v0)
  "1-1_7:v0:case1:player": { keys: [{ t: 1000, dx: 0, dy: 0, tx: 0, ty: -36 }, { t: 2000, dx: -19, dy: -259, tx: 0, ty: -96 }, { t: 3000, dx: -90, dy: -399, tx: -208, ty: 4 }, { t: 4000, dx: -280, dy: -398, tx: -28, ty: 0 }, { t: 5000, dx: -411, dy: -502, tx: 0, ty: -164 }, { t: 6000, dx: -410, dy: -619, tx: 0, ty: -72 }] },
  "1-1_7:v0:case2:player": { keys: [{ t: 1000, dx: 0, dy: 0, tx: 0, ty: -36 }, { t: 2000, dx: -19, dy: -259, tx: 0, ty: -96 }, { t: 3000, dx: -90, dy: -399, tx: -208, ty: 4 }, { t: 4000, dx: -280, dy: -398, tx: -28, ty: 0 }, { t: 5000, dx: -411, dy: -502, tx: 0, ty: -164 }, { t: 6000, dx: -410, dy: -619, tx: 0, ty: -72 }] },
  // 1-1_8 (single variant → v0)
  "1-1_8:v0:case1:player": { keys: [{ t: 0, dx: 0, dy: 0, tx: 0, ty: -44 }, { t: 2000, dx: 1, dy: -426, tx: 0, ty: -84 }, { t: 3000, dx: 39, dy: -477, tx: 56, ty: -72 }, { t: 4000, dx: 77, dy: -539, tx: 0, ty: -64 }, { t: 5000, dx: 76, dy: -716, tx: 0, ty: -48 }] },
  "1-1_8:v0:case2:player": { keys: [{ t: 0, dx: 0, dy: 0, tx: 0, ty: -44 }, { t: 1000, dx: -1, dy: -81, tx: 0, ty: -24 }, { t: 2000, dx: 34, dy: -118, tx: 76, ty: -40 }, { t: 3000, dx: 77, dy: -205, tx: 0, ty: -120 }, { t: 4000, dx: 77, dy: -301, tx: 0, ty: -40 }, { t: 6000, dx: 77, dy: -716, tx: 0, ty: -48 }] },
  // 1-1_9 (single variant → v0)
  "1-1_9:v0:case1:player": { keys: [{ t: 2000, dx: 0, dy: 0, tx: 0, ty: -32 }, { t: 2500, dx: -1, dy: -422, tx: 0, ty: -32 }, { t: 4000, dx: 0, dy: -954, tx: 0, ty: -28 }] },
  "1-1_9:v0:case2:player": { keys: [{ t: 0, dx: 0, dy: 0, tx: 0, ty: -32 }, { t: 1000, dx: -1, dy: -422, tx: 0, ty: -32 }, { t: 2500, dx: 0, dy: -954, tx: 0, ty: -28 }] },
  "1-1_9:v0:case3:player": { keys: [{ t: 2000, dx: 0, dy: 0, tx: 0, ty: -32 }, { t: 3000, dx: -1, dy: -422, tx: 0, ty: -32 }, { t: 4500, dx: 0, dy: -954, tx: 0, ty: -28 }] },
  "1-1_9:v0:case1:ment": { keys: [{ t: 0, dx: 0, dy: 0, tx: -44, ty: 0 }, { t: 1000, dx: -304, dy: 0, tx: 0, ty: 0 }, { t: 2000, dx: -421, dy: 101, tx: 4, ty: 276 }, { t: 3000, dx: -420, dy: 864, tx: 0, ty: 0 }] },
  "1-1_9:v0:case2:ment": { keys: [{ t: 1000, dx: 0, dy: 0, tx: -44, ty: 0 }, { t: 2000, dx: -304, dy: 0, tx: 0, ty: 0 }, { t: 3000, dx: -421, dy: 101, tx: 4, ty: 276 }, { t: 4000, dx: -420, dy: 864, tx: 0, ty: 0 }] },
  "1-1_9:v0:case3:ment": { keys: [{ t: 0, dx: 0, dy: 0, tx: -44, ty: 0 }, { t: 1000, dx: -304, dy: 0, tx: 0, ty: 0 }, { t: 2000, dx: -421, dy: 101, tx: 4, ty: 276 }, { t: 3000, dx: -420, dy: 864, tx: 0, ty: 0 }] },
  // 1-1_10 (single variant → v0)
  "1-1_10:v0:case1:player": { keys: [{ t: 1500, dx: 0, dy: 0, tx: 0, ty: -28 }, { t: 2000, dx: 92, dy: -113, tx: 336, ty: 0 }, { t: 3000, dx: 500, dy: -112, tx: 28, ty: 0 }, { t: 4000, dx: 809, dy: -81, tx: 0, ty: 104 }, { t: 5000, dx: 809, dy: -32, tx: 0, ty: 32 }] },
  "1-1_10:v0:case2:player": { keys: [{ t: 0, dx: 0, dy: 0, tx: 0, ty: -28 }, { t: 1000, dx: 92, dy: -113, tx: 336, ty: 0 }, { t: 2000, dx: 500, dy: -112, tx: 28, ty: 0 }, { t: 3000, dx: 809, dy: -88, tx: 0, ty: 96 }, { t: 4000, dx: 809, dy: -36, tx: 0, ty: 32 }] },
  "1-1_10:v0:case1:yellowblink": { keys: [{ t: 0, dx: 0, dy: 0, tx: 0, ty: 10 }, { t: 1000, dx: 57, dy: 111, tx: 168, ty: 0 }, { t: 3000, dx: 2251, dy: 110, tx: 48, ty: 0 }] },
  "1-1_10:v0:case2:yellowblink": { keys: [{ t: 5000, dx: 0, dy: 0, tx: 0, ty: 10 }, { t: 6000, dx: 57, dy: 111, tx: 168, ty: 0 }, { t: 7000, dx: 2251, dy: 110, tx: 48, ty: 0 }] },
  // 1-1_1 вариант 0: мотоцикл едет сверху вниз (case анимации после ответа)
  "1-1_1:v0:case1:motorcycle2": { keys: [{ t: 0, dx: 0, dy: 0, tx: 0, ty: -68 }, { t: 1000, dx: -1, dy: -384, tx: 0, ty: 0 }, { t: 2000, dx: 91, dy: -535, tx: 320, ty: -12 }, { t: 3000, dx: 1287, dy: -535, tx: 80, ty: 0 }] },
  "1-1_1:v0:case2:motorcycle2": { keys: [{ t: 0, dx: 0, dy: 0, tx: 0, ty: -68 }, { t: 1000, dx: -1, dy: -384, tx: 0, ty: 0 }, { t: 2000, dx: 91, dy: -535, tx: 320, ty: -12 }, { t: 3000, dx: 1287, dy: -535, tx: 80, ty: 0 }] },
  // 1-1_1 вариант 1: мотоцикл едет снизу вверх — оверрайдов нет, используется оригинал из missions.json
};

const DEFAULT_NPC_TWEAKS: Record<string, NpcTweak> = {
  "2-0_InitMis2:our_car": { x: 90, y: -110 },
  "2-2_1:our_car": { x: 0, y: 0 },
  "2-2_1:audi": { x: 550, y: 165 },
  "2-2_2:bus": { x: 230, y: 0 },
  "2-2_2:ment": { x: 205, y: 0 },
  "2-2_3:audi": { x: 350, y: 0 },
  "2-2_3:ford": { x: 365, y: 0 },
  "2-2_3:lada": { x: 350, y: 0 },
  "2-2_3:muka": { x: 370, y: 0 },
  "2-2_5:ford": { x: 0, y: -350 },
  "2-2_5:truck": { x: 0, y: -305 },
  "2-2_6:train": { x: 620, y: 0 },
  "2-2_6:our_car": { x: 0, y: 0 },
  "2-2_5:motorcycle2": { x: 0, y: -350 },
  "2-2_7:ford": { x: 350, y: 0 },
  "2-2_10:yellowblink": { x: 180, y: 0 },
  "2-2_9:yellowblink": { x: 385, y: 0 },
  "3-0_InitMis3:taxi": { x: 520, y: 50 },
  "3-3_1:pedestrian4": { x: -270, y: -15 },
  "3-3_1:v0:pedestrian4": { x: -270, y: -5 },
  "3-3_1:v1:pedestrian4": { x: -270, y: -5 },
  "3-3_1:v0:tram2": { x: -190, y: 95 },
  "3-3_1:v1:tram2": { x: -195, y: -50 },
  "3-3_1:tram2": { x: -190, y: -50 },
  "3-3_1:taxi": { x: 0, y: 0 },
  "3-3_2:pedestrian4": { x: -270, y: -15 },
  "3-3_2:v0:pedestrian4": { x: -270, y: -10 },
  "3-3_5:v0:truck": { x: 0, y: 280 },
  "3-3_5:v0:audi": { x: 20, y: 285 },
  "3-3_5:v1:motorcycle": { x: 0, y: 280 },
  "3-3_5:v1:truck": { x: 0, y: 285 },
  "3-3_6:v0:taxi": { x: 0, y: 0 },
  "3-3_6:v0:motorcycle": { x: 525, y: 0 },
  "3-3_6:v0:truck": { x: 520, y: 0 },
  "3-3_8:v0:pedestrian": { x: -120, y: 0 },
  "3-3_8:v0:pedestrian4": { x: -285, y: -30 },
  "3-3_9:v0:pedestrian4": { x: -230, y: -30 },
  "1-0_InitMis1:our_car": { x: -50, y: 60 },
  "1-1_1:motorcycle2": { x: 144, y: -12 },
  "1-1_1:our_car": { x: 0, y: 0 },
  "1-1_2:truck": { x: 0, y: -97 },
  "1-1_5:pedestrian": { x: -25, y: -525 },
  "1-1_5:ford": { x: -25, y: -550 },
  "1-1_7:tram2": { x: 30, y: -480 },
  "1-1_7:tram11": { x: -40, y: -480 },
  "1-1_8:ford": { x: -50, y: -235 },
  "1-1_10:yellowblink": { x: -20, y: -139 },
  "1-1_2:tractor": { x: -5, y: -105 },
  "1-1_7:ford": { x: 0, y: -4050 },
  "1-1_3:tractor": { x: -100, y: -10 },
  "1-1_3:our_car": { x: 0, y: -10 },
  "1-1_4:tractor": { x: 0, y: -580 },
  "1-1_9:ment": { x: 30, y: -170 },
  "4-0_InitMis4:v0:our_car": { x: -175, y: 60 },
  "4-4_1:v0:our_car": { x: -175, y: 60 },
  "4-4_1:v0:truck": { x: 175, y: 45 },
  "4-4_1:v0:pedestrian4": { x: 160, y: -110 },
  "4-4_2:v0:our_car": { x: 175, y: -30 },
  "4-4_2:v0:truck": { x: 165, y: -120 },
  "4-4_2:v0:pedestrian4": { x: 185, y: -190 },
  "4-4_3:v0:bus": { x: 120, y: -40 },
  "4-4_4:v0:bus": { x: 190, y: 0 },
  "4-4_5:v1:audi": { x: 320, y: -60 },
  "4-4_5:v1:yellowblink": { x: 335, y: 25 },
  "4-4_5:v0:truck": { x: 335, y: 20 },
  "4-4_5:v0:audi": { x: 320, y: -65 },
  "4-4_6:v1:audi": { x: 20, y: -305 },
  "4-4_6:v1:ford": { x: -40, y: -270 },
  "4-4_6:v0:audi": { x: 15, y: -305 },
  "4-4_6:v0:yellowblink": { x: -50, y: -275 },
  "4-4_7:v0:truck": { x: 0, y: -290 },
  "4-4_7:v0:yellowblink": { x: 0, y: -265 },
  "4-4_10:v1:audi": { x: 55, y: 1085 },
  "4-4_10:v1:ford": { x: 60, y: 1075 },
  "4-4_10:v1:truck": { x: 15, y: 1115 },
  "4-4_11:v0:audi": { x: 10, y: 0 },
  "4-4_11:v0:ford": { x: 20, y: -15 },
  "4-4_10:v1:our_car": { x: 0, y: 0 },
  "4-4_10:v0:audi": { x: 50, y: 1085 },
  "4-4_10:v0:bus": { x: 20, y: 1115 },
  "4-4_10:v0:ford": { x: 60, y: 1075 },
  "5-5_1:v0:ford": { x: -10, y: -35 },
  "5-5_1:v0:truck": { x: -40, y: -15 },
  "5-5_2:v1:bus": { x: 25, y: -10 },
  "5-5_2:v1:gazel": { x: -10, y: 35 },
  "5-5_2:v0:pedestrian1": { x: 0, y: 0 },
  "5-5_2:v0:gazel": { x: 0, y: 35 },
  "5-5_2:v0:truck": { x: 20, y: -15 },
  "5-5_3:v0:yellowblink": { x: -30, y: -40 },
  "5-5_4:v0:ment": { x: 35, y: -35 },
  "5-5_4:v0:audi": { x: 145, y: -105 },
  "5-5_5:v0:audi": { x: 255, y: 0 },
  "5-5_6:v0:audi": { x: 260, y: -5 },
  "5-5_7:v0:ford": { x: 40, y: -180 },
  "5-5_7:v0:tram": { x: 10, y: -195 },
  "5-5_8:v0:emergency": { x: -165, y: 0 },
  "5-5_8:v0:tram": { x: -10, y: -55 },
  "5-5_8:v0:ford": { x: 20, y: -40 },
  "5-5_8:v0:tram3": { x: -220, y: -50 },
  "5-5_9:v0:audi": { x: -35, y: -105 },
  "5-5_9:v0:truck": { x: -45, y: -80 },
  "5-5_10:v0:ford": { x: 55, y: -505 },
  "5-5_10:v0:truck": { x: 70, y: -500 },
  "6-0_InitMis6:v0:our_car": { x: 105, y: 0 },
  "6-6_1:v0:audi": { x: -70, y: 90 },
  "6-6_2:v0:tractor": { x: 90, y: 200 },
  "6-6_3:v0:tractor": { x: 305, y: -5 },
  "6-6_5:v0:truck": { x: -100, y: -10 },
  "6-6_7:v0:our_car": { x: 0, y: 0 },
  "6-6_7:v0:tram": { x: -455, y: 0 },
  "6-6_7:v0:milkcar": { x: -565, y: 75 },
  "6-6_7:v0:lada": { x: -580, y: 90 },
  "6-6_8:v0:milkcar": { x: -190, y: -10 },
  "6-6_8:v0:lada": { x: -190, y: -10 },
  "6-6_8:v0:bus": { x: -270, y: 50 },
  "6-6_9:v0:milkcar": { x: -10, y: -40 },
  "6-6_9:v0:lada": { x: -10, y: -35 },
  "6-6_9:v0:bus": { x: -90, y: 20 },
  "6-6_10:v0:truck": { x: -675, y: -25 },
  "7-0_InitMis7:v0:ment": { x: 555, y: 55 },
  "7-7_1:v0:truck": { x: -150, y: -15 },
  "7-7_2:v0:truck": { x: 295, y: 0 },
  "7-7_5:v0:yellowblink": { x: 90, y: 110 },
  "7-7_5:v0:taxi": { x: 20, y: 160 },
  "7-7_6:v0:lada": { x: -145, y: -80 },
  "7-7_6:v0:motorcycle": { x: -145, y: -45 },
  "7-7_6:v0:truck": { x: -125, y: -95 },
  "7-7_7:v0:audi": { x: 45, y: 265 },
  "7-7_7:v0:motorcycle2": { x: 40, y: 250 },
  "7-7_8:v0:lada": { x: 20, y: 345 },
  "7-7_9:v0:lada": { x: 0, y: 0 },
  "7-7_9:v0:motorcycle": { x: 70, y: 445 },
  "7-7_9:v0:tractor": { x: 60, y: 420 },
  "7-7_9:v0:truck": { x: 75, y: 435 },
  "7-7_11:v0:lada": { x: -60, y: -160 },
  "9-0_InitMis9:v0:our_car_y": { x: 120, y: 0 },
  "9-0_InitMis9:v0:audi": { x: 160, y: 0 },
  "9-9_1:v0:audi": { x: 160, y: 0 },
  "9-9_1:v0:our_car_y": { x: 120, y: 0 },
  "9-9_3:v0:audi": { x: -130, y: 0 },
  "9-9_3:v0:ford": { x: -135, y: 5 },
  "9-9_3:v0:truck": { x: -135, y: 0 },
  "9-9_3:v0:truck1": { x: -5, y: -35 },
  "9-9_3:v0:lada": { x: -135, y: 0 },
  "9-9_5:v1:bus": { x: -55, y: 0 },
  "9-9_5:v1:ment": { x: -60, y: 120 },
  "9-9_5:v1:audi": { x: -70, y: 15 },
  "9-9_6:v0:ment_off": { x: -55, y: -10 },
  "0-0_InitMis10:v0:our_car_y": { x: 120, y: 0 },
  "0-10_1:v0:audi": { x: -50, y: 15 },
  "0-10_4:v0:yellowblink": { x: 40, y: 25 },
  "0-10_4:v0:audi": { x: 20, y: -45 },
  "0-10_5:v0:train": { x: 0, y: -315 },
  "0-10_5:v0:bus": { x: 360, y: -410 },
  "0-10_6:v0:bus": { x: -10, y: -15 },
  "0-10_6:v0:truck": { x: 0, y: -50 },
  "0-10_6:v0:yellowblink": { x: 0, y: -60 },
  "0-10_7:v0:ford": { x: 75, y: -95 },
  "0-10_7:v0:motorcycle": { x: 130, y: -125 },
  "0-10_8:v0:truck": { x: 55, y: -30 },
  "0-10_9:v0:audi": { x: 105, y: 80 },
  "0-10_9:v0:tram": { x: 90, y: 10 },
};

function chooseVariant(
  node: SceneNode,
  missionIndex: number,
  nodeIndex: number,
  /** Один на запуск миссии — иначе Date.now() на каждом узле даёт другие v0/v1, чем пакетный расчёт шва / jumpToNode. */
  sessionSeed: number
): { scene: Scene; variantIndex: number } {
  if (node.variants.length <= 1) return { scene: node.variants[0], variantIndex: 0 };
  const r = (RNG_SEED_BASE + missionIndex * 1000 + nodeIndex * 17 + sessionSeed) >>> 0;
  const variantIndex = r % node.variants.length;
  return { scene: node.variants[variantIndex], variantIndex };
}

export class SceneRunner {
  mission: Mission | null = null;
  state: RunnerState = {
    phase: "idle",
    missionId: null,
    missionIndex: 0,
    nodeIndex: 0,
    sceneVariantIndex: 0,
    totalNodes: 0,
    currentNodeId: null,
    scene: null,
    questionTimeRemaining: 0,
    totalFine: 0,
    totalLostTime: 0,
    totalLicenseRevokeMonths: 0,
    history: [],
    errorInfoText: null,
    errorChatContext: null,
    errorContextKey: null,
    errorMeta: null,
    tlColors: {},
  };

  actors: RuntimeActor[] = [];
  player: RuntimeActor | null = null;
  currentVariantIndex = 0;
  phaseStart = 0;
  phaseDuration = 0;
  pendingCase: CaseAction | null = null;
  pendingTransition: { fine: number; lostTime: number; errorInfo: string | null } | null = null;
  pendingSeamEnd: SceneSeam | null = null;
  approachDelayCounted = 0;
  notify: (s: RunnerState) => void = () => {};
  userNpcTweaks: Record<string, NpcTweak> = {};
  userSplineOverrides: Record<string, SplineOverride> = {};
  /** Фиксируется в startMission; варианты сцен завязаны только на него + индекс узла (совместимо с computeSeamForNode). */
  variantSessionSeed = 0;
  /** Full TL state table from missions.json, keyed stateId → {tlId → color}. */
  tlStateTable: Record<number, Record<number, TLColor>> = {};
  /** Scheduled c_STATE transitions for the current case animation. */
  private pendingCStateTransitions: Array<{ t: number; stateId: number }> = [];

  setTLStateTable(table: Record<number, Record<number, TLColor>>) {
    // Normalize string keys from JSON.parse into numbers
    const normalized: Record<number, Record<number, TLColor>> = {};
    for (const [stateKey, lights] of Object.entries(table)) {
      const inner: Record<number, TLColor> = {};
      for (const [tlKey, color] of Object.entries(lights)) inner[Number(tlKey)] = color as TLColor;
      normalized[Number(stateKey)] = inner;
    }
    this.tlStateTable = normalized;
  }

  private applyTLState(stateId: number) {
    const lights = this.tlStateTable[stateId];
    if (!lights) return;
    this.state = { ...this.state, tlColors: { ...this.state.tlColors, ...lights } };
  }

  startMission(mission: Mission) {
    this.userNpcTweaks = this.loadUserNpcTweaks();
    this.userSplineOverrides = this.loadUserSplineOverrides();
    // Детерминируем выбор вариантов сцен: один и тот же mission.index → одна и та же
    // последовательность v0/v1 при каждом перезапуске. Иначе Date.now() даёт новый
    // sessionSeed на каждый запуск → на узлах с несколькими variants выпадают разные
    // ветки (другие splines / npc tweaks / sprites), и пользователь видит «не ту»
    // анимацию.
    this.variantSessionSeed = (RNG_SEED_BASE + mission.index * 7919) >>> 0;
    this.mission = mission;
    this.state = {
      phase: "approach",
      missionId: mission.id,
      missionIndex: mission.index,
      nodeIndex: 0,
      sceneVariantIndex: 0,
      totalNodes: mission.nodes.length,
      currentNodeId: null,
      scene: null,
      questionTimeRemaining: 0,
      totalFine: 0,
      totalLostTime: 0,
      totalLicenseRevokeMonths: 0,
      history: [],
      errorInfoText: null,
      errorChatContext: null,
      errorContextKey: null,
      errorMeta: null,
      tlColors: {},
    };
    this.actors = [];
    this.player = null;
    this.pendingCase = null;
    this.pendingSeamEnd = null;
    this.approachDelayCounted = 0;
    this.enterNode(0, performance.now(), null);
  }

  endMission() {
    this.state = { ...this.state, phase: "missionResult" };
    this.notify(this.state);
  }

  enterNode(
    nodeIndex: number,
    now: number,
    seamEnd: SceneSeam | null = null
  ) {
    if (!this.mission) return;
    if (nodeIndex >= this.mission.nodes.length) {
      this.endMission();
      return;
    }
    const node = this.mission.nodes[nodeIndex];
    const { scene, variantIndex } = chooseVariant(node, this.mission.index, nodeIndex, this.variantSessionSeed);
    this.currentVariantIndex = variantIndex;

    const seam =
      nodeIndex > 0 && seamEnd ? seamEnd : null;
    this.spawnSceneActors(scene, now, seam, node.nodeId, variantIndex);

    // Apply scene-level initial TL state
    if (scene.initialState != null) this.applyTLState(scene.initialState);
    this.pendingCStateTransitions = [];

    const splineDur = this.player?.splineDuration ?? 0;
    let approachDuration = Math.max(splineDur, scene.timeLimit ?? 0);
    if (approachDuration === 0) approachDuration = 1200;
    if (nodeIndex === 0) {
      approachDuration = Math.max(approachDuration, 1500);
    }

    this.state = {
      ...this.state,
      phase: "approach",
      nodeIndex,
      sceneVariantIndex: variantIndex,
      currentNodeId: node.nodeId,
      scene,
      questionTimeRemaining: 0,
      errorInfoText: null,
      errorChatContext: null,
      errorContextKey: null,
      errorMeta: null,
    };
    this.phaseStart = now;
    this.phaseDuration = approachDuration;
    this.pendingCase = null;
    this.pendingSeamEnd = null;
    this.approachDelayCounted = 0;
    this.notify(this.state);
  }

  spawnSceneActors(
    scene: Scene,
    now: number,
    seamEnd: SceneSeam | null = null,
    nodeId: string | null = null,
    variantIndex = 0
  ) {
    let offsetX = 0;
    let offsetY = 0;
    if (seamEnd) {
      const dumpMy = scene.actors.find((a) => a.kind === "MY_CAR");
      if (dumpMy) {
        offsetX = seamEnd.x - dumpMy.position.x;
        offsetY = seamEnd.y - dumpMy.position.y;
      }
    }
    const next: RuntimeActor[] = [];
    let player: RuntimeActor | null = null;
    let actorIdx = 0;
    for (const a of scene.actors) {
      if (a.kind === "CAMERA") continue;
      const key = this.actorKeyForActor(a, actorIdx++);
      const tweak = this.getNpcSpawnTweak(nodeId, variantIndex, a);
      let baseWx = a.position.x + offsetX + tweak.x;
      let baseWy = a.position.y + offsetY + tweak.y;
      const hasSpline = !!a.spline && a.spline.keys.length > 0;
      let spawnSample = { x: 0, y: 0, vx: 0, vy: 0 };
      if (hasSpline && a.spline) {
        spawnSample = sampleSpline(a.spline, 0);
      }
      if (seamEnd && a.kind === "MY_CAR" && hasSpline) {
        baseWx -= spawnSample.x;
        baseWy -= spawnSample.y;
      }
      let spawnAngle = 0;
      if (a.kind === "MY_CAR") {
        if (
          seamEnd &&
          typeof seamEnd.angle === "number" &&
          Number.isFinite(seamEnd.angle)
        ) {
          spawnAngle = seamEnd.angle;
        } else if (
          Math.abs(spawnSample.vx) + Math.abs(spawnSample.vy) > 1e-4
        ) {
          spawnAngle = Math.atan2(spawnSample.vy, spawnSample.vx);
        }
      } else if (
        Math.abs(spawnSample.vx) + Math.abs(spawnSample.vy) > 1e-4
      ) {
        // Spawn NPCs already aligned to their spline tangent to avoid one-frame yaw snap.
        spawnAngle = Math.atan2(spawnSample.vy, spawnSample.vx);
      }
      const wx = baseWx + spawnSample.x;
      const wy = baseWy + spawnSample.y;
      const ra: RuntimeActor = {
        key,
        actorId: a.id,
        kind: a.kind,
        sprite: a.sprite,
        baseX: baseWx,
        baseY: baseWy,
        x: wx,
        y: wy,
        prevX: wx,
        prevY: wy,
        angle: spawnAngle,
        spline: a.spline,
        splineStart: now,
        splineDuration: a.spline ? splineDuration(a.spline) : 0,
        isPlayer: a.kind === "MY_CAR",
      };
      if (nodeId) {
        const overrideKey = `${nodeId}:v${variantIndex}:${a.sprite.toLowerCase()}`;
        const ov = this.getEffectiveOverride(overrideKey);
        if (ov && ov.keys.length > 0) {
          const ovSpline = { raw: "", keys: ov.keys, duration: 0 };
          const dur = splineDuration(ovSpline);
          ovSpline.duration = dur;
          ra.spline = ovSpline;
          ra.splineDuration = dur;
          // Пересчитываем позицию спавна по override-сплайну,
          // иначе baseX/baseY останутся сдвинутыми на delta оригинала
          const ovSample = sampleSpline(ovSpline, 0);
          const origSample = spawnSample;
          const dx = ovSample.x - origSample.x;
          const dy = ovSample.y - origSample.y;
          ra.baseX -= dx;
          ra.baseY -= dy;
          ra.x = ra.baseX + ovSample.x;
          ra.y = ra.baseY + ovSample.y;
          ra.prevX = ra.x;
          ra.prevY = ra.y;
        }
      }
      if (ra.isPlayer) player = ra;
      next.push(ra);
    }
    this.actors = next;
    this.player = player;
  }

  private resolveNpcTweak(nodeId: string, variantIndex: number, spriteLower: string): NpcTweak {
    const scoped = `${nodeId}:v${variantIndex}:${spriteLower}`;
    if (scoped in this.userNpcTweaks) return this.userNpcTweaks[scoped]!;
    if (scoped in DEFAULT_NPC_TWEAKS) return DEFAULT_NPC_TWEAKS[scoped]!;
    const legacy = `${nodeId}:${spriteLower}`;
    if (legacy in this.userNpcTweaks) return this.userNpcTweaks[legacy]!;
    if (legacy in DEFAULT_NPC_TWEAKS) return DEFAULT_NPC_TWEAKS[legacy]!;
    return { x: 0, y: 0 };
  }

  private getNpcSpawnTweak(nodeId: string | null, variantIndex: number, actor: Actor): NpcTweak {
    if (!nodeId || actor.kind === "CAMERA") {
      return { x: 0, y: 0 };
    }
    return this.resolveNpcTweak(nodeId, variantIndex, actor.sprite.toLowerCase());
  }

  private loadUserNpcTweaks(): Record<string, NpcTweak> {
    try {
      const raw = localStorage.getItem(CALIBRATION_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, NpcTweak>;
      return parsed ?? {};
    } catch {
      return {};
    }
  }

  private saveUserNpcTweaks() {
    try {
      localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(this.userNpcTweaks));
    } catch {
      // ignore storage errors
    }
  }

  getCalibrationTargets(): CalibrationTarget[] {
    const nodeId = this.state.currentNodeId;
    if (!nodeId) return [];
    const unique = new Map<string, CalibrationTarget>();
    const vi = this.currentVariantIndex;
    for (const actor of this.actors) {
      if (actor.kind === "CAMERA" || !actor.sprite) continue;
      const sprite = actor.sprite.toLowerCase();
      const key = `${nodeId}:v${vi}:${sprite}`;
      if (unique.has(key)) continue;
      const label =
        actor.isPlayer
          ? `${nodeId} · v${vi} · ${sprite} (MY_CAR)`
          : `${nodeId} · v${vi} · ${sprite}`;
      unique.set(key, { key, sprite, label });
    }
    return [...unique.values()].sort((a, b) => {
      const ap = a.label.includes("(MY_CAR)");
      const bp = b.label.includes("(MY_CAR)");
      if (ap !== bp) return ap ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }

  getCalibrationTweak(key: string): NpcTweak {
    const parsed = parseCalibrationNpcKey(key);
    if (!parsed) return { x: 0, y: 0 };
    const vi = parsed.variantIndex ?? this.currentVariantIndex;
    return this.resolveNpcTweak(parsed.nodeId, vi, parsed.sprite);
  }

  adjustCalibrationTweak(key: string, dx: number, dy: number) {
    const parsed = parseCalibrationNpcKey(key);
    if (!parsed) return;
    const prev = this.userNpcTweaks[key] ?? { x: 0, y: 0 };
    const next = { x: prev.x + dx, y: prev.y + dy };
    this.userNpcTweaks[key] = next;
    this.saveUserNpcTweaks();
    const sprite = parsed.sprite;
    const vi = parsed.variantIndex;
    for (const actor of this.actors) {
      if (actor.sprite.toLowerCase() !== sprite) continue;
      if (vi !== null && vi !== this.currentVariantIndex) continue;
      actor.baseX += dx;
      actor.baseY += dy;
      actor.x += dx;
      actor.y += dy;
      actor.prevX += dx;
      actor.prevY += dy;
    }
  }

  clearCalibrationFor(key: string) {
    if (!(key in this.userNpcTweaks)) return;
    const val = this.userNpcTweaks[key];
    delete this.userNpcTweaks[key];
    this.saveUserNpcTweaks();
    const parsed = parseCalibrationNpcKey(key);
    if (!parsed) return;
    const sprite = parsed.sprite;
    const vi = parsed.variantIndex;
    for (const actor of this.actors) {
      if (actor.sprite.toLowerCase() !== sprite) continue;
      if (vi !== null && vi !== this.currentVariantIndex) continue;
      actor.baseX -= val.x;
      actor.baseY -= val.y;
      actor.x -= val.x;
      actor.y -= val.y;
      actor.prevX -= val.x;
      actor.prevY -= val.y;
    }
  }

  exportCalibrationJson(): string {
    return JSON.stringify(this.userNpcTweaks, null, 2);
  }

  exportMergedCalibrationJson(): string {
    const merged: Record<string, NpcTweak> = { ...DEFAULT_NPC_TWEAKS };
    for (const [key, val] of Object.entries(this.userNpcTweaks)) {
      merged[key] = val;
    }
    return JSON.stringify(merged, null, 2);
  }

  importCalibrationJson(raw: string): { ok: boolean; message: string } {
    try {
      const parsed = JSON.parse(raw) as Record<string, Partial<NpcTweak>>;
      const next: Record<string, NpcTweak> = {};
      for (const [key, value] of Object.entries(parsed ?? {})) {
        if (!value) continue;
        const x = Number(value.x ?? 0);
        const y = Number(value.y ?? 0);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        next[key] = { x, y };
      }
      this.userNpcTweaks = next;
      this.saveUserNpcTweaks();
      return { ok: true, message: `Импортировано корректировок: ${Object.keys(next).length}` };
    } catch {
      return { ok: false, message: "Не удалось распарсить JSON" };
    }
  }

  // --- Animation override methods ---

  getAnimationTargets(): AnimationTarget[] {
    const nodeId = this.state.currentNodeId;
    const scene = this.state.scene;
    const vi = this.currentVariantIndex;
    if (!nodeId || !scene) return [];
    const result: AnimationTarget[] = [];
    const seenApproach = new Set<string>();

    // --- approach (до вопроса) ---
    for (const actor of this.actors) {
      if (actor.kind === "CAMERA") continue;
      const sprite = actor.sprite.toLowerCase();
      const key = `${nodeId}:v${vi}:${sprite}`;
      if (seenApproach.has(key)) continue;
      seenApproach.add(key);
      const label = actor.isPlayer ? `[до вопроса] ${sprite} (MY_CAR)` : `[до вопроса] ${sprite}`;
      result.push({ key, sprite, label, hasSpline: !!actor.spline });
    }

    // --- post-answer (после ответа, по вариантам) ---
    for (const c of scene.cases) {
      const ci = c.case;
      const correctMark = c.isCorrect ? " ✓" : c.errorInfo ? " ✗" : "";
      const caseLabel = `[ответ ${ci}${correctMark}]`;

      // player spline
      const playerSprite = "player";
      const playerKey = `${nodeId}:v${vi}:case${ci}:${playerSprite}`;
      result.push({
        key: playerKey,
        sprite: playerSprite,
        label: `${caseLabel} MY_CAR`,
        hasSpline: !!c.playerSpline,
        caseIndex: ci,
        isCorrect: c.isCorrect,
      });

      // npc updates
      const seenNpc = new Set<string>();
      for (const upd of c.npcUpdates) {
        const sprite = upd.sprite.toLowerCase();
        if (seenNpc.has(sprite)) continue;
        seenNpc.add(sprite);
        const key = `${nodeId}:v${vi}:case${ci}:${sprite}`;
        result.push({
          key,
          sprite,
          label: `${caseLabel} ${sprite}`,
          hasSpline: !!upd.spline,
          caseIndex: ci,
          isCorrect: c.isCorrect,
        });
      }
    }

    return result;
  }

  private getEffectiveOverride(key: string): SplineOverride | null {
    return this.userSplineOverrides[key] ?? DEFAULT_SPLINE_OVERRIDES[key] ?? null;
  }

  // Возвращает пользовательский override (не дефолтный) — для UI (показывает кнопку «Сброс»)
  getAnimationOverride(key: string): SplineOverride | null {
    return this.userSplineOverrides[key] ?? null;
  }

  // Возвращает активный override (пользовательский или дефолтный) — для отображения keyframe-ов в панели
  getActiveOverride(key: string): SplineOverride | null {
    return this.getEffectiveOverride(key);
  }

  // Разбирает ключ на составляющие: подход или post-answer
  private parseAnimKey(key: string): { nodeId: string; variantIndex: number; caseIndex: number | null; sprite: string } | null {
    // формат: "nodeId:vN:caseN:sprite" или "nodeId:vN:sprite"
    const caseMatch = key.match(/^(.+):v(\d+):case(\d+):(.+)$/);
    if (caseMatch) {
      return { nodeId: caseMatch[1], variantIndex: Number(caseMatch[2]), caseIndex: Number(caseMatch[3]), sprite: caseMatch[4] };
    }
    const approachMatch = key.match(/^(.+):v(\d+):(.+)$/);
    if (approachMatch) {
      return { nodeId: approachMatch[1], variantIndex: Number(approachMatch[2]), caseIndex: null, sprite: approachMatch[3] };
    }
    return null;
  }

  getOriginalSplineKeys(key: string): SplineKey[] {
    // Если есть дефолтный override — показываем его как «базу»
    const def = DEFAULT_SPLINE_OVERRIDES[key];
    if (def) return def.keys;
    const parsed = this.parseAnimKey(key);
    if (!parsed) return [];
    const scene = this.state.scene;
    if (!scene) return [];
    if (parsed.caseIndex !== null) {
      const c = scene.cases.find((x) => x.case === parsed.caseIndex);
      if (!c) return [];
      if (parsed.sprite === "player") return c.playerSpline?.keys ?? [];
      const upd = c.npcUpdates.find((u) => u.sprite.toLowerCase() === parsed.sprite);
      return upd?.spline?.keys ?? [];
    }
    const sceneActor = scene.actors.find((a) => a.sprite.toLowerCase() === parsed.sprite);
    return sceneActor?.spline?.keys ?? [];
  }

  setAnimationOverride(key: string, keys: SplineKey[]) {
    this.userSplineOverrides[key] = { keys };
    this.saveUserSplineOverrides();
    const parsed = this.parseAnimKey(key);
    if (!parsed || parsed.caseIndex !== null) return; // post-answer: применяется при prepareCaseAnimation
    const sprite = parsed.sprite;
    const dur = splineDuration({ raw: "", keys, duration: 0 });
    for (const actor of this.actors) {
      if (actor.sprite.toLowerCase() !== sprite) continue;
      actor.spline = { raw: "", keys, duration: dur };
      actor.splineDuration = dur;
      actor.splineStart = performance.now();
    }
  }

  clearAnimationOverride(key: string) {
    if (!(key in this.userSplineOverrides)) return;
    delete this.userSplineOverrides[key];
    this.saveUserSplineOverrides();
    const parsed = this.parseAnimKey(key);
    if (!parsed || parsed.caseIndex !== null) return; // post-answer: применяется при prepareCaseAnimation
    const sprite = parsed.sprite;
    // После сброса применяем дефолтный override или оригинал из сцены
    const effective = this.getEffectiveOverride(key);
    const scene = this.state.scene;
    const sceneActor = scene?.actors.find((a) => a.sprite.toLowerCase() === sprite);
    const restoredSpline = effective
      ? { raw: "", keys: effective.keys, duration: splineDuration({ raw: "", keys: effective.keys, duration: 0 }) }
      : sceneActor?.spline;
    for (const actor of this.actors) {
      if (actor.sprite.toLowerCase() !== sprite) continue;
      actor.spline = restoredSpline;
      actor.splineDuration = restoredSpline ? splineDuration(restoredSpline) : 0;
      actor.splineStart = performance.now();
    }
  }

  exportAnimationJson(): string {
    return JSON.stringify(this.userSplineOverrides, null, 2);
  }

  importAnimationJson(raw: string): { ok: boolean; message: string } {
    try {
      const parsed = JSON.parse(raw) as Record<string, Partial<SplineOverride>>;
      const next: Record<string, SplineOverride> = {};
      for (const [k, value] of Object.entries(parsed ?? {})) {
        if (!value || !Array.isArray(value.keys)) continue;
        const keys: SplineKey[] = [];
        for (const sk of value.keys) {
          const t = Number((sk as SplineKey).t ?? 0);
          const dx = Number((sk as SplineKey).dx ?? 0);
          const dy = Number((sk as SplineKey).dy ?? 0);
          const tx = Number((sk as SplineKey).tx ?? 0);
          const ty = Number((sk as SplineKey).ty ?? 0);
          if ([t, dx, dy, tx, ty].every(Number.isFinite))
            keys.push({ t, dx, dy, tx, ty });
        }
        if (keys.length > 0) next[k] = { keys };
      }
      this.userSplineOverrides = next;
      this.saveUserSplineOverrides();
      return { ok: true, message: `Импортировано анимаций: ${Object.keys(next).length}` };
    } catch {
      return { ok: false, message: "Не удалось распарсить JSON" };
    }
  }

  private loadUserSplineOverrides(): Record<string, SplineOverride> {
    try {
      const raw = localStorage.getItem(ANIMATION_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, SplineOverride>;
      // Migrate old keys without variant index (e.g. "1-1_3:tractor" → "1-1_3:v0:tractor")
      const migrated: Record<string, SplineOverride> = {};
      let didMigrate = false;
      for (const [k, v] of Object.entries(parsed)) {
        if (/^.+:v\d+:/.test(k)) {
          migrated[k] = v;
        } else {
          // Insert :v0: after nodeId
          const firstColon = k.indexOf(":");
          if (firstColon >= 0) {
            const newKey = k.slice(0, firstColon) + ":v0:" + k.slice(firstColon + 1);
            migrated[newKey] = v;
            didMigrate = true;
          }
        }
      }
      if (didMigrate) {
        try { localStorage.setItem(ANIMATION_STORAGE_KEY, JSON.stringify(migrated)); } catch { /* ignore */ }
      }
      return migrated;
    } catch {
      return {};
    }
  }

  private saveUserSplineOverrides() {
    try {
      localStorage.setItem(
        ANIMATION_STORAGE_KEY,
        JSON.stringify(this.userSplineOverrides)
      );
    } catch {
      // ignore
    }
  }

  /** Вычисляет SceneSeam, который был бы у MY_CAR к началу сцены nodeIndex
   *  при нормальном прохождении (без ответов игрока — используется correct case). */
  computeSeamForNode(nodeIndex: number): SceneSeam | null {
    if (!this.mission || nodeIndex <= 0) return null;
    /** То же, что передаёт advanceToNextNode → enterNode: visual_end − tweak_следующей_сцены (не сырая visual). */
    let seam: SceneSeam | null = null;
    for (let i = 0; i < nodeIndex; i++) {
      const node = this.mission.nodes[i];
      const { scene, variantIndex: vi } = chooseVariant(node, this.mission.index, i, this.variantSessionSeed);
      const myCar = scene.actors.find((a) => a.kind === "MY_CAR");
      if (!myCar) {
        seam = null;
        continue;
      }

      const tweak = this.getNpcSpawnTweak(node.nodeId, vi, myCar);
      let offsetX = 0;
      let offsetY = 0;
      if (seam && i > 0) {
        offsetX = seam.x - myCar.position.x;
        offsetY = seam.y - myCar.position.y;
      }
      let baseX = myCar.position.x + offsetX + tweak.x;
      let baseY = myCar.position.y + offsetY + tweak.y;

      const overrideKey = `${node.nodeId}:v${vi}:${myCar.sprite.toLowerCase()}`;
      const ov = this.getEffectiveOverride(overrideKey);
      let spline = myCar.spline;
      if (ov && ov.keys.length > 0) {
        spline = { raw: "", keys: ov.keys, duration: splineDuration({ raw: "", keys: ov.keys, duration: 0 }) };
      }

      let visualEnd: SceneSeam;

      if (spline && spline.keys.length > 0) {
        const s0 = sampleSpline(spline, 0);
        if (seam && i > 0) {
          baseX -= s0.x;
          baseY -= s0.y;
        }
        const dur = splineDuration(spline);
        const endSample = sampleSpline(spline, dur);
        const endAngle: number =
          Math.abs(endSample.vx) + Math.abs(endSample.vy) > 1e-4
            ? Math.atan2(endSample.vy, endSample.vx)
            : (seam?.angle ?? 0);

        const approachEnd: SceneSeam = {
          x: baseX + endSample.x,
          y: baseY + endSample.y,
          angle: endAngle,
        };

        const correctCase = scene.cases.find((c) => c.isCorrect) ?? scene.cases[0];
        if (correctCase) {
          const caseKey = `${node.nodeId}:v${vi}:case${correctCase.case}:player`;
          const caseOv = this.getEffectiveOverride(caseKey);
          let caseSpline = correctCase.playerSpline;
          if (caseOv && caseOv.keys.length > 0) {
            caseSpline = { raw: "", keys: caseOv.keys, duration: 0 };
          }
          if (caseSpline && caseSpline.keys.length > 0) {
            const caseDur = splineDuration(caseSpline);
            const caseEnd = sampleSpline(caseSpline, caseDur);
            const caseAngle: number =
              Math.abs(caseEnd.vx) + Math.abs(caseEnd.vy) > 1e-4
                ? Math.atan2(caseEnd.vy, caseEnd.vx)
                : endAngle;
            visualEnd = {
              x: approachEnd.x + caseEnd.x,
              y: approachEnd.y + caseEnd.y,
              angle: caseAngle,
            };
          } else {
            visualEnd = approachEnd;
          }
        } else {
          visualEnd = approachEnd;
        }
      } else {
        visualEnd = { x: baseX, y: baseY, angle: seam?.angle ?? 0 };
      }

      seam = this.seamWorldMinusNextMyCarTweak(i + 1, visualEnd);
    }
    return seam;
  }

  /** Шов для enterNode: позиция без твика MY_CAR следующей сцены (spawn даёт world = seam + tweak_next). */
  private seamWorldMinusNextMyCarTweak(nextNodeIndex: number, visualWorld: SceneSeam): SceneSeam {
    if (!this.mission || nextNodeIndex >= this.mission.nodes.length) return visualWorld;
    const node = this.mission.nodes[nextNodeIndex];
    const { scene, variantIndex } = chooseVariant(node, this.mission.index, nextNodeIndex, this.variantSessionSeed);
    const myCar = scene.actors.find((a) => a.kind === "MY_CAR");
    if (!myCar) return visualWorld;
    const tw = this.getNpcSpawnTweak(node.nodeId, variantIndex, myCar);
    return {
      x: visualWorld.x - tw.x,
      y: visualWorld.y - tw.y,
      angle: visualWorld.angle,
    };
  }

  private actorKeyForActor(a: Actor, idx: number): string {
    return `${a.kind.toLowerCase()}.${a.sprite || "x"}#${idx}`;
  }

  pickCase(caseIndex: number, now: number) {
    if (!this.state.scene) return;
    const c = this.state.scene.cases[caseIndex];
    if (!c) return;
    this.beginAnsweringWithCase(c, now);
  }

  pickCorrectCaseAuto(now: number) {
    if (!this.state.scene) return;
    const c =
      this.state.scene.cases.find((x) => x.isCorrect) ?? this.state.scene.cases[0];
    if (c) this.beginAnsweringWithCase(c, now);
  }

  pickWorstCaseAuto(now: number) {
    if (!this.state.scene) return;
    const cs = this.state.scene.cases;
    if (cs.length === 0) {
      this.advanceToNextNode(now);
      return;
    }
    const worst = [...cs].sort((a, b) => {
      const af = a.fine ?? -1;
      const bf = b.fine ?? -1;
      if (a.errorInfo && !b.errorInfo) return -1;
      if (!a.errorInfo && b.errorInfo) return 1;
      return bf - af;
    })[0];
    this.beginAnsweringWithCase(worst, now);
  }

  private resolveSpline(baseSpline: Spline | undefined, overrideKey: string): Spline | undefined {
    const ov = this.getEffectiveOverride(overrideKey);
    if (ov && ov.keys.length > 0) {
      const dur = splineDuration({ raw: "", keys: ov.keys, duration: 0 });
      return { raw: "", keys: ov.keys, duration: dur };
    }
    return baseSpline;
  }

  private prepareCaseAnimation(c: CaseAction, now: number) {
    if (!this.player) return;
    const nodeId = this.state.currentNodeId ?? "";
    const vi = this.currentVariantIndex;
    const playerNow = this.player;
    playerNow.baseX = playerNow.x;
    playerNow.baseY = playerNow.y;

    const playerSpline = this.resolveSpline(c.playerSpline, `${nodeId}:v${vi}:case${c.case}:player`);
    playerNow.spline = playerSpline;
    playerNow.splineStart = now;
    playerNow.splineDuration = playerSpline ? splineDuration(playerSpline) : 0;
    if (playerSpline && playerSpline.keys.length > 0) {
      const dur = splineDuration(playerSpline);
      const endSample = sampleSpline(playerSpline, dur);
      let angle: number | undefined;
      if (
        Math.abs(endSample.vx) + Math.abs(endSample.vy) > 1e-4
      ) {
        angle = Math.atan2(endSample.vy, endSample.vx);
      }
      this.pendingSeamEnd = {
        x: playerNow.baseX + endSample.x,
        y: playerNow.baseY + endSample.y,
        angle,
      };
    } else {
      this.pendingSeamEnd = {
        x: playerNow.x,
        y: playerNow.y,
        angle: playerNow.angle,
      };
    }

    for (const update of c.npcUpdates) {
      const target = this.actors.find(
        (a) => !a.isPlayer && a.sprite.toLowerCase() === update.sprite.toLowerCase()
      );
      if (!target) continue;
      const npcSpline = this.resolveSpline(update.spline, `${nodeId}:v${vi}:case${c.case}:${update.sprite.toLowerCase()}`);
      if (!npcSpline || npcSpline.keys.length === 0) continue;
      const s0 = sampleSpline(npcSpline, 0);
      // База без текущего оффсета кейсового сплайна: иначе при «появлении в t>0»
      // суммируется подходный SPLINE (−2000 в машине) + первый ключ кейса — NPC за кадром до конца сегмента.
      target.baseX = target.x - s0.x;
      target.baseY = target.y - s0.y;
      target.spline = npcSpline;
      target.splineStart = now;
      target.splineDuration = splineDuration(npcSpline);
    }

    const animDuration = playerNow.splineDuration;

    this.phaseStart = now;
    this.phaseDuration = Math.max(800, animDuration);
  }

  private beginAnsweringWithCase(c: CaseAction, now: number) {
    const isLicenseRevoke = c.fine === -1;
    const monetaryFine = isLicenseRevoke ? 0 : (c.fine ?? 0);
    const licenseRevokeMonths = isLicenseRevoke ? (c.licenseRevokeMonths ?? parseLicenseRevokeMonths(c.errorInfo)) : null;

    this.pendingTransition = {
      fine: monetaryFine,
      lostTime: c.lostTime ?? 0,
      errorInfo: c.errorInfo,
    };
    this.state.history = [
      ...this.state.history,
      {
        nodeId: this.state.currentNodeId ?? "?",
        sceneId: this.state.scene?.sceneId ?? "?",
        pickedCase: c.case,
        isCorrect: c.isCorrect,
        fine: monetaryFine,
        licenseRevokeMonths,
        lostTime: c.lostTime ?? 0,
        errorInfo: c.errorInfo,
        topics: [],
      },
    ];
    this.state = {
      ...this.state,
      totalFine: this.state.totalFine + monetaryFine,
      totalLostTime: this.state.totalLostTime + (c.lostTime ?? 0),
      totalLicenseRevokeMonths: this.state.totalLicenseRevokeMonths + (licenseRevokeMonths ?? 0),
    };

    // Apply case-level initial TL state (overrides scene-level)
    if (c.initialState != null) this.applyTLState(c.initialState);
    // Load c_STATE transitions — will be fired during answering phase
    this.pendingCStateTransitions = [...(c.cStateTransitions ?? [])].sort((a, b) => a.t - b.t);

    if (c.errorInfo) {
      this.pendingCase = c;
      const scene = this.state.scene;
      const nodeId = this.state.currentNodeId ?? "?";
      this.state = {
        ...this.state,
        phase: "errorPopup",
        errorInfoText: c.errorInfo,
        errorChatContext:
          scene != null ? buildErrorChatContext(scene, nodeId, c) : c.errorInfo,
        errorContextKey:
          scene != null ? buildErrorContextKey(nodeId, scene.sceneId, c.case) : `${nodeId}:${c.case}`,
        errorMeta: { fine: monetaryFine, licenseRevokeMonths, lostTime: c.lostTime ?? 0 },
      };
      this.notify(this.state);
      return;
    }

    this.pendingCase = null;
    this.prepareCaseAnimation(c, now);
    this.state = {
      ...this.state,
      phase: "answering",
      errorInfoText: null,
      errorChatContext: null,
      errorContextKey: null,
      errorMeta: null,
    };
    this.notify(this.state);
  }

  closeErrorPopup(now: number) {
    if (this.state.phase !== "errorPopup") return;
    const pendingCase = this.pendingCase;
    this.pendingCase = null;
    if (!pendingCase) {
      this.advanceToNextNode(now);
      return;
    }
    this.prepareCaseAnimation(pendingCase, now);
    this.state = {
      ...this.state,
      phase: "answering",
      errorInfoText: null,
      errorChatContext: null,
      errorContextKey: null,
      errorMeta: null,
    };
    this.notify(this.state);
  }

  advanceToNextNode(now: number) {
    if (!this.mission) return;
    const next = this.state.nodeIndex + 1;
    if (next >= this.mission.nodes.length) {
      this.endMission();
      return;
    }
    let seamEnd: SceneSeam | null =
      this.player != null
        ? {
            x: this.player.x,
            y: this.player.y,
            angle: this.player.angle,
          }
        : this.pendingSeamEnd;
    this.pendingSeamEnd = null;
    if (seamEnd) seamEnd = this.seamWorldMinusNextMyCarTweak(next, seamEnd);
    this.enterNode(next, now, seamEnd);
  }

  update(now: number) {
    for (const a of this.actors) {
      const elapsed = now - a.splineStart;
      a.prevX = a.x;
      a.prevY = a.y;
      if (a.spline) {
        const sample = sampleSpline(a.spline, elapsed);
        a.x = a.baseX + sample.x;
        a.y = a.baseY + sample.y;
        const motionAngle = angleFromMotion(a.x - a.prevX, a.y - a.prevY, a.angle);
        const targetAngle = (Math.abs(sample.vx) + Math.abs(sample.vy) > 0.001)
          ? Math.atan2(sample.vy, sample.vx)
          : motionAngle;
        a.angle = smoothAngle(a.angle, targetAngle, 0.3);
      }
    }

    const phaseElapsed = now - this.phaseStart;
    if (this.state.phase === "approach") {
      const scene = this.state.scene;
      if (scene && !scene.hasQuestion && this.state.nodeIndex > 0) {
        const limitMs = Math.max(0, scene.timeLimit ?? 0);
        const delayMs = Math.max(0, phaseElapsed - limitMs);
        const delaySec = Math.floor(delayMs / 1000);
        if (delaySec !== this.approachDelayCounted) {
          const delta = delaySec - this.approachDelayCounted;
          this.approachDelayCounted = delaySec;
          this.state = {
            ...this.state,
            totalLostTime: Math.max(0, this.state.totalLostTime + delta),
          };
          this.notify(this.state);
        }
      }
      if (this.state.scene && !this.state.scene.hasQuestion) {
        if (phaseElapsed >= this.phaseDuration) {
          this.advanceToNextNode(now);
        }
      } else if (phaseElapsed >= this.phaseDuration) {
        this.phaseStart = now;
        this.phaseDuration = 0;
        this.state = {
          ...this.state,
          phase: "question",
          questionTimeRemaining: 0,
        };
        this.notify(this.state);
      }
    } else if (this.state.phase === "question") {
      this.state.questionTimeRemaining = 0;
    } else if (this.state.phase === "answering") {
      // Fire c_STATE transitions whose time has elapsed
      while (
        this.pendingCStateTransitions.length > 0 &&
        phaseElapsed >= this.pendingCStateTransitions[0]!.t
      ) {
        const tr = this.pendingCStateTransitions.shift()!;
        this.applyTLState(tr.stateId);
        this.notify(this.state);
      }

      if (phaseElapsed >= this.phaseDuration) {
        this.pendingCase = null;
        this.pendingCStateTransitions = [];
        const t = this.pendingTransition;
        this.pendingTransition = null;
        void t;
        this.advanceToNextNode(now);
      }
    }
  }
}
