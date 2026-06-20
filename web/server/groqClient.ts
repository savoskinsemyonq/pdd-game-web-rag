import { Groq, RateLimitError } from "groq-sdk";
import { formatNetworkLlmError, isNetworkLlmError, llmTimeoutMs } from "./llmConfig.js";

export const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";
const GROQ_MODEL_FALLBACK =
  process.env.GROQ_MODEL_FALLBACK ?? "llama-3.1-8b-instant";

export function groqMaxTokens(profile: "chat" | "analyze"): number {
  if (profile === "chat") {
    return Number(process.env.GROQ_CHAT_MAX_TOKENS ?? 1024);
  }
  return Number(process.env.GROQ_ANALYZE_MAX_TOKENS ?? 768);
}

function groqModelsToTry(): string[] {
  const models = [GROQ_MODEL];
  if (!models.includes(GROQ_MODEL_FALLBACK)) {
    models.push(GROQ_MODEL_FALLBACK);
  }
  return models;
}

export function formatGroqError(err: unknown): string {
  if (isNetworkLlmError(err)) return formatNetworkLlmError();
  if (err instanceof RateLimitError) {
    const raw = err.message;
    const retryMatch = raw.match(/try again in (\d+m[\d.]+s)/i);
    if (retryMatch) {
      const [, rawTime] = retryMatch;
      const minMatch = rawTime.match(/^(\d+)m([\d.]+)s$/);
      if (minMatch) {
        const mins = minMatch[1];
        const secs = Math.ceil(Number(minMatch[2]));
        return `Лимит запросов к AI исчерпан. Попробуй снова через ${mins} мин ${secs} сек.`;
      }
      return `Лимит запросов к AI исчерпан. Попробуй снова через ${rawTime}.`;
    }
    return "Лимит запросов к AI исчерпан. Попробуй позже.";
  }

  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("429") || message.includes("rate_limit")) {
    return "Лимит запросов к AI исчерпан. Попробуй позже.";
  }
  if (message.includes("401") || message.includes("invalid_api_key")) {
    return "Ошибка авторизации AI-сервиса на сервере.";
  }
  return "Не удалось получить ответ от AI. Попробуй позже.";
}

function shouldTryGroqFallback(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (lower.includes("401") || lower.includes("invalid_api_key")) {
    return false;
  }
  return true;
}

function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateGroqUsage(
  messages: Groq.Chat.ChatCompletionMessageParam[],
  outputText: string,
): import("./llmUsageLog.js").LlmUsage {
  const promptText = messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
  const promptTokens = estimateTokensFromText(promptText);
  const completionTokens = estimateTokensFromText(outputText);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

export async function* streamGroqChat(options: {
  messages: Groq.Chat.ChatCompletionMessageParam[];
  maxCompletionTokens?: number;
  temperature?: number;
}): AsyncGenerator<string, { model: string; usage: import("./llmUsageLog.js").LlmUsage }> {
  const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY!,
    timeout: llmTimeoutMs(),
    maxRetries: Number(process.env.GROQ_MAX_RETRIES ?? 1),
  });
  const models = groqModelsToTry();
  let lastError: unknown;
  const maxTokens = options.maxCompletionTokens ?? groqMaxTokens("chat");

  for (let i = 0; i < models.length; i++) {
    const model = models[i]!;
    try {
      const stream = await groq.chat.completions.create({
        model,
        messages: options.messages,
        stream: true,
        max_completion_tokens: maxTokens,
        temperature: options.temperature ?? 0.7,
      });
      if (i > 0) {
        console.warn(`[Groq] fallback model: ${model}`);
      }

      let outputText = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) {
          outputText += delta;
          yield delta;
        }
      }
      return { model, usage: estimateGroqUsage(options.messages, outputText) };
    } catch (err) {
      lastError = err;
      if (i < models.length - 1 && shouldTryGroqFallback(err)) {
        console.warn(`[Groq] ${model} failed, trying ${models[i + 1]}`);
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error("Groq request failed");
}

export async function createGroqChatStream(options: {
  messages: Groq.Chat.ChatCompletionMessageParam[];
  maxCompletionTokens?: number;
  temperature?: number;
}) {
  const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY!,
    timeout: llmTimeoutMs(),
    maxRetries: Number(process.env.GROQ_MAX_RETRIES ?? 1),
  });
  const models = groqModelsToTry();
  let lastError: unknown;
  const maxTokens = options.maxCompletionTokens ?? groqMaxTokens("chat");

  for (let i = 0; i < models.length; i++) {
    try {
      const stream = await groq.chat.completions.create({
        model: models[i]!,
        messages: options.messages,
        stream: true,
        max_completion_tokens: maxTokens,
        temperature: options.temperature ?? 0.7,
      });
      if (i > 0) {
        console.warn(`[Groq] fallback model: ${models[i]}`);
      }
      return stream;
    } catch (err) {
      lastError = err;
      if (i < models.length - 1 && shouldTryGroqFallback(err)) {
        console.warn(`[Groq] ${models[i]} failed, trying ${models[i + 1]}`);
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error("Groq request failed");
}
