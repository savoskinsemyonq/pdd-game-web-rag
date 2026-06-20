interface Props {
  onPlay: () => void;
  onEditor: () => void;
  onLogout: () => void;
  showEditor?: boolean;
}

export function MainMenu({ onPlay, onEditor, onLogout, showEditor = false }: Props) {
  return (
    <div className="menu">
      <h1>Игра по правилам ПДД</h1>
      <p>
        Тренажёр по правилам дорожного движения: 9 миссий, в каждой — последовательность
        дорожных ситуаций. Выберите правильный вариант действия. Если ошибётесь —
        инспектор ГИБДД пояснит, в чём дело, и вы продолжите движение.
      </p>
      <button onClick={onPlay}>Начнём обучение</button>
      {showEditor && (
        <button
          onClick={onEditor}
          style={{ background: "rgba(255,255,255,0.08)", color: "#e6e6e6", border: "1px solid rgba(255,255,255,0.2)", fontSize: 14 }}
        >
          🗺 Редактор карты
        </button>
      )}
      <button type="button" className="auth-screen__guest" onClick={onLogout}>
        Выйти
      </button>
      <p style={{ fontSize: 12, color: "#9aa0a8" }}>
        Управление: варианты ответов — клик по кнопке, Enter/Esc — закрыть пояснение,
        Esc — выход в меню. Окно с вопросом можно перетаскивать мышью.
      </p>
    </div>
  );
}
