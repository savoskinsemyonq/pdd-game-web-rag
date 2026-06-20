import { ProxyAgent, fetch as undiciFetch } from "undici";

const LLM_API_HOSTS = new Set([
  "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com",
  "api.mistral.ai",
  "api.groq.com",
]);

let proxyAgent: ProxyAgent | undefined;
let originalFetch: typeof globalThis.fetch | undefined;
let installed = false;

export function getLlmProxyUrl(): string | undefined {
  const dedicated = process.env.LLM_PROXY?.trim();
  if (dedicated) return dedicated;

  if (process.env.LLM_USE_SYSTEM_PROXY === "1") {
    return process.env.HTTPS_PROXY?.trim() || process.env.HTTP_PROXY?.trim() || undefined;
  }

  return undefined;
}

function maskProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    if (parsed.username) parsed.username = `${parsed.username.slice(0, 2)}***`;
    return parsed.toString();
  } catch {
    return "[proxy]";
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isNoProxyHost(hostname: string): boolean {
  const raw = process.env.NO_PROXY ?? process.env.no_proxy ?? "localhost,127.0.0.1,::1";
  for (const entry of raw.split(",").map((part) => part.trim()).filter(Boolean)) {
    if (entry === "*") return true;
    if (entry === hostname) return true;
    if (entry.startsWith(".") && hostname.endsWith(entry)) return true;
  }
  return false;
}

function isLlmApiHost(hostname: string): boolean {
  for (const host of LLM_API_HOSTS) {
    if (hostname === host || hostname.endsWith(`.${host}`)) return true;
  }
  return false;
}

export function shouldProxyUrl(url: string): boolean {
  if (!proxyAgent) return false;
  try {
    const hostname = new URL(url).hostname;
    if (isNoProxyHost(hostname)) return false;
    return isLlmApiHost(hostname);
  } catch {
    return false;
  }
}

/** Патчит global fetch: прокси только для LLM API (Gemini, Groq, Mistral). */
export function initLlmProxy(): boolean {
  if (installed) return Boolean(proxyAgent);

  const url = getLlmProxyUrl();
  if (!url) return false;

  proxyAgent = new ProxyAgent(url);
  originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const href = requestUrl(input);
    if (shouldProxyUrl(href)) {
      return undiciFetch(href, {
        ...init,
        dispatcher: proxyAgent,
      } as Parameters<typeof undiciFetch>[1]);
    }
    return originalFetch!(input as RequestInfo, init);
  }) as typeof globalThis.fetch;

  installed = true;
  console.log(`[LLM] proxy enabled: ${maskProxyUrl(url)}`);
  return true;
}
