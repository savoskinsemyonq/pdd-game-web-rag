/**
 * Removes photo backgrounds from mission2 PNG sprites.
 *
 * По умолчанию (sharp):
 * - home.png: edge flood только по «травяным» пикселям (чтобы не съесть зелёный забор).
 * - naklon / no_playground: flood по краю с блокировкой прохода через блики столба и белые
 *   участки (signBrightMetal), затем локальное восстановление альфы около этих бликов.
 * - Остальные PNG: flood с края + слабая альфа + крупнейший остров (убирает пятна фона).
 * - Если спрайт экспортирован с чёрной подложкой вместо альфы (край не трава/не асфальт),
 *   основной flood может не стартовать — тогда включается второй проход по связным почти-чёрным пикселям.
 * - relsi.png: не трогаем (рельсы с балластом — фон часть спрайта).
 *
 * Флаг `--rembg`: удаление через Python rembg (`pip install -r scripts/requirements-rembg.txt`,
 * первый запуск скачает модель). Для игрового топдауна результат может быть хуже flood-профилей.
 *
 * Usage:
 *   node scripts/remove-mission2-sprite-background.mjs [png ...]
 *   node scripts/remove-mission2-sprite-background.mjs --all
 *   node scripts/remove-mission2-sprite-background.mjs --all --rembg
 */
import fs from "fs";
import os from "node:os";
import path from "path";
import sharp from "sharp";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(scriptDir, "..");

/** Спрайты, для которых фон сознательно не удаляем. */
const SKIP_BG_REMOVAL = new Set(["relsi"]);

/** Знаки с белым/серым столбом и цветным полем — без `keepLargestOpaqueIsland` (он отрезал стрелки и синие круги). */
const ROAD_SIGN_BASES = new Set([
  "50",
  "500",
  "kr_treug",
  "krug_dvig",
  "krug_dvig_l",
  "main_road",
  "mr",
  "mroad",
  "mod_naklon",
  "mod_playg",
  "ne_pravilsk",
  "park",
  "prav",
  "rabota",
  "treug",
]);

/** Пешеходный переход «ступени»: только чёрные линии, без серого асфальта между пролётами и снаружи. */
const PODZEM_BASES = new Set(["podzem", "podzem_180"]);

const SPRITES_DIR_REL = "public/maps/mission2/sprites";

const DEFAULT_RELS = [
  "public/maps/mission2/sprites/home.png",
  "public/maps/mission2/sprites/naklon.png",
  "public/maps/mission2/sprites/no_playground.png",
];

/** Толерантность RGB между соседями для обычных спрайтов (не спец-профили). */
const DEFAULT_GENERIC_TOL = 34;

const TOL_BY_BASENAME = {
  home: 40,
  dom: 50,
  naklon: 34,
  no_playground: 38,
  /** Зернистый асфальт + разрез серый/чёрный фон требуют более широкой связности с края. */
  "50": 50,
  "500": 50,
  kr_treug: 50,
  krug_dvig: 50,
  krug_dvig_l: 50,
  main_road: 50,
  mr: 50,
  mroad: 50,
  mod_naklon: 50,
  mod_playg: 50,
  ne_pravilsk: 50,
  park: 50,
  prav: 50,
  rabota: 50,
  treug: 50,
};

function idx(x, y, w) {
  return y * w + x;
}

function distRgb(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function lumRgb(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Turf behind `home.png` — excludes darker fence greens and building colours. */
function grassLikeHome(r, g, b) {
  return r >= 78 && g >= 115 && b >= 22 && b <= 72 && g - r <= 62 && g >= b + 35;
}

function isGrassish(r, g, b) {
  return g > 95 && g > r + 18 && g > b + 25;
}

/** Столб / белые блики: через них flood не проходит (иначе смыкается с серым фоном). */
function signBrightMetal(r, g, b) {
  const lum = lumRgb(r, g, b);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const spread = mx - mn;
  if (lum >= 184) return true;
  if (spread <= 12 && mn >= 128 && mx <= 172) return true;
  return false;
}

/** Тёмно-серый цилиндр столба naklon (после flood часто отрезается от белого ядра). */
function naklonPoleRestoreRGB(r, g, b) {
  if (isGrassish(r, g, b)) return false;
  const lum = lumRgb(r, g, b);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const spread = mx - mn;
  return lum >= 62 && lum <= 122 && spread <= 22;
}

/** Участок между синей табличкой и белым столбом у no_playground. */
function noPlayMountBlue(r, g, b) {
  const lum = lumRgb(r, g, b);
  return b >= 112 && r >= 48 && r <= 95 && g >= 72 && g <= 165 && b - r >= 35 && lum <= 130;
}

function noPlaygroundPoleRestoreRGB(r, g, b) {
  if (naklonPoleRestoreRGB(r, g, b)) return true;
  const lum = lumRgb(r, g, b);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const spread = mx - mn;
  if (g >= 110 && r >= 100 && b <= 100 && b >= 68 && lum <= 155 && lum >= 88 && spread <= 72) return true;
  if (g >= 95 && lum <= 148 && lum >= 76 && b >= 62 && b <= 118 && spread <= 50 && r <= 138) return true;
  if (noPlayMountBlue(r, g, b)) return true;
  return false;
}

/**
 * Через эти пиксели flood не проходит: блики/металл, синее и жёлтое поле знака, красная окантовка,
 * белая серединка, оранжевые «дорожные работы». Серый асфальт обычно не попадает под правила.
 */
function roadSignPanelTraverseBlock(r, g, b) {
  if (signBrightMetal(r, g, b)) return true;
  const lum = lumRgb(r, g, b);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const spread = mx - mn;

  if (b >= 76 && b - r >= 10 && b - g >= 3 && lum <= 252 && lum >= 30) return true;
  if (r >= 148 && g >= 126 && b <= 148 && r - b >= 18) return true;
  if (r >= 92 && r - g >= 10 && r - b >= 10 && lum <= 252) return true;
  if (lum >= 156 && spread <= 52 && mn >= 112) return true;
  if (r >= 152 && g >= 68 && g <= 218 && b <= 130 && r - b >= 22) return true;
  /** Белая табличка / белая обводка ромба / белый столб (ещё до узкой классификации асфальта в grain). */
  if (roadSignWhitePlateOrBorder(r, g, b)) return true;

  return false;
}

/** Якоря для восстановления столба: светлые блики + насыщенные области знака (не только белый металл). */
function collectRoadSignAnchors(data, w, h) {
  const pts = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = idx(x, y, w) * 4;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      if (signBrightMetal(r, g, b)) {
        pts.push([x, y]);
        continue;
      }
      if (roadSignWhitePlateOrBorder(r, g, b)) {
        pts.push([x, y]);
        continue;
      }
      const lum = lumRgb(r, g, b);
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sp = mx - mn;
      if (b >= 84 && b - r >= 12 && b - g >= 5 && lum <= 248) pts.push([x, y]);
      else if (r >= 158 && g >= 134 && b <= 142 && r - b >= 26) pts.push([x, y]);
      else if (lum >= 172 && sp <= 44 && mn >= 120) pts.push([x, y]);
      else if (r >= 158 && g >= 72 && b <= 122 && r - b >= 28) pts.push([x, y]);
    }
  }
  return pts;
}

/**
 * Типичная крупа асфальта на скриншотах знаков — такие пиксели не считаем «дырой» столба
 * и не восстанавливаем после flood (иначе серый фон остаётся).
 */
function roadSignAsphaltGrain(r, g, b) {
  const lum = lumRgb(r, g, b);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const sp = mx - mn;
  return lum >= 55 && lum <= 106 && mn >= 56 && mx <= 118 && sp <= 28;
}

/**
 * Белая/светло-серая табличка («Правильск»), белая обводка ромба (mr), цилиндр столба.
 * Жёлтый ромб и красная окантовка треугольника исключаются по доминанте каналов.
 */
function roadSignWhitePlateOrBorder(r, g, b) {
  if (roadSignAsphaltGrain(r, g, b)) return false;
  const lum = lumRgb(r, g, b);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const sp = mx - mn;
  if (lum > 252 || mx > 252 || sp > 50) return false;

  const poleCylinder = lum >= 118 && lum <= 218 && mn >= 104 && sp <= 22;
  const whitePaint = lum >= 126 && mn >= 88 && sp <= 48 && lum <= 248;
  if (!poleCylinder && !whitePaint) return false;

  if (g >= r + 14 && g >= b + 16 && r >= 118 && b <= 168) return false;
  if (r >= 148 && r - Math.min(g, b) >= 36 && g <= 218 && b <= 218) return false;
  return true;
}

/** Чуть шире зона «нейтральной крупы» фона — только для слоя снятия у прозрачного края (не для восстановления столба). */
function roadSignAsphaltGrainWide(r, g, b) {
  const lum = lumRgb(r, g, b);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const sp = mx - mn;
  return lum >= 46 && lum <= 122 && mn >= 46 && mx <= 134 && sp <= 34;
}

/**
 * Остаточная серость фона (точки после flood/strip), без цвета знака.
 * Не матчится на синее/жёлтое/красное/белое поле — см. roadSignPanelTraverseBlock.
 */
function roadSignResidualGraySpeck(r, g, b) {
  if (roadSignPanelTraverseBlock(r, g, b)) return false;
  const lum = lumRgb(r, g, b);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const sp = mx - mn;
  /** Выше порога — часто металл столба / блики, не фоновые точки. */
  if (lum >= 122 || mn >= 102) return false;
  return lum >= 50 && lum <= 118 && mn >= 44 && mx <= 130 && sp <= 42;
}

/** Белые/очень светлые точки на чёрном после матирования (salt). */
function roadSignBrightBgSpeck(r, g, b) {
  if (roadSignPanelTraverseBlock(r, g, b)) return false;
  if (signBrightMetal(r, g, b)) return false;
  const lum = lumRgb(r, g, b);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const sp = mx - mn;
  return lum >= 158 && mn >= 132 && mx <= 255 && sp <= 40;
}

/** Жёлтое поле знака «главная дорога»: высокие R и G, B заметно ниже (не путать с green spill). */
function roadSignYellowGoldPanel(r, g, b) {
  const mnRG = Math.min(r, g);
  const mx = Math.max(r, g, b);
  if (mnRG < 124 || mx > 252) return false;
  /** У синего знака «P» chroma даёт G>R; у ромба R≈G (Δ обычно ≤14). */
  if (g - r > 14) return false;
  return b <= mnRG - 8 && r >= 136 && g >= 138;
}

/**
 * Ореол chroma key — заметный перевес G над R и B.
 * Нельзя отсекать через roadSignPanelTraverseBlock: «светлое поле» перехватывает мятную кайму у синего/белого.
 */
function roadSignGreenScreenFringe(r, g, b) {
  if (roadSignAsphaltGrain(r, g, b)) return false;
  if (roadSignYellowGoldPanel(r, g, b)) return false;
  const lum = lumRgb(r, g, b);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const sp = mx - mn;
  const greenLead = g - Math.max(r, b);
  /** Бирюзовый chroma у синего «50» — до signBrightMetal (иначе светлый ореол Lum≥184 считается «бликом»). */
  if (
    lum >= 88 &&
    lum <= 218 &&
    g >= 148 &&
    b >= 118 &&
    b <= 198 &&
    r <= 198 &&
    greenLead >= 15
  )
    return true;

  if (signBrightMetal(r, g, b)) return false;

  if (lum < 38 || lum > 226) return false;
  if (greenLead < 12) return false;
  /** Серый столб без отлива G; не ослаблять до «AA белой каймы», иначе зелёный экран не снимается. */
  if (sp <= 14 && mn >= 116 && greenLead < 11) return false;
  if (greenLead >= 17 && sp >= 15) return true;
  /** sp≥14 — слабая кайма у белого/голубого после кеинга (park.png и т.п.). */
  if (greenLead >= 12 && g >= 66 && sp >= 14) return true;
  return false;
}

/** Снять любой оставшийся chroma-key (включая «островки», достигшие синего поля — prune их не режет). */
function obliterateRoadSignGreenScreenFringe(data, w, h) {
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (data[o + 3] < 28) continue;
    const r = data[o];
    const gch = data[o + 1];
    const b = data[o + 2];
    if (!roadSignGreenScreenFringe(r, gch, b)) continue;
    data[o + 3] = 0;
    data[o] = 0;
    data[o + 1] = 0;
    data[o + 2] = 0;
  }
}

/** Пиксель «ядра знака» — связку таких островков не трогаем. */
function roadSignProtectedCorePixel(r, g, b) {
  return roadSignPanelTraverseBlock(r, g, b) || signBrightMetal(r, g, b);
}

/**
 * Удаляет мелкие 4-связные островки непрозрачности без контакта с полем знака/бликами
 * (типичный salt-and-pepper на фоне).
 */
function pruneRoadSignTinyNoiseComponents(data, w, h, maxTinyArea = 15, alphaCut = 22) {
  const fg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    fg[i] = data[i * 4 + 3] > alphaCut ? 1 : 0;
  }

  const seen = new Uint8Array(w * h);

  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const si = sy * w + sx;
      if (!fg[si] || seen[si]) continue;

      const qx = [sx];
      const qy = [sy];
      seen[si] = 1;
      const members = [si];
      let touchesProt = false;
      let qh = 0;

      const o0 = si * 4;
      const r0 = data[o0];
      const g0 = data[o0 + 1];
      const b0 = data[o0 + 2];
      if (roadSignProtectedCorePixel(r0, g0, b0)) touchesProt = true;

      while (qh < qx.length) {
        const x = qx[qh];
        const y = qy[qh++];
        const neigh = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ];
        for (const [nx, ny] of neigh) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (!fg[ni] || seen[ni]) continue;
          seen[ni] = 1;
          members.push(ni);
          qx.push(nx);
          qy.push(ny);
          const o = ni * 4;
          if (roadSignProtectedCorePixel(data[o], data[o + 1], data[o + 2])) touchesProt = true;
        }
      }

      if (!touchesProt && members.length <= maxTinyArea) {
        for (let k = 0; k < members.length; k++) {
          const o = members[k] * 4;
          data[o + 3] = 0;
          data[o] = 0;
          data[o + 1] = 0;
          data[o + 2] = 0;
        }
      }
    }
  }
}

/** Снимает слои «островков» chroma key: граница — сосед не матчится или прозрачен (эрозия от краёв объекта). */
function stripRoadSignGreenFringeErode(data, w, h, passes = 12) {
  const neigh = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  for (let p = 0; p < passes; p++) {
    const clear = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = idx(x, y, w);
        const o = i * 4;
        if (data[o + 3] < 28) continue;
        const r = data[o];
        const gch = data[o + 1];
        const b = data[o + 2];
        if (!roadSignGreenScreenFringe(r, gch, b)) continue;
        let peel = false;
        for (const [dx, dy] of neigh) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
            peel = true;
            break;
          }
          const ni = idx(nx, ny, w);
          const no = ni * 4;
          if (data[no + 3] < 36) {
            peel = true;
            break;
          }
          const nr = data[no];
          const ng = data[no + 1];
          const nb = data[no + 2];
          if (!roadSignGreenScreenFringe(nr, ng, nb)) {
            peel = true;
            break;
          }
        }
        if (peel) clear[i] = 1;
      }
    }
    let any = false;
    for (let i = 0; i < w * h; i++) {
      if (!clear[i]) continue;
      any = true;
      const o = i * 4;
      data[o + 3] = 0;
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
    }
    if (!any) break;
  }
}

/** Снимает пиксели, попадающие под matcher, если рядом есть прозрачность (8-соседство быстрее съедает ореол). */
function stripRoadSignMatcherTouchingTransparent(
  data,
  w,
  h,
  matcher,
  passes,
  eightNeighbors = true,
  minWeakNeighbors = 1,
) {
  const neigh = eightNeighbors
    ? [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ]
    : [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ];
  for (let p = 0; p < passes; p++) {
    const clear = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = idx(x, y, w);
        const o = i * 4;
        if (data[o + 3] < 28) continue;
        const r = data[o];
        const gch = data[o + 1];
        const b = data[o + 2];
        if (!matcher(r, gch, b)) continue;
        let weakNei = 0;
        for (const [dx, dy] of neigh) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
            weakNei++;
            continue;
          }
          const ni = idx(nx, ny, w);
          if (data[ni * 4 + 3] < 36) weakNei++;
        }
        if (weakNei >= minWeakNeighbors) clear[i] = 1;
      }
    }
    for (let i = 0; i < w * h; i++) {
      if (!clear[i]) continue;
      const o = i * 4;
      data[o + 3] = 0;
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
    }
  }
}

/** Восстановить альфу у «дыр» столба / монтажа рядом с бликами и полем знака. */
function roadSignGreyHoleRestore(r, g, b) {
  if (roadSignAsphaltGrain(r, g, b)) return false;
  if (roadSignGreenScreenFringe(r, g, b)) return false;
  if (roadSignWhitePlateOrBorder(r, g, b)) return true;
  if (noPlaygroundPoleRestoreRGB(r, g, b)) return true;
  const lum = lumRgb(r, g, b);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const spread = mx - mn;
  if (spread <= 36 && lum >= 48 && lum <= 175 && mn >= 38 && mx <= 218) return true;
  return false;
}

/** Газон вокруг dom.png — шире, чем у home (ядро дома не затрагиваем). */
function grassLikeDom(r, g, b) {
  return openFieldGrass(r, g, b) || isGrassish(r, g, b);
}

/** Почти чёрный пиксель (фон или обводка — различаем по связности со ступенями). */
function podzemVeryDark(r, g, b) {
  const lum = lumRgb(r, g, b);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const sp = mx - mn;
  return lum <= 26 && mx <= 36 && sp <= 22;
}

/** Достижимость из «светлых» ступеней по тёмным мостам (обводка), чтобы не вырезать контур вместе с фоном. */
function podzemReachableFromLightStairs(data, w, h) {
  const reach = new Uint8Array(w * h);
  const qx = [];
  const qy = [];
  function lumAt(ii) {
    const o = ii * 4;
    return lumRgb(data[o], data[o + 1], data[o + 2]);
  }
  function mxAt(ii) {
    const o = ii * 4;
    return Math.max(data[o], data[o + 1], data[o + 2]);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y, w);
      const o = i * 4;
      if (data[o + 3] < 17) continue;
      const L = lumAt(i);
      const mx = mxAt(i);
      if (L >= 46 || mx >= 58) {
        reach[i] = 1;
        qx.push(x);
        qy.push(y);
      }
    }
  }
  let qh = 0;
  while (qh < qx.length) {
    const x = qx[qh];
    const y = qy[qh++];
    const neigh = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
      [x - 1, y - 1],
      [x + 1, y - 1],
      [x - 1, y + 1],
      [x + 1, y + 1],
    ];
    for (const [nx, ny] of neigh) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = idx(nx, ny, w);
      const no = ni * 4;
      if (data[no + 3] < 17 || reach[ni]) continue;
      const nr = data[no];
      const ng = data[no + 1];
      const nb = data[no + 2];
      if (roadSignAsphaltGrain(nr, ng, nb)) continue;
      const L = lumRgb(nr, ng, nb);
      const mx = Math.max(nr, ng, nb);
      /** Чистый #000 между ступенями не тянем; только «мосты» обводки / AA с L чуть выше нуля. */
      if (L >= 14 && L <= 95 && mx <= 140) {
        reach[ni] = 1;
        qx.push(nx);
        qy.push(ny);
      }
    }
  }
  return reach;
}

/**
 * Подземный переход: убираем чёрные окна и асфальт, **ступени и контуры серые**.
 * Режим «чёрный фон»: выкидываем только очень тёмное вне достижимости от светлых ступеней (дыры фона).
 * Режим «дорога»: вырезаем асфальт, RGB не меняем.
 */
/** @returns {boolean} true если использован «спасательный» режим почти чёрного PNG — не резать островами. */
function applyPodzemStairsPreserveGray(data, w, h) {
  let salvageBlackCrop = false;
  let opaqueRead = 0;
  let blackishRead = 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (data[o + 3] < 17) continue;
    opaqueRead++;
    const r = data[o];
    const gch = data[o + 1];
    const b = data[o + 2];
    const lum = lumRgb(r, gch, b);
    const mx = Math.max(r, gch, b);
    if (lum <= 30 && mx <= 42) blackishRead++;
  }
  const blackBgMode = opaqueRead > 0 && blackishRead / opaqueRead > 0.035;

  let reach = null;
  let reachablePx = 0;
  if (blackBgMode) {
    reach = podzemReachableFromLightStairs(data, w, h);
    for (let i = 0; i < w * h; i++) {
      if (reach[i]) reachablePx++;
    }
    /** Почти весь PNG после старых прогонов чёрный — мало «светлых» сидов; режем только совсем #000, остальное красим в серый. */
    salvageBlackCrop = reachablePx < Math.min(450, Math.max(140, Math.floor(opaqueRead * 0.2)));
  }

  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const r = data[o];
    const gch = data[o + 1];
    const b = data[o + 2];
    const lum = lumRgb(r, gch, b);
    const mx = Math.max(r, gch, b);
    const mn = Math.min(r, gch, b);
    const sp = mx - mn;

    let remove = false;
    if (blackBgMode && salvageBlackCrop) {
      remove = roadSignAsphaltGrain(r, gch, b) || (lum <= 14 && mx <= 22 && sp <= 18);
    } else if (blackBgMode) {
      const dark = podzemVeryDark(r, gch, b);
      remove =
        roadSignAsphaltGrain(r, gch, b) ||
        (dark && !reach[i]) ||
        (!reach[i] && lum <= 42 && mx <= 62);
    } else {
      remove =
        roadSignAsphaltGrain(r, gch, b) ||
        (lum >= 70 && lum <= 132 && mn >= 64 && mx <= 142 && sp <= 30) ||
        (lum <= 44 && mx <= 62 && sp <= 32);
    }

    if (remove) {
      data[o + 3] = 0;
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
      continue;
    }

    data[o + 3] = 255;
    if (blackBgMode) {
      const avg = (r + gch + b) / 3;
      let t;
      if (avg <= 46) {
        t = Math.min(205, Math.max(78, Math.round(avg * 1.55 + 62)));
      } else {
        t = Math.min(238, Math.max(62, Math.round(avg * 0.9 + 15)));
      }
      data[o] = t;
      data[o + 1] = t;
      data[o + 2] = t;
    }
  }

  return salvageBlackCrop;
}

function collectBrightCoords(data, w, h) {
  const bright = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = idx(x, y, w) * 4;
      if (signBrightMetal(data[o], data[o + 1], data[o + 2])) bright.push([x, y]);
    }
  }
  return bright;
}

function manhattan(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function restoreNearBrightPixels(data, w, h, visited, brightCoords, maxDist, maxXFrac, matcher) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x > w * maxXFrac) continue;
      const i = idx(x, y, w);
      if (!visited[i]) continue;
      const o = i * 4;
      const r = data[o];
      const g = data[o + 1];
      const b = data[o + 2];
      if (!matcher(r, g, b)) continue;
      let dmin = 9999;
      for (let bi = 0; bi < brightCoords.length; bi++) {
        const d = manhattan([x, y], brightCoords[bi]);
        if (d < dmin) dmin = d;
      }
      if (dmin <= maxDist) {
        visited[i] = 0;
        data[o + 3] = 255;
      }
    }
  }
}

/**
 * Удаляет оторванные «пятна» (второй flood / восстановление столба иногда оставляют островки фона).
 * Оставляет только крупнейшую 4-связную область с alpha > alphaMin.
 */
function keepLargestOpaqueIsland(data, w, h, alphaMin = 20) {
  const fg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    fg[i] = data[i * 4 + 3] > alphaMin ? 1 : 0;
  }

  const seen = new Uint8Array(w * h);
  let bestIdx = null;
  let bestSize = 0;

  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const si = sy * w + sx;
      if (!fg[si] || seen[si]) continue;

      const qx = [sx];
      const qy = [sy];
      seen[si] = 1;
      const members = [si];
      let qh = 0;

      while (qh < qx.length) {
        const x = qx[qh];
        const y = qy[qh++];
        const neigh = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ];
        for (const [nx, ny] of neigh) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (!fg[ni] || seen[ni]) continue;
          seen[ni] = 1;
          members.push(ni);
          qx.push(nx);
          qy.push(ny);
        }
      }

      if (members.length > bestSize) {
        bestSize = members.length;
        bestIdx = members;
      }
    }
  }

  if (!bestIdx || bestSize === 0) return;

  const keep = new Uint8Array(w * h);
  for (let k = 0; k < bestIdx.length; k++) {
    keep[bestIdx[k]] = 1;
  }

  for (let i = 0; i < w * h; i++) {
    if (!keep[i]) {
      const o = i * 4;
      data[o + 3] = 0;
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
    }
  }
}

/** Полупрозрачный шум по краю → полностью прозрачный (чище чёрный фон в превью). */
function crushWeakAlpha(data, w, h, threshold = 28) {
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (data[o + 3] > 0 && data[o + 3] < threshold) {
      data[o + 3] = 0;
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
    }
  }
}

function zeroRgbWhereFullyTransparent(data, w, h) {
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (data[o + 3] === 0) {
      data[o] = 0;
      data[o + 1] = 0;
      data[o + 2] = 0;
    }
  }
}

function countMarkedVisited(visited) {
  let n = 0;
  for (let i = 0; i < visited.length; i++) if (visited[i]) n++;
  return n;
}

/** PNG с чёрной подложкой вместо альфы: край не похож на траву/асфальт → основной flood без семян. */
function matteBlackLetterboxRgb(r, g, b) {
  const mx = Math.max(r, g, b);
  return mx <= 26 && r + g + b <= 62;
}

function floodBlackLetterboxBackground(data, w, h, traverseBlocker = () => false) {
  const tol = 16;
  return floodMarkBackground(data, w, h, tol, traverseBlocker, matteBlackLetterboxRgb, matteBlackLetterboxRgb);
}

/**
 * Если помечено слишком мало «фона», считаем что край — чёрная матовая рамка экспорта, и заливаем её отдельно.
 */
function maybeVisitedBlackLetterboxFallback(data, w, h, visited, opts = {}) {
  const area = w * h;
  const minFrac = opts.minFrac ?? 0.018;
  const minPx = opts.minPx ?? 280;
  const need = Math.max(Math.floor(area * minFrac), minPx);
  if (countMarkedVisited(visited) >= need) return visited;
  const tb = opts.traverseBlocker ?? (() => false);
  return floodBlackLetterboxBackground(data, w, h, tb);
}

/**
 * Заливка фона с краёв.
 * @param edgeSeedFilter если задан — с края в очередь попадают только такие пиксели.
 * @param expandNeighborMatch если задан — в «фон» расширяемся только в соседей, ему удовлетворяющих
 *   (для home.png: только трава, иначе заливка зайдёт в дом/забор).
 */
function floodMarkBackground(data, w, h, adjTol, traverseBlocker, edgeSeedFilter, expandNeighborMatch) {
  const visited = new Uint8Array(w * h);
  const q = [];
  let qh = 0;

  function rgbAt(ii) {
    const o = ii * 4;
    return [data[o], data[o + 1], data[o + 2]];
  }

  function enqueueEdgePixel(x, y) {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = idx(x, y, w);
    if (visited[i]) return;
    const [r, g, b] = rgbAt(i);
    if (traverseBlocker(r, g, b)) return;
    if (edgeSeedFilter && !edgeSeedFilter(r, g, b)) return;
    visited[i] = 1;
    q.push(x, y);
  }

  for (let x = 0; x < w; x++) {
    enqueueEdgePixel(x, 0);
    enqueueEdgePixel(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    enqueueEdgePixel(0, y);
    enqueueEdgePixel(w - 1, y);
  }

  while (qh < q.length) {
    const x = q[qh++];
    const y = q[qh++];
    const i = idx(x, y, w);
    const c = rgbAt(i);
    const neigh = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];
    for (const [nx, ny] of neigh) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = idx(nx, ny, w);
      if (visited[ni]) continue;
      const [nr, ng, nb] = rgbAt(ni);
      if (traverseBlocker(nr, ng, nb)) continue;
      if (expandNeighborMatch && !expandNeighborMatch(nr, ng, nb)) continue;
      const nc = [nr, ng, nb];
      if (distRgb(c, nc) <= adjTol) {
        visited[ni] = 1;
        q.push(nx, ny);
      }
    }
  }

  return visited;
}

/** Однотонный газон у края кадра (кусты/ямы часто на траве — отличается от листвы). */
function openFieldGrass(r, g, b) {
  return g >= 118 && r <= 125 && b <= 85 && g > r + 18 && g > b + 28;
}

/** Краевые семена flood для ямы: только достаточно светлый асфальт/трава — тёмная кромка самой ямы не стартует заливку. */
function yamaEdgeSeedOk(r, g, b) {
  const lum = lumRgb(r, g, b);
  return lum >= 64 || openFieldGrass(r, g, b);
}

/** Через очень тёмные пиксели заливка не проходит — сохраняем чашу ямы, пока фон с краёв светлее. */
function yamaProtectDarkInterior(r, g, b) {
  return lumRgb(r, g, b) < 46;
}

/** Общие пороги отката «слишком мало переднего плана» (sharp и rembg). */
function maybeRollbackLowForeground(basename, opaque, area, backup, absPath) {
  if (basename === "home" && opaque < 6000) {
    fs.writeFileSync(absPath, backup);
    console.warn(`rollback ${basename}: слишком мало переднего плана (${opaque}px) — файл не изменён.`);
    return true;
  }
  if (basename === "yama" && opaque < Math.max(380, Math.floor(area * 0.016))) {
    fs.writeFileSync(absPath, backup);
    console.warn(
      `rollback ${basename}: остров оставил мало пикселей (${opaque}) — если яма обрезана, замените PNG.`,
    );
    return true;
  }
  if (basename === "kust" && opaque < Math.max(650, Math.floor(area * 0.022))) {
    fs.writeFileSync(absPath, backup);
    console.warn(
      `rollback ${basename}: после удаления газона осталось мало пикселей (${opaque}) — попробуйте другой исходник или правьте вручную.`,
    );
    return true;
  }
  if (ROAD_SIGN_BASES.has(basename) && opaque < Math.max(220, Math.floor(area * 0.014))) {
    fs.writeFileSync(absPath, backup);
    console.warn(
      `rollback ${basename}: профиль дорожного знака дал слишком мало непрозрачных (${opaque}px) — файл не изменён.`,
    );
    return true;
  }
  if (basename === "dom" && opaque < Math.max(8200, Math.floor(area * 0.048))) {
    fs.writeFileSync(absPath, backup);
    console.warn(
      `rollback ${basename}: после удаления газона мало переднего плана (${opaque}px) — файл не изменён.`,
    );
    return true;
  }
  if (PODZEM_BASES.has(basename) && opaque < Math.max(260, Math.floor(area * 0.018))) {
    fs.writeFileSync(absPath, backup);
    console.warn(`rollback ${basename}: мало линий лестницы (${opaque}px) — файл не изменён.`);
    return true;
  }
  const minOpaqueGuard = Math.max(300, Math.floor(area * 0.02));
  const genericLike =
    basename !== "home" &&
    basename !== "dom" &&
    basename !== "naklon" &&
    basename !== "no_playground" &&
    basename !== "kust" &&
    basename !== "yama" &&
    !ROAD_SIGN_BASES.has(basename) &&
    !PODZEM_BASES.has(basename);
  if (genericLike && opaque < minOpaqueGuard) {
    fs.writeFileSync(absPath, backup);
    console.warn(
      `rollback ${basename}: foreground ${opaque}px < guard ${minOpaqueGuard}px — файл не изменён (контакт объекта с краем или сложный фон).`,
    );
    return true;
  }
  return false;
}

function runRembgCli(absInput, absOutput) {
  const py = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  const helper = path.join(scriptDir, "rembg-one-pass.py");
  const r = spawnSync(py, [helper, absInput, absOutput], {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) {
    throw new Error(
      `rembg: не удалось запустить Python (${py}): ${r.error.message}. Установите зависимости: pip install -r scripts/requirements-rembg.txt`,
    );
  }
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || "").trim() || `код ${r.status}`;
    throw new Error(`rembg: ${msg}`);
  }
}

async function removeBackgroundWithRembg(absPath, basename, backup) {
  const tmpOut = path.join(os.tmpdir(), `rembg-${basename}-${process.pid}-${Date.now()}.png`);
  try {
    runRembgCli(absPath, tmpOut);
    if (!fs.existsSync(tmpOut)) {
      throw new Error("rembg не записал выходной файл");
    }
    const { data: raw, info } = await sharp(tmpOut).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const data = Buffer.from(raw);
    const w = info.width;
    const h = info.height;
    crushWeakAlpha(data, w, h, 26);
    zeroRgbWhereFullyTransparent(data, w, h);
    let opaque = 0;
    for (let i = 0; i < w * h; i++) {
      if (data[i * 4 + 3] > 0) opaque++;
    }
    const area = w * h;
    if (maybeRollbackLowForeground(basename, opaque, area, backup, absPath)) {
      return { w, h, opaque: -2, rolledBack: true };
    }
    await sharp(data, {
      raw: { width: w, height: h, channels: 4 },
    })
      .png({ compressionLevel: 9 })
      .toFile(absPath);
    return { w, h, opaque };
  } finally {
    try {
      fs.unlinkSync(tmpOut);
    } catch {
      /* ignore */
    }
  }
}

async function removeBackground(absPath, basename, options = {}) {
  if (SKIP_BG_REMOVAL.has(basename)) {
    const meta = await sharp(absPath).metadata();
    return {
      w: meta.width ?? 0,
      h: meta.height ?? 0,
      opaque: -1,
      skipped: true,
    };
  }

  const backup = fs.readFileSync(absPath);

  const { data: raw, info } = await sharp(absPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const data = Buffer.from(raw);
  const w = info.width;
  const h = info.height;

  let initialOpaque = 0;
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] > 16) initialOpaque++;
  }
  const areaPx = w * h;
  if (initialOpaque < Math.max(380, Math.floor(areaPx * 0.04))) {
    console.warn(
      `warn ${basename}: очень мало непрозрачных пикселей (${initialOpaque}/${areaPx}) — если знак «обрезан», замените файл полноразмерным PNG из источника.`,
    );
  }
  if (
    (basename === "kust" || basename === "yama") &&
    initialOpaque < Math.min(800, Math.floor(w * h * 0.03))
  ) {
    console.warn(
      `skip ${basename}: слишком мало непрозрачных пикселей (${initialOpaque}) — похоже на повреждённый файл; замените PNG оригиналом и запустите скрипт снова.`,
    );
    return { w, h, opaque: initialOpaque, skippedDamage: true };
  }

  if (options.useRembg) {
    return removeBackgroundWithRembg(absPath, basename, backup);
  }

  let visited;

  if (basename === "home") {
    for (let i = 0; i < w * h; i++) {
      data[i * 4 + 3] = 255;
    }
    const adjTol = TOL_BY_BASENAME.home ?? 40;
    visited = floodMarkBackground(data, w, h, adjTol, () => false, grassLikeHome, grassLikeHome);
    visited = maybeVisitedBlackLetterboxFallback(data, w, h, visited);
  } else if (basename === "dom") {
    for (let i = 0; i < w * h; i++) {
      data[i * 4 + 3] = 255;
    }
    const adjTol = TOL_BY_BASENAME.dom ?? 50;
    visited = floodMarkBackground(data, w, h, adjTol, () => false, grassLikeDom, grassLikeDom);
    visited = maybeVisitedBlackLetterboxFallback(data, w, h, visited);
    for (let i = 0; i < w * h; i++) {
      if (visited[i]) data[i * 4 + 3] = 0;
    }
    crushWeakAlpha(data, w, h, 26);
    keepLargestOpaqueIsland(data, w, h, 16);
    zeroRgbWhereFullyTransparent(data, w, h);
  } else if (basename === "yama") {
    /** Яма часто на сером асфальте — «газонная» маска и чистый edge-flood режут яму; оставляем крупнейший остров. */
    for (let i = 0; i < w * h; i++) {
      data[i * 4 + 3] = 255;
    }
    const adjTol = TOL_BY_BASENAME.yama ?? 24;
    visited = floodMarkBackground(data, w, h, adjTol, yamaProtectDarkInterior, yamaEdgeSeedOk, null);
    visited = maybeVisitedBlackLetterboxFallback(data, w, h, visited);
    for (let i = 0; i < w * h; i++) {
      if (visited[i]) data[i * 4 + 3] = 0;
    }
    crushWeakAlpha(data, w, h, 22);
    keepLargestOpaqueIsland(data, w, h, 18);
    zeroRgbWhereFullyTransparent(data, w, h);
  } else if (basename === "kust") {
    for (let i = 0; i < w * h; i++) {
      data[i * 4 + 3] = 255;
    }
    const grassTol = 52;
    visited = floodMarkBackground(data, w, h, grassTol, () => false, openFieldGrass, openFieldGrass);
    visited = maybeVisitedBlackLetterboxFallback(data, w, h, visited);
    let grassMarked = 0;
    for (let i = 0; i < w * h; i++) {
      if (visited[i]) grassMarked++;
    }
    for (let i = 0; i < w * h; i++) {
      if (visited[i]) data[i * 4 + 3] = 0;
    }
    /** Если газон по краю не совпал с маской (например яма на асфальте), пробуем обычный flood без острова. */
    if (grassMarked < areaPx * 0.055) {
      const reload = await sharp(backup).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      data.set(reload.data);
      for (let i = 0; i < w * h; i++) {
        data[i * 4 + 3] = 255;
      }
      visited = floodMarkBackground(data, w, h, 30, () => false, null, null);
      visited = maybeVisitedBlackLetterboxFallback(data, w, h, visited);
      for (let i = 0; i < w * h; i++) {
        if (visited[i]) data[i * 4 + 3] = 0;
      }
    }
    crushWeakAlpha(data, w, h, 28);
    zeroRgbWhereFullyTransparent(data, w, h);
  } else if (PODZEM_BASES.has(basename)) {
    visited = new Uint8Array(w * h);
    const podzemSalvage = applyPodzemStairsPreserveGray(data, w, h);
    crushWeakAlpha(data, w, h, 14);
    if (!podzemSalvage) {
      keepLargestOpaqueIsland(data, w, h, 12);
    }
    zeroRgbWhereFullyTransparent(data, w, h);
  } else if (ROAD_SIGN_BASES.has(basename)) {
    const adjTol = TOL_BY_BASENAME[basename] ?? 48;
    visited = floodMarkBackground(data, w, h, adjTol, roadSignPanelTraverseBlock, null, null);
    visited = maybeVisitedBlackLetterboxFallback(data, w, h, visited);
    const anchors = collectRoadSignAnchors(data, w, h);
    for (let i = 0; i < w * h; i++) {
      if (visited[i]) data[i * 4 + 3] = 0;
    }
    restoreNearBrightPixels(data, w, h, visited, anchors, 54, 1.0, roadSignGreyHoleRestore);
    stripRoadSignMatcherTouchingTransparent(data, w, h, roadSignAsphaltGrain, 5, true);
    stripRoadSignMatcherTouchingTransparent(data, w, h, roadSignAsphaltGrainWide, 5, true);
    /** Серые точки на фоне: ≥2 пустых/краевых соседа из 8 (чтобы реже задевать тонкий столб по диагонали). */
    stripRoadSignMatcherTouchingTransparent(data, w, h, roadSignResidualGraySpeck, 12, true, 2);
    /** Светлые/белые точки на чёрном фоне. */
    stripRoadSignMatcherTouchingTransparent(data, w, h, roadSignBrightBgSpeck, 8, true, 1);
    stripRoadSignMatcherTouchingTransparent(data, w, h, roadSignGreenScreenFringe, 14, true, 1);
    stripRoadSignGreenFringeErode(data, w, h, 14);
    for (let rep = 0; rep < 3; rep++) {
      pruneRoadSignTinyNoiseComponents(data, w, h, 15, 22);
    }
    obliterateRoadSignGreenScreenFringe(data, w, h);
    crushWeakAlpha(data, w, h, 32);
    zeroRgbWhereFullyTransparent(data, w, h);
  } else if (basename === "naklon") {
    const adjTol = TOL_BY_BASENAME.naklon ?? 34;
    visited = floodMarkBackground(data, w, h, adjTol, signBrightMetal, null, null);
    visited = maybeVisitedBlackLetterboxFallback(data, w, h, visited);
    const bright = collectBrightCoords(data, w, h);
    for (let i = 0; i < w * h; i++) {
      if (visited[i]) data[i * 4 + 3] = 0;
    }
    restoreNearBrightPixels(data, w, h, visited, bright, 6, 0.28, naklonPoleRestoreRGB);
    crushWeakAlpha(data, w, h, 28);
    keepLargestOpaqueIsland(data, w, h, 20);
    zeroRgbWhereFullyTransparent(data, w, h);
  } else if (basename === "no_playground") {
    const adjTol = TOL_BY_BASENAME.no_playground ?? 38;
    visited = floodMarkBackground(data, w, h, adjTol, signBrightMetal, null, null);
    visited = maybeVisitedBlackLetterboxFallback(data, w, h, visited);
    const bright = collectBrightCoords(data, w, h);
    for (let i = 0; i < w * h; i++) {
      if (visited[i]) data[i * 4 + 3] = 0;
    }
    restoreNearBrightPixels(data, w, h, visited, bright, 22, 0.52, noPlaygroundPoleRestoreRGB);
  } else {
    const adjTol = TOL_BY_BASENAME[basename] ?? DEFAULT_GENERIC_TOL;
    visited = floodMarkBackground(data, w, h, adjTol, () => false, null, null);
    visited = maybeVisitedBlackLetterboxFallback(data, w, h, visited);
    for (let i = 0; i < w * h; i++) {
      if (visited[i]) data[i * 4 + 3] = 0;
    }
    crushWeakAlpha(data, w, h, 28);
    keepLargestOpaqueIsland(data, w, h, 20);
    zeroRgbWhereFullyTransparent(data, w, h);
  }

  if (basename === "home") {
    for (let i = 0; i < w * h; i++) {
      if (visited[i]) data[i * 4 + 3] = 0;
    }
  }

  let opaque = 0;
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] > 0) opaque++;
  }

  const area = w * h;

  if (maybeRollbackLowForeground(basename, opaque, area, backup, absPath)) {
    return { w, h, opaque: -2, rolledBack: true };
  }

  await sharp(data, {
    raw: { width: w, height: h, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toFile(absPath);

  return { w, h, opaque };
}

const argv = process.argv.slice(2);
const useAll = argv.includes("--all");
const useRembg = argv.includes("--rembg");
const pathsArg = argv.filter((a) => !a.startsWith("-"));

let rels;
if (useAll) {
  const dirAbs = path.join(webRoot, SPRITES_DIR_REL);
  rels = fs
    .readdirSync(dirAbs)
    .filter((f) => f.toLowerCase().endsWith(".png"))
    .filter((f) => !SKIP_BG_REMOVAL.has(path.basename(f, ".png")))
    .sort()
    .map((f) => path.join(SPRITES_DIR_REL, f));
} else {
  rels = pathsArg.length ? pathsArg : DEFAULT_RELS;
}

console.log("remove-mission2-sprite-background");
for (const rel of rels) {
  const abs = path.isAbsolute(rel) ? rel : path.join(webRoot, rel);
  const basename = path.basename(abs, ".png");
  if (SKIP_BG_REMOVAL.has(basename)) {
    console.log(`skip ${rel} (keep embedded background)`);
    continue;
  }
  const tag =
    basename === "home"
      ? " grassMask"
      : basename === "dom"
        ? " grassDom"
        : basename === "naklon" || basename === "no_playground"
          ? " sign-post"
          : PODZEM_BASES.has(basename)
            ? " podzem-strokes"
            : ROAD_SIGN_BASES.has(basename)
              ? " road-sign"
              : " generic";
  const tagSuffix = useRembg ? " rembg" : "";
  const out = await removeBackground(abs, basename, { useRembg });
  let opaqueStr = String(out.opaque);
  if (out.skipped) opaqueStr = "skipped";
  else if (out.skippedDamage) opaqueStr = "skipped-damaged";
  else if (out.rolledBack) opaqueStr = "rolled-back";
  console.log(`ok ${rel}${tag}${tagSuffix} opaque_pixels=${opaqueStr} size=${out.w}×${out.h}`);
}
