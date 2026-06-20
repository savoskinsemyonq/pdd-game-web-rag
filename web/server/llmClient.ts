import {
  createGeminiChatStream,
  formatGeminiError,
  GEMINI_MODEL,
  type LlmMessage,
} from "./geminiClient.js";
import { formatGroqError, groqMaxTokens, streamGroqChat } from "./groqClient.js";
import {
  formatMistralError,
  mistralMaxTokens,
  MISTRAL_MODEL,
  streamMistralChat,
} from "./mistralClient.js";
import { isNetworkLlmError, llmMaxRetries, type LlmProvider } from "./llmConfig.js";
import { logLlmUsage, type LlmUsage } from "./llmUsageLog.js";

export type { LlmProvider, LlmMessage };

const ALL_PROVIDERS: LlmProvider[] = ["gemini", "groq", "mistral"];

function parseLlmProvider(raw: string): LlmProvider {
  const lower = raw.toLowerCase();
  if (lower === "groq" || lower === "mistral" || lower === "gemini") {
    return lower;
  }
  return "gemini";
}

export function getLlmProvider(): LlmProvider {
  return parseLlmProvider(process.env.LLM_PROVIDER ?? "gemini");
}

function providerHasKey(provider: LlmProvider): boolean {
  if (provider === "gemini") return Boolean(process.env.GEMINI_API_KEY);
  if (provider === "groq") return Boolean(process.env.GROQ_API_KEY);
  return Boolean(process.env.MISTRAL_API_KEY);
}

export function hasLlmConfigured(): boolean {
  return ALL_PROVIDERS.some(providerHasKey);
}

export function llmMaxTokens(profile: "chat" | "analyze"): number {
  const provider = getLlmProvider();
  if (provider === "groq") return groqMaxTokens(profile);
  if (provider === "mistral") return mistralMaxTokens(profile);
  if (profile === "chat") return Number(process.env.GEMINI_CHAT_MAX_TOKENS ?? 1024);
  return Number(process.env.GEMINI_ANALYZE_MAX_TOKENS ?? 768);
}

export function formatLlmError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("MISTRAL") || message.includes("Mistral")) {
    return formatMistralError(err);
  }
  if (message.includes("GEMINI")) return formatGeminiError(err);
  if (message.includes("GROQ") || message.includes("Groq")) return formatGroqError(err);
  return formatGeminiError(err) !== "Не удалось получить ответ от AI. Попробуй позже."
    ? formatGeminiError(err)
    : formatGroqError(err);
}

function providersToTry(preferred?: LlmProvider): LlmProvider[] {
  const primary = preferred ?? getLlmProvider();
  const list: LlmProvider[] = [];

  if (providerHasKey(primary)) list.push(primary);
  for (const provider of ALL_PROVIDERS) {
    if (provider !== primary && providerHasKey(provider) && !list.includes(provider)) {
      list.push(provider);
    }
  }

  return list;
}

interface StreamMeta {
  model: string;
  usage?: LlmUsage;
}

async function* streamFromProvider(
  provider: LlmProvider,
  messages: LlmMessage[],
  maxTokens: number,
  temperature: number,
): AsyncGenerator<string, StreamMeta> {
  if (provider === "gemini") {
    const stream = createGeminiChatStream({
      messages,
      maxCompletionTokens: maxTokens,
      temperature,
    });
    let step = await stream.next();
    while (!step.done) {
      yield step.value;
      step = await stream.next();
    }
    return { model: GEMINI_MODEL, usage: step.value };
  }

  if (provider === "mistral") {
    const stream = streamMistralChat({
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      maxCompletionTokens: maxTokens,
      temperature,
    });
    let step = await stream.next();
    while (!step.done) {
      yield step.value;
      step = await stream.next();
    }
    return { model: step.value.model, usage: step.value.usage };
  }

  const stream = streamGroqChat({
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    maxCompletionTokens: maxTokens,
    temperature,
  });
  let step = await stream.next();
  while (!step.done) {
    yield step.value;
    step = await stream.next();
  }
  return { model: step.value.model, usage: step.value.usage };
}

export async function* createChatStream(options: {
  messages: LlmMessage[];
  maxCompletionTokens?: number;
  temperature?: number;
  profile?: "chat" | "analyze";
  preferredProvider?: LlmProvider;
}): AsyncGenerator<string> {
  const providers = providersToTry(options.preferredProvider);
  if (providers.length === 0) {
    throw new Error(
      "Ни GEMINI_API_KEY, ни GROQ_API_KEY, ни MISTRAL_API_KEY не настроены на сервере",
    );
  }

  const profile = options.profile ?? "chat";
  const maxTokens = options.maxCompletionTokens ?? llmMaxTokens(profile);
  const temperature = options.temperature ?? 0.7;
  const retries = llmMaxRetries();
  let lastError: unknown;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i]!;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const stream = streamFromProvider(provider, options.messages, maxTokens, temperature);
        let step = await stream.next();
        while (!step.done) {
          yield step.value;
          step = await stream.next();
        }
        const meta = step.value;
        const defaultModel =
          provider === "gemini"
            ? GEMINI_MODEL
            : provider === "mistral"
              ? MISTRAL_MODEL
              : "groq";

        logLlmUsage({
          profile,
          provider,
          model: meta.model ?? defaultModel,
          messages: options.messages,
          maxCompletionTokens: maxTokens,
          usage: meta.usage,
          usageSource:
            provider === "groq" || provider === "mistral"
              ? "estimate"
              : meta.usage
                ? "api"
                : "estimate",
          fallback: i > 0,
        });

        if (i > 0) {
          console.warn(`[LLM] fallback provider: ${provider}`);
        }
        return;
      } catch (err) {
        lastError = err;
        const retryable = isNetworkLlmError(err) && attempt < retries;
        console.warn(
          `[LLM] ${provider} failed${retryable ? ` (retry ${attempt + 1}/${retries})` : ""}:`,
          err instanceof Error ? err.message : err,
        );
        if (retryable) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        break;
      }
    }
    if (i < providers.length - 1) continue;
    throw lastError;
  }

  throw lastError ?? new Error("LLM request failed");
}
