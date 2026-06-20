import type { LlmMessage } from "./geminiClient.js";
import type { LlmProvider } from "./llmConfig.js";

export interface LlmUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface LlmUsageLogContext {
  profile: "chat" | "analyze";
  provider: LlmProvider;
  model: string;
  messages: LlmMessage[];
  maxCompletionTokens: number;
  usage: LlmUsage | null | undefined;
  usageSource?: "api" | "estimate";
  fallback?: boolean;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function breakdownByRole(
  messages: LlmMessage[],
  promptTokens: number | null,
): { system: number; user: number; assistant: number } {
  const chars = {
    system: 0,
    user: 0,
    assistant: 0,
  };
  for (const m of messages) {
    if (m.role === "system") chars.system += m.content.length;
    else if (m.role === "user") chars.user += m.content.length;
    else chars.assistant += m.content.length;
  }
  const totalChars = chars.system + chars.user + chars.assistant;
  if (promptTokens != null && totalChars > 0) {
    return {
      system: Math.round((promptTokens * chars.system) / totalChars),
      user: Math.round((promptTokens * chars.user) / totalChars),
      assistant: Math.round((promptTokens * chars.assistant) / totalChars),
    };
  }
  return {
    system: estimateTokens(messages.filter((m) => m.role === "system").map((m) => m.content).join("\n")),
    user: estimateTokens(messages.filter((m) => m.role === "user").map((m) => m.content).join("\n")),
    assistant: estimateTokens(messages.filter((m) => m.role === "assistant").map((m) => m.content).join("\n")),
  };
}

export function logLlmUsage(ctx: LlmUsageLogContext): void {
  const { usage, messages, profile, provider, model, maxCompletionTokens, fallback } = ctx;
  const prompt = usage?.promptTokens ?? null;
  const completion = usage?.completionTokens ?? null;
  const total = usage?.totalTokens ?? (prompt != null && completion != null ? prompt + completion : null);
  const parts = breakdownByRole(messages, prompt);
  const source = ctx.usageSource ?? (usage ? "api" : "estimate");

  const promptPart =
    prompt != null
      ? `${prompt} (system=${parts.system}, user=${parts.user}, history=${parts.assistant})`
      : `~${parts.system + parts.user + parts.assistant} (system=${parts.system}, user=${parts.user}, history=${parts.assistant})`;

  const completionPart = completion != null ? String(completion) : "?";
  const totalPart = total != null ? String(total) : "?";

  console.log(
    `[LLM] ${profile} | ${provider}/${model}${fallback ? " (fallback)" : ""} | ` +
      `prompt=${promptPart} | completion=${completionPart} | total=${totalPart} | ` +
      `max_completion=${maxCompletionTokens} | source=${source}`,
  );
}
