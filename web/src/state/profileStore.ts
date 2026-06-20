import { create } from "zustand";
import { useAuthStore } from "./authStore";

export interface BestRecord {
  fine: number;
  lostTime: number;
  attempts: number;
  completedAt: number;
}

export interface ChatMessageRecord {
  role: "user" | "assistant";
  content: string;
}

export interface ChatSessionRecord {
  errorContext: string;
  messages: ChatMessageRecord[];
}

export interface RunHistoryEntry {
  sceneId: string;
  pickedCase: number;
  isCorrect: boolean;
  fine: number;
  licenseRevokeMonths: number | null;
  lostTime: number;
  errorInfo: string | null;
  topics: string[];
}

export interface RunRecord {
  id: string;
  missionId: string;
  missionTitle: string;
  completedAt: number;
  correct: number;
  total: number;
  totalFine: number;
  totalLostTime: number;
  history: RunHistoryEntry[];
  chatSessions: ChatSessionRecord[];
}

export interface Profile {
  id: string;
  name: string;
  createdAt: number;
  bestByMission: Record<string, BestRecord | undefined>;
  topicsToReview: Record<string, string[]>;
  runs: RunRecord[];
}

interface ProfileStoreState {
  profiles: Profile[];
  activeProfileId: string | null;
  serverSynced: boolean;
  hydrate: () => void;
  syncFromServer: () => Promise<void>;
  importActiveGuestProfile: () => Promise<boolean>;
  ensureGuestProfile: () => Profile;
  createProfile: (name: string) => Promise<Profile>;
  deleteProfile: (id: string) => Promise<void>;
  setActiveProfile: (id: string) => Promise<void>;
  activeProfile: () => Profile | null;
  updateMissionResult: (
    missionId: string,
    candidate: BestRecord,
    topics: string[]
  ) => void;
  addRunRecord: (record: RunRecord) => void;
}

const PROFILES_KEY = "pdd-web::profiles";
const ACTIVE_KEY = "pdd-web::activeProfileId";
const IMPORTED_KEY = "pdd-web::server-imported";

function loadProfiles(): Profile[] {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (JSON.parse(raw) as any[]).map((p) => ({ runs: [], ...p }));
  } catch {
    return [];
  }
}

function saveProfiles(profiles: Profile[]) {
  try {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  } catch {
    // ignore
  }
}

function saveActiveId(id: string | null) {
  try {
    if (id == null) localStorage.removeItem(ACTIVE_KEY);
    else localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // ignore
  }
}

function getActiveGuestProfile(): Profile | null {
  const profiles = loadProfiles();
  const storedId = localStorage.getItem(ACTIVE_KEY);
  const active = storedId ? profiles.find((p) => p.id === storedId) : profiles[0];
  if (!active) return null;
  return { ...active, runs: active.runs ?? [] };
}

async function isLoggedIn(): Promise<boolean> {
  const user = useAuthStore.getState().user;
  if (user) return true;
  try {
    const res = await fetch("/api/auth/me", { credentials: "include" });
    const data = (await res.json()) as { user: unknown };
    return Boolean(data.user);
  } catch {
    return false;
  }
}

export const useProfileStore = create<ProfileStoreState>((set, get) => ({
  profiles: [],
  activeProfileId: null,
  serverSynced: false,

  hydrate: () => {
    const profiles = loadProfiles();
    const storedId = localStorage.getItem(ACTIVE_KEY);
    const activeProfileId =
      storedId && profiles.some((p) => p.id === storedId) ? storedId : null;
    set({ profiles, activeProfileId });
  },

  syncFromServer: async () => {
    if (!(await isLoggedIn())) return;
    const authUser = useAuthStore.getState().user;
    try {
      const res = await fetch("/api/account", { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as { profile: Profile };
      const profile = data.profile;
      const profiles = [profile];
      const activeProfileId = authUser?.profileId ?? profile.id;
      set({
        profiles,
        activeProfileId,
        serverSynced: true,
      });
      saveProfiles(profiles);
      saveActiveId(activeProfileId);
    } catch {
      // keep local
    }
  },

  importActiveGuestProfile: async () => {
    if (!(await isLoggedIn())) return false;
    if (localStorage.getItem(IMPORTED_KEY)) return false;
    const guest = getActiveGuestProfile();
    if (!guest || ((guest.runs?.length ?? 0) === 0 && Object.keys(guest.bestByMission).length === 0)) {
      return false;
    }
    try {
      const res = await fetch("/api/profiles/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ profile: guest }),
      });
      if (!res.ok) return false;
      localStorage.setItem(IMPORTED_KEY, "1");
      await get().syncFromServer();
      return true;
    } catch {
      return false;
    }
  },

  ensureGuestProfile: () => {
    const existing = get().activeProfile();
    if (existing) return existing;
    const profiles = loadProfiles();
    if (profiles.length > 0) {
      const id = profiles[0].id;
      set({ profiles, activeProfileId: id });
      saveActiveId(id);
      return profiles[0];
    }
    const profile: Profile = {
      id: crypto.randomUUID(),
      name: "Гость",
      createdAt: Date.now(),
      bestByMission: {},
      topicsToReview: {},
      runs: [],
    };
    const next = [profile];
    set({ profiles: next, activeProfileId: profile.id });
    saveProfiles(next);
    saveActiveId(profile.id);
    return profile;
  },

  createProfile: async (name: string) => {
    if (await isLoggedIn()) {
      const res = await fetch("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: name.trim() }),
      });
      if (res.ok) {
        const data = (await res.json()) as { profile: Profile };
        const next = [data.profile];
        set({ profiles: next, activeProfileId: data.profile.id });
        saveProfiles(next);
        saveActiveId(data.profile.id);
        return data.profile;
      }
    }
    const profile: Profile = {
      id: crypto.randomUUID(),
      name: name.trim(),
      createdAt: Date.now(),
      bestByMission: {},
      topicsToReview: {},
      runs: [],
    };
    const next = [profile];
    set({ profiles: next, activeProfileId: profile.id });
    saveProfiles(next);
    saveActiveId(profile.id);
    return profile;
  },

  deleteProfile: async (id: string) => {
    if (await isLoggedIn()) {
      await fetch(`/api/profiles/${id}`, { method: "DELETE", credentials: "include" });
    }
    const next = get().profiles.filter((p) => p.id !== id);
    const activeProfileId =
      get().activeProfileId === id ? null : get().activeProfileId;
    set({ profiles: next, activeProfileId });
    saveProfiles(next);
    saveActiveId(activeProfileId);
  },

  setActiveProfile: async (id: string) => {
    set({ activeProfileId: id });
    saveActiveId(id);
    if (await isLoggedIn()) {
      await fetch(`/api/profiles/${id}/active`, {
        method: "POST",
        credentials: "include",
      });
    }
  },

  activeProfile: () => {
    const { profiles, activeProfileId } = get();
    return profiles.find((p) => p.id === activeProfileId) ?? null;
  },

  updateMissionResult: (missionId, candidate, topics) => {
    const { profiles, activeProfileId } = get();
    if (!activeProfileId) return;
    const next = profiles.map((p) => {
      if (p.id !== activeProfileId) return p;
      const prev = p.bestByMission[missionId];
      const better =
        !prev ||
        candidate.fine < prev.fine ||
        (candidate.fine === prev.fine && candidate.lostTime < prev.lostTime);
      const record: BestRecord = better
        ? candidate
        : { ...prev!, attempts: candidate.attempts };
      return {
        ...p,
        bestByMission: { ...p.bestByMission, [missionId]: record },
        topicsToReview: { ...p.topicsToReview, [missionId]: topics },
      };
    });
    set({ profiles: next });
    saveProfiles(next);
  },

  addRunRecord: (record) => {
    const { profiles, activeProfileId } = get();
    if (!activeProfileId) return;
    const profile = profiles.find((p) => p.id === activeProfileId);
    if (!profile) return;
    const next = profiles.map((p) =>
      p.id !== activeProfileId ? p : { ...p, runs: [...(p.runs ?? []), record] }
    );
    set({ profiles: next });
    saveProfiles(next);

    void (async () => {
      if (!(await isLoggedIn())) return;
      await fetch(`/api/profiles/${activeProfileId}/runs`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          run: {
            ...record,
            bestByMission: profile.bestByMission,
            topicsToReview: profile.topicsToReview,
          },
        }),
      });
    })();
  },
}));
