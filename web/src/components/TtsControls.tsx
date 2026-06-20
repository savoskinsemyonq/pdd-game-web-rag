import type { MouseEvent } from "react";
import type { TtsState } from "../hooks/useSileroTts";

interface TtsControlsProps {
  text: string;
  state: TtsState;
  error: string | null;
  disabled?: boolean;
  playLabel?: string;
  playTitle?: string;
  onSpeak: (text: string) => void;
  onPause: () => void;
  onResume: () => void | Promise<void>;
  onStop: () => void;
  onMouseDown?: (event: MouseEvent<HTMLDivElement>) => void;
  variant?: "default" | "chat" | "toolbar";
}

function IconPlay() {
  return <span className="tts-controls__glyph" aria-hidden="true">▶</span>;
}

function IconPause() {
  return <span className="tts-controls__glyph" aria-hidden="true">⏸</span>;
}

function IconStop() {
  return <span className="tts-controls__glyph" aria-hidden="true">⏹</span>;
}

export function TtsControls({
  text,
  state,
  error,
  disabled = false,
  playLabel = "Озвучить",
  playTitle = "Озвучить",
  onSpeak,
  onPause,
  onResume,
  onStop,
  onMouseDown,
  variant = "default",
}: TtsControlsProps) {
  const trimmed = text.trim();
  const canPlay = trimmed.length > 0 && !disabled && state !== "loading";
  const isLoading = state === "loading";
  const isPlaying = state === "playing";
  const isPaused = state === "paused";
  const isActive = isPlaying || isPaused;
  const hint = error ?? playTitle;

  return (
    <div
      className={`tts-controls tts-controls--${variant}${isActive ? " tts-controls--active" : ""}${isLoading ? " tts-controls--loading" : ""}`}
      onMouseDown={onMouseDown}
    >
      {!isActive && (
        <button
          type="button"
          className="tts-controls__btn tts-controls__btn--play tts-controls__btn--start"
          disabled={!canPlay}
          title={hint}
          aria-label={playTitle}
          onClick={() => onSpeak(trimmed)}
        >
          {isLoading ? (
            <span className="tts-controls__start-label">Озвучивание…</span>
          ) : (
            <>
              <IconPlay />
              <span className="tts-controls__start-label">{playLabel}</span>
            </>
          )}
        </button>
      )}

      {isPlaying && (
        <button
          type="button"
          className="tts-controls__btn tts-controls__btn--pause"
          title="Пауза"
          aria-label="Пауза"
          onClick={onPause}
        >
          <IconPause />
        </button>
      )}

      {isPaused && (
        <button
          type="button"
          className={`tts-controls__btn tts-controls__btn--play${variant !== "default" ? " tts-controls__btn--start" : ""}`}
          title="Продолжить"
          aria-label="Продолжить"
          onClick={() => void onResume()}
        >
          <IconPlay />
          {variant !== "default" && <span className="tts-controls__start-label">Продолжить</span>}
        </button>
      )}

      {isActive && (
        <button
          type="button"
          className="tts-controls__btn tts-controls__btn--stop"
          title="Стоп"
          aria-label="Стоп"
          onClick={onStop}
        >
          <IconStop />
        </button>
      )}
    </div>
  );
}
