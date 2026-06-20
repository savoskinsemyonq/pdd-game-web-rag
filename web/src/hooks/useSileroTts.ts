import { useCallback, useEffect, useRef, useState } from "react";

export type TtsState = "idle" | "loading" | "playing" | "paused" | "error";

function ttsLog(message: string, extra?: Record<string, unknown>) {
  if (extra) {
    console.info(`[TTS] ${message}`, extra);
    return;
  }
  console.info(`[TTS] ${message}`);
}

export function useSileroTts() {
  const [state, setState] = useState<TtsState>("idle");
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cleanup = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    ttsLog("stop");
    cleanup();
    setState("idle");
    setError(null);
  }, [cleanup]);

  const pause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    ttsLog("paused", { currentTime: audio.currentTime });
    setState("paused");
  }, []);

  const resume = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      await audio.play();
      ttsLog("resumed", { currentTime: audio.currentTime });
      setState("playing");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Не удалось продолжить воспроизведение";
      console.error("[TTS] resume failed", err);
      setState("error");
      setError(message);
    }
  }, []);

  const speak = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        ttsLog("skipped: empty text");
        return;
      }

      cleanup();
      setState("loading");
      setError(null);

      const started = performance.now();
      const preview = trimmed.slice(0, 80) + (trimmed.length > 80 ? "…" : "");
      ttsLog("speak start", { chars: trimmed.length, preview });

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          signal: controller.signal,
          body: JSON.stringify({ text: trimmed }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Озвучивание недоступно" }));
          const message = (err as { error?: string }).error ?? "Озвучивание недоступно";
          console.warn(`[TTS] fetch failed status=${res.status} message=${message}`);
          throw new Error(message);
        }

        const blob = await res.blob();
        ttsLog("fetch ok", {
          bytes: blob.size,
          type: blob.type,
          elapsed_ms: Math.round(performance.now() - started),
        });

        if (blob.size < 44) {
          throw new Error("Получен пустой аудиофайл");
        }

        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;

        audio.onended = () => {
          ttsLog("playback ended");
          cleanup();
          setState("idle");
        };
        audio.onerror = () => {
          console.error("[TTS] audio element error", audio.error);
          cleanup();
          setState("error");
          setError("Не удалось воспроизвести аудио");
        };

        await audio.play();
        ttsLog("playback started", {
          elapsed_ms: Math.round(performance.now() - started),
        });
        setState("playing");
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          ttsLog("aborted");
          return;
        }
        const message = err instanceof Error ? err.message : "Озвучивание недоступно";
        console.error("[TTS] speak failed", err);
        cleanup();
        setState("error");
        setError(message);
      }
    },
    [cleanup],
  );

  useEffect(() => () => cleanup(), [cleanup]);

  return {
    speak,
    pause,
    resume,
    stop,
    state,
    error,
    isLoading: state === "loading",
    isPlaying: state === "playing",
    isPaused: state === "paused",
    isActive: state === "playing" || state === "paused",
  };
};
