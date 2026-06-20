import type { RunnerState } from "../engine/SceneRunner";

interface Props {
  state: RunnerState;
  missionTitle: string;
  onExit: () => void;
  calibrationEnabled: boolean;
  onToggleCalibration: () => void;
  animationEnabled: boolean;
  onToggleAnimation: () => void;
  showDevTools?: boolean;
}

export function Hud({
  state,
  missionTitle,
  onExit,
  calibrationEnabled,
  onToggleCalibration,
  animationEnabled,
  onToggleAnimation,
  showDevTools = false,
}: Props) {
  const totalScenes = Math.max(0, state.totalNodes - 1);
  const sceneIdx = Math.max(0, state.nodeIndex);
  return (
    <div className="hud">
      <span className="chip">{missionTitle}</span>
      <span className="chip">Сцена {Math.min(sceneIdx, totalScenes)} / {totalScenes}</span>
      <span className="chip">Штраф: {state.totalFine} ₽</span>
      {state.totalLicenseRevokeMonths > 0 && (
        <span className="chip">Лишение прав: до {state.totalLicenseRevokeMonths} мес.</span>
      )}
      <span className="chip">Задержка: {state.totalLostTime} мин</span>
      <button
        className="chip"
        onClick={onExit}
        style={{ cursor: "pointer", border: "none" }}
      >
        Выход (Esc)
      </button>
      {showDevTools && (
        <>
          <button
            className="chip"
            onClick={onToggleCalibration}
            style={{ cursor: "pointer", border: "none" }}
          >
            {calibrationEnabled ? "Калибровка: ON (K)" : "Калибровка: OFF (K)"}
          </button>
          <button
            className="chip"
            onClick={onToggleAnimation}
            style={{ cursor: "pointer", border: "none" }}
          >
            {animationEnabled ? "Анимации: ON (J)" : "Анимации: OFF (J)"}
          </button>
        </>
      )}
    </div>
  );
}
