import type { Profile, RunHistoryEntry } from "../state/profileStore";
import { buildReviewPlan } from "./reviewPlan";

export interface ErrorPriority {
  sceneId: string;
  missionId: string;
  missionTitle: string;
  errorInfo: string;
  count: number;
  wasFixed: boolean;
  priority: "high" | "medium" | "low";
}

export function buildErrorPriorities(profile: Profile): ErrorPriority[] {
  const runs = [...(profile.runs ?? [])].sort((a, b) => a.completedAt - b.completedAt);
  const map = new Map<string, {
    sceneId: string;
    missionId: string;
    missionTitle: string;
    errorInfo: string;
    wrongCount: number;
    lastWasCorrect: boolean;
  }>();

  for (const run of runs) {
    for (const h of run.history) {
      const existing = map.get(h.sceneId);
      if (!h.isCorrect && h.errorInfo) {
        map.set(h.sceneId, {
          sceneId: h.sceneId,
          missionId: run.missionId,
          missionTitle: run.missionTitle,
          errorInfo: h.errorInfo,
          wrongCount: (existing?.wrongCount ?? 0) + 1,
          lastWasCorrect: false,
        });
      } else if (h.isCorrect && existing) {
        map.set(h.sceneId, { ...existing, lastWasCorrect: true });
      }
    }
  }

  const priorityOrder = { high: 0, medium: 1, low: 2 };

  return Array.from(map.values())
    .filter((e) => e.wrongCount > 0)
    .map((e) => {
      let priority: "high" | "medium" | "low";
      if (e.lastWasCorrect) {
        priority = "low";
      } else if (e.wrongCount >= 2) {
        priority = "high";
      } else {
        priority = "medium";
      }
      return {
        sceneId: e.sceneId,
        missionId: e.missionId,
        missionTitle: e.missionTitle,
        errorInfo: e.errorInfo,
        count: e.wrongCount,
        wasFixed: e.lastWasCorrect,
        priority,
      };
    })
    .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
}

/** Темы миссии, где остались незакреплённые ошибки по сценам. */
export function getUnfixedTopicsForMission(
  profile: Profile,
  missionId: string,
  pendingHistory?: RunHistoryEntry[],
): string[] {
  const tempRuns = [...(profile.runs ?? [])];
  if (pendingHistory?.length) {
    tempRuns.push({
      id: "__pending__",
      missionId,
      missionTitle: "",
      completedAt: Date.now(),
      correct: 0,
      total: pendingHistory.length,
      totalFine: 0,
      totalLostTime: 0,
      history: pendingHistory,
      chatSessions: [],
    });
  }

  const missionErrors = buildErrorPriorities({ ...profile, runs: tempRuns }).filter(
    (err) => err.missionId === missionId,
  );
  return buildReviewPlan(missionErrors).map((group) => group.title);
}

const ANALYSIS_SECTION_HEADINGS = new Set([
  "Слабые места",
  "Исправлено",
  "План повторения",
  "С чего начать",
]);

export function isAnalysisSectionHeading(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  if (!trimmed || trimmed.includes("\n")) return false;
  const legacy = trimmed.match(/^\d+\)\s*(.+)$/);
  const candidate = (legacy?.[1] ?? trimmed).trim();
  if (ANALYSIS_SECTION_HEADINGS.has(candidate)) return true;
  if (ANALYSIS_SECTION_HEADINGS.has(`${candidate.replace(/:$/, "")}:`)) return true;
  return Boolean(legacy);
}

export function normalizeAnalysisSectionHeading(paragraph: string): string {
  const trimmed = paragraph.trim();
  const legacy = trimmed.match(/^\d+\)\s*(.+)$/);
  return (legacy?.[1] ?? trimmed).replace(/:$/, "").trim();
}

export function extractAnalysisTopics(text: string): string[] {
  const topics: string[] = [];
  const repeatLine = text.match(/повторить\s*:\s*(.+)/i);
  if (repeatLine) {
    for (const part of repeatLine[1].split(/[,;]/)) {
      const t = part.trim();
      if (t) topics.push(t);
    }
  }
  const pddRefs = text.match(/(?:п\.?\s*\d+(?:\.\d+)?|ПДД\s*п\.?\s*\d+(?:\.\d+)?(?:\s*[–-]\s*\d+(?:\.\d+)?)?)/gi);
  if (pddRefs) {
    for (const ref of pddRefs) {
      const normalized = ref.replace(/\s+/g, " ").trim();
      if (!topics.includes(normalized)) topics.push(normalized);
    }
  }
  for (const line of text.split("\n")) {
    const m = line.match(/(?:тема|раздел|пункт)\s*[:\-]?\s*(.+)/i);
    if (m) {
      const t = m[1].trim().slice(0, 48);
      if (t && !topics.includes(t)) topics.push(t);
    }
  }
  return topics;
}
