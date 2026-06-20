import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import { initLlmProxy } from "./llmProxy.js";
import { handleChat } from "./chat.js";
import { handleAnalyze } from "./analyze.js";
import { handleTts } from "./tts.js";
import { checkRagHealth, isRagAvailable } from "./ragClient.js";
import { checkTtsHealth } from "./ttsClient.js";
import {
  handleRegister,
  handleLogin,
  handleLogout,
  handleMe,
} from "./auth/routes.js";
import { requireAuth, optionalAuth } from "./auth/jwt.js";
import {
  handleListProfiles,
  handleGetAccount,
  handleCreateProfile,
  handleDeleteProfile,
  handleSetActiveProfile,
  handleGetRuns,
  handleAddRun,
  handleImportProfiles,
} from "./profiles/routes.js";
import { runMigrations } from "./db/migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
initLlmProxy();
const app = express();
const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "127.0.0.1";

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

app.post("/api/chat", handleChat);
app.post("/api/analyze", handleAnalyze);
app.post("/api/tts", handleTts);

app.post("/api/auth/register", handleRegister);
app.post("/api/auth/login", handleLogin);
app.post("/api/auth/logout", handleLogout);
app.get("/api/auth/me", optionalAuth, handleMe);

app.get("/api/account", requireAuth, handleGetAccount);
app.get("/api/profiles", requireAuth, handleListProfiles);
app.post("/api/profiles", requireAuth, handleCreateProfile);
app.delete("/api/profiles/:id", requireAuth, handleDeleteProfile);
app.post("/api/profiles/:id/active", requireAuth, handleSetActiveProfile);
app.get("/api/profiles/:id/runs", requireAuth, handleGetRuns);
app.put("/api/profiles/:id/runs", requireAuth, handleAddRun);
app.post("/api/profiles/import", requireAuth, handleImportProfiles);

const distPath = path.resolve(__dirname, "../dist");
app.use(express.static(distPath));
app.get("*splat", (_req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

async function start() {
  if (process.env.DATABASE_URL) {
    try {
      await runMigrations();
      console.log("[db] migrations ok");
    } catch (err) {
      console.error("[db] migration failed:", err instanceof Error ? err.message : err);
    }
  }

  app.listen(PORT, HOST, async () => {
  console.log(`PDD server running on http://${HOST}:${PORT}`);
  const llmProvider = process.env.LLM_PROVIDER ?? "gemini";
  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  const hasGroq = Boolean(process.env.GROQ_API_KEY);
  const hasMistral = Boolean(process.env.MISTRAL_API_KEY);
  if (!hasGemini && !hasGroq && !hasMistral) {
    console.warn(
      "[LLM] WARNING: ни GEMINI_API_KEY, ни GROQ_API_KEY, ни MISTRAL_API_KEY не заданы — чат и анализ недоступны",
    );
  } else {
    console.log(
      `[LLM] provider=${llmProvider}, gemini=${hasGemini}, groq=${hasGroq}, mistral=${hasMistral}`,
    );
  }
  if (isRagAvailable()) {
    const health = await checkRagHealth();
    if (health.ok) {
      const points =
        health.qdrantPoints != null ? `, qdrant_points=${health.qdrantPoints}` : "";
      console.log(`[RAG] API ok${points}`);
      if (health.qdrantPoints === 0) {
        console.warn("[RAG] WARNING: Qdrant пуст — будет локальный fallback до индексации");
      }
    } else {
      console.warn(
        `[RAG] WARNING: API недоступен (${health.detail ?? "unknown"}) — будет локальный fallback`,
      );
    }
  }

  const ttsHealth = await checkTtsHealth();
  if (ttsHealth.ok) {
    console.log(`[TTS] API ok${ttsHealth.ttsReady ? ", model ready" : ", lazy load"}`);
  } else {
    console.warn(`[TTS] WARNING: API недоступен (${ttsHealth.detail ?? "unknown"})`);
  }
  });
}

void start();
