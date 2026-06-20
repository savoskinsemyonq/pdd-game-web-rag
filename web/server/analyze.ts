import type { Request, Response } from "express";
import {
  buildMissionReviewPlan,
  extractPddRefs,
  formatMissionReviewPlanText,
  formatWeakSpotsSummary,
} from "../src/utils/reviewPlan.js";
import type { ReviewMissionPlan } from "../src/utils/reviewPlan.js";
import { buildAnalyzeContext } from "./ragContext.js";
import {
  createChatStream,
  formatLlmError,
  getLlmProvider,
  hasLlmConfigured,
  llmMaxTokens,
} from "./llmClient.js";
import { stripMarkdownFormatting } from "./textFormat.js";

interface ErrorPriority {
  sceneId?: string;
  missionId?: string;
  missionTitle?: string;
  errorInfo: string;
  count: number;
  wasFixed: boolean;
  priority: "high" | "medium" | "low";
}

interface AnalyzeRequestBody {
  errors: ErrorPriority[];
  profileName?: string;
}

function formatCompactErrorLine(e: ErrorPriority): string {
  const refs = extractPddRefs(e.errorInfo);
  const refPart = refs.length > 0 ? refs.join(", ") : "ПДД";
  const scenePart = e.sceneId ? `сцена ${e.sceneId}` : "сцена ?";
  const countPart = e.count > 1 ? ` ×${e.count}` : "";
  return `• ${scenePart}${countPart} — ${refPart}`;
}

function formatErrorsForPrompt(errors: ErrorPriority[]): string {
  const unfixed = errors.filter((e) => !e.wasFixed);
  const fixed = errors.filter((e) => e.wasFixed);

  const lines: string[] = [];
  if (unfixed.length > 0) {
    lines.push(`Нужно повторить (${unfixed.length}):`);
    lines.push(...unfixed.slice(0, 12).map(formatCompactErrorLine));
  } else {
    lines.push("Невыправленных ошибок нет.");
  }

  if (fixed.length > 0) {
    const fixedRefs = [
      ...new Set(fixed.flatMap((e) => extractPddRefs(e.errorInfo))),
    ].slice(0, 8);
    lines.push("");
    lines.push(
      `Уже исправлено: ${fixed.length} ${fixedRefs.length > 0 ? `(${fixedRefs.join(", ")})` : ""}`,
    );
  }

  return lines.join("\n");
}

function formatRelatedRefsLine(ruleRefs: string[]): string {
  if (ruleRefs.length === 0) return "—";
  return ruleRefs.slice(0, 12).join(", ");
}

function buildRelatedRefsSection(ruleRefs: string[]): string {
  const line = formatRelatedRefsLine(ruleRefs);
  if (line === "—") {
    return "Абзац про смежные пункты ПДД — пропусти (дополнительных пунктов нет).";
  }
  return (
    `После «План повторения» добавь 1–2 предложения без заголовка: встрой фразу вроде «Для более глубокого понимания материала рекомендую изучить…» ` +
    `и перечисли пункты ${line} через запятую один раз. ` +
    `Это смежные пункты из справочника ПДД — дополнение к плану, а не второй список заданий. ` +
    `Запрещено выносить этот блок в отдельный заголовок и повторять тот же список во втором предложении.`
  );
}

function buildFallbackAnalyzeText(
  studentName: string,
  missionPlan: ReviewMissionPlan[],
  ruleRefs: string[],
  unfixedCount: number,
): string {
  const planLines = formatMissionReviewPlanText(missionPlan);
  const weakSpots = formatWeakSpotsSummary(missionPlan);

  const relatedBlock =
    ruleRefs.length > 0
      ? [
          "",
          `Для более глубокого понимания материала рекомендую изучить ${formatRelatedRefsLine(ruleRefs)}.`,
        ].join("\n")
      : "";

  return [
    `${studentName}, краткий разбор по ${unfixedCount} ошибкам.`,
    "",
    "Слабые места",
    "",
    weakSpots,
    "",
    "План повторения",
    "",
    planLines === "—" ? "Повтори миссии с ошибками." : planLines,
    relatedBlock,
    "",
    "С чего начать",
    "",
    missionPlan.length > 0
      ? `Начни с миссии «${missionPlan[0]!.missionTitle}», сцена ${missionPlan[0]!.scenes[0]?.sceneId ?? "?"}.`
      : "Продолжай тренировки.",
  ].join("\n");
}

export async function handleAnalyze(req: Request, res: Response): Promise<void> {
  const { errors = [], profileName = "Ученик" } = req.body as AnalyzeRequestBody;

  if (!hasLlmConfigured()) {
    res.status(500).json({ error: "AI не настроен: нужен GEMINI_API_KEY, GROQ_API_KEY или MISTRAL_API_KEY" });
    return;
  }

  if (errors.length === 0) {
    res.status(400).json({ error: "Список ошибок пуст" });
    return;
  }

  const errorsSummary = formatErrorsForPrompt(errors);
  const topErrors = errors.filter((e) => e.priority === "high" || e.priority === "medium");

  const { context: pddContext, ruleRefs } = await buildAnalyzeContext(
    topErrors.map((e) => e.errorInfo),
    2,
  );

  const missionPlan = buildMissionReviewPlan(errors);
  const missionPlanText = formatMissionReviewPlanText(missionPlan);
  const weakSpotsText = formatWeakSpotsSummary(missionPlan);
  const relatedRefsSection = buildRelatedRefsSection(ruleRefs);

  const studentName = (profileName ?? "Ученик").trim() || "Ученик";
  const unfixedCount = errors.filter((e) => !e.wasFixed).length;
  const fixedCount = errors.filter((e) => e.wasFixed).length;
  const startHint =
    missionPlan.length > 0
      ? `Начни с миссии «${missionPlan[0]!.missionTitle}», сцена ${missionPlan[0]!.scenes[0]?.sceneId ?? "?"}.`
      : "Продолжай тренировки.";

  const systemPrompt = `Ты — инспектор ГИБДД. Аудитория: школьники 10–17 лет.

Сформируй КРАТКИЙ ответ строго по шаблону ниже. Обычный текст, без markdown.

ФОРМАТ СЕКЦИИ (без нумерации «1)», «2)» и т.п.):
Заголовок секции

Текст секции

Между секциями — пустая строка.

СЕКЦИИ:

Начни ответ сразу с приветствия (1 предложение, обращение по имени «${studentName}»), без заголовка «Приветствие».

Слабые места
Выведи дословно этот текст (можно слегка подстроить вводное предложение под ученика; названия тем в списке «•» не перефразируй и не заменяй; без сцен и без пунктов ПДД):
${weakSpotsText}

${fixedCount > 0 ? "Исправлено\n1 короткое предложение похвалы, без перечисления правил." : "Секцию «Исправлено» — пропусти."}

План повторения
Выведи дословно этот текст (миссии и сцены уже отсортированы, не меняй порядок и формулировки):
${missionPlanText}

${relatedRefsSection}

С чего начать
1 предложение. Подсказка: ${startHint}

ЗАПРЕЩЕНО:
- нумеровать секции как «1)», «2)», «3)» и т.д.;
- дублировать содержание секций «Слабые места» и «План повторения» (в «Слабые места» — только обзор, в «План повторения» — детальный список);
- перечислять сцены или пункты ПДД в секции «Слабые места»;
- выносить смежные пункты ПДД в отдельный заголовок или выдавать их за основной план;
- повторять один и тот же список пунктов ПДД дважды в одной секции;
- пересказывать длинные формулировки ошибок;
- добавлять второй план или списки «что нужно сделать» от себя;
- писать вступления про «сегодня поговорим о ПДД».

Справка ПДД (только для формулировок, не цитируй целиком):
${pddContext || "—"}`;

  const userMessage = `Имя: ${studentName}\nНевыправлено: ${unfixedCount}\n\n${errorsSummary}`;

  try {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    res.write(
      `data: ${JSON.stringify({ meta: { ruleRefs, missionPlan } })}\n\n`,
    );

    const stream = createChatStream({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      maxCompletionTokens: llmMaxTokens("analyze"),
      temperature: 0.4,
      profile: "analyze",
      preferredProvider: getLlmProvider(),
    });

    for await (const delta of stream) {
      if (delta) {
        const clean = stripMarkdownFormatting(delta);
        if (clean) {
          res.write(`data: ${JSON.stringify({ delta: clean })}\n\n`);
        }
      }
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err: unknown) {
    const message = formatLlmError(err);
    if (res.headersSent) {
      console.warn("[analyze] LLM failed, using offline fallback:", message);
      const fallback = buildFallbackAnalyzeText(
        studentName,
        missionPlan,
        ruleRefs,
        unfixedCount,
      );
      res.write(`data: ${JSON.stringify({ delta: fallback })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.status(500).json({ error: message });
  }
}
