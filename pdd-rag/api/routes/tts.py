from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from tts.silero import synthesize_wav

router = APIRouter()
logger = logging.getLogger(__name__)


class TtsRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    speaker: str | None = None


@router.post("/tts")
async def tts_endpoint(body: TtsRequest):
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    preview = text[:80] + ("…" if len(text) > 80 else "")
    started = time.perf_counter()
    logger.info(
        "[TTS] POST /api/v1/tts chars=%d speaker=%s preview=%r",
        len(text),
        body.speaker or "default",
        preview,
    )

    loop = asyncio.get_running_loop()
    try:
        wav_bytes = await loop.run_in_executor(
            None,
            lambda: synthesize_wav(text, body.speaker),
        )
    except ValueError as exc:
        logger.warning("[TTS] bad request after %.0fms: %s", (time.perf_counter() - started) * 1000, exc)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        logger.error("[TTS] synthesis error after %.0fms: %s", (time.perf_counter() - started) * 1000, exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("[TTS] unexpected error after %.0fms", (time.perf_counter() - started) * 1000)
        raise HTTPException(status_code=500, detail=f"TTS synthesis failed: {exc}") from exc

    elapsed_ms = (time.perf_counter() - started) * 1000
    logger.info("[TTS] POST /api/v1/tts ok wav_bytes=%d elapsed_ms=%.0f", len(wav_bytes), elapsed_ms)
    return Response(content=wav_bytes, media_type="audio/wav")
