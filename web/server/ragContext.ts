import { retrieveChunks } from "./rag.js";
import type { PddChunk } from "./pdd-rules.js";
import {
  formatRagContext,
  formatRagFailure,
  isRagAvailable,
  retrieveFromRag,
  type RagRetrieveChunk,
  type RagRetrieveStatus,
} from "./ragClient.js";

export type PddContextSource = "rag" | "local";

export interface PddContextResult {
  context: string;
  source: PddContextSource;
  ruleRefs: string[];
}

function logPddContextSource(
  scope: "chat" | "analyze" | "default",
  source: PddContextSource,
  detail: string,
  ruleRefs: string[],
): void {
  const sourceLabel =
    source === "rag"
      ? "RAG (векторная БД Qdrant)"
      : "локальная справка (pdd-rules.ts)";
  const refs = ruleRefs.length > 0 ? ruleRefs.join(", ") : "нет";
  console.log(`[PDD context] ${scope}: ${sourceLabel} | ${detail} | пункты: ${refs}`);
}

function ragFallbackReason(status: RagRetrieveStatus, detail?: string): string {
  return formatRagFailure(status, detail);
}

function formatLocalContext(chunks: PddChunk[]): string {
  return chunks
    .map((c) => `[${c.section}] ${c.title}\n${c.text}`)
    .join("\n\n---\n\n");
}

export function ruleRefsFromRagChunks(chunks: RagRetrieveChunk[]): string[] {
  const refs = new Set<string>();
  for (const c of chunks) {
    if (c.paragraph) refs.add(`п.${c.paragraph}`);
    else if (c.section) refs.add(c.section);
  }
  return [...refs];
}

export function ruleRefsFromLocalChunks(chunks: PddChunk[]): string[] {
  return [...new Set(chunks.map((c) => c.section).filter(Boolean))];
}

export async function buildPddContext(
  query: string,
  errorContext = "",
  topK = 4,
  profile: "chat" | "default" = "default",
): Promise<PddContextResult> {
  const scope = profile === "chat" ? "chat" : "default";
  let fallbackReason: string | null = null;

  if (isRagAvailable()) {
    const rag = await retrieveFromRag(query, errorContext, topK, profile);
    if (rag.status === "ok" && rag.chunks.length > 0) {
      const result: PddContextResult = {
        context: formatRagContext(rag.chunks),
        source: "rag",
        ruleRefs: ruleRefsFromRagChunks(rag.chunks),
      };
      logPddContextSource(
        scope,
        "rag",
        `найдено ${rag.chunks.length} фрагм.`,
        result.ruleRefs,
      );
      return result;
    }
    fallbackReason = ragFallbackReason(rag.status, rag.detail);
  } else {
    fallbackReason = "USE_RAG≠1 — RAG отключён";
  }

  const local = retrieveChunks(query, topK);
  const result: PddContextResult = {
    context: formatLocalContext(local),
    source: "local",
    ruleRefs: ruleRefsFromLocalChunks(local),
  };
  logPddContextSource(
    scope,
    "local",
    `${fallbackReason ?? "fallback"} → найдено ${local.length} фрагм.`,
    result.ruleRefs,
  );
  return result;
}

export async function buildAnalyzeContext(
  errorTexts: string[],
  topKPerError = 3,
): Promise<PddContextResult> {
  const seen = new Set<string>();
  const ragChunks: RagRetrieveChunk[] = [];
  let fallbackReason: string | null = null;

  if (isRagAvailable()) {
    let lastFailure: { status: RagRetrieveStatus; detail?: string } | null = null;
    for (const text of errorTexts) {
      const rag = await retrieveFromRag(text, "", topKPerError, "default");
      if (rag.status === "ok") {
        for (const c of rag.chunks) {
          const key = `${c.paragraph}|${c.section}|${c.text.slice(0, 80)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          ragChunks.push(c);
        }
      } else {
        lastFailure = { status: rag.status, detail: rag.detail };
      }
    }
    if (ragChunks.length === 0 && lastFailure) {
      fallbackReason = ragFallbackReason(lastFailure.status, lastFailure.detail);
    } else if (ragChunks.length === 0) {
      fallbackReason = ragFallbackReason("empty", "индекс пуст?");
    }
  } else {
    fallbackReason = "USE_RAG≠1 — RAG отключён";
  }

  if (ragChunks.length > 0) {
    const maxChunks = Number(process.env.ANALYZE_RAG_MAX_CHUNKS ?? 12);
    const limited = ragChunks.slice(0, maxChunks);
    const result: PddContextResult = {
      context: formatRagContext(limited),
      source: "rag",
      ruleRefs: ruleRefsFromRagChunks(limited),
    };
    logPddContextSource(
      "analyze",
      "rag",
      `найдено ${limited.length} фрагм. по ${errorTexts.length} ошибкам` +
        (limited.length < ragChunks.length ? ` (лимит ${maxChunks})` : ""),
      result.ruleRefs,
    );
    return result;
  }

  const query = errorTexts.join(" ");
  const local = retrieveChunks(query, Math.max(topKPerError * 2, 6));
  const result: PddContextResult = {
    context: formatLocalContext(local),
    source: "local",
    ruleRefs: ruleRefsFromLocalChunks(local),
  };
  logPddContextSource(
    "analyze",
    "local",
    `${fallbackReason ?? "fallback"} → найдено ${local.length} фрагм.`,
    result.ruleRefs,
  );
  return result;
}
