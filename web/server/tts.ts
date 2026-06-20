import type { Request, Response } from "express";
import { getTtsApiUrl } from "./ttsClient.js";

const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS ?? 60_000);
const MAX_TTS_CHARS = 5000;

interface TtsRequestBody {
  text?: string;
  speaker?: string;
}

export async function handleTts(req: Request, res: Response): Promise<void> {
  const { text = "", speaker } = req.body as TtsRequestBody;
  const trimmed = text.trim();
  const started = Date.now();

  if (!trimmed) {
    console.warn("[TTS] rejected: empty text");
    res.status(400).json({ error: "Текст для озвучивания пуст" });
    return;
  }

  if (trimmed.length > MAX_TTS_CHARS) {
    console.warn(`[TTS] rejected: too long (${trimmed.length} chars)`);
    res.status(400).json({ error: `Текст слишком длинный (макс. ${MAX_TTS_CHARS} символов)` });
    return;
  }

  const preview = trimmed.slice(0, 80) + (trimmed.length > 80 ? "…" : "");
  const upstreamUrl = `${getTtsApiUrl()}/api/v1/tts`;
  console.log(
    `[TTS] request chars=${trimmed.length} speaker=${speaker ?? "default"} upstream=${upstreamUrl} preview=${JSON.stringify(preview)}`,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: trimmed, speaker }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      let message = "Озвучивание недоступно";
      try {
        const parsed = JSON.parse(errText) as { detail?: string };
        if (parsed.detail) message = parsed.detail;
      } catch {
        if (errText) message = errText.slice(0, 200);
      }
      console.warn(
        `[TTS] upstream error status=${upstream.status} elapsed_ms=${Date.now() - started} message=${message}`,
      );
      res.status(upstream.status >= 500 ? 503 : upstream.status).json({ error: message });
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    console.log(
      `[TTS] ok wav_bytes=${buffer.length} elapsed_ms=${Date.now() - started}`,
    );
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      console.warn(`[TTS] timeout after ${TTS_TIMEOUT_MS}ms`);
      res.status(504).json({ error: "Таймаут синтеза речи" });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[TTS] proxy failed elapsed_ms=${Date.now() - started} error=${message}`);
    res.status(503).json({ error: `TTS API недоступен: ${message}` });
  } finally {
    clearTimeout(timer);
  }
}
