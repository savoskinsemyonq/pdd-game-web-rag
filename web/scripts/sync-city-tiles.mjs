import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const TILES_SRC = path.join(ROOT, "map_analyse", "tiles");
const TILES_DST = path.resolve(__dirname, "..", "public", "city", "tiles");
const MAPDATA_SRC = path.join(ROOT, "map_analyse", "mapData.js");
const MAPDATA_DST = path.resolve(__dirname, "..", "src", "data", "cityMapData.js");

if (!fs.existsSync(TILES_SRC)) {
  console.error("[sync-city-tiles] Missing tiles dir:", TILES_SRC);
  process.exit(1);
}

fs.mkdirSync(TILES_DST, { recursive: true });
let n = 0;
for (const name of fs.readdirSync(TILES_SRC)) {
  if (!name.endsWith(".png")) continue;
  fs.copyFileSync(path.join(TILES_SRC, name), path.join(TILES_DST, name));
  n++;
}
console.log(`[sync-city-tiles] Copied ${n} PNG(s) → ${TILES_DST}`);

if (fs.existsSync(MAPDATA_SRC)) {
  fs.mkdirSync(path.dirname(MAPDATA_DST), { recursive: true });
  fs.copyFileSync(MAPDATA_SRC, MAPDATA_DST);
  console.log(`[sync-city-tiles] Copied mapData.js → ${MAPDATA_DST}`);
} else {
  console.warn("[sync-city-tiles] Skip mapData (missing):", MAPDATA_SRC);
}
