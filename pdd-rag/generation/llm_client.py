from __future__ import annotations

import logging
import os
from typing import AsyncIterator

from groq import AsyncGroq
from openai import AsyncOpenAI
from tenacity import retry, stop_after_attempt, wait_exponential

from generation.proxy_config import gemini_http_options, get_llm_http_client

logger = logging.getLogger(__name__)

DEFAULT_GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.1-8b-instant")
DEFAULT_GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-lite")
DEFAULT_MISTRAL_MODEL = os.environ.get("MISTRAL_MODEL", "mistral-small-2506")

ALL_PROVIDERS = ("gemini", "groq", "mistral")


def _llm_provider() -> str:
    raw = os.environ.get("LLM_PROVIDER", "gemini").lower()
    return raw if raw in ALL_PROVIDERS else "gemini"


def _provider_has_key(provider: str) -> bool:
    if provider == "gemini":
        return bool(os.environ.get("GEMINI_API_KEY"))
    if provider == "groq":
        return bool(os.environ.get("GROQ_API_KEY"))
    return bool(os.environ.get("MISTRAL_API_KEY"))


def _providers_to_try() -> list[str]:
    primary = _llm_provider()
    providers: list[str] = []

    if _provider_has_key(primary):
        providers.append(primary)
    for provider in ALL_PROVIDERS:
        if provider != primary and _provider_has_key(provider) and provider not in providers:
            providers.append(provider)

    return providers


class GroqBackend:
    def __init__(self, api_key: str, model: str):
        self.model = model
        http_client = get_llm_http_client()
        if http_client is not None:
            self._client = AsyncGroq(api_key=api_key, http_client=http_client)
        else:
            self._client = AsyncGroq(api_key=api_key)

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
    async def generate(self, messages: list[dict], stream: bool = False, max_tokens: int = 800):
        return await self._client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=0.1,
            max_tokens=max_tokens,
            stream=stream,
        )

    async def stream_text(self, messages: list[dict]) -> AsyncIterator[str]:
        stream = await self.generate(messages, stream=True)
        async for chunk in stream:
            delta = chunk.choices[0].delta.content or ""
            if delta:
                yield delta


class GeminiBackend:
    def __init__(self, api_key: str, model: str):
        from google import genai
        from google.genai import types

        self.model = model
        self._types = types
        self._client = genai.Client(
            api_key=api_key,
            http_options=gemini_http_options(types),
        )

    def _to_contents(self, messages: list[dict]):
        system_parts = [m["content"] for m in messages if m.get("role") == "system"]
        system_instruction = "\n\n".join(system_parts) if system_parts else None
        contents = []
        for m in messages:
            role = m.get("role")
            if role == "system":
                continue
            contents.append(
                self._types.Content(
                    role="model" if role == "assistant" else "user",
                    parts=[self._types.Part(text=m["content"])],
                )
            )
        return system_instruction, contents

    async def generate(self, messages: list[dict], stream: bool = False, max_tokens: int = 800):
        system_instruction, contents = self._to_contents(messages)
        config = self._types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=0.1,
            max_output_tokens=max_tokens,
        )
        if stream:
            return await self._client.aio.models.generate_content_stream(
                model=self.model,
                contents=contents,
                config=config,
            )
        return await self._client.aio.models.generate_content(
            model=self.model,
            contents=contents,
            config=config,
        )

    async def stream_text(self, messages: list[dict]) -> AsyncIterator[str]:
        stream = await self.generate(messages, stream=True)
        async for chunk in stream:
            text = getattr(chunk, "text", None)
            if text:
                yield text


class MistralBackend:
    def __init__(self, api_key: str, model: str):
        self.model = model
        http_client = get_llm_http_client()
        client_kwargs: dict = {
            "api_key": api_key,
            "base_url": "https://api.mistral.ai/v1",
        }
        if http_client is not None:
            client_kwargs["http_client"] = http_client
        self._client = AsyncOpenAI(**client_kwargs)

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=8))
    async def generate(self, messages: list[dict], stream: bool = False, max_tokens: int = 800):
        return await self._client.chat.completions.create(
            model=self.model,
            messages=messages,
            temperature=0.1,
            max_tokens=max_tokens,
            stream=stream,
        )

    async def stream_text(self, messages: list[dict]) -> AsyncIterator[str]:
        stream = await self.generate(messages, stream=True)
        async for chunk in stream:
            delta = chunk.choices[0].delta.content or ""
            if delta:
                yield delta


class LlmClient:
    def __init__(self):
        self._backends: dict[str, GroqBackend | GeminiBackend | MistralBackend] = {}
        groq_key = os.environ.get("GROQ_API_KEY", "")
        gemini_key = os.environ.get("GEMINI_API_KEY", "")
        mistral_key = os.environ.get("MISTRAL_API_KEY", "")
        if groq_key:
            self._backends["groq"] = GroqBackend(groq_key, DEFAULT_GROQ_MODEL)
        if gemini_key:
            self._backends["gemini"] = GeminiBackend(gemini_key, DEFAULT_GEMINI_MODEL)
        if mistral_key:
            self._backends["mistral"] = MistralBackend(mistral_key, DEFAULT_MISTRAL_MODEL)

    def _get_backend(self, provider: str) -> GroqBackend | GeminiBackend | MistralBackend:
        backend = self._backends.get(provider)
        if backend is None:
            raise RuntimeError(f"{provider.upper()} API key is not set")
        return backend

    async def generate(self, messages: list[dict], stream: bool = False, max_tokens: int = 800):
        providers = _providers_to_try()
        if not providers:
            raise RuntimeError("Neither GEMINI_API_KEY, GROQ_API_KEY, nor MISTRAL_API_KEY is set")

        last_error: Exception | None = None
        for i, provider in enumerate(providers):
            try:
                result = await self._get_backend(provider).generate(
                    messages, stream=stream, max_tokens=max_tokens
                )
                if i > 0:
                    logger.warning("[LLM] fallback provider: %s", provider)
                return result
            except Exception as exc:
                last_error = exc
                logger.warning("[LLM] %s failed: %s", provider, exc)
                if i < len(providers) - 1:
                    continue
                raise

        raise last_error or RuntimeError("LLM request failed")

    async def complete_text(self, messages: list[dict], max_tokens: int = 800) -> str:
        response = await self.generate(messages, stream=False, max_tokens=max_tokens)
        if hasattr(response, "choices"):
            return (response.choices[0].message.content or "").strip()
        text = getattr(response, "text", None)
        return (text or "").strip()

    async def stream_text(self, messages: list[dict]) -> AsyncIterator[str]:
        providers = _providers_to_try()
        if not providers:
            raise RuntimeError("Neither GEMINI_API_KEY, GROQ_API_KEY, nor MISTRAL_API_KEY is set")

        last_error: Exception | None = None
        for i, provider in enumerate(providers):
            try:
                if i > 0:
                    logger.warning("[LLM] fallback provider: %s", provider)
                async for delta in self._get_backend(provider).stream_text(messages):
                    yield delta
                return
            except Exception as exc:
                last_error = exc
                logger.warning("[LLM] %s failed: %s", provider, exc)
                if i < len(providers) - 1:
                    continue
                raise

        raise last_error or RuntimeError("LLM request failed")


_llm: LlmClient | None = None


def get_llm() -> LlmClient:
    global _llm
    if _llm is None:
        _llm = LlmClient()
    return _llm


def get_groq() -> LlmClient:
    """Backward-compatible alias."""
    return get_llm()
