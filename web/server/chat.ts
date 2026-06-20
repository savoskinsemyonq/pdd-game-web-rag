import type { Request, Response } from "express";
import { buildPddContext } from "./ragContext.js";
import {
  createChatStream,
  formatLlmError,
  hasLlmConfigured,
  llmMaxTokens,
  type LlmMessage,
} from "./llmClient.js";
import { stripMarkdownFormatting } from "./textFormat.js";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequestBody {
  messages: ChatMessage[];
  errorContext?: string;
  sceneId?: string;
  nodeId?: string;
  mode?: "error" | "analysis";
}

function buildSystemPrompt(
  errorContext: string,
  ragContext: string,
  mode: "error" | "analysis",
): string {
  const base =
    mode === "analysis"
      ? `Ты — инспектор ГИБДД, наставник кружка ПДД. Аудитория: школьники 10–17 лет.

Твоя зона ответственности — только образовательная деятельность кружка ПДД:
- правила дорожного движения и дорожные ситуации;
- ошибки ученика из контекста анализа и как действовать правильно;
- как лучше изучать и повторять ПДД (план, порядок тем, советы по запоминанию);
- безопасность на дороге и подготовка к экзамену по ПДД.

Правила ответа:
- Отвечай понятно и по делу, без лишней воды.
- Пиши обычным текстом: без markdown, без **, *, #, __ и других знаков форматирования.
- Если в контексте указано «Имя ученика: …» — обращайся по этому имени точно так, как написано, не переводи и не меняй.
- Если спрашивают про несколько пунктов — объясни каждый кратко.
- Сначала суть: что не так и как правильно (или как лучше учить тему).
- Указывай пункты ПДД из контекста, без выдумок.
- Не повторяй вопрос ученика.
- На вопросы вне ПДД и обучения в кружке (другие предметы, игры, личные темы, политика, программирование и т.п.) — вежливо откажи одним предложением и предложи задать вопрос по ПДД или по ошибкам из анализа.`
      : `Ты — инспектор ГИБДД. Аудитория: школьники 10–17 лет.
Правила ответа (строго):
- Пиши КОРОТКО: 2–4 предложения на первый ответ, 1–2 на уточняющие.
- Пиши обычным текстом: без markdown, без **, *, #, __ и других знаков форматирования.
- Структура: что не так → как правильно → один пункт ПДД из контекста.
- Без длинных списков, без повторения контекста ошибки.
- Не запугивай — акцент на безопасности.
- На вопросы не по ПДД — вежливо откажи одним предложением.
- Объясняй только ситуацию из блока «Контекст ошибки» (та же сцена и тот же вопрос). Не подменяй её другой сценой или перекрёстком с двумя легковыми автомобилями, если в контексте речь о тракторе или другой ситуации.`;

  return `${base}

Контекст ошибки / анализа ученика:
${errorContext || "Ученик допустил ошибку в задании по ПДД."}

Пункты ПДД для справки (используй только их, не выдумывай):
${ragContext || "Справка недоступна."}

Отвечай по-русски, живо и понятно для школьника.`;
}

async function buildRagContext(ragQuery: string, errorContext: string): Promise<string> {
  const { context } = await buildPddContext(ragQuery, errorContext, 4, "chat");
  return context;
}

async function streamLlmReply(
  res: Response,
  systemPrompt: string,
  conversationMessages: LlmMessage[],
): Promise<void> {
  const stream = createChatStream({
    messages: [{ role: "system", content: systemPrompt }, ...conversationMessages],
    maxCompletionTokens: llmMaxTokens("chat"),
    temperature: 0.7,
    profile: "chat",
  });
  for await (const delta of stream) {
    const clean = stripMarkdownFormatting(delta);
    if (clean) res.write(`data: ${JSON.stringify({ delta: clean })}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

export async function handleChat(req: Request, res: Response): Promise<void> {
  const {
    messages = [],
    errorContext = "",
    sceneId = "",
    nodeId = "",
    mode = "error",
  } = req.body as ChatRequestBody;

  if (!hasLlmConfigured()) {
    res.status(500).json({ error: "AI не настроен: нужен GEMINI_API_KEY, GROQ_API_KEY или MISTRAL_API_KEY" });
    return;
  }

  const sceneLabel = [sceneId && `сцена ${sceneId}`, nodeId && `узел ${nodeId}`]
    .filter(Boolean)
    .join(", ");

  const lastUserMessage =
    [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  const isFirstMessage = messages.length === 0;
  const userQuery = isFirstMessage
    ? mode === "error"
      ? `Кратко объясни мою ошибку и правильные действия: ${errorContext}`
      : `Объясни мою ошибку и расскажи, как правильно действовать в этой ситуации: ${errorContext}`
    : lastUserMessage;

  const ragQuery = [sceneLabel, errorContext, lastUserMessage].filter(Boolean).join(" ").trim();

  if (sceneLabel) {
    console.log(`[PDD context] chat: ${sceneLabel}`);
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const ragContext = await buildRagContext(ragQuery, errorContext);
  const systemPrompt = buildSystemPrompt(errorContext, ragContext, mode);
  const conversationMessages: LlmMessage[] = isFirstMessage
    ? [{ role: "user", content: userQuery }]
    : messages.map((m) => ({ role: m.role, content: m.content }));

  try {
    await streamLlmReply(res, systemPrompt, conversationMessages);
  } catch (err: unknown) {
    const message = formatLlmError(err);
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    } else {
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    }
  }
}
