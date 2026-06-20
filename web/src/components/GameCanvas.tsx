import { useEffect, useRef, useState } from "react";
import { Game } from "../engine/Game";
import { useGameStore } from "../state/gameStore";
import { MissionWorldOverlay } from "./MissionWorldOverlay";

interface Props {
  onReady?: (game: Game) => void;
  allowTilemapDebug?: boolean;
}

export function GameCanvas({ onReady, allowTilemapDebug = false }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const gameRef = useRef<Game | null>(null);
  const [gameBooted, setGameBooted] = useState(false);
  const setRunnerState = useGameStore((s) => s.setRunnerState);
  const selectedMission = useGameStore((s) => s.selectedMission);

  useEffect(() => {
    if (!ref.current) return;
    let cancelled = false;
    const canvas = ref.current;
    const game = new Game({ canvas, onState: setRunnerState });

    const ro = new ResizeObserver(() => {
      const w = Math.round(canvas.clientWidth);
      const h = Math.round(canvas.clientHeight);
      if (w > 0 && h > 0) game.resize(w, h);
    });
    ro.observe(canvas.parentElement ?? canvas);

    void game.ready().then(() => {
      if (cancelled) return;
      gameRef.current = game;
      setGameBooted(true);
      onReady?.(game);
    });
    return () => {
      cancelled = true;
      ro.disconnect();
      game.stop();
      gameRef.current = null;
      setGameBooted(false);
    };
  }, [onReady, setRunnerState]);

  useEffect(() => {
    if (!gameBooted || !gameRef.current || !selectedMission) return;
    void gameRef.current.startMission(selectedMission);
  }, [gameBooted, selectedMission]);

  useEffect(() => {
    if (!gameBooted || !allowTilemapDebug) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "t" && e.key !== "T") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      const game = gameRef.current;
      if (!game) return;
      const on = game.renderer.toggleTilemapDebug();
      console.info(`[tilemap-debug] ${on ? "on" : "off"}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [gameBooted, allowTilemapDebug]);

  return (
    <div className="mission-stage">
      <MissionWorldOverlay />
      <canvas ref={ref} width={800} height={600} />
    </div>
  );
}
