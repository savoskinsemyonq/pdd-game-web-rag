import type { ActorKind } from "../types";

export type ActorShape =
  | "sedan"
  | "sedan_sport"
  | "driving_school"
  | "police"
  | "emergency"
  | "taxi"
  | "truck_modern"
  | "bus"
  | "minibus"
  | "motorcycle"
  | "tram"
  | "tractor"
  | "horse"
  | "bicycle"
  | "ped"
  | "tl"
  | "none";

export interface ActorVisual {
  kind: ActorKind;
  shape: ActorShape;
  color: string;
  accent: string;
  width: number;
  height: number;
  label?: string;
}

const TL_COLORS: Record<string, string> = {
  green: "#3ac24a",
  red: "#e23a3a",
  yellow: "#f4cc3a",
  yellowblink: "#f4cc3a",
  whiteblink: "#f0f0f0",
  disrepair: "#5a5a5a",
};

interface CarDef {
  shape: ActorShape;
  color: string;
  accent: string;
  width: number;
  height: number;
}

const CAR_DEFS: Record<string, CarDef> = {
  // --- player cars ---
  our_car:   { shape: "sedan_sport", color: "#d83b3b", accent: "#fff2c2", width: 28, height: 58 },
  our_car_y: { shape: "driving_school", color: "#f6c63a", accent: "#1a1a1a", width: 28, height: 58 },
  our_car2:  { shape: "sedan_sport", color: "#3aa1f6", accent: "#fff2c2", width: 28, height: 58 },

  // --- taxi ---
  taxi: { shape: "taxi", color: "#f7d300", accent: "#111", width: 28, height: 60 },

  // --- police ---
  ment:      { shape: "police", color: "#2055b8", accent: "#ffffff", width: 28, height: 58 },
  ment1:     { shape: "police", color: "#2055b8", accent: "#ffffff", width: 28, height: 58 },
  ment_off:  { shape: "police", color: "#1c4f8e", accent: "#aaa",    width: 28, height: 58 },

  // --- emergency ---
  emergency:     { shape: "emergency", color: "#ff3c28", accent: "#fff", width: 30, height: 62 },
  emergency_off: { shape: "emergency", color: "#8a3020", accent: "#ccc", width: 30, height: 62 },

  // --- sedans ---
  audi:  { shape: "sedan", color: "#2a2a2a", accent: "#c8ccd0", width: 28, height: 58 },
  audi2: { shape: "sedan", color: "#4a4a4a", accent: "#c8ccd0", width: 28, height: 58 },
  ford:  { shape: "sedan", color: "#1a6e44", accent: "#b0dcc8", width: 28, height: 58 },
  lada:  { shape: "sedan", color: "#8a4e28", accent: "#d8b898", width: 28, height: 58 },
  blue:  { shape: "sedan", color: "#2a3ec8", accent: "#9ab8ff", width: 28, height: 58 },
  green: { shape: "sedan", color: "#1e7828", accent: "#a8d8b0", width: 28, height: 58 },
  bug:   { shape: "sedan", color: "#c89020", accent: "#3a2800", width: 28, height: 56 },
  bug2:  { shape: "sedan", color: "#907018", accent: "#3a2800", width: 28, height: 56 },
  naoborot: { shape: "sedan", color: "#6a2a6a", accent: "#f0e0ff", width: 28, height: 58 },
  graud:    { shape: "sedan", color: "#484848", accent: "#aaa",    width: 28, height: 58 },

  // --- trucks ---
  truck:    { shape: "truck_modern", color: "#4a3e2e", accent: "#c8b890", width: 36, height: 88 },
  truck1:   { shape: "truck_modern", color: "#3a4250", accent: "#c8b890", width: 36, height: 88 },
  truck2:   { shape: "truck_modern", color: "#2e4e2e", accent: "#c8b890", width: 36, height: 88 },
  truck3:   { shape: "truck_modern", color: "#6a2e2e", accent: "#c8b890", width: 36, height: 88 },
  truckpri: { shape: "truck_modern", color: "#5a3818", accent: "#c8b890", width: 36, height: 88 },
  yellowblink: { shape: "truck_modern", color: "#f5c800", accent: "#1a1a1a", width: 38, height: 96 },
  buks1: { shape: "truck_modern", color: "#2a5e6a", accent: "#a8d8e0", width: 36, height: 88 },
  buks2: { shape: "truck_modern", color: "#2a5e6a", accent: "#a8d8e0", width: 36, height: 88 },
  buks3: { shape: "truck_modern", color: "#2a5e6a", accent: "#a8d8e0", width: 36, height: 88 },
  buks4: { shape: "truck_modern", color: "#2a5e6a", accent: "#a8d8e0", width: 36, height: 88 },
  buks5: { shape: "truck_modern", color: "#2a5e6a", accent: "#a8d8e0", width: 36, height: 88 },

  // --- buses / vans ---
  bus:     { shape: "bus",     color: "#882828", accent: "#ffe8a0", width: 34, height: 92 },
  gazel:   { shape: "minibus", color: "#c8c4ba", accent: "#333",    width: 30, height: 72 },
  milkcar: { shape: "minibus", color: "#e8eaec", accent: "#1040a0", width: 30, height: 72 },
  muka:    { shape: "minibus", color: "#c8c0a0", accent: "#6a4820", width: 30, height: 72 },

  // --- motorcycles ---
  motorcycle:    { shape: "motorcycle", color: "#181818", accent: "#d83b3b", width: 14, height: 34 },
  motorcycle2:   { shape: "motorcycle", color: "#181818", accent: "#3aa1f6", width: 14, height: 34 },
  motorcyclepri: { shape: "motorcycle", color: "#181818", accent: "#f6c63a", width: 14, height: 34 },
  moto:          { shape: "motorcycle", color: "#181818", accent: "#d83b3b", width: 14, height: 34 },

  // --- trams / train ---
  tram:   { shape: "tram", color: "#b83030", accent: "#ffd060", width: 38, height: 112 },
  tram1:  { shape: "tram", color: "#b83030", accent: "#ffd060", width: 38, height: 112 },
  tram2:  { shape: "tram", color: "#b83030", accent: "#ffd060", width: 38, height: 112 },
  tram3:  { shape: "tram", color: "#b83030", accent: "#ffd060", width: 38, height: 112 },
  tram10: { shape: "tram", color: "#b83030", accent: "#ffd060", width: 38, height: 112 },
  tram11: { shape: "tram", color: "#b83030", accent: "#ffd060", width: 38, height: 112 },
  train:  { shape: "tram", color: "#282828", accent: "#f6c63a", width: 40, height: 120 },

  // --- tractor ---
  tractor:  { shape: "tractor", color: "#1a4e22", accent: "#f6c63a", width: 32, height: 60 },
  tractor1: { shape: "tractor", color: "#1a4e22", accent: "#f6c63a", width: 32, height: 60 },
  tractor2: { shape: "tractor", color: "#1a4e22", accent: "#f6c63a", width: 32, height: 60 },

  // --- horse ---
  horse: { shape: "horse", color: "#6a4a2c", accent: "#c8a070", width: 20, height: 38 },

  // --- bicycle ---
  vel: { shape: "bicycle", color: "#b0b0b0", accent: "#2a2a2a", width: 10, height: 28 },
};

export function visualForActor(kind: ActorKind, sprite: string): ActorVisual {
  const s = sprite.toLowerCase();

  if (kind === "PEDESTRIAN" || /^pedestrian/.test(s)) {
    let color = "#d8c8b8";
    let accent = "#1a1a1a";
    if (s.includes("girl")) {
      color = "#ffb1d6";
      accent = "#5e1f3a";
    } else if (s.includes("ment")) {
      color = "#2055b8";
      accent = "#ffffff";
    } else if (s.includes("vel")) {
      color = "#b0b0b0";
      accent = "#333";
    } else if (s.includes("mlk")) {
      color = "#e8eaec";
      accent = "#1040a0";
    }
    return { kind, shape: "ped", color, accent, width: 14, height: 14 };
  }

  if (kind === "TL" || (s in TL_COLORS && kind !== "CAR")) {
    return { kind, shape: "tl", color: TL_COLORS[s] ?? "#888", accent: "#000", width: 18, height: 18 };
  }

  if (kind === "CAMERA" || s === "") {
    return { kind, shape: "none", color: "transparent", accent: "transparent", width: 0, height: 0 };
  }

  const def = CAR_DEFS[s];
  if (def) {
    return { kind, shape: def.shape, color: def.color, accent: def.accent, width: def.width, height: def.height, label: s };
  }

  return { kind, shape: "sedan", color: "#666", accent: "#ccc", width: 28, height: 58, label: s };
}
