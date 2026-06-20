/**
 * One-off enrichment step: reads the original `.script` sources (restored under
 * `<repo root>/scripts/`) to recover each scene's pre-CASE `STATE <id>` directive —
 * the traffic-light state a scene starts in before the player picks an answer.
 * This data is missing from game_logic_dump.json because the original dump tool
 * only captured per-case commands, not the scene header.
 *
 * Run once (or whenever `scripts/` is refreshed) with:
 *   npx tsx scripts/import-scene-states.ts
 *
 * `build-data.ts` never reads `scripts/` directly — it only consumes the
 * `scene_initial_state` field this script writes into game_logic_dump.json.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const DUMP_PATH = path.join(ROOT, "game_logic_dump.json");

interface DumpScene {
  scene_file: string;
  scene_initial_state?: number;
  [key: string]: unknown;
}

/** The scene-level STATE directive precedes the first CASE line; anything after belongs to a case. */
function parseSceneInitialState(scriptPath: string): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(scriptPath, "latin1");
  } catch {
    return null;
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^CASE\s+\d+/i.test(line)) break;
    const m = line.match(/^STATE\s+(\d+)$/i);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

const dump = JSON.parse(fs.readFileSync(DUMP_PATH, "utf8")) as { scenes: DumpScene[] };

let updated = 0;
let missingFile = 0;
for (const scene of dump.scenes) {
  const scriptPath = path.resolve(ROOT, scene.scene_file);
  if (!fs.existsSync(scriptPath)) {
    missingFile++;
    continue;
  }
  const sceneInitialState = parseSceneInitialState(scriptPath);
  if (sceneInitialState != null) {
    scene.scene_initial_state = sceneInitialState;
    updated++;
  } else {
    delete scene.scene_initial_state;
  }
}

fs.writeFileSync(DUMP_PATH, JSON.stringify(dump, null, 2) + "\n", "utf8");
console.log(`Updated ${updated} scenes with scene-level initial TL state (${missingFile} script files not found).`);
