export interface CameraView {
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export class Camera {
  cx = 0;
  cy = 0;
  width: number;
  height: number;
  zoom: number;

  constructor(width = 800, height = 600, zoom = 1) {
    this.width = width;
    this.height = height;
    this.zoom = zoom;
  }

  centerOn(x: number, y: number) {
    this.cx = x;
    this.cy = y;
  }

  follow(x: number, y: number, alpha = 1) {
    const a = Math.min(1, Math.max(0, alpha));
    this.cx += (x - this.cx) * a;
    this.cy += (y - this.cy) * a;
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: (wx - this.cx) * this.zoom + this.width / 2,
      y: (wy - this.cy) * this.zoom + this.height / 2,
    };
  }

  /** World units visible in each direction from center. */
  get visibleHalfW() { return this.width / 2 / this.zoom; }
  get visibleHalfH() { return this.height / 2 / this.zoom; }

  view(): CameraView {
    return {
      cx: this.cx,
      cy: this.cy,
      width: this.width / this.zoom,
      height: this.height / this.zoom,
    };
  }
}
