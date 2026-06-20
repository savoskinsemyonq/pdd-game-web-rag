import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { CalibrationTarget, NpcTweak } from "../engine/SceneRunner";

const PANEL_MIN_VISIBLE_X = 160;

interface Props {
  enabled: boolean;
  targets: CalibrationTarget[];
  selectedKey: string | null;
  selectedTweak: NpcTweak;
  onSelect: (key: string) => void;
  onClose: () => void;
  onExport: () => void;
  onExportMerged: () => void;
  onImport: () => void;
  importStatus: string | null;
}

export function CalibrationPanel({
  enabled,
  targets,
  selectedKey,
  selectedTweak,
  onSelect,
  onClose,
  onExport,
  onExportMerged,
  onImport,
  importStatus,
}: Props) {
  const [pos, setPos] = useState(() => ({
    x:
      typeof window !== "undefined"
        ? Math.max(8, window.innerWidth - 368)
        : 8,
    y:
      typeof window !== "undefined"
        ? Math.max(8, window.innerHeight - 286)
        : 8,
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
      const dx = e.clientX - d.originX;
      const dy = e.clientY - d.originY;
      setPos(clampPos(d.startX + dx, d.startY + dy));
    },
    [clampPos]
  );

  const onDragPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      dragRef.current = null;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    []
  );

  const panelStyle = useMemo(
    () => ({ left: pos.x, top: pos.y }),
    [pos.x, pos.y]
  );

  if (!enabled) return null;
  return (
    <div className="calibration-panel" style={panelStyle}>
      <div className="calibration-head">
        <div
          className="calibration-drag-handle"
          onPointerDown={onDragPointerDown}
          onPointerMove={onDragPointerMove}
          onPointerUp={onDragPointerUp}
          onPointerCancel={onDragPointerUp}
        >
          <strong>Калибровка позиций</strong>
        </div>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
        >
          Закрыть
        </button>
      </div>
      <div className="calibration-help">
        Выбери машину (MY_CAR) или NPC. Стрелки: смещение на 5px. Shift+стрелки:
        20px. R: сброс текущей цели.
      </div>
      <div className="calibration-actions">
        <button onClick={onExport}>Экспорт JSON</button>
        <button onClick={onExportMerged}>Скопировать итоговые</button>
        <button onClick={onImport}>Импорт JSON</button>
      </div>
      {importStatus && <div className="calibration-status">{importStatus}</div>}
      <div className="calibration-list">
        {targets.map((t) => (
          <button
            key={t.key}
            className={t.key === selectedKey ? "active" : ""}
            onClick={() => onSelect(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {selectedKey && (
        <div className="calibration-meta">
          Текущая коррекция: dx={selectedTweak.x}, dy={selectedTweak.y}
        </div>
      )}
    </div>
  );
}

