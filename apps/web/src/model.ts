/**
 * The model preview page (model.html, `pnpm models`): an asset group's models
 * alone, in every rotation, by day and night, at a chosen zoom, without
 * loading a world (modelPreview.ts has the steps). Every parameter is in the
 * URL, so the dev server's reload on saving a generator, a city pack or a
 * style pack shows the same models again, re-generated and re-baked.
 *
 * Parameters (all optional): style, group, generator (draw the group with
 * another generator), seeds=1-4,9, fp=8x6,12x10 and h=24,40 (voxels;
 * buildings and landmarks), size=10x4x5 (voxels; vehicles), part, variant,
 * hints=front:2,floors:3,year:1900,corner:1,roof:gabled, rot=0,1,2,3,
 * palette=day|night (default both), zoom=1–8, ground=<ramp>|0.
 *
 * Plugins: every workspace package with a `src/plugin.ts` exporting `plugin`
 * (the city packs, D-071) is registered, so its generators can be previewed
 * before a style pack names them.
 */
import { Baker, type BakedImage } from "@pixelworlds/bake";
import { listGenerators, resolveAsset, type PluginReport } from "@pixelworlds/generators";
import type { Rotation } from "@pixelworlds/grid";
import { buildPalette, materialTables, mergeStylePacks, validateStyle, type Palette, type StylePack } from "@pixelworlds/style";
import {
  DEFAULT_SPEC,
  defaultGroundRamp,
  defaultVehicleSize,
  modelKind,
  paletteImage,
  parseSpec,
  previewModels,
  previewScene,
  registerWorkspacePlugins,
  specParams,
  type PaletteName,
  type PreviewSpec,
} from "./modelPreview";

const STYLE_FILES = import.meta.glob("../../../worlds/_styles/*/style.json", { eager: true, import: "default" }) as Record<
  string,
  object
>;
const STYLES: Record<string, object> = Object.fromEntries(
  Object.entries(STYLE_FILES).map(([path, json]) => [path.split("/").at(-2)!, json]),
);

interface CellState {
  palette: PaletteName;
  rotation: Rotation;
  width: number;
  height: number;
}
interface RowState {
  label: string;
  error: string | null;
  cells: CellState[];
}
interface ModelsState {
  spec: PreviewSpec;
  plugins: PluginReport[];
  error: string | null;
  rows: RowState[];
}

/** Test/debug hooks (e2e/model.spec.ts). */
interface ModelsDebug {
  /** Resolves once the current parameters are drawn. */
  ready: () => Promise<void>;
  state: () => ModelsState;
}
declare global {
  interface Window {
    __models?: ModelsDebug;
  }
}

const form = document.getElementById("controls") as HTMLFormElement;
const statusEl = document.getElementById("status")!;
const grid = document.getElementById("grid")!;

const glCanvas = document.createElement("canvas");
const gl = glCanvas.getContext("webgl2", { antialias: false, depth: false, alpha: false });
const baker = gl ? new Baker(gl) : null;

let state: ModelsState = { spec: parseSpec(new URLSearchParams(location.search)), plugins: [], error: null, rows: [] };
let drawing: Promise<void> = Promise.resolve();
/** The style and group the form was built for (it is rebuilt when either changes). */
let built = "";

/** A pack with the packs it `extends` merged in (D-139's `arches` extends `desert-southwest`). */
function packOf(id: string): object {
  const json = STYLES[id];
  if (!json) throw new Error(`no style pack ${id} (worlds/_styles/${id}/style.json)`);
  const parent = (json as { extends?: unknown }).extends;
  return typeof parent === "string" ? mergeStylePacks(packOf(parent), json) : json;
}

function styleOf(id: string): StylePack {
  return validateStyle(packOf(id) as StylePack);
}

// ---------------------------------------------------------------- controls

function field(label: string, input: HTMLInputElement | HTMLSelectElement): void {
  const l = document.createElement("label");
  l.append(label, input);
  form.append(l);
}
function select(name: string, options: [string, string][], value: string): HTMLSelectElement {
  const s = document.createElement("select");
  s.name = name;
  for (const [v, text] of options) s.add(new Option(text, v, false, v === value));
  return s;
}
function text(name: string, value: string, placeholder = ""): HTMLInputElement {
  const i = document.createElement("input");
  i.name = name;
  i.value = value;
  i.placeholder = placeholder;
  i.className = "short";
  return i;
}

/** The form for a spec; changing it updates the URL and redraws. */
function buildControls(spec: PreviewSpec, style: StylePack): void {
  if (built === `${spec.style}/${spec.group}`) return;
  built = `${spec.style}/${spec.group}`;
  form.replaceChildren();
  const p = specParams(spec);
  const groups = Object.keys(style.assets ?? {}).sort();
  field("style", select("style", Object.keys(STYLES).sort().map((id) => [id, id]), spec.style));
  field("group", select("group", groups.map((g) => [g, `${g} — ${style.assets![g]!.generator}`]), spec.group));
  const generators = listGenerators().sort((a, b) => a.name.localeCompare(b.name));
  field(
    "generator",
    select("generator", [["", "(the group's)"], ...generators.map((g): [string, string] => [g.name, `${g.name} (${g.source})`])], spec.generator ?? ""),
  );
  field("seeds", text("seeds", p.get("seeds")!, "1-4,9"));
  field("footprint (voxels)", text("fp", p.get("fp")!, "8x6,12x10"));
  field("height (voxels)", text("h", p.get("h")!, "24,40"));
  const vehicle = modelKind(spec.group) === "vehicle" ? defaultVehicleSize(spec.group) : null;
  field("size (vehicles)", text("size", p.get("size") ?? "", vehicle ? `${vehicle.length}x${vehicle.width}x${vehicle.height}` : ""));
  field("hints", text("hints", p.get("hints") ?? "", "front:2,floors:3"));
  field("rotations", text("rot", spec.rotations.join(","), "0,1,2,3"));
  field("palette", select("palette", [["", "day and night"], ["day", "day"], ["night", "night"]], p.get("palette") ?? ""));
  field("zoom", select("zoom", [1, 2, 3, 4, 5, 6, 8].map((z): [string, string] => [String(z), `${z}×`]), String(spec.zoom)));
  const ramps = Object.keys(style.ramps).sort();
  field(
    "ground",
    select("ground", [["", `${defaultGroundRamp(style)} (default)`], ["0", "none"], ...ramps.map((r): [string, string] => [r, r])], p.get("ground") ?? ""),
  );
}

function readControls(): PreviewSpec {
  const data = new FormData(form);
  const params = new URLSearchParams();
  for (const [k, v] of data) if (typeof v === "string" && v !== "") params.set(k, v);
  const spec = parseSpec(params);
  // a group the newly chosen pack doesn't have: its first building, else its first group
  const style = styleOf(spec.style);
  if (!style.assets?.[spec.group]) {
    const groups = Object.keys(style.assets ?? {}).sort();
    spec.group = groups.find((g) => g.startsWith("building.")) ?? groups[0] ?? spec.group;
  }
  return spec;
}

form.addEventListener("change", () => {
  let spec: PreviewSpec;
  try {
    spec = readControls();
  } catch (e) {
    showError(e);
    return;
  }
  history.replaceState(null, "", `?${specParams(spec)}`);
  redraw(spec);
});
form.addEventListener("submit", (e) => e.preventDefault());

// ---------------------------------------------------------------- drawing

function showError(e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  state = { ...state, error: message };
  statusEl.textContent = message;
  statusEl.className = "error";
  // a pack the URL names that isn't there: the form for the default one, to pick another
  if (!form.childElementCount && STYLES[DEFAULT_SPEC.style]) buildControls(DEFAULT_SPEC, styleOf(DEFAULT_SPEC.style));
}

/** Each rotation's baked image placed so the model's origin lines up across a row. */
function rowCanvases(images: (BakedImage | null)[], palette: Palette, zoom: number): HTMLCanvasElement[] {
  const present = images.filter((i): i is BakedImage => i !== null);
  const left = Math.min(...present.map((i) => i.left));
  const top = Math.min(...present.map((i) => i.top));
  const width = Math.max(...present.map((i) => i.left + i.width)) - left;
  const height = Math.max(...present.map((i) => i.top + i.height)) - top;
  const bg = [...palette.rgba.subarray(0, 3)];
  return images.map((img) => {
    const c = document.createElement("canvas");
    c.width = Math.max(1, width);
    c.height = Math.max(1, height);
    c.style.width = `${c.width * zoom}px`;
    c.style.height = `${c.height * zoom}px`;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = `rgb(${bg.join(",")})`;
    ctx.fillRect(0, 0, c.width, c.height);
    if (img) {
      const tmp = document.createElement("canvas");
      tmp.width = img.width;
      tmp.height = img.height;
      tmp.getContext("2d")!.putImageData(new ImageData(paletteImage(img, palette), img.width, img.height), 0, 0);
      ctx.drawImage(tmp, img.left - left, img.top - top);
    }
    return c;
  });
}

async function draw(spec: PreviewSpec): Promise<void> {
  if (!baker) throw new Error("WebGL2 is required");
  const style = styleOf(spec.style);
  buildControls(spec, style);
  if (!resolveAsset(style.assets ?? {}, spec.group)) throw new Error(`the style pack ${style.id} has no asset for ${spec.group}`);
  const day = buildPalette(style);
  const palettes: [PaletteName, Palette][] = spec.palettes.flatMap((p): [PaletteName, Palette][] =>
    p === "day" ? [["day", day]] : style.night ? [["night", buildPalette(style, "night")]] : [],
  );
  if (!palettes.length) throw new Error(`the style pack ${style.id} has no night palette`);
  baker.setStyle({
    tables: materialTables(style, day, { surfaces: {} }, (m) => m),
    aoStrength: style.ao.strength,
    outlineThreshold: style.outline.depthThreshold,
    renderScale: 1,
  });
  const groundName = spec.ground === "default" ? defaultGroundRamp(style) : spec.ground;
  const groundRamp = groundName === null ? null : (day.rampIds.get(groundName) ?? null);
  if (groundName !== null && groundRamp === null) throw new Error(`the style pack ${style.id} has no ramp ${groundName}`);

  const asset = resolveAsset(style.assets ?? {}, spec.group)!;
  const generator = spec.generator ?? asset.generator;
  const source = listGenerators().find((g) => g.name === generator)?.source;
  const named = (style as { plugins?: string[] }).plugins ?? [];
  const notes = [
    `${spec.group}: ${generator}${source ? ` (${source})` : " (not registered)"}`,
    ...(source && source.startsWith("@") && source !== "@pixelworlds/generators" && !named.includes(source)
      ? [`note: ${style.id} doesn't name the plugin ${source} in "plugins", so a world view won't load it`]
      : []),
  ];

  statusEl.className = "";
  statusEl.textContent = `${notes.join("\n")}\nbaking…`;
  const table = document.createElement("table");
  const head = table.insertRow();
  head.append(document.createElement("th"));
  for (const [name] of palettes)
    for (const r of spec.rotations) {
      const th = document.createElement("th");
      th.textContent = `${name} · rotation ${r}`;
      head.append(th);
    }
  const rows: RowState[] = [];
  const t0 = performance.now();
  for (const m of previewModels(style, day, spec)) {
    const tr = table.insertRow();
    const th = document.createElement("th");
    th.textContent = m.label;
    tr.append(th);
    if (!m.model) {
      const td = tr.insertCell();
      td.colSpan = Math.max(1, palettes.length * spec.rotations.length);
      td.className = "error";
      td.textContent = m.error;
      rows.push({ label: m.label, error: m.error, cells: [] });
      continue;
    }
    const scene = previewScene(m.model, groundRamp);
    const images = spec.rotations.map((r) => baker.bake(scene, r, "all", { shadows: true })?.image ?? null);
    baker.releaseScene(scene);
    const cells: CellState[] = [];
    if (images.some((i) => i !== null))
      for (const [name, palette] of palettes)
        rowCanvases(images, palette, spec.zoom).forEach((c, k) => {
          tr.insertCell().append(c);
          cells.push({ palette: name, rotation: spec.rotations[k]!, width: c.width, height: c.height });
        });
    const error = cells.length ? null : "the model is empty";
    if (error) tr.insertCell().textContent = error;
    rows.push({ label: m.label, error, cells });
    await new Promise((r) => setTimeout(r)); // let the page draw between models
  }
  grid.replaceChildren(table);
  state = { ...state, spec, error: null, rows };
  const baked = rows.reduce((n, r) => n + (r.cells.length ? spec.rotations.length : 0), 0);
  statusEl.textContent = `${notes.join("\n")}\n${rows.length} models, ${baked} bakes in ${Math.round(performance.now() - t0)} ms`;
}

function redraw(spec: PreviewSpec): void {
  drawing = drawing.then(() => draw(spec)).catch(showError);
}

async function main(): Promise<void> {
  const { reports, errors } = await registerWorkspacePlugins();
  state = { ...state, plugins: reports };
  if (errors.length) console.warn(errors.join("\n"));
  redraw(state.spec);
}

window.__models = {
  ready: async () => {
    // a redraw queued meanwhile replaces the promise: wait for the last one
    for (let p = drawing; ; p = drawing) {
      await p;
      if (p === drawing) return;
    }
  },
  state: () => state,
};
drawing = main().catch(showError);
