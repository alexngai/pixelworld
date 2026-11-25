import { cityPlugin as hongKong } from "@pixelworlds/city-hongkong";
import { cityPlugin as kyoto } from "@pixelworlds/city-kyoto";
import { cityPlugin as newYork } from "@pixelworlds/city-nyc";
import { cityPlugin as paris } from "@pixelworlds/city-paris";
import { cityPlugin as sanFrancisco } from "@pixelworlds/city-sf";
import { cityPlugin as tokyo } from "@pixelworlds/city-tokyo";
import { Boards, createWorldView, roverController, type Board, type WorldView } from "@pixelworlds/engine";
import { OVERRUN, SQUAD, SQUADS, arenaFromBoard, cloneCombat, rooftop, teamOf, toWire, fromWire, type Combat, type Loadout, type Puzzle, type Squad, type Threat } from "@pixelworlds/tactics";
import { Brain } from "./brain";
import { Ahead } from "./ahead";
import { CityMap } from "./cityMap";
import { FIGHT_ROUNDS, coopCampaign, roomCode, soloCampaign, type JointOut } from "./coop";
import { Fight, type FightOutcome } from "./fight";
import "./game.css";
import { chooseThreat, drawFront } from "./overworld";
import { depot, isUnlocked, loadProfile, loadouts, newRun, pickSquad, reward, saveProfile, type Run } from "./runs";
import { CITIES, type Block, type City } from "./sites";

/**
 * The tactics game (D-153): pick a city, then defend it against invaders one
 * block at a time, on boards cut from the real streets: the city's front
 * (D-179) over its surveyed boards (D-178), alone or with other squads in a
 * co-op room. Puzzles are made and checked in a worker; buildings a fight
 * brings down stay down for the rest of the operation, for every squad.
 * `?city=0` (an index into CITIES) skips the title and plays alone;
 * `&room=CODE` joins a co-op room; `&board=x0,y0,cell` plays that one board
 * (the survey gallery's link). The console has `__tactics`.
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
const ROUNDS = FIGHT_ROUNDS;
const RESETS = 1;
const HINTS = 1;
const SIZE = 8;
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
     <p>Invaders are landing in the cities. Your squad of three rigs holds one block at a time while the front spreads through the city's districts; between blocks, the depot arms it with what the blocks held have earned. Defend a city alone, or with other squads.</p>
     <p>Every invader shows where it will strike before you move. Push them, drown them, drop them off roofs, bring towers down on them: whatever keeps the people in the buildings alive.</p>
     <button data-go="start">Start</button>`,
    "title",
  );
  const go = await screen(
    `<h2>Choose a city</h2>
     <div class="cities">${CITIES.map((c, i) => `<button data-go="${i}"><b>${c.name}</b><span>${pools[c.world]?.length ?? 0} surveyed blocks to defend</span></button>`).join("")}</div>`,
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
  const flat = arenaFromBoard(board, view.query, view.world.manifest.surfaces, { metersPerCell: mpc });
  const arena = block.floor === undefined ? flat : rooftop(flat, block.floor);
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

/**
 * An operation (D-179): the city's front, alone or in a co-op room; each wave
 * the squad takes a block on the overworld, fights it, is paid, and visits
 * the depot. One board given (the gallery's link) is fought on its own.
 */
async function operation(city: City, squad: Squad, cityPool: readonly Block[], opts: { board?: Block; room?: string; name?: string }): Promise<void> {
  const profile = loadProfile();
  profile.runs++;
  saveProfile(profile);
  const run = newRun(squad);
  let seed = (Math.random() * 2 ** 31) >>> 0;
  const crew = { name: opts.name ?? "You", squad: squad.name };
  const campaign = opts.board ? null : opts.room ? await coopCampaign(opts.room, { world: city.world, ...crew }) : soloCampaign(cityPool, crew, seed);
  // the boards the front's sites are places in: a room's own (a newer survey may have changed this page's)
  const pool = campaign?.pool ?? cityPool;
  const view = await openCity(city);
  const boards = new Boards(view);
  const brain = new Brain();
  const played: Played[] = [];
  let fight: Fight | null = null;
  let board: Board | null = null;
  let choosing = false;
  // the city from above (D-158): the front on it (D-179), and the board being fought
  const cityMap = new CityMap(ui, view, opts.board ? [{ name: opts.board.name, ...middle(opts.board) }] : [], () => {
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
  if (campaign) {
    cityMap.decorate = (g, at, k) => drawFront(g, at, k, campaign, pool);
    // what the other squads' fights brought down comes down here too
    const sync = () => {
      const gone = campaign.front.razed.filter((o) => !view.edits.isRemoved(o));
      if (gone.length) view.edits.remove(gone);
      cityMap.redraw();
    };
    campaign.listen(sync);
    sync();
  }
  Object.assign(window, { __tactics: { view, boards, brain, fight: () => fight, board: () => board, played, cityMap, campaign } });

  // the pointer and keys go to the fight on
  const canvas = view.canvas;
  let pointer: { x: number; y: number; h: number; object?: number } | null = null;
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener("pointermove", (e) => {
    const object = view.query.pickObject(e.offsetX, e.offsetY);
    const ground = view.query.pick(e.offsetX, e.offsetY);
    pointer = ground ? { x: ground.x, y: ground.y, h: ground.h, ...(object && object.index >= 0 ? { object: object.index } : {}) } : null;
    if (pointer) fight?.pointer(pointer.x, pointer.y, pointer.object, pointer.h);
  });
  canvas.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener("pointerup", (e) => {
    if (e.button === 0 && down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4 && pointer) fight?.click(pointer.x, pointer.y, pointer.object, pointer.h);
    down = null;
  });
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    fight?.back();
  });
  window.addEventListener("keydown", (e) => {
    if (choosing || (e.target as HTMLElement).tagName === "INPUT") return;
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

  // fights are made on a worker of their own (the fight's outlook and hints keep theirs); the first on a cold worker, given longer
  const maker = new Brain();
  let cold = true;
  const make = (site: Block, progress: (tried: number) => void) => {
    const timeMs = cold ? FIRST_MAKE_MS : MAKE_MS;
    cold = false;
    return fightOn(view, boards, maker, site, loadouts(run), seed++, timeMs, progress);
  };
  // the wave's open blocks made ahead while the squad isn't fighting (D-185): looking over the city, or at the depot
  const ahead = campaign ? new Ahead<{ board: Board; puzzle: Puzzle }>((i, progress) => make(pool[i]!, progress), (f) => boards.remove(f.board)) : null;
  let fighting = false;
  const lookAhead = () => {
    if (!campaign || !ahead || fighting || campaign.front.over) return;
    ahead.want(campaign.front.threats.filter((t) => !t.result && (!t.by || t.by === campaign.me)).map((t) => t.site));
  };
  campaign?.listen(lookAhead);
  lookAhead();

  /** A block fought till the squad moves on (retried as often as asked), paid for; null when no fight could be made on it. */
  const play = async (site: Block, making: (progress: (tried: number) => void) => Promise<{ board: Board; puzzle: Puzzle } | null>): Promise<{ o: FightOutcome; start: Combat } | null> => {
    const n = note(`<h2>${site.name}</h2><p>Scouting the block…</p>`);
    const [found] = await Promise.all([making((tried) => n.set(`<h2>${site.name}</h2><p>Working out the invaders' landing… ${tried} positions tried</p>`)), view.camera.lookAt(middle(site))]);
    n.close();
    if (!found) {
      await screen(`<h2>${site.name}</h2><p>No fight could be made on this block.</p><button data-go="next">Move on</button>`);
      return null;
    }
    board = found.board;
    const puzzle = armedNow(found.puzzle, run);
    for (;;) {
      fight = new Fight({ view, board, puzzle, brain, ui, labels, title: `${city.name} · ${site.name}`, rounds: ROUNDS, resets: RESETS, hints: HINTS });
      const o = await fight.done;
      fight.dispose();
      fight = null;
      const pay = reward(o);
      const go = await screen(
        `<h2>${o.held ? "Block held" : o.squadDown ? "Squad down" : "Block lost"}</h2>
         <p>${site.name}: ${o.held ? "nobody lost" : `${Math.round(o.lost)} of ${Math.round(o.atStake)} people lost`} · ${o.invadersDown} invader${o.invadersDown === 1 ? "" : "s"} down · ${o.roundsHeld} of ${o.rounds} round${o.rounds === 1 ? "" : "s"} without loss${o.razed.length ? ` · ${o.razed.length} building${o.razed.length === 1 ? "" : "s"} down` : ""}</p>
         <p class="wallet">Moving on pays <b>★ ${pay.reputation}</b> reputation${pay.cores ? ` and <b>◆ ${pay.cores}</b> core` : ""}.</p>
         <button data-go="retry">Retry this block</button>
         <button data-go="next">${campaign ? "Back to the city" : "End the operation"}</button>`,
        o.held ? "won" : "lost",
      );
      if (go === "next") {
        boards.remove(board);
        board = null;
        played.push({ site, outcome: o });
        run.reputation += pay.reputation;
        run.cores += pay.cores;
        if (o.held) profile.blocksHeld++;
        saveProfile(profile);
        return { o, start: puzzle.combat };
      }
      // the block as it was: its fallen buildings stand again
      if (o.razed.length) view.edits.restore(o.razed);
    }
  };

  /**
   * A joint finale (D-187): the lead's page makes the fight and sends its
   * start, the second squad's page sends its rigs; the room sets both squads
   * on the board and sends the fight to both. Null when it doesn't begin (the
   * other squad gone, or the block changed): back to the city.
   */
  const playJoint = async (t: Threat): Promise<FightOutcome | null> => {
    const c = campaign!;
    const site = pool[t.site]!;
    const lead = t.by === c.me;
    const partner = c.crews[(lead ? t.with : t.by)!]?.name ?? "the other squad";
    const n = note(`<h2>${site.name}: the finale</h2><p>${lead ? "Working out the invaders' landing…" : `Waiting for ${partner}'s squad to scout the block…`}</p>`);
    const begun = new Promise<Extract<JointOut, { k: "j-begin" }> | null>((done) => {
      const end = (m: Extract<JointOut, { k: "j-begin" }> | null) => {
        offJ();
        offF();
        done(m);
      };
      const offJ = c.onJoint((m) => {
        if (m.k === "j-begin" && m.threat === t.id) end(m);
      });
      // the other squad gone, or the block changed, before it begins
      const offF = c.listen(() => {
        const x = c.front.threats.find((y) => y.id === t.id);
        if (!x || !x.with || x.site !== t.site || x.result) end(null);
      });
    });
    let found: { board: Board; puzzle: Puzzle } | null = null;
    if (lead) {
      ahead!.onProgress = (s, tried) => s === t.site && n.set(`<h2>${site.name}: the finale</h2><p>Working out the invaders' landing… ${tried} positions tried</p>`);
      found = await ahead!.take(t.site);
      if (!found) {
        n.close();
        c.send({ k: "swap", threat: t.id });
        return null;
      }
      c.joint({ k: "j-start", threat: t.id, start: toWire(armedNow(found.puzzle, run).combat) });
    } else {
      ahead!.clear();
      c.joint({ k: "j-squad", threat: t.id, rigs: run.rigs.map((r) => ({ kind: r.kind, slots: r.slots })) });
    }
    const [b] = await Promise.all([begun, view.camera.lookAt(middle(site))]);
    n.close();
    if (!b) {
      if (found) boards.remove(found.board);
      return null;
    }
    board = found?.board ?? (await boards.add({ x0: site.x0, y0: site.y0, w: SIZE, h: SIZE, cell: site.cell }));
    fight = new Fight({
      view,
      board,
      puzzle: { combat: fromWire<Combat>(b.start) },
      brain,
      ui,
      labels,
      title: `${city.name} · ${site.name} · with ${partner}`,
      rounds: ROUNDS,
      resets: 0,
      hints: HINTS,
      joint: {
        mine: new Set(b.units[c.me] ?? []),
        partner,
        take: (unit) => c.joint({ k: "j-take", threat: t.id, unit }),
        act: (action) => c.joint({ k: "j-act", threat: t.id, action }),
        cancel: () => c.joint({ k: "j-cancel", threat: t.id }),
        end: () => c.joint({ k: "j-end", threat: t.id }),
      },
    });
    const off = c.onJoint((m) => {
      if (m.threat !== t.id || !fight) return;
      if (m.k === "j-baton") fight.jointBaton(m.by === null ? null : m.by === c.me);
      else if (m.k === "j-act" && m.by !== c.me) fight.jointAct(m.action);
      else if (m.k === "j-turn") fight.jointTurn();
    });
    const o = await fight.done;
    off();
    fight.dispose();
    fight = null;
    boards.remove(board);
    board = null;
    const pay = reward(o);
    await screen(
      `<h2>${o.held ? "Finale held" : o.squadDown ? "Squads down" : "Finale lost"}</h2>
       <p>${site.name}, with ${partner}: ${o.held ? "nobody lost" : `${Math.round(o.lost)} of ${Math.round(o.atStake)} people lost`} · ${o.invadersDown} invader${o.invadersDown === 1 ? "" : "s"} down · ${o.roundsHeld} of ${o.rounds} round${o.rounds === 1 ? "" : "s"} without loss</p>
       <p class="wallet">It pays <b>★ ${pay.reputation}</b> reputation${pay.cores ? ` and <b>◆ ${pay.cores}</b> core` : ""}.</p>
       <button data-go="next">Back to the city</button>`,
      o.held ? "won" : "lost",
    );
    played.push({ site, outcome: o });
    run.reputation += pay.reputation;
    run.cores += pay.cores;
    if (o.held) profile.blocksHeld++;
    saveProfile(profile);
    return o;
  };

  if (!campaign) {
    played.push({ site: opts.board!, outcome: (await play(opts.board!, (progress) => make(opts.board!, progress)))?.o ?? null });
  } else {
    // the front: a block taken on the overworld each wave, fought, reported, then the depot
    for (;;) {
      choosing = true;
      const id = await chooseThreat(ui, cityMap, campaign, pool, city.name);
      choosing = false;
      cityMap.close();
      if (id === null) break;
      const t = campaign.front.threats.find((x) => x.id === id)!;
      const site = pool[t.site]!;
      // the finale with nobody to join it: fought alone; with a second squad, together (D-187)
      if (t.joint && !t.with) campaign.send({ k: "alone", threat: id });
      if (t.joint && t.with) {
        fighting = true;
        const o = await playJoint(t);
        fighting = false;
        if (!o) continue;
        if (campaign.front.over) break;
        const pay = reward(o);
        await depot(ui, run, site.name, `${o.held ? "Block held" : "Block lost"}: ★ ${pay.reputation} reputation${pay.cores ? `, ◆ ${pay.cores} core` : ""}. Back to the city next.`, seed++);
        continue;
      }
      fighting = true;
      const r = await play(site, (progress) => {
        ahead!.onProgress = (s, tried) => s === t.site && progress(tried);
        return ahead!.take(t.site);
      });
      fighting = false;
      if (!r) {
        campaign.send({ k: "swap", threat: id });
        continue;
      }
      const o = r.o;
      campaign.fought(id, r.start, o);
      if (campaign.front.over) break;
      const pay = reward(o);
      await depot(ui, run, site.name, `${o.held ? "Block held" : "Block lost"}: ★ ${pay.reputation} reputation${pay.cores ? `, ◆ ${pay.cores} core` : ""}. Back to the city next.`, seed++);
    }
  }

  // the run's end: a city held counts, and squads may unlock
  const f = campaign?.front;
  const before = SQUADS.filter((s) => isUnlocked(profile, s));
  if (f?.over === "held") profile.operationsHeld++;
  saveProfile(profile);
  const fresh = SQUADS.filter((s) => isUnlocked(profile, s) && !before.includes(s));
  const lost = played.reduce((n, p) => n + (p.outcome?.lost ?? 0), 0);
  const overrun = f ? f.districts.filter((_, j) => f.pressure[j] === OVERRUN) : [];
  await screen(
    `<h2>${city.name}: ${!f ? (played[0]?.outcome?.held ? "block held" : "block fought") : f.over === "held" ? "the city held" : f.over === "lost" ? "the city lost" : "the room is gone"}</h2>
     ${f ? `<p>${f.wave} of ${f.waves} waves · trust ${f.trust} left · ${overrun.length ? `overrun: ${overrun.map((d) => d.name).join(", ")}` : "no district overrun"}</p>` : ""}
     ${f?.news.length ? `<ul class="news">${f.news.map((n) => `<li>${n}</li>`).join("")}</ul>` : ""}
     <h3>Your squad's blocks</h3>
     <ul class="summary">${played.map((p) => `<li>${p.site.name}: ${!p.outcome ? "no fight" : p.outcome.held ? "held" : `${Math.round(p.outcome.lost)} people lost`}</li>`).join("")}</ul>
     <p>${Math.round(lost)} people lost in your fights. The ${squad.name} ends the run with ★ ${run.reputation} and ◆ ${run.cores} unspent.</p>
     ${fresh.map((s) => `<p class="unlock">New squad unlocked: <b>${s.name}</b>. ${s.about}</p>`).join("")}
     <button data-go="cities">Another city</button>`,
  );
  location.search = "";
}

/** Playing with other squads: a name, and a room opened (its code) or the one in the link joined. */
function together(room: string | null): Promise<{ room: string; name: string } | null> {
  const KEY = "pixelworld.tactics.name";
  let name = "";
  try {
    name = localStorage.getItem(KEY) ?? "";
  } catch {
    // no storage: the name is asked each time
  }
  const el = document.createElement("div");
  el.className = "screen";
  el.innerHTML = `<div class="box">
    <h2>${room ? `Join room ${room}` : "Defend a city together"}</h2>
    <p>${room ? "Squads in this room are defending the city together: each takes its own block each wave." : "Open a room and send its link to the other squads: each takes its own block each wave, and the city's front is everyone's."}</p>
    <p><label>Your name <input name="crew" maxlength="20" value="${name.replace(/"/g, "")}" placeholder="Your name"></label></p>
    <button data-go="go">${room ? "Join" : "Open a room"}</button>
    ${room ? "" : `<button data-go="alone">Play alone instead</button>`}
  </div>`;
  ui.append(el);
  return new Promise((done) =>
    el.addEventListener("click", (e) => {
      const go = (e.target as HTMLElement).closest<HTMLElement>("[data-go]")?.dataset.go;
      if (!go) return;
      const typed = el.querySelector<HTMLInputElement>("input")!.value.trim() || "A squad";
      try {
        localStorage.setItem(KEY, typed);
      } catch {
        // as above
      }
      el.remove();
      done(go === "alone" ? null : { room: room ?? roomCode(), name: typed });
    }),
  );
}

async function main() {
  const pools = await POOLS;
  const i = params.get("city");
  const city = i !== null && CITIES[Number(i)] ? CITIES[Number(i)]! : await title(pools);
  const pool = pools[city.world] ?? [];
  // one board given in the address (the gallery's link), else the city's front: alone, or in the room the link names
  const at = params.get("board")?.split(",").map(Number);
  const given = at && pool.find((b) => b.x0 === at[0] && b.y0 === at[1] && b.cell === at[2]);
  const board = at ? given || { name: "The surveyed board", zone: -1, x0: at[0]!, y0: at[1]!, cell: at[2] ?? 2, score: 0 } : undefined;
  const linked = params.get("room");
  const coop = board ? null : linked ? await together(linked) : i === null && (await screen(`<h2>${city.name}</h2><p>Defend the city alone, or with other squads, each fighting its own blocks while the city's front is everyone's.</p><button data-go="alone">Alone</button><button data-go="together">With other squads</button>`)) === "together" ? await together(null) : null;
  if (coop) history.replaceState(null, "", `?${new URLSearchParams({ city: String(CITIES.indexOf(city)), room: coop.room })}`);
  // a squad given in the address (`squad=1`) skips the choosing, as `city=` does
  const sq = params.get("squad");
  const profile = loadProfile();
  const squad = sq !== null && SQUADS[Number(sq)] && isUnlocked(profile, SQUADS[Number(sq)]!) ? SQUADS[Number(sq)]! : sq !== null ? SQUADS[0]! : await pickSquad(ui, profile);
  await operation(city, squad, pool, { board, ...(coop ?? {}) });
}

main().catch((e: unknown) => {
  console.error(e);
  note(`<h2>Something went wrong</h2><p>${String(e)}</p>`);
});
