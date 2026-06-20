export interface TtsHealthInfo {
  ok: boolean;
  ttsReady?: boolean;
  detail?: string;
}

export function getTtsApiUrl(): string {
  return process.env.TTS_API_URL ?? process.env.RAG_API_URL ?? "http://127.0.0.1:8000";
}

export async function checkTtsHealth(): Promise<TtsHealthInfo> {
  try {
    const res = await fetch(`${getTtsApiUrl()}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { tts_ready?: boolean; status?: string };
    return {
      ok: data.status === "ok" || data.tts_ready === true,
      ttsReady: data.tts_ready,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: message };
  }
}
