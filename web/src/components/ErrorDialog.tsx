import { useEffect } from "react";

interface Props {
  message: string;
  fine: number;
  licenseRevokeMonths: number | null;
  lostTime: number;
  chatOpen: boolean;
  onClose: () => void;
  onAskInspector: () => void;
}

export function ErrorDialog({ message, fine, licenseRevokeMonths, lostTime, chatOpen, onClose, onAskInspector }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (chatOpen) return;
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, chatOpen]);

  function penaltyLabel() {
    if (licenseRevokeMonths != null) {
      return `Лишение прав на срок до ${licenseRevokeMonths} мес.`;
    }
    return fine > 0 ? `Штраф: ${fine} ₽` : "Без денежного штрафа";
  }

  return (
    <div className="error-dialog-backdrop" onClick={chatOpen ? undefined : onClose}>
      <div className="error-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Инспектор ГИБДД объясняет</h2>
        <div className="meta">
          {penaltyLabel()}
          {lostTime > 0 ? `   ·  Потеряно времени: ${lostTime} мин` : ""}
        </div>
        <p>{message}</p>
        <div className="error-dialog__actions">
          <button autoFocus disabled={chatOpen} onClick={onClose}>
            Продолжить
          </button>
          <button
            className="error-dialog__ask-btn"
            onClick={(e) => { e.stopPropagation(); onAskInspector(); }}
          >
            {chatOpen ? "Чат открыт" : "Спросить инспектора"}
          </button>
        </div>
      </div>
    </div>
  );
}
