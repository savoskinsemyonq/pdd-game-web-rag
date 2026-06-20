import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type { MissionTilemap, TilemapCell, TilemapKind } from "../engine/Renderer";

// ─── constants ────────────────────────────────────────────────────────────────

const TILE_COUNT = 205; // tile_000 … tile_204
const TILE_SIZE = 64;
const THUMB_SIZE = 48; // palette preview size
const DEFAULT_COLS = 40;
const DEFAULT_ROWS = 60;
const DEFAULT_ORIGIN = { x: 0, y: 0 };
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 6;

const KIND_OPTIONS: TilemapKind[] = [
  "road", "grass", "sidewalk", "road_marking", "building", "unknown", "empty",
];

const KIND_COLORS: Record<TilemapKind, string> = {
  road: "#3a3a44",
  grass: "#3aa454",
  road_marking: "#f4cc3a",
  sidewalk: "#b0a48a",
  building: "#c83232",
  unknown: "#8050c0",
  empty: "#111",
};

// ─── helpers ──────────────────────────────────────────────────────────────────

function tileSrc(id: number) {
  return `/city/tiles/tile_${String(id).padStart(3, "0")}.png`;
}

function makeEmptyMap(cols: number, rows: number, origin: { x: number; y: number }): MissionTilemap {
  const cells: TilemapCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({ col: c, row: r, tileId: null, kind: "empty", passable: true, confidence: 1 });
    }
  }
  return { missionId: "mission1", tileSize: TILE_SIZE, cols, rows, originWorld: origin, cells };
}

function cloneMap(tm: MissionTilemap): MissionTilemap {
  return { ...tm, cells: tm.cells.map((c) => ({ ...c })) };
}

function resizeMap(
  tm: MissionTilemap,
  newCols: number,
  newRows: number,
): MissionTilemap {
  const cells: TilemapCell[] = [];
  for (let r = 0; r < newRows; r++) {
    for (let c = 0; c < newCols; c++) {
      const old = r < tm.rows && c < tm.cols ? tm.cells[r * tm.cols + c] : null;
      cells.push(old ? { ...old } : { col: c, row: r, tileId: null, kind: "empty", passable: true, confidence: 1 });
    }
  }
  return { ...tm, cols: newCols, rows: newRows, cells };
}

// ─── tile image cache (module-level, never re-created) ─────────────────────────

const tileCache = new Map<number, HTMLImageElement>();

function loadTile(id: number): HTMLImageElement {
  if (tileCache.has(id)) return tileCache.get(id)!;
  const img = new Image();
  img.src = tileSrc(id);
  tileCache.set(id, img);
  return img;
}

// Pre-load all tiles on module init
for (let i = 0; i < TILE_COUNT; i++) loadTile(i);

// ─── component ────────────────────────────────────────────────────────────────

interface Props {
  onClose: () => void;
}

export function MapEditor({ onClose }: Props) {
  // ── state ──────────────────────────────────────────────────────────────────

  // Map being edited
  const [tilemap, setTilemap] = useState<MissionTilemap>(() => makeEmptyMap(DEFAULT_COLS, DEFAULT_ROWS, DEFAULT_ORIGIN));
  const [dirty, setDirty] = useState(false);

  // Editor tool
  const [selectedTile, setSelectedTile] = useState<number | null>(0);
  const [selectedKind, setSelectedKind] = useState<TilemapKind>("road");
  const [tool, setTool] = useState<"tile" | "kind" | "erase">("tile");
  const [showKindOverlay, setShowKindOverlay] = useState(false);

  // Palette
  const [search, setSearch] = useState("");
  const [paletteFilter, setPaletteFilter] = useState<"all" | TilemapKind>("all");

  // Viewport
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 }); // canvas offset in px (top-left world px visible)

  // Interaction
  const isPainting = useRef(false);
  const lastCell = useRef<{ col: number; row: number } | null>(null);
  const isPanning = useRef(false);
  const panStart = useRef({ mx: 0, my: 0, ox: 0, oy: 0 });

  // Resize dialog
  const [showResize, setShowResize] = useState(false);
  const [resizeCols, setResizeCols] = useState(DEFAULT_COLS);
  const [resizeRows, setResizeRows] = useState(DEFAULT_ROWS);

  // Map size settings dialog
  const [showMapSettings, setShowMapSettings] = useState(false);
  const [settingsCols, setSettingsCols] = useState(DEFAULT_COLS);
  const [settingsRows, setSettingsRows] = useState(DEFAULT_ROWS);
  const [settingsOriginX, setSettingsOriginX] = useState(DEFAULT_ORIGIN.x);
  const [settingsOriginY, setSettingsOriginY] = useState(DEFAULT_ORIGIN.y);
  const [settingsMissionId, setSettingsMissionId] = useState("mission1");

  // Status bar text
  const [status, setStatus] = useState("Готово");

  // ── tile filtering for palette ─────────────────────────────────────────────

  // Build per-tile kind mapping from current map
  const tileKindMap = useMemo(() => {
    const m = new Map<number, TilemapKind>();
    for (const cell of tilemap.cells) {
      if (cell.tileId !== null && !m.has(cell.tileId)) {
        m.set(cell.tileId, cell.kind);
      }
    }
    return m;
  }, [tilemap]);

  const filteredTiles = useMemo(() => {
    const ids: number[] = [];
    for (let i = 0; i < TILE_COUNT; i++) {
      if (search && !String(i).includes(search)) continue;
      if (paletteFilter !== "all") {
        const kind = tileKindMap.get(i);
        if (!kind || kind !== paletteFilter) continue;
      }
      ids.push(i);
    }
    return ids;
  }, [search, paletteFilter, tileKindMap]);

  // ── canvas drawing ─────────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { width, height } = canvas;
    const tm = tilemap;
    const TS = tm.tileSize * zoom;

    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, width, height);

    // world origin in canvas px
    const ox = -pan.x;
    const oy = -pan.y;

    // visible cell range
    const c0 = Math.max(0, Math.floor(pan.x / (tm.tileSize * zoom)));
    const c1 = Math.min(tm.cols - 1, Math.ceil((pan.x + width) / (tm.tileSize * zoom)));
    const r0 = Math.max(0, Math.floor(pan.y / (tm.tileSize * zoom)));
    const r1 = Math.min(tm.rows - 1, Math.ceil((pan.y + height) / (tm.tileSize * zoom)));

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = tm.cells[r * tm.cols + c];
        if (!cell) continue;
        const sx = ox + c * TS;
        const sy = oy + r * TS;

        if (showKindOverlay || cell.tileId === null) {
          if (cell.kind !== "empty") {
            ctx.fillStyle = KIND_COLORS[cell.kind] ?? "#333";
            ctx.fillRect(sx, sy, TS, TS);
          } else {
            ctx.fillStyle = "#111";
            ctx.fillRect(sx, sy, TS, TS);
          }
        }

        if (!showKindOverlay && cell.tileId !== null) {
          const img = tileCache.get(cell.tileId);
          if (img?.complete && img.naturalWidth > 0) {
            ctx.drawImage(img, sx, sy, TS, TS);
          } else {
            ctx.fillStyle = "#222";
            ctx.fillRect(sx, sy, TS, TS);
          }
        }

        if (showKindOverlay && cell.tileId !== null) {
          const img = tileCache.get(cell.tileId);
          if (img?.complete && img.naturalWidth > 0) {
            ctx.save();
            ctx.globalAlpha = 0.4;
            ctx.drawImage(img, sx, sy, TS, TS);
            ctx.restore();
          }
        }
      }
    }

    // Grid lines (when zoomed in enough)
    if (zoom >= 0.5) {
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 0.5;
      for (let c = c0; c <= c1 + 1; c++) {
        const x = ox + c * TS;
        ctx.beginPath(); ctx.moveTo(x, oy + r0 * TS); ctx.lineTo(x, oy + (r1 + 1) * TS); ctx.stroke();
      }
      for (let r = r0; r <= r1 + 1; r++) {
        const y = oy + r * TS;
        ctx.beginPath(); ctx.moveTo(ox + c0 * TS, y); ctx.lineTo(ox + (c1 + 1) * TS, y); ctx.stroke();
      }
    }

    // Map border
    ctx.strokeStyle = "rgba(255,204,51,0.6)";
    ctx.lineWidth = 2;
    ctx.strokeRect(ox, oy, tm.cols * TS, tm.rows * TS);
  }, [tilemap, zoom, pan, showKindOverlay]);

  // Redraw on state change
  useEffect(() => {
    let raf: number;
    function frame() { draw(); }
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [draw]);

  // Canvas resize observer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const obs = new ResizeObserver(() => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      draw();
    });
    obs.observe(canvas);
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    return () => obs.disconnect();
  }, [draw]);

  // ── paint logic ───────────────────────────────────────────────────────────

  const canvasToCell = useCallback((cx: number, cy: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = cx - rect.left;
    const my = cy - rect.top;
    const worldX = (pan.x + mx) / zoom;
    const worldY = (pan.y + my) / zoom;
    const col = Math.floor(worldX / TILE_SIZE);
    const row = Math.floor(worldY / TILE_SIZE);
    if (col < 0 || col >= tilemap.cols || row < 0 || row >= tilemap.rows) return null;
    return { col, row };
  }, [pan, zoom, tilemap.cols, tilemap.rows]);

  const paintCell = useCallback((col: number, row: number) => {
    setTilemap((prev) => {
      const next = cloneMap(prev);
      const idx = row * next.cols + col;
      const cell = next.cells[idx];
      if (!cell) return prev;
      if (tool === "erase") {
        cell.tileId = null;
        cell.kind = "empty";
      } else if (tool === "tile") {
        cell.tileId = selectedTile;
        if (cell.kind === "empty") cell.kind = selectedKind;
      } else if (tool === "kind") {
        cell.kind = selectedKind;
        cell.passable = selectedKind !== "building";
      }
      return next;
    });
    setDirty(true);
  }, [tool, selectedTile, selectedKind]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      // Middle or alt+click = pan
      isPanning.current = true;
      panStart.current = { mx: e.clientX, my: e.clientY, ox: pan.x, oy: pan.y };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const cell = canvasToCell(e.clientX, e.clientY);
    if (!cell) return;
    isPainting.current = true;
    lastCell.current = cell;
    paintCell(cell.col, cell.row);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [canvasToCell, paintCell, pan]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isPanning.current) {
      const dx = e.clientX - panStart.current.mx;
      const dy = e.clientY - panStart.current.my;
      setPan({ x: panStart.current.ox - dx, y: panStart.current.oy - dy });
      return;
    }
    if (!isPainting.current) return;
    const cell = canvasToCell(e.clientX, e.clientY);
    if (!cell) return;
    if (lastCell.current?.col === cell.col && lastCell.current?.row === cell.row) return;
    lastCell.current = cell;
    paintCell(cell.col, cell.row);
  }, [canvasToCell, paintCell]);

  const onPointerUp = useCallback(() => {
    isPainting.current = false;
    isPanning.current = false;
  }, []);

  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // Zoom toward mouse
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));
    // Keep world point under cursor fixed
    const worldX = (pan.x + mx) / zoom;
    const worldY = (pan.y + my) / zoom;
    setPan({ x: worldX * newZoom - mx, y: worldY * newZoom - my });
    setZoom(newZoom);
  }, [zoom, pan]);

  // ── fill tool ─────────────────────────────────────────────────────────────

  const floodFill = useCallback((startCol: number, startRow: number) => {
    setTilemap((prev) => {
      const next = cloneMap(prev);
      const startCell = next.cells[startRow * next.cols + startCol];
      if (!startCell) return prev;
      const targetTileId = startCell.tileId;
      const targetKind = startCell.kind;
      const visited = new Set<number>();
      const queue: [number, number][] = [[startCol, startRow]];
      while (queue.length) {
        const [c, r] = queue.shift()!;
        if (c < 0 || c >= next.cols || r < 0 || r >= next.rows) continue;
        const key = r * next.cols + c;
        if (visited.has(key)) continue;
        visited.add(key);
        const cell = next.cells[key];
        if (!cell) continue;
        if (cell.tileId !== targetTileId || cell.kind !== targetKind) continue;
        if (tool === "erase") {
          cell.tileId = null; cell.kind = "empty";
        } else if (tool === "tile") {
          cell.tileId = selectedTile;
          if (cell.kind === "empty") cell.kind = selectedKind;
        } else {
          cell.kind = selectedKind;
          cell.passable = selectedKind !== "building";
        }
        queue.push([c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]);
      }
      return next;
    });
    setDirty(true);
  }, [tool, selectedTile, selectedKind]);

  // ── load / save ──────────────────────────────────────────────────────────

  const handleLoadFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string) as MissionTilemap;
        if (!data.cells || !data.cols || !data.rows) throw new Error("invalid");
        setTilemap(data);
        setSettingsCols(data.cols);
        setSettingsRows(data.rows);
        setSettingsOriginX(data.originWorld.x);
        setSettingsOriginY(data.originWorld.y);
        setSettingsMissionId(data.missionId);
        setDirty(false);
        setStatus(`Загружено: ${file.name} (${data.cols}×${data.rows})`);
      } catch {
        setStatus("Ошибка загрузки JSON");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }, []);

  const handleSave = useCallback(() => {
    const json = JSON.stringify(tilemap, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${tilemap.missionId}-tilemap.json`;
    a.click();
    URL.revokeObjectURL(url);
    setDirty(false);
    setStatus("Сохранено");
  }, [tilemap]);

  const handleLoadFromServer = useCallback(async () => {
    try {
      setStatus("Загрузка с сервера...");
      const res = await fetch("/maps/mission1/mission1-tilemap.json");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as MissionTilemap;
      setTilemap(data);
      setSettingsCols(data.cols);
      setSettingsRows(data.rows);
      setSettingsOriginX(data.originWorld.x);
      setSettingsOriginY(data.originWorld.y);
      setSettingsMissionId(data.missionId);
      setDirty(false);
      setStatus(`Загружено с сервера: ${data.cols}×${data.rows}`);
    } catch (err) {
      setStatus(`Ошибка загрузки: ${err}`);
    }
  }, []);

  // ── map settings apply ────────────────────────────────────────────────────

  const applyMapSettings = useCallback(() => {
    setTilemap((prev) => {
      const resized = resizeMap(prev, settingsCols, settingsRows);
      return { ...resized, missionId: settingsMissionId, originWorld: { x: settingsOriginX, y: settingsOriginY } };
    });
    setShowMapSettings(false);
    setDirty(true);
  }, [settingsCols, settingsRows, settingsOriginX, settingsOriginY, settingsMissionId]);

  // ── tile stats for palette ────────────────────────────────────────────────

  const tileUsageCount = useMemo(() => {
    const m = new Map<number, number>();
    for (const cell of tilemap.cells) {
      if (cell.tileId !== null) m.set(cell.tileId, (m.get(cell.tileId) ?? 0) + 1);
    }
    return m;
  }, [tilemap]);

  const mapStats = useMemo(() => {
    let filled = 0;
    const byKind: Record<string, number> = {};
    for (const cell of tilemap.cells) {
      if (cell.kind !== "empty") {
        filled++;
        byKind[cell.kind] = (byKind[cell.kind] ?? 0) + 1;
      }
    }
    return { filled, total: tilemap.cells.length, byKind };
  }, [tilemap]);

  // ── keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "t" || e.key === "т") setTool("tile");
      if (e.key === "k" || e.key === "л") setTool("kind");
      if (e.key === "e" || e.key === "у") setTool("erase");
      if (e.key === "o" || e.key === "щ") setShowKindOverlay((v) => !v);
      if (e.key === "Escape") onClose();
      if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); handleSave(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, handleSave]);

  // ── double-click = flood fill ─────────────────────────────────────────────

  const onDblClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const cell = canvasToCell(e.clientX, e.clientY);
    if (!cell) return;
    floodFill(cell.col, cell.row);
  }, [canvasToCell, floodFill]);

  // ── reset view ────────────────────────────────────────────────────────────

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="mapedit-root">
      {/* ── Left panel: tools + palette ── */}
      <div className="mapedit-sidebar">
        <div className="mapedit-sidebar-head">
          <span className="mapedit-title">Редактор карты</span>
          <button className="mapedit-close" onClick={onClose} title="Закрыть (Esc)">✕</button>
        </div>

        {/* Tools */}
        <div className="mapedit-section-label">Инструмент</div>
        <div className="mapedit-tools">
          <button
            className={`mapedit-tool-btn${tool === "tile" ? " active" : ""}`}
            onClick={() => setTool("tile")}
            title="Рисовать тайлом [T]"
          >
            🧱 Тайл
          </button>
          <button
            className={`mapedit-tool-btn${tool === "kind" ? " active" : ""}`}
            onClick={() => setTool("kind")}
            title="Красить тип [K]"
          >
            🎨 Тип
          </button>
          <button
            className={`mapedit-tool-btn${tool === "erase" ? " active" : ""}`}
            onClick={() => setTool("erase")}
            title="Стереть [E]"
          >
            🗑 Стереть
          </button>
        </div>

        {/* Kind selector */}
        <div className="mapedit-section-label">Тип клетки</div>
        <div className="mapedit-kinds">
          {KIND_OPTIONS.map((k) => (
            <button
              key={k}
              className={`mapedit-kind-btn${selectedKind === k ? " active" : ""}`}
              style={{ "--kind-color": KIND_COLORS[k] } as React.CSSProperties}
              onClick={() => setSelectedKind(k)}
            >
              {k}
            </button>
          ))}
        </div>

        {/* Kind overlay toggle */}
        <label className="mapedit-overlay-toggle">
          <input type="checkbox" checked={showKindOverlay} onChange={(e) => setShowKindOverlay(e.target.checked)} />
          Показать типы [O]
        </label>

        {/* Palette search */}
        <div className="mapedit-section-label">Тайлы ({TILE_COUNT})</div>
        <input
          className="mapedit-search"
          placeholder="Поиск по номеру…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="mapedit-palette-filters">
          <button
            className={`mapedit-filter-btn${paletteFilter === "all" ? " active" : ""}`}
            onClick={() => setPaletteFilter("all")}
          >все</button>
          {KIND_OPTIONS.filter(k => k !== "empty").map((k) => (
            <button
              key={k}
              className={`mapedit-filter-btn${paletteFilter === k ? " active" : ""}`}
              style={{ "--kind-color": KIND_COLORS[k] } as React.CSSProperties}
              onClick={() => setPaletteFilter(paletteFilter === k ? "all" : k)}
            >
              {k}
            </button>
          ))}
        </div>

        {/* Palette grid */}
        <div className="mapedit-palette">
          {filteredTiles.map((id) => {
            const img = tileCache.get(id);
            const used = tileUsageCount.get(id) ?? 0;
            return (
              <div
                key={id}
                className={`mapedit-tile${selectedTile === id ? " selected" : ""}`}
                onClick={() => { setSelectedTile(id); setTool("tile"); }}
                title={`tile_${String(id).padStart(3, "0")} ${used > 0 ? `(×${used})` : ""}`}
              >
                {img ? (
                  <img src={img.src} width={THUMB_SIZE} height={THUMB_SIZE} draggable={false} />
                ) : (
                  <div className="mapedit-tile-placeholder">{id}</div>
                )}
                <span className="mapedit-tile-id">{id}</span>
                {used > 0 && <span className="mapedit-tile-used" />}
              </div>
            );
          })}
          {filteredTiles.length === 0 && (
            <div className="mapedit-palette-empty">Ничего не найдено</div>
          )}
        </div>
      </div>

      {/* ── Canvas area ── */}
      <div className="mapedit-canvas-wrap">
        {/* Toolbar */}
        <div className="mapedit-toolbar">
          <button className="mapedit-btn" onClick={handleLoadFromServer} title="Загрузить mission1-tilemap.json с сервера">
            ↓ Сервер
          </button>
          <label className="mapedit-btn" title="Загрузить JSON с диска">
            📂 Файл
            <input type="file" accept=".json" onChange={handleLoadFile} style={{ display: "none" }} />
          </label>
          <button className="mapedit-btn primary" onClick={handleSave} title="Сохранить JSON (Ctrl+S)">
            💾 Сохранить{dirty ? " *" : ""}
          </button>
          <div className="mapedit-sep" />
          <button className="mapedit-btn" onClick={() => {
            setSettingsCols(tilemap.cols);
            setSettingsRows(tilemap.rows);
            setSettingsOriginX(tilemap.originWorld.x);
            setSettingsOriginY(tilemap.originWorld.y);
            setSettingsMissionId(tilemap.missionId);
            setShowMapSettings(true);
          }}>
            ⚙ Карта ({tilemap.cols}×{tilemap.rows})
          </button>
          <div className="mapedit-sep" />
          <button className="mapedit-btn" onClick={resetView} title="Сбросить вид">⊙ Вид</button>
          <span className="mapedit-zoom-label">{Math.round(zoom * 100)}%</span>
          <div className="mapedit-sep" />
          <span className="mapedit-stat">
            {mapStats.filled}/{mapStats.total} кл.
          </span>
        </div>

        {/* Canvas */}
        <canvas
          ref={canvasRef}
          className="mapedit-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          onWheel={onWheel}
          onDoubleClick={onDblClick}
          style={{ cursor: tool === "erase" ? "crosshair" : "default" }}
        />

        {/* Status bar */}
        <div className="mapedit-statusbar">
          <span>{status}</span>
          <span className="mapedit-hints">
            ЛКМ — рисовать · ДабклПКМ — заливка · Alt+ЛКМ / СКМ — перетащить · Колесо — масштаб · T/K/E — инструмент · O — типы · Ctrl+S — сохранить
          </span>
        </div>
      </div>

      {/* ── Map settings modal ── */}
      {showMapSettings && (
        <div className="mapedit-modal-backdrop" onClick={() => setShowMapSettings(false)}>
          <div className="mapedit-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Настройки карты</h3>
            <label>Mission ID
              <input value={settingsMissionId} onChange={(e) => setSettingsMissionId(e.target.value)} />
            </label>
            <label>Колонны
              <input type="number" min={1} max={500} value={settingsCols}
                onChange={(e) => setSettingsCols(Math.max(1, +e.target.value))} />
            </label>
            <label>Строки
              <input type="number" min={1} max={500} value={settingsRows}
                onChange={(e) => setSettingsRows(Math.max(1, +e.target.value))} />
            </label>
            <label>Начало мира X
              <input type="number" value={settingsOriginX}
                onChange={(e) => setSettingsOriginX(+e.target.value)} />
            </label>
            <label>Начало мира Y
              <input type="number" value={settingsOriginY}
                onChange={(e) => setSettingsOriginY(+e.target.value)} />
            </label>
            <p className="mapedit-modal-note">
              Изменение размеров обрежет или дополнит карту пустыми клетками.
            </p>
            <div className="mapedit-modal-actions">
              <button className="mapedit-btn primary" onClick={applyMapSettings}>Применить</button>
              <button className="mapedit-btn" onClick={() => setShowMapSettings(false)}>Отмена</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
