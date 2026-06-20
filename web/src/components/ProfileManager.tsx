import { useEffect, useMemo, useRef, useState } from "react";
import { useProfileStore, type Profile, type RunRecord } from "../state/profileStore";
import { useGameStore } from "../state/gameStore";
import { useAuthStore } from "../state/authStore";
import { PddChat } from "./PddChat";
import { ProfileDashboard } from "./ProfileDashboard";
import { buildErrorPriorities, extractAnalysisTopics, isAnalysisSectionHeading, normalizeAnalysisSectionHeading } from "../utils/profileAnalytics";
import type { ReviewMissionPlan } from "../utils/reviewPlan";
import { useSileroTts } from "../hooks/useSileroTts";
import { TtsControls } from "./TtsControls";

interface Props {
  onSelect: () => void;
  onBack?: () => void;
  onLogout?: () => void;
}

type SubView = "home" | "stats" | "history" | "analysis";

function RunHistoryViewer({ profile, onBack }: { profile: Profile; onBack: () => void }) {
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const runs = [...(profile.runs ?? [])].sort((a, b) => b.completedAt - a.completedAt);

  return (
    <div className="menu menu--scroll">
      <button className="run-history__back" onClick={onBack}>← Назад</button>
      <h1>История прохождений</h1>
      <p style={{ color: "#9ca3af", fontSize: 14 }}>{profile.name}</p>

      <div className="run-history">
        {runs.length === 0 && (
          <p className="run-history__empty">Пока нет ни одного прохождения.</p>
        )}
        {runs.map((run) => (
          <RunCard
            key={run.id}
            run={run}
            expanded={expandedRunId === run.id}
            onToggle={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}
          />
        ))}
      </div>
    </div>
  );
}

function RunCard({ run, expanded, onToggle }: { run: RunRecord; expanded: boolean; onToggle: () => void }) {
  const allOk = run.correct === run.total;
  const date = new Date(run.completedAt).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  return (
    <div className="run-card">
      <div className="run-card__header" onClick={onToggle}>
        <div>
          <div className="run-card__title">{run.missionTitle}</div>
          <div className="run-card__meta">
            <span>{date}</span>
            <span className={allOk ? "run-card__score--ok" : "run-card__score--bad"}>
              {run.correct}/{run.total} верных
            </span>
            {run.totalFine > 0 && <span>Штраф: {run.totalFine} ₽</span>}
            {run.totalLostTime > 0 && <span>Задержка: {run.totalLostTime} мин</span>}
          </div>
        </div>
        <span className={`run-card__chevron ${expanded ? "run-card__chevron--open" : ""}`}>▼</span>
      </div>

      {expanded && (
        <div className="run-card__body">
          <div>
            <div className="run-card__section-title">Ответы</div>
            {run.history.map((h, i) => (
              <div key={i}>
                <div className={`run-card__history-row run-card__history-row--${h.isCorrect ? "ok" : "bad"}`}>
                  <span>Сцена {h.sceneId} · вариант {h.pickedCase}</span>
                  <span>
                    {h.isCorrect
                      ? "верно"
                      : h.licenseRevokeMonths
                        ? `лишение прав до ${h.licenseRevokeMonths} мес.`
                        : `штраф ${h.fine} ₽`}
                  </span>
                </div>
                {!h.isCorrect && h.errorInfo && (
                  <div className="run-card__error-info">{h.errorInfo}</div>
                )}
              </div>
            ))}
          </div>

          {run.chatSessions.length > 0 && (
            <div>
              <div className="run-card__section-title">Диалоги с инспектором ({run.chatSessions.length})</div>
              {run.chatSessions.map((session, si) => (
                <div key={si} style={{ marginBottom: 12 }}>
                  {session.errorContext && (
                    <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6 }}>
                      Контекст: {session.errorContext}
                    </div>
                  )}
                  <div className="run-card__chat">
                    {session.messages.map((msg, mi) => (
                      <div key={mi} className={`run-card__chat-msg run-card__chat-msg--${msg.role}`}>
                        <div className="run-card__chat-label">
                          {msg.role === "assistant" ? "Инспектор" : "Вы"}
                        </div>
                        <div>{msg.content}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AnalysisViewer({ profile, onBack }: { profile: Profile; onBack: () => void }) {
  const user = useAuthStore((s) => s.user);
  const studentName = user?.displayName ?? profile.name;
  const [analysisText, setAnalysisText] = useState("");
  const [ruleRefs, setRuleRefs] = useState<string[]>([]);
  const [missionPlan, setMissionPlan] = useState<ReviewMissionPlan[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const startedRef = useRef(false);
  const {
    speak,
    pause,
    resume,
    stop,
    state: ttsState,
    error: ttsError,
  } = useSileroTts();

  const canSpeakAnalysis = done && analysisText.trim().length > 0 && !streaming;

  const prioritized = buildErrorPriorities(profile);
  const relevant = prioritized.filter((e) => e.priority !== "low" || !e.wasFixed);

  const chatContext = useMemo(() => {
    return [
      `Имя ученика: ${studentName}`,
      `Анализ ошибок:`,
      analysisText,
      "",
      "Частые ошибки:",
      ...relevant.map((e) => `- ${e.errorInfo}`),
    ].join("\n");
  }, [studentName, analysisText, relevant]);

  const topicChips = useMemo(() => {
    const fromText = extractAnalysisTopics(analysisText);
    const merged = [...ruleRefs];
    for (const t of fromText) {
      if (!merged.includes(t)) merged.push(t);
    }
    return merged;
  }, [analysisText, ruleRefs]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    if (relevant.length === 0) {
      setDone(true);
      return;
    }

    (async () => {
      setStreaming(true);
      try {
        const response = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ errors: prioritized, profileName: studentName }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: "Ошибка сервера" }));
          setError(err.error ?? "Нет ответа от сервера");
          return;
        }

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        if (!reader) return;

        let full = "";
        while (true) {
          const { done: rdDone, value } = await reader.read();
          if (rdDone) break;
          const text = decoder.decode(value, { stream: true });
          for (const line of text.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);
            if (payload === "[DONE]") break;
            try {
              const json = JSON.parse(payload);
              if (json.meta?.ruleRefs) setRuleRefs(json.meta.ruleRefs as string[]);
              if (json.meta?.missionPlan) setMissionPlan(json.meta.missionPlan as ReviewMissionPlan[]);
              if (json.delta) { full += json.delta; setAnalysisText(full); }
              if (json.error) { setError(json.error); }
            } catch { /* skip */ }
          }
        }
      } catch {
        setError("Не удалось получить анализ. Проверьте соединение.");
      } finally {
        setStreaming(false);
        setDone(true);
        setChatOpen(true);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const noErrors = done && analysisText === "" && !error && !streaming;

  return (
    <div className="menu menu--scroll analysis-page">
      <button className="run-history__back" onClick={onBack}>← Назад</button>
      <h1>Анализ ошибок</h1>
      <p style={{ color: "#9ca3af", fontSize: 14 }}>{studentName}</p>

      <div className="analysis-layout">
        <div className="analysis-layout__main">
          {noErrors && (
            <div className="analysis-none">
              Отличный результат! Ошибок не найдено — все правила соблюдены.
            </div>
          )}

          {error && (
            <div className="analysis-result" style={{ color: "#f87171" }}>
              Ошибка: {error}
            </div>
          )}

          {(streaming || analysisText) && !error && (
            <div className="analysis-result-wrap">
              {done && analysisText && !streaming && (
                <div className="analysis-result__toolbar">
                  <TtsControls
                    text={analysisText}
                    state={ttsState}
                    error={ttsError}
                    disabled={!canSpeakAnalysis}
                    variant="toolbar"
                    playLabel="Озвучить анализ"
                    playTitle="Озвучить итоговый анализ"
                    onSpeak={speak}
                    onPause={pause}
                    onResume={resume}
                    onStop={stop}
                  />
                </div>
              )}
              <div className="analysis-result">
                {analysisText.split("\n\n").map((para, i) =>
                  isAnalysisSectionHeading(para) ? (
                    <h3 key={i} className="analysis-result__heading">
                      {normalizeAnalysisSectionHeading(para)}
                    </h3>
                  ) : (
                    <p key={i}>{para}</p>
                  ),
                )}
                {streaming && <span className="analysis-cursor">▍</span>}
              </div>
            </div>
          )}

          {!done && !error && !analysisText && (
            <p className="analysis-loading">Анализирую ошибки…</p>
          )}

          {(missionPlan.length > 0 || topicChips.length > 0) && (
            <div className="analysis-topics">
              <h3>Пункты для повторения</h3>
              {missionPlan.length > 0 ? (
                <div className="review-mission-groups">
                  {missionPlan.map((mission) => (
                    <div key={mission.missionId} className="review-mission-group">
                      <div className="review-mission-group__title">
                        {mission.missionTitle}
                        <span className="review-mission-group__count">×{mission.totalErrors}</span>
                      </div>
                      <div className="review-mission-group__scenes">
                        {mission.scenes.map((scene) => (
                          <div key={`${mission.missionId}:${scene.sceneId}`} className="review-topic-chip review-topic-chip--compact">
                            <span className="review-topic-chip__title">
                              сц. {scene.sceneId} — {scene.title}
                              {scene.errorCount > 1 && (
                                <span className="review-topic-chip__count">×{scene.errorCount}</span>
                              )}
                            </span>
                            <span className="review-topic-chip__ref">{scene.ruleRef}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="analysis-topics__chips">
                  {topicChips.map((t) => (
                    <span key={t} className="topic-chip topic-chip--warn">{t}</span>
                  ))}
                </div>
              )}
            </div>
          )}

          {done && analysisText && (
            <button
              type="button"
              className="analysis-ask-btn"
              onClick={() => setChatOpen(true)}
            >
              Спросить инспектора
            </button>
          )}
        </div>

        {chatOpen && chatContext && (
          <div className="analysis-layout__chat">
            <PddChat
              open
              embedded
              mode="analysis"
              autoExplain={false}
              initialErrorContext={chatContext}
              onClose={() => setChatOpen(false)}
              hideClose={false}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function ProfileManager({ onSelect, onBack, onLogout }: Props) {
  const profiles = useProfileStore((s) => s.profiles);
  const activeProfileId = useProfileStore((s) => s.activeProfileId);
  const syncFromServer = useProfileStore((s) => s.syncFromServer);
  const importActiveGuestProfile = useProfileStore((s) => s.importActiveGuestProfile);
  const ensureGuestProfile = useProfileStore((s) => s.ensureGuestProfile);
  const setActiveProfile = useProfileStore((s) => s.setActiveProfile);
  const syncBestFromProfile = useGameStore((s) => s.syncBestFromProfile);
  const user = useAuthStore((s) => s.user);

  const [subView, setSubView] = useState<SubView>("home");
  const [importPrompt, setImportPrompt] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [editingGuestName, setEditingGuestName] = useState(false);

  useEffect(() => {
    if (user) {
      void syncFromServer();
    } else {
      ensureGuestProfile();
    }
  }, [user, syncFromServer, ensureGuestProfile]);

  useEffect(() => {
    if (!user || subView !== "home") return;
    const imported = localStorage.getItem("pdd-web::server-imported");
    if (imported) return;
    const local = localStorage.getItem("pdd-web::profiles");
    const activeId = localStorage.getItem("pdd-web::activeProfileId");
    if (!local || !activeId) return;
    try {
      const list = JSON.parse(local) as Profile[];
      const active = list.find((p) => p.id === activeId);
      const hasProgress =
        active &&
        ((active.runs?.length ?? 0) > 0 || Object.keys(active.bestByMission ?? {}).length > 0);
      if (hasProgress) setImportPrompt(true);
    } catch {
      // ignore
    }
  }, [user, subView]);

  const profile = profiles.find((p) => p.id === activeProfileId) ?? profiles[0] ?? null;

  if (!profile && !user) {
    return (
      <div className="menu menu--scroll">
        <h1>Добро пожаловать!</h1>
        {editingGuestName ? (
          <form
            className="profile-create-form"
            onSubmit={(e) => {
              e.preventDefault();
              const name = guestName.trim() || "Гость";
              void useProfileStore.getState().createProfile(name).then((p) => {
                void setActiveProfile(p.id);
                setEditingGuestName(false);
              });
            }}
          >
            <input
              autoFocus
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              placeholder="Как тебя зовут?"
              maxLength={32}
            />
            <button type="submit">Начать</button>
          </form>
        ) : (
          <button onClick={() => setEditingGuestName(true)}>Ввести имя</button>
        )}
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="menu menu--scroll">
        <p>Загрузка профиля…</p>
      </div>
    );
  }

  if (subView === "history") {
    return <RunHistoryViewer profile={profile} onBack={() => setSubView("home")} />;
  }

  if (subView === "analysis") {
    return <AnalysisViewer profile={profile} onBack={() => setSubView("home")} />;
  }

  if (subView === "stats") {
    return (
      <div className="menu menu--scroll">
        <button className="run-history__back" onClick={() => setSubView("home")}>← Назад</button>
        <ProfileDashboard profile={profile} />
      </div>
    );
  }

  const missionCount = Object.keys(profile.bestByMission).length;
  const runCount = (profile.runs ?? []).length;
  const displayName = user?.displayName ?? profile.name;

  function handlePlay() {
    void setActiveProfile(profile.id).then(() => {
      syncBestFromProfile();
      onSelect();
    });
  }

  return (
    <div className="menu menu--scroll account-home">
      {onBack && (
        <button type="button" className="run-history__back" onClick={onBack}>
          ← Назад
        </button>
      )}
      <div className="profile-header">
        <h1>Привет, {displayName}!</h1>
        {user ? (
          <div className="profile-header__auth">
            <span>{user.login}</span>
            <button type="button" onClick={() => void onLogout?.()}>
              Выйти
            </button>
          </div>
        ) : (
          <p className="profile-header__guest-hint">
            Гостевой режим — прогресс только на этом устройстве
          </p>
        )}
      </div>

      {importPrompt && (
        <div className="import-banner">
          <p>Перенести прогресс с этого устройства в аккаунт?</p>
          <button
            type="button"
            onClick={() => {
              void importActiveGuestProfile();
              setImportPrompt(false);
            }}
          >
            Перенести
          </button>
          <button
            type="button"
            onClick={() => {
              localStorage.setItem("pdd-web::server-imported", "1");
              setImportPrompt(false);
            }}
          >
            Пропустить
          </button>
        </div>
      )}

      <div className="account-home__summary">
        <p>
          Миссий пройдено: {missionCount} · Попыток: {runCount}
        </p>
      </div>

      <div className="account-home__actions">
        <button type="button" className="account-home__play" onClick={handlePlay}>
          Играть
        </button>
        <button type="button" className="profile-card__action" onClick={() => setSubView("stats")}>
          Статистика
        </button>
        <button type="button" className="profile-card__action" onClick={() => setSubView("history")}>
          История
        </button>
        <button
          type="button"
          className="profile-card__action profile-card__action--primary"
          onClick={() => setSubView("analysis")}
        >
          Анализ
        </button>
      </div>
    </div>
  );
}
