import { cityPlugin as hongKong } from "@pixelworlds/city-hongkong";
import { cityPlugin as kyoto } from "@pixelworlds/city-kyoto";
import { cityPlugin as newYork } from "@pixelworlds/city-nyc";
import { cityPlugin as paris } from "@pixelworlds/city-paris";
import { cityPlugin as sanFrancisco } from "@pixelworlds/city-sf";
import { cityPlugin as tokyo } from "@pixelworlds/city-tokyo";
import { Boards, createWorldView, roverController, type Board, type BoardSpec, type WorldView } from "@pixelworlds/engine";
import { SQUAD, SQUADS, arenaFromBoard, cloneCombat, hiddenFrom, teamOf, type Loadout, type Puzzle, type Squad } from "@pixelworlds/tactics";
import { Brain } from "./brain";
import { CityMap } from "./cityMap";
import { Fight, towardCamera, type FightOutcome } from "./fight";
import "./game.css";
import { depot, isUnlocked, loadProfile, loadouts, newRun, pickSquad, reward, saveProfile, type Run } from "./runs";
import { CITIES, type City, type Site } from "./sites";

/**
 * The tactics game (D-153): pick a city, then hold its blocks one fight at a
 * time against invaders, on boards cut from the real streets. Puzzles are made
 * and checked in a worker; buildings a fight brings down stay down for the
 * rest of the operation. `?city=0` (an index into CITIES) skips the title.
 * The console has `__tactics`.
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
const ROUNDS = 3;
const RESETS = 1;
const HINTS = 1;
const SIZE = 8;
/** The most of a board its own buildings may hide from its clearest side (D-169): a board hiding more is tried only when none clearer makes a fight. */
const MAX_HIDDEN = 0.15;
/** Where boards are tried round a site, in spans (a board's width): a grid at half spans. */
const OFFSETS = [-1, -0.5, 0, 0.5, 1].flatMap((dx) => [-1, -0.5, 0, 0.5, 1].map((dy) => [dx, dy] as const));

const ui = document.getElementById("ui")!;
const labels = document.getElementById("labels")!;
const params = new URLSearchParams(location.search);

/** A screen over everything: its HTML, and a promise of the button clicked (its `data-go`). */
function screen(html: string, cls = ""): Promise<string> {
  const el = document.createElement("div");
  el.className = `screen ${cls}`;
  el.innerHTML = `<div class="box">${html}</div>`;
  ui.append(el);
  return new Promise((done) =>
    el.addEventListener("click", (e) => {
      const go = (e.target as HTMLElement).closest<HTMLElement>("[data-go]")?.dataset.go;
      if (go === undefined) return;
      el.remove();
      done(go);
    }),
  );
}

function note(html: string): { set(html: string): void; close(): void } {
  const el = document.createElement("div");
  el.className = "screen note";
  el.innerHTML = `<div class="box">${html}</div>`;
  ui.append(el);
  return { set: (h) => void (el.querySelector(".box")!.innerHTML = h), close: () => el.remove() };
}

async function title(): Promise<City> {
  await screen(
    `<h1>Hold the Block</h1>
     <p>Invaders are landing in the cities. Your squad of three rigs holds one block at a time; between blocks, the depot arms it with what the blocks held have earned.</p>
     <p>Every invader shows where it will strike before you move. Push them, drown them, drop them off roofs, bring towers down on them: whatever keeps the people in the buildings alive.</p>
     <button data-go="start">Start</button>`,
    "title",
  );
  const go = await screen(
    `<h2>Choose a city</h2>
     <div class="cities">${CITIES.map((c, i) => `<button data-go="${i}"><b>${c.name}</b><span>${c.sites.length} block${c.sites.length === 1 ? "" : "s"}: ${c.sites.map((s) => s.name).join(", ")}</span></button>`).join("")}</div>`,
  );
  return CITIES[Number(go)]!;
}

async function openCity(city: City): Promise<WorldView> {
  const manifest = (await (await fetch(`/${city.world}/manifest.json`)).json()) as { style: string };
  const style = (await STYLES[manifest.style]!()).default as { plugins?: string[] };
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const view = await createWorldView({
    canvas,
    worldUrl: `/${city.world}/`,
    style,
    plugins: PACKS.filter((p) => style.plugins?.includes(p.name)),
    // a free camera: WASD and drags pan, Q/E rotate, 1–6 zoom
    controller: roverController({ follow: false, visible: false, listen: { keys: window, pointer: canvas } }),
  });
  view.camera.zoom = 3;
  return view;
}

/**
 * A board round a site with buildings enough for a fight, and a puzzle made on
 * it; null when none comes of it. Boards are tried round the site, each
 * scored by how much of it its own buildings hide from its clearest side
 * (D-169), clearest first (the site's own cell size and its middle preferred
 * a little); one hiding more than `MAX_HIDDEN` only when none clearer makes a
 * fight. It needs no camera there, so the next block is made while this one
 * is fought.
 */
async function scout(
  view: WorldView,
  boards: Boards,
  brain: Brain,
  site: Site,
  squad: Loadout[],
  seed: number,
  progress: (tried: number) => void,
): Promise<{ board: Board; puzzle: Puzzle } | null> {
  const at = view.query.lonLatToCell(site.lon, site.lat);
  if (!at) return null;
  const cx = Math.floor(at[0]);
  const cy = Math.floor(at[1]);
  const mpc = view.world.manifest.scale.metersPerCell;
  const arenaOf = (board: Board) => arenaFromBoard(board, view.query, view.world.manifest.surfaces, { metersPerCell: mpc });
  const towards = [0, 1, 2, 3].map((r) => towardCamera(view, r));
  const tries: { spec: BoardSpec; score: number }[] = [];
  for (const cell of [site.cell, site.cell === 1 ? 2 : 1])
    for (const [dx, dy] of OFFSETS) {
      const span = SIZE * cell;
      const spec = { x0: Math.round(cx - span / 2 + dx * span), y0: Math.round(cy - span / 2 + dy * span), w: SIZE, h: SIZE, cell };
      const board = await boards.add(spec);
      const arena = arenaOf(board);
      boards.remove(board);
      if (arena.structures.length < 5) continue;
      const hidden = Math.min(...towards.map((t) => hiddenFrom(board, arena, t).reduce((n, v) => n + v, 0))) / (SIZE * SIZE);
      tries.push({ spec, score: hidden + (hidden > MAX_HIDDEN ? 1 : 0) + (cell === site.cell ? 0 : 0.1) + 0.03 * Math.hypot(dx, dy) });
    }
  tries.sort((p, q) => p.score - q.score);
  for (const { spec } of tries) {
    const board = await boards.add(spec);
    const puzzle = await brain.generate(arenaOf(board), { seed, timeMs: 6000, attempts: 400, rounds: ROUNDS, arrivals: 1, squad }, progress);
    if (puzzle) return { board, puzzle };
    boards.remove(board);
  }
  return null;
}

interface Played {
  site: Site;
  outcome: FightOutcome | null;
}

/** A puzzle fought with the squad's weapons as they are now (the depot may have changed them since it was made). */
function armedNow(p: Puzzle, run: Run): Puzzle {
  const c = cloneCombat(p.combat);
  const arms = loadouts(run);
  let i = 0;
  for (let u = 0; u < c.roster.length; u++) if (teamOf(c, u) === SQUAD && arms[i]) c.arms[u] = arms[i++]!.arms;
  return { ...p, combat: c };
}

async function operation(city: City, squad: Squad): Promise<void> {
  const profile = loadProfile();
  profile.runs++;
  saveProfile(profile);
  const run = newRun(squad);
  const view = await openCity(city);
  const boards = new Boards(view);
  const brain = new Brain();
  const played: Played[] = [];
  let fight: Fight | null = null;
  let board: Board | null = null;
  // the city from above (D-158): the operation's blocks on it, and the board being fought
  const places = city.sites.flatMap((s) => {
    const at = view.query.lonLatToCell(s.lon, s.lat);
    return at ? [{ name: s.name, x: at[0], y: at[1] }] : [];
  });
  const cityMap = new CityMap(ui, view, places, () => {
    if (!board) return null;
    const x0 = board.origin[0];
    const y0 = board.origin[1];
    return { x0, y0, x1: x0 + board.w * board.cell, y1: y0 + board.h * board.cell };
  });
  view.edits.onChange((e) => {
    // the tiles under what was edited bake again: objects' footprints, terrain cells
    const pts = e.op === "cells" ? e.cells.map((c) => [c.x, c.y] as const) : e.objects.flatMap((i) => {
      const o = view.query.object(i);
      return o ? (o.fp ?? [[o.x, o.y] as const]) : [];
    });
    if (!pts.length) return;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    cityMap.forget(Math.min(...xs) - 4, Math.min(...ys) - 4, Math.max(...xs) + 4, Math.max(...ys) + 4);
  });
  Object.assign(window, { __tactics: { view, boards, brain, fight: () => fight, board: () => board, played, cityMap } });

  // the pointer and keys go to the fight on
  const canvas = view.canvas;
  let pointer: { x: number; y: number; object?: number } | null = null;
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener("pointermove", (e) => {
    const object = view.query.pickObject(e.offsetX, e.offsetY);
    const ground = view.query.pick(e.offsetX, e.offsetY);
    pointer = ground ? { x: ground.x, y: ground.y, ...(object && object.index >= 0 ? { object: object.index } : {}) } : null;
    if (pointer) fight?.pointer(pointer.x, pointer.y, pointer.object);
  });
  canvas.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener("pointerup", (e) => {
    if (e.button === 0 && down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4 && pointer) fight?.click(pointer.x, pointer.y, pointer.object);
    down = null;
  });
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    fight?.back();
  });
  window.addEventListener("keydown", (e) => {
    const k = e.key === "Enter" ? "enter" : e.key === "Tab" ? "tab" : e.key === "Escape" ? "escape" : e.key.toLowerCase();
    if (k === "c" || (k === "escape" && cityMap.open)) {
      cityMap.toggle();
      if (k === "escape") cityMap.close();
      return e.preventDefault();
    }
    if (fight?.key(k)) e.preventDefault();
    // the camera turned (the free camera's Q and E): the map and the cutaway follow at once
    if (k === "q" || k === "e") queueMicrotask(() => fight?.relayout());
  });

  // each block is made while the one before it is fought, on a worker of its own (the fight's outlook and hints keep theirs)
  const maker = new Brain();
  let tried = 0;
  let waiting: { set(html: string): void } | null = null;
  const make = (i: number) => {
    tried = 0;
    return scout(view, boards, maker, city.sites[i]!, loadouts(run), i + 1, (n) => {
      tried = n;
      waiting?.set(`<h2>${city.sites[i]!.name}</h2><p>Working out the invaders' landing… ${n} positions tried</p>`);
    });
  };
  let next = make(0);
  for (let i = 0; i < city.sites.length; i++) {
    const site = city.sites[i]!;
    const n = note(`<h2>${site.name}</h2><p>${tried ? `Working out the invaders' landing… ${tried} positions tried` : "Scouting the block…"}</p>`);
    waiting = n;
    const [found] = await Promise.all([next, view.camera.lookAt({ lon: site.lon, lat: site.lat })]);
    waiting = null;
    n.close();
    if (i + 1 < city.sites.length) next = make(i + 1);
    if (!found) {
      played.push({ site, outcome: null });
      await screen(`<h2>${site.name}</h2><p>No fight could be made on this block.</p><button data-go="next">Move on</button>`);
      continue;
    }
    board = found.board;
    for (;;) {
      fight = new Fight({ view, board, puzzle: armedNow(found.puzzle, run), brain, ui, labels, title: `${city.name} · ${site.name}`, rounds: ROUNDS, resets: RESETS, hints: HINTS });
      const o = await fight.done;
      fight.dispose();
      fight = null;
      const last = i === city.sites.length - 1;
      const pay = reward(o);
      const go = await screen(
        `<h2>${o.held ? "Block held" : o.squadDown ? "Squad down" : "Block lost"}</h2>
         <p>${site.name}: ${o.held ? "nobody lost" : `${Math.round(o.lost)} of ${Math.round(o.atStake)} people lost`} · ${o.invadersDown} invader${o.invadersDown === 1 ? "" : "s"} down · ${o.roundsHeld} of ${o.rounds} round${o.rounds === 1 ? "" : "s"} without loss${o.razed.length ? ` · ${o.razed.length} building${o.razed.length === 1 ? "" : "s"} down` : ""}</p>
         <p class="wallet">Moving on pays <b>★ ${pay.reputation}</b> reputation${pay.cores ? ` and <b>◆ ${pay.cores}</b> core` : ""}.</p>
         <button data-go="retry">Retry this block</button>
         <button data-go="next">${last ? "End the operation" : "Next block"}</button>`,
        o.held ? "won" : "lost",
      );
      if (go === "next") {
        played.push({ site, outcome: o });
        run.reputation += pay.reputation;
        run.cores += pay.cores;
        if (o.held) profile.blocksHeld++;
        saveProfile(profile);
        if (!last)
          await depot(
            ui,
            run,
            site.name,
            `${o.held ? "Block held" : "Block lost"}: ★ ${pay.reputation} reputation${pay.cores ? `, ◆ ${pay.cores} core` : ""}. Next: ${city.sites[i + 1]!.name}.`,
            i + 1,
          );
        break;
      }
      // the block as it was: its fallen buildings stand again
      if (o.razed.length) view.edits.restore(o.razed);
    }
    boards.remove(board);
    board = null;
  }

  const held = played.filter((p) => p.outcome?.held).length;
  const lost = played.reduce((n, p) => n + (p.outcome?.lost ?? 0), 0);
  // the run's end: an operation held to its last block counts, and squads may unlock
  const before = SQUADS.filter((s) => isUnlocked(profile, s));
  if (held === played.length && played.length) profile.operationsHeld++;
  saveProfile(profile);
  const fresh = SQUADS.filter((s) => isUnlocked(profile, s) && !before.includes(s));
  await screen(
    `<h2>${city.name}: ${held === played.length ? "every block held" : `${held} of ${played.length} blocks held`}</h2>
     <ul class="summary">${played.map((p) => `<li>${p.site.name}: ${!p.outcome ? "no fight" : p.outcome.held ? "held" : `${Math.round(p.outcome.lost)} people lost`}</li>`).join("")}</ul>
     <p>${Math.round(lost)} people lost in all. The ${squad.name} ends the run with ★ ${run.reputation} and ◆ ${run.cores} unspent.</p>
     ${fresh.map((s) => `<p class="unlock">New squad unlocked: <b>${s.name}</b>. ${s.about}</p>`).join("")}
     <button data-go="cities">Another city</button>`,
  );
  location.search = "";
}

async function main() {
  const i = params.get("city");
  const city = i !== null && CITIES[Number(i)] ? CITIES[Number(i)]! : await title();
  // a squad given in the address (`squad=1`) skips the choosing, as `city=` does
  const sq = params.get("squad");
  const profile = loadProfile();
  const squad = sq !== null && SQUADS[Number(sq)] && isUnlocked(profile, SQUADS[Number(sq)]!) ? SQUADS[Number(sq)]! : sq !== null ? SQUADS[0]! : await pickSquad(ui, profile);
  await operation(city, squad);
}

main().catch((e: unknown) => {
  console.error(e);
  note(`<h2>Something went wrong</h2><p>${String(e)}</p>`);
});
