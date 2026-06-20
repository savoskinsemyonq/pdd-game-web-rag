import { useMemo } from "react";
import type { RunnerState } from "../engine/SceneRunner";
import type { Mission } from "../types";
import { summarizeErrorTopics } from "../utils/reviewPlan";

interface Props {
  mission: Mission;
  state: RunnerState;
  onRetry: () => void;
  onMenu: () => void;
}

export function MissionResult({ mission, state, onRetry, onMenu }: Props) {
  const correct = state.history.filter((h) => h.isCorrect).length;
  const total = state.history.length;
  const heading = correct === total
    ? "Отлично! Все ответы верные."
    : correct >= total - 2
      ? "Хороший результат, но есть над чем поработать."
      : "Нужно перечитать правила и попробовать ещё раз.";

  const recommendedTopics = useMemo(
    () =>
      summarizeErrorTopics(
        state.history
          .filter((h) => !h.isCorrect && h.errorInfo)
          .map((h) => ({ errorInfo: h.errorInfo!, sceneId: h.sceneId })),
      ),
    [state.history],
  );

  return (
    <div className="menu">
      <h1>{mission.title}</h1>
      <p>{heading}</p>
      <p>
        Правильных ответов: <strong>{correct}</strong> из <strong>{total}</strong>
        {" · "}
        Суммарный штраф: <strong>{state.totalFine} ₽</strong>
        {state.totalLicenseRevokeMonths > 0 && (
          <>{" · "}Лишение прав: <strong>до {state.totalLicenseRevokeMonths} мес.</strong></>
        )}
        {" · "}
        Задержка: <strong>{state.totalLostTime} мин</strong>
      </p>

      <div className="result-list">
        {state.history.map((h, i) => (
          <div key={i} className={`row ${h.isCorrect ? "ok" : "bad"}`}>
            <span>
              Сцена {h.sceneId} · вариант {h.pickedCase}
            </span>
            <span>
              {h.isCorrect
                ? "верно"
                : h.licenseRevokeMonths != null
                  ? `лишение прав до ${h.licenseRevokeMonths} мес.`
                  : `штраф ${h.fine} ₽`}
            </span>
          </div>
        ))}
      </div>

      {recommendedTopics.length > 0 && (
        <div className="recommendations">
          <h3>Рекомендуем повторить</h3>
          <p className="recommendations__subtitle">
            В этой миссии вы допустили ошибки по следующим темам:
          </p>
          <ul className="recommendations__list">
            {recommendedTopics.map((t) => (
              <li key={t.key} className="recommendations__item">
                <span className="recommendations__title">{t.title}</span>
                {t.ruleRef !== "ПДД" && (
                  <span className="recommendations__ref">{t.ruleRef}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {correct === total && (
        <div className="recommendations recommendations--success">
          Отличный результат! Все правила соблюдены — нечего повторять.
        </div>
      )}

      <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
        <button onClick={onRetry}>Пройти заново</button>
        <button onClick={onMenu} style={{ background: "#444", color: "#fff" }}>
          В меню
        </button>
      </div>
    </div>
  );
}
