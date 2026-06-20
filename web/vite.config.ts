import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Домены туннелей (Cloudpub и др.) — Vite иначе блокирует Host из внешней ссылки. */
function tunnelAllowedHosts(): string[] {
  const hosts = [".cloudpub.ru", ".localhost"];
  const extra =
    process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS ??
    process.env.VITE_TUNNEL_HOST;
  if (extra) {
    for (const h of extra.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!hosts.includes(h)) hosts.push(h);
    }
  }
  return hosts;
}

function tunnelHmrHost(): string | undefined {
  return process.env.VITE_TUNNEL_HOST?.trim() || undefined;
}

function tunnelPublicOrigin(): string | undefined {
  const host = tunnelHmrHost();
  if (!host) return undefined;
  const port = process.env.VITE_TUNNEL_PORT?.trim();
  if (port && port !== "443" && port !== "80") {
    return `https://${host}:${port}`;
  }
  return `https://${host}`;
}

const tunnelHost = tunnelHmrHost();
const tunnelOrigin = tunnelPublicOrigin();

export default defineConfig({
  plugins: [react()],
  server: {
    // 0.0.0.0 — туннель (Cloudpub) может стучаться не только в 127.0.0.1
    host: tunnelHost ? true : "127.0.0.1",
    port: 5173,
    strictPort: true,
    open: !tunnelHost,
    allowedHosts: tunnelAllowedHosts(),
    ...(tunnelOrigin ? { origin: tunnelOrigin } : {}),
    hmr: tunnelHost
      ? {
          host: tunnelHost,
          protocol: "wss",
          clientPort: Number(process.env.VITE_TUNNEL_PORT ?? 443),
        }
      : undefined,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: true,
    port: 5173,
    allowedHosts: tunnelAllowedHosts(),
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
});
