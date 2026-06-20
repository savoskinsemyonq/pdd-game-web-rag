import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PddChat } from "./PddChat";
import { useFloatingPanel } from "../hooks/useFloatingPanel";

interface Props {
  message: string;
  fine: number;
  licenseRevokeMonths: number | null;
  lostTime: number;
  errorContext: string;
  contextKey?: string;
  sceneId?: string;
  nodeId?: string;
  onClose: () => void;
  onMessagesUpdate?: (messages: { role: "user" | "assistant"; content: string }[]) => void;
}

const POPUP_WIDTH = 360;
const CHAT_WIDTH = 420;
const CHAT_HEIGHT = 480;
const GAP = 16;

export function ErrorInspectorPanel({
  message,
  fine,
  licenseRevokeMonths,
  lostTime,
  errorContext,
  contextKey,
  sceneId,
  nodeId,
  onClose,
  onMessagesUpdate,
}: Props) {
  const layoutReadyRef = useRef(false);
  const { ref, dragging, panelStyle, onDragStart, setInitialLayout } = useFloatingPanel({
    minWidth: 280,
    minHeight: 180,
    resizable: false,
  });
  const [chatLayout, setChatLayout] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  useLayoutEffect(() => {
    if (layoutReadyRef.current) return;
    layoutReadyRef.current = true;

    const totalW = POPUP_WIDTH + GAP + CHAT_WIDTH;
    const x = Math.max(16, (window.innerWidth - totalW) / 2);
    const y = Math.max(16, (window.innerHeight - CHAT_HEIGHT) / 2);

    setInitialLayout({ x, y, w: POPUP_WIDTH });
    setChatLayout({ x: x + POPUP_WIDTH + GAP, y, w: CHAT_WIDTH, h: CHAT_HEIGHT });
  }, [setInitialLayout]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function penaltyLabel() {
    if (licenseRevokeMonths != null) {
      return `Лишение прав на срок до ${licenseRevokeMonths} мес.`;
    }
    return fine > 0 ? `Штраф: ${fine} ₽` : "Без денежного штрафа";
  }

  return (
    <div className="error-inspector-backdrop">
      <div className="error-inspector-layer">
        <div
          ref={ref}
          className={`error-inspector__popup error-inspector__popup--floating${dragging ? " error-inspector__popup--dragging" : ""}`}
          style={panelStyle}
        >
          <div
            className="error-inspector__popup-header"
            onMouseDown={onDragStart}
            title="Перетащите, чтобы переместить"
          >
            <div className="error-inspector__badge">Инспектор ГИБДД</div>
            <h2>Что случилось?</h2>
            <span className="error-inspector__drag-hint" aria-hidden>⠿</span>
          </div>
          <div className="error-inspector__meta">
            {penaltyLabel()}
            {lostTime > 0 ? ` · Потеряно времени: ${lostTime} мин` : ""}
          </div>
          <p className="error-inspector__message">{message}</p>
          <button
            className="error-inspector__continue"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onClose}
            autoFocus
          >
            Продолжить игру
          </button>
        </div>

        {chatLayout && (
          <PddChat
            open
            embedded
            autoExplain
            mode="error"
            initialErrorContext={errorContext}
            contextKey={contextKey}
            sceneId={sceneId}
            nodeId={nodeId}
            onClose={onClose}
            onMessagesUpdate={onMessagesUpdate}
            defaultLayout={chatLayout}
          />
        )}
      </div>
    </div>
  );
}
