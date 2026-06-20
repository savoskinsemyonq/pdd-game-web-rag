import { useCallback, useEffect, useRef, useState } from "react";
import { GameCanvas } from "./components/GameCanvas";
import { QuestionPanel } from "./components/QuestionPanel";
import { ErrorInspectorPanel } from "./components/ErrorInspectorPanel";
import { AuthScreen } from "./components/AuthScreen";
import { useAuthStore } from "./state/authStore";
import { canUseEditors } from "./lib/editorAccess";
import { Hud } from "./components/Hud";
import { MainMenu } from "./components/MainMenu";
import { MissionSelect } from "./components/MissionSelect";
import { MissionResult } from "./components/MissionResult";
import { ProfileManager } from "./components/ProfileManager";
import { CalibrationPanel } from "./components/CalibrationPanel";
import { AnimationPanel } from "./components/AnimationPanel";
import { MapEditor } from "./components/MapEditor";
import { MapCompositeEditor } from "./components/MapCompositeEditor";
import { useGameStore } from "./state/gameStore";
import { useCompositeStore } from "./state/compositeStore";
import { useProfileStore } from "./state/profileStore";
import { TrafficLightEditor } from "./components/TrafficLightEditor";
import type { Game } from "./engine/Game";
import type { MissionsData, SplineKey, TrafficLightDef } from "./types";
import data from "./data/missions.json";
const missionsData = data as unknown as MissionsData;

const PROTECTED_SCREENS = new Set([
  "menu",
  "profiles",
  "missionSelect",
  "playing",
  "result",
  "editor",
]);

function isTypingInField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable === true;
}

export function App() {
  const screen = useGameStore((s) => s.screen);
  const setScreen = useGameStore((s) => s.setScreen);
  const beginMission = useGameStore((s) => s.beginMission);
  const selectedMission = useGameStore((s) => s.selectedMission);
  const runnerState = useGameStore((s) => s.runnerState);
  const resetToMenu = useGameStore((s) => s.resetToMenu);
  const hydrate = useGameStore((s) => s.hydrate);

  const addChatSession = useGameStore((s) => s.addChatSession);

  const gameRef = useRef<Game | null>(null);
  const chatMessagesRef = useRef<{ role: "user" | "assistant"; content: string }[]>([]);
  const chatErrorContextRef = useRef("");
  const [calibrationTargets, setCalibrationTargets] = useState<ReturnType<Game["getCalibrationTargets"]>>([]);
  const [selectedCalibrationKey, setSelectedCalibrationKey] = useState<string | null>(null);
  const [calibrationStatus, setCalibrationStatus] = useState<string | null>(null);
  const [, force] = useState(0);

  const [animationEnabled, setAnimationEnabled] = useState(false);
  const [animationTargets, setAnimationTargets] = useState<ReturnType<Game["getAnimationTargets"]>>([]);
  const [selectedAnimationKey, setSelectedAnimationKey] = useState<string | null>(null);
  const [animationStatus, setAnimationStatus] = useState<string | null>(null);
  const [_animRevision, forceAnimRefresh] = useState(0);

  const [tlEditorEnabled, setTlEditorEnabled] = useState(false);
  const [tlLights, setTlLights] = useState<TrafficLightDef[]>([]);

  const compositeEditorEnabled = useCompositeStore((s) => s.editorEnabled);

  const authChecked = useAuthStore((s) => s.checked);
  const authUser = useAuthStore((s) => s.user);
  const authHydrate = useAuthStore((s) => s.hydrate);
  const isEditorUser = canUseEditors(authUser);
  const [guestMode, setGuestMode] = useState(
    () => sessionStorage.getItem("pdd-web::guest") === "1",
  );

  const hasAccess = Boolean(authUser) || guestMode;

  const [calibrationEnabled, setCalibrationEnabled] = useState(false);
  useEffect(() => {
    hydrate();
    void authHydrate();
  }, [hydrate, authHydrate]);

  useEffect(() => {
    if (!authChecked) return;

    if (!hasAccess) {
      if (PROTECTED_SCREENS.has(screen)) {
        setScreen("auth");
      }
      return;
    }

    if (screen === "auth") {
      setScreen("menu");
    }
  }, [authChecked, hasAccess, screen, setScreen]);

  useEffect(() => {
    if (screen === "editor" && !isEditorUser) {
      setScreen(hasAccess ? "menu" : "auth");
    }
  }, [screen, isEditorUser, hasAccess, setScreen]);

  useEffect(() => {
    if (isEditorUser) return;
    setCalibrationEnabled(false);
    setAnimationEnabled(false);
    setTlEditorEnabled(false);
    useCompositeStore.getState().setEditorEnabled(false);
  }, [isEditorUser]);

  function goToProfiles() {
    setScreen("profiles");
  }

  function handleAuthSuccess(justRegistered: boolean) {
    setScreen("menu");
    void useAuthStore.getState().hydrate();
    void useProfileStore.getState().syncFromServer().then(() => {
      const user = useAuthStore.getState().user;
      if (user?.profileId) {
        void useProfileStore.getState().setActiveProfile(user.profileId);
      }
      if (justRegistered) {
        const imported = localStorage.getItem("pdd-web::server-imported");
        if (!imported) {
          const local = localStorage.getItem("pdd-web::profiles");
          const activeId = localStorage.getItem("pdd-web::activeProfileId");
          if (local && activeId) {
            try {
              const list = JSON.parse(local) as {
                id: string;
                runs?: unknown[];
                bestByMission?: Record<string, unknown>;
              }[];
              const active = list.find((p) => p.id === activeId);
              const hasProgress =
                active &&
                ((active.runs?.length ?? 0) > 0 ||
                  Object.keys(active.bestByMission ?? {}).length > 0);
              if (hasProgress) {
                void useProfileStore.getState().importActiveGuestProfile();
              }
            } catch {
              // ignore
            }
          }
        }
      }
    });
  }

  function handleLogout() {
    setGuestMode(false);
    setScreen("auth");
  }

  async function handleSignOut() {
    sessionStorage.removeItem("pdd-web::guest");
    if (useAuthStore.getState().user) {
      await useAuthStore.getState().logout();
    }
    handleLogout();
  }

  // Save chat when error popup closes
  useEffect(() => {
    if (runnerState?.phase !== "errorPopup") {
      if (chatMessagesRef.current.length > 0) {
        addChatSession({
          errorContext: chatErrorContextRef.current,
          messages: chatMessagesRef.current,
        });
        chatMessagesRef.current = [];
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runnerState?.phase]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isEditorUser && screen === "playing" && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCalibrationEnabled((v) => !v);
        return;
      }
      if (isEditorUser && screen === "playing" && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setAnimationEnabled((v) => !v);
        return;
      }
      if (isEditorUser && screen === "playing" && e.key.toLowerCase() === "t") {
        e.preventDefault();
        setTlEditorEnabled((v) => {
          if (!v && gameRef.current) setTlLights([...gameRef.current.trafficLights]);
          return !v;
        });
        return;
      }
      if (isEditorUser && screen === "playing" && e.key.toLowerCase() === "m") {
        const cs = useCompositeStore.getState();
        if (cs.mapMode === "composite") {
          e.preventDefault();
          cs.setEditorEnabled(!cs.editorEnabled);
        }
        return;
      }
      if (isEditorUser && screen === "playing") {
        const cs = useCompositeStore.getState();
        if (cs.mapMode === "composite" && cs.editorEnabled && !isTypingInField(e.target)) {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
            e.preventDefault();
            if (e.shiftKey) cs.redo();
            else cs.undo();
            return;
          }
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
            e.preventDefault();
            cs.redo();
            return;
          }
          if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[1-8]$/.test(e.key)) {
            e.preventDefault();
            if (e.key === "1") cs.setEditorTool("select");
            if (e.key === "2") cs.setEditorTool("paint");
            if (e.key === "3") cs.setEditorTool("stroke");
            if (e.key === "4") cs.setEditorTool("marking_line");
            if (e.key === "5") cs.setEditorTool("marking_crosswalk");
            if (e.key === "6") cs.setEditorTool("marking_zone");
            if (e.key === "7") cs.setEditorTool("marking_tram");
            if (e.key === "8") cs.setEditorTool("erase");
            return;
          }
          if (e.key === "[" || e.key === "]") {
            e.preventDefault();
            if (
              cs.mapMode === "composite" &&
              cs.editorEnabled &&
              cs.selectedSpriteId &&
              e.altKey
            ) {
              cs.snapshotUndo();
              const fine = e.shiftKey;
              const factor = e.key === "]" ? (fine ? 1.05 : 1.1) : fine ? 1 / 1.05 : 1 / 1.1;
              cs.scaleSelectedSprite(factor);
              return;
            }
            if (cs.editorTool === "marking_line") {
              const step = e.shiftKey ? 4 : 2;
              const delta = e.key === "]" ? step : -step;
              cs.setMarkingLineWidthWorld(cs.markingLineWidthWorld + delta);
            } else if (cs.editorTool === "stroke") {
              const step = e.shiftKey ? 32 : 16;
              const delta = e.key === "]" ? step : -step;
              cs.setStrokeWidthWorld(cs.strokeWidthWorld + delta);
            }
            return;
          }
        }
      }
      if (e.key === "Escape" && screen === "playing") {
        if (runnerState?.phase === "errorPopup") return;
        if (isEditorUser && animationEnabled) {
          e.preventDefault();
          setAnimationEnabled(false);
          return;
        }
        if (isEditorUser && calibrationEnabled) {
          e.preventDefault();
          setCalibrationEnabled(false);
          return;
        }
        if (isEditorUser) {
          const cs = useCompositeStore.getState();
          if (cs.mapMode === "composite" && cs.editorEnabled) {
            const partial =
              cs.paintPreview != null ||
              cs.strokePreview != null ||
              cs.markingRectPreview != null ||
              cs.erasePreview != null ||
              cs.markingLinePreview != null ||
              cs.editorGestureBusy;
            if (partial) {
              e.preventDefault();
              cs.cancelCompositeGesture();
              return;
            }
            e.preventDefault();
            cs.setEditorEnabled(false);
            return;
          }
        }
        e.preventDefault();
        resetToMenu();
        return;
      }
      if (isEditorUser && animationEnabled && screen === "playing") {
        const g = gameRef.current;
        if (g && selectedAnimationKey && e.key.toLowerCase() === "r") {
          e.preventDefault();
          g.clearAnimationOverride(selectedAnimationKey);
          forceAnimRefresh((x) => x + 1);
        }
        return;
      }
      if (!isEditorUser || !calibrationEnabled || screen !== "playing") return;
      const g = gameRef.current;
      if (!g || !selectedCalibrationKey) return;
      const step = e.shiftKey ? 20 : 5;
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowLeft") dx = -step;
      else if (e.key === "ArrowRight") dx = step;
      else if (e.key === "ArrowUp") dy = -step;
      else if (e.key === "ArrowDown") dy = step;
      else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        g.clearCalibration(selectedCalibrationKey);
        force((x) => x + 1);
        return;
      }
      if (dx !== 0 || dy !== 0) {
        e.preventDefault();
        g.adjustCalibration(selectedCalibrationKey, dx, dy);
        force((x) => x + 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, runnerState?.phase, resetToMenu, calibrationEnabled, selectedCalibrationKey, animationEnabled, selectedAnimationKey, isEditorUser]);

  useEffect(() => {
    if (!calibrationEnabled || screen !== "playing") return;
    const g = gameRef.current;
    if (!g) return;
    const targets = g.getCalibrationTargets();
    setCalibrationTargets(targets);
    if (!selectedCalibrationKey || !targets.some((t) => t.key === selectedCalibrationKey)) {
      setSelectedCalibrationKey(targets[0]?.key ?? null);
    }
  }, [
    calibrationEnabled,
    screen,
    runnerState?.currentNodeId,
    runnerState?.sceneVariantIndex,
    runnerState?.phase,
    selectedCalibrationKey,
  ]);

  useEffect(() => {
    if (!animationEnabled || screen !== "playing") return;
    const g = gameRef.current;
    if (!g) return;
    const targets = g.getAnimationTargets();
    setAnimationTargets(targets);
    if (!selectedAnimationKey || !targets.some((t) => t.key === selectedAnimationKey)) {
      setSelectedAnimationKey(targets[0]?.key ?? null);
    }
  }, [animationEnabled, screen, runnerState?.currentNodeId, runnerState?.phase, selectedAnimationKey]);

  const onCanvasReady = useCallback((g: Game) => {
    gameRef.current = g;
    g.setMissionsData(missionsData);
    g.onTrafficLightsLoaded = (lights: TrafficLightDef[]) => setTlLights(lights);
    force((x) => x + 1);
  }, []);

  const exportCalibration = useCallback(async () => {
    const g = gameRef.current;
    if (!g) return;
    const json = g.exportCalibrationJson();
    try {
      await navigator.clipboard.writeText(json);
      setCalibrationStatus("JSON скопирован в буфер обмена.");
    } catch {
      setCalibrationStatus("Не удалось скопировать в буфер. Открой консоль и скопируй вручную.");
      console.log("Calibration JSON:", json);
    }
  }, []);

  const exportMergedCalibration = useCallback(async () => {
    const g = gameRef.current;
    if (!g) return;
    const json = g.exportMergedCalibrationJson();
    try {
      await navigator.clipboard.writeText(json);
      setCalibrationStatus("Итоговый JSON (дефолт+пользовательские) скопирован.");
    } catch {
      setCalibrationStatus("Не удалось скопировать итоговый JSON. См. console.log.");
      console.log("Merged calibration JSON:", json);
    }
  }, []);

  const importCalibration = useCallback(async () => {
    const g = gameRef.current;
    if (!g) return;
    try {
      const raw = await navigator.clipboard.readText();
      const res = g.importCalibrationJson(raw);
      setCalibrationStatus(res.message);
      force((x) => x + 1);
    } catch {
      setCalibrationStatus("Не удалось прочитать буфер обмена.");
    }
  }, []);

  const exportAnimation = useCallback(async () => {
    const g = gameRef.current;
    if (!g) return;
    const json = g.exportAnimationJson();
    try {
      await navigator.clipboard.writeText(json);
      setAnimationStatus("Анимации JSON скопирован в буфер.");
    } catch {
      setAnimationStatus("Не удалось скопировать. Смотри console.log.");
      console.log("Animation JSON:", json);
    }
  }, []);

  const importAnimation = useCallback(async () => {
    const g = gameRef.current;
    if (!g) return;
    try {
      const raw = await navigator.clipboard.readText();
      const res = g.importAnimationJson(raw);
      setAnimationStatus(res.message);
      forceAnimRefresh((x) => x + 1);
    } catch {
      setAnimationStatus("Не удалось прочитать буфер обмена.");
    }
  }, []);

  if (screen === "editor" && isEditorUser && hasAccess) {
    return (
      <div className="app app--editor">
        <MapEditor onClose={() => setScreen("menu")} />
      </div>
    );
  }

  return (
    <div className="app">
      <div className="stage">
        {!authChecked && (
          <div className="menu">
            <p>Загрузка…</p>
          </div>
        )}

        {authChecked && screen === "auth" && (
          <AuthScreen
            onGuest={() => {
              sessionStorage.setItem("pdd-web::guest", "1");
              setGuestMode(true);
              setScreen("menu");
            }}
            onSuccess={handleAuthSuccess}
          />
        )}

        {authChecked && screen === "playing" && hasAccess && selectedMission && (
          <>
            <GameCanvas onReady={onCanvasReady} allowTilemapDebug={isEditorUser} />
            {runnerState && (
              <Hud
                state={runnerState}
                missionTitle={selectedMission.title}
                onExit={resetToMenu}
                calibrationEnabled={calibrationEnabled}
                onToggleCalibration={() => setCalibrationEnabled((v) => !v)}
                animationEnabled={animationEnabled}
                onToggleAnimation={() => setAnimationEnabled((v) => !v)}
                showDevTools={isEditorUser}
              />
            )}
            {runnerState?.phase === "question" && runnerState.scene && (
              <QuestionPanel
                scene={runnerState.scene}
                timeRemaining={runnerState.questionTimeRemaining}
                onPick={(i) => gameRef.current?.pick(i)}
              />
            )}
            {runnerState?.phase === "errorPopup" && runnerState.errorInfoText && (
              <ErrorInspectorPanel
                message={runnerState.errorInfoText}
                fine={runnerState.errorMeta?.fine ?? 0}
                licenseRevokeMonths={runnerState.errorMeta?.licenseRevokeMonths ?? null}
                lostTime={runnerState.errorMeta?.lostTime ?? 0}
                errorContext={runnerState.errorChatContext ?? runnerState.errorInfoText}
                contextKey={runnerState.errorContextKey ?? undefined}
                sceneId={runnerState.scene?.sceneId}
                nodeId={runnerState.currentNodeId ?? undefined}
                onClose={() => gameRef.current?.closeError()}
                onMessagesUpdate={(msgs) => {
                  chatMessagesRef.current = msgs;
                  chatErrorContextRef.current = runnerState.errorChatContext ?? runnerState.errorInfoText ?? "";
                }}
              />
            )}
          </>
        )}

        {authChecked && screen === "menu" && hasAccess && (
          <MainMenu
            onPlay={goToProfiles}
            onEditor={() => setScreen("editor")}
            showEditor={isEditorUser}
            onLogout={() => void handleSignOut()}
          />
        )}

        {authChecked && screen === "profiles" && hasAccess && (
          <ProfileManager
            onSelect={() => setScreen("missionSelect")}
            onBack={() => setScreen("menu")}
            onLogout={() => void handleSignOut()}
          />
        )}

        {authChecked && screen === "missionSelect" && hasAccess && (
          <MissionSelect
            onPick={(m) => beginMission(m)}
            onBack={() => setScreen("profiles")}
          />
        )}

        {authChecked && screen === "result" && hasAccess && selectedMission && runnerState && (
          <MissionResult
            mission={selectedMission}
            state={runnerState}
            onRetry={() => beginMission(selectedMission)}
            onMenu={() => resetToMenu()}
          />
        )}
      </div>

      {screen === "playing" && hasAccess && selectedMission && isEditorUser && (
        <>
          <CalibrationPanel
            enabled={calibrationEnabled}
            targets={calibrationTargets}
            selectedKey={selectedCalibrationKey}
            selectedTweak={
              selectedCalibrationKey && gameRef.current
                ? gameRef.current.getCalibrationTweak(selectedCalibrationKey)
                : { x: 0, y: 0 }
            }
            onSelect={(key) => setSelectedCalibrationKey(key)}
            onClose={() => setCalibrationEnabled(false)}
            onExport={exportCalibration}
            onExportMerged={exportMergedCalibration}
            onImport={importCalibration}
            importStatus={calibrationStatus}
          />
          <AnimationPanel
            enabled={animationEnabled}
            nodes={gameRef.current?.getNodeList() ?? []}
            currentNodeIndex={runnerState?.nodeIndex ?? 0}
            onJumpToNode={(idx) => gameRef.current?.jumpToNode(idx)}
            targets={animationTargets}
            selectedKey={selectedAnimationKey}
            activeKeys={
              selectedAnimationKey && gameRef.current
                ? (gameRef.current.getActiveOverride(selectedAnimationKey)?.keys
                    ?? gameRef.current.getOriginalSplineKeys(selectedAnimationKey))
                : ([] as SplineKey[])
            }
            hasOverride={
              !!selectedAnimationKey &&
              !!gameRef.current?.getAnimationOverride(selectedAnimationKey)
            }
            onSelect={(key) => setSelectedAnimationKey(key)}
            onClose={() => setAnimationEnabled(false)}
            onKeysChange={(keys) => {
              if (!selectedAnimationKey || !gameRef.current) return;
              gameRef.current.setAnimationOverride(selectedAnimationKey, keys);
              forceAnimRefresh((x) => x + 1);
            }}
            onReset={() => {
              if (!selectedAnimationKey || !gameRef.current) return;
              gameRef.current.clearAnimationOverride(selectedAnimationKey);
              forceAnimRefresh((x) => x + 1);
            }}
            onExport={exportAnimation}
            onImport={importAnimation}
            importStatus={animationStatus}
          />
          {tlEditorEnabled && (
            <TrafficLightEditor
              lights={tlLights}
              onChange={(lights) => {
                setTlLights(lights);
                if (gameRef.current) gameRef.current.trafficLights = lights;
              }}
              getCamera={() => gameRef.current?.camera ?? null}
            />
          )}
          {compositeEditorEnabled && (
            <MapCompositeEditor
              onClose={() => useCompositeStore.getState().setEditorEnabled(false)}
            />
          )}
        </>
      )}
    </div>
  );
}
