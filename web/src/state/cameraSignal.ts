/**
 * Singleton camera state shared between the canvas renderer and the DOM/SVG
 * mission overlay. Updated every frame from `Game.tick`; subscribers (overlay)
 * read it inside their own rAF loop and apply CSS transforms directly — no
 * React state churn at 60 fps.
 */
export interface CameraSnapshot {
  cx: number;
  cy: number;
  zoom: number;
  viewW: number;
  viewH: number;
}

export const cameraSignal: CameraSnapshot = {
  cx: 0,
  cy: 0,
  zoom: 1,
  viewW: 800,
  viewH: 600,
};

export function setCameraSignal(s: CameraSnapshot) {
  cameraSignal.cx = s.cx;
  cameraSignal.cy = s.cy;
  cameraSignal.zoom = s.zoom;
  cameraSignal.viewW = s.viewW;
  cameraSignal.viewH = s.viewH;
}
