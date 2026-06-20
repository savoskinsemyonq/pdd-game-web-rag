import type { AuthUser } from "../state/authStore";

export function canUseEditors(user: AuthUser | null): boolean {
  return user?.isAdmin === true;
}
