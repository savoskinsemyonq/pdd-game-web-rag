/**
 * Reads ../../map/city.map (binary editor format) and writes:
 *   ../../map/city-map-export.json  — header, tile stats, objects (debug)
 *   ../../map/city-map-tiles.bin    — raw uint16 LE tile ids row-major (192×192)
 *   web/public/city/city-bg.png     — stylized world background 12288×12288 (nearest from 192² tile categories)
 *   web/public/city/city-objects.json — compact decor for the web renderer (houses / traffic lights)
 *
 * Run:  cd web && npm run build:map
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const root = path.resolve(__dirname, "..", "..");
const mapDir = path.join(root, "map");
const publicCityDir = path.join(webRoot, "public", "city");
const src = path.join(mapDir, "city.map");

/** Tile id → category for stylized raster (heuristic from frequency / roles). */
const CAT_GRASS = "grass";
const CAT_ASPHALT = "asphalt";
const CAT_SIDEWALK = "sidewalk";
const CAT_SPECIAL = "special";

const ASPHALT_IDS = new Set([1, 2, 3, 9, 11, 6, 7, 10, 13, 14, 20, 37, 38, 49, 73]);
const SIDEWALK_IDS = new Set([66, 72, 145, 151, 140, 224, 147]);
const SPECIAL_IDS = new Set([216]);

/** RGBA per category */
const COLORS = {
  [CAT_GRASS]: [42, 92, 58, 255],
  [CAT_ASPHALT]: [34, 36, 44, 255],
  [CAT_SIDEWALK]: [118, 116, 108, 255],
  [CAT_SPECIAL]: [52, 112, 168, 255],
};

function tileCategory(id) {
  if (id === 0) return CAT_GRASS;
  if (SPECIAL_IDS.has(id)) return CAT_SPECIAL;
  if (SIDEWALK_IDS.has(id)) return CAT_SIDEWALK;
  if (ASPHALT_IDS.has(id)) return CAT_ASPHALT;
  /** default: treat unknown as asphalt-ish road surface */
  return CAT_ASPHALT;
}

function readU32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function decodeHeader(b) {
  const width = readU32(b, 0);
  const height = readU32(b, 4);
  const itemSize = readU32(b, 8);
  let i = 12;
  let spriteFolder = "";
  while (i < b.length && b[i] !== 0) spriteFolder += String.fromCharCode(b[i++]);
  return {
    width,
    height,
    itemSize,
    spriteFolder: spriteFolder.replace(/\\/g, "/"),
    headerBytes: 272,
    worldWidthPx: width * itemSize,
    worldHeightPx: height * itemSize,
  };
}

function readTiles(b, headerBytes, w, h) {
  const count = w * h;
  const need = headerBytes + count * 2;
  if (b.length < need) throw new Error(`Buffer too short for tile layer: ${b.length} < ${need}`);
  const tiles = new Uint16Array(count);
  let o = headerBytes;
  for (let i = 0; i < count; i++) {
    tiles[i] = b[o] | (b[o + 1] << 8);
    o += 2;
  }
  return tiles;
}

function tileStats(tiles) {
  const hist = new Map();
  let nz = 0;
  let min = 65535;
  let max = 0;
  for (let i = 0; i < tiles.length; i++) {
    const v = tiles[i];
    if (v) {
      nz++;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    hist.set(v, (hist.get(v) || 0) + 1);
  }
  const top = [...hist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([id, n]) => ({ id, count: n }));
  return {
    nonZeroCells: nz,
    minId: min === 65535 ? 0 : min,
    maxId: max,
    topTileIds: top,
  };
}

/** Find tex\\....\.GLt paths and infer uint32 fields immediately before the path (after one separator byte). */
function extractObjects(b, minOff) {
  const latin1 = b.toString("latin1");
  const re = /tex\\[^\x00]+\.GLt/g;
  const out = [];
  let m;
  while ((m = re.exec(latin1))) {
    const pathStart = m.index;
    if (pathStart < minOff) continue;
    const pathStr = m[0].replace(/\\/g, "/");
    const sep = pathStart - 1 >= 0 ? b[pathStart - 1] : 0;
    const ints = [];
    for (let back = 4; back <= 48; back += 4) {
      const o = pathStart - 1 - back;
      if (o < minOff) break;
      ints.unshift(readU32(b, o));
    }
    while (ints.length > 1 && ints[0] === 0) ints.shift();
    out.push({
      path: pathStr,
      separatorByte: sep,
      fieldsLeU32: ints,
      xPx: ints.length >= 2 ? ints[ints.length - 2] : undefined,
      yPx: ints.length >= 1 ? ints[ints.length - 1] : undefined,
    });
  }
  return out;
}

function classifyDecorPath(p) {
  const lower = p.toLowerCase();
  if (lower.includes("/houses/")) return "house";
  if (lower.includes("/trafficlights/")) return "trafficLight";
  return "other";
}

async function writeStylizedCityPng(tiles, W, H, itemSize, outPath) {
  const sharp = (await import("sharp")).default;
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const id = tiles[y * W + x];
      const cat = tileCategory(id);
      const c = COLORS[cat];
      const p = (y * W + x) * 4;
      rgba[p] = c[0];
      rgba[p + 1] = c[1];
      rgba[p + 2] = c[2];
      rgba[p + 3] = c[3];
    }
  }
  const worldW = W * itemSize;
  const worldH = H * itemSize;
  await sharp(Buffer.from(rgba), {
    raw: { width: W, height: H, channels: 4 },
  })
    .resize(worldW, worldH, { kernel: sharp.kernel.nearest })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
}

async function main() {
  fs.mkdirSync(publicCityDir, { recursive: true });

  const buf = fs.readFileSync(src);
  const header = decodeHeader(buf);
  const { width: W, height: H, headerBytes, itemSize } = header;
  const tiles = readTiles(buf, headerBytes, W, H);
  const stats = tileStats(tiles);

  const tileBinPath = path.join(mapDir, "city-map-tiles.bin");
  fs.writeFileSync(tileBinPath, Buffer.from(tiles.buffer));

  const objects = extractObjects(buf, headerBytes + W * H * 2);

  const exportPath = path.join(mapDir, "city-map-export.json");
  const payload = {
    source: "map/city.map",
    header,
    tileLayer: {
      encoding: "uint16 LE row-major (width * y + x)",
      ...stats,
      binFile: "city-map-tiles.bin",
    },
    objects: {
      count: objects.length,
      note:
        "fieldsLeU32 — LE uint32 перед separatorByte (без ведущих нулей); последние два поля обычно X/Y в пикселях (÷ itemSize для индекса клетки).",
      items: objects,
    },
    companionFiles: {
      "map/city": "настройки редактора: Width, Height, ItemSize, SpriteFolder, MapFile",
      "map/tl": "строки вида «NNN a b» — справочник типов тайлов/слоёв для светофоров",
      "map/color": "RGB палитра редактора (по строкам)",
    },
  };
  fs.writeFileSync(exportPath, JSON.stringify(payload, null, 2), "utf8");

  const cityBgPath = path.join(publicCityDir, "city-bg.png");
  await writeStylizedCityPng(tiles, W, H, itemSize, cityBgPath);

  const decorItems = objects
    .filter((o) => o.xPx !== undefined && o.yPx !== undefined)
    .map((o) => {
      const kind = classifyDecorPath(o.path);
      return {
        kind,
        sprite: o.path,
        xPx: o.xPx,
        yPx: o.yPx,
      };
    });

  const cityObjectsPath = path.join(publicCityDir, "city-objects.json");
  fs.writeFileSync(
    cityObjectsPath,
    JSON.stringify(
      {
        version: 1,
        worldWidthPx: header.worldWidthPx,
        worldHeightPx: header.worldHeightPx,
        tileSizePx: itemSize,
        itemCount: decorItems.length,
        items: decorItems,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log("Wrote:", tileBinPath);
  console.log("Wrote:", exportPath);
  console.log("Wrote:", cityBgPath);
  console.log("Wrote:", cityObjectsPath);
  console.log("Tiles non-zero:", stats.nonZeroCells, "/", W * H, "id range", stats.minId, "..", stats.maxId);
  console.log("Objects (.GLt paths):", objects.length, "→ decor JSON:", decorItems.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
