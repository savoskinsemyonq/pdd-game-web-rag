import { create } from "zustand";

export interface AuthUser {
  id: string;
  login: string;
  email: string;
  displayName: string;
  profileId: string | null;
  isAdmin: boolean;
}

interface AuthState {
  user: AuthUser | null;
  checked: boolean;
  hydrate: () => Promise<void>;
  login: (loginOrEmail: string, password: string) => Promise<void>;
  register: (loginOrEmail: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
}

async function parseError(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return (data as { error?: string }).error ?? `Ошибка ${res.status}`;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  checked: false,

  hydrate: async () => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      const data = (await res.json()) as { user: AuthUser | null };
      set({ user: data.user, checked: true });
    } catch {
      set({ user: null, checked: true });
    }
  },

  login: async (loginOrEmail, password) => {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ loginOrEmail, password }),
    });
    if (!res.ok) throw new Error(await parseError(res));
    const data = (await res.json()) as { user: AuthUser };
    set({ user: data.user });
  },

  register: async (loginOrEmail, password, displayName) => {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ loginOrEmail, password, displayName }),
    });
    if (!res.ok) throw new Error(await parseError(res));
    const data = (await res.json()) as { user: AuthUser };
    set({ user: data.user });
  },

  logout: async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    set({ user: null });
  },
}));
