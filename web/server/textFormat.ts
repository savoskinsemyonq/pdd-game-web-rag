/** Убирает markdown-разметку из текста ответа LLM. */
export function stripMarkdownFormatting(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/\*(.+?)\*/gs, "$1")
    .replace(/__(.+?)__/gs, "$1")
    .replace(/_(.+?)_/gs, "$1")
    .replace(/`(.+?)`/gs, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*#_`]/g, "");
}
