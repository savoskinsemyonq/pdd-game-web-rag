/**
 * Extract inline SVGs from game-assets-modern.html → PNG sibling folder uses sprites/;
 * writes sprites/modern/modern_*.svg and prints catalog entries (merged into sprite-catalog.json).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, "..");

const NAMES = [
  "rails",
  "yama",
  "sign_50",
  "dom",
  "home",
  "krug_dvig",
  "krug_dvig_l",
  "kust",
  "main_road",
  "naklon",
  "ne_pravilsk",
  "no_playground",
  "podzem",
  "podzem_180",
  "rabota",
];

function parseViewBoxSize(svg) {
  const vb = /viewBox="([^"]+)"/i.exec(svg);
  if (!vb) return [64, 64];
  const p = vb[1].trim().split(/\s+/).map(Number);
  const w = Math.round(p[2] ?? 64);
  const h = Math.round(p[3] ?? 64);
  return [w, h];
}

function ensureXmlns(svg) {
  if (/xmlns\s*=/.test(svg)) return svg;
  return svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
}

const htmlPath =
  process.argv[2] ?? path.join(process.env.USERPROFILE ?? "", "Downloads", "game-assets-modern.html");

const catalogPath = path.join(webRoot, "public", "maps", "mission2", "sprite-catalog.json");
const outDir = path.join(webRoot, "public", "maps", "mission2", "sprites", "modern");

if (!fs.existsSync(htmlPath)) {
  console.error("HTML not found:", htmlPath);
  console.error("Usage: node scripts/import-modern-game-assets.mjs [path/to/game-assets-modern.html]");
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, "utf8");
const re = /<svg\b[^>]*>[\s\S]*?<\/svg>/gi;
const svgs = [];
let m;
while ((m = re.exec(html)) !== null) svgs.push(m[0]);

if (svgs.length !== NAMES.length) {
  console.warn(`Expected ${NAMES.length} SVGs, found ${svgs.length}`);
}

fs.mkdirSync(outDir, { recursive: true });

const newEntries = [];

for (let i = 0; i < NAMES.length; i++) {
  const name = NAMES[i];
  const raw = svgs[i];
  if (!raw) continue;
  const svg = ensureXmlns(raw);
  const fileRel = `sprites/modern/modern_${name}.svg`;
  const outFile = path.join(outDir, `modern_${name}.svg`);
  fs.writeFileSync(outFile, `<?xml version="1.0" encoding="UTF-8"?>\n${svg}\n`, "utf8");
  const [w, h] = parseViewBoxSize(svg);
  newEntries.push({ file: fileRel, w, h });
}

const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const existing = new Set(catalog.sprites.map((s) => s.file));
let added = 0;
for (const e of newEntries) {
  if (existing.has(e.file)) continue;
  catalog.sprites.push(e);
  existing.add(e.file);
  added++;
}
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n", "utf8");

console.log(`Wrote ${newEntries.length} SVGs to sprites/modern/`);
console.log(`Added ${added} new entries to sprite-catalog.json`);
