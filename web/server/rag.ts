import { PDD_CHUNKS, type PddChunk } from "./pdd-rules.js";

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[.,!?;:()\-—«»"']/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function score(chunk: PddChunk, queryTokens: string[]): number {
  const chunkTokens = tokenize(chunk.text + " " + chunk.title + " " + chunk.keywords.join(" "));
  const chunkSet = new Set(chunkTokens);
  let hits = 0;
  for (const qt of queryTokens) {
    if (chunkSet.has(qt)) hits++;
    // partial match (e.g. "перекрёстк" matches "перекрёстке")
    if (!chunkSet.has(qt)) {
      for (const ct of chunkSet) {
        if (ct.startsWith(qt) || qt.startsWith(ct)) {
          hits += 0.5;
          break;
        }
      }
    }
  }
  return hits;
}

export function retrieveChunks(query: string, topK = 4): PddChunk[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return PDD_CHUNKS.slice(0, topK);

  const scored = PDD_CHUNKS.map((chunk) => ({
    chunk,
    score: score(chunk, queryTokens),
  }));

  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, topK).filter((s) => s.score > 0);
  if (top.length === 0) return PDD_CHUNKS.slice(0, 2);
  return top.map((s) => s.chunk);
}
