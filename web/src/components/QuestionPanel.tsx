import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Scene } from "../types";

interface Props {
  scene: Scene;
  timeRemaining: number;
  onPick: (caseIndex: number) => void;
}

const PANEL_W = 360;
const PANEL_MIN_VISIBLE_X = 160;

export function QuestionPanel({ scene, timeRemaining: _timeRemaining, onPick }: Props) {
  void _timeRemaining;

  const [pos, setPos] = useState(() => ({
    x: typeof window !== "undefined" ? Math.max(8, window.innerWidth / 2 - PANEL_W - window.innerWidth * 0.15) : 8,
    y: typeof window !== "undefined" ? Math.max(8, window.innerHeight - 300) : 8,
  }));

  const dragRef = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    startX: number;
    startY: number;
  } | null>(null);

  const clampPos = useCallback((x: number, y: number) => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const margin = 8;
    return {
      x: Math.min(Math.max(margin, x), w - PANEL_MIN_VISIBLE_X),
      y: Math.min(Math.max(margin, y), h - margin - 40),
    };
  }, []);

  const onDragPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        pointerId: e.pointerId,
        originX: e.clientX,
        originY: e.clientY,
        startX: pos.x,
        startY: pos.y,
      };
    },
    [pos.x, pos.y]
  );

  const onDragPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      setPos(clampPos(d.startX + (e.clientX - d.originX), d.startY + (e.clientY - d.originY)));
    },
    [clampPos]
  );

  const onDragPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      dragRef.current = null;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    },
    []
  );

  const panelStyle = useMemo(
    () => ({ left: pos.x, top: pos.y, width: PANEL_W }),
    [pos.x, pos.y]
  );

  const isSingleNoQuestion = scene.cases.length === 1 && scene.questionOptions.length === 0;
  const options = scene.questionOptions.length === scene.cases.length
    ? scene.questionOptions
    : isSingleNoQuestion
      ? ["Результаты заезда!"]
      : scene.cases.map((c) => `Вариант ${c.case}`);

  return (
    <div className="question-panel" style={panelStyle}>
      <header
        onPointerDown={onDragPointerDown}
        onPointerMove={onDragPointerMove}
        onPointerUp={onDragPointerUp}
      >
        <span>сцена {scene.sceneId}</span>
        <span style={{ color: "#aaa" }}>можно перетаскивать</span>
      </header>
      <div className="question-panel-scroll">
        <div className="q-text">{scene.questionTitle.replace(/\s+/g, " ")}</div>
        <div className="q-options">
          {options.map((label, i) => (
            <button
              key={i}
              className="q-option"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onPick(i)}
            >
              <span className="num">{i + 1}</span>
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
