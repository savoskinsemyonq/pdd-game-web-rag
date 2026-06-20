export type ActorKind = "CAMERA" | "MY_CAR" | "CAR" | "PEDESTRIAN" | "TL" | "OTHER";

export interface SplineKey {
  t: number;
  dx: number;
  dy: number;
  tx: number;
  ty: number;
}

export interface Spline {
  raw: string;
  keys: SplineKey[];
  duration: number;
}

export interface TurnKey {
  t: number;
  a: number;
  b: number;
  c: number;
  d: number;
}

export interface Turn {
  raw: string;
  keys: TurnKey[];
}

export interface Actor {
  id: string;
  kind: ActorKind;
  sprite: string;
  position: { x: number; y: number; z?: number };
  spline?: Spline;
  turns: Turn[];
}

/** One scheduled traffic-light state switch: at `t` ms into animation → apply state `stateId`. */
export interface CStateTransition {
  t: number;
  stateId: number;
}

export interface CaseAction {
  case: number;
  playerSpline?: Spline;
  playerTurns: Turn[];
  npcUpdates: Array<{
    sprite: string;
    spline?: Spline;
    turns: Turn[];
  }>;
  fine: number | null;
  /** Populated when fine === -1: months parsed from the errorInfo text. */
  licenseRevokeMonths: number | null;
  errorInfo: string | null;
  lostTime: number | null;
  isCorrect: boolean;
  /** Initial TL state applied when this case begins (overrides scene-level initialState). */
  initialState: number | null;
  /** Scheduled TL state switches during the case animation. */
  cStateTransitions: CStateTransition[];
}

export interface Scene {
  sceneFile: string;
  sceneId: string;
  sceneVar: string;
  questionTextRaw: string;
  questionTitle: string;
  questionOptions: string[];
  textPos: { x: number; y: number } | null;
  timeLimit: number;
  actors: Actor[];
  cases: CaseAction[];
  hasQuestion: boolean;
  /** Traffic-light state ID applied when entering this scene (before any answer). */
  initialState: number | null;
}

/** Traffic-light value → color name used by the renderer. */
export type TLColor = "red" | "yellow" | "green" | "yellowblink" | "whiteblink" | "off";

export interface TrafficLightDef {
  id: number;
  x: number;
  y: number;
  /** Rotation in degrees (0 = faces up/north, rotates whole object in 2D plane). */
  rotation?: number;
  /** Flip vertically (pole hangs from above, lamps point down). */
  flipY?: boolean;
  /** Side view: rotated 90° around pole axis — narrow profile with color glow bleed. */
  sideView?: boolean;
  /** Back view: rotated 180° around pole axis — back panel with color glow bleed. */
  backView?: boolean;
  /** Render as a railway barrier instead of a traffic light. Arm extends right by default. */
  type?: "light" | "barrier";
  /** If set, this light is only drawn when playing the named mission. */
  missionId?: string;
}

export interface TrafficLightStateDef {
  stateId: number;
  lights: Record<number, TLColor>;
}

export interface TrafficLightsData {
  lights: TrafficLightDef[];
  states: TrafficLightStateDef[];
}

export interface SceneNode {
  nodeId: string;
  variants: Scene[];
}

export interface Mission {
  id: string;
  index: number;
  initNodeId: string;
  terminalNodeId: string;
  nodes: SceneNode[];
  playerSprite: string;
  title: string;
}

export interface MissionsData {
  missions: Mission[];
  /** All traffic-light states from TrafficLightState.script, keyed by stateId. */
  tlStates: Record<number, Record<number, TLColor>>;
}
