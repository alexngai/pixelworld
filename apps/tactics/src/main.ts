import { cityPlugin as hongKong } from "@pixelworlds/city-hongkong";
import { cityPlugin as kyoto } from "@pixelworlds/city-kyoto";
import { cityPlugin as newYork } from "@pixelworlds/city-nyc";
import { cityPlugin as paris } from "@pixelworlds/city-paris";
import { cityPlugin as sanFrancisco } from "@pixelworlds/city-sf";
import { cityPlugin as tokyo } from "@pixelworlds/city-tokyo";
import { Boards, createWorldView, roverController, type Board, type WorldView } from "@pixelworlds/engine";
import { SQUAD, SQUADS, arenaFromBoard, cloneCombat, teamOf, type Loadout, type Puzzle, type Squad } from "@pixelworlds/tactics";
import { Brain } from "./brain";
import { CityMap } from "./cityMap";
import { Fight, type FightOutcome } from "./fight";
import "./game.css";
import { depot, isUnlocked, loadProfile, loadouts, newRun, pickSquad, reward, saveProfile, type Run } from "./runs";
import { BLOCKS, CITIES, drawBlock, drawOperation, type Block, type City } from "./sites";

/**
 * The tactics game (D-153): pick a city, then hold its blocks one fight at a
 * time against invaders, on boards cut from the real streets: three drawn
 * from the city's surveyed boards each run (D-178). Puzzles are made and
 * checked in a worker; buildings a fight brings down stay down for the rest
 * of the operation. `?city=0` (an index into CITIES) skips the title;
 * `&board=x0,y0,cell` plays that one board (the survey gallery's link). The
 * console has `__tactics`.
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
/** Boards drawn for a block before it is given up: another is drawn when no fight can be made on one. */
const DRAWS = 4;
/**
 * How long a block's puzzle is looked for (ms). The first block's longer: its
 * worker is cold, a few times slower than once warm, and boards a fight is
 * made on in the survey (tools/survey-play.mjs, six seconds) came to nothing.
 */
const MAKE_MS = 6000;
const FIRST_MAKE_MS = 12000;
/** The surveyed boards by world (tools/survey-boards.mjs). */
const POOLS = import("../survey/boards.json").then((m) => m.default as unknown as Record<string, Block[]>);
const middle = (b: Block) => ({ x: b.x0 + (SIZE * b.cell) / 2, y: b.y0 + (SIZE * b.cell) / 2 });

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

async function title(pools: Record<string, Block[]>): Promise<City> {
  await screen(
    `<h1>Hold the Block</h1>
     <p>Invaders are landing in the cities. Your squad of three rigs holds one block at a time; between blocks, the depot arms it with what the blocks held have earned.</p>
     <p>Every invader shows where it will strike before you move. Push them, drown them, drop them off roofs, bring towers down on them: whatever keeps the people in the buildings alive.</p>
     <button data-go="start">Start</button>`,
    "title",
  );
  const go = await screen(
    `<h2>Choose a city</h2>
     <div class="cities">${CITIES.map((c, i) => `<button data-go="${i}"><b>${c.name}</b><span>${BLOCKS} blocks drawn from ${pools[c.world]?.length ?? 0} surveyed, anew each run</span></button>`).join("")}</div>`,
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
 * A fight on a surveyed board (D-178): the board added and a puzzle made on
 * it; null when none comes of it. It needs no camera there, so the next block
 * is made while this one is fought.
 */
async function fightOn(
  view: WorldView,
  boards: Boards,
  brain: Brain,
  block: Block,
  squad: Loadout[],
  seed: number,
  timeMs: number,
  progress: (tried: number) => void,
): Promise<{ board: Board; puzzle: Puzzle } | null> {
  const mpc = view.world.manifest.scale.metersPerCell;
  const board = await boards.add({ x0: block.x0, y0: block.y0, w: SIZE, h: SIZE, cell: block.cell });
  const arena = arenaFromBoard(board, view.query, view.world.manifest.surfaces, { metersPerCell: mpc });
  const puzzle = await brain.generate(arena, { seed, timeMs, attempts: 400, rounds: ROUNDS, arrivals: 1, squad }, progress);
  if (puzzle) return { board, puzzle };
  boards.remove(board);
  return null;
}

interface Played {
  site: Block;
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

/** An operation: the blocks fought in order, each redrawn from the pool when no fight can be made on it. */
async function operation(city: City, squad: Squad, pool: readonly Block[], blocks: Block[]): Promise<void> {
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
  const places = blocks.map((b) => ({ name: b.name, ...middle(b) }));
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
  const given: Block[] = [];
  const make = async (i: number) => {
    for (let d = 0; d < DRAWS; d++) {
      tried = 0;
      const block = blocks[i]!;
      const found = await fightOn(view, boards, maker, block, loadouts(run), i + 1, i === 0 && d === 0 ? FIRST_MAKE_MS : MAKE_MS, (n) => {
        tried = n;
        waiting?.set(`<h2>${block.name}</h2><p>Working out the invaders' landing… ${n} positions tried</p>`);
      });
      if (found) return found;
      // no fight on this one: another in its place
      given.push(block);
      const again = drawBlock(pool, blocks.filter((b) => b !== block), Math.random, given);
      if (!again) return null;
      blocks[i] = again;
      places[i] = { name: again.name, ...middle(again) };
    }
    return null;
  };
  let next = make(0);
  for (let i = 0; i < blocks.length; i++) {
    const n = note(`<h2>${blocks[i]!.name}</h2><p>${tried ? `Working out the invaders' landing… ${tried} positions tried` : "Scouting the block…"}</p>`);
    waiting = n;
    const drawn = blocks[i]!;
    const [found] = await Promise.all([next, view.camera.lookAt(middle(drawn))]);
    // drawn again while the camera went
    const site = blocks[i]!;
    if (site !== drawn) await view.camera.lookAt(middle(site));
    waiting = null;
    n.close();
    if (i + 1 < blocks.length) next = make(i + 1);
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
      const last = i === blocks.length - 1;
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
            `${o.held ? "Block held" : "Block lost"}: ★ ${pay.reputation} reputation${pay.cores ? `, ◆ ${pay.cores} core` : ""}. Next: ${blocks[i + 1]!.name}.`,
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
  const pools = await POOLS;
  const i = params.get("city");
  const city = i !== null && CITIES[Number(i)] ? CITIES[Number(i)]! : await title(pools);
  const pool = pools[city.world] ?? [];
  // one board given in the address (the gallery's link), else an operation drawn
  const at = params.get("board")?.split(",").map(Number);
  const given = at && pool.find((b) => b.x0 === at[0] && b.y0 === at[1] && b.cell === at[2]);
  const blocks = at ? [given || { name: "The surveyed board", zone: -1, x0: at[0]!, y0: at[1]!, cell: at[2] ?? 2, score: 0 }] : drawOperation(pool, Math.random);
  // a squad given in the address (`squad=1`) skips the choosing, as `city=` does
  const sq = params.get("squad");
  const profile = loadProfile();
  const squad = sq !== null && SQUADS[Number(sq)] && isUnlocked(profile, SQUADS[Number(sq)]!) ? SQUADS[Number(sq)]! : sq !== null ? SQUADS[0]! : await pickSquad(ui, profile);
  await operation(city, squad, at ? [] : pool, blocks);
}

main().catch((e: unknown) => {
  console.error(e);
  note(`<h2>Something went wrong</h2><p>${String(e)}</p>`);
});
