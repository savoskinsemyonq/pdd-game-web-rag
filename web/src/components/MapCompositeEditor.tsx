import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  applyOverrides,
  SURFACE_DRAW_ORDER,
  useCompositeStore,
  type CompositeOverrides,
  type MarkingDashPreset,
  type SurfaceKind,
} from "../state/compositeStore";
import { cameraSignal } from "../state/cameraSignal";

/** Quick corridor widths for the stroke tool (world px). */
const STROKE_WIDTH_PRESETS = [48, 96, 160, 240] as const;

function surfaceKindOptionLabel(k: SurfaceKind): string {
  if (k === "grass") return "grass (трава)";
  return k;
}

const PANEL_POS_LS_KEY = "compositeEditorPanelPos";
const PANEL_WIDTH_CSS = 300;
const PANEL_EDGE = 16;

function defaultPanelPosition(): { left: number; top: number } {
  if (typeof window === "undefined") return { left: PANEL_EDGE, top: PANEL_EDGE };
  return {
    left: Math.max(PANEL_EDGE, window.innerWidth - PANEL_WIDTH_CSS - PANEL_EDGE),
    top: PANEL_EDGE,
  };
}

function loadPanelPosition(): { left: number; top: number } {
  try {
    const raw = localStorage.getItem(PANEL_POS_LS_KEY);
    if (!raw) return defaultPanelPosition();
    const p = JSON.parse(raw) as unknown;
    if (
      p &&
      typeof p === "object" &&
      typeof (p as { left?: unknown }).left === "number" &&
      typeof (p as { top?: unknown }).top === "number"
    ) {
      return { left: (p as { left: number }).left, top: (p as { top: number }).top };
    }
  } catch {
    /* ignore */
  }
  return defaultPanelPosition();
}

function persistPanelPosition(left: number, top: number): void {
  try {
    localStorage.setItem(PANEL_POS_LS_KEY, JSON.stringify({ left, top }));
  } catch {
    /* ignore */
  }
}

/** Keep at least `keepVisible` px of the panel inside the viewport. */
function clampPanelPosition(left: number, top: number, panelEl: HTMLElement): { left: number; top: number } {
  const { width: pw, height: ph } = panelEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 8;
  const keepVisible = 72;
  const minLeft = margin - pw + keepVisible;
  const maxLeft = vw - keepVisible;
  const minTop = margin;
  const maxTop = vh - keepVisible;
  return {
    left: Math.min(maxLeft, Math.max(minLeft, left)),
    top: Math.min(maxTop, Math.max(minTop, top)),
  };
}

interface Props {
  onClose: () => void;
}

interface SpriteCatalogEntry {
  file: string;
  w: number;
  h: number;
}

/**
 * Floating panel for composite-map editing on mission 2. Surfaces all editor
 * commands; pointer interactions live in `MissionWorldOverlay` so the panel
 * stays a thin controller over the shared `useCompositeStore` state.
 */
export function MapCompositeEditor({ onClose }: Props) {
  const baseScene = useCompositeStore((s) => s.baseScene);
  const overrides = useCompositeStore((s) => s.overrides);
  const selectedSpriteId = useCompositeStore((s) => s.selectedSpriteId);
  const editorTool = useCompositeStore((s) => s.editorTool);
  const paintKind = useCompositeStore((s) => s.paintKind);
  const strokeWidthWorld = useCompositeStore((s) => s.strokeWidthWorld);
  const markingLineWidthWorld = useCompositeStore((s) => s.markingLineWidthWorld);
  const markingDashPreset = useCompositeStore((s) => s.markingDashPreset);
  const markingColor = useCompositeStore((s) => s.markingColor);
  const crosswalkOrient = useCompositeStore((s) => s.crosswalkOrient);
  const setEditorTool = useCompositeStore((s) => s.setEditorTool);
  const setPaintKind = useCompositeStore((s) => s.setPaintKind);
  const setStrokeWidthWorld = useCompositeStore((s) => s.setStrokeWidthWorld);
  const setMarkingLineWidthWorld = useCompositeStore((s) => s.setMarkingLineWidthWorld);
  const setMarkingDashPreset = useCompositeStore((s) => s.setMarkingDashPreset);
  const setMarkingColor = useCompositeStore((s) => s.setMarkingColor);
  const setCrosswalkOrient = useCompositeStore((s) => s.setCrosswalkOrient);
  const setSelectedSprite = useCompositeStore((s) => s.setSelectedSprite);
  const updateOverrides = useCompositeStore((s) => s.updateOverrides);
  const setOverrides = useCompositeStore((s) => s.setOverrides);
  const undoStack = useCompositeStore((s) => s.undoStack);
  const redoStack = useCompositeStore((s) => s.redoStack);
  const undo = useCompositeStore((s) => s.undo);
  const redo = useCompositeStore((s) => s.redo);
  const snapshotUndo = useCompositeStore((s) => s.snapshotUndo);
  const scaleSelectedSprite = useCompositeStore((s) => s.scaleSelectedSprite);
  const missionId = useCompositeStore((s) => s.missionId);
  const spriteBaseUrl = useCompositeStore((s) => s.spriteBaseUrl);

  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState(loadPanelPosition);
  const [headerDragging, setHeaderDragging] = useState(false);

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    setPanelPos((p) => clampPanelPosition(p.left, p.top, el));
  }, []);

  useEffect(() => {
    function onResize() {
      const el = panelRef.current;
      if (!el) return;
      setPanelPos((p) => clampPanelPosition(p.left, p.top, el));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function onHeaderPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".composite-editor__close")) return;
    const panel = panelRef.current;
    if (!panel) return;
    e.preventDefault();
    const pid = e.pointerId;
    const sx = e.clientX;
    const sy = e.clientY;
    const rect = panel.getBoundingClientRect();
    const originLeft = rect.left;
    const originTop = rect.top;
    setHeaderDragging(true);

    function move(ev: PointerEvent) {
      if (ev.pointerId !== pid) return;
      const el = panelRef.current;
      if (!el) return;
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      setPanelPos(clampPanelPosition(originLeft + dx, originTop + dy, el));
    }
    function end(ev: PointerEvent) {
      if (ev.pointerId !== pid) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setHeaderDragging(false);
      const el = panelRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const next = clampPanelPosition(r.left, r.top, el);
        setPanelPos(next);
        persistPanelPosition(next.left, next.top);
      }
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  const mergedScene = useMemo(
    () => (baseScene ? applyOverrides(baseScene, overrides) : null),
    [baseScene, overrides],
  );
  const selectedSprite = useMemo(() => {
    if (!mergedScene || !selectedSpriteId) return null;
    return mergedScene.sprites.find((sp) => (sp.id ?? sp.file) === selectedSpriteId) ?? null;
  }, [mergedScene, selectedSpriteId]);

  const spriteTemplatesFromScene = useMemo(() => {
    const m = new Map<string, SpriteCatalogEntry>();
    if (!mergedScene) return [];
    for (const sp of mergedScene.sprites) {
      if (!m.has(sp.file)) m.set(sp.file, { file: sp.file, w: sp.w, h: sp.h });
    }
    return [...m.values()].sort((a, b) => a.file.localeCompare(b.file));
  }, [mergedScene]);

  const [catalogFromJson, setCatalogFromJson] = useState<SpriteCatalogEntry[]>([]);
  const [catalogPickFile, setCatalogPickFile] = useState("");

  useEffect(() => {
    if (!missionId) return;
    let cancelled = false;
    fetch(`/maps/${missionId}/sprite-catalog.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: unknown) => {
        if (cancelled || !data || typeof data !== "object") return;
        const sprites = (data as { sprites?: unknown }).sprites;
        if (!Array.isArray(sprites)) return;
        const list: SpriteCatalogEntry[] = [];
        for (const x of sprites) {
          if (
            x !== null &&
            typeof x === "object" &&
            typeof (x as { file?: unknown }).file === "string" &&
            typeof (x as { w?: unknown }).w === "number" &&
            typeof (x as { h?: unknown }).h === "number"
          ) {
            list.push({ file: (x as { file: string }).file, w: (x as { w: number }).w, h: (x as { h: number }).h });
          }
        }
        setCatalogFromJson(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [missionId]);

  const spritePickList = useMemo(() => {
    const m = new Map<string, SpriteCatalogEntry>();
    for (const t of [...spriteTemplatesFromScene, ...catalogFromJson]) {
      if (!m.has(t.file)) m.set(t.file, t);
    }
    return [...m.values()].sort((a, b) => a.file.localeCompare(b.file));
  }, [spriteTemplatesFromScene, catalogFromJson]);

  useEffect(() => {
    if (spritePickList.length === 0) {
      setCatalogPickFile("");
      return;
    }
    setCatalogPickFile((prev) =>
      prev && spritePickList.some((s) => s.file === prev) ? prev : spritePickList[0]!.file,
    );
  }, [spritePickList]);

  function addSpriteFromCatalog() {
    const tpl = spritePickList.find((s) => s.file === catalogPickFile);
    if (!tpl) return;
    snapshotUndo();
    const id = `added-${Date.now()}`;
    updateOverrides((cur) => ({
      ...cur,
      addedSprites: [
        ...(cur.addedSprites ?? []),
        {
          id,
          file: tpl.file,
          cx: cameraSignal.cx,
          cy: cameraSignal.cy,
          w: tpl.w,
          h: tpl.h,
        },
      ],
    }));
    setSelectedSprite(id);
    setEditorTool("select");
  }

  function deleteSelected() {
    if (!selectedSpriteId) return;
    snapshotUndo();
    updateOverrides((cur) => {
      // If this sprite was added by the user, remove it from addedSprites instead.
      const added = cur.addedSprites ?? [];
      const matchAdded = added.findIndex((sp) => (sp.id ?? sp.file) === selectedSpriteId);
      if (matchAdded >= 0) {
        const next = [...added];
        next.splice(matchAdded, 1);
        return { ...cur, addedSprites: next };
      }
      return {
        ...cur,
        spriteOverrides: {
          ...(cur.spriteOverrides ?? {}),
          [selectedSpriteId]: { ...(cur.spriteOverrides?.[selectedSpriteId] ?? {}), deleted: true },
        },
      };
    });
    setSelectedSprite(null);
  }

  function duplicateSelected() {
    if (!selectedSprite) return;
    snapshotUndo();
    const newId = `added-${Date.now()}`;
    updateOverrides((cur) => ({
      ...cur,
      addedSprites: [
        ...(cur.addedSprites ?? []),
        {
          id: newId,
          file: selectedSprite.file,
          cx: selectedSprite.cx + 30,
          cy: selectedSprite.cy + 30,
          w: selectedSprite.w,
          h: selectedSprite.h,
          angle: selectedSprite.angle,
        },
      ],
    }));
    setSelectedSprite(newId);
  }

  function resetSelected() {
    if (!selectedSpriteId) return;
    snapshotUndo();
    updateOverrides((cur) => {
      const so = { ...(cur.spriteOverrides ?? {}) };
      delete so[selectedSpriteId];
      return { ...cur, spriteOverrides: so };
    });
  }

  function clearAll() {
    if (!confirm("Очистить все правки этой миссии?")) return;
    snapshotUndo();
    setOverrides({}, { resetHistory: false });
    setSelectedSprite(null);
  }

  async function exportToClipboard() {
    const json = JSON.stringify(overrides);
    try {
      await navigator.clipboard.writeText(json);
      alert("JSON правок скопирован в буфер. Вставь в mission2-composite.overrides.json.");
    } catch {
      console.log("Composite overrides JSON:", json);
      alert("Не удалось скопировать. Смотри console.log.");
    }
  }

  async function importFromClipboard() {
    try {
      const raw = await navigator.clipboard.readText();
      const parsed = JSON.parse(raw) as CompositeOverrides;
      snapshotUndo();
      setOverrides(parsed, { resetHistory: false });
      alert("Правки загружены из буфера обмена.");
    } catch (err) {
      alert(`Не удалось прочитать/разобрать буфер: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div
      ref={panelRef}
      className="composite-editor"
      style={{ left: panelPos.left, top: panelPos.top }}
    >
      <div
        className={
          headerDragging
            ? "composite-editor__header composite-editor__header--dragging"
            : "composite-editor__header composite-editor__header--draggable"
        }
        onPointerDown={onHeaderPointerDown}
        title="Перетащить окно"
      >
        <strong className="composite-editor__title">Редактор карты</strong>
        <button type="button" onClick={onClose} className="composite-editor__close">×</button>
      </div>

      <section>
        <div className="composite-editor__section-title">Действия</div>
        <div className="composite-editor__row">
          <button type="button" disabled={undoStack.length === 0} onClick={() => undo()}>
            Отменить
          </button>
          <button type="button" disabled={redoStack.length === 0} onClick={() => redo()}>
            Повторить
          </button>
        </div>
        <div className="composite-editor__shortcut-list">
          <span><kbd>Ctrl</kbd>+<kbd>Z</kbd> отмена</span>
          <span><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> повтор</span>
          <span>
            <kbd>1</kbd> выделение · <kbd>2</kbd> поверхн. прямоуг. · <kbd>3</kbd> коридор ·{" "}
            <kbd>7</kbd> трамвайные рельсы · <kbd>4</kbd> линия разметки · <kbd>5</kbd> зебра ·{" "}
            <kbd>6</kbd> зона · <kbd>8</kbd> ластик
          </span>
          <span>
            <kbd>[</kbd>/<kbd>]</kbd> ширина коридора (<kbd>3</kbd>) или линии разметки (<kbd>4</kbd>);{" "}
            <kbd>Alt</kbd>+<kbd>[</kbd>/<kbd>]</kbd> масштаб выделенного спрайта (<kbd>Shift</kbd> — мелкий шаг)
          </span>
          <span><kbd>Esc</kbd> отменить жест / закрыть панель</span>
          <span><kbd>M</kbd> открыть редактор снова</span>
          <span>Перемещение: тяни за заголовок «Редактор карты»</span>
        </div>
      </section>

      <section>
        <div className="composite-editor__section-title">Выделение</div>
        <div className="composite-editor__subsection-title">Добавить спрайт</div>
        {spritePickList.length === 0 ? (
          <div className="composite-editor__hint">
            Нет шаблонов: в сцене нет спрайтов и не загружен{" "}
            <code>sprite-catalog.json</code>. Для mission2 запусти{" "}
            <code>extract-mission2-sprites.py</code> (создаёт каталог и PNG в{" "}
            <code>sprites/</code>).
          </div>
        ) : (
          <>
            <div className="composite-editor__row composite-editor__row--catalog">
              {spriteBaseUrl ? (
                <img
                  className="composite-editor__catalog-thumb"
                  src={`${spriteBaseUrl}${catalogPickFile}`}
                  alt=""
                  width={40}
                  height={40}
                />
              ) : null}
              <label className="composite-editor__catalog-select">
                Спрайт:&nbsp;
                <select
                  value={catalogPickFile}
                  onChange={(e) => setCatalogPickFile(e.target.value)}
                >
                  {spritePickList.map((t) => (
                    <option key={t.file} value={t.file}>
                      {t.file.replace(/^sprites\//, "")} ({t.w}×{t.h})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="composite-editor__row">
              <button type="button" onClick={addSpriteFromCatalog}>
                Вставить в центр экрана
              </button>
            </div>
            <div className="composite-editor__hint">
              Новый экземпляр появится в точке камеры; затем перетащи его на карте.
            </div>
          </>
        )}
        {selectedSprite ? (
          <>
            <div className="composite-editor__sprite-info">
              <div><b>id:</b> {selectedSpriteId}</div>
              <div><b>file:</b> {selectedSprite.file}</div>
              <div>
                <b>x:</b> {selectedSprite.cx.toFixed(0)} <b>y:</b> {selectedSprite.cy.toFixed(0)}
              </div>
              <div><b>w×h:</b> {selectedSprite.w}×{selectedSprite.h}</div>
            </div>
            <div className="composite-editor__row composite-editor__row--sprite-scale">
              <span className="composite-editor__muted">Масштаб:</span>
              <button
                type="button"
                title="Уменьшить (~×0.91)"
                onClick={() => {
                  snapshotUndo();
                  scaleSelectedSprite(1 / 1.1);
                }}
              >
                −
              </button>
              <button
                type="button"
                title="Уменьшить слегка (~×0.95)"
                onClick={() => {
                  snapshotUndo();
                  scaleSelectedSprite(1 / 1.05);
                }}
              >
                −5%
              </button>
              <button
                type="button"
                title="Увеличить слегка (~×1.05)"
                onClick={() => {
                  snapshotUndo();
                  scaleSelectedSprite(1.05);
                }}
              >
                +5%
              </button>
              <button
                type="button"
                title="Увеличить (~×1.1)"
                onClick={() => {
                  snapshotUndo();
                  scaleSelectedSprite(1.1);
                }}
              >
                +
              </button>
            </div>
            <div className="composite-editor__row">
              <button onClick={deleteSelected}>Удалить</button>
              <button onClick={duplicateSelected}>Дублировать</button>
              <button onClick={resetSelected}>Сбросить</button>
            </div>
          </>
        ) : (
          <div className="composite-editor__hint">
            Кликни на спрайт, чтобы выделить. Перетаскивай для перемещения.
          </div>
        )}
      </section>

      <section>
        <div className="composite-editor__section-title">Рисование на карте</div>
        <div className="composite-editor__row composite-editor__row--radio">
          <label className="composite-editor__radio">
            <input
              type="radio"
              name="composite-edit-tool"
              checked={editorTool === "select"}
              onChange={() => setEditorTool("select")}
            />
            Выделение спрайта
          </label>
          <label className="composite-editor__radio">
            <input
              type="radio"
              name="composite-edit-tool"
              checked={editorTool === "paint"}
              onChange={() => setEditorTool("paint")}
            />
            Прямоугольник поверхности
          </label>
          <label className="composite-editor__radio">
            <input
              type="radio"
              name="composite-edit-tool"
              checked={editorTool === "stroke"}
              onChange={() => setEditorTool("stroke")}
            />
            Коридор поверхности
          </label>
          <label className="composite-editor__radio">
            <input
              type="radio"
              name="composite-edit-tool"
              checked={editorTool === "marking_tram"}
              onChange={() => setEditorTool("marking_tram")}
            />
            Трамвайные рельсы (по дуге)
          </label>
          <label className="composite-editor__radio">
            <input
              type="radio"
              name="composite-edit-tool"
              checked={editorTool === "marking_line"}
              onChange={() => setEditorTool("marking_line")}
            />
            Линия разметки
          </label>
          <label className="composite-editor__radio">
            <input
              type="radio"
              name="composite-edit-tool"
              checked={editorTool === "marking_crosswalk"}
              onChange={() => setEditorTool("marking_crosswalk")}
            />
            Пешеходный переход (зебра)
          </label>
          <label className="composite-editor__radio">
            <input
              type="radio"
              name="composite-edit-tool"
              checked={editorTool === "marking_zone"}
              onChange={() => setEditorTool("marking_zone")}
            />
            Зона разметки (заливка)
          </label>
          <label className="composite-editor__radio">
            <input
              type="radio"
              name="composite-edit-tool"
              checked={editorTool === "erase"}
              onChange={() => setEditorTool("erase")}
            />
            Ластик (стереть объекты в прямоугольнике)
          </label>
        </div>

        {(editorTool === "paint" || editorTool === "stroke") && (
          <div className="composite-editor__row">
            <label>
              Тип поверхности:&nbsp;
              <select
                value={paintKind}
                onChange={(e) => setPaintKind(e.target.value as SurfaceKind)}
              >
                {SURFACE_DRAW_ORDER.map((k) => (
                  <option key={k} value={k}>
                    {surfaceKindOptionLabel(k)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {editorTool === "stroke" ? (
          <>
            <div className="composite-editor__row">
              <label>
                Ширина коридора (мировые px):{" "}
                <input
                  type="number"
                  min={8}
                  max={1200}
                  step={4}
                  value={strokeWidthWorld}
                  onChange={(e) => setStrokeWidthWorld(Number(e.target.value))}
                  style={{ width: "4.5rem" }}
                />
              </label>
            </div>
            <div className="composite-editor__row composite-editor__preset-row">
              {STROKE_WIDTH_PRESETS.map((w) => (
                <button
                  key={w}
                  type="button"
                  className={strokeWidthWorld === w ? "composite-editor__preset composite-editor__preset--active" : "composite-editor__preset"}
                  onClick={() => setStrokeWidthWorld(w)}
                >
                  {w}px
                </button>
              ))}
            </div>
          </>
        ) : null}

        {editorTool === "marking_line" ? (
          <>
            <div className="composite-editor__row">
              <label>
                Толщина линии (мировые px):{" "}
                <input
                  type="number"
                  min={2}
                  max={80}
                  step={1}
                  value={markingLineWidthWorld}
                  onChange={(e) => setMarkingLineWidthWorld(Number(e.target.value))}
                  style={{ width: "4rem" }}
                />
              </label>
            </div>
            <div className="composite-editor__row">
              <label>
                Штриховка:&nbsp;
                <select
                  value={markingDashPreset}
                  onChange={(e) => setMarkingDashPreset(e.target.value as MarkingDashPreset)}
                >
                  <option value="solid">Сплошная</option>
                  <option value="dash_long">Длинный пунктир</option>
                  <option value="dash_short">Короткий пунктир</option>
                  <option value="dash_center">Осевая (рваная)</option>
                </select>
              </label>
            </div>
          </>
        ) : null}

        {editorTool === "marking_crosswalk" ? (
          <div className="composite-editor__row">
            <label>
              Полоски зебры:&nbsp;
              <select
                value={crosswalkOrient}
                onChange={(e) => setCrosswalkOrient(e.target.value as "h" | "v")}
              >
                <option value="h">Горизонтальные в полосе</option>
                <option value="v">Вертикальные в полосе</option>
              </select>
            </label>
          </div>
        ) : null}

        {(editorTool === "marking_line" ||
          editorTool === "marking_crosswalk" ||
          editorTool === "marking_zone") && (
          <div className="composite-editor__row">
            <label>
              Цвет разметки:&nbsp;
              <input
                type="color"
                value={markingColor.startsWith("#") ? markingColor : "#ffffff"}
                onChange={(e) => setMarkingColor(e.target.value)}
                style={{ width: "2.25rem", height: "1.5rem", padding: 0, border: "none", cursor: "pointer" }}
              />
            </label>
          </div>
        )}

        <div className="composite-editor__hint">
          {editorTool === "select"
            ? "Выбери спрайт на карте для перемещения."
            : editorTool === "paint"
              ? "Потяни прямоугольник поверхности. Shift — квадрат. Разметка (окна, линии) рисуется поверх поверхностей — её не перекроет трава; для этого есть ластик (8)."
              : editorTool === "stroke"
                ? "Веди коридор поверхности. Shift — ортогонально от последней точки."
                : editorTool === "marking_tram"
                  ? "Четыре тёмные параллельные линии по центральному пути. Веди как коридор; Shift — ортогонально от последней точки."
                  : editorTool === "marking_line"
                    ? "Линия разметки с прямоугольными торцами (без скруглений). Shift — горизонталь или вертикаль."
                    : editorTool === "marking_crosswalk"
                      ? "Зебра: полосы и промежутки фиксированной ширины (как масштаб на карте), блок центрируется в прямоугольнике."
                      : editorTool === "marking_zone"
                        ? "Потяни прямоугольник сплошной заливки (стоп-линия, выделение)."
                        : editorTool === "erase"
                          ? "Потяни прямоугольник: стирается только то, что реально пересекает ластик. Большие полигоны/спрайты — если покрыто мало площади, не трогаем (нет ложных удалений «далеко»). Shift — квадрат."
                          : ""}
        </div>
      </section>

      <section>
        <div className="composite-editor__section-title">Сохранение</div>
        <div className="composite-editor__hint">
          Правки автоматически сохраняются в localStorage. Для коммита в репозиторий
          экспортируй и вставь в <code>mission2-composite.overrides.json</code>.
        </div>
        <div className="composite-editor__row">
          <button onClick={exportToClipboard}>Экспорт</button>
          <button onClick={importFromClipboard}>Импорт</button>
          <button onClick={clearAll}>Очистить все</button>
        </div>
        <div className="composite-editor__counts">
          {countOverrides(overrides)}
        </div>
      </section>
    </div>
  );
}

function countOverrides(o: CompositeOverrides): string {
  const moved = Object.values(o.spriteOverrides ?? {}).filter(
    (v) =>
      !v.deleted &&
      (typeof v.cx === "number" ||
        typeof v.cy === "number" ||
        typeof v.w === "number" ||
        typeof v.h === "number" ||
        typeof v.angle === "number"),
  ).length;
  const deleted = Object.values(o.spriteOverrides ?? {}).filter((v) => v.deleted).length;
  const added =
    (o.addedSprites?.length ?? 0) +
    (o.addedSurfaces?.length ?? 0) +
    (o.addedMarkings?.length ?? 0);
  const hidM = o.hiddenBaseMarkingIndices?.length ?? 0;
  const hidS = o.hiddenBaseSurfaceIndices?.length ?? 0;
  return `Перемещено ${moved} • удалено ${deleted} • добавлено ${added} • скрыто базы: разметка ${hidM}, поверхности ${hidS}`;
}
