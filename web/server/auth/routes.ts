import type { Request, Response } from "express";

import bcrypt from "bcryptjs";

import { query, isDbAvailable } from "../db/pool.js";

import { setAuthCookie, signToken, clearAuthCookie, getTokenFromRequest, verifyToken } from "./jwt.js";

import type { AuthUser } from "./jwt.js";



interface RegisterBody {

  loginOrEmail: string;

  password: string;

  displayName?: string;

}



interface LoginBody {

  loginOrEmail: string;

  password: string;

}



const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;



function validateLogin(login: string): string | null {

  if (login.length < 3 || login.length > 32) return "Логин: 3–32 символа";

  if (!/^[a-zA-Z0-9_а-яА-ЯёЁ-]+$/.test(login)) return "Логин: только буквы, цифры, _ и -";

  return null;

}



function validateEmail(email: string): string | null {

  if (!EMAIL_RE.test(email)) return "Некорректный email";

  return null;

}



function validatePassword(password: string): string | null {

  if (password.length < 8) return "Пароль: минимум 8 символов";

  return null;

}



function validateDisplayName(name: string): string | null {

  const trimmed = name.trim();

  if (trimmed.length < 2 || trimmed.length > 64) return "Имя: 2–64 символа";

  return null;

}



function loginFromEmail(email: string): string {

  const local = email.split("@")[0]

    .replace(/[^a-zA-Z0-9_а-яА-ЯёЁ-]/g, "_")

    .replace(/_+/g, "_")

    .replace(/^_|_$/g, "")

    .slice(0, 32);

  if (local.length >= 3) return local;

  return `user_${local || "pdd"}`.slice(0, 32);

}



function resolveRegisterIdentity(loginOrEmail: string): { login: string; email: string } | { error: string } {

  const input = loginOrEmail.trim();

  if (!input) return { error: "Введите логин или email" };



  if (input.includes("@")) {

    const email = input.toLowerCase();

    const emailErr = validateEmail(email);

    if (emailErr) return { error: emailErr };

    const login = loginFromEmail(email);

    const loginErr = validateLogin(login);

    if (loginErr) return { error: loginErr };

    return { login, email };

  }



  const loginErr = validateLogin(input);

  if (loginErr) return { error: loginErr };

  return { login: input, email: `${input.toLowerCase()}@pdd.local` };

}

function resolveIsAdmin(login: string, dbIsAdmin: boolean): boolean {
  if (dbIsAdmin) return true;
  const raw = process.env.ADMIN_LOGINS ?? "";
  if (!raw.trim()) return false;
  const needle = login.toLowerCase();
  return raw.split(",").some((entry) => entry.trim().toLowerCase() === needle);
}

async function fetchAuthUser(userId: string): Promise<AuthUser | null> {
  const userResult = await query<{
    id: string;
    login: string;
    email: string;
    display_name: string;
    is_admin: boolean;
  }>(
    `SELECT id, login, email, display_name, is_admin FROM users WHERE id = $1`,
    [userId],
  );
  const user = userResult.rows[0];
  if (!user) return null;

  const profileResult = await query<{ id: string }>(
    `SELECT id FROM profiles WHERE user_id = $1
     ORDER BY is_active DESC, created_at ASC LIMIT 1`,
    [userId],
  );

  return {
    id: user.id,
    login: user.login,
    email: user.email,
    displayName: user.display_name || user.login,
    profileId: profileResult.rows[0]?.id ?? null,
    isAdmin: resolveIsAdmin(user.login, user.is_admin),
  };
}



export async function handleRegister(req: Request, res: Response): Promise<void> {

  if (!isDbAvailable()) {

    res.status(503).json({ error: "База данных недоступна. Проверьте DATABASE_URL и что Postgres запущен." });

    return;

  }

  const { loginOrEmail, password, displayName } = req.body as RegisterBody;

  const passErr = validatePassword(password ?? "");

  if (passErr) { res.status(400).json({ error: passErr }); return; }



  const nameErr = validateDisplayName(displayName ?? "");

  if (nameErr) { res.status(400).json({ error: nameErr }); return; }

  const name = (displayName ?? "").trim();



  const identity = resolveRegisterIdentity(loginOrEmail ?? "");

  if ("error" in identity) {

    res.status(400).json({ error: identity.error });

    return;

  }



  let { login, email } = identity;

  const hash = await bcrypt.hash(password, 10);



  for (let attempt = 0; attempt < 5; attempt++) {

    try {

      const result = await query<{ id: string; login: string; email: string; display_name: string }>(

        `INSERT INTO users (login, email, password_hash, display_name)

         VALUES ($1, $2, $3, $4)

         RETURNING id, login, email, display_name`,

        [login, email, hash, name],

      );

      const user = result.rows[0];

      const profileResult = await query<{ id: string }>(

        `INSERT INTO profiles (user_id, name, is_active)

         VALUES ($1, $2, TRUE)

         RETURNING id`,

        [user.id, name],

      );

      const profileId = profileResult.rows[0].id;

      const authUser = await fetchAuthUser(user.id);
      if (!authUser) {
        res.status(500).json({ error: "Не удалось загрузить профиль" });
        return;
      }

      const token = signToken(authUser);

      setAuthCookie(res, token);

      res.json({ user: authUser });

      return;

    } catch (err: unknown) {

      const msg = err instanceof Error ? err.message : String(err);

      if (msg.includes("users_email_key") || msg.includes("email")) {

        res.status(409).json({ error: "Этот email уже зарегистрирован" });

        return;

      }

      if (msg.includes("users_login_key") || msg.includes("login")) {

        login = `${login.slice(0, 28)}_${attempt + 1}`;

        continue;

      }

      if (msg.includes("unique") || msg.includes("duplicate")) {

        res.status(409).json({ error: "Логин или email уже занят" });

        return;

      }

      res.status(500).json({ error: msg });

      return;

    }

  }

  res.status(409).json({ error: "Не удалось создать аккаунт — попробуйте другой логин или email" });

}



export async function handleLogin(req: Request, res: Response): Promise<void> {

  if (!isDbAvailable()) {

    res.status(503).json({ error: "База данных недоступна. Проверьте DATABASE_URL и что Postgres запущен." });

    return;

  }

  const { loginOrEmail, password } = req.body as LoginBody;

  if (!loginOrEmail || !password) {

    res.status(400).json({ error: "Введите логин/email и пароль" });

    return;

  }

  const needle = loginOrEmail.trim();

  const result = await query<{ id: string; login: string; email: string; password_hash: string }>(

    `SELECT id, login, email, password_hash FROM users

     WHERE login = $1 OR email = $1 OR email = $2 LIMIT 1`,

    [needle, needle.toLowerCase()],

  );

  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {

    res.status(401).json({ error: "Неверный логин или пароль" });

    return;

  }

  const authUser = await fetchAuthUser(user.id);

  if (!authUser) {

    res.status(500).json({ error: "Не удалось загрузить профиль" });

    return;

  }

  const token = signToken(authUser);

  setAuthCookie(res, token);

  res.json({ user: authUser });

}



export async function handleLogout(_req: Request, res: Response): Promise<void> {

  clearAuthCookie(res);

  res.json({ ok: true });

}



export async function handleMe(req: Request, res: Response): Promise<void> {

  const token = getTokenFromRequest(req);

  if (!token) {

    res.json({ user: null });

    return;

  }

  const decoded = verifyToken(token);

  if (!decoded) {

    res.json({ user: null });

    return;

  }

  if (!isDbAvailable()) {

    res.json({ user: { ...decoded, isAdmin: decoded.isAdmin === true } });

    return;

  }

  const authUser = await fetchAuthUser(decoded.id);

  res.json({ user: authUser ?? { ...decoded, isAdmin: decoded.isAdmin === true } });

}

