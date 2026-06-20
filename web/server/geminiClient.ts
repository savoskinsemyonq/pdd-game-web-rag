import { GoogleGenAI } from "@google/genai";

import { formatNetworkLlmError, isNetworkLlmError, llmTimeoutMs } from "./llmConfig.js";

import type { LlmUsage } from "./llmUsageLog.js";



export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite";



export interface LlmMessage {

  role: "system" | "user" | "assistant";

  content: string;

}



function toGeminiContents(messages: LlmMessage[]): {

  systemInstruction?: string;

  contents: Array<{ role: string; parts: Array<{ text: string }> }>;

} {

  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);

  const systemInstruction = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;

  const contents = messages

    .filter((m) => m.role !== "system")

    .map((m) => ({

      role: m.role === "assistant" ? "model" : "user",

      parts: [{ text: m.content }],

    }));

  return { systemInstruction, contents };

}



function mapGeminiUsage(meta: {

  promptTokenCount?: number;

  candidatesTokenCount?: number;

  totalTokenCount?: number;

} | undefined): LlmUsage | undefined {

  if (!meta) return undefined;

  const prompt = meta.promptTokenCount ?? null;

  const completion = meta.candidatesTokenCount ?? null;

  const total =

    meta.totalTokenCount ?? (prompt != null && completion != null ? prompt + completion : null);

  if (prompt == null && completion == null && total == null) return undefined;

  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };

}



export function formatGeminiError(err: unknown): string {

  if (isNetworkLlmError(err)) return formatNetworkLlmError();

  const message = err instanceof Error ? err.message : String(err);

  if (message.includes("429") || message.includes("RESOURCE_EXHAUSTED")) {

    return "Лимит запросов к AI исчерпан. Попробуй позже.";

  }

  if (message.includes("401") || message.includes("403") || message.includes("API key")) {

    return "Ошибка авторизации AI-сервиса на сервере.";

  }

  return "Не удалось получить ответ от AI. Попробуй позже.";

}



function isRetryableGeminiError(err: unknown): boolean {

  const message = err instanceof Error ? err.message : String(err);

  return (

    message.includes("429") ||

    message.includes("RESOURCE_EXHAUSTED") ||

    message.includes("503") ||

    message.includes("500") ||

    message.includes("UNAVAILABLE")

  );

}



export async function* createGeminiChatStream(options: {

  messages: LlmMessage[];

  maxCompletionTokens?: number;

  temperature?: number;

}): AsyncGenerator<string, LlmUsage | undefined> {

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {

    throw new Error("GEMINI_API_KEY is not set");

  }



  const ai = new GoogleGenAI({

    apiKey,

    httpOptions: { timeout: llmTimeoutMs() },

  });

  const { systemInstruction, contents } = toGeminiContents(options.messages);



  try {

    const stream = await ai.models.generateContentStream({

      model: GEMINI_MODEL,

      contents,

      config: {

        systemInstruction,

        temperature: options.temperature ?? 0.7,

        maxOutputTokens: options.maxCompletionTokens ?? 1024,

      },

    });



    let usage: LlmUsage | undefined;

    for await (const chunk of stream) {

      if (chunk.usageMetadata) {

        usage = mapGeminiUsage(chunk.usageMetadata);

      }

      const text = chunk.text;

      if (text) yield text;

    }

    return usage;

  } catch (err) {

    if (isRetryableGeminiError(err)) throw err;

    throw err;

  }

}



export { isRetryableGeminiError };


