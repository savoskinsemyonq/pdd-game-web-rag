import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

const COOKIE_NAME = "pdd_token";
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-in-production";

export interface AuthUser {
  id: string;
  login: string;
  email: string;
  displayName: string;
  profileId: string | null;
  isAdmin: boolean;
}

export function signToken(user: AuthUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: "30d" });
}

export function verifyToken(token: string): AuthUser | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthUser;
  } catch {
    return null;
  }
}

export function setAuthCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === "production",
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME);
}

export function getTokenFromRequest(req: Request): string | null {
  const cookie = req.headers.cookie ?? "";
  const match = cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (match) return match[1];
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = getTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: "Не авторизован" });
    return;
  }
  const user = verifyToken(token);
  if (!user) {
    res.status(401).json({ error: "Сессия истекла" });
    return;
  }
  (req as Request & { user: AuthUser }).user = user;
  next();
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = getTokenFromRequest(req);
  if (token) {
    const user = verifyToken(token);
    if (user) (req as Request & { user: AuthUser }).user = user;
  }
  next();
}
