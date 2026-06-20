import missionsData from "../data/missions.json";

export interface ErrorPriorityInput {
  sceneId?: string;
  missionId?: string;
  missionTitle?: string;
  errorInfo: string;
  count: number;
  wasFixed: boolean;
  priority: "high" | "medium" | "low";
}

export interface ReviewScene {
  sceneId: string;
  missionId: string;
  missionTitle: string;
}

export interface ReviewGroup {
  topicKey: string;
  title: string;
  ruleRef: string;
  errorCount: number;
  recommendedRuns: number;
  missions: { id: string; title: string }[];
  scenes: ReviewScene[];
  action: string;
}

export interface ReviewSceneItem {
  sceneId: string;
  title: string;
  ruleRef: string;
  errorCount: number;
}

export interface ReviewMissionPlan {
  missionId: string;
  missionTitle: string;
  totalErrors: number;
  scenes: ReviewSceneItem[];
}

export interface ErrorTopicSummary {
  key: string;
  title: string;
  ruleRef: string;
  count: number;
}

interface ErrorBucketInput {
  errorInfo: string;
  sceneId?: string;
  missionId?: string;
  missionTitle?: string;
  count?: number;
}

interface ErrorBucket {
  key: string;
  displayRef: string;
  errorCount: number;
  sampleError: string;
  sampleMissionId?: string;
  sampleSceneId?: string;
  scenes: Map<string, ReviewScene>;
}

const PENALTY_TAIL = /(Предупреждение или штраф|Предупреждение|Штраф|Лишение права управления|Лишение прав).*$/is;

const PDD_PAREN_RE = /\(п\.?\s*(\d+(?:\(\d+\))?(?:\.\d+)?)\)/gi;
const PDD_PLAIN_RE = /(?:^|[\s,(])п\.?\s*(\d+(?:\(\d+\))?(?:\.\d+)?)\b/gi;
const APPENDIX_RE = /(?:^|[\s,(])Приложение\s+(\d+)\b/gi;

const GENERIC_QUESTION_RE =
  /^(?:как (?:следует )?поступить|как вы поступите|должны ли вы|можно ли|разрешено ли|где вы|что означает)/i;

/** Короткие названия тем по пунктам ПДД */
const RULE_LABELS: Record<string, string> = {
  "3.2": "Спецсигналы и уступание",
  "3.4": "Дорожные знаки",
  "6.2": "Красный сигнал светофора",
  "8.3": "Выезд с прилегающей",
  "8.5": "Полоса перед поворотом",
  "8.9": "Уступить справа",
  "8.11": "Разворот на переходе",
  "8.12": "Движение задним ходом",
  "10.2": "Скорость в населённом пункте",
  "10.3": "Скорость вне населённого пункта",
  "11.4": "Обгон без видимости",
  "12.2": "Остановка по табличкам",
  "12.4": "Остановка у перехода",
  "13.8": "Уступить при повороте",
  "13.9": "Выезд на главную",
  "13.11": "Помеха справа",
  "13.11(1)": "Круговое движение",
  "13.12": "Поворот налево",
  "14.1": "Пешеходный переход",
  "15.3": "Ж/д переезд",
  "16.1": "Движение по магистрали",
  "18.1": "Приоритет трамвая",
  "18.3": "Уступить автобусу",
  "app:1": "Дорожные знаки",
  "app:2": "Дорожная разметка",
};

const CYR = "[а-яё]+";

const ERROR_TITLE_HEURISTICS: Array<{ pattern: RegExp; title: string }> = [
  { pattern: new RegExp(`проблесков${CYR}|спецсигнал`, "i"), title: "Спецсигналы и уступание" },
  { pattern: new RegExp(`минимальн${CYR}\\s+скорост`, "i"), title: "Минимальная скорость" },
  { pattern: new RegExp(`вне\\s+насел[её]нн${CYR}\\s+пункт`, "i"), title: "Скорость вне населённого пункта" },
  { pattern: /не\s+более\s+\d+\s*км\/ч/i, title: "Ограничение скорости" },
  { pattern: new RegExp(`разметк|обгон\\s+запрещ`, "i"), title: "Дорожная разметка" },
  { pattern: new RegExp(`кругов${CYR}\\s+движен`, "i"), title: "Круговое движение" },
  { pattern: new RegExp(`шлагбаум|ж\\/\\s*д|железнодорожн`, "i"), title: "Ж/д переезд" },
  { pattern: new RegExp(`главн${CYR}\\s+дорог|выезжаете\\s+на\\s+главн`, "i"), title: "Выезд на главную" },
  { pattern: new RegExp(`уступить\\s+дорог`, "i"), title: "Уступление дороги" },
];

const VAGUE_ERROR_PREFIX_RE =
  new RegExp(`^(?:этот\\s+знак|вне\\s+насел[её]нн${CYR}\\s+пункт${CYR}\\s+разрешено|автомобиль\\s+с\\s+включенным)`, "i");

const QUESTION_SHORTCUTS: Array<{ pattern: RegExp; title: string }> = [
  {
    pattern: new RegExp(`скорост${CYR}.*после\\s+знак`, "i"),
    title: "Скорость после знака",
  },
  {
    pattern: new RegExp(`скорост${CYR}.*двига`, "i"),
    title: "Выбор скорости",
  },
  {
    pattern: /^с какой скорост/i,
    title: "Выбор скорости",
  },
  {
    pattern: new RegExp(`обогнать\\s+грузовик`, "i"),
    title: "Обгон грузовика",
  },
  {
    pattern: new RegExp(`кругов${CYR}\\s+движен`, "i"),
    title: "Круговое движение",
  },
  {
    pattern: new RegExp(`перекр[её]ст`, "i"),
    title: "Перекрёсток",
  },
];

let sceneQuestionIndex: Map<string, string> | null = null;

function getSceneQuestionIndex(): Map<string, string> {
  if (sceneQuestionIndex) return sceneQuestionIndex;
  sceneQuestionIndex = new Map();
  for (const mission of missionsData.missions) {
    for (const node of mission.nodes) {
      for (const variant of node.variants ?? []) {
        if (!variant.sceneId || !variant.questionTitle) continue;
        sceneQuestionIndex.set(`${mission.id}:${variant.sceneId}`, variant.questionTitle.trim());
      }
    }
  }
  return sceneQuestionIndex;
}

export function lookupQuestionTitle(missionId?: string, sceneId?: string): string | undefined {
  if (!missionId || !sceneId) return undefined;
  return getSceneQuestionIndex().get(`${missionId}:${sceneId}`);
}

function stripPenalty(text: string): string {
  let t = text.replace(PENALTY_TAIL, "").trim();
  t = t.replace(/\([^)]*12\.[^)]*\)\.?\s*$/i, "").trim();
  return t.replace(/\.\s*$/, "").trim();
}

function isValidPddParagraphKey(key: string): boolean {
  if (key.startsWith("app:")) {
    const n = Number.parseInt(key.slice(4), 10);
    return n >= 1 && n <= 9;
  }
  const m = key.match(/^(\d+)(?:\.(\d+))?(?:\((\d+)\))?$/);
  if (!m) return false;
  const chapter = Number.parseInt(m[1]!, 10);
  return chapter >= 1 && chapter <= 26;
}

function truncateToWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, maxWords).join(" ");
}

/** Первый валидный пункт ПДД из текста ошибки (0 или 1 элемент). */
export function extractPddRefs(text: string): string[] {
  const body = stripPenalty(text);
  const candidates: Array<{ key: string; display: string }> = [];

  for (const m of body.matchAll(PDD_PAREN_RE)) {
    const key = m[1]!;
    candidates.push({ key, display: `п. ${key}` });
  }
  for (const m of body.matchAll(PDD_PLAIN_RE)) {
    const key = m[1]!;
    candidates.push({ key, display: `п. ${key}` });
  }
  for (const m of body.matchAll(APPENDIX_RE)) {
    const n = m[1]!;
    candidates.push({ key: `app:${n}`, display: `Приложение ${n}` });
  }

  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c.key) || !isValidPddParagraphKey(c.key)) continue;
    seen.add(c.key);
    return [c.display];
  }
  return [];
}

function ruleKeyFromDisplay(displayRef: string): string {
  const app = displayRef.match(/Приложение\s+(\d+)/i);
  if (app) return `app:${app[1]}`;
  const p = displayRef.match(/(\d+(?:\(\d+\))?(?:\.\d+)?)/);
  return p ? p[1]! : displayRef;
}

function normalizedErrorBody(errorInfo: string): string {
  let body = stripPenalty(errorInfo);
  body = body.replace(/\((?:п\.?\s*)?[\d().]+\)\.?\s*$/i, "").trim();
  body = body.replace(/\(Приложение\s+\d+\)\.?\s*$/i, "").trim();
  return body;
}

export function inferTitleFromErrorBody(errorInfo: string): string | null {
  const body = normalizedErrorBody(errorInfo);
  if (!body) return null;

  for (const { pattern, title } of ERROR_TITLE_HEURISTICS) {
    if (pattern.test(body)) return title;
  }
  return null;
}

export function isGenericQuestionTitle(title: string): boolean {
  const trimmed = title.trim().replace(/\?+$/, "").trim();
  return GENERIC_QUESTION_RE.test(trimmed);
}

export function shortenQuestionTitle(title: string): string | null {
  const trimmed = title.trim().replace(/\?+$/, "").replace(/\s+/g, " ").trim();
  if (!trimmed || isGenericQuestionTitle(trimmed)) return null;

  for (const { pattern, title: shortcut } of QUESTION_SHORTCUTS) {
    if (pattern.test(trimmed)) return shortcut;
  }

  return truncateToWords(trimmed, 5);
}

function errorGroupKey(
  errorInfo: string,
  sceneId?: string,
): { key: string; displayRef: string } {
  const refs = extractPddRefs(errorInfo);
  if (refs.length > 0) {
    const displayRef = refs[0]!;
    return { key: ruleKeyFromDisplay(displayRef), displayRef };
  }

  const normalized = normalizedErrorBody(errorInfo);
  if (normalized.length >= 4) {
    const textKey = normalized.toLowerCase().replace(/\s+/g, " ");
    return { key: `text:${textKey}`, displayRef: "ПДД" };
  }

  const sid = sceneId ?? "?";
  return { key: `scene:${sid}`, displayRef: "ПДД" };
}

function fallbackFromErrorBody(sampleError: string): string | null {
  const body = normalizedErrorBody(sampleError);
  if (body.length < 4 || VAGUE_ERROR_PREFIX_RE.test(body)) return null;
  return truncateToWords(body, 4);
}

export function resolveTopicTitle(options: {
  ruleKey: string;
  displayRef: string;
  sampleError: string;
  missionId?: string;
  sceneId?: string;
}): string {
  const { ruleKey, displayRef, sampleError, missionId, sceneId } = options;

  if (RULE_LABELS[ruleKey]) return RULE_LABELS[ruleKey]!;

  const inferred = inferTitleFromErrorBody(sampleError);
  if (inferred) return inferred;

  const questionTitle = lookupQuestionTitle(missionId, sceneId);
  if (questionTitle) {
    const shortened = shortenQuestionTitle(questionTitle);
    if (shortened) return shortened;
  }

  const fromError = fallbackFromErrorBody(sampleError);
  if (fromError) return fromError;

  if (displayRef && displayRef !== "ПДД") {
    return truncateToWords(displayRef.replace(/^п\.\s*/, "п. "), 4);
  }

  return "Повторить сцену";
}

function titleForBucket(
  key: string,
  displayRef: string,
  sampleError: string,
  missionId?: string,
  sceneId?: string,
): string {
  return resolveTopicTitle({
    ruleKey: key,
    displayRef,
    sampleError,
    missionId,
    sceneId,
  });
}

function collectErrorBuckets(items: ErrorBucketInput[]): Map<string, ErrorBucket> {
  const buckets = new Map<string, ErrorBucket>();

  for (const item of items) {
    if (!item.errorInfo) continue;

    const { key, displayRef } = errorGroupKey(item.errorInfo, item.sceneId);
    const increment = item.count ?? 1;
    const scene: ReviewScene | null =
      item.sceneId && item.missionTitle
        ? {
            sceneId: item.sceneId,
            missionId: item.missionId ?? "",
            missionTitle: item.missionTitle,
          }
        : null;

    const bucket = buckets.get(key) ?? {
      key,
      displayRef,
      errorCount: 0,
      sampleError: item.errorInfo,
      sampleMissionId: item.missionId,
      sampleSceneId: item.sceneId,
      scenes: new Map(),
    };
    bucket.errorCount += increment;
    if (scene) bucket.scenes.set(`${scene.missionId}:${scene.sceneId}`, scene);
    buckets.set(key, bucket);
  }

  return buckets;
}

export function summarizeErrorTopics(
  items: Array<{ errorInfo: string; sceneId?: string; missionId?: string; count?: number }>,
): ErrorTopicSummary[] {
  const buckets = collectErrorBuckets(items);

  return [...buckets.values()]
    .map((bucket) => ({
      key: bucket.key,
      title: titleForBucket(
        bucket.key,
        bucket.displayRef,
        bucket.sampleError,
        bucket.sampleMissionId,
        bucket.sampleSceneId,
      ),
      ruleRef: bucket.displayRef,
      count: bucket.errorCount,
    }))
    .sort((a, b) => b.count - a.count);
}

function formatSource(scenes: ReviewScene[]): string {
  if (scenes.length === 0) return "источник не указан";
  if (scenes.length === 1) {
    const s = scenes[0]!;
    return `${s.missionTitle} · сцена ${s.sceneId}`;
  }
  return scenes.map((s) => `${s.missionTitle}, сц. ${s.sceneId}`).join("; ");
}

export function buildReviewPlan(
  errors: ErrorPriorityInput[],
  _ruleRefs: string[] = [],
): ReviewGroup[] {
  const buckets = collectErrorBuckets(
    errors
      .filter((err) => !err.wasFixed)
      .map((err) => ({
        errorInfo: err.errorInfo,
        sceneId: err.sceneId,
        missionId: err.missionId,
        missionTitle: err.missionTitle,
        count: err.count,
      })),
  );

  const result: ReviewGroup[] = [];

  for (const bucket of buckets.values()) {
    const scenes = [...bucket.scenes.values()];
    const missions = [
      ...new Map(
        scenes.map((s) => [s.missionId || s.missionTitle, { id: s.missionId, title: s.missionTitle }]),
      ).values(),
    ];

    result.push({
      topicKey: `rule:${bucket.key}`,
      title: titleForBucket(
        bucket.key,
        bucket.displayRef,
        bucket.sampleError,
        bucket.sampleMissionId,
        bucket.sampleSceneId,
      ),
      ruleRef: bucket.displayRef,
      errorCount: bucket.errorCount,
      recommendedRuns: 1,
      missions,
      scenes,
      action: formatSource(scenes),
    });
  }

  result.sort((a, b) => b.errorCount - a.errorCount);
  return result.slice(0, 12);
}

function pluralErrors(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ошибка`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} ошибки`;
  return `${n} ошибок`;
}

/** План повторения: сначала миссии с наибольшим числом ошибок, внутри — сцены по убыванию. */
export function buildMissionReviewPlan(errors: ErrorPriorityInput[]): ReviewMissionPlan[] {
  const byMission = new Map<string, ReviewMissionPlan>();

  for (const err of errors.filter((e) => !e.wasFixed)) {
    const missionId = err.missionId ?? "unknown";
    const missionTitle = err.missionTitle?.trim() || "Миссия без названия";
    const { key, displayRef } = errorGroupKey(err.errorInfo, err.sceneId);
    const sceneItem: ReviewSceneItem = {
      sceneId: err.sceneId ?? "?",
      title: titleForBucket(key, displayRef, err.errorInfo, missionId, err.sceneId),
      ruleRef: displayRef,
      errorCount: err.count,
    };

    const mission =
      byMission.get(missionId) ??
      ({
        missionId,
        missionTitle,
        totalErrors: 0,
        scenes: [],
      } satisfies ReviewMissionPlan);

    mission.totalErrors += err.count;
    mission.scenes.push(sceneItem);
    byMission.set(missionId, mission);
  }

  const plans = [...byMission.values()];
  for (const mission of plans) {
    mission.scenes.sort((a, b) => b.errorCount - a.errorCount);
  }
  plans.sort((a, b) => b.totalErrors - a.totalErrors);
  return plans;
}

export function formatMissionReviewPlanText(plans: ReviewMissionPlan[]): string {
  if (plans.length === 0) return "—";

  return plans
    .map((mission) => {
      const header = `${mission.missionTitle} — ${pluralErrors(mission.totalErrors)}`;
      const lines = mission.scenes.map((scene, index) => {
        const countPart = scene.errorCount > 1 ? ` ×${scene.errorCount}` : "";
        return `${index + 1}. сцена ${scene.sceneId} — ${scene.title} — ${scene.ruleRef}${countPart}`;
      });
      return [header, ...lines].join("\n");
    })
    .join("\n\n");
}

/** Краткое описание слабых мест без перечисления сцен (для секции «Слабые места»). */
export function formatWeakSpotsSummary(plans: ReviewMissionPlan[]): string {
  if (plans.length === 0) {
    return "Серьёзных незакрытых ошибок не осталось.";
  }

  const missionNames = plans
    .slice(0, 3)
    .map((m) => `«${m.missionTitle}» (${pluralErrors(m.totalErrors)})`)
    .join(", ");

  const topicTitles: string[] = [];
  const seen = new Set<string>();
  for (const mission of plans) {
    for (const scene of mission.scenes) {
      const key = scene.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      topicTitles.push(scene.title);
      if (topicTitles.length >= 4) break;
    }
    if (topicTitles.length >= 4) break;
  }

  const missionIntro =
    plans.length === 1
      ? `Основные проблемы в миссии ${missionNames}.`
      : `Больше всего ошибок в миссиях: ${missionNames}.`;

  if (topicTitles.length === 0) {
    return missionIntro;
  }

  const topicList = topicTitles.map((title) => `• ${title}`).join("\n");
  return `${missionIntro}\n\nЧаще всего путаются темы:\n${topicList}`;
}
