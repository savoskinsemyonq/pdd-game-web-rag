from __future__ import annotations

import logging
import os
from urllib.parse import urlparse, urlunparse

import httpx

logger = logging.getLogger(__name__)

_proxy_client: httpx.AsyncClient | None = None


def get_llm_proxy_url() -> str | None:
    dedicated = os.environ.get("LLM_PROXY", "").strip()
    if dedicated:
        return dedicated

    if os.environ.get("LLM_USE_SYSTEM_PROXY", "").strip() == "1":
        return os.environ.get("HTTPS_PROXY", "").strip() or os.environ.get("HTTP_PROXY", "").strip() or None

    return None


def _mask_proxy_url(url: str) -> str:
    try:
        parsed = urlparse(url)
        if parsed.password:
            netloc = parsed.hostname or ""
            if parsed.username:
                netloc = f"{parsed.username[:2]}***:{parsed.password}@{netloc}"
            if parsed.port:
                netloc = f"{netloc}:{parsed.port}"
            parsed = parsed._replace(netloc=netloc)
        return urlunparse(parsed)
    except Exception:
        return "[proxy]"


def get_llm_http_client() -> httpx.AsyncClient | None:
    global _proxy_client
    proxy = get_llm_proxy_url()
    if not proxy:
        return None

    if _proxy_client is None:
        _proxy_client = httpx.AsyncClient(proxy=proxy, timeout=120.0)
        logger.info("[LLM] proxy enabled: %s", _mask_proxy_url(proxy))

    return _proxy_client


def gemini_http_options(types_module):
    proxy = get_llm_proxy_url()
    if not proxy:
        return types_module.HttpOptions(timeout=120_000)

    return types_module.HttpOptions(
        timeout=120_000,
        client_args={"proxy": proxy},
        async_client_args={"proxy": proxy},
    )
