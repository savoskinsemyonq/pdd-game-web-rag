import OpenAI from "openai";
import { formatNetworkLlmError, isNetworkLlmError, llmTimeoutMs } from "./llmConfig.js";

export const MISTRAL_MODEL = process.env.MISTRAL_MODEL ?? "mistral-small-2506";
const MISTRAL_MODEL_FALLBACK =
  process.env.MISTRAL_MODEL_FALLBACK ?? "open-mistral-nemo";

export function mistralMaxTokens(profile: "chat" | "analyze"): number {
  if (profile === "chat") {
    return Number(process.env.MISTRAL_CHAT_MAX_TOKENS ?? 1024);
  }
  return Number(process.env.MISTRAL_ANALYZE_MAX_TOKENS ?? 4096);
}

function mistralModelsToTry(): string[] {
  const models = [MISTRAL_MODEL];
  if (!models.includes(MISTRAL_MODEL_FALLBACK)) {
    models.push(MISTRAL_MODEL_FALLBACK);
  }
  return models;
}

function createMistralClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.MISTRAL_API_KEY!,
    baseURL: "https://api.mistral.ai/v1",
    timeout: llmTimeoutMs(),
    maxRetries: Number(process.env.MISTRAL_MAX_RETRIES ?? 1),
  });
}

export function formatMistralError(err: unknown): string {
  if (isNetworkLlmError(err)) return formatNetworkLlmError();

  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("429") || message.includes("rate_limit")) {
    return "Лимит запросов к AI исчерпан. Попробуй позже.";
  }
  if (message.includes("401") || message.includes("invalid_api_key")) {
    return "Ошибка авторизации AI-сервиса на сервере.";
  }
  if (message.includes("model") && message.includes("not found")) {
    return "Модель Mistral недоступна. Проверь MISTRAL_MODEL в .env.";
  }
  return "Не удалось получить ответ от AI. Попробуй позже.";
}

function shouldTryMistralFallback(err: unknown): boolean {
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

function estimateMistralUsage(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
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

export async function* streamMistralChat(options: {
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  maxCompletionTokens?: number;
  temperature?: number;
}): AsyncGenerator<string, { model: string; usage: import("./llmUsageLog.js").LlmUsage }> {
  const client = createMistralClient();
  const models = mistralModelsToTry();
  let lastError: unknown;
  const maxTokens = options.maxCompletionTokens ?? mistralMaxTokens("chat");

  for (let i = 0; i < models.length; i++) {
    const model = models[i]!;
    try {
      const stream = await client.chat.completions.create({
        model,
        messages: options.messages,
        stream: true,
        max_tokens: maxTokens,
        temperature: options.temperature ?? 0.7,
      });
      if (i > 0) {
        console.warn(`[Mistral] fallback model: ${model}`);
      }

      let outputText = "";
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? "";
        if (delta) {
          outputText += delta;
          yield delta;
        }
      }
      return { model, usage: estimateMistralUsage(options.messages, outputText) };
    } catch (err) {
      lastError = err;
      if (i < models.length - 1 && shouldTryMistralFallback(err)) {
        console.warn(`[Mistral] ${model} failed, trying ${models[i + 1]}`);
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error("Mistral request failed");
}
