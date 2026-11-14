import { cityPlugin } from "@pixelworlds/city-sf";
import { stylePack } from "@pixelworlds/game/src/styles";
import { createWorldView, fogLayer, fogSampler, veilLayer, type Controller, type ControllerView, type Entity, type EntityModel, type KeyInput, type WorldView } from "pixelworld/engine";
import { Smoothing, TickClient, joinRoom, type Room } from "../../index";
import {
  BUILDINGS,
  DELAY,
  LAYOUT,
  MAP,
  TEAMS,
  TEAM_NAMES,
  TICK,
  UNITS,
  Razed,
  buildGrid,
  cellIndex,
  placementError,
  type BuildingKind,
  type BuildingNet,
  type MapGrid,
  type PlayerNet,
  type Point,
  type RtsCommand,
  type RtsEvent,
  type RtsJoin,
  type RtsSnap,
  type RtsWorldNet,
  type SeepNet,
  type Structure,
  type Team,
  type UnitKind,
  type UnitNet,
  type Watch,
  BUILDING_EYE,
  SIGHT,
  fogCells,
  sideSight,
  type Eye,
  DAY,
  GARRISON,
  OBJECTIVE,
} from "./rules";

/**
 * Fogfront in the page (D-121): San Francisco's driving level at the
 * Presidio, a room on `/rts?room=` run by the server (server.ts). The page
 * predicts nothing and sends no inputs: it sends orders (`TickClient.command`,
 * numbered) and puts the newest snapshot of what its side sees in place each
 * frame (`sync`). Units are entities drawn a little behind on the server's
 * clock (`Smoothing`), buildings and seeps entities where they stand, all
 * built from boxes in the side's colours. An order shows at once (a marker,
 * and lines to where the units go) and holds until a snapshot says it was
 * taken (`cmd`). The level's buildings knocked down in the match (the shared
 * snapshot's `razed`) are taken out of the view (`view.edits`, D-124), which
 * bakes their tiles again, and rubble is left where each stood.
 *
 * Two to a side (D-127), the snapshot is the side's, shared with a teammate
 * who orders the same units from the same glim; the board names them. A page
 * that watches (`watch`) orders nothing and draws what the side it watches
 * sees, veiled as that side's own page would, or everything, unveiled.
 *
 * Mouse: left click or drag selects (`query.pick` for the ground, the units
 * where they are drawn, `query.pickObject` for the level's buildings), right
 * click orders (move; attack what's under it, or knock down a building;
 * runners to a seep), middle drag pans, the wheel zooms. Keys: WASD or
 * arrows pan, Q/E turn the view, F then a click fights its way there, X
 * stops, R trains a runner, B places a lodge, T trains a warden, Esc cancels.
 */

const PAN = 260; // internal px a second
const pickRadius = 18; // CSS px round a unit's middle

/** The camera: keys and a middle drag pan it over the play area, Q/E turn it, the wheel zooms. */
class RtsCamera implements Controller {
  readonly id = "rts-camera";
  private view: ControllerView | null = null;
  private readonly keys = new Set<string>();

  attach(view: ControllerView): void {
    this.view = view;
  }

  detach(): void {
    this.view = null;
  }

  update(dt: number, clock: { realDt: number }): void {
    const v = this.view;
    if (!v) return;
    let px = 0;
    let py = 0;
    if (this.keys.has("a") || this.keys.has("arrowleft")) px -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) px += 1;
    if (this.keys.has("w") || this.keys.has("arrowup")) py -= 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) py += 1;
    const step = PAN * (dt || clock.realDt);
    if (px || py) this.pan(px * step, py * step);
  }

  /** Pan by internal pixels, kept over the play area. */
  pan(dx: number, dy: number): void {
    const v = this.view;
    if (!v) return;
    v.camera.pan(dx, dy);
    const c = v.camera;
    const x = Math.min(MAP.x0 + MAP.w, Math.max(MAP.x0, c.x));
    const y = Math.min(MAP.y0 + MAP.h, Math.max(MAP.y0, c.y));
    if (x !== c.x || y !== c.y) c.setFocus(x, y, v.query.heightAt(x, y) ?? c.h);
  }

  keyDown(e: KeyInput): boolean {
    const v = this.view;
    if (!v) return false;
    const k = e.key.toLowerCase();
    if (k === "q") v.camera.rotate(-1);
    else if (k === "e") v.camera.rotate(1);
    else if (k === "+" || k === "=") v.camera.zoom = Math.min(6, v.camera.zoom + 1);
    else if (k === "-") v.camera.zoom = Math.max(1, v.camera.zoom - 1);
    else if ("wasd".includes(k) || k.startsWith("arrow")) {
      this.keys.add(k);
      e.preventDefault?.();
    } else return false;
    return true;
  }

  keyUp(e: KeyInput): void {
    this.keys.delete(e.key.toLowerCase());
  }

  blur(): void {
    this.keys.clear();
  }
}

// ---------------------------------------------------------------- the models

type Boxes = Extract<EntityModel, { boxes: unknown }>["boxes"];
type Ramps = (name: string) => number;

const cube = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, ramp: number) => ({ x0, y0, z0, x1, y1, z1, ramp });

/** The sides' colours: the Kiln's ember red, the Tide's slate blue. */
const SIDE_RAMP: Record<Team, string> = { kiln: "marker", tide: "paint-slate" };

/** Units drawn this much bigger than their boxes below: a 25 m cell is wide for a person, and they should read at a glance. */
const UNIT_SCALE = 1.4;

function unitBoxes(kind: UnitKind, side: Team, carrying: boolean, r: Ramps): Boxes {
  const k = UNIT_SCALE;
  return unitShape(kind, side, carrying, r).map((b) => ({ ...b, x0: b.x0 * k, y0: b.y0 * k, z0: b.z0 * k, x1: b.x1 * k, y1: b.y1 * k, z1: b.z1 * k }));
}

function unitShape(kind: UnitKind, side: Team, carrying: boolean, r: Ramps): Boxes {
  const c = r(SIDE_RAMP[side]);
  if (kind === "runner")
    return [
      cube(-0.14, -0.14, 0, 0.14, 0.14, 1.0, c),
      cube(-0.1, -0.1, 1.0, 0.1, 0.1, 1.35, r("paint-salmon")),
      cube(-0.3, -0.13, 0.4, -0.14, 0.13, 1.05, r(carrying ? "tower-gold" : "bark")),
    ];
  return [
    cube(-0.17, -0.17, 0, 0.17, 0.17, 1.3, c),
    cube(-0.12, -0.12, 1.3, 0.12, 0.12, 1.7, r("concrete")),
    cube(0.17, -0.22, 0.3, 0.25, 0.04, 1.2, c),
    cube(0.12, 0.14, 0.1, 0.19, 0.21, 2.6, r("bark")),
    cube(0.11, 0.13, 2.6, 0.2, 0.22, 2.9, r("concrete")),
  ];
}

function buildingBoxes(kind: BuildingKind, side: Team, built: boolean, r: Ramps, ok = true): Boxes {
  const c = ok ? r(SIDE_RAMP[side]) : r("marker");
  const s = BUILDINGS[kind].size / 2;
  if (!built) {
    const post = (x: number, y: number) => cube(x - 0.1, y - 0.1, 0.3, x + 0.1, y + 0.1, 1.6, c);
    const e = s * 0.85;
    return [cube(-e, -e, 0, e, e, 0.3, r("concrete")), post(-e + 0.1, -e + 0.1), post(e - 0.1, -e + 0.1), post(-e + 0.1, e - 0.1), post(e - 0.1, e - 0.1)];
  }
  if (kind === "hearth")
    return [
      cube(-1.3, -1.3, 0, 1.3, 1.3, 2.4, r("concrete")),
      cube(-1.4, -1.4, 2.4, 1.4, 1.4, 3.0, c),
      cube(-0.45, -0.45, 3.0, 0.45, 0.45, 5.4, c),
      cube(-0.3, -0.3, 5.4, 0.3, 0.3, 6.2, r("tower-gold")),
    ];
  return [
    cube(-0.85, -0.85, 0, 0.85, 0.85, 1.9, ok ? r("bark") : c),
    cube(-0.95, -0.95, 1.9, 0.95, 0.95, 2.5, c),
    cube(0.55, 0.55, 2.5, 0.65, 0.65, 4.2, r("concrete")),
    cube(0.65, 0.58, 3.5, 1.1, 0.62, 4.1, c),
  ];
}

/** What is left of one of the level's buildings: a slab and a heap on each cell it walled (cells from its middle). */
const rubbleBoxes = (s: Structure, g: MapGrid, r: Ramps): Boxes =>
  s.cells.flatMap((i, n) => {
    const x = (i % g.w) + g.x0 + 0.5 - s.x;
    const y = Math.floor(i / g.w) + g.y0 + 0.5 - s.y;
    const k = ((n * 7) % 5) / 10;
    return [cube(x - 0.42, y - 0.42, 0, x + 0.42, y + 0.42, 0.15, r("concrete")), cube(x - 0.25 + k * 0.3, y - 0.2, 0.15, x + 0.05 + k * 0.3, y + 0.2, 0.35 + k, r("bark"))];
  });

const seepBoxes = (r: Ramps): Boxes => {
  const g = r("tower-gold");
  return [cube(-0.32, -0.2, 0, -0.02, 0.1, 1.4, g), cube(0.0, -0.28, 0, 0.26, -0.02, 0.9, g), cube(-0.12, 0.06, 0, 0.2, 0.32, 1.1, g)];
};

// ---------------------------------------------------------------- the page

interface Drawn {
  e: Entity;
  key: string;
}

export interface RtsOptions {
  canvas: HTMLCanvasElement;
  room: string;
  name?: string | null;
  vs?: "any" | "bot";
  /** Players a side, 1 or 2, and the side to play (D-127); or to watch rather than play: a side, as it sees, or all. */
  size?: 1 | 2;
  side?: Team;
  watch?: Watch;
  /** The rooms' WebSocket path (default /rts). */
  path?: string;
  /** Where the level is served (default `RTS_WORLD`). */
  worldUrl: string;
}

export async function startRts(opts: RtsOptions): Promise<void> {
  const camera = new RtsCamera();
  const home = LAYOUT.hearths.kiln;
  // the fog of war (D-125): what the side doesn't see darkened, what it has never seen darker
  const veil = veilLayer({ id: "sight", label: "Fog of war", ramp: "asphalt", shade: 1, levels: [0.3, 0.55, 0.8] });
  // the Golden Gate's fog, on the server's clock: what stands in it is hidden as the server reckons it
  const weather = fogLayer({ paused: true });
  const view: WorldView = await createWorldView({
    canvas: opts.canvas,
    worldUrl: opts.worldUrl,
    style: stylePack,
    plugins: [cityPlugin],
    cache: true,
    startTiles: false, // none baked for this level
    camera: { x: home[0] + 1.5, y: home[1] + 1.5, zoom: 2 },
    controller: camera,
    layers: [veil, weather],
  });
  const hud = makeHud();
  hud.status("joining…");
  let room: Room;
  try {
    room = await joinRoom(opts.path ?? "/rts", opts.room);
  } catch (e) {
    hud.status(`Fogfront: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  await view.query.ensure(MAP.x0, MAP.y0, MAP.x0 + MAP.w, MAP.y0 + MAP.h);
  /** The play area's cells, for placing a lodge: the server's own check, here before sending. */
  const grid: MapGrid = buildGrid(view.query);
  const structures = grid.structures!;
  /** The level's buildings knocked down: out of the view's world and the page's cells, rubble where each stood. */
  const razed = new Razed(view.edits, grid);
  const rubble = new Map<number, Entity>();
  const fog = fogSampler(view.world, view.query);

  const ramp: Ramps = (name) => view.world.palette.rampIds.get(name) ?? 0;
  const now = () => performance.now() / 1000;

  let snap: (RtsSnap & { t: number; cmd?: number }) | null = null;
  let world: (RtsWorldNet & { t: number }) | null = null;
  /** The side this page plays (null for a spectator), and the side its snapshot is of: its own, the one it watches, or `all`. */
  let side: Team | null = null;
  let shows: Watch | null = null;
  const units = new Map<number, UnitNet>();

  const client: TickClient<never, RtsSnap, RtsWorldNet, RtsEvent> = new TickClient(room, {
    tick: TICK,
    delay: DELAY,
    restore: (s) => takeSnap(s),
    onWorld: (w) => takeWorld(w),
  });
  /** The units, drawn `DELAY` behind on the server's clock, as the events wait for it. */
  const smoothing = new Smoothing(DELAY, client.clock);
  client.hello({ name: (opts.name || "Commander").slice(0, 20), vs: opts.vs ?? "any", size: opts.size ?? 1, ...(opts.side ? { side: opts.side } : {}), ...(opts.watch ? { watch: opts.watch } : {}) } satisfies RtsJoin);

  // ---------------------------------------------------------------- what the side sees

  const unitsDrawn = new Map<number, Drawn>();
  const buildingsDrawn = new Map<number, Drawn & { net: BuildingNet }>();
  const seepsDrawn = new Map<number, Drawn & { net: SeepNet }>();
  /** Orders sent and not yet in a snapshot: their number, units and where they go. */
  const pending = new Map<number, { units: number[]; to: Point }>();
  const selection = new Set<number>();
  /** A building or a foe picked: its health (one's own building: its queue) on the HUD. */
  let picked: number | null = null;
  /** One of the level's buildings picked (its object). */
  let pickedStructure: number | null = null;

  /** The shared snapshot: the match, who plays, and the level's buildings knocked down (each new one goes in a puff). */
  function takeWorld(w: RtsWorldNet & { t: number }): void {
    const first = world === null;
    world = w;
    const list = w.razed ?? [];
    for (const obj of razed.sync(list)) {
      const s = structures.get(obj);
      if (s && !first) effect(dustBoxes, "rts.dust", s.x, s.y, 1.2, 0);
    }
    const now = new Set(list);
    for (const [obj, e] of rubble)
      if (!now.has(obj)) {
        e.remove();
        rubble.delete(obj);
      }
    for (const obj of list) {
      const s = structures.get(obj);
      if (s && !rubble.has(obj)) rubble.set(obj, view.entities.add({ model: { boxes: rubbleBoxes(s, grid, ramp), key: `rts.rubble.${obj}` }, x: s.x, y: s.y, headings: 1, wait: false }));
    }
    if (pickedStructure !== null && now.has(pickedStructure)) pickedStructure = null;
  }

  function takeSnap(s: RtsSnap & { t: number; cmd?: number }): void {
    const first = shows === null;
    snap = s;
    shows = s.side;
    if (!opts.watch) side = s.side as Team;
    if (first) {
      const [x, y] = shows === "all" ? [MAP.x0 + MAP.w / 2 - 1.5, MAP.y0 + MAP.h / 2 - 1.5] : LAYOUT.hearths[shows];
      void view.camera.lookAt({ x: x + 1.5, y: y + 1.5 });
    }
    for (const n of [...pending.keys()]) if ((s.cmd ?? 0) >= n) pending.delete(n);
    const seen = new Set<number>();
    for (const u of s.units) {
      seen.add(u.i);
      units.set(u.i, u);
      smoothing.push(String(u.i), s.t, { x: u.x, y: u.y, h: view.query.heightAt(u.x, u.y) ?? 0, heading: u.d }, now());
    }
    for (const id of [...units.keys()])
      if (!seen.has(id)) {
        units.delete(id);
        smoothing.delete(String(id));
        unitsDrawn.get(id)?.e.remove();
        unitsDrawn.delete(id);
        selection.delete(id);
      }
    // buildings and seeps where they stand; the grid knows the buildings, for placing
    grid.building.fill(0);
    const here = new Set<number>();
    for (const b of s.buildings) {
      here.add(b.i);
      const key = `rts.${b.k}.${b.s}.${b.b >= 1 ? "up" : "rising"}`;
      let d = buildingsDrawn.get(b.i);
      if (d?.key !== key) {
        d?.e.remove();
        const size = BUILDINGS[b.k].size;
        d = { e: view.entities.add({ model: { boxes: buildingBoxes(b.k, b.s, b.b >= 1, ramp), key }, x: b.x + size / 2, y: b.y + size / 2, headings: 1, wait: false }), key, net: b };
        buildingsDrawn.set(b.i, d);
      }
      d.net = b;
      for (let dy = 0; dy < BUILDINGS[b.k].size; dy++)
        for (let dx = 0; dx < BUILDINGS[b.k].size; dx++) {
          const i = cellIndex(grid, b.x + dx, b.y + dy);
          if (i >= 0) grid.building[i] = b.i;
        }
    }
    for (const [id, d] of buildingsDrawn)
      if (!here.has(id)) {
        d.e.remove();
        buildingsDrawn.delete(id);
        if (picked === id) picked = null;
      }
    // seeps with glim; a new match's are new ones
    const wet = new Set(s.seeps.filter((sp) => sp.left > 0).map((sp) => sp.i));
    for (const [id, d] of seepsDrawn)
      if (!wet.has(id)) {
        d.e.remove();
        seepsDrawn.delete(id);
      }
    for (const sp of s.seeps) {
      if (!wet.has(sp.i)) continue;
      let d = seepsDrawn.get(sp.i);
      d ??= { e: view.entities.add({ model: { boxes: seepBoxes(ramp), key: "rts.seep" }, x: sp.x, y: sp.y, headings: 1, wait: false }), key: "rts.seep", net: sp };
      d.net = sp;
      seepsDrawn.set(sp.i, d);
    }
  }

  /** Units where they are drawn now: each frame, their entities moved there (a new one, or a runner's load changed: a new model). */
  function drawUnits(t: number): void {
    for (const [id, u] of units) {
      const p = smoothing.at(String(id), t);
      if (!p) continue;
      // inside one of the level's buildings: not drawn (a count over it)
      if (u.in !== undefined) {
        unitsDrawn.get(id)?.e.remove();
        unitsDrawn.delete(id);
        selection.delete(id);
        continue;
      }
      const key = `rts.${u.k}.${u.s}${u.c ? ".laden" : ""}`;
      let d = unitsDrawn.get(id);
      if (d?.key !== key) {
        d?.e.remove();
        // through woods and behind buildings: a silhouette in its side's colour
        d = {
          e: view.entities.add({ model: { boxes: unitBoxes(u.k, u.s, !!u.c, ramp), key }, x: p.x, y: p.y, h: p.h, heading: p.heading, silhouette: true, silhouetteRamp: ramp(SIDE_RAMP[u.s]), wait: false }),
          key,
        };
        unitsDrawn.set(id, d);
      }
      d.e.moveTo(p.x, p.y, p.h);
      d.e.heading = p.heading;
    }
  }

  // ---------------------------------------------------------------- selecting and ordering

  let placing: BuildingKind | null = null;
  let fightMove = false;
  /** G pressed: the next click names a building to go into. */
  let garrisoning = false;
  let drag: { x: number; y: number; at: Point } | null = null;
  let pointer: Point = { x: 0, y: 0 };
  let ghost: Drawn | null = null;
  let ghostAt: { x: number; y: number; why: string | null } | null = null;
  const markers: { at: Point; kind: "move" | "attack" | "gather"; life: number }[] = [];

  const mine = (u: UnitNet | undefined) => !!u && u.s === side;
  /** The unit drawn nearest a point on the canvas, within `pickRadius`. */
  function unitAt(sx: number, sy: number, filter: (u: UnitNet) => boolean): UnitNet | null {
    let best: UnitNet | null = null;
    let bestD = pickRadius;
    for (const [id, d] of unitsDrawn) {
      const u = units.get(id);
      if (!u || !filter(u)) continue;
      const p = view.camera.project(d.e.x, d.e.y, d.e.h + 1);
      const dist = Math.hypot(p.x - sx, p.y - sy);
      if (dist < bestD) [best, bestD] = [u, dist];
    }
    return best;
  }
  /** The level's building drawn under a point on the canvas, standing. */
  const structureAt = (sx: number, sy: number): Structure | null => {
    const o = view.query.pickObject(sx, sy);
    return (o && structures.get(o.index)) ?? null;
  };
  const buildingAt = (p: Point): BuildingNet | null => {
    for (const d of buildingsDrawn.values()) {
      const b = d.net;
      const size = BUILDINGS[b.k].size;
      if (p.x >= b.x - 0.3 && p.y >= b.y - 0.3 && p.x < b.x + size + 0.3 && p.y < b.y + size + 0.3) return b;
    }
    return null;
  };

  /** An order to the server, shown at once. */
  function order(c: RtsCommand, mark?: { at: Point; kind: "move" | "attack" | "gather" }): number {
    const n = client.command(c);
    if (mark) {
      markers.push({ ...mark, life: 0.7 });
      if ("u" in c) pending.set(n, { units: c.u, to: mark.at });
    }
    return n;
  }

  function select(sx: number, sy: number, add: boolean): void {
    if (!add) selection.clear();
    picked = null;
    pickedStructure = null;
    const u = unitAt(sx, sy, () => true);
    if (u) {
      if (mine(u)) selection.add(u.i);
      else picked = u.i;
      return;
    }
    const hit = view.query.pick(sx, sy);
    const b = hit && buildingAt(hit);
    if (b) picked = b.i;
    else pickedStructure = structureAt(sx, sy)?.obj ?? null;
  }

  function selectBox(a: Point, b: Point, add: boolean): void {
    if (!add) selection.clear();
    picked = null;
    const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
    const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    for (const [id, d] of unitsDrawn) {
      if (!mine(units.get(id))) continue;
      const p = view.camera.project(d.e.x, d.e.y, d.e.h + 0.5);
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) selection.add(id);
    }
  }

  /** A right click: attack what's there, runners to a seep, or move. */
  function command(sx: number, sy: number, attack = false): void {
    const ids = [...selection].filter((id) => mine(units.get(id)));
    if (!ids.length) return;
    const foe = unitAt(sx, sy, (u) => u.s !== side);
    const hit = view.query.pick(sx, sy);
    if (foe) return void order({ t: "attack", u: ids, target: foe.i }, { at: { x: foe.x, y: foe.y }, kind: "attack" });
    if (!hit) return;
    const b = buildingAt(hit);
    if (b && b.s !== side) return void order({ t: "attack", u: ids, target: b.i }, { at: hit, kind: "attack" });
    // one of the level's buildings: wardens knock it down; runners alone go in (D-125)
    const wardens = ids.filter((id) => units.get(id)?.k === "warden");
    const structure = structureAt(sx, sy);
    if (structure && wardens.length) return void order({ t: "raze", u: wardens, obj: structure.obj }, { at: structure, kind: "attack" });
    if (structure) return void order({ t: "enter", u: ids, obj: structure.obj }, { at: structure, kind: "move" });
    const seep = [...seepsDrawn.values()].find((d) => Math.hypot(d.net.x - hit.x, d.net.y - hit.y) < 1.2);
    const runners = ids.filter((id) => units.get(id)?.k === "runner");
    if (seep && runners.length) {
      order({ t: "gather", u: runners, seep: seep.net.i }, { at: { x: seep.net.x, y: seep.net.y }, kind: "gather" });
      const rest = ids.filter((id) => !runners.includes(id));
      if (rest.length) order({ t: "move", u: rest, x: hit.x, y: hit.y }, { at: hit, kind: "move" });
      return;
    }
    order({ t: "move", u: ids, x: hit.x, y: hit.y, attack }, { at: hit, kind: attack ? "attack" : "move" });
  }

  const own = (kind: BuildingKind) => (snap?.buildings ?? []).filter((b) => b.s === side && b.k === kind);
  const train = (kind: BuildingKind) => {
    if (!side) return;
    const at = own(kind)
      .filter((b) => b.b >= 1)
      .sort((a, b) => (a.q ?? 0) - (b.q ?? 0))[0];
    if (!at) return hud.say(kind === "lodge" ? "Raise a lodge first (B)" : "Your hearth has fallen");
    order({ t: "train", b: at.i });
  };
  const startPlacing = () => {
    if (!side) return;
    placing = "lodge";
    fightMove = false;
    hud.say("Click to place a lodge · Esc to cancel", 2);
  };
  const stopPlacing = () => {
    placing = null;
    ghost?.e.remove();
    ghost = null;
    ghostAt = null;
  };

  // ---------------------------------------------------------------- input

  const canvas = view.canvas;
  let panning: Point | null = null;
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    const at = { x: e.offsetX, y: e.offsetY };
    if (e.button === 1) {
      panning = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button === 2) {
      if (placing) stopPlacing();
      else command(at.x, at.y);
      return;
    }
    if (e.button !== 0) return;
    if (placing) {
      if (ghostAt?.why === null) {
        order({ t: "build", kind: placing, x: ghostAt.x, y: ghostAt.y });
        if (!e.shiftKey) stopPlacing();
      } else if (ghostAt) hud.say(`Can't build there: ${ghostAt.why}`, 1.5);
      return;
    }
    if (fightMove) {
      fightMove = false;
      command(at.x, at.y, true);
      return;
    }
    if (garrisoning) {
      garrisoning = false;
      const structure = structureAt(at.x, at.y);
      const ids = [...selection].filter((id) => mine(units.get(id)));
      if (structure && ids.length) order({ t: "enter", u: ids, obj: structure.obj }, { at: structure, kind: "move" });
      else hud.say("Click one of the level's buildings to go in", 1.5);
      return;
    }
    drag = { x: at.x, y: at.y, at };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    pointer = { x: e.offsetX, y: e.offsetY };
    if (panning) {
      const scale = view.pixelRatio / view.camera.zoom;
      camera.pan(-(e.clientX - panning.x) * scale, -(e.clientY - panning.y) * scale);
      panning = { x: e.clientX, y: e.clientY };
    }
  });
  canvas.addEventListener("pointerup", (e) => {
    if (e.button === 1) panning = null;
    if (e.button !== 0 || !drag) return;
    const end = { x: e.offsetX, y: e.offsetY };
    if (Math.hypot(end.x - drag.x, end.y - drag.y) < 5) select(end.x, end.y, e.shiftKey);
    else selectBox(drag, end, e.shiftKey);
    drag = null;
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    view.camera.zoom = Math.min(6, Math.max(1, view.camera.zoom + (e.deltaY < 0 ? 1 : -1)));
  });
  window.addEventListener("keydown", (e) => {
    if (camera.keyDown(e)) return;
    const k = e.key.toLowerCase();
    if (k === "escape") {
      stopPlacing();
      fightMove = false;
      garrisoning = false;
      selection.clear();
    } else if (k === "f" && selection.size) {
      fightMove = true;
      hud.say("Click where to fight to", 1.5);
    } else if (k === "g" && selection.size) {
      garrisoning = true;
      hud.say("Click a building to go into it", 1.5);
    } else if (k === "u") {
      // out of the building under the pointer
      const structure = structureAt(pointer.x, pointer.y);
      if (structure) order({ t: "leave", obj: structure.obj });
    } else if (k === "x" && selection.size) order({ t: "stop", u: [...selection] });
    else if (k === "r") train("hearth");
    else if (k === "t") train("lodge");
    else if (k === "b") startPlacing();
  });
  window.addEventListener("keyup", (e) => camera.keyUp(e));
  window.addEventListener("blur", () => camera.blur());
  hud.onButton = (what) => (what === "runner" ? train("hearth") : what === "warden" ? train("lodge") : startPlacing());

  // ---------------------------------------------------------------- the server's word

  const sparks: { e: Entity; life: number }[] = [];
  function effect(boxes: Boxes, key: string, x: number, y: number, life: number, rise = 0.8): void {
    sparks.push({ e: view.entities.add({ model: { boxes, key }, x, y, h: (view.query.heightAt(x, y) ?? 0) + rise, headings: 1, wait: false }), life });
  }
  const hitBoxes = [cube(-0.08, -0.08, 0, 0.08, 0.08, 0.3, ramp("tower-gold"))];
  const puffBoxes = [cube(-0.3, -0.3, 0, 0.3, 0.3, 1.0, ramp("marker")), cube(-0.2, -0.2, 1.0, 0.25, 0.2, 1.8, ramp("concrete"))];
  const dustBoxes = [cube(-0.8, -0.8, 0, 0.8, 0.8, 1.2, ramp("concrete")), cube(-0.5, -0.6, 1.2, 0.6, 0.5, 2.4, ramp("concrete"))];
  const nameOf = (s: Team | null) =>
    s
      ? world?.players
          .filter((p) => p.side === s)
          .map((p) => p.name)
          .join(" & ") || TEAM_NAMES[s]
      : "nobody";
  const play = (e: RtsEvent) => {
    if (e.kind === "hit") effect(hitBoxes, "rts.hit", e.x, e.y, 0.2);
    else if (e.kind === "die") effect(puffBoxes, "rts.puff", e.x, e.y, 0.6);
    else if (e.kind === "refused") hud.say(`Can't: ${e.why}`, 2);
    else if (e.kind === "taken") hud.say(e.side === side ? `You hold ${e.name}` : `${nameOf(e.side)} took ${e.name}`, 3);
    else if (e.phase === "playing") hud.say("The match is on: gather glim, raise a lodge, take their hearth", 4);
    else if (!side) hud.say(e.winner ? `${nameOf(e.winner)} win` : "The match ran out of time", 8);
    else hud.say(e.winner ? (e.winner === side ? "Their hearth has fallen: you win!" : `Your hearth has fallen: ${nameOf(e.winner)} wins`) : "The match ran out of time", 8);
  };
  /** Why the room let the page go (sent away, the room closed, the server gone): the board says it from then on. */
  let closed: string | null = null;
  room.onClose = (why) => (closed = `Fogfront: ${why ?? "the server went away"}`);

  // ---------------------------------------------------------------- each frame

  // ---------------------------------------------------------------- what the side sees (D-125)

  /** Each cell's distance to the nearest eye of the side that sees it; whether it has ever been seen; the veil over it. */
  const sight = new Float32Array(grid.flags.length);
  const explored = new Uint8Array(grid.flags.length);
  const veiled = new Uint8Array(grid.flags.length);
  let fogCover: Float32Array | null = null;
  let sightAt = -Infinity;
  let fogAt = -Infinity;
  let matchSeen: number | null = null;

  /** The fog on the server's clock each frame; the side's sight, as the server works it out, four times a second; the veil from it. */
  function see(t: number): void {
    const shown = client.seen(t);
    if (shown !== null && Math.abs(shown - weather.time) > 1 / 12) weather.set({ time: shown });
    // night falls (the style's night palette: lit windows), and day breaks
    const night = world?.night ?? false;
    if (view.palette !== (night ? "night" : "day")) view.palette = night ? "night" : "day";
    if (!snap || !shows || t - sightAt < 0.25) return;
    sightAt = t;
    // watching all: nothing veiled
    if (shows === "all") return veil.set(MAP, veiled.fill(0));
    const who = shows;
    // a new match: nothing seen yet
    if (world && world.match.phase === "playing" && matchSeen !== world.match.until) {
      matchSeen = world.match.until;
      explored.fill(0);
    }
    if (fog && shown !== null && t - fogAt > 2) {
      fogCover = fogCells(grid, (x, y, h) => fog.at(x, y, h, shown, night), fogCover ?? undefined);
      fogAt = t;
    }
    const dark = night ? DAY.sight : 1;
    const eyes: Eye[] = [];
    for (const u of snap.units) {
      if (u.s !== who) continue;
      const s = u.in === undefined ? undefined : structures.get(u.in);
      if (s) eyes.push({ x: s.x, y: s.y, up: Math.max(SIGHT.eye, s.top - (view.query.heightAt(s.x, s.y) ?? 0) + 0.5), radius: (UNITS[u.k].sight + GARRISON.sight) * dark });
      else eyes.push({ x: u.x, y: u.y, up: SIGHT.eye, radius: UNITS[u.k].sight * dark });
    }
    for (const m of world?.marks ?? []) if (m.owner === who) eyes.push({ x: m.x, y: m.y, up: OBJECTIVE.eye, radius: OBJECTIVE.sight });
    for (const b of snap.buildings)
      if (b.s === who) eyes.push({ x: b.x + BUILDINGS[b.k].size / 2, y: b.y + BUILDINGS[b.k].size / 2, up: BUILDING_EYE[b.k] * Math.max(0.3, b.b), radius: BUILDINGS[b.k].sight });
    sideSight(grid, eyes, fogCover, sight);
    for (let i = 0; i < sight.length; i++) {
      if (sight[i]! < Infinity) explored[i] = 1;
      veiled[i] = sight[i]! < Infinity ? 0 : explored[i] ? 150 : 255;
    }
    veil.set(MAP, veiled);
  }

  view.onFrame(({ realDt }) => {
    const t = now();
    client.sync();
    see(t);
    drawUnits(t);
    for (const e of client.due(t)) play(e);
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i]!;
      s.life -= realDt;
      if (s.life <= 0) {
        s.e.remove();
        sparks.splice(i, 1);
      }
    }
    for (let i = markers.length - 1; i >= 0; i--) if ((markers[i]!.life -= realDt) <= 0) markers.splice(i, 1);
    if (placing && side) placeGhost();
    hud.draw(overlay(), text(t), buttons());
  });

  /** The lodge to be: where the pointer is, coloured by whether it can go there. */
  function placeGhost(): void {
    const hit = view.query.pick(pointer.x, pointer.y);
    if (!hit || !side) return;
    const size = BUILDINGS[placing!].size;
    const x = Math.round(hit.x - size / 2);
    const y = Math.round(hit.y - size / 2);
    const s = snap!;
    const why = placementError(grid, placing!, x, y, {
      own: s.buildings.filter((b) => b.s === side).map((b) => ({ x: b.x, y: b.y, size: BUILDINGS[b.k].size })),
      units: s.units,
      seeps: s.seeps.filter((p) => p.left > 0),
    });
    ghostAt = { x, y, why };
    const key = `rts.ghost.${placing}.${side}.${why === null}`;
    if (ghost?.key !== key) {
      ghost?.e.remove();
      ghost = { e: view.entities.add({ model: { boxes: buildingBoxes(placing!, side, true, ramp, why === null), key }, x: x + size / 2, y: y + size / 2, headings: 1, silhouette: true, wait: false }), key };
    }
    ghost.e.moveTo(x + size / 2, y + size / 2);
  }

  /** The SVG over the canvas: selection rings, health, where units go, order markers, the drag box. */
  function overlay(): string {
    const out: string[] = [];
    const ring = (x: number, y: number, h: number, r: number, color: string) => {
      const p = view.camera.project(x, y, h);
      if (p.onScreen) out.push(`<ellipse cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" rx="${r}" ry="${r / 2}" fill="none" stroke="${color}" stroke-width="1.5"/>`);
      return p;
    };
    const bar = (p: Point, frac: number, w: number) =>
      out.push(
        `<rect x="${(p.x - w / 2).toFixed(1)}" y="${(p.y - 4).toFixed(1)}" width="${w}" height="3" fill="#200"/><rect x="${(p.x - w / 2).toFixed(1)}" y="${(p.y - 4).toFixed(1)}" width="${(w * Math.max(0, frac)).toFixed(1)}" height="3" fill="${frac > 0.5 ? "#6c6" : frac > 0.25 ? "#dc5" : "#e54"}"/>`,
      );
    const goals = new Map<number, Point>();
    for (const { units: ids, to } of pending.values()) for (const id of ids) goals.set(id, to);
    for (const [id, d] of unitsDrawn) {
      const u = units.get(id)!;
      const chosen = selection.has(id) || picked === id;
      const hurt = u.hp < UNITS[u.k].hp;
      if (chosen) {
        const p = ring(d.e.x, d.e.y, d.e.h, 11, mine(u) ? "#8f8" : "#f66");
        const goal = goals.get(id) ?? (u.g ? { x: u.g[0], y: u.g[1] } : null);
        if (goal && mine(u)) {
          const g = view.camera.project(goal.x, goal.y);
          if (g) out.push(`<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${g.x.toFixed(1)}" y2="${g.y.toFixed(1)}" stroke="#8f8" stroke-opacity="0.45" stroke-dasharray="3 3"/>`);
        }
      }
      if (chosen || hurt) bar(view.camera.project(d.e.x, d.e.y, d.e.h + 3.4), u.hp / UNITS[u.k].hp, 18);
    }
    for (const d of buildingsDrawn.values()) {
      const b = d.net;
      const size = BUILDINGS[b.k].size;
      const top = view.camera.project(b.x + size / 2, b.y + size / 2, (view.query.heightAt(b.x + size / 2, b.y + size / 2) ?? 0) + (b.k === "hearth" ? 6.6 : 4.4));
      if (picked === b.i) ring(b.x + size / 2, b.y + size / 2, view.query.heightAt(b.x + size / 2, b.y + size / 2) ?? 0, size * 14, b.s === side ? "#8f8" : "#f66");
      if (picked === b.i || b.hp < BUILDINGS[b.k].hp || b.b < 1) bar(top, b.hp / BUILDINGS[b.k].hp, size * 12);
    }
    // the level's buildings knocked about, and the one picked
    const hurt = new Map(snap?.hurt ?? []);
    for (const obj of new Set([...hurt.keys(), ...(pickedStructure !== null ? [pickedStructure] : [])])) {
      const s = structures.get(obj);
      if (!s) continue;
      const r = Math.sqrt(s.cells.length);
      if (obj === pickedStructure) ring(s.x, s.y, view.query.heightAt(s.x, s.y) ?? 0, r * 14, "#fd6");
      bar(view.camera.project(s.x, s.y, s.top + 0.6), (hurt.get(obj) ?? s.hp) / s.hp, Math.max(18, r * 12));
    }
    // the landmarks to hold: a diamond in the holder's colour, the taking as a ring filling (D-125)
    const colour = (t: Team | null) => (t === "kiln" ? "#e6553a" : t === "tide" ? "#8aa4d6" : "#c4c3c3");
    for (const m of world?.marks ?? []) {
      const p = view.camera.project(m.x, m.y, (view.query.heightAt(m.x, m.y) ?? 0) + 2);
      if (!p.onScreen) continue;
      const [x, y] = [p.x.toFixed(1), p.y.toFixed(1)];
      out.push(`<path d="M${x} ${p.y - 9}L${p.x + 7} ${y}L${x} ${p.y + 9}L${p.x - 7} ${y}Z" fill="${colour(m.owner)}" stroke="#222" stroke-width="1"/>`);
      if (m.taker && m.p > 0) {
        const r = 12;
        const len = 2 * Math.PI * r;
        out.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${colour(m.taker)}" stroke-width="2.5" stroke-dasharray="${(len * m.p).toFixed(1)} ${len.toFixed(1)}" transform="rotate(-90 ${x} ${y})"/>`);
      }
    }
    // the units in the level's buildings that the snapshot has (its side's; watching all, both): a count over each, in their side's colour
    const inside = new Map<number, { n: number; s: Team }>();
    for (const u of units.values()) if (u.in !== undefined) inside.set(u.in, { n: (inside.get(u.in)?.n ?? 0) + 1, s: u.s });
    for (const [obj, { n, s: by }] of inside) {
      const s = structures.get(obj);
      if (!s) continue;
      const p = view.camera.project(s.x, s.y, s.top + 1);
      if (!p.onScreen) continue;
      out.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="8" fill="${by === "kiln" ? "#c0302d" : "#3e5c9a"}" stroke="#fff" stroke-width="1"/><text x="${p.x.toFixed(1)}" y="${(p.y + 4).toFixed(1)}" text-anchor="middle" fill="#fff">${n}</text>`);
    }
    for (const m of markers) {
      const p = view.camera.project(m.at.x, m.at.y);
      if (p) out.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(4 + (0.7 - m.life) * 14).toFixed(1)}" fill="none" stroke="${m.kind === "attack" ? "#f66" : m.kind === "gather" ? "#fd6" : "#8f8"}" stroke-opacity="${(m.life / 0.7).toFixed(2)}" stroke-width="2"/>`);
    }
    if (drag && (Math.abs(pointer.x - drag.x) > 4 || Math.abs(pointer.y - drag.y) > 4))
      out.push(`<rect x="${Math.min(drag.x, pointer.x)}" y="${Math.min(drag.y, pointer.y)}" width="${Math.abs(pointer.x - drag.x)}" height="${Math.abs(pointer.y - drag.y)}" fill="#8f8" fill-opacity="0.1" stroke="#8f8"/>`);
    if (placing && ghostAt?.why) out.push(`<text x="${pointer.x + 14}" y="${pointer.y + 4}" fill="#f88">${ghostAt.why}</text>`);
    return out.join("");
  }

  const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  function text(t: number): string {
    if (closed) return closed;
    const m = world?.match;
    const shown = client.seen(t);
    const left = m?.until != null && shown !== null ? Math.max(0, m.until - shown) : null;
    const phase = !m
      ? "joining…"
      : m.phase === "waiting"
        ? opts.vs === "bot"
          ? "the bot is coming…"
          : "waiting for a second side (alone, the bot comes in 20 s)"
        : m.phase === "playing"
          ? `playing · ${left === null ? "" : clock(left)}${world?.light != null && shown !== null ? ` · ${world.night ? "night" : "day"}, ${world.night ? "dawn" : "dusk"} in ${clock(Math.max(0, world.light - shown))}` : ""}`
          : `${m.winner ? `${nameOf(m.winner)} won` : "over"} · next in ${Math.ceil(left ?? 0)}`;
    const names = (list: PlayerNet[]) => list.map((p) => `${p.name}${p.bot ? " (bot)" : ""}`).join(" & ");
    const foes = world?.players.filter((p) => p.side !== side) ?? [];
    const mates = world?.players.filter((p) => p.side === side && p.id !== room.id) ?? [];
    const mineNow = [...units.values()].filter((u) => u.s === side);
    const count = (k: UnitKind, list: UnitNet[]) => list.filter((u) => u.k === k).length;
    /** A side's line: glim, units and lodges, as the snapshot has them. */
    const tally = (t: Team, glim: number) => {
      const list = [...units.values()].filter((u) => u.s === t);
      const lodges = (snap?.buildings ?? []).filter((b) => b.s === t && b.k === "lodge").length;
      return `${TEAM_NAMES[t]}: glim ${glim} · runners ${count("runner", list)} · wardens ${count("warden", list)} · lodges ${lodges}`;
    };
    const watching =
      !side && shows
        ? [
            `watching ${shows === "all" ? "both sides" : TEAM_NAMES[shows]} · ${TEAMS.map((t) => `${TEAM_NAMES[t]}: ${nameOf(t)}`).join(" vs ")}`,
            ...(snap?.glims ? TEAMS.map((t) => tally(t, snap!.glims![t])) : shows !== "all" && snap ? [tally(shows, snap.glim)] : []),
          ].join("\n")
        : "";
    const chosen = [...selection].map((id) => units.get(id)).filter((u): u is UnitNet => !!u);
    const pickedB = picked !== null ? buildingsDrawn.get(picked)?.net : undefined;
    const pickedU = picked !== null ? units.get(picked) : undefined;
    const pickedS = pickedStructure !== null ? structures.get(pickedStructure) : undefined;
    const sel = chosen.length
      ? `selected: ${[count("runner", chosen) && `${count("runner", chosen)} runner(s)`, count("warden", chosen) && `${count("warden", chosen)} warden(s)`].filter(Boolean).join(", ")}`
      : pickedB
        ? `${pickedB.s === side ? "your" : `${nameOf(pickedB.s)}'s`} ${pickedB.k} · ${pickedB.hp}/${BUILDINGS[pickedB.k].hp}${pickedB.b < 1 ? ` · rising ${Math.round(pickedB.b * 100)}%` : ""}${pickedB.q ? ` · training ${BUILDINGS[pickedB.k].trains} ${Math.round((pickedB.p ?? 0) * 100)}% (${pickedB.q} queued)` : ""}`
        : pickedU
          ? `${nameOf(pickedU.s)}'s ${pickedU.k} · ${pickedU.hp}/${UNITS[pickedU.k].hp}`
          : pickedS
            ? `a building of the Presidio · ${new Map(snap?.hurt ?? []).get(pickedS.obj) ?? pickedS.hp}/${pickedS.hp} · wardens knock it down (right click)`
            : "nothing selected";
    return [
      `FOGFRONT · room ${room.name} · ${phase}`,
      side ? `you: ${TEAM_NAMES[side]} (${side === "kiln" ? "red" : "blue"})${mates.length ? ` with ${names(mates)}` : ""} · vs ${foes.length ? names(foes) : "nobody yet"}` : watching,
      side && snap ? `glim ${snap.glim} · runners ${count("runner", mineNow)} · wardens ${count("warden", mineNow)} · lodges ${own("lodge").length}` : "",
      world?.marks.length ? `landmarks: ${world.marks.map((m) => `${m.name} (${m.owner ? (m.owner === side ? "yours" : TEAM_NAMES[m.owner]) : "nobody's"})`).join(", ")}` : "",
      sel,
      `ping ${client.ping === null ? "–" : Math.round(client.ping)} ms · invite: ${location.origin}${location.pathname}?room=${room.name}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  function buttons(): Record<"runner" | "lodge" | "warden", boolean> {
    const g = snap?.glim ?? 0;
    const playing = world?.match.phase === "playing" && !!side;
    return {
      runner: playing && g >= UNITS.runner.cost && own("hearth").length > 0,
      lodge: playing && g >= BUILDINGS.lodge.cost,
      warden: playing && g >= UNITS.warden.cost && own("lodge").some((b) => b.b >= 1),
    };
  }

  hud.say(`Fogfront · room ${room.name}: drag to select, right click to order, B for a lodge`, 5);
  window.__rts = {
    view,
    room,
    client,
    side: () => side,
    shows: () => shows,
    snap: () => snap,
    world: () => world,
    selected: () => [...selection],
    select: (ids: number[]) => {
      selection.clear();
      for (const id of ids) if (mine(units.get(id))) selection.add(id);
    },
    order: (c: RtsCommand) => order(c, c.t === "move" ? { at: { x: c.x, y: c.y }, kind: "move" } : undefined),
    pending: () => pending.size,
    drawn: () => ({ units: unitsDrawn.size, buildings: buildingsDrawn.size, seeps: seepsDrawn.size, rubble: rubble.size }),
    grid,
    command,
    selectBox,
    /** The level's buildings in the play area, standing. */
    structures: () => [...structures.values()].filter((s) => !view.edits.isRemoved(s.obj)),
    /** The side's sight now: cells seen, cells ever seen, and the share of the field in fog. */
    sight: () => ({ seen: sight.filter((d) => d < Infinity).length, explored: explored.reduce((a, b) => a + b, 0), cells: sight.length, fog: fogCover ? fogCover.filter((f) => f > 0.3).length / fogCover.length : 0 }),
  };
}

// ---------------------------------------------------------------- the HUD

interface Hud {
  status(s: string): void;
  say(s: string, seconds?: number): void;
  draw(svg: string, text: string, buttons: Record<"runner" | "lodge" | "warden", boolean>): void;
  onButton: ((what: "runner" | "lodge" | "warden") => void) | null;
}

function makeHud(): Hud {
  const el = (tag: string, cls: string) => Object.assign(document.createElement(tag), { className: cls });
  const board = el("div", "rts-panel rts-board");
  const toast = el("div", "rts-panel rts-toast");
  const bar = el("div", "rts-bar");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("rts-overlay");
  document.body.append(svg, board, toast, bar);
  toast.style.display = "none";
  let toastUntil = 0;
  const hud: Hud = {
    onButton: null,
    status: (s) => (board.textContent = s),
    say: (s, seconds = 3) => {
      toast.textContent = s;
      toast.style.display = "";
      toastUntil = performance.now() + seconds * 1000;
    },
    draw: (overlay, text, enabled) => {
      svg.innerHTML = overlay; // drawn from numbers and the page's own words only, never other players' names
      board.textContent = text;
      if (performance.now() > toastUntil) toast.style.display = "none";
      for (const b of buttons) b.disabled = !enabled[b.dataset.what as "runner" | "lodge" | "warden"];
    },
  };
  const buttons = (
    [
      ["runner", `Runner · ${UNITS.runner.cost} glim · R`],
      ["lodge", `Lodge · ${BUILDINGS.lodge.cost} glim · B`],
      ["warden", `Warden · ${UNITS.warden.cost} glim · T`],
    ] as const
  ).map(([what, label]) => {
    const b = Object.assign(document.createElement("button"), { textContent: label });
    b.dataset.what = what;
    b.addEventListener("click", () => hud.onButton?.(what));
    bar.append(b);
    return b;
  });
  return hud;
}

declare global {
  interface Window {
    __rts?: {
      view: WorldView;
      room: Room;
      client: TickClient<never, RtsSnap, RtsWorldNet, RtsEvent>;
      side: () => Team | null;
      shows: () => Watch | null;
      snap: () => RtsSnap | null;
      world: () => RtsWorldNet | null;
      selected: () => number[];
      select: (ids: number[]) => void;
      order: (c: RtsCommand) => number;
      pending: () => number;
      drawn: () => { units: number; buildings: number; seeps: number; rubble: number };
      grid: MapGrid;
      command: (sx: number, sy: number, attack?: boolean) => void;
      selectBox: (a: Point, b: Point, add: boolean) => void;
      sight: () => { seen: number; explored: number; cells: number; fog: number };
      structures: () => Structure[];
    };
  }
}
