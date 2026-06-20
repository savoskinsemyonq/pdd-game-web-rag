import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { AnimationTarget } from "../engine/SceneRunner";
import type { SplineKey } from "../types";

const PANEL_MIN_VISIBLE_X = 160;

interface NodeEntry {
  index: number;
  nodeId: string;
}

interface Props {
  enabled: boolean;
  nodes: NodeEntry[];
  currentNodeIndex: number;
  onJumpToNode: (index: number) => void;
  targets: AnimationTarget[];
  selectedKey: string | null;
  activeKeys: SplineKey[];
  hasOverride: boolean;
  onSelect: (key: string) => void;
  onClose: () => void;
  onKeysChange: (keys: SplineKey[]) => void;
  onReset: () => void;
  onExport: () => void;
  onImport: () => void;
  importStatus: string | null;
}

export function AnimationPanel({
  enabled,
  nodes,
  currentNodeIndex,
  onJumpToNode,
  targets,
  selectedKey,
  activeKeys,
  hasOverride,
  onSelect,
  onClose,
  onKeysChange,
  onReset,
  onExport,
  onImport,
  importStatus,
}: Props) {
  const [pos, setPos] = useState(() => ({
    x: typeof window !== "undefined" ? Math.max(8, window.innerWidth - 440) : 8,
    y: typeof window !== "undefined" ? Math.max(8, window.innerHeight - 500) : 8,
  }));

  // Local editable copy of keys so inputs feel responsive
  const [localKeys, setLocalKeys] = useState<SplineKey[]>(activeKeys);

  useEffect(() => {
    setLocalKeys(activeKeys);
  }, [activeKeys]);

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

  const panelStyle = useMemo(() => ({ left: pos.x, top: pos.y }), [pos.x, pos.y]);

  const updateField = useCallback(
    (keyIdx: number, field: keyof SplineKey, value: string) => {
      const num = parseFloat(value);
      if (!Number.isFinite(num)) return;
      const updated = localKeys.map((k, i) =>
        i === keyIdx ? { ...k, [field]: num } : k
      );
      setLocalKeys(updated);
      onKeysChange(updated);
    },
    [localKeys, onKeysChange]
  );

  const addKey = useCallback(() => {
    const lastT = localKeys.length > 0 ? localKeys[localKeys.length - 1].t : 0;
    const newKey: SplineKey = { t: lastT + 500, dx: 0, dy: 0, tx: 0, ty: 0 };
    const updated = [...localKeys, newKey];
    setLocalKeys(updated);
    onKeysChange(updated);
  }, [localKeys, onKeysChange]);

  const removeLast = useCallback(() => {
    if (localKeys.length === 0) return;
    const updated = localKeys.slice(0, -1);
    setLocalKeys(updated);
    onKeysChange(updated);
  }, [localKeys, onKeysChange]);

  if (!enabled) return null;

  return (
    <div className="calibration-panel" style={{ ...panelStyle, minWidth: 420, maxHeight: "80vh", overflowY: "auto" }}>
      <div className="calibration-head">
        <div
          className="calibration-drag-handle"
          onPointerDown={onDragPointerDown}
          onPointerMove={onDragPointerMove}
          onPointerUp={onDragPointerUp}
          onPointerCancel={onDragPointerUp}
        >
          <strong>Анимации</strong>
        </div>
        <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>
          Закрыть
        </button>
      </div>
      <div className="calibration-help">
        J — открыть/закрыть. Выбери объект и редактируй keyframe-ы сплайна.
        Изменения применяются сразу. R — сброс к оригиналу.
      </div>
      {nodes.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <label style={{ whiteSpace: "nowrap", color: "#aaa" }}>Сцена:</label>
          <select
            value={currentNodeIndex}
            onChange={(e) => onJumpToNode(Number(e.target.value))}
            style={{ flex: 1, fontSize: 12, background: "#1e1e2e", color: "#cdd6f4", border: "1px solid #45475a", borderRadius: 4, padding: "2px 4px" }}
          >
            {nodes.map((n) => (
              <option key={n.index} value={n.index}>
                {n.index + 1}. {n.nodeId}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="calibration-actions">
        <button onClick={onExport}>Экспорт JSON</button>
        <button onClick={onImport}>Импорт JSON</button>
      </div>
      {importStatus && <div className="calibration-status">{importStatus}</div>}
      <div className="calibration-list">
        {(() => {
          const approachTargets = targets.filter((t) => t.caseIndex === undefined);
          const caseTargets = targets.filter((t) => t.caseIndex !== undefined);
          // группируем post-answer по caseIndex
          const caseGroups = new Map<number, typeof targets>();
          for (const t of caseTargets) {
            const ci = t.caseIndex!;
            if (!caseGroups.has(ci)) caseGroups.set(ci, []);
            caseGroups.get(ci)!.push(t);
          }
          return (
            <>
              {approachTargets.length > 0 && (
                <div style={{ fontSize: 11, color: "#888", padding: "2px 4px", marginTop: 2 }}>
                  — до вопроса —
                </div>
              )}
              {approachTargets.map((t) => (
                <button key={t.key} className={t.key === selectedKey ? "active" : ""} onClick={() => onSelect(t.key)}>
                  {t.label.replace("[до вопроса] ", "")}{!t.hasSpline ? " (нет сплайна)" : ""}
                </button>
              ))}
              {[...caseGroups.entries()].map(([ci, group]) => (
                <div key={ci}>
                  <div style={{ fontSize: 11, color: "#888", padding: "2px 4px", marginTop: 4 }}>
                    — {group[0].label.match(/\[.+?\]/)?.[0] ?? `ответ ${ci}`} —
                  </div>
                  {group.map((t) => (
                    <button key={t.key} className={t.key === selectedKey ? "active" : ""} onClick={() => onSelect(t.key)}>
                      {`[${ci}] `}{t.label.replace(/\[.+?\]\s*/, "")}{!t.hasSpline ? " (нет сплайна)" : ""}
                    </button>
                  ))}
                </div>
              ))}
            </>
          );
        })()}
      </div>
      {selectedKey && (
        <div style={{ marginTop: 8 }}>
          {hasOverride && (
            <div className="calibration-actions">
              <button onClick={onReset}>Сброс к оригиналу</button>
            </div>
          )}
          <div style={{ overflowX: "auto", marginTop: 4 }}>
            <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
              <thead>
                <tr>
                  {(["#", "t", "dx", "dy", "tx", "ty"] as const).map((h) => (
                    <th
                      key={h}
                      style={{ padding: "2px 4px", textAlign: "center", borderBottom: "1px solid #555" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {localKeys.map((k, i) => (
                  <tr key={i}>
                    <td style={{ padding: "2px 4px", textAlign: "center", color: "#aaa" }}>{i}</td>
                    {(["t", "dx", "dy", "tx", "ty"] as (keyof SplineKey)[]).map((field) => (
                      <td key={field} style={{ padding: "2px 2px" }}>
                        <input
                          type="number"
                          defaultValue={k[field]}
                          key={`${selectedKey}-${i}-${field}-${k[field]}`}
                          onBlur={(e) => updateField(i, field, e.target.value)}
                          style={{ width: 64, fontSize: 12, background: "#1e1e2e", color: "#cdd6f4", border: "1px solid #45475a", borderRadius: 3, padding: "1px 3px" }}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="calibration-actions" style={{ marginTop: 6 }}>
            <button onClick={addKey}>+ Keyframe</button>
            <button onClick={removeLast} disabled={localKeys.length === 0}>− Последний</button>
          </div>
        </div>
      )}
    </div>
  );
}
