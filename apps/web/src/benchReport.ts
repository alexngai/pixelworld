/**
 * The benchmark's cases and report (apps/web/bench.html): what is measured,
 * how it is summarised, and the copyable text form. Pure, so it is tested
 * without a browser (apps/web/test/benchReport.test.ts).
 */

/** One baked tile's timings, as the bake service reports them. */
export interface TileBake {
  rotation: number;
  tx: number;
  ty: number;
  /** Preparing the tile's geometry (micro-terrain fields, object meshes) in the bake worker. */
  meshMs: number;
  /** Drawing it on the GPU, waiting for the pixels (shadow map, AO, colour, depth). */
  bakeMs: number;
  vertices: number;
}

/** A fixed place to bake and draw: a world, a lon/lat and a rotation. */
export interface BenchCase {
  id: string;
  label: string;
  /** World package path, as the app's `world=` parameter. */
  world: string;
  lon: number;
  lat: number;
  rotation: 0 | 1 | 2 | 3;
}

/** The default set: the driving and walking levels of both regions. */
export const BENCH_CASES: BenchCase[] = [
  { id: "sw-drive", label: "Southwest, driving: Grand Canyon Village", world: "/southwest/", lon: -112.1365, lat: 36.057, rotation: 2 },
  { id: "sw-walk", label: "Southwest, walking: the Strip", world: "/southwest-walk/", lon: -115.1728, lat: 36.1147, rotation: 0 },
  { id: "sf-drive", label: "San Francisco, driving: the Outer Sunset in fog", world: "/sf/", lon: -122.496, lat: 37.753, rotation: 0 },
  { id: "sf-walk", label: "San Francisco, walking: Alamo Square", world: "/sf-walk/", lon: -122.4327, lat: 37.776, rotation: 0 },
];

/** Zooms measured, in order: each one bakes only the tiles the one before didn't need. */
export const BENCH_ZOOMS = [3, 2, 1] as const;

export interface Stats {
  n: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

/** Nearest-rank percentile of ascending values. */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function summarize(values: number[]): Stats | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    medianMs: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted[sorted.length - 1]!,
  };
}

export interface BakeSummary {
  /** Mesh + bake per tile, without the case's first tile (it compiles the shaders). */
  tile: Stats | null;
  mesh: Stats | null;
  bake: Stats | null;
  /** The case's first tile (shader compilation included), if it is among these. */
  firstMs: number | null;
}

/** Summary of tiles baked; `first` is the case's first tile, reported apart. */
export function bakeSummary(tiles: TileBake[], first: TileBake | null = null): BakeSummary {
  const rest = tiles.filter((t) => t !== first);
  return {
    tile: summarize(rest.map((t) => t.meshMs + t.bakeMs)),
    mesh: summarize(rest.map((t) => t.meshMs)),
    bake: summarize(rest.map((t) => t.bakeMs)),
    firstMs: first && tiles.includes(first) ? first.meshMs + first.bakeMs : null,
  };
}

/** Frame cost with one set of layers on. */
export interface FrameSample {
  traffic: boolean;
  fog: boolean;
  /** One frame drawn again and again, waiting for the GPU each time (compositor, sprites, fog pass). */
  drawMs: number;
  /** Intervals between animation frames while the layers move (vsync bounds them below). */
  frame: Stats | null;
  /** Main-thread time per frame: compositor submission plus the traffic simulation. */
  cpuMs: number;
  vehiclesDrawn: number | null;
  fogInView: boolean | null;
}

export interface MemorySample {
  /** Baked tile textures held on the GPU. */
  tilesMB: number;
  tilesOnGpu: number;
  chunksLoaded: number;
  /** The page's JavaScript heap (Chromium only; the bake worker's heap is not included). */
  jsHeapMB: number | null;
  trafficSprites: number | null;
}

export interface ZoomResult {
  zoom: number;
  /** Until every tile in view was baked and drawn (vehicle sprites included). */
  readyMs: number;
  tiles: TileBake[];
  bake: BakeSummary;
  frames: FrameSample[];
  memory: MemorySample;
}

export interface CaseResult {
  id: string;
  label: string;
  world: string;
  level: string | null;
  packageHash: string | null;
  rotation: number;
  lon: number;
  lat: number;
  /** Page load to the first complete frame at the first zoom. */
  loadMs: number;
  bakeMode: string;
  zooms: ZoomResult[];
  /** All tiles of the case (every zoom). */
  bake: BakeSummary;
  error?: string;
}

export interface BenchReport {
  version: 1;
  date: string;
  userAgent: string;
  renderer: string;
  canvas: [number, number];
  devicePixelRatio: number;
  cores: number | null;
  cases: CaseResult[];
}

const ms = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined || Number.isNaN(v) ? "–" : v.toFixed(digits);

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

/** The report as aligned text, for pasting into an issue or the docs. */
export function reportText(r: BenchReport): string {
  const lines = [
    `Pixelworld bench · ${r.date}`,
    `GPU: ${r.renderer}`,
    `${r.userAgent}`,
    `canvas ${r.canvas[0]}×${r.canvas[1]} · devicePixelRatio ${r.devicePixelRatio} · ${r.cores ?? "?"} cores`,
    "",
    "Tile bakes (mesh + bake per tile, ms; the first tile, which compiles the shaders, apart):",
    `${pad("case", 10)}${pad("zoom", 6)}${pad("tiles", 7)}${pad("median", 8)}${pad("p95", 7)}${pad("max", 7)}${pad("mesh", 6)}ready`,
  ];
  for (const c of r.cases) {
    if (c.error) {
      lines.push(`${pad(c.id, 10)}error: ${c.error}`);
      continue;
    }
    for (const z of c.zooms) {
      const t = z.bake.tile;
      lines.push(
        `${pad(c.id, 10)}${pad(`${z.zoom}×`, 6)}${pad(String(z.tiles.length), 7)}${pad(ms(t?.medianMs), 8)}${pad(ms(t?.p95Ms), 7)}${pad(ms(t?.maxMs), 7)}${pad(ms(z.bake.mesh?.medianMs), 6)}${ms(z.readyMs)}`,
      );
    }
    const t = c.bake.tile;
    lines.push(
      `${pad(c.id, 10)}${pad("all", 6)}${pad(String(t?.n ?? 0), 7)}${pad(ms(t?.medianMs), 8)}${pad(ms(t?.p95Ms), 7)}${pad(ms(t?.maxMs), 7)}${pad(ms(c.bake.mesh?.medianMs), 6)}first tile ${ms(c.bake.firstMs)} · ${c.bakeMode}`,
    );
  }
  lines.push(
    "",
    "Frames (ms): draw = one frame redrawn, waiting for the GPU; frame = p95 interval while layers move; cpu = main thread per frame",
    `${pad("case", 10)}${pad("zoom", 6)}${pad("layers", 15)}${pad("draw", 7)}${pad("frame", 7)}${pad("cpu", 6)}vehicles · fog`,
  );
  for (const c of r.cases) {
    for (const z of c.zooms) {
      for (const f of z.frames) {
        const layers = [f.traffic ? "traffic" : "", f.fog ? "fog" : ""].filter(Boolean).join("+") || "none";
        lines.push(
          `${pad(c.id, 10)}${pad(`${z.zoom}×`, 6)}${pad(layers, 15)}${pad(ms(f.drawMs, 1), 7)}${pad(ms(f.frame?.p95Ms, 1), 7)}${pad(ms(f.cpuMs, 1), 6)}${f.vehiclesDrawn ?? "–"} · ${f.fogInView === null ? "–" : f.fogInView ? "in view" : "none in view"}`,
        );
      }
    }
  }
  lines.push(
    "",
    "Memory after each zoom (MB): tiles = baked tile textures on the GPU; heap = page JavaScript heap",
    `${pad("case", 10)}${pad("zoom", 6)}${pad("tiles", 13)}${pad("heap", 7)}${pad("chunks", 8)}sprites`,
  );
  for (const c of r.cases) {
    for (const z of c.zooms) {
      const m = z.memory;
      lines.push(
        `${pad(c.id, 10)}${pad(`${z.zoom}×`, 6)}${pad(`${ms(m.tilesMB)} (${m.tilesOnGpu})`, 13)}${pad(ms(m.jsHeapMB), 7)}${pad(String(m.chunksLoaded), 8)}${m.trafficSprites ?? "–"}`,
      );
    }
  }
  return lines.join("\n");
}
