export interface RagSource {
  paragraph: string;
  section: string;
  source_type: string;
  score: number;
}

export interface RagRetrieveChunk {
  text: string;
  paragraph: string;
  section: string;
  source_type: string;
  score: number;
}

export type RagRetrieveStatus =
  | "ok"
  | "unreachable"
  | "timeout"
  | "http_error"
  | "empty"
  | "disabled";

export interface RagRetrieveResult {
  chunks: RagRetrieveChunk[];
  status: RagRetrieveStatus;
  detail?: string;
}

export interface RagHealthInfo {
  ok: boolean;
  modelsReady?: boolean;
  qdrantPoints?: number;
  status?: string;
  detail?: string;
}

const RAG_API_URL = process.env.RAG_API_URL ?? "http://127.0.0.1:8000";
const RAG_TIMEOUT_MS = Number(process.env.RAG_TIMEOUT_MS ?? 120_000);
const CHAT_RAG_TIMEOUT_MS = Number(process.env.CHAT_RAG_TIMEOUT_MS ?? 10_000);

export function isRagAvailable(): boolean {
  return process.env.USE_RAG === "1";
}

export function formatRagFailure(status: RagRetrieveStatus, detail?: string): string {
  switch (status) {
    case "unreachable":
      return `RAG API недоступен (${detail ?? "connection refused"})`;
    case "timeout":
      return `RAG API timeout (${detail ?? "unknown"})`;
    case "http_error":
      return `RAG API HTTP ${detail ?? "error"}`;
    case "empty":
      return `Qdrant вернул 0 фрагментов (${detail ?? "индекс пуст?"})`;
    case "disabled":
      return "USE_RAG≠1 — RAG отключён";
    default:
      return "RAG fallback";
  }
}

export async function retrieveFromRag(
  query: string,
  errorContext = "",
  topK = 5,
  profile: "chat" | "default" = "default",
): Promise<RagRetrieveResult> {
  if (profile === "chat" && process.env.USE_RAG !== "1") {
    return { chunks: [], status: "disabled" };
  }
  if (!process.env.RAG_API_URL) {
    return { chunks: [], status: "unreachable", detail: "RAG_API_URL не задан" };
  }

  const timeoutMs = profile === "chat" ? CHAT_RAG_TIMEOUT_MS : RAG_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${RAG_API_URL}/api/v1/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, error_context: errorContext, top_k: topK }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { chunks: [], status: "http_error", detail: String(res.status) };
    }
    const data = (await res.json()) as { chunks?: RagRetrieveChunk[] };
    const chunks = data.chunks ?? [];
    if (chunks.length === 0) {
      return { chunks: [], status: "empty", detail: "индекс пуст?" };
    }
    return { chunks, status: "ok" };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return {
        chunks: [],
        status: "timeout",
        detail: `${Math.round(timeoutMs / 1000)}s`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { chunks: [], status: "unreachable", detail: message };
  } finally {
    clearTimeout(timer);
  }
}

export async function* streamRagQuery(options: {
  query: string;
  errorContext?: string;
  mode?: "error" | "analysis";
}): AsyncGenerator<{ type: string; text?: string; sources?: RagSource[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RAG_TIMEOUT_MS);
  try {
    const res = await fetch(`${RAG_API_URL}/api/v1/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: options.query,
        error_context: options.errorContext ?? "",
        mode: options.mode ?? "error",
        stream: true,
        skip_guard: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`RAG API error: ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") return;
        try {
          yield JSON.parse(payload) as { type: string; text?: string; sources?: RagSource[] };
        } catch {
          // skip
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

export function formatRagContext(chunks: RagRetrieveChunk[]): string {
  return chunks
    .map((c) => `[${c.section}] п.${c.paragraph} (${c.source_type})\n${c.text}`)
    .join("\n\n---\n\n");
}

export async function checkRagHealth(): Promise<RagHealthInfo> {
  try {
    const res = await fetch(`${RAG_API_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      models_ready?: boolean;
      status?: string;
      qdrant_points?: number;
      warmup_error?: string | null;
    };
    if (data.models_ready === false) {
      return {
        ok: false,
        modelsReady: false,
        status: data.status,
        qdrantPoints: data.qdrant_points,
        detail: data.warmup_error ?? "models not ready",
      };
    }
    const ready = data.status === "ok" || data.models_ready === true;
    return {
      ok: ready,
      modelsReady: data.models_ready,
      status: data.status,
      qdrantPoints: data.qdrant_points,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: message };
  }
}
