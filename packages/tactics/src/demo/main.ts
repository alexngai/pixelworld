import { cityPlugin as hongKong } from "@pixelworlds/city-hongkong";
import { cityPlugin as kyoto } from "@pixelworlds/city-kyoto";
import { cityPlugin as newYork } from "@pixelworlds/city-nyc";
import { cityPlugin as paris } from "@pixelworlds/city-paris";
import { cityPlugin as sanFrancisco } from "@pixelworlds/city-sf";
import { cityPlugin as tokyo } from "@pixelworlds/city-tokyo";
import {
  Boards,
  CELL_ROAD,
  CELL_WALL,
  CELL_WATER,
  boardCellAt,
  createWorldView,
  roverController,
  toWorld,
  type Board,
  type CellEdit,
  type Entity,
  type WorldView,
} from "@pixelworlds/engine";
import { BoardOverlay, entityModel, objectInfo, rampsFor, type Arrow, type FxKind, type Mark, type UnitKind } from "../index";

/**
 * The tactics sandbox (D-147–D-149): the engine's terrain edits and boards,
 * and this package's overlays, models and building facts, on a city's
 * walking level. Three boards lie on the map at three resolutions, two of
 * them overlapping; fire, demolition, floods and mounds edit the world, and
 * every board over the ground follows. Not a game: a bench to try them on.
 * `?world=kyoto-walk` (or sf-walk, paris-walk, tokyo-walk, hongkong-walk),
 * `&at=lon,lat`. The console has `sandbox`.
 */

const PACKS = [sanFrancisco, newYork, paris, kyoto, tokyo, hongKong];
const STYLES: Record<string, () => Promise<{ default: object }>> = {
  "new-york": () => import("../../../../worlds/_styles/new-york/style.json"),
  kyoto: () => import("../../../../worlds/_styles/kyoto/style.json"),
  "bay-area": () => import("../../../../worlds/_styles/bay-area/style.json"),
  paris: () => import("../../../../worlds/_styles/paris/style.json"),
  tokyo: () => import("../../../../worlds/_styles/tokyo/style.json"),
  hongkong: () => import("../../../../worlds/_styles/hongkong/style.json"),
};
/** Where each world's boards go: Battery Park's lawns, harbour and towers; Pontochō between the Kamo and Kiyamachi. */
const PLACES: Record<string, [number, number]> = {
  "nyc-walk": [-74.0158, 40.7043],
  "kyoto-walk": [135.7712, 35.0047],
};

const FLAMMABLE_SURFACES: Record<string, number> = { forest: 0.8, woodland: 0.75, scrub: 0.7, grass: 0.55, lawn: 0.45, yard: 0.45, farmland: 0.5 };

const log = document.getElementById("log")!;
const status = document.getElementById("status")!;
const say = (s: string) => (log.textContent = s);

async function main() {
  const params = new URLSearchParams(location.search);
  const world = params.get("world") ?? "nyc-walk";
  const manifest = (await (await fetch(`/${world}/manifest.json`)).json()) as { style: string };
  const style = (await STYLES[manifest.style]!()).default as { plugins?: string[] };
  const canvas = document.getElementById("world") as HTMLCanvasElement;
  const at = params.get("at")?.split(",").map(Number) ?? PLACES[world];
  const view = await createWorldView({
    canvas,
    worldUrl: `/${world}/`,
    style,
    plugins: PACKS.filter((p) => style.plugins?.includes(p.name)),
    // the rover's free camera: WASD and drags pan, Q/E rotate, 1–6 zoom (the rover itself is left out)
    controller: roverController({ follow: false, visible: false, listen: { keys: window, pointer: canvas } }),
  });
  if (at) await view.camera.lookAt({ lon: at[0]!, lat: at[1]! });
  view.camera.zoom = 3;
  const sandbox = await setUp(view);
  Object.assign(window, { view, sandbox });
}

async function setUp(view: WorldView) {
  const { query } = view;
  const ramps = rampsFor(view.world.palette.rampIds);
  const rs = view.world.renderScale;
  const mpc = view.world.manifest.scale.metersPerCell;
  const cx = Math.floor(view.camera.x);
  const cy = Math.floor(view.camera.y);
  // a board's cells by (i, j); where a unit stands on one (a roof, or the ground)
  const idx = (b: Board, i: number, j: number) => j * b.w + i;
  const inside = (b: Board, i: number, j: number) => i >= 0 && j >= 0 && i < b.w && j < b.h;
  const center = (b: Board, i: number, j: number) => toWorld(b, { x: i + 0.5, y: j + 0.5 });
  const cellOf = (b: Board, x: number, y: number): [number, number] => {
    const k = boardCellAt(b, x, y);
    return [k % b.w, Math.floor(k / b.w)];
  };
  const stand = (b: Board, k: number) => (b.flags[k]! & CELL_WALL ? b.top[k]! : b.height[k]!);

  // three boards: a battle at world cells, a finer one over its east side, a coarse one apart to the north
  const boards = new Boards(view);
  const main = await boards.add({ x0: cx - 8, y0: cy - 8, w: 16, h: 16 });
  const fine = await boards.add({ x0: cx + 2, y0: cy - 4, w: 16, h: 16, cell: 0.5 });
  const coarse = await boards.add({ x0: cx - 12, y0: cy - 40, w: 8, h: 8, cell: 3 });
  const overlays = new Map<Board, BoardOverlay>();
  for (const [i, b] of [main, fine, coarse].entries()) {
    const o = new BoardOverlay(b, { id: `board-${i}` });
    overlays.set(b, o);
    await view.layers.add(o);
  }
  boards.onChange((b) => overlays.get(b)?.changed());

  // ---------------------------------------------------------------- units
  const units: { kind: UnitKind; board: Board; i: number; j: number; entity: Entity }[] = [];
  const free = (b: Board, i: number, j: number) => {
    const k = idx(b, i, j);
    return !(b.flags[k]! & (CELL_WATER | CELL_WALL)) && b.object[k]! < 0 && !units.some((u) => u.board === b && u.i === i && u.j === j);
  };
  const place = (kind: UnitKind, b: Board, i0: number, j0: number, heading: number) => {
    for (let r = 0; r < Math.max(b.w, b.h); r++)
      for (let j = j0 - r; j <= j0 + r; j++)
        for (let i = i0 - r; i <= i0 + r; i++) {
          if (!inside(b, i, j) || !free(b, i, j)) continue;
          const { x, y } = center(b, i, j);
          const flying = kind === "drone" || kind === "flyer";
          const entity = view.entities.add({ model: entityModel(kind, ramps, { scale: b.cell, renderScale: rs }), x, y, h: stand(b, idx(b, i, j)), heading, silhouette: true, ...(flying ? { lift: 0 } : {}) });
          units.push({ kind, board: b, i, j, entity });
          return;
        }
  };
  for (const [kind, i, j] of [["pumper", 2, 12], ["crane", 4, 13], ["wrecker", 2, 9], ["drone", 5, 10]] as const) place(kind, main, i, j, -Math.PI / 4);
  for (const [kind, i, j] of [["crawler", 12, 3], ["brute", 13, 5], ["flyer", 10, 2]] as const) place(kind, main, i, j, (3 * Math.PI) / 4);
  place("crawler", fine, 10, 4, Math.PI);
  place("brute", coarse, 4, 4, Math.PI / 2);

  // ---------------------------------------------------------------- effects
  const fx = new Set<{ entities: Entity[]; until: number }>();
  const effect = (kind: FxKind, x: number, y: number, frames: number, seconds = Infinity) => {
    const h = query.heightAt(x, y) ?? 0;
    const entities = Array.from({ length: frames }, (_, frame) =>
      view.entities.add({ model: entityModel(kind, ramps, { renderScale: rs, frame, seed: (x * 31 + y) | 0 }), x, y, h, wait: false, visible: frame === 0, headings: 1 }),
    );
    const e = { entities, until: view.time + seconds };
    fx.add(e);
    return e;
  };
  let tick = 0;
  view.onFrame(() => {
    const t = Math.floor(view.time * 6);
    if (t === tick) return;
    tick = t;
    for (const e of fx) {
      if (view.time > e.until) {
        for (const en of e.entities) en.remove();
        fx.delete(e);
        continue;
      }
      e.entities.forEach((en, i) => (en.visible = i === t % e.entities.length));
    }
  });

  // ---------------------------------------------------------------- the world under a point
  const describe = (x: number, y: number): string => {
    const lines: string[] = [];
    const s = query.surfaceAt(x, y);
    lines.push(`cell ${Math.floor(x)},${Math.floor(y)} · ${s?.name ?? "?"}${s?.waterLevel != null ? ` · water ${s.waterLevel}` : ""} · ground ${query.heightAt(x, y)?.toFixed(2)}`);
    for (const hit of query.objectsAt(x, y).slice(0, 2)) {
      const o = query.object(hit.index);
      if (!o) continue;
      const info = objectInfo(o, { metersPerCell: mpc });
      lines.push(
        `#${hit.index} ${hit.group}` +
          (info.building
            ? ` · ${info.storeys} storeys, ${Math.round(info.footprintM2)} m² · ${info.material} ${info.use}${info.year ? ` (${info.year})` : ""} · ${info.occupants} people`
            : ` · ${info.material}`) +
          ` · burns ${info.flammability}`,
      );
    }
    for (const b of boards.at(x, y)) {
      const [i, j] = cellOf(b, x, y);
      const k = idx(b, i, j);
      lines.push(
        `board ${[main, fine, coarse].indexOf(b)} (${b.cell} cells a cell) ${i},${j}: top ${b.top[k]!.toFixed(1)} ground ${b.height[k]!.toFixed(1)}` +
          `${Number.isNaN(b.water[k]) ? "" : ` water ${b.water[k]}`}${b.flags[k]! & CELL_ROAD ? " road" : ""}${b.flags[k]! & CELL_WALL ? " walled" : ""}${b.object[k]! >= 0 ? ` object #${b.object[k]} (${Math.round(b.cover[k]! * 100)}%)` : ""}`,
      );
    }
    return lines.join("\n");
  };

  // ---------------------------------------------------------------- selection: a move range on the finest board under the click
  const select = (x: number, y: number) => {
    for (const o of overlays.values()) o.setMarks([]);
    const b = boards.at(x, y).sort((p, q) => p.cell - q.cell)[0];
    if (!b) return;
    const [si, sj] = cellOf(b, x, y);
    const steps = 4 / b.cell; // 40 m of walking, whatever the board's cells
    const climb = 3; // steps up or down a move may take
    const seen = new Map<number, number>([[idx(b, si, sj), 0]]);
    const queue: [number, number][] = [[si, sj]];
    const marks: Mark[] = [{ i: si, j: sj, kind: "select" }];
    while (queue.length) {
      const [i, j] = queue.shift()!;
      const d = seen.get(idx(b, i, j))!;
      if (d >= steps) continue;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ni = i + di;
        const nj = j + dj;
        if (!inside(b, ni, nj) || seen.has(idx(b, ni, nj))) continue;
        const k = idx(b, ni, nj);
        // units climb: onto a roof, or down from one, within the climb
        if (b.flags[k]! & CELL_WATER || Math.abs(stand(b, k) - stand(b, idx(b, i, j))) > climb) continue;
        seen.set(k, d + 1);
        queue.push([ni, nj]);
        marks.push({ i: ni, j: nj, kind: b.flags[k]! & CELL_WALL ? "info" : "move" });
      }
    }
    overlays.get(b)!.setMarks(marks);
  };

  // ---------------------------------------------------------------- edits
  /** Apply edits, timing them (the tiles they touch bake in the background). */
  const edit = (what: string, cells: CellEdit[], remove: number[] = []) => {
    const t0 = performance.now();
    if (cells.length) view.edits.cells(cells);
    if (remove.length) view.edits.remove(remove);
    say(`${what}: ${(performance.now() - t0).toFixed(1)} ms to apply\n${view.edits.version} edits so far`);
  };

  /** Burning world cells: how many turns each has burnt, and its flames. */
  const burning = new Map<string, { x: number; y: number; turns: number; fire: ReturnType<typeof effect>; smoke: ReturnType<typeof effect> }>();
  const flammability = (x: number, y: number) => {
    const s = query.surfaceAt(x + 0.5, y + 0.5);
    if (!s || s.waterLevel !== null) return 0;
    let f = FLAMMABLE_SURFACES[s.name] ?? 0;
    for (const hit of query.objectsAt(x + 0.5, y + 0.5)) {
      const o = query.object(hit.index);
      if (o) f = Math.max(f, objectInfo(o, { metersPerCell: mpc }).flammability);
    }
    return f;
  };
  const ignite = (x: number, y: number) => {
    const key = `${x},${y}`;
    if (burning.has(key) || flammability(x, y) === 0) return false;
    burning.set(key, { x, y, turns: 0, fire: effect("fire", x + 0.5, y + 0.5, 3), smoke: effect("smoke", x + 0.5, y + 0.5, 4) });
    return true;
  };
  /** Fell what stands at a point: the objects go, rubble and a blast stay. */
  const demolish = (x: number, y: number, object?: number) => {
    // what the pointer hit, else what stands at the point, else what covers most of the board cell there
    const isStructure = (h: { group: string }) => h.group.startsWith("building") || h.group.startsWith("landmark");
    let hits = query.objectsAt(x, y).filter((h) => (object !== undefined ? h.index === object : isStructure(h)));
    if (!hits.length && object === undefined)
      for (const b of boards.at(x, y)) {
        const o = b.object[idx(b, ...cellOf(b, x, y))]!;
        const at = o >= 0 ? query.object(o) : null;
        if (at?.fp?.length) hits = query.objectsAt(at.fp[0]![0], at.fp[0]![1]).filter((h) => h.index === o && isStructure(h));
        if (hits.length) break;
      }
    if (!hits.length) return say("nothing to demolish there");
    const people = hits.reduce((n, h) => n + objectInfo(query.object(h.index)!, { metersPerCell: mpc }).occupants, 0);
    edit(`demolished ${hits.map((h) => `#${h.index} ${h.group}`).join(", ")} (${people} people inside)`, [], hits.map((h) => h.index));
    for (const h of hits) {
      const [x0, y0, x1, y1] = h.bounds;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy += 1.5) for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx += 1.5) effect("rubble", xx + 0.75, yy + 0.75, 1);
      effect("blast", (x0 + x1) / 2, (y0 + y1) / 2, 4, 1.5);
    }
  };
  /** A turn: each fire spreads to its neighbours as readily as they burn, and burns out after two. */
  let turn = 0;
  const nextTurn = () => {
    turn++;
    const hash = (x: number, y: number) => (((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(turn, 83492791)) >>> 0) % 1000) / 1000;
    const now = [...burning.values()];
    for (const f of now)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = f.x + dx;
        const ny = f.y + dy;
        if (hash(nx, ny) < flammability(nx, ny)) ignite(nx, ny);
      }
    const cells: CellEdit[] = [];
    const gone = new Set<number>();
    for (const f of now) {
      if (++f.turns < 2) continue;
      burning.delete(`${f.x},${f.y}`);
      for (const e of [f.fire, f.smoke]) e.until = 0;
      const s = query.surfaceAt(f.x + 0.5, f.y + 0.5)?.name ?? "";
      if (FLAMMABLE_SURFACES[s]) cells.push({ x: f.x, y: f.y, surface: "rock" }); // scorched
      for (const hit of query.objectsAt(f.x + 0.5, f.y + 0.5)) {
        const o = query.object(hit.index);
        if (o && objectInfo(o, { metersPerCell: mpc }).flammability >= 0.4) gone.add(hit.index);
      }
    }
    if (cells.length || gone.size) edit(`turn ${turn}: ${cells.length} cells scorched, ${gone.size} objects burnt down`, cells, [...gone]);
    else say(`turn ${turn}: ${burning.size} cells burning`);
    intents();
  };
  const flood = (x: number, y: number) => {
    const level = Math.ceil(query.heightAt(x, y) ?? 0) + 1;
    const cells: CellEdit[] = [];
    const planes = !!view.world.manifest.micro?.shores; // a world without draws water where the surface says (D-147)
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const h = query.heightAt(Math.floor(x) + dx + 0.5, Math.floor(y) + dy + 0.5);
        if (h !== null && h < level && dx * dx + dy * dy <= 10)
          cells.push({ x: Math.floor(x) + dx, y: Math.floor(y) + dy, water: level, ...(planes ? {} : { surface: "water" }) });
      }
    for (const c of cells) {
      const f = burning.get(`${c.x},${c.y}`);
      if (f) {
        burning.delete(`${c.x},${c.y}`);
        f.fire.until = 0; // doused
      }
    }
    edit(`flooded ${cells.length} cells to ${level}`, cells);
  };
  const raise = (x: number, y: number) => {
    const h = (query.heightAt(x, y) ?? 0) + 3;
    edit(`raised a mound to ${h.toFixed(1)}`, [{ x: Math.floor(x), y: Math.floor(y), height: h }]);
  };

  /** Each invader's intent: an arrow to the nearest building on its board. */
  const intents = () => {
    const arrows = new Map<Board, Arrow[]>();
    for (const u of units) {
      if (!["crawler", "brute", "flyer"].includes(u.kind)) continue;
      const b = u.board;
      let best: [number, number] | null = null;
      let bd = Infinity;
      for (let j = 0; j < b.h; j++)
        for (let i = 0; i < b.w; i++) {
          const k = idx(b, i, j);
          if (!(b.flags[k]! & CELL_WALL) || b.top[k]! < b.height[k]! + 2) continue;
          const d = Math.hypot(i - u.i, j - u.j);
          if (d < bd && d * b.cell <= 6) [best, bd] = [[i, j], d];
        }
      if (best) arrows.set(b, [...(arrows.get(b) ?? []), { from: [u.i, u.j], to: best, kind: "attack" }]);
    }
    for (const [b, o] of overlays) o.setArrows(arrows.get(b) ?? []);
  };
  intents();

  // ---------------------------------------------------------------- input
  let pointer: { x: number; y: number; object?: number } | null = null;
  let down: { x: number; y: number } | null = null;
  const canvas = view.canvas;
  canvas.addEventListener("pointermove", (e) => {
    // the building drawn there, else the ground
    const object = query.pickObject(e.offsetX, e.offsetY);
    const ground = query.pick(e.offsetX, e.offsetY);
    const at = object ? { x: (object.bounds[0] + object.bounds[2]) / 2, y: (object.bounds[1] + object.bounds[3]) / 2 } : ground;
    pointer = at ? { x: at.x, y: at.y, ...(object && object.index >= 0 ? { object: object.index } : {}) } : null;
    if (pointer) status.textContent = describe(pointer.x, pointer.y);
  });
  canvas.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener("pointerup", (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4 && pointer) select(pointer.x, pointer.y);
    down = null;
  });
  let grids = true;
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "g") {
      grids = !grids;
      for (const o of overlays.values()) o.setGrid(grids);
    } else if (k === "t") nextTurn();
    const p = pointer;
    if (!p) return;
    const { x, y } = p;
    if (k === "i") say(ignite(Math.floor(x), Math.floor(y)) ? `fire at ${Math.floor(x)},${Math.floor(y)}` : "nothing there burns");
    else if (k === "x") demolish(x, y, p.object);
    else if (k === "v") flood(x, y);
    else if (k === "r") raise(x, y);
  });

  await view.ready();
  say(`${view.world.manifest.id}: boards of 1, 0.5 and 3 cells a cell; ${units.length} units`);
  return { boards, main, fine, coarse, overlays, units, ignite, demolish, flood, raise, nextTurn, select, describe, burning };
}

main().catch((e: unknown) => {
  console.error(e);
  say(`error: ${String(e)}`);
});
