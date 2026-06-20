import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Actor,
  ActorKind,
  CaseAction,
  Mission,
  MissionsData,
  Scene,
  SceneNode,
  Spline,
  SplineKey,
  Turn,
  TurnKey,
} from "../src/types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, "..", "..");
const DUMP_PATH = path.join(ROOT, "game_logic_dump.json");
const OUT_PATH = path.resolve(__dirname, "..", "src", "data", "missions.json");

const MISSION_TITLES: Record<string, string> = {
  mission1: "Миссия 1. Перекрёстки",
  mission2: "Миссия 2. Знаки приоритета",
  mission3: "Миссия 3. Такси",
  mission4: "Миссия 4. Городские правила",
  mission5: "Миссия 5. Пешеход",
  mission6: "Миссия 6. На загородной",
  mission7: "Миссия 7. В погоне",
  mission8: "Миссия 8. Жёлтая машина",
  mission9: "Миссия 9. Инспектор",
};

interface DumpScene {
  scene_file: string;
  scene_id: string;
  scene_var: string;
  question_text_raw: string;
  text_pos: string | null;
  time_limit: number;
  /** Pre-CASE `STATE <id>` directive, recovered from `scripts/` by import-scene-states.ts. */
  scene_initial_state?: number;
  actors: Array<{
    init: string;
    position: string | null;
    spline: string | null;
    turn: string[];
  }>;
  cases: Array<{
    case: number;
    commands: string[];
    fine: number | null;
    error_info: string | null;
    lost_time: number | null;
  }>;
}

interface DumpMission {
  file: string;
  init_node: string;
  terminal_node: string;
  nodes: string[];
}

interface DumpTLState {
  state: number;
  trafficlights: Array<{ id: number; value: number }>;
}

interface Dump {
  missions: Record<string, DumpMission>;
  scenes: DumpScene[];
  traffic_light_state_machine: { file: string; states: DumpTLState[] };
}

/** Parse STATE and c_STATE directives out of a case's raw `commands` (sourced from the dump JSON). */
function parseCaseStateCommands(commands: string[]): {
  initialState: number | null;
  cStateTransitions: Array<{ t: number; stateId: number }>;
} {
  let initialState: number | null = null;
  const cStateTransitions: Array<{ t: number; stateId: number }> = [];

  for (const cmd of commands) {
    const cStateMatch = cmd.match(/^c_STATE\s+(.+)/i);
    if (cStateMatch) {
      const nums = cStateMatch[1].trim().split(/\s+/).map(Number);
      for (let i = 0; i + 1 < nums.length; i += 2) {
        cStateTransitions.push({ t: nums[i]!, stateId: nums[i + 1]! });
      }
      continue;
    }
    const stateMatch = cmd.match(/^STATE\s+(\d+)$/i);
    if (stateMatch) initialState = parseInt(stateMatch[1], 10);
  }

  return { initialState, cStateTransitions };
}

function parseFloats(s: string): number[] {
  return s
    .trim()
    .split(/\s+/)
    .map((x) => Number.parseFloat(x))
    .filter((x) => Number.isFinite(x));
}

function parsePosition(s: string | null): { x: number; y: number; z?: number } {
  if (!s) return { x: 0, y: 0 };
  const m = s.replace(/^POSITION\s+/i, "");
  const nums = parseFloats(m);
  return {
    x: nums[0] ?? 0,
    y: nums[1] ?? 0,
    z: nums[2],
  };
}

function parseSpline(raw: string | null | undefined): Spline | undefined {
  if (!raw) return undefined;
  const tokens = raw.replace(/^SPLINE\s+/i, "").trim().split(/\s+/);
  if (tokens.length < 1) return undefined;
  const n = Number.parseInt(tokens[0], 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const nums = tokens.slice(1).map((x) => Number.parseFloat(x));
  const keys: SplineKey[] = [];
  for (let i = 0; i < n; i++) {
    const base = i * 5;
    const t = nums[base];
    if (!Number.isFinite(t)) break;
    keys.push({
      t,
      dx: nums[base + 1] ?? 0,
      dy: nums[base + 2] ?? 0,
      tx: nums[base + 3] ?? 0,
      ty: nums[base + 4] ?? 0,
    });
  }
  if (keys.length === 0) return undefined;
  const duration = Math.max(0, ...keys.map((k) => k.t));
  return { raw, keys, duration };
}

function parseTurn(raw: string | undefined): Turn | undefined {
  if (!raw) return undefined;
  const nums = parseFloats(raw.replace(/^turn\s+/i, ""));
  if (nums.length === 0) return undefined;
  const keys: TurnKey[] = [];
  for (let i = 0; i + 3 < nums.length; i += 4) {
    keys.push({
      t: nums[i],
      a: nums[i + 1],
      b: nums[i + 2],
      c: nums[i + 3],
      d: 0,
    });
  }
  return { raw, keys };
}

function parseTurns(rawList: string[] | undefined): Turn[] {
  if (!rawList) return [];
  return rawList
    .map((r) => parseTurn(r))
    .filter((t): t is Turn => Boolean(t));
}

function parseActor(
  raw: { init: string; position: string | null; spline: string | null; turn: string[] },
  index: number
): Actor | null {
  const m = raw.init.match(/INIT\s+(\w+)(?:\.(\S+))?/i);
  if (!m) return null;
  const kindRaw = m[1].toUpperCase();
  let kind: ActorKind = "OTHER";
  if (kindRaw === "CAMERA") kind = "CAMERA";
  else if (kindRaw === "MY_CAR") kind = "MY_CAR";
  else if (kindRaw === "CAR") kind = "CAR";
  else if (kindRaw === "PEDESTRIAN" || kindRaw === "PED") kind = "PEDESTRIAN";
  else if (kindRaw === "TL") kind = "TL";
  const sprite = m[2] ?? "";
  return {
    id: `${kind.toLowerCase()}_${sprite || "x"}_${index}`,
    kind,
    sprite,
    position: parsePosition(raw.position),
    spline: parseSpline(raw.spline),
    turns: parseTurns(raw.turn),
  };
}

function parseCase(c: DumpScene["cases"][number]): CaseAction {
  const commands = c.commands;
  const stateInfo = parseCaseStateCommands(commands);
  const playerSplineCmd = commands.find((cmd) => /^SPLINE\b/i.test(cmd));
  const playerTurnCmds = commands.filter((cmd) => /^turn\b/i.test(cmd));
  const npcUpdates: CaseAction["npcUpdates"] = [];
  let currentSprite: string | null = null;

  for (const cmd of commands) {
    const initMatch = cmd.match(/^c_init\s+\w+\.(\S+)/i);
    if (initMatch) {
      currentSprite = initMatch[1];
      npcUpdates.push({ sprite: currentSprite, turns: [] });
      continue;
    }
    const splineMatch = cmd.match(/^c_spline\s+(.+)/i);
    if (splineMatch && currentSprite) {
      const last = npcUpdates[npcUpdates.length - 1];
      if (last && last.sprite === currentSprite) {
        last.spline = parseSpline("SPLINE " + splineMatch[1]);
      }
      continue;
    }
    const turnMatch = cmd.match(/^c_turn\s+(.+)/i);
    if (turnMatch && currentSprite) {
      const last = npcUpdates[npcUpdates.length - 1];
      const t = parseTurn("turn " + turnMatch[1]);
      if (last && t) last.turns.push(t);
      continue;
    }
  }

  const fine = c.fine;
  const errorInfo = c.error_info;
  let licenseRevokeMonths: number | null = null;
  if (fine === -1 && errorInfo) {
    const m = errorInfo.match(/от\s+(\d+)\s+до\s+(\d+)\s+месяц/i);
    if (m) licenseRevokeMonths = parseInt(m[2], 10);
    else {
      const range = errorInfo.match(/(\d+)\s*[-–]\s*(\d+)\s+месяц/i);
      if (range) licenseRevokeMonths = parseInt(range[2], 10);
      else {
        const s = errorInfo.match(/на\s+срок\s+(\d+)\s+месяц/i);
        if (s) licenseRevokeMonths = parseInt(s[1], 10);
      }
    }
  }

  return {
    case: c.case,
    playerSpline: parseSpline(playerSplineCmd),
    playerTurns: playerTurnCmds
      .map((t) => parseTurn(t))
      .filter((t): t is Turn => Boolean(t)),
    npcUpdates,
    fine,
    licenseRevokeMonths,
    errorInfo,
    lostTime: c.lost_time,
    isCorrect: false,
    initialState: stateInfo.initialState,
    cStateTransitions: stateInfo.cStateTransitions,
  };
}

function splitQuestion(raw: string): { title: string; options: string[] } {
  const decoded = raw.replace(/\\t/g, "\t").replace(/\\n/g, "\n");
  const parts = decoded
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return { title: raw, options: [] };

  const optionRegex = /^(\d+)[.)]\s*(.+)$/;
  const titleParts: string[] = [];
  const options: string[] = [];
  for (const p of parts) {
    const m = p.match(optionRegex);
    if (m) options.push(m[2]);
    else titleParts.push(p);
  }
  return { title: titleParts.join(" "), options };
}

function parseTextPos(s: string | null): { x: number; y: number } | null {
  if (!s) return null;
  const nums = parseFloats(s);
  if (nums.length < 2) return null;
  return { x: nums[0], y: nums[1] };
}

function buildScene(d: DumpScene): Scene {
  const actors = d.actors
    .map((a, i) => parseActor(a, i))
    .filter((a): a is Actor => Boolean(a));

  const cases = d.cases.map((c) => parseCase(c));

  if (cases.length > 0) {
    const correctIdx = cases.findIndex((c) => c.errorInfo == null && (c.fine == null || c.fine === 0));
    const fallback = cases.findIndex((c) => c.errorInfo == null);
    const idx = correctIdx >= 0 ? correctIdx : fallback >= 0 ? fallback : 0;
    cases[idx].isCorrect = true;
  }

  const { title, options } = splitQuestion(d.question_text_raw);
  return {
    sceneFile: d.scene_file,
    sceneId: d.scene_id,
    sceneVar: d.scene_var,
    questionTextRaw: d.question_text_raw,
    questionTitle: title,
    questionOptions: options,
    textPos: parseTextPos(d.text_pos),
    timeLimit: d.time_limit,
    actors,
    cases,
    hasQuestion: cases.length > 0,
    initialState: d.scene_initial_state ?? null,
  };
}

function nodeFromFile(scenePath: string): string {
  const parts = scenePath.split("/");
  const i = parts.indexOf("scripts");
  return parts[i + 1] ?? scenePath;
}

function build(): MissionsData {
  const dump = JSON.parse(fs.readFileSync(DUMP_PATH, "utf8")) as Dump;
  const sceneByFile = new Map<string, DumpScene>();
  for (const s of dump.scenes) sceneByFile.set(s.scene_file, s);

  const scenesByNode = new Map<string, DumpScene[]>();
  for (const s of dump.scenes) {
    const node = nodeFromFile(s.scene_file);
    let arr = scenesByNode.get(node);
    if (!arr) {
      arr = [];
      scenesByNode.set(node, arr);
    }
    arr.push(s);
  }
  for (const arr of scenesByNode.values()) {
    arr.sort((a, b) => a.scene_file.localeCompare(b.scene_file));
  }

  const missions: Mission[] = [];
  const missionKeys = Object.keys(dump.missions).sort((a, b) => {
    const na = Number.parseInt(a.replace(/\D/g, ""), 10);
    const nb = Number.parseInt(b.replace(/\D/g, ""), 10);
    return na - nb;
  });

  for (let i = 0; i < missionKeys.length; i++) {
    const id = missionKeys[i];
    const dm = dump.missions[id];
    const nodes: SceneNode[] = [];
    for (const nodeId of dm.nodes) {
      const list = scenesByNode.get(nodeId) ?? [];
      const variants = list.map((s) => buildScene(s));
      nodes.push({ nodeId, variants });
    }

    let playerSprite = "our_car";
    for (const node of nodes) {
      for (const v of node.variants) {
        const my = v.actors.find((a) => a.kind === "MY_CAR");
        if (my && my.sprite) {
          playerSprite = my.sprite;
          break;
        }
      }
      if (playerSprite !== "our_car") break;
    }

    missions.push({
      id,
      index: i + 1,
      initNodeId: dm.init_node,
      terminalNodeId: dm.terminal_node,
      nodes,
      playerSprite,
      title: MISSION_TITLES[id] ?? `Миссия ${i + 1}`,
    });
  }

  // Build TL state table from TrafficLightState.script dump
  const TL_VALUE_MAP: Record<number, import("../src/types.ts").TLColor> = {
    0: "red",
    1: "yellow",
    2: "green",
    3: "yellowblink",
    4: "whiteblink",
    5: "off",
  };
  const tlStates: Record<number, Record<number, import("../src/types.ts").TLColor>> = {};
  for (const s of dump.traffic_light_state_machine?.states ?? []) {
    const lights: Record<number, import("../src/types.ts").TLColor> = {};
    for (const tl of s.trafficlights) {
      lights[tl.id] = TL_VALUE_MAP[tl.value] ?? "off";
    }
    tlStates[s.state] = lights;
  }

  return { missions, tlStates };
}

const out = build();
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(out));
console.log(
  `Built ${out.missions.length} missions, ${out.missions.reduce(
    (acc, m) => acc + m.nodes.length,
    0
  )} nodes -> ${OUT_PATH}`
);
