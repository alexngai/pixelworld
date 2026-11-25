import { cityPlugin as hongKong } from "@pixelworlds/city-hongkong";
import { cityPlugin as kyoto } from "@pixelworlds/city-kyoto";
import { cityPlugin as newYork } from "@pixelworlds/city-nyc";
import { cityPlugin as paris } from "@pixelworlds/city-paris";
import { cityPlugin as sanFrancisco } from "@pixelworlds/city-sf";
import { cityPlugin as tokyo } from "@pixelworlds/city-tokyo";
import { Boards, createWorldView, roverController, type Board, type Rotation, type WorldView } from "@pixelworlds/engine";
import { BoardOverlay } from "@pixelworlds/tactics";
import "./gallery.css";
import { CITIES } from "./sites";
import { hiddenPenalty, WEIGHTS, type Site, type SurveyResult, type Terms } from "./survey";

/**
 * The map survey's gallery (D-175, docs/tactics/map-survey.md): a city's pool
 * of sites and its calibration samples as cards seen from above, the one
 * chosen in the city view from its starting side (what the game cuts away in
 * front cut away), its scores term by term, and ratings: good, fine or bad,
 * with tags and a note, kept in `apps/tactics/survey/ratings.json` to fit the
 * survey's weights to. Keys: 1 good, 2 fine, 3 bad, J/K or ←/→ next and
 * previous, N the next unrated; click the view to pan and turn it (WASD, Q/E).
 */

const PACKS = [sanFrancisco, newYork, paris, kyoto, tokyo, hongKong];
const STYLES: Record<string, () => Promise<{ default: object }>> = {
  "new-york": () => import("../../../worlds/_styles/new-york/style.json"),
  kyoto: () => import("../../../worlds/_styles/kyoto/style.json"),
  "bay-area": () => import("../../../worlds/_styles/bay-area/style.json"),
  paris: () => import("../../../worlds/_styles/paris/style.json"),
  tokyo: () => import("../../../worlds/_styles/tokyo/style.json"),
  hongkong: () => import("../../../worlds/_styles/hongkong/style.json"),
};
const WORLDS = [
  ["nyc-walk", "New York"],
  ["sf-walk", "San Francisco"],
  ["paris-walk", "Paris"],
  ["kyoto-walk", "Kyoto"],
  ["hongkong-walk", "Hong Kong"],
  ["tokyo-walk", "Tokyo"],
] as const;
const TAGS = ["great view", "landmark", "character", "interesting terrain", "good puzzle space", "boring", "too dense", "too open", "occluded", "ugly cut", "edge of data"];
const TOP_SUN: [number, number, number] = [0.15, 0.27, 1.6];
const SIZE = 8;

type Grade = "good" | "fine" | "bad";
interface Rating {
  rating: Grade;
  tags: string[];
  note: string;
  score: number;
  terms: Terms;
  /** For the hidden penalty (D-177), which is not a term. */
  hiddenCells: number;
  sample: boolean;
  at: string;
}

const params = new URLSearchParams(location.search);
const world = params.get("world") ?? "nyc-walk";
const show = (params.get("show") ?? "pool") as "pool" | "samples" | "unrated";
const $ = (id: string) => document.getElementById(id)!;
const keyOf = (s: Site) => `${world}:${s.x0},${s.y0},${s.cell}`;
const pct = (v: number) => `${Math.round(v * 100)}`;

const data = (await (await fetch(`/survey/${world}.json?t=${Date.now()}`)).json()) as SurveyResult;
const ratings = (await (await fetch("/__survey/ratings")).json()) as Record<string, Rating>;
/** Whether a fight could be made on each board (tools/survey-play.mjs, D-178). */
interface Tried {
  ok: boolean;
  tried: number;
  ms: number;
  /** The simulation's measures (D-181). */
  sim?: { score: number; kinds: string[]; held: string[]; room: number; terms: Record<string, number> };
}
const play = (await fetch(`/survey/play.json?t=${Date.now()}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))) as Record<string, Tried>;
const all: Site[] = [...data.sites, ...data.samples];
const list = (show === "samples" ? data.samples : show === "unrated" ? all.filter((s) => !ratings[keyOf(s)]) : data.sites).slice();
let at = Math.min(list.length - 1, Math.max(0, Number(params.get("at") ?? 0)));

// ---------------------------------------------------------------- the city view
const manifest = (await (await fetch(`/${world}/manifest.json`)).json()) as { style: string };
const style = (await STYLES[manifest.style]!()).default as { plugins?: string[] };
const canvas = $("view") as HTMLCanvasElement;
const view: WorldView = await createWorldView({
  canvas,
  worldUrl: `/${world}/`,
  style,
  plugins: PACKS.filter((p) => style.plugins?.includes(p.name)),
  // its keys only while the view has the focus: the page's own are 1–3, J, K, N
  controller: roverController({ follow: false, visible: false, listen: { keys: canvas, pointer: canvas } }),
});
const boards = new Boards(view);
let board: Board | null = null;

/** The rotation whose camera looks from a diagonal (a world cell across each way stays on one screen point, two steps up). */
function rotationFor([tx, ty]: readonly [number, number]): Rotation {
  const cam = view.camera;
  const was = cam.rotation;
  for (let r = 0; r < 4; r++) {
    cam.rotation = r as Rotation;
    const a = cam.project(cam.x, cam.y, 0);
    const b = cam.project(cam.x + tx, cam.y + ty, 2);
    if (Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01) {
      cam.rotation = was;
      return r as Rotation;
    }
  }
  cam.rotation = was;
  return was;
}

async function lookAt(s: Site): Promise<void> {
  const cam = view.camera;
  const r = rotationFor(s.toward);
  cam.rotation = r;
  // what the game cuts away in front, from this side (D-168)
  view.cutDown(null, undefined, { always: true });
  const cuts = new Map<number, number>();
  for (const o of s.cutObjects) {
    const inst = view.query.object(o);
    if (inst) cuts.set(o, (view.query.heightAt(inst.x, inst.y) ?? 0) + 0.05);
  }
  view.cutDown(cuts.size ? cuts : null, r, { always: true });
  if (board) {
    view.layers.remove("survey-board");
    boards.remove(board);
  }
  board = await boards.add({ x0: s.x0, y0: s.y0, w: SIZE, h: SIZE, cell: s.cell });
  await view.layers.add(new BoardOverlay(board, { id: "survey-board", ...(s.floor !== undefined ? { floor: s.floor } : {}) }));
  const span = SIZE * s.cell;
  await cam.lookAt({ x: s.x0 + span / 2, y: s.y0 + span / 2 });
  // the board about half the view's width
  const a = cam.project(s.x0, s.y0 + span, 0);
  const b = cam.project(s.x0 + span, s.y0, 0);
  const c = cam.project(s.x0, s.y0, 0);
  const d = cam.project(s.x0 + span, s.y0 + span, 0);
  const wide = Math.max(Math.abs(a.x - b.x), Math.abs(c.x - d.x)) || 1;
  cam.zoom = Math.max(1, Math.min(6, Math.round((cam.zoom * 0.5 * canvas.clientWidth) / wide)));
}

// ---------------------------------------------------------------- the bar
$("bar").innerHTML = `
  <nav>${WORLDS.map(([id, name]) => `<a href="?world=${id}&show=${show}" class="${id === world ? "on" : ""}">${name}</a>`).join("")}</nav>
  <nav>${(["pool", "samples", "unrated"] as const).map((v) => `<a href="?world=${world}&show=${v}" class="${v === show ? "on" : ""}">${v === "pool" ? `Pool (${data.sites.length})` : v === "samples" ? `Samples (${data.samples.length})` : "Unrated"}</a>`).join("")}</nav>
  <span id="count"></span>
  <span class="keys"><kbd>1</kbd> good <kbd>2</kbd> fine <kbd>3</kbd> bad · <kbd>J</kbd>/<kbd>K</kbd> next, previous · <kbd>N</kbd> next unrated · click the view: WASD, Q/E</span>`;
const count = () => {
  const n = all.filter((s) => ratings[keyOf(s)]).length;
  $("count").textContent = `${n} of ${all.length} rated in ${WORLDS.find(([id]) => id === world)?.[1] ?? world}`;
};

// ---------------------------------------------------------------- the cards
const cards = list.map((s, i) => {
  const el = document.createElement("button");
  el.className = "card";
  el.innerHTML = `<canvas></canvas><div class="name">${s.name}</div><div class="score"><b>${pct(s.score)}</b> <span title="readability">R ${pct(s.parts.readability)}</span> <span title="interactables">I ${pct(s.parts.interactables)}</span> <span title="character">C ${pct(s.parts.character)}</span></div><div class="grade"></div>`;
  el.addEventListener("click", () => void select(i));
  $("cards").append(el);
  return el;
});
const grade = (i: number) => {
  const r = ratings[keyOf(list[i]!)];
  const g = cards[i]!.querySelector(".grade")!;
  g.textContent = r ? `${r.rating}${r.tags.length ? ` · ${r.tags.join(", ")}` : ""}` : "";
  cards[i]!.dataset.grade = r?.rating ?? "";
};
list.forEach((_, i) => grade(i));

// thumbnails from above, the cards in view first
const seen = new Set<number>();
const done = new Set<number>();
const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const i = cards.indexOf(e.target as HTMLButtonElement);
    if (e.isIntersecting) seen.add(i);
    else seen.delete(i);
  }
});
cards.forEach((c) => observer.observe(c));
void (async () => {
  for (;;) {
    const i = [...seen].find((n) => !done.has(n)) ?? list.findIndex((_, n) => !done.has(n));
    if (i < 0) return;
    done.add(i);
    await thumb(list[i]!, cards[i]!.querySelector("canvas")!);
  }
})();

async function thumb(s: Site, c: HTMLCanvasElement): Promise<void> {
  const span = SIZE * s.cell;
  const m = Math.round(span * 0.3);
  const px = Math.max(3, Math.round(170 / (span + 2 * m)));
  const img = await view.bakeTopDown(s.x0 - m, s.y0 - m, s.x0 + span + m, s.y0 + span + m, { px, shadows: true, sun: TOP_SUN, cache: true }).catch(() => null);
  if (!img) return;
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext("2d")!;
  g.putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
  // the board, and the corner the starting side's camera looks from
  g.strokeStyle = "rgba(255,214,64,0.95)";
  g.lineWidth = 2;
  g.strokeRect(m * px, m * px, span * px, span * px);
  const [tx, ty] = s.toward;
  const cx = (m + (tx > 0 ? span : 0)) * px;
  const cy = (m + (ty > 0 ? span : 0)) * px;
  g.fillStyle = "rgba(255,214,64,0.95)";
  g.beginPath();
  g.moveTo(cx, cy);
  g.lineTo(cx - tx * 14, cy);
  g.lineTo(cx, cy - ty * 14);
  g.closePath();
  g.fill();
}

// ---------------------------------------------------------------- the one chosen
async function select(i: number): Promise<void> {
  if (i < 0 || i >= list.length) return;
  at = i;
  cards.forEach((c, n) => c.classList.toggle("on", n === i));
  cards[i]!.scrollIntoView({ block: "nearest" });
  history.replaceState(null, "", `?world=${world}&show=${show}&at=${i}`);
  info();
  await lookAt(list[i]!);
}

const fightNote = (p: Tried | undefined) =>
  !p
    ? "fight not tried"
    : !p.ok
      ? `<span class="nofight">no fight could be made</span>`
      : p.sim
        ? `simulated ${pct(p.sim.score)}: ${p.sim.kinds.join(", ") || "nothing but weapons"}; ${p.sim.room} way${p.sim.room === 1 ? "" : "s"} to hold it, the city ${pct(p.sim.terms.environment ?? 0)}% of the damage, held by ${p.sim.held.join(", ")}`
        : `a fight made (${p.tried} positions, ${(p.ms / 1000).toFixed(1)} s)`;

function info(): void {
  const s = list[at]!;
  const r = ratings[keyOf(s)];
  const bar = (label: string, v: number, wt?: number) => `<div class="term"><span>${label}${wt !== undefined ? ` <i>${Math.round(wt * 100)}%</i>` : ""}</span><div class="meter"><div style="width:${pct(v)}%"></div></div><b>${pct(v)}</b></div>`;
  const part = (name: keyof typeof WEIGHTS.parts, terms: Record<string, number>) =>
    `<h3>${bar(name, s.parts[name], WEIGHTS.parts[name])}</h3>${Object.entries(terms)
      .map(([t, wt]) => bar(t, s.terms[t as keyof Terms], wt))
      .join("")}`;
  const f = s.facts;
  $("info").innerHTML = `
    <h2>${s.name}${s.sample ? ' <small class="sample">sample</small>' : ""}</h2>
    <p class="where">${s.area ? `${s.area} · ` : ""}${s.lat !== undefined ? `${s.lat}, ${s.lon} · ` : ""}cells ${s.x0},${s.y0} · ${s.cell === 2 ? "20" : "10"} m a board cell · zone ${s.zone} · ${fightNote(play[`${keyOf(s)}${s.floor === undefined ? "" : `^${s.floor}`}`])} · <a class="play" href="/?city=${CITIES.findIndex((c) => c.world === world)}&board=${s.x0},${s.y0},${s.cell}" target="_blank">play this board</a></p>
    <div class="total">${bar("score", s.score)}</div>
    <div class="parts">${part("readability", WEIGHTS.readability)}${part("interactables", WEIGHTS.interactables)}${part("character", WEIGHTS.character)}</div>
    <p class="facts">${s.floor !== undefined ? `<b>rooftops</b>: the roofs ${Math.round(s.floor * view.world.manifest.scale.metersPerStep)} m up and above, the street a chasm · ` : ""}${f.buildings} buildings · ${f.hiddenCells} cells hidden (score −${pct(hiddenPenalty(f.hiddenCells))}) · ${f.water} water · ${f.burnable} burnable · ${f.cut} cells cut away in front · ${f.typology.replace("building.", "")}${f.landmark ? ` · ${f.landmark}` : ""}</p>
    <div class="rate">
      ${(["good", "fine", "bad"] as const).map((g, n) => `<button data-grade="${g}" class="${r?.rating === g ? "on" : ""}"><kbd>${n + 1}</kbd> ${g}</button>`).join("")}
    </div>
    <div class="tags">${TAGS.map((t) => `<button data-tag="${t}" class="${r?.tags.includes(t) ? "on" : ""}">${t}</button>`).join("")}</div>
    <textarea placeholder="A note: why (optional)">${r?.note ?? ""}</textarea>`;
  $("info")
    .querySelectorAll<HTMLButtonElement>("[data-grade]")
    .forEach((b) => b.addEventListener("click", () => rate(b.dataset.grade as Grade)));
  $("info")
    .querySelectorAll<HTMLButtonElement>("[data-tag]")
    .forEach((b) =>
      b.addEventListener("click", () => {
        const cur = ratings[keyOf(s)];
        if (!cur) return void b.classList.toggle("on");
        cur.tags = cur.tags.includes(b.dataset.tag!) ? cur.tags.filter((t) => t !== b.dataset.tag) : [...cur.tags, b.dataset.tag!];
        b.classList.toggle("on");
        save();
      }),
    );
  $("info")
    .querySelector("textarea")!
    .addEventListener("input", (e) => {
      const cur = ratings[keyOf(s)];
      if (!cur) return;
      cur.note = (e.target as HTMLTextAreaElement).value;
      save();
    });
}

function rate(g: Grade): void {
  const s = list[at]!;
  const k = keyOf(s);
  // tags chosen before the grade come with it
  const tags = [...$("info").querySelectorAll<HTMLButtonElement>("[data-tag].on")].map((b) => b.dataset.tag!);
  const note = $("info").querySelector("textarea")!.value;
  ratings[k] = { rating: g, tags, note, score: s.score, terms: s.terms, hiddenCells: s.facts.hiddenCells, sample: !!s.sample, at: new Date().toISOString() };
  grade(at);
  save();
  void select(Math.min(list.length - 1, at + 1));
}

let timer = 0;
function save(): void {
  count();
  clearTimeout(timer);
  timer = window.setTimeout(() => void fetch("/__survey/ratings", { method: "POST", body: JSON.stringify(ratings) }), 300);
}

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLTextAreaElement || e.target === canvas || e.metaKey || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k === "1" || k === "2" || k === "3") rate((["good", "fine", "bad"] as const)[Number(k) - 1]!);
  else if (k === "j" || k === "arrowright") void select(at + 1);
  else if (k === "k" || k === "arrowleft") void select(at - 1);
  else if (k === "n") void select(list.findIndex((s, n) => n > at && !ratings[keyOf(s)]));
  else return;
  e.preventDefault();
});

count();
Object.assign(window, { __gallery: { view, data, ratings, list, select } });
if (list.length) void select(at);
