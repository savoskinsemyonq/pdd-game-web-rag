import { useGameStore } from "../state/gameStore";
import type { Mission } from "../types";

interface Props {
  onPick: (m: Mission) => void;
  onBack: () => void;
}

export function MissionSelect({ onPick, onBack }: Props) {
  const missions = useGameStore((s) => s.missions);
  const best = useGameStore((s) => s.bestByMission);

  return (
    <div className="menu">
      <h1>Выбор миссии</h1>
      <p>Каждая миссия — 11 ситуаций. Цель: пройти, набрав минимальный штраф.</p>
      <div className="mission-grid">
        {missions.map((m) => {
          const b = best[m.id];
          return (
            <button
              key={m.id}
              className="mission-card"
              onClick={() => onPick(m)}
              title={m.title}
            >
              <span className="num">{m.index}</span>
              <span className="label">{m.title.replace(/^Миссия \d+\.\s*/, "")}</span>
              {b && (
                <span className="label mission-best-fine">
                  Лучший штраф: {b.fine} ₽
                </span>
              )}
            </button>
          );
        })}
      </div>
      <button onClick={onBack}>Назад</button>
    </div>
  );
}
