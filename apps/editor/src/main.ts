export {};

/**
 * Pixelworld editor v0 (M2): paint focus areas and drag pins on the real
 * geography, see the elastic map re-solve within seconds, then build the world.
 * Talks to the local pipeline server (`uv run pixelworld serve <region.yaml>`).
 */

interface Focus {
  name: string;
  sx: number; // source-frame metres (x east, y south from the region's NW corner)
  sy: number;
  lon?: number;
  lat?: number;
  radiusKm: number;
  falloffKm: number;
  metersPerCell: number;
}

interface Pin {
  name: string;
  sx: number;
  sy: number;
  lon?: number;
  lat?: number;
  x: number; // target world cell
  y: number;
}

interface Warp {
  background: number;
  focus: Focus[];
  pins: Pin[];
  [key: string]: unknown;
}

interface RegionInfo {
  id: string;
  name: string;
  baseMetersPerCell: number;
  sourceMeters: [number, number];
  source: { url: string; width: number; height: number; metersPerPixel: number };
  warp: Warp;
  places: { label: string; sitelinks: number; x: number; y: number }[];
}

interface Lattice {
  xs: number[];
  ys: number[];
  cx: number[][];
  cy: number[][];
}

interface SolveResult {
  error?: string;
  stats: {
    folds: number;
    maxAnisotropy: number;
    focus: { name: string; target: number; achieved: number; error: number }[];
    pins: { name: string; cells: number }[];
  };
  cells: [number, number];
  preview: string;
  lattice: Lattice;
  timing: { solve: number; total: number };
}

type Tool = "select" | "focus" | "pin";
type Picked = { kind: "focus" | "pin"; index: number } | null;
type Drag =
  | { kind: "focus-move" | "focus-radius" | "pin-source"; index: number }
  | { kind: "pin-target"; index: number }
  | null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sourceCanvas = $<HTMLCanvasElement>("source");
const worldCanvas = $<HTMLCanvasElement>("world");
const statusEl = $<HTMLSpanElement>("status");

let region: RegionInfo;
let warp: Warp;
let tool: Tool = "select";
let selection: Picked = null;
let drag: Drag = null;
let solved: SolveResult | null = null;
let solveSeq = 0;
let solveTimer: number | undefined;
let solveCount = 0;
const sourceImg = new Image();
const worldImg = new Image();

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// ---- view transforms ----------------------------------------------------------------

interface View {
  scale: number;
  ox: number;
  oy: number;
}

function fit(canvas: HTMLCanvasElement, w: number, h: number): View {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width));
  canvas.height = Math.max(1, Math.round(rect.height));
  const scale = Math.min(canvas.width / w, canvas.height / h);
  return { scale, ox: (canvas.width - w * scale) / 2, oy: (canvas.height - h * scale) / 2 };
}

let srcView: View = { scale: 1, ox: 0, oy: 0 };
let worldView: View = { scale: 1, ox: 0, oy: 0 };
const mpp = () => region.source.metersPerPixel;
const srcToCanvas = (sx: number, sy: number): [number, number] => [
  srcView.ox + (sx / mpp()) * srcView.scale,
  srcView.oy + (sy / mpp()) * srcView.scale,
];
const canvasToSrc = (px: number, py: number): [number, number] => [
  ((px - srcView.ox) / srcView.scale) * mpp(),
  ((py - srcView.oy) / srcView.scale) * mpp(),
];
const cellToCanvas = (x: number, y: number): [number, number] => [
  worldView.ox + x * worldView.scale,
  worldView.oy + y * worldView.scale,
];
const canvasToCell = (px: number, py: number): [number, number] => [
  (px - worldView.ox) / worldView.scale,
  (py - worldView.oy) / worldView.scale,
];

/** Forward map (source metres → cells) from the last solve's lattice, bilinear. */
function forward(sx: number, sy: number): [number, number] | null {
  const L = solved?.lattice;
  if (!L) return null;
  const find = (v: number[], t: number) => {
    let i = 0;
    while (i < v.length - 2 && v[i + 1]! < t) i++;
    const f = (t - v[i]!) / Math.max(1e-9, v[i + 1]! - v[i]!);
    return [i, Math.min(1, Math.max(0, f))] as const;
  };
  const [i, fx] = find(L.xs, sx);
  const [j, fy] = find(L.ys, sy);
  const lerp = (g: number[][]) =>
    g[j]![i]! * (1 - fx) * (1 - fy) +
    g[j]![i + 1]! * fx * (1 - fy) +
    g[j + 1]![i]! * (1 - fx) * fy +
    g[j + 1]![i + 1]! * fx * fy;
  return [lerp(L.cx), lerp(L.cy)];
}

// ---- drawing ------------------------------------------------------------------------

function draw(): void {
  if (!region) return;
  srcView = fit(sourceCanvas, region.source.width, region.source.height);
  const g = sourceCanvas.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, sourceCanvas.width, sourceCanvas.height);
  if (sourceImg.complete)
    g.drawImage(sourceImg, srcView.ox, srcView.oy, region.source.width * srcView.scale, region.source.height * srcView.scale);
  // famous places (importance)
  for (const p of region.places) {
    const [x, y] = srcToCanvas(p.x, p.y);
    g.fillStyle = "rgba(255, 230, 150, 0.8)";
    g.beginPath();
    g.arc(x, y, 1.5 + Math.log2(p.sitelinks / 20), 0, Math.PI * 2);
    g.fill();
  }
  const kmPx = (km: number) => ((km * 1000) / mpp()) * srcView.scale;
  warp.focus.forEach((f, i) => {
    const [x, y] = srcToCanvas(f.sx, f.sy);
    const sel = selection?.kind === "focus" && selection.index === i;
    g.strokeStyle = sel ? "#ffcf5a" : "#ff7a45";
    g.lineWidth = sel ? 2 : 1.5;
    g.setLineDash([]);
    g.beginPath();
    g.arc(x, y, kmPx(f.radiusKm), 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([4, 4]);
    g.beginPath();
    g.arc(x, y, kmPx(f.radiusKm + f.falloffKm), 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = g.strokeStyle;
    g.fillRect(x + kmPx(f.radiusKm) - 3, y - 3, 6, 6); // radius handle
    g.font = "11px system-ui";
    g.fillText(`${f.name} · ${f.metersPerCell} m`, x + 4, y - 4);
  });
  warp.pins.forEach((p, i) => {
    const [x, y] = srcToCanvas(p.sx, p.sy);
    pinMark(g, x, y, selection?.kind === "pin" && selection.index === i);
  });

  const cells = solved?.cells ?? [1, 1];
  worldView = fit(worldCanvas, cells[0], cells[1]);
  const w = worldCanvas.getContext("2d")!;
  w.imageSmoothingEnabled = false;
  w.clearRect(0, 0, worldCanvas.width, worldCanvas.height);
  if (solved && worldImg.complete && worldImg.naturalWidth)
    w.drawImage(worldImg, worldView.ox, worldView.oy, cells[0] * worldView.scale, cells[1] * worldView.scale);
  // the source lattice, warped: shows where the map stretches
  const L = solved?.lattice;
  if (L) {
    w.strokeStyle = "rgba(255, 255, 255, 0.18)";
    w.lineWidth = 1;
    for (let j = 0; j < L.ys.length; j += 2) {
      w.beginPath();
      L.xs.forEach((_, i) => {
        const [x, y] = cellToCanvas(L.cx[j]![i]!, L.cy[j]![i]!);
        if (i === 0) w.moveTo(x, y);
        else w.lineTo(x, y);
      });
      w.stroke();
    }
    for (let i = 0; i < L.xs.length; i += 2) {
      w.beginPath();
      L.ys.forEach((_, j) => {
        const [x, y] = cellToCanvas(L.cx[j]![i]!, L.cy[j]![i]!);
        if (j === 0) w.moveTo(x, y);
        else w.lineTo(x, y);
      });
      w.stroke();
    }
  }
  warp.focus.forEach((f) => {
    const at = forward(f.sx, f.sy);
    if (!at) return;
    const [x, y] = cellToCanvas(at[0], at[1]);
    w.fillStyle = "#ff7a45";
    w.fillRect(x - 2, y - 2, 4, 4);
  });
  warp.pins.forEach((p, i) => {
    const [x, y] = cellToCanvas(p.x, p.y);
    pinMark(w, x, y, selection?.kind === "pin" && selection.index === i);
  });
}

function pinMark(g: CanvasRenderingContext2D, x: number, y: number, selected: boolean): void {
  g.fillStyle = selected ? "#ffcf5a" : "#5ad0ff";
  g.strokeStyle = "#000";
  g.beginPath();
  g.moveTo(x, y - 7);
  g.lineTo(x + 5, y);
  g.lineTo(x, y + 7);
  g.lineTo(x - 5, y);
  g.closePath();
  g.fill();
  g.stroke();
}

// ---- solving ------------------------------------------------------------------------

function requestSolve(delay = 350): void {
  window.clearTimeout(solveTimer);
  statusEl.textContent = "editing…";
  statusEl.classList.remove("bad");
  solveTimer = window.setTimeout(() => void solve(), delay);
}

async function solve(): Promise<void> {
  const seq = ++solveSeq;
  statusEl.textContent = "solving…";
  const t0 = performance.now();
  try {
    const res = await api<SolveResult>("/api/solve", { warp });
    if (seq !== solveSeq) return; // a newer edit is on its way
    solved = res;
    solveCount++;
    await new Promise<void>((resolve) => {
      worldImg.onload = () => resolve();
      worldImg.onerror = () => resolve();
      worldImg.src = res.preview;
    });
    const s = res.stats;
    statusEl.textContent =
      `solved in ${res.timing.solve.toFixed(1)} s (preview ${((performance.now() - t0) / 1000).toFixed(1)} s) · ` +
      `${res.cells[0]}×${res.cells[1]} cells · ${s.folds} folds`;
    statusEl.classList.toggle("bad", s.folds > 0);
    renderStats();
    draw();
  } catch (e) {
    if (seq !== solveSeq) return;
    statusEl.textContent = `solve failed: ${(e as Error).message}`;
    statusEl.classList.add("bad");
  }
}

function renderStats(): void {
  const el = $<HTMLDivElement>("stats");
  if (!solved) return;
  const s = solved.stats;
  const rows = s.focus
    .map((f) => {
      const cls = Math.abs(f.error) <= 0.1 ? "ok" : "err";
      return `<tr><td>${esc(f.name)}</td><td>${f.target}</td><td>${f.achieved}</td><td class="${cls}">${(f.error * 100).toFixed(1)}%</td></tr>`;
    })
    .join("");
  const pins = s.pins.map((p) => `<tr><td>${esc(p.name)}</td><td colspan="3">${p.cells} cells off</td></tr>`).join("");
  el.innerHTML =
    `<div>World ${solved.cells[0]} × ${solved.cells[1]} cells · <span class="${s.folds ? "err" : "ok"}">${s.folds} folds</span> · ` +
    `max anisotropy ${s.maxAnisotropy}</div>` +
    `<table><tr><th>focus</th><th>target</th><th>got</th><th>err</th></tr>${rows}${pins}</table>`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

// ---- selection panel ------------------------------------------------------------------

function renderSelection(): void {
  const el = $<HTMLDivElement>("selection");
  el.replaceChildren();
  if (!selection) {
    el.innerHTML = `<h3>${esc(region.name)}</h3><p class="hint">Add focus areas on the source map, drag them, or pin a place and drag its pin on the world map.</p>`;
    return;
  }
  const field = (label: string, value: number | string, onInput: (v: string) => void, type = "number") => {
    const row = document.createElement("label");
    row.className = "field";
    const span = document.createElement("span");
    span.textContent = label;
    const input = document.createElement("input");
    input.type = type;
    input.value = String(value);
    input.dataset.field = label;
    input.addEventListener("change", () => {
      onInput(input.value);
      draw();
      requestSolve();
    });
    row.append(span, input);
    el.append(row);
  };
  const title = document.createElement("h3");
  el.append(title);
  if (selection.kind === "focus") {
    const f = warp.focus[selection.index]!;
    title.textContent = "Focus area";
    field("name", f.name, (v) => (f.name = v), "text");
    field("metres per cell", f.metersPerCell, (v) => (f.metersPerCell = Math.max(10, Number(v))));
    field("radius (km)", f.radiusKm, (v) => (f.radiusKm = Math.max(0.5, Number(v))));
    field("falloff (km)", f.falloffKm, (v) => (f.falloffKm = Math.max(1, Number(v))));
  } else {
    const p = warp.pins[selection.index]!;
    title.textContent = "Pin";
    field("name", p.name, (v) => (p.name = v), "text");
    field("target x (cells)", p.x.toFixed(1), (v) => (p.x = Number(v)));
    field("target y (cells)", p.y.toFixed(1), (v) => (p.y = Number(v)));
  }
  const del = document.createElement("button");
  del.textContent = "Delete";
  del.addEventListener("click", deleteSelection);
  el.append(del);
}

function deleteSelection(): void {
  if (!selection) return;
  if (selection.kind === "focus") warp.focus.splice(selection.index, 1);
  else warp.pins.splice(selection.index, 1);
  selection = null;
  renderSelection();
  draw();
  requestSolve(0);
}

function setTool(t: Tool): void {
  tool = t;
  document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
}

// ---- pointer interaction ----------------------------------------------------------------

function local(e: PointerEvent, canvas: HTMLCanvasElement): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

sourceCanvas.addEventListener("pointerdown", (e) => {
  const [px, py] = local(e, sourceCanvas);
  const [sx, sy] = canvasToSrc(px, py);
  if (tool === "focus") {
    warp.focus.push({ name: `focus-${warp.focus.length + 1}`, sx, sy, radiusKm: 5, falloffKm: 10, metersPerCell: 150 });
    selection = { kind: "focus", index: warp.focus.length - 1 };
    setTool("select");
    renderSelection();
    draw();
    requestSolve(0);
    return;
  }
  if (tool === "pin") {
    const at = forward(sx, sy) ?? [0, 0];
    warp.pins.push({ name: `pin-${warp.pins.length + 1}`, sx, sy, x: at[0], y: at[1] });
    selection = { kind: "pin", index: warp.pins.length - 1 };
    setTool("select");
    renderSelection();
    draw();
    requestSolve(0);
    return;
  }
  const kmPx = (km: number) => ((km * 1000) / mpp()) * srcView.scale;
  let hit: Drag = null;
  for (let i = 0; i < warp.pins.length && !hit; i++) {
    const [x, y] = srcToCanvas(warp.pins[i]!.sx, warp.pins[i]!.sy);
    if (Math.hypot(px - x, py - y) < 8) hit = { kind: "pin-source", index: i };
  }
  for (let i = 0; i < warp.focus.length && !hit; i++) {
    const f = warp.focus[i]!;
    const [x, y] = srcToCanvas(f.sx, f.sy);
    if (Math.hypot(px - (x + kmPx(f.radiusKm)), py - y) < 7) hit = { kind: "focus-radius", index: i };
    else if (Math.hypot(px - x, py - y) < Math.max(8, kmPx(f.radiusKm))) hit = { kind: "focus-move", index: i };
  }
  drag = hit;
  selection = hit ? { kind: hit.kind === "pin-source" ? "pin" : "focus", index: hit.index } : null;
  if (hit) sourceCanvas.setPointerCapture(e.pointerId);
  renderSelection();
  draw();
});

sourceCanvas.addEventListener("pointermove", (e) => {
  if (!drag || drag.kind === "pin-target") return;
  const [sx, sy] = canvasToSrc(...local(e, sourceCanvas));
  if (drag.kind === "focus-move") Object.assign(warp.focus[drag.index]!, { sx, sy });
  else if (drag.kind === "pin-source") Object.assign(warp.pins[drag.index]!, { sx, sy });
  else {
    const f = warp.focus[drag.index]!;
    f.radiusKm = Math.max(0.5, Math.round(Math.hypot(sx - f.sx, sy - f.sy) / 100) / 10);
  }
  draw();
});

worldCanvas.addEventListener("pointerdown", (e) => {
  const [px, py] = local(e, worldCanvas);
  let hit: Drag = null;
  for (let i = 0; i < warp.pins.length && !hit; i++) {
    const [x, y] = cellToCanvas(warp.pins[i]!.x, warp.pins[i]!.y);
    if (Math.hypot(px - x, py - y) < 9) hit = { kind: "pin-target", index: i };
  }
  drag = hit;
  if (hit) {
    selection = { kind: "pin", index: hit.index };
    worldCanvas.setPointerCapture(e.pointerId);
    renderSelection();
    draw();
  }
});

worldCanvas.addEventListener("pointermove", (e) => {
  if (drag?.kind !== "pin-target") return;
  const [x, y] = canvasToCell(...local(e, worldCanvas));
  Object.assign(warp.pins[drag.index]!, { x, y });
  draw();
});

for (const c of [sourceCanvas, worldCanvas])
  c.addEventListener("pointerup", () => {
    if (drag) {
      drag = null;
      renderSelection();
      requestSolve(0);
    }
  });

window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).tagName === "INPUT") return;
  if (e.key === "Delete" || e.key === "Backspace") deleteSelection();
  else if (e.key === "s") setTool("select");
  else if (e.key === "f") setTool("focus");
  else if (e.key === "p") setTool("pin");
});
document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) =>
  b.addEventListener("click", () => setTool(b.dataset.tool as Tool)),
);
window.addEventListener("resize", draw);

// ---- save and build ---------------------------------------------------------------------

$<HTMLButtonElement>("save").addEventListener("click", async () => {
  try {
    const res = await api<{ saved: string }>("/api/save", { warp });
    statusEl.textContent = `saved ${res.saved}`;
  } catch (e) {
    statusEl.textContent = `save failed: ${(e as Error).message}`;
  }
});

$<HTMLButtonElement>("build").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("build");
  const log = $<HTMLPreElement>("buildlog");
  btn.disabled = true;
  try {
    await api("/api/save", { warp });
    await api("/api/build", {});
    for (;;) {
      const s = await api<{ state: string; log?: string; seconds?: number; error?: string; report?: { roads: { ok: boolean } } }>("/api/build");
      log.textContent = `${s.state}${s.seconds ? ` · ${s.seconds} s` : ""}\n${s.log ?? ""}`;
      if (s.state !== "running") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (e) {
    log.textContent = `build failed: ${(e as Error).message}`;
  } finally {
    btn.disabled = false;
  }
});

// ---- start ----------------------------------------------------------------------------

async function main(): Promise<void> {
  // the server may still be preparing its source image: keep asking
  for (let attempt = 0; ; attempt++) {
    try {
      region = await api<RegionInfo>("/api/region");
      break;
    } catch (e) {
      if (attempt >= 60) throw e;
      statusEl.textContent = "waiting for the pipeline server (uv run pixelworld serve <region.yaml>)…";
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  warp = structuredClone(region.warp);
  warp.focus ??= [];
  warp.pins ??= [];
  $<HTMLElement>("title").textContent = `Pixelworld editor · ${region.name}`;
  const bg = $<HTMLInputElement>("background");
  bg.value = String(warp.background);
  bg.addEventListener("change", () => {
    const value = Math.max(50, Number(bg.value));
    if (value === warp.background) return;
    warp.background = value;
    requestSolve(0);
  });
  const viewer = $<HTMLAnchorElement>("viewer");
  viewer.href = `http://${location.hostname}:5173/?world=/${region.id}/`;
  sourceImg.onload = draw;
  sourceImg.src = region.source.url;
  renderSelection();
  draw();
  await solve();
}

declare global {
  interface Window {
    __editor?: { warp: () => Warp; solves: () => number; solved: () => boolean };
  }
}
window.__editor = { warp: () => warp, solves: () => solveCount, solved: () => solved !== null };

main().catch((e: unknown) => {
  statusEl.textContent = `could not reach the pipeline server: ${String(e)}`;
  statusEl.classList.add("bad");
});
