import { useMemo, useState } from "react";
import type { Profile } from "../state/profileStore";
import { buildErrorPriorities } from "../utils/profileAnalytics";
import { buildMissionReviewPlan, summarizeErrorTopics, type ErrorTopicSummary } from "../utils/reviewPlan";

interface Props {
  profile: Profile;
}

type ChartMode = "current" | "alltime";

function collectWrongAnswers(profile: Profile) {
  const items: Array<{ errorInfo: string; sceneId: string }> = [];
  for (const run of profile.runs ?? []) {
    for (const h of run.history) {
      if (h.isCorrect || !h.errorInfo) continue;
      items.push({ errorInfo: h.errorInfo, sceneId: h.sceneId });
    }
  }
  return items;
}

function TopicsBarChart({
  topics,
  emptyMessage,
}: {
  topics: ErrorTopicSummary[];
  emptyMessage: string;
}) {
  if (topics.length === 0) {
    return <p className="bar-chart__empty">{emptyMessage}</p>;
  }

  const maxCount = Math.max(1, ...topics.map((t) => t.count));

  return (
    <div className="bar-chart">
      {topics.map((topic) => (
        <div key={topic.key} className="bar-chart__row">
          <span className="bar-chart__label">{topic.title}</span>
          <div className="bar-chart__track">
            <div
              className="bar-chart__fill"
              style={{ width: `${(topic.count / maxCount) * 100}%` }}
            />
          </div>
          <span className="bar-chart__count">{topic.count}</span>
        </div>
      ))}
    </div>
  );
}

function TopicsModeToggle({
  chartMode,
  onChange,
}: {
  chartMode: ChartMode;
  onChange: (mode: ChartMode) => void;
}) {
  return (
    <div className="chart-mode-toggle" role="tablist" aria-label="Режим статистики ошибок">
      <button
        type="button"
        role="tab"
        aria-selected={chartMode === "current"}
        className={`chart-mode-toggle__btn ${chartMode === "current" ? "chart-mode-toggle__btn--active" : ""}`}
        onClick={() => onChange("current")}
      >
        Актуальные
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={chartMode === "alltime"}
        className={`chart-mode-toggle__btn ${chartMode === "alltime" ? "chart-mode-toggle__btn--active" : ""}`}
        onClick={() => onChange("alltime")}
      >
        За всё время
      </button>
    </div>
  );
}

export function ProfileDashboard({ profile }: Props) {
  const [chartMode, setChartMode] = useState<ChartMode>("current");

  const runs = [...(profile.runs ?? [])].sort((a, b) => b.completedAt - a.completedAt);
  const recentRuns = runs.slice(0, 5);

  const totalAnswers = runs.reduce((s, r) => s + r.total, 0);
  const totalCorrect = runs.reduce((s, r) => s + r.correct, 0);
  const progressPct = totalAnswers > 0 ? Math.round((totalCorrect / totalAnswers) * 100) : 0;

  const totalFines = runs.reduce((s, r) => s + r.totalFine, 0);
  const recentFines = recentRuns.reduce((s, r) => s + r.totalFine, 0);
  const olderFines = runs.slice(5).reduce((s, r) => s + r.totalFine, 0);
  const fineTrend = recentFines <= olderFines ? "down" : "up";

  const errorPriorities = useMemo(() => buildErrorPriorities(profile), [profile]);

  const allTimeSummaries = useMemo(
    () => summarizeErrorTopics(collectWrongAnswers(profile)),
    [profile],
  );
  const currentSummaries = useMemo(
    () =>
      summarizeErrorTopics(
        errorPriorities
          .filter((e) => !e.wasFixed)
          .map((e) => ({ errorInfo: e.errorInfo, sceneId: e.sceneId, count: e.count })),
      ),
    [errorPriorities],
  );

  const activeSummaries = chartMode === "current" ? currentSummaries : allTimeSummaries;
  const topTopics = activeSummaries.slice(0, 3);
  const chartTopics = activeSummaries.slice(0, 6);

  const missionPlan = buildMissionReviewPlan(errorPriorities);
  const unfixedSummaries = currentSummaries;

  const daySet = new Set(
    runs.map((r) => new Date(r.completedAt).toDateString()),
  );
  const streak = daySet.size;

  const showChart = allTimeSummaries.length > 0 || currentSummaries.length > 0;

  return (
    <div className="profile-dashboard">
      {showChart && (
        <div className="profile-dashboard__mode-bar">
          <span className="profile-dashboard__mode-label">Статистика ошибок</span>
          <TopicsModeToggle chartMode={chartMode} onChange={setChartMode} />
        </div>
      )}
      <div className="profile-dashboard__metrics">
        <div className="metric-card metric-card--progress">
          <div className="metric-card__label">Прогресс</div>
          <div className="metric-card__value">{progressPct}%</div>
          <div className="metric-card__hint">верных ответов</div>
        </div>
        <div className="metric-card metric-card--fines">
          <div className="metric-card__label">Штрафы</div>
          <div className="metric-card__value">{totalFines} ₽</div>
          <div className={`metric-card__hint metric-card__hint--${fineTrend}`}>
            {fineTrend === "down" ? "↓ стало лучше" : "↑ нужно внимание"}
          </div>
        </div>
        <div className="metric-card metric-card--topics">
          <div className="metric-card__label">
            Слабые темы
            <span className="metric-card__label-mode">
              {chartMode === "current" ? "· актуальные" : "· за всё время"}
            </span>
          </div>
          <div className="metric-card__topics">
            {topTopics.length === 0 ? (
              <span className="metric-card__hint">
                {chartMode === "current" ? "Незакрытых ошибок нет" : "Пока всё отлично"}
              </span>
            ) : (
              topTopics.map((t) => (
                <span key={t.key} className="topic-chip topic-chip--warn">
                  {t.title}
                </span>
              ))
            )}
          </div>
        </div>
        <div className="metric-card metric-card--streak">
          <div className="metric-card__label">Тренировки</div>
          <div className="metric-card__value">{streak}</div>
          <div className="metric-card__hint">дней с попытками</div>
        </div>
      </div>

      {showChart && (
        <div className="profile-dashboard__chart">
          <h3>Ошибки по темам</h3>
          <TopicsBarChart
            topics={chartTopics}
            emptyMessage={
              chartMode === "current"
                ? "Незакрытых ошибок нет — всё исправлено."
                : "Пока нет ошибок в истории."
            }
          />
        </div>
      )}
      {runs.length > 0 && (
        <div className="profile-dashboard__timeline">
          <h3>Последние миссии</h3>
          <div className="mission-timeline">
            {recentRuns.map((run) => {
              const ok = run.correct === run.total;
              return (
                <div key={run.id} className="mission-timeline__item">
                  <span className={`mission-timeline__dot mission-timeline__dot--${ok ? "ok" : "bad"}`} />
                  <div className="mission-timeline__info">
                    <span>{run.missionTitle}</span>
                    <span className="mission-timeline__meta">
                      {new Date(run.completedAt).toLocaleDateString("ru-RU")} · {run.correct}/{run.total}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(missionPlan.length > 0 || unfixedSummaries.length > 0) && (
        <div className="profile-dashboard__priorities">
          <h3>Что повторить</h3>
          {missionPlan.length > 0 ? (
            <div className="review-mission-groups">
              {missionPlan.slice(0, 4).map((mission) => (
                <div key={mission.missionId} className="review-mission-group">
                  <div className="review-mission-group__title">
                    {mission.missionTitle}
                    <span className="review-mission-group__count">×{mission.totalErrors}</span>
                  </div>
                  <div className="review-mission-group__scenes">
                    {mission.scenes.slice(0, 4).map((scene) => (
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
            <div className="review-topic-chips">
              {unfixedSummaries.slice(0, 8).map((topic) => (
                <div key={topic.key} className="review-topic-chip">
                  <span className="review-topic-chip__title">
                    {topic.title}
                    <span className="review-topic-chip__count">×{topic.count}</span>
                  </span>
                  {topic.ruleRef !== "ПДД" && (
                    <span className="review-topic-chip__ref">{topic.ruleRef}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
