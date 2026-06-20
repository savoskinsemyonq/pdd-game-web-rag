import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { TrafficLightDef } from "../types";
import type { Camera } from "../engine/Camera";

interface Props {
  lights: TrafficLightDef[];
  onChange: (lights: TrafficLightDef[]) => void;
  getCamera: () => Camera | null;
}

const PANEL_W = 300;
const PANEL_MIN_VISIBLE_X = 120;

export function TrafficLightEditor({ lights, onChange, getCamera }: Props) {
  const [pos, setPos] = useState({ x: 8, y: 80 });
  const dragRef = useRef<{ pointerId: number; ox: number; oy: number; sx: number; sy: number } | null>(null);
  const nextId = useRef(lights.length > 0 ? Math.max(...lights.map((l) => l.id)) + 1 : 1);

  // Keep nextId in sync when lights come from outside
  useEffect(() => {
    if (lights.length > 0) {
      nextId.current = Math.max(...lights.map((l) => l.id)) + 1;
    }
  }, [lights]);

  const clampPos = useCallback((x: number, y: number) => ({
    x: Math.min(Math.max(8, x), window.innerWidth - PANEL_MIN_VISIBLE_X),
    y: Math.min(Math.max(8, y), window.innerHeight - 48),
  }), []);

  const onPanelPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, ox: e.clientX, oy: e.clientY, sx: pos.x, sy: pos.y };
  }, [pos]);

  const onPanelPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    setPos(clampPos(d.sx + e.clientX - d.ox, d.sy + e.clientY - d.oy));
  }, [clampPos]);

  const onPanelPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }, []);

  // Click on canvas = place light, right-click = remove nearest
  useEffect(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return;

    function screenToWorld(clientX: number, clientY: number) {
      const cam = getCamera();
      if (!cam) return null;
      const rect = canvas!.getBoundingClientRect();
      const scaleX = canvas!.width / rect.width;
      const scaleY = canvas!.height / rect.height;
      const sx = (clientX - rect.left) * scaleX;
      const sy = (clientY - rect.top) * scaleY;
      return {
        x: cam.cx + (sx - cam.width / 2) / cam.zoom,
        y: cam.cy + (sy - cam.height / 2) / cam.zoom,
      };
    }

    function onClick(e: MouseEvent) {
      if (e.button !== 0) return;
      e.preventDefault();
      const w = screenToWorld(e.clientX, e.clientY);
      if (!w) return;
      const id = nextId.current++;
      onChange([...lights, { id, x: Math.round(w.x), y: Math.round(w.y) }]);
    }

    function onContextMenu(e: MouseEvent) {
      e.preventDefault();
      const w = screenToWorld(e.clientX, e.clientY);
      if (!w || lights.length === 0) return;
      const nearest = lights.reduce((best, l) =>
        Math.hypot(l.x - w.x, l.y - w.y) < Math.hypot(best.x - w.x, best.y - w.y) ? l : best
      );
      if (Math.hypot(nearest.x - w.x, nearest.y - w.y) < 200) {
        onChange(lights.filter((l) => l.id !== nearest.id));
      }
    }

    canvas.addEventListener("click", onClick);
    canvas.addEventListener("contextmenu", onContextMenu);
    return () => {
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("contextmenu", onContextMenu);
    };
  }, [lights, onChange, getCamera]);

  const exportJson = useCallback(async () => {
    const json = JSON.stringify({ lights }, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      alert("JSON скопирован в буфер обмена");
    } catch {
      prompt("Скопируйте JSON:", json);
    }
  }, [lights]);

  const clearAll = useCallback(() => {
    if (confirm("Удалить все светофоры?")) onChange([]);
  }, [onChange]);

  const updateLight = useCallback((id: number, field: "x" | "y" | "rotation", val: number) => {
    onChange(lights.map((l) => l.id === id ? { ...l, [field]: val } : l));
  }, [lights, onChange]);

  const toggleFlipY = useCallback((id: number) => {
    onChange(lights.map((l) => l.id === id ? { ...l, flipY: !l.flipY } : l));
  }, [lights, onChange]);

  const toggleSideView = useCallback((id: number) => {
    onChange(lights.map((l) => l.id === id ? { ...l, sideView: !l.sideView, backView: false } : l));
  }, [lights, onChange]);

  const toggleBackView = useCallback((id: number) => {
    onChange(lights.map((l) => l.id === id ? { ...l, backView: !l.backView, sideView: false } : l));
  }, [lights, onChange]);

  return (
    <div
      style={{
        position: "fixed",
        left: pos.x,
        top: pos.y,
        width: PANEL_W,
        background: "rgba(10,16,32,0.96)",
        border: "1px solid #3ac24a",
        borderRadius: 10,
        color: "#fff",
        fontSize: 13,
        zIndex: 30,
        userSelect: "none",
        boxShadow: "0 6px 20px rgba(0,0,0,0.7)",
      }}
    >
      <div
        style={{ padding: "8px 12px", cursor: "grab", borderBottom: "1px solid #2a3a2a", display: "flex", justifyContent: "space-between", alignItems: "center" }}
        onPointerDown={onPanelPointerDown}
        onPointerMove={onPanelPointerMove}
        onPointerUp={onPanelPointerUp}
      >
        <strong style={{ color: "#3ac24a" }}>Светофоры ({lights.length})</strong>
        <span style={{ color: "#888", fontSize: 11 }}>перетаскивать</span>
      </div>

      <div style={{ padding: "8px 12px", borderBottom: "1px solid #1a2a1a", fontSize: 11, color: "#aaa" }}>
        <b>ЛКМ</b> по карте — поставить &nbsp;|&nbsp; <b>ПКМ</b> — удалить ближайший
      </div>

      <div style={{ maxHeight: 280, overflowY: "auto", padding: "4px 0" }}>
        {lights.length === 0 && (
          <div style={{ padding: "10px 12px", color: "#666" }}>Нет светофоров</div>
        )}
        {lights.map((l) => (
          <div key={l.id} style={{ padding: "4px 12px", borderBottom: "1px solid #111", display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ color: "#3ac24a", minWidth: 28 }}>#{l.id}</span>
            <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
              X<input
                type="number"
                value={l.x}
                style={{ width: 64, background: "#111", border: "1px solid #333", color: "#fff", borderRadius: 3, padding: "1px 4px" }}
                onChange={(e) => updateLight(l.id, "x", parseInt(e.target.value, 10) || 0)}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 3 }}>
              Y<input
                type="number"
                value={l.y}
                style={{ width: 64, background: "#111", border: "1px solid #333", color: "#fff", borderRadius: 3, padding: "1px 4px" }}
                onChange={(e) => updateLight(l.id, "y", parseInt(e.target.value, 10) || 0)}
              />
            </label>
            <button
              title="Перевернуть (столб вниз)"
              style={{ background: l.flipY ? "#1a2a3a" : "transparent", border: `1px solid ${l.flipY ? "#3a9ac2" : "#444"}`, color: l.flipY ? "#3a9ac2" : "#888", borderRadius: 3, cursor: "pointer", fontSize: 11, padding: "0 4px" }}
              onClick={() => toggleFlipY(l.id)}
            >↕</button>
            <button
              title="Вид сбоку (sideView)"
              style={{ background: l.sideView ? "#2a1a3a" : "transparent", border: `1px solid ${l.sideView ? "#a03ac2" : "#444"}`, color: l.sideView ? "#c26af0" : "#888", borderRadius: 3, cursor: "pointer", fontSize: 10, padding: "0 4px" }}
              onClick={() => toggleSideView(l.id)}
            >S</button>
            <button
              title="Вид сзади (backView)"
              style={{ background: l.backView ? "#3a2a1a" : "transparent", border: `1px solid ${l.backView ? "#c27a3a" : "#444"}`, color: l.backView ? "#f0a06a" : "#888", borderRadius: 3, cursor: "pointer", fontSize: 10, padding: "0 4px" }}
              onClick={() => toggleBackView(l.id)}
            >B</button>
            <button
              style={{ marginLeft: "auto", background: "transparent", border: "none", color: "#e23a3a", cursor: "pointer", fontSize: 14, padding: "0 4px" }}
              onClick={() => onChange(lights.filter((x) => x.id !== l.id))}
            >✕</button>
          </div>
        ))}
      </div>

      <div style={{ padding: "8px 12px", display: "flex", gap: 8 }}>
        <button
          style={{ flex: 1, background: "#1a3a1a", border: "1px solid #3ac24a", color: "#3ac24a", borderRadius: 5, padding: "4px 0", cursor: "pointer" }}
          onClick={exportJson}
        >
          Экспорт JSON
        </button>
        <button
          style={{ background: "#3a1a1a", border: "1px solid #e23a3a", color: "#e23a3a", borderRadius: 5, padding: "4px 8px", cursor: "pointer" }}
          onClick={clearAll}
        >
          Сброс
        </button>
      </div>
    </div>
  );
}
