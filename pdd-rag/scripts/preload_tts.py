#!/usr/bin/env python3
"""Pre-download Silero TTS during Docker image build."""

from __future__ import annotations

from tts.silero import warmup_tts


def main() -> None:
    print("Preloading Silero TTS (ru v4)…", flush=True)
    warmup_tts()
    print("Silero TTS preloaded OK", flush=True)


if __name__ == "__main__":
    main()
