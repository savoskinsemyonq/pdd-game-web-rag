import { create } from "zustand";
import type { Mission, MissionsData } from "../types";
import type { RunnerState } from "../engine/SceneRunner";
import { useProfileStore, type BestRecord, type ChatSessionRecord } from "./profileStore";
import { summarizeErrorTopics } from "../utils/reviewPlan";
import { getUnfixedTopicsForMission } from "../utils/profileAnalytics";
import data from "../data/missions.json";

const missionsData = data as unknown as MissionsData;

export type Screen = "auth" | "menu" | "profiles" | "missionSelect" | "playing" | "result" | "editor";

interface GameStoreState {
  screen: Screen;
  missions: Mission[];
  selectedMission: Mission | null;
  runnerState: RunnerState | null;
  bestByMission: Record<string, BestRecord | undefined>;
  chatSessions: ChatSessionRecord[];
  missionFinished: boolean;
  setScreen: (s: Screen) => void;
  setMissionList: () => void;
  selectMission: (m: Mission) => void;
  beginMission: (m: Mission) => void;
  setRunnerState: (s: RunnerState) => void;
  addChatSession: (session: ChatSessionRecord) => void;
  finishMission: () => void;
  resetToMenu: () => void;
  hydrate: () => void;
  syncBestFromProfile: () => void;
}

export const useGameStore = create<GameStoreState>((set, get) => ({
  screen: "auth",
  missions: missionsData.missions,
  selectedMission: null,
  runnerState: null,
  bestByMission: {},
  chatSessions: [],
  missionFinished: false,

  setScreen: (s) => set({ screen: s }),
  setMissionList: () => set({ missions: missionsData.missions }),
  selectMission: (m) => set({ selectedMission: m, screen: "missionSelect" }),

  beginMission: (m) => {
    set({ selectedMission: m, screen: "playing", runnerState: null, chatSessions: [], missionFinished: false });
  },

  addChatSession: (session) => {
    set((s) => ({ chatSessions: [...s.chatSessions, session] }));
  },

  setRunnerState: (s) => {
    set({ runnerState: s });
    if (s.phase === "missionResult" && !get().missionFinished) {
      set({ missionFinished: true });
      get().finishMission();
    }
  },

  finishMission: () => {
    const { runnerState, selectedMission, chatSessions } = get();
    if (!runnerState || !selectedMission) return;
    const id = selectedMission.id;
    const profileStore = useProfileStore.getState();
    const prev = profileStore.activeProfile()?.bestByMission[id];
    const now = Date.now();
    const candidate: BestRecord = {
      fine: runnerState.totalFine,
      lostTime: runnerState.totalLostTime,
      attempts: (prev?.attempts ?? 0) + 1,
      completedAt: now,
    };
    const history = runnerState.history.map((h) => ({
      sceneId: h.sceneId,
      pickedCase: h.pickedCase,
      isCorrect: h.isCorrect,
      fine: h.fine,
      licenseRevokeMonths: h.licenseRevokeMonths,
      lostTime: h.lostTime,
      errorInfo: h.errorInfo,
      topics: h.topics,
    }));
    const profile = profileStore.activeProfile();
    const topics = profile
      ? getUnfixedTopicsForMission(profile, id, history)
      : summarizeErrorTopics(
          runnerState.history
            .filter((h) => !h.isCorrect && h.errorInfo)
            .map((h) => ({ errorInfo: h.errorInfo!, sceneId: h.sceneId })),
        ).map((t) => t.title);
    const uniqueTopics = [...new Set(topics)];
    profileStore.updateMissionResult(id, candidate, uniqueTopics);
    profileStore.addRunRecord({
      id: crypto.randomUUID(),
      missionId: id,
      missionTitle: selectedMission.title,
      completedAt: now,
      correct: runnerState.history.filter((h) => h.isCorrect).length,
      total: runnerState.history.length,
      totalFine: runnerState.totalFine,
      totalLostTime: runnerState.totalLostTime,
      history,
      chatSessions,
    });
    get().syncBestFromProfile();
    set({ screen: "result" });
  },

  resetToMenu: () =>
    set({ screen: "menu", selectedMission: null, runnerState: null }),

  hydrate: () => {
    useProfileStore.getState().hydrate();
    get().syncBestFromProfile();
  },

  syncBestFromProfile: () => {
    const profile = useProfileStore.getState().activeProfile();
    set({ bestByMission: profile?.bestByMission ?? {} });
  },
}));
