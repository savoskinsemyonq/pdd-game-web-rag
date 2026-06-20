export function llmTimeoutMs(): number {
  return Number(process.env.LLM_TIMEOUT_MS ?? 120_000);
}

export function llmMaxRetries(): number {
  return Number(process.env.LLM_MAX_RETRIES ?? 1);
}

export type LlmProvider = "gemini" | "groq" | "mistral";

export function isNetworkLlmError(err: unknown): boolean {
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message);
    if (err.cause instanceof Error) parts.push(err.cause.message);
    else if (err.cause != null) parts.push(String(err.cause));
  } else {
    parts.push(String(err));
  }
  const combined = parts.join(" ").toLowerCase();
  return (
    combined.includes("fetch failed") ||
    combined.includes("timed out") ||
    combined.includes("timeout") ||
    combined.includes("econnrefused") ||
    combined.includes("enotfound") ||
    combined.includes("network") ||
    combined.includes("connect timeout") ||
    combined.includes("socket hang up")
  );
}

export function formatNetworkLlmError(): string {
  return (
    "Не удалось связаться с AI-сервисом (сеть или таймаут). " +
    "Gemini часто недоступен без VPN — в web/.env можно указать LLM_PROVIDER=groq или LLM_PROVIDER=mistral, " +
    "либо LLM_PROXY=http://host:port для прокси. " +
    "Попробуй позже."
  );
}
