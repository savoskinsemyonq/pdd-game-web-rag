import { useState } from "react";
import { useAuthStore } from "../state/authStore";

interface Props {
  onGuest: () => void;
  onSuccess: (justRegistered: boolean) => void;
}

export function AuthScreen({ onGuest, onSuccess }: Props) {
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [loginOrEmail, setLoginOrEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const id = loginOrEmail.trim();
      if (mode === "login") {
        await login(id, password);
        onSuccess(false);
      } else {
        await register(id, password, displayName.trim());
        onSuccess(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка авторизации");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="menu menu--scroll auth-screen">
      <h1>PDD Simulator</h1>
      <p className="auth-screen__subtitle">
        Войди в аккаунт, чтобы сохранять прогресс на разных устройствах
      </p>

      <div className="auth-screen__tabs">
        <button
          type="button"
          className={mode === "login" ? "auth-screen__tab--active" : ""}
          onClick={() => setMode("login")}
        >
          Вход
        </button>
        <button
          type="button"
          className={mode === "register" ? "auth-screen__tab--active" : ""}
          onClick={() => setMode("register")}
        >
          Регистрация
        </button>
      </div>

      <form className="auth-screen__form" onSubmit={handleSubmit}>
        {mode === "register" && (
          <label>
            Как тебя зовут?
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Семён"
              autoComplete="nickname"
              required
              minLength={2}
              maxLength={64}
            />
          </label>
        )}
        <label>
          Логин или email
          <input
            value={loginOrEmail}
            onChange={(e) => setLoginOrEmail(e.target.value)}
            placeholder={mode === "register" ? "driver_2024 или you@mail.ru" : "логин или email"}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Пароль
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="минимум 8 символов"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
            minLength={8}
          />
        </label>

        {mode === "register" && (
          <p className="auth-screen__hint">
            Можно указать логин или email — для входа потом используйте то же самое.
          </p>
        )}

        {error && <p className="auth-screen__error">{error}</p>}

        <button type="submit" className="auth-screen__submit" disabled={loading}>
          {loading ? "Подождите…" : mode === "login" ? "Войти" : "Создать аккаунт"}
        </button>
      </form>

      <button type="button" className="auth-screen__guest" onClick={onGuest}>
        Продолжить как гость (без синхронизации)
      </button>
    </div>
  );
}
