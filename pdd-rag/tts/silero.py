from __future__ import annotations

import io
import logging
import os
import re
import time
import wave

import numpy as np
import torch

from tts.normalize import normalize_for_tts

logger = logging.getLogger(__name__)

MAX_TTS_CHARS = int(os.environ.get("TTS_MAX_CHARS", "4000"))
CHUNK_MAX_CHARS = int(os.environ.get("TTS_CHUNK_CHARS", "900"))
DEFAULT_SPEAKER = os.environ.get("TTS_SPEAKER", "xenia")
SAMPLE_RATE = 48000
SILERO_MODEL_URL = os.environ.get(
    "SILERO_MODEL_URL",
    "https://models.silero.ai/models/tts/ru/v4_ru.pt",
)
SILERO_MODEL_DIR = os.environ.get("SILERO_MODEL_DIR", "/root/.cache/silero")

_model = None
_load_error: str | None = None


def is_tts_ready() -> bool:
    return _model is not None


def get_tts_load_error() -> str | None:
    return _load_error


def _prepare_text(text: str) -> str:
    spoken = normalize_for_tts(text)
    if len(spoken) <= MAX_TTS_CHARS:
        return spoken
    return spoken[: MAX_TTS_CHARS - 1].rstrip() + "…"


def _split_for_tts(text: str, max_chars: int = CHUNK_MAX_CHARS) -> list[str]:
    if len(text) <= max_chars:
        return [text]

    parts = re.split(r"(?<=[.!?…])\s+", text)
    chunks: list[str] = []
    current = ""

    for part in parts:
        if not part:
            continue
        candidate = f"{current} {part}".strip() if current else part
        if len(candidate) <= max_chars:
            current = candidate
            continue

        if current:
            chunks.append(current)
            current = ""

        if len(part) <= max_chars:
            current = part
            continue

        for i in range(0, len(part), max_chars):
            piece = part[i : i + max_chars].strip()
            if piece:
                chunks.append(piece)

    if current:
        chunks.append(current)

    return [chunk for chunk in chunks if chunk]


def _audio_to_wav_bytes(audio: torch.Tensor, sample_rate: int) -> bytes:
    audio_np = audio.detach().cpu().numpy()
    if audio_np.ndim > 1:
        audio_np = audio_np.squeeze()
    audio_np = np.clip(audio_np, -1.0, 1.0)
    pcm = (audio_np * 32767).astype(np.int16)

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm.tobytes())
    return buffer.getvalue()


def _load_model():
    global _model, _load_error
    if _model is not None:
        return _model
    if _load_error is not None:
        raise RuntimeError(_load_error)

    try:
        from torch import package

        model_dir = SILERO_MODEL_DIR
        os.makedirs(model_dir, exist_ok=True)
        model_path = os.path.join(model_dir, os.path.basename(SILERO_MODEL_URL))

        if not os.path.isfile(model_path):
            logger.info("[TTS] downloading weights from %s", SILERO_MODEL_URL)
            torch.hub.download_url_to_file(SILERO_MODEL_URL, model_path, progress=True)

        logger.info("[TTS] loading model from %s", model_path)
        model = package.PackageImporter(model_path).load_pickle("tts_models", "model")
        model.to(torch.device("cpu"))
        _model = model
        _load_error = None
        logger.info("[TTS] model ready (speaker=%s, sample_rate=%d)", DEFAULT_SPEAKER, SAMPLE_RATE)
        return _model
    except Exception as exc:
        _load_error = str(exc)
        logger.exception("[TTS] model load failed")
        raise


def warmup_tts() -> None:
    try:
        wav = synthesize_wav("Прогрев: ПДД п. 13.9, скорость 60 км/ч.")
        logger.info("[TTS] warmup complete (wav_bytes=%d)", len(wav))
    except Exception:
        logger.exception("[TTS] warmup failed")


def synthesize_wav(text: str, speaker: str | None = None) -> bytes:
    started = time.perf_counter()
    raw_preview = text.strip()[:80] + ("…" if len(text.strip()) > 80 else "")
    normalized = _prepare_text(text)
    if not normalized:
        raise ValueError("empty text")

    voice = (speaker or DEFAULT_SPEAKER).strip() or DEFAULT_SPEAKER
    chunks = _split_for_tts(normalized)
    preview = normalized[:80] + ("…" if len(normalized) > 80 else "")

    logger.info(
        "[TTS] synthesize start raw_chars=%d spoken_chars=%d chunks=%d speaker=%s raw=%r spoken=%r",
        len(text.strip()),
        len(normalized),
        len(chunks),
        voice,
        raw_preview,
        preview,
    )

    model = _load_model()
    segments: list[torch.Tensor] = []

    for index, chunk in enumerate(chunks, start=1):
        chunk_preview = chunk[:60] + ("…" if len(chunk) > 60 else "")
        try:
            segment = model.apply_tts(text=chunk, speaker=voice, sample_rate=SAMPLE_RATE)
            segments.append(segment)
            logger.info(
                "[TTS] chunk %d/%d ok chars=%d samples=%d preview=%r",
                index,
                len(chunks),
                len(chunk),
                segment.shape[0],
                chunk_preview,
            )
        except Exception as exc:
            logger.exception(
                "[TTS] chunk %d/%d failed chars=%d preview=%r error=%s",
                index,
                len(chunks),
                len(chunk),
                chunk_preview,
                exc,
            )
            raise RuntimeError(f"TTS synthesis failed on chunk {index}/{len(chunks)}: {exc}") from exc

    audio = torch.cat(segments) if len(segments) > 1 else segments[0]
    wav_bytes = _audio_to_wav_bytes(audio, SAMPLE_RATE)
    elapsed_ms = (time.perf_counter() - started) * 1000
    audio_sec = audio.shape[0] / SAMPLE_RATE

    logger.info(
        "[TTS] synthesize done wav_bytes=%d audio_sec=%.1f elapsed_ms=%.0f",
        len(wav_bytes),
        audio_sec,
        elapsed_ms,
    )
    return wav_bytes
