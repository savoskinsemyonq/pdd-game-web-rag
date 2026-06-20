import { useEffect, useMemo, useRef, useState } from "react";
import { useFloatingPanel } from "../hooks/useFloatingPanel";
import { useSileroTts } from "../hooks/useSileroTts";
import { TtsControls } from "./TtsControls";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  initialErrorContext: string;
  contextKey?: string;
  sceneId?: string;
  nodeId?: string;
  onMessagesUpdate?: (messages: Message[]) => void;
  embedded?: boolean;
  draggable?: boolean;
  resizable?: boolean;
  autoExplain?: boolean;
  mode?: "error" | "analysis";
  hideClose?: boolean;
  defaultLayout?: { x: number; y: number; w?: number; h?: number };
}

export function PddChat({
  open,
  onClose,
  initialErrorContext,
  contextKey,
  sceneId,
  nodeId,
  onMessagesUpdate,
  embedded = false,
  draggable = true,
  resizable = true,
  autoExplain = false,
  mode = "error",
  hideClose = false,
  defaultLayout,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const prevContextRef = useRef<string>("");
  const fetchAbortRef = useRef<AbortController | null>(null);
  const fetchGenRef = useRef(0);
  const layoutAppliedRef = useRef(false);
  const {
    speak,
    pause,
    resume,
    stop,
    state: ttsState,
    error: ttsError,
  } = useSileroTts();

  const lastAssistantText = useMemo(() => {
    if (streamingContent) return streamingContent;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant" && msg.content.trim()) return msg.content;
    }
    return "";
  }, [messages, streamingContent]);

  const canSpeak = lastAssistantText.length > 0;

  const ttsDisabled = !canSpeak;

  const {
    ref,
    dragging,
    resizing,
    isFloating,
    panelStyle,
    onDragStart,
    onResizeStart,
    setInitialLayout,
    resetLayout,
  } = useFloatingPanel({
    minWidth: 280,
    minHeight: 220,
    resizable,
  });

  useEffect(() => {
    if (!open) return;
    const sessionKey = contextKey ?? initialErrorContext;
    if (sessionKey === prevContextRef.current && messages.length > 0) return;
    prevContextRef.current = sessionKey;
    setMessages([]);
    setStreamingContent("");
    resetLayout();
    layoutAppliedRef.current = false;
    fetchAbortRef.current?.abort();
    fetchAbortRef.current = null;

    if (autoExplain && initialErrorContext) {
      void fetchAssistantReply([], initialErrorContext);
    }

    return () => {
      fetchAbortRef.current?.abort();
      fetchAbortRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialErrorContext, contextKey, autoExplain]);

  useEffect(() => {
    if (!open || !defaultLayout || layoutAppliedRef.current) return;
    setInitialLayout(defaultLayout);
    layoutAppliedRef.current = true;
  }, [open, defaultLayout, setInitialLayout]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [messages, streamingContent]);

  useEffect(() => {
    onMessagesUpdate?.(messages);
  }, [messages, onMessagesUpdate]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) stop();
  }, [open, stop]);

  async function fetchAssistantReply(history: Message[], context: string) {
    fetchAbortRef.current?.abort();
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    const gen = ++fetchGenRef.current;

    setLoading(true);
    setStreamingContent("");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: controller.signal,
        body: JSON.stringify({
          messages: history,
          errorContext: context,
          sceneId,
          nodeId,
          mode,
        }),
      });

      if (gen !== fetchGenRef.current) return;

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: "Ошибка сервера" }));
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: `Ошибка: ${err.error ?? "Нет ответа от сервера"}` },
        ]);
        return;
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) return;

      let full = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (gen !== fetchGenRef.current) return;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") break;
          try {
            const json = JSON.parse(payload);
            if (json.delta) {
              full += json.delta;
              setStreamingContent(full);
            }
            if (json.error) {
              full += `\n[Ошибка: ${json.error}]`;
              setStreamingContent(full);
            }
          } catch {
            // skip
          }
        }
      }

      if (gen !== fetchGenRef.current) return;
      setMessages((prev) => [...prev, { role: "assistant", content: full }]);
      setStreamingContent("");
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (gen !== fetchGenRef.current) return;
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Не удалось получить ответ. Проверьте соединение." },
      ]);
    } finally {
      if (gen === fetchGenRef.current) {
        setLoading(false);
        if (fetchAbortRef.current === controller) {
          fetchAbortRef.current = null;
        }
      }
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;
    const userMsg: Message = { role: "user", content: text };
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    setInput("");
    await fetchAssistantReply(nextHistory, initialErrorContext);
  }

  if (!open) return null;

  const placeholder =
    mode === "analysis"
      ? "Спроси про ПДД, ошибки или как лучше учить…"
      : "Спроси, почему так нельзя…";

  const style: React.CSSProperties = { ...panelStyle };
  if (!isFloating && !embedded) {
    style.right = 16;
    style.bottom = 16;
  }

  return (
    <div
      ref={ref}
      className={`pdd-chat${embedded ? " pdd-chat--embedded" : ""}${draggable ? " pdd-chat--draggable" : ""}${resizable ? " pdd-chat--resizable" : ""}${dragging ? " pdd-chat--dragging" : ""}${resizing ? " pdd-chat--resizing" : ""}${isFloating ? " pdd-chat--floating" : ""}`}
      style={Object.keys(style).length > 0 ? style : undefined}
    >
      <div
        className="pdd-chat__header"
        onMouseDown={draggable ? onDragStart : undefined}
      >
        <span>
          {mode === "analysis"
            ? "Инспектор ГИБДД"
            : "Инспектор ГИБДД — объясняет ошибку"}
        </span>
        <div className="pdd-chat__header-actions">
          {resizable && (
            <span className="pdd-chat__header-hint" title="Потяните за угол, чтобы изменить размер">
              ⇲
            </span>
          )}
          {!hideClose && (
            <button
              className="pdd-chat__close"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={onClose}
              title="Закрыть чат"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      <div className="pdd-chat__messages" ref={messagesContainerRef}>
        {messages.length === 0 && !streamingContent && loading && (
          <div className="pdd-chat__msg pdd-chat__msg--assistant pdd-chat__msg--loading">
            <span className="pdd-chat__typing">Инспектор думает</span>
            <span className="pdd-chat__dot" />
            <span className="pdd-chat__dot" />
            <span className="pdd-chat__dot" />
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`pdd-chat__msg pdd-chat__msg--${m.role}`}>
            <div className="pdd-chat__msg-label">
              {m.role === "assistant" ? "Инспектор" : "Вы"}
            </div>
            <div className="pdd-chat__msg-text">{m.content}</div>
          </div>
        ))}
        {streamingContent && (
          <div className="pdd-chat__msg pdd-chat__msg--assistant">
            <div className="pdd-chat__msg-label">Инспектор</div>
            <div className="pdd-chat__msg-text">
              {streamingContent}
              <span className="pdd-chat__cursor">▍</span>
            </div>
          </div>
        )}
      </div>

      {(lastAssistantText || ttsState !== "idle") && (
        <div className="pdd-chat__tts-bar">
          <span className="pdd-chat__tts-label">Озвучка ответа</span>
          <TtsControls
            text={lastAssistantText}
            state={ttsState}
            error={ttsError}
            disabled={ttsDisabled}
            variant="chat"
            playLabel="Озвучить"
            playTitle="Озвучить последний ответ инспектора"
            onSpeak={speak}
            onPause={pause}
            onResume={resume}
            onStop={stop}
          />
        </div>
      )}

      <form className="pdd-chat__input-row" onSubmit={handleSend}>
        <input
          ref={inputRef}
          type="text"
          className="pdd-chat__input"
          placeholder={placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
        />
        <button type="submit" className="pdd-chat__send" disabled={!input.trim() || loading}>
          Отправить
        </button>
      </form>
      {!embedded && <p className="pdd-chat__hint">Закройте чат, чтобы продолжить игру</p>}

      {resizable && (
        <div
          className="pdd-chat__resize-handle"
          onMouseDown={onResizeStart}
          title="Изменить размер"
          aria-hidden
        />
      )}
    </div>
  );
}
