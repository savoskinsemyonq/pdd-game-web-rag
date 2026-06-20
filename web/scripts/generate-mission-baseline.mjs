/**
 * Auto-generate `defaultSplineOverrides.missionN.json` baseline for missions 5-9.
 *
 * Idea:
 *   For each scene transition A → B, shift the LAST keyframe of the player's
 *   movement so that the total travel equals (positionB − positionA), which is
 *   the anchor delta on the new PNG world map (positions in `missions.json` are
 *   exactly the placement anchors in `*-map.meta.json`).
 *
 * Per-scene rule:
 *   shift = (positionB − positionA) − (approachEnd + correctCaseEnd)
 *   • If at least one non-error `case.playerSpline` has ≥2 keyframes →
 *     shift its last keyframe (replicated for ALL non-error multi-key cases,
 *     so wrong-but-non-error answers also lead to the same final position).
 *   • Otherwise (init scenes, single-keyframe cases) →
 *     shift the last keyframe of the approach spline (`*:v*:<MY_CAR.sprite>`).
 *   • If shift = (0,0): skip (don't add a redundant override).
 *
 * Re-runnable: overwrites the 5 output JSONs in place.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const MISSIONS_FILE = path.join(ROOT, "src", "data", "missions.json");
const OUT_DIR = path.join(ROOT, "src", "data");

const TARGET_MISSION_NUMS = [5, 6, 7, 8, 9];

function shiftLastKeyframe(keys, dx, dy) {
  if (!Array.isArray(keys) || keys.length === 0) return null;
  const out = keys.map((k) => ({ ...k }));
  const last = out[out.length - 1];
  last.dx += dx;
  last.dy += dy;
  return out;
}

function pickCorrectCase(cases) {
  if (!Array.isArray(cases) || cases.length === 0) return null;
  return cases.find((c) => c.isCorrect) ?? cases.find((c) => !c.errorInfo) ?? null;
}

function generateForMission(mission) {
  const overrides = {};
  let appliedToCase = 0;
  let appliedToApproach = 0;
  let skippedZero = 0;

  for (let i = 0; i < mission.nodes.length - 1; i++) {
    const nodeA = mission.nodes[i];
    const nodeB = mission.nodes[i + 1];
    const myA = nodeA.variants[0].actors.find((a) => a.kind === "MY_CAR");
    const myB = nodeB.variants[0].actors.find((a) => a.kind === "MY_CAR");
    if (!myA || !myB) continue;

    const targetX = myB.position.x - myA.position.x;
    const targetY = myB.position.y - myA.position.y;

    for (let vi = 0; vi < nodeA.variants.length; vi++) {
      const scene = nodeA.variants[vi];
      const mc = scene.actors.find((a) => a.kind === "MY_CAR");
      if (!mc?.spline?.keys?.length) continue;

      const apKeys = mc.spline.keys;
      const apEnd = apKeys[apKeys.length - 1];

      const correctCase = pickCorrectCase(scene.cases);
      const ccKeys = correctCase?.playerSpline?.keys ?? [];
      const ccEnd =
        ccKeys.length > 0
          ? ccKeys[ccKeys.length - 1]
          : { dx: 0, dy: 0 };

      const origTotalX = apEnd.dx + ccEnd.dx;
      const origTotalY = apEnd.dy + ccEnd.dy;
      const shiftX = targetX - origTotalX;
      const shiftY = targetY - origTotalY;

      if (shiftX === 0 && shiftY === 0) {
        skippedZero++;
        continue;
      }

      const multiKeyNonErrorCases = scene.cases.filter(
        (c) => !c.errorInfo && (c.playerSpline?.keys?.length ?? 0) >= 2
      );

      if (multiKeyNonErrorCases.length > 0) {
        for (const c of multiKeyNonErrorCases) {
          const newKeys = shiftLastKeyframe(c.playerSpline.keys, shiftX, shiftY);
          if (!newKeys) continue;
          overrides[`${nodeA.nodeId}:v${vi}:case${c.case}:player`] = { keys: newKeys };
          appliedToCase++;
        }
      } else {
        const sprite = (mc.sprite || "").toLowerCase();
        if (!sprite) continue;
        const newKeys = shiftLastKeyframe(mc.spline.keys, shiftX, shiftY);
        if (!newKeys) continue;
        overrides[`${nodeA.nodeId}:v${vi}:${sprite}`] = { keys: newKeys };
        appliedToApproach++;
      }
    }
  }

  return { overrides, appliedToCase, appliedToApproach, skippedZero };
}

function main() {
  if (!fs.existsSync(MISSIONS_FILE)) {
    console.error(`[gen] missions.json not found at ${MISSIONS_FILE}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(MISSIONS_FILE, "utf8"));

  for (const num of TARGET_MISSION_NUMS) {
    const missionId = `mission${num}`;
    const mission = data.missions.find((m) => m.id === missionId);
    if (!mission) {
      console.warn(`[gen] ${missionId}: not in missions.json, skipping`);
      continue;
    }

    const { overrides, appliedToCase, appliedToApproach, skippedZero } =
      generateForMission(mission);

    const outPath = path.join(OUT_DIR, `defaultSplineOverrides.${missionId}.json`);
    fs.writeFileSync(outPath, JSON.stringify(overrides, null, 2) + "\n");
    console.log(
      `[gen] ${missionId}: ${Object.keys(overrides).length} overrides ` +
        `(${appliedToCase} on case, ${appliedToApproach} on approach, ${skippedZero} zero-skip) ` +
        `→ ${path.relative(ROOT, outPath)}`
    );
  }
}

main();
