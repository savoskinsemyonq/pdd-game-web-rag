import { useCallback, useRef, useState } from "react";

export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Options {
  minWidth?: number;
  minHeight?: number;
  resizable?: boolean;
}

function clampSize(w: number, h: number, minW: number, minH: number): { w: number; h: number } {
  const maxW = window.innerWidth - 16;
  const maxH = window.innerHeight - 16;
  return {
    w: Math.min(maxW, Math.max(minW, w)),
    h: Math.min(maxH, Math.max(minH, h)),
  };
}

function clampPos(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(window.innerWidth - w - 8, x)),
    y: Math.max(8, Math.min(window.innerHeight - h - 8, y)),
  };
}

export function useFloatingPanel(options: Options = {}) {
  const minWidth = options.minWidth ?? 280;
  const minHeight = options.minHeight ?? 220;
  const resizable = options.resizable ?? false;

  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState<{ w: number; h?: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);

  const dragRef = useRef<{
    startMouseX: number;
    startMouseY: number;
    startPosX: number;
    startPosY: number;
    width: number;
    height: number;
  } | null>(null);

  const resizeRef = useRef<{
    startMouseX: number;
    startMouseY: number;
    startW: number;
    startH: number;
  } | null>(null);

  const captureRect = useCallback((): PanelRect => {
    const el = ref.current!;
    const rect = el.getBoundingClientRect();
    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  }, []);

  const ensureFloating = useCallback(() => {
    const rect = captureRect();
    setSize((prev) => prev ?? { w: rect.w, h: undefined });
    setPos((prev) => prev ?? { x: rect.x, y: rect.y });
    return rect;
  }, [captureRect]);

  const setInitialLayout = useCallback((layout: Partial<PanelRect> & { h?: number }) => {
    if (layout.x != null && layout.y != null) {
      const w = layout.w ?? ref.current?.getBoundingClientRect().width ?? minWidth;
      const h = layout.h ?? ref.current?.getBoundingClientRect().height ?? minHeight;
      setPos(clampPos(layout.x, layout.y, w, h));
    }
    if (layout.w != null) {
      if (layout.h != null) {
        setSize(clampSize(layout.w, layout.h, minWidth, minHeight));
      } else {
        setSize({ w: layout.w });
      }
    } else if (layout.h != null) {
      setSize((prev) => ({ w: prev?.w ?? minWidth, h: layout.h! }));
    }
  }, [minWidth, minHeight]);

  const resetLayout = useCallback(() => {
    setPos(null);
    setSize(null);
  }, []);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0 || resizing) return;
    const rect = ensureFloating();
    const liveH = size?.h ?? rect.h;
    dragRef.current = {
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startPosX: rect.x,
      startPosY: rect.y,
      width: size?.w ?? rect.w,
      height: liveH,
    };
    setDragging(true);

    function onMove(ev: MouseEvent) {
      if (!dragRef.current) return;
      const { startMouseX, startMouseY, startPosX, startPosY, width, height } = dragRef.current;
      const next = clampPos(
        startPosX + ev.clientX - startMouseX,
        startPosY + ev.clientY - startMouseY,
        width,
        height,
      );
      setPos(next);
    }

    function onUp() {
      dragRef.current = null;
      setDragging(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
  }, [ensureFloating, resizing, size]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    if (!resizable || e.button !== 0) return;
    const rect = ensureFloating();
    resizeRef.current = {
      startMouseX: e.clientX,
      startMouseY: e.clientY,
      startW: size?.w ?? rect.w,
      startH: size?.h ?? rect.h,
    };
    setResizing(true);

    function onMove(ev: MouseEvent) {
      if (!resizeRef.current) return;
      const next = clampSize(
        resizeRef.current.startW + ev.clientX - resizeRef.current.startMouseX,
        resizeRef.current.startH + ev.clientY - resizeRef.current.startMouseY,
        minWidth,
        minHeight,
      );
      setSize(next);
      setPos((prev) => {
        const current = prev ?? { x: rect.x, y: rect.y };
        return clampPos(current.x, current.y, next.w, next.h);
      });
    }

    function onUp() {
      resizeRef.current = null;
      setResizing(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    e.preventDefault();
    e.stopPropagation();
  }, [ensureFloating, minWidth, minHeight, resizable, size]);

  const panelStyle: React.CSSProperties = {};
  const isFloating = pos != null;

  if (size?.w) panelStyle.width = size.w;
  if (size?.h != null && size.h > 0) panelStyle.height = size.h;
  if (isFloating && pos) {
    panelStyle.position = "fixed";
    panelStyle.left = pos.x;
    panelStyle.top = pos.y;
    panelStyle.zIndex = 1002;
    panelStyle.margin = 0;
  }

  return {
    ref,
    pos,
    size,
    dragging,
    resizing,
    isFloating,
    panelStyle,
    onDragStart,
    onResizeStart,
    setInitialLayout,
    resetLayout,
  };
}
