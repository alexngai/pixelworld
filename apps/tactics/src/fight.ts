import { veilLayer, type Entity, type Rotation, type VeilLayer, type WorldView } from "@pixelworlds/engine";
import { boardCellAt, toWorld, type Board } from "@pixelworlds/engine/boards";
import {
  A_BURNS,
  A_WATER,
  FIRE_ASH,
  HIGH_GROUND_M,
  isBurning,
  DIRS,
  DIR_NAMES,
  FIGHTERS,
  INVADERS,
  SQUAD,
  aimOf,
  arriving,
  cloneCombat,
  endRound,
  entityModel,
  movePath,
  movesOf,
  moveUnit,
  BONUS_REPUTATION,
  objectiveMet,
  objectiveState,
  objectiveText,
  outcome,
  planInvaders,
  rampsFor,
  resolveInvaders,
  arrowStyle,
  planeAt,
  standAt,
  strike,
  strikeCell,
  strikeTarget,
  riseAt,
  climbBlocked,
  step,
  strikesOf,
  structureAt,
  teamOf,
  weaponsOf,
  type Arrow,
  type Combat,
  type CombatEvent,
  type FxKind,
  type Mark,
  type Puzzle,
  type Strike,
  type Action,
  type Weapon,
} from "@pixelworlds/tactics";
import type { Brain, } from "./brain";
import { BoardGlass, type FireLine, type Shot } from "./glass";
import { TacticalMap, mapAxis } from "./map";
import type { Outlook } from "./worker";

/**
 * A fight (D-153): a puzzle on a board cut from the city, played round by
 * round. Each rig moves then acts; hovering a target shows what the strike
 * would do, and how the invaders' aims change with it; Enter ends the turn,
 * and everything plays out in order. Invaders arriving at a round's end are
 * shown where they will stand, and a unit standing there blocks one. A turn
 * can be reset, and a hint asked for, a limited number of times. A building
 * that falls is taken out of the world.
 */

/**
 * A joint finale's link to the room (D-187): the rigs this page commands, the
 * other squad's name, and what goes to the room (a rig asked for, its action,
 * the rig handed back, the turn ended). What comes back reaches the fight by
 * `jointBaton`, `jointAct` and `jointTurn`.
 */
export interface JointLink {
  mine: ReadonlySet<number>;
  partner: string;
  take(u: number): void;
  act(a: Action): void;
  cancel(): void;
  end(): void;
}

export interface FightSetup {
  view: WorldView;
  board: Board;
  /** The position (a joint finale's has no solution of its own). */
  puzzle: Pick<Puzzle, "combat" | "fight" | "objectives">;
  /** Fought with another squad (D-187). */
  joint?: JointLink;
  brain: Brain;
  /** Where the fight's panels go, and the labels over the world. */
  ui: HTMLElement;
  labels: HTMLElement;
  title: string;
  rounds: number;
  resets: number;
  hints: number;
}

export interface FightOutcome {
  /** Nobody lost and the squad standing through every round. */
  held: boolean;
  /** The bonus objectives (D-199), each with whether the fight met it. */
  bonuses: { text: string; met: boolean }[];
  lost: number;
  /** People in the board's buildings when it began. */
  atStake: number;
  squadDown: boolean;
  roundsHeld: number;
  rounds: number;
  invadersDown: number;
  /** World objects (buildings) the fight brought down. */
  razed: number[];
  /** Each turn's rig actions as taken, a reset's undone (D-186): `replayFight` from the fight's start plays it again. */
  turns: Action[][];
}

interface Step {
  ms: number;
  start?(): void;
  tick?(t: number): void;
  end?(): void;
}

interface Label {
  el: HTMLElement;
  x: number;
  y: number;
  h: number;
  /** Screen pixels above the point. */
  dy: number;
  /** Floating labels rise and fade, then go. */
  until?: number;
  born?: number;
  /** What it says and how it's drawn, and its size on screen then (CSS px). */
  text?: string;
  cls?: string;
  w?: number;
  hgt?: number;
  /** A building's plain label: left to the pointer where it would cover another (D-197). */
  minor?: boolean;
  /** Where it stands on screen this frame: its anchor, the middle of its foot. */
  sx?: number;
  sy?: number;
}

type Phase = "pick" | "move" | "strike" | "busy" | "over";

/** How much of a building cut down still shows, where it stood in front (D-160). */
const GHOST = 0.3;
/** The sun for bakes from above (D-164): where the world's is, but high, for short shadows. */
const TOP_SUN: [number, number, number] = [0.15, 0.27, 1.6];
/** …under the selected unit or the cell looked at, even in the way (D-166). */
const GHOST_LIT = 0.85;
/** Units' outlines (D-170): the rig chosen, what the rig's move or strike would reach or affect, what the invaders will hurt. */
const CHOSEN: [number, number, number] = [110, 235, 95];
const AIMED: [number, number, number] = [255, 214, 64];
const THREATENED: [number, number, number] = [255, 72, 72];
/** How long the cutaway stays after what called for it ends (ms, D-167): a sweep of the pointer doesn't flicker it. */
const CUT_LINGER_MS = 450;
/** How high a building cut down stands (metres): a plinth, its footprint plain, a unit in the street behind it in view (the faint building shows the rest). */
const STUMP_M = 0.5;

/** One side of the view's cutaway (D-159): the buildings cut, the fight's among them (outlined), the cells still hidden with it and without. */
interface Side {
  /** What isn't the fight's and hides any of it: cut to the ground always (D-168). */
  clear: Map<number, number>;
  /** The fight's own buildings in front of another of its cells: cut to a stump in the cutaway (D-167). */
  cuts: Map<number, number>;
  /** The fight's buildings cut, far to near. */
  ghosts: number[];
  /** Per cell, the fight's buildings in front of it (ids). */
  blockers: number[][];
  hidden: Uint8Array;
  /** The cells hidden with only what's outside the fight cut (the cutaway off). */
  hiddenRest: Uint8Array;
  key: string;
}
const angle = (dir: number) => Math.atan2(DIRS[dir]![1], DIRS[dir]![0]);
const pips = (hp: number, max: number) => "■".repeat(Math.max(0, hp)) + "□".repeat(Math.max(0, max - hp));

/** Steps a view ray rises a world cell across each way toward the camera: two in the 2:1 view, three in the higher one (D-195). */
export function rayRise(view: WorldView): number {
  const p = view.camera.projection;
  return (p.y[0] + p.y[1]) / -p.y[2];
}

/** Which way the camera is from a side of the view, over the ground: a world cell across each way lands straight below on screen (in any projection, D-195). */
export function towardCamera(view: WorldView, r: number): readonly [number, number] {
  const [gx, gy] = view.camera.screenDirToGrid(0, 1, r as Rotation);
  return [Math.sign(gx) || 1, Math.sign(gy) || 1] as const;
}

export class Fight {
  readonly done: Promise<FightOutcome>;
  private finish!: (o: FightOutcome) => void;
  private readonly view: WorldView;
  private readonly board: Board;
  private readonly brain: Brain;
  private readonly puzzle: Pick<Puzzle, "combat" | "fight" | "objectives">;
  /** A joint finale's link (D-187), whether the other squad is acting, and whether this page has ended the turn and waits on it. */
  private readonly joint: JointLink | null;
  private partnerActing = false;
  /** The strike target a tap last showed (D-190), or −1. */
  private tapped = -1;
  private waiting = false;
  private readonly rounds: number;
  private readonly title: string;
  private readonly ramps: ReturnType<typeof rampsFor>;
  private c: Combat;
  private readonly start: Combat;
  private turnStart: Combat;
  /** Each turn's rig actions (D-186). */
  private turns: Action[][] = [[]];
  private roundsHeld = 0;
  private acted = new Set<number>();
  private selected = -1;
  /** Where the selected rig stood before this move (to take the move back). */
  private moveFrom = -1;
  private weapon = 0;
  /** For a hoist: the direction of the unit to lift, once clicked. */
  private lift = -1;
  private phase: Phase = "pick";
  private resets: number;
  private hints: number;
  private outlook: Outlook | "checking" = "checking";
  private outlookToken = 0;
  private assist = true;
  private hint: Arrow[] = [];
  /** The board's cells over the city view (D-156), and the cell under the pointer. */
  private readonly glass: BoardGlass;
  /** What the looked-at cell holds, said beside it, and that cell. */
  private readonly tip: HTMLElement;
  private tipAt = -1;
  private hover = -1;
  /** Buildings struck, by when (D-171): they flash on the glass. Shots in flight. */
  private readonly flashes = new Map<number, number>();
  private readonly shots: Shot[] = [];
  /** Each unit's idle rise now (steps, D-171), on top of where the timeline or the state puts it; when each was chosen (it hops). */
  private readonly idleDh: number[] = [];
  private readonly hopAt = new Map<number, number>();
  /** The world shaken (D-171): how hard (px), from when, till when. */
  private shakePx = 0;
  private shakeFrom = 0;
  private shakeTill = 0;
  /** A board step along the view's u (down-right on screen) and v (down-left): what the arrow keys move by. */
  private stepU: [number, number] = [1, 0];
  private stepV: [number, number] = [0, 1];
  /** A strike under the pointer, played on a copy: what it would do. */
  /**
   * A strike looked at (D-191): the fight after it, its arrows and words over the board, the buildings it hurts (pulsing) and the
   * units it moves (sliding), what it does in words, and which strike it is (to work it out once).
   */
  private preview: {
    state: Combat;
    arrows: Arrow[];
    tags: { k: number; text: string; cls: string }[];
    hurt: number[];
    slides: { from: number; to: number }[];
    text: string;
    key: string;
  } | null = null;
  private razed: number[] = [];
  private razedThisTurn: number[] = [];
  private readonly entities: (Entity | null)[] = [];
  private readonly map: TacticalMap;
  /** The rotation the view was laid out for. */
  private hiddenFor = -1;
  /** Each side's cuts, outlines and hidden cells (D-159), worked out once; what was sent to the view for each; whether all four were. */
  private sides: (Side | null)[] = [null, null, null, null];
  private readonly sent: (string | null)[] = [null, null, null, null];
  private primed = false;
  /** The fight's own buildings cut down in front of a unit (their ids), shown whole as outlines; what the cuts are now. */
  private ghosts: number[] = [];
  /** The cutaway showing now (D-167): while a rig is chosen, a move plays out, or a unit or a hidden cell is looked at; else the board's buildings whole (what's in front of the board is gone either way, D-168). */
  private cutting = false;
  /** In the move phase, the cells the rig in hand would reach but for a climb: each with the climb onto it (m). */
  private blockedNow = new Map<number, number>();
  /** V: the cutaway always. */
  private pinned = false;
  /** Till when the cutaway stays after what called for it ended (ms), or 0. */
  private cutTill = 0;
  private cutTimer = 0;
  private readonly fires = new Map<number, Entity[]>();
  private readonly ash = new Set<number>();
  private readonly fx = new Set<{ entities: Entity[]; until: number }>();
  private readonly queue: Step[] = [];
  private current: { step: Step; t0: number } | null = null;
  private idle: (() => void)[] = [];
  private readonly labels = new Map<string, Label>();
  private readonly offFrame: () => void;
  private readonly hud: HTMLElement;
  private readonly labelRoot: HTMLElement;
  private now = 0;
  /** The invader striking now, and those that have struck this round (their arrows gone). */
  private striking = -1;
  private readonly struck = new Set<number>();
  /** Enter pressed once with rigs that haven't acted: the next ends the turn. */
  private confirmEnd = false;
  /** The keyboard's cell (arrows move it, Space acts there), or −1 till a key is pressed. */
  private cursor = -1;

  constructor(s: FightSetup) {
    this.done = new Promise((r) => (this.finish = r));
    this.view = s.view;
    this.board = s.board;
    this.brain = s.brain;
    this.puzzle = s.puzzle;
    this.joint = s.joint ?? null;
    this.rounds = s.rounds;
    this.title = s.title;
    this.resets = s.resets;
    this.hints = s.hints;
    this.ramps = rampsFor(s.view.world.palette.rampIds);
    this.c = cloneCombat(s.puzzle.combat);
    this.start = cloneCombat(this.c);
    this.turnStart = cloneCombat(this.c);
    this.labelRoot = s.labels;
    this.hud = document.createElement("div");
    this.hud.className = "fight";
    s.ui.append(this.hud);
    const away = (k: number) => (k >= 0 ? this.centre(k) : { x: -1e9, y: -1e9 });
    this.map = new TacticalMap(s.ui, s.puzzle.combat.arena.w, s.puzzle.combat.arena.h, {
      click: (k) => this.click(away(k).x, away(k).y),
      hover: (k) => this.pointer(away(k).x, away(k).y),
      back: () => this.back(),
    });
    this.map.layOut(() => this.screenAxes());
    this.glass = new BoardGlass(s.labels, s.view, s.board);
    this.tip = document.createElement("div");
    this.tip.className = "tip";
    this.tip.hidden = true;
    s.labels.append(this.tip);
    this.bestRotation();
    this.clearView();
    this.frameBoard();
    this.refreshArt();
    this.bakeUnitArt();
    for (let u = 0; u < this.c.roster.length; u++) this.spawnEntity(u);
    this.offFrame = this.view.onFrame((e) => this.frame(e.now));
    this.checkOutlook();
    this.paint();
    // again, now the panels are drawn: the board in the space they leave
    this.frameBoard();
    // the city around the board dimmed (D-197): the board reads as the fight's ground, as Into the Breach's slab does
    this.veil = veilLayer({ id: "fight-veil", label: "Around the board", ramp: "asphalt", shade: 1, levels: [0.45] });
    void this.view.layers
      .add(this.veil)
      .then(() => this.veilAround())
      .catch(() => {});
    // a rooftop board (D-180): what lies below its roofs dimmed too, over the board, so the roofs stand out of the towers
    const floor = this.c.arena.floor;
    this.under = floor === undefined ? null : veilLayer({ id: "fight-under", label: "Under the roofs", ramp: "asphalt", shade: 1, levels: [0.45], below: floor - 0.5 });
    if (this.under)
      void this.view.layers
        .add(this.under)
        .then(() => this.veilUnder())
        .catch(() => {});
    const f = s.puzzle.fight;
    const traps = f && f.firstTurns > f.safeFirstTurns ? ` Careful: ${f.firstTurns - f.safeFirstTurns} of the ${f.firstTurns} first turns that lose nobody lose a later round.` : "";
    this.say(`Hold the block for ${this.rounds} rounds. Click a rig to move it.${traps}`);
  }

  /** The board baked from above for the map (D-155), again when what stands on it changes; the latest asked wins. */
  private artToken = 0;
  /** The rotation the board was framed in: turning the view frames it again (D-197). */
  private framedRotation = -1;
  /** The city around the board dimmed (D-197); under a rooftop board, the street and the towers' faces too (D-198). */
  private readonly veil: VeilLayer;
  private readonly under: VeilLayer | null;
  private refreshArt(): void {
    const token = ++this.artToken;
    const a = this.c.arena;
    const p0 = toWorld(this.board, { x: 0, y: 0 });
    const p1 = toWorld(this.board, { x: a.w, y: a.h });
    // one art px a map px on the small map (the large one shows it at exactly twice), D-163
    const px = Math.max(4, Math.round((TacticalMap.SMALL * (window.devicePixelRatio || 1)) / this.board.cell));
    // short shadows from a high sun (D-164): the taller a building, the further its shadow, without burying the streets
    void this.view.bakeTopDown(Math.min(p0.x, p1.x), Math.min(p0.y, p1.y), Math.max(p0.x, p1.x), Math.max(p0.y, p1.y), { px, shadows: true, sun: TOP_SUN }).then((img) => {
      if (img && token === this.artToken && this.phase !== "over") this.map.setArt(img.rgba, img.width, img.height);
    });
  }

  /** Every kind of unit from above (D-164), once a fight, at the map's art scale: the map draws them in place of discs. */
  private bakeUnitArt(): void {
    const rs = this.view.world.renderScale;
    const px = (TacticalMap.SMALL * (window.devicePixelRatio || 1)) / (this.board.cell * rs);
    for (const kind of Object.keys(FIGHTERS) as (keyof typeof FIGHTERS)[]) {
      const model = entityModel(kind, this.ramps, { scale: this.board.cell, renderScale: rs });
      if (!("boxes" in model)) continue;
      void this.view.bakeSpriteTopDown(model.boxes, { px, sun: TOP_SUN }).then((img) => {
        if (img && this.phase !== "over") this.map.setUnitArt(kind, img.rgba, img.width, img.height, img.left, img.top);
      });
    }
  }

  /**
   * Turn the camera to the side from which the board's own buildings hide
   * the least of it (D-169): the fewest cells hidden as the view stands at
   * rest (each side's rays, worked out now rather than a moment later), a
   * unit's counting three.
   */
  private bestRotation(): void {
    const { camera } = this.view;
    const c = this.c;
    const start = camera.rotation;
    let best = start;
    let least = Infinity;
    for (let i = 0; i < 4; i++) {
      const r = ((start + i) % 4) as Rotation;
      const hidden = this.side(r).hiddenRest;
      let n = 0;
      for (let k = 0; k < hidden.length; k++) if (hidden[k]) n += c.occ[k]! >= 0 ? 3 : 1;
      if (n < least) [least, best] = [n, r];
    }
    camera.rotation = best;
  }

  /** Where the board's axes run on screen in the city view now: a step along i, and along j, from its first cell. */
  private screenAxes(): { di: { x: number; y: number }; dj: { x: number; y: number } } {
    const { camera } = this.view;
    const o = camera.project(this.centre(0).x, this.centre(0).y, 0);
    const pi = camera.project(this.centre(1).x, this.centre(1).y, 0);
    const pj = camera.project(this.centre(this.c.arena.w).x, this.centre(this.c.arena.w).y, 0);
    return { di: { x: pi.x - o.x, y: pi.y - o.y }, dj: { x: pj.x - o.x, y: pj.y - o.y } };
  }

  /** The camera turned (Q, E): lay everything out for the new side at once, not at the next frame. */
  relayout(): void {
    this.clearView();
  }

  /** Lay the map and the arrow keys as the view lies, and cut down what hides the board from this side (again when the camera turns). */
  private clearView(): void {
    const { camera } = this.view;
    if (camera.rotation === this.hiddenFor) return;
    this.hiddenFor = camera.rotation;
    // the map turned as the view is (it asks the camera itself, at every drawing)
    this.map.refresh();
    // the arrow keys run as the map lies: right is its right, down its down
    const { di, dj } = this.screenAxes();
    const [ai, aj] = [mapAxis(di), mapAxis(dj)];
    this.stepU = [ai[0], aj[0]];
    this.stepV = [ai[1], aj[1]];
    // this side's cuts were sent with the others' when the fight began: only the outlines and hidden cells change
    this.updateCuts();
  }



  /**
   * The placed objects between the camera and a point (world cells, steps),
   * by a march up its view ray over their footprints and heights: all of them,
   * front ones and those behind, but trees.
   */
  private occluders(x: number, y: number, h: number, toward: readonly [number, number]): Set<number> {
    const out = new Set<number>();
    const { query } = this.view;
    const [dx, dy] = toward;
    // a cell across each way, `rise` steps up; to the tallest tower (about 150 steps)
    const rise = rayRise(this.view);
    for (let t = 0.25; t < 160 / rise; t += 0.35) {
      const z = h + rise * t;
      for (const o of query.objectsAt(x + dx * t, y + dy * t))
        if (o.base !== null && z >= o.base && z <= (o.top ?? o.base + 3) && !o.group.startsWith("tree")) out.add(o.index);
    }
    return out;
  }

  /**
   * What hides the fight is cut down to a stump (D-159), drawn so; the
   * queries still have it whole. Every building between the camera and the
   * board that isn't the fight's own, and every one of the fight's own in
   * front of another of its cells. The fight's are drawn whole as glass on the
   * glass layer, and a unit on one's roof stands on the glass. Worked out for
   * each side the camera may look from, and sent for all four when the fight
   * begins (and when a building falls), so the view bakes the other sides'
   * tiles while idle with their own cuts, and a turn finds them ready.
   */
  private updateCuts(): void {
    const r = this.view.camera.rotation;
    const side = this.side(r);
    this.ghosts = side.ghosts;
    this.send(r);
    // the other sides a moment later, so this one draws first
    if (!this.primed) {
      this.primed = true;
      setTimeout(() => {
        if (this.phase === "over") return;
        for (let o = 0; o < 4; o++) if (o !== this.view.camera.rotation) this.send(o);
      }, 400);
    }
  }

  /** A side's cuts to the view, if they changed: baked beside the plain tiles, shown while the cutaway is (D-167). */
  private send(r: number): void {
    const side = this.side(r);
    if (this.sent[r] === side.key) return;
    this.sent[r] = side.key;
    this.view.cutaway.set(side.clear.size ? side.clear : null, r as Rotation, { always: true });
    this.view.cutaway.set(side.cuts.size ? side.cuts : null, r as Rotation);
  }

  /** What one side of the view needs cut, outlined and dashed, worked out once (again when a building falls). */
  private side(r: number): Side {
    const known = this.sides[r];
    if (known) return known;
    const c = this.c;
    const a = c.arena;
    const toward = towardCamera(this.view, r);
    const stump = STUMP_M / a.metersPerStep;
    const own = new Map(a.structures.map((st, id) => [st.object, id] as const));
    // what stands between each cell and the camera: from its middle and corners, at a unit's feet and head
    const rays: { centre: Set<number>; all: Set<number> }[] = [];
    for (let k = 0; k < a.w * a.h; k++) {
      const h = planeAt(c, k) + 0.1;
      const centre = new Set<number>();
      const all = new Set<number>();
      for (const [di, dj] of [[0.5, 0.5], [0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]] as const)
        for (const z of [h, h + 1.5]) {
          const p = toWorld(this.board, { x: (k % a.w) + di, y: Math.floor(k / a.w) + dj });
          for (const o of this.occluders(p.x, p.y, z, toward)) {
            all.add(o);
            if (di === 0.5 && z === h) centre.add(o);
          }
        }
      rays.push({ centre, all });
    }
    const { query } = this.view;
    const clear = new Map<number, number>();
    const cuts = new Map<number, number>();
    const ghosts: number[] = [];
    const blockers: number[][] = rays.map((ray) => [...new Set([...ray.all].flatMap((o) => (own.has(o) ? [own.get(o)!] : [])))]);
    for (let k = 0; k < a.w * a.h; k++) {
      const sid = structureAt(c, k);
      const mine = sid >= 0 ? a.structures[sid]!.object : -1;
      for (const o of rays[k]!.all) {
        if (o === mine || cuts.has(o) || clear.has(o)) continue;
        const id = own.get(o);
        if (id === undefined) {
          // not the fight's: gone, to the ground, always (D-162, D-168), so nothing outside the board stands in its way
          const hit = query.object(o);
          if (!hit) continue;
          clear.set(o, (query.heightAt(hit.x, hit.y) ?? 0) + 0.05);
        } else if (c.structHp[id]! > 0) {
          // the fight's own: a stump, outlined whole as glass (a unit on its roof stands on the glass)
          cuts.set(o, a.height[a.structures[id]!.cells[0]!]! + stump);
          ghosts.push(id);
        }
      }
    }
    // the cells still hidden (dashed on the glass): behind a building that isn't the cell's own and isn't cut, the cutaway on or off
    const hidden = new Uint8Array(a.w * a.h);
    const hiddenRest = new Uint8Array(a.w * a.h);
    for (let k = 0; k < a.w * a.h; k++) {
      const sid = structureAt(c, k);
      const mine = sid >= 0 ? a.structures[sid]!.object : -1;
      const front = [...rays[k]!.centre].filter((o) => o !== mine);
      hidden[k] = front.some((o) => !cuts.has(o) && !clear.has(o)) ? 1 : 0;
      hiddenRest[k] = front.some((o) => !clear.has(o)) ? 1 : 0;
    }
    const keyOf = (m: Map<number, number>) => [...m].map(([o, h]) => `${o}:${h.toFixed(2)}`).sort().join(",");
    const key = `${keyOf(clear)}|${keyOf(cuts)}`;
    // far to near (the nearer drawn over the farther in the opacity mask): along the way to the camera
    const depth = (id: number) => {
      const p = this.centre(a.structures[id]!.cells[0]!);
      return p.x * toward[0] + p.y * toward[1];
    };
    ghosts.sort((p, q) => depth(p) - depth(q));
    return (this.sides[r] = { clear, cuts, ghosts, blockers, hidden, hiddenRest, key });
  }

  /** A building fell (or stood again): every side's cuts afresh, this one's now, the others' a moment later. */
  private resetSides(): void {
    this.sides = [null, null, null, null];
    this.primed = false;
  }

  /**
   * The camera on the board, in the space the panels leave (D-197): with `fit`, zoomed in as far as the board's plane fits that
   * space (its side corners may reach a little under the side panels); its middle in the middle of the space. Turning the view
   * frames it again, without the zoom.
   */
  private frameBoard(fit = true): void {
    const { camera, query, canvas } = this.view;
    const a = this.c.arena;
    const middle = toWorld(this.board, { x: a.w / 2, y: a.h / 2 });
    // a rooftop board's plane is its floor (D-180), not the street
    const at = (x: number, y: number) => Math.max(a.floor ?? -Infinity, query.heightAt(x, y) ?? 0);
    camera.setFocus(middle.x, middle.y, at(middle.x, middle.y));
    this.framedRotation = camera.rotation;
    const free = this.freeSpace(canvas.clientWidth, canvas.clientHeight);
    // on screen: its corners, and each unit at its head (one on a tower's roof stands far above the board's plane); roofs
    // aren't fitted, or a block of tall buildings would be framed small (the bars over them let the pointer through)
    const box = () => {
      const corners = [0, a.w].flatMap((i) => [0, a.h].map((j) => toWorld(this.board, { x: i, y: j }))).map((p) => camera.project(p.x, p.y, at(p.x, p.y)));
      const heads = this.c.roster.flatMap((_, u) => {
        const k = this.c.pos[u]!;
        if (this.c.hp[u]! <= 0) return [];
        const p = toWorld(this.board, { x: (k % a.w) + 0.5, y: Math.floor(k / a.w) + 0.5 });
        return [camera.project(p.x, p.y, planeAt(this.c, k) + 2)];
      });
      const xs = [...corners, ...heads].map((p) => p.x);
      const ys = [...corners, ...heads].map((p) => p.y);
      return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    };
    if (fit) {
      // the board's size on screen grows with the zoom: the largest whole zoom it fits at
      const b = box();
      const [w, h, z0] = [b.x1 - b.x0, b.y1 - b.y0, camera.zoom];
      let z = 1;
      for (let n = 6; n > 1; n--)
        if ((w * n) / z0 <= 1.1 * (free.right - free.left) && (h * n) / z0 <= free.bottom - free.top) {
          z = n;
          break;
        }
      camera.zoom = z;
    }
    // its middle to the middle of the space (panning moves the view the other way, in art pixels)
    const b = box();
    const k = (window.devicePixelRatio || 1) / camera.zoom;
    camera.pan(((b.x0 + b.x1) / 2 - (free.left + free.right) / 2) * k, ((b.y0 + b.y1) / 2 - (free.top + free.bottom) / 2) * k);
  }

  /**
   * The part of the canvas the panels leave (CSS px): those across its middle row close it at the sides, those across its
   * middle column at the top and the bottom; one in a corner (the invaders' list, the map) doesn't.
   */
  private freeSpace(W: number, H: number): { left: number; right: number; top: number; bottom: number } {
    const box = this.view.canvas.getBoundingClientRect();
    let [left, right, top, bottom] = [0, W, 0, H];
    for (const el of [...this.hud.children, this.map.el]) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const [x0, x1, y0, y1] = [r.left - box.left, r.right - box.left, r.top - box.top, r.bottom - box.top];
      if (y0 < H / 2 && y1 > H / 2) {
        if (x1 < W / 2) left = Math.max(left, x1);
        else if (x0 > W / 2) right = Math.min(right, x0);
      } else if (x0 < W / 2 && x1 > W / 2) {
        if (y1 < H / 2) top = Math.max(top, y1);
        else if (y0 > H / 2) bottom = Math.min(bottom, y0);
      }
    }
    return { left: left + 8, right: right - 8, top: top + 8, bottom: bottom - 8 };
  }

  /** Under a rooftop board's roofs: the board and a cell round it, nothing from two cells out, where the veil around it lies (D-198). */
  private veilUnder(): void {
    const [x0, y0, w, h] = this.aroundBoard();
    const values = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) values[y * w + x] = 255;
    this.under!.set({ x0, y0, w, h }, values);
  }

  /** The board's world cells and two more each way: x0, y0, width, height. */
  private aroundBoard(): [number, number, number, number] {
    const a = this.c.arena;
    const p0 = toWorld(this.board, { x: 0, y: 0 });
    const p1 = toWorld(this.board, { x: a.w, y: a.h });
    const [x0, y0] = [Math.floor(Math.min(p0.x, p1.x)) - 2, Math.floor(Math.min(p0.y, p1.y)) - 2];
    const [x1, y1] = [Math.ceil(Math.max(p0.x, p1.x)) + 2, Math.ceil(Math.max(p0.y, p1.y)) + 2];
    return [x0, y0, x1 - x0, y1 - y0];
  }

  /** The veil over the city but the board and a cell round it, thickest from two cells out (D-197). */
  private veilAround(): void {
    const [x0, y0, w, h] = this.aroundBoard();
    const values = new Uint8Array(w * h).fill(255);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) values[y * w + x] = 0;
    this.veil.set({ x0, y0, w, h }, values);
  }

  // ---------------------------------------------------------------- the world: entities, effects, labels

  private centre(k: number) {
    return toWorld(this.board, { x: (k % this.c.arena.w) + 0.5, y: Math.floor(k / this.c.arena.w) + 0.5 });
  }

  private spawnEntity(u: number, h?: number): void {
    this.idleDh[u] = 0;
    const k = this.c.pos[u]!;
    const p = this.centre(k);
    this.entities[u] = this.view.entities.add({
      model: entityModel(this.c.roster[u]!, this.ramps, { scale: this.board.cell, renderScale: this.view.world.renderScale }),
      x: p.x,
      y: p.y,
      h: h ?? standAt(this.c, k),
      heading: teamOf(this.c, u) === INVADERS && this.c.aim[u]! >= 0 ? angle(this.c.aim[u]!) : 0,
      // seen through what hides it (D-167): the rigs in the style's colour, the invaders red
      silhouette: true,
      ...(teamOf(this.c, u) === INVADERS ? { silhouetteRamp: this.ramps.red } : {}),
      wait: false,
    });
  }

  private effect(kind: FxKind, k: number, frames: number, seconds: number, h?: number): Entity[] {
    const p = this.centre(k);
    const entities = Array.from({ length: frames }, (_, frame) =>
      this.view.entities.add({
        model: entityModel(kind, this.ramps, { renderScale: this.view.world.renderScale, frame, seed: k, scale: this.board.cell }),
        x: p.x,
        y: p.y,
        h: h ?? planeAt(this.c, k),
        wait: false,
        visible: frame === 0,
        headings: 1,
      }),
    );
    this.fx.add({ entities, until: this.now + seconds * 1000 });
    return entities;
  }

  /** A word over a cell: one kept by its id, or one that rises and fades. */
  private label(id: string | null, k: number, text: string, cls: string, dy = 34, h?: number): void {
    const p = this.centre(k);
    let l = id ? this.labels.get(id) : undefined;
    if (!l) {
      const el = document.createElement("div");
      this.labelRoot.append(el);
      l = { el, x: p.x, y: p.y, h: 0, dy };
      this.labels.set(id ?? `float-${Math.random()}`, l);
    }
    if (l.text !== text || l.cls !== cls) {
      l.el.className = `label ${cls}${id ? "" : " rise"}`;
      l.el.textContent = text;
      Object.assign(l, { text, cls, w: l.el.offsetWidth, hgt: l.el.offsetHeight, minor: cls === "building" || cls === "building empty" });
    }
    Object.assign(l, { x: p.x, y: p.y, h: h ?? planeAt(this.c, k), dy });
    if (!id) Object.assign(l, { born: this.now, until: this.now + 1100 });
  }

  /** A unit's entity put somewhere by the timeline: its idle rise stays on top (D-171). */
  private place(u: number, x: number, y: number, h: number): void {
    this.entities[u]?.moveTo(x, y, h + (this.idleDh[u] ?? 0));
  }

  /** Where a unit's entity stands, without its idle rise. */
  private baseH(u: number): number {
    return (this.entities[u]?.h ?? 0) - (this.idleDh[u] ?? 0);
  }

  /**
   * Idle (D-171): flyers hover, the other invaders breathe, the chosen rig
   * bounces, a rig just chosen hops. A rise on top of wherever the unit is
   * put, so it carries on through moves and strikes.
   */
  private idleMotion(now: number): void {
    const c = this.c;
    for (let u = 0; u < c.roster.length; u++) {
      const e = this.entities[u];
      if (!e || c.hp[u]! <= 0) continue;
      const f = FIGHTERS[c.roster[u]!];
      const t = now / 1000 + u * 0.7;
      let dh = f.flying ? 0.35 * Math.sin(t * 2.2) : teamOf(c, u) === INVADERS ? 0.12 * Math.sin(t * 3) : 0;
      if (u === this.selected && this.phase !== "busy") dh += 0.25 * Math.abs(Math.sin(t * 3.4));
      const hop = now - (this.hopAt.get(u) ?? -Infinity);
      if (hop < 280) dh += 0.9 * Math.sin((Math.PI * hop) / 280);
      const was = this.idleDh[u] ?? 0;
      if (Math.abs(dh - was) < 0.01) continue;
      this.idleDh[u] = dh;
      e.moveTo(e.x, e.y, e.h - was + dh);
    }
  }

  /** Shake the world (the view, the glass, the labels) a moment, as hard as asked (px) or the shake on now, whichever is harder. */
  private shake(px: number, ms: number): void {
    const left = this.shakeTill > this.now ? (this.shakePx * (this.shakeTill - this.now)) / (this.shakeTill - this.shakeFrom) : 0;
    if (px < left) return;
    [this.shakePx, this.shakeFrom, this.shakeTill] = [px, this.now, this.now + ms];
  }

  /** Every unit's entity where the state has it, the fallen gone; the fires; the invaders facing their aims. */
  private sync(): void {
    const c = this.c;
    for (let u = 0; u < c.roster.length; u++) {
      if (!this.entities[u]) this.spawnEntity(u);
      const e = this.entities[u]!;
      e.visible = c.hp[u]! > 0;
      const p = this.centre(c.pos[u]!);
      e.moveTo(p.x, p.y, standAt(c, c.pos[u]!) + (this.idleDh[u] ?? 0));
      if (teamOf(c, u) === INVADERS && c.aim[u]! >= 0) e.heading = angle(c.aim[u]!);
    }
    for (let k = 0; k < c.fire.length; k++) {
      const f = this.fires.get(k);
      if (isBurning(c, k) && !f) this.fires.set(k, this.effect("fire", k, 3, Infinity));
      else if (!isBurning(c, k) && f) {
        for (const e of f) e.remove();
        for (const x of this.fx) if (x.entities === f) this.fx.delete(x);
        this.fires.delete(k);
      }
      // burnt out: a wisp of smoke stays
      if (c.fire[k] === FIRE_ASH && !this.ash.has(k)) {
        this.ash.add(k);
        this.effect("smoke", k, 2, Infinity);
      }
    }
    this.updateCuts();
  }

  private frame(now: number): void {
    this.now = now;
    if (this.view.camera.rotation !== this.framedRotation) this.frameBoard(false);
    this.clearView();
    this.glass.frame();
    if (!this.tip.hidden && this.tipAt >= 0) {
      const p = this.centre(this.tipAt);
      const q = this.view.camera.project(p.x, p.y, planeAt(this.c, this.tipAt));
      this.tip.style.transform = `translate(${Math.round(q.x + 26)}px, ${Math.round(q.y - 10)}px)`;
    }
    // the timeline
    for (let guard = 0; guard < 64; guard++) {
      if (!this.current) {
        const step = this.queue.shift();
        if (!step) {
          if (this.idle.length) this.idle.splice(0).forEach((f) => f());
          break;
        }
        step.start?.();
        this.current = { step, t0: now };
      }
      const { step, t0 } = this.current;
      const t = step.ms > 0 ? Math.min(1, (now - t0) / step.ms) : 1;
      step.tick?.(t);
      if (t < 1) break;
      step.end?.();
      this.current = null;
    }
    if (this.phase !== "over") this.idleMotion(now);
    // the world shaken: a fading jolt
    const els = [this.view.canvas, this.glass.el, this.labelRoot];
    if (this.shakeTill > now) {
      const k = (this.shakePx * (this.shakeTill - now)) / (this.shakeTill - this.shakeFrom);
      const tf = `translate(${(Math.sin(now / 17) * k).toFixed(1)}px, ${(Math.cos(now / 23) * k * 0.6).toFixed(1)}px)`;
      for (const el of els) el.style.transform = tf;
    } else if (this.shakePx) {
      this.shakePx = 0;
      for (const el of els) el.style.transform = "";
    }
    for (const [id, t0] of this.flashes) if (now - t0 > 600) this.flashes.delete(id);
    for (let i = this.shots.length - 1; i >= 0; i--) if (now > this.shots[i]!.t0 + this.shots[i]!.ms) this.shots.splice(i, 1);
    // effects: cycle their frames, and let go of the spent
    const frame = Math.floor(now / 160);
    for (const f of this.fx) {
      if (now > f.until) {
        for (const e of f.entities) e.remove();
        this.fx.delete(f);
        continue;
      }
      f.entities.forEach((e, i) => (e.visible = i === frame % f.entities.length));
    }
    // labels over the world
    for (const [id, l] of this.labels) {
      if (l.until !== undefined && now > l.until) {
        l.el.remove();
        this.labels.delete(id);
        continue;
      }
      const p = this.view.camera.project(l.x, l.y, l.h);
      const rise = l.born !== undefined ? ((now - l.born) / 1100) * 18 : 0;
      [l.sx, l.sy] = [p.x, p.y - l.dy - rise];
      l.el.style.transform = `translate(${l.sx}px, ${l.sy}px)`;
      if (l.until !== undefined) l.el.style.opacity = String(Math.min(1, (l.until - now) / 400));
    }
    this.declutter();
  }

  /**
   * A building's plain label that would cover another label is hidden (D-197): the pointer's tip still names the building, its
   * hit points and people. Units', strikes', arrivals' and threatened buildings' labels always show; plain ones nearest the
   * viewer first.
   */
  private declutter(): void {
    const box = (l: Label) => [l.sx! - l.w! / 2, l.sy! - l.hgt!, l.sx! + l.w! / 2, l.sy!] as const;
    const meets = (p: readonly number[], q: readonly number[]) => p[0]! < q[2]! && q[0]! < p[2]! && p[1]! < q[3]! && q[1]! < p[3]!;
    const all = [...this.labels.values()].filter((l) => l.sx !== undefined && l.w !== undefined);
    const placed = all.filter((l) => !l.minor).map(box);
    for (const l of all.filter((l) => l.minor).sort((p, q) => q.sy! - p.sy!)) {
      const b = box(l);
      const hide = placed.some((q) => meets(b, q));
      l.el.style.visibility = hide ? "hidden" : "";
      if (!hide) placed.push(b);
    }
  }

  /** Play steps in order; resolves when they (and those queued before) are done. */
  private steps(list: Step[]): Promise<void> {
    this.queue.push(...list);
    return new Promise((r) => this.idle.push(r));
  }

  /**
   * The steps that show what a log of events did, in order, from where the
   * entities stood (D-171, after Into the Breach): a move walks its path cell
   * by cell with a hop and dust where it lands; a shot flies along its arc; a
   * unit hit flashes and shakes; a building hit flashes; big blows shake the
   * world.
   */
  private animate(log: readonly CombatEvent[]): Step[] {
    const c = this.c;
    const steps: Step[] = [];
    // from where the entity is when the step starts (an earlier step may have moved it)
    const tween = (u: number, from: number, to: number, ms: number, lift = 0, ease = false): Step => {
      const b = this.centre(to);
      const hb = standAt(c, to);
      let a = { x: b.x, y: b.y };
      let ha = hb;
      return {
        ms,
        start: () => {
          const e = this.entities[u];
          a = e ? { x: e.x, y: e.y } : this.centre(from);
          ha = e ? this.baseH(u) : standAt(c, from);
        },
        tick: (t) => {
          const f = ease ? t * t * (3 - 2 * t) : t;
          this.place(u, a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, ha + (hb - ha) * f + lift * Math.sin(Math.PI * t));
        },
      };
    };
    const nudge = (u: number, at: number, ms: number): Step => {
      let x0 = 0;
      let y0 = 0;
      let h0 = 0;
      const b = this.centre(at);
      return {
        ms,
        start: () => {
          const e = this.entities[u];
          [x0, y0, h0] = [e?.x ?? b.x, e?.y ?? b.y, this.baseH(u)];
        },
        tick: (t) => this.place(u, x0 + (b.x - x0) * 0.3 * Math.sin(Math.PI * t), y0 + (b.y - y0) * 0.3 * Math.sin(Math.PI * t), h0),
        end: () => this.place(u, x0, y0, h0),
      };
    };
    // hit: a white flash, then red, and a shudder across the screen
    const hit = (u: number, ms: number): Step => {
      let x0 = 0;
      let y0 = 0;
      let h0 = 0;
      const [tx, ty] = towardCamera(this.view, this.view.camera.rotation);
      const [sx, sy] = [ty * 0.09, -tx * 0.09];
      return {
        ms,
        start: () => {
          const e = this.entities[u];
          [x0, y0, h0] = [e?.x ?? 0, e?.y ?? 0, this.baseH(u)];
          if (e) e.outline = [255, 255, 255];
          this.shake(3, 180);
        },
        tick: (t) => {
          const k = Math.sin(t * Math.PI * 7) * (1 - t);
          this.place(u, x0 + sx * k, y0 + sy * k, h0);
          const e = this.entities[u];
          if (e && t > 0.3) e.outline = THREATENED;
        },
        end: () => {
          this.place(u, x0, y0, h0);
          const e = this.entities[u];
          if (e) e.outline = null;
        },
      };
    };
    const dust = (k: number): Step => ({ ms: 0, start: () => void this.effect("smoke", k, 2, 0.35) });
    const word = (k: number, text: string, cls: string): Step => ({ ms: 0, start: () => this.label(null, k, text, cls) });
    let lastAt = -1;
    for (const e of log) {
      switch (e.t) {
        case "move": {
          const f = FIGHTERS[c.roster[e.unit]!];
          if (f.flying) {
            // a flyer glides there over everything
            steps.push(tween(e.unit, e.from, e.to, Math.min(650, 160 * manhattan(c.arena.w, e.from, e.to)), 1.2, true));
            break;
          }
          // cell by cell along its path, a hop each; roof to roof, a leap arcing over the street
          const path = movePath(c, e.unit, e.from, e.to);
          for (let n = 1; n < path.length; n++) {
            const leap = manhattan(c.arena.w, path[n - 1]!, path[n]!) >= 2;
            steps.push(tween(e.unit, path[n - 1]!, path[n]!, leap ? 380 : path.length > 2 ? 115 : 160, leap ? 6 : 0.35));
          }
          steps.push(dust(e.to));
          break;
        }
        case "strike": {
          lastAt = e.at;
          const w = weaponsOf(c, e.unit)[e.weapon]!;
          const from = c.pos[e.unit]!;
          steps.push(nudge(e.unit, e.at, 160));
          // a shot flies to what's struck from further than the next cell
          if (w.kind !== "hoist" && w.kind !== "evacuate" && manhattan(c.arena.w, from, e.at) > 1) {
            const ms = 160 + 45 * manhattan(c.arena.w, from, e.at);
            steps.push({ ms, start: () => void this.shots.push({ from, to: e.at, t0: this.now, ms, kind: teamOf(c, e.unit) === INVADERS ? "attack" : "info" }) });
          }
          if (w.kind !== "hoist" && w.kind !== "evacuate") steps.push({ ms: 120, start: () => this.effect(w.douses ? "jet" : "blast", e.at, 3, 0.45) });
          break;
        }
        case "push":
          steps.push(tween(e.unit, e.from, e.to, 170, 0.2, true), dust(e.to));
          break;
        case "bump":
          steps.push(nudge(e.unit, e.at, 170), { ms: 0, start: () => this.shake(3, 160) }, word(e.at, "bump", "hurt"));
          break;
        case "fall":
          steps.push({ ms: 0 }, word(c.pos[e.unit]!, `falls ${Math.round(e.drop * c.arena.metersPerStep)} m`, "hurt"));
          break;
        case "damage":
          steps.push(word(c.pos[e.unit]!, `−${e.amount}`, "hurt"), hit(e.unit, 320));
          break;
        case "down": {
          const at = e.at;
          steps.push({
            ms: 220,
            start: () => {
              this.effect(c.arena.flags[at]! & A_WATER && structureAt(c, at) < 0 ? "jet" : "blast", at, 4, 0.9);
              this.shake(6, 300);
            },
            end: () => {
              const ent = this.entities[e.unit];
              if (ent) ent.visible = false;
            },
          });
          if (e.drowned) steps.push(word(at, "drowned", "hurt"));
          break;
        }
        case "structure": {
          const s = c.arena.structures[e.id]!;
          const at = s.cells.includes(lastAt) ? lastAt : s.cells[0]!;
          steps.push(word(at, e.people >= 0.5 ? `−${Math.round(e.people)} people` : `−${e.amount}`, "lost"), {
            ms: 0,
            start: () => {
              this.flashes.set(e.id, performance.now());
              this.shake(e.destroyed ? 0 : 3, 160);
            },
          });
          if (e.destroyed)
            steps.push({
              ms: 260,
              start: () => {
                for (const k of s.cells) this.effect("rubble", k, 1, Infinity, c.arena.height[k]);
                this.effect("blast", at, 4, 0.9);
                this.shake(8, 420);
                if (s.object >= 0) {
                  this.view.edits.remove([s.object]);
                  this.razed.push(s.object);
                  this.razedThisTurn.push(s.object);
                  this.resetSides();
                  this.refreshArt();
                }
              },
            });
          break;
        }
        case "topple":
          steps.push(word(e.cells[0] ?? lastAt, "topples!", "lost"), { ms: 0, start: () => this.shake(10, 600) });
          for (const k of e.cells) steps.push({ ms: 90, start: () => this.effect("blast", k, 3, 0.6) });
          break;
        case "hoist":
          steps.push(tween(e.unit, e.from, e.to, 450, 8));
          break;
        case "evacuate":
          steps.push(word(c.arena.structures[e.id]!.cells[0]!, "evacuating", "good"));
          break;
        case "arrive":
          steps.push({
            ms: 380,
            start: () => {
              this.spawnEntity(e.unit, standAt(c, e.at) + 14);
              this.label(null, e.at, `${FIGHTERS[c.roster[e.unit]!].name} arrives`, "hurt");
            },
            // falling faster and faster, then a jolt and dust on landing
            tick: (t) => {
              const p = this.centre(e.at);
              this.place(e.unit, p.x, p.y, standAt(c, e.at) + 14 * (1 - t * t));
            },
            end: () => {
              this.effect("blast", e.at, 3, 0.5);
              this.effect("smoke", e.at, 2, 0.5);
              this.shake(5, 260);
            },
          });
          break;
        case "blocked":
          steps.push({ ms: 200, start: () => this.effect("blast", e.at, 3, 0.5) }, word(e.at, "blocked", "good"));
          break;
        default:
          break; // fire is shown when the state is put back in step
      }
    }
    return steps;
  }

  // ---------------------------------------------------------------- what is drawn on the board, and the panels

  private ij = (k: number): [number, number] => [k % this.c.arena.w, Math.floor(k / this.c.arena.w)];

  /** Each invader's aim as an arrow from where it stands, in a state. */
  private aims(s: Combat): Arrow[] {
    const out: Arrow[] = [];
    for (let u = 0; u < s.roster.length; u++) {
      if (teamOf(s, u) !== INVADERS || s.hp[u]! <= 0 || s.aim[u]! < 0 || this.struck.has(u)) continue;
      const t = strikeCell(s, u, aimOf(s, u));
      if (t >= 0) out.push({ from: this.ij(s.pos[u]!), to: this.ij(t), kind: "attack", style: arrowStyle(weaponsOf(s, u)[0]!.kind) });
    }
    return out;
  }

  /** The cells a state's round would harm: struck, crushed, buildings hit. */
  /**
   * What the invaders will do this round (D-192, D-194): the cells their strikes hurt (a building on the cell struck), and on each,
   * the damage a badge shows: hit points off a unit or a building.
   */
  private intents(s: Combat): { cells: Set<number>; hits: Map<number, number> } {
    // each invader's strike in turn; a building it hurts marked on the cell struck (D-192), not the whole of it
    const r = cloneCombat(s);
    const cells = new Set<number>();
    const hits = new Map<number, number>();
    const hit = (k: number, n: number) => hits.set(k, (hits.get(k) ?? 0) + n);
    const w = s.arena.w;
    for (let u = 0; u < r.roster.length; u++) {
      if (teamOf(r, u) !== INVADERS || r.hp[u]! <= 0 || r.aim[u]! < 0) continue;
      const t = strikeCell(r, u, aimOf(r, u));
      const log: CombatEvent[] = [];
      strike(r, u, aimOf(r, u), log);
      for (const e of log) {
        if (e.t === "crush") cells.add(e.at);
        if (e.t === "damage") {
          cells.add(r.pos[e.unit]!);
          hit(r.pos[e.unit]!, e.amount);
        }
        if (e.t !== "structure") continue;
        const own = s.arena.structures[e.id]!.cells;
        // the cell struck if it's this building's, else (pushed into it, fallen on) its cell nearest the strike
        const near = t >= 0 && own.includes(t) ? t : own.reduce((a, b) => (t < 0 || Math.hypot((b % w) - (t % w), Math.floor(b / w) - Math.floor(t / w)) < Math.hypot((a % w) - (t % w), Math.floor(a / w) - Math.floor(t / w)) ? b : a));
        cells.add(near);
        hit(near, e.amount);
      }
    }
    return { cells, hits };
  }

  private targets(u: number): Map<number, Strike> {
    const out = new Map<number, Strike>();
    const w = weaponsOf(this.c, u)[this.weapon]!;
    for (const s of strikesOf(this.c, u)) {
      if (s.weapon !== this.weapon) continue;
      if (w.kind === "hoist") {
        if (this.lift < 0) out.set(strikeCell(this.c, u, s), { ...s, to: -1 });
        else if (s.dir === this.lift) out.set(s.to!, s);
        continue;
      }
      const k = strikeCell(this.c, u, s);
      if (k >= 0 && !out.has(k)) out.set(k, s);
    }
    return out;
  }

  private order(s: Combat): Map<number, number> {
    const out = new Map<number, number>();
    // numbered as at the round's start: those that have struck keep their numbers out of the list
    for (let u = 0, n = 1; u < s.roster.length; u++) {
      if (teamOf(s, u) !== INVADERS || s.aim[u]! < 0 || (s.hp[u]! <= 0 && !this.struck.has(u))) continue;
      if (!this.struck.has(u) && s.hp[u]! > 0) out.set(u, n);
      n++;
    }
    return out;
  }

  /** The board's marks, arrows and labels, and the panels, as things stand. */
  private paint(): void {
    const c = this.c;
    const shown = this.preview?.state ?? c;
    const byCell = new Map<number, Mark["kind"]>();
    const mark = (k: number, kind: Mark["kind"]) => byCell.set(k, kind);
    const plan = this.phase !== "busy" && this.phase !== "over" ? this.intents(shown) : null;
    const danger = plan?.cells ?? new Set<number>();
    for (const k of danger) mark(k, "danger");
    for (const { at } of arriving(shown)) mark(at, "info");
    for (let u = 0; u < shown.roster.length; u++) {
      if (shown.hp[u]! <= 0) continue;
      if (teamOf(shown, u) === INVADERS) mark(shown.pos[u]!, "enemy");
      else mark(shown.pos[u]!, u === this.selected ? "select" : this.acted.has(u) ? "info" : "ally");
    }
    if (this.selected >= 0 && this.phase === "move") for (const k of movesOf(c, this.selected)) if (k !== c.pos[this.selected]) mark(k, "move");
    if (this.selected >= 0 && this.phase === "strike") for (const k of this.targets(this.selected).keys()) mark(k, this.lift >= 0 ? "move" : "attack");
    const marks: Mark[] = [];
    for (const [k, kind] of byCell) marks.push({ i: k % c.arena.w, j: Math.floor(k / c.arena.w), kind });
    // in the move phase, what the rig could strike from the cell pointed at
    const focus = this.focus();
    this.cutting = this.cutawayWanted(shown, focus);
    this.view.cutaway.enabled = this.cutting;
    const reach: number[] = [];
    // lines of fire: the shots and charges the rig in hand has, from where it stands in the strike phase (its weapon chosen), from the cell
    // pointed at in the move phase (every weapon's)
    const lines: FireLine[] = [];
    if (this.phase === "move" && focus >= 0 && movesOf(c, this.selected).includes(focus)) {
      const d = cloneCombat(c);
      moveUnit(d, this.selected, focus);
      for (const st of strikesOf(d, this.selected)) {
        const t = strikeCell(d, this.selected, st);
        if (t >= 0 && t !== focus && !reach.includes(t)) reach.push(t);
      }
      lines.push(...this.fireLines(d, this.selected));
    }
    if (this.phase === "strike" && this.selected >= 0 && this.lift < 0) lines.push(...this.fireLines(c, this.selected, this.weapon));
    this.blockedNow = this.phase === "move" && this.selected >= 0 ? climbBlocked(c, this.selected) : new Map();
    // units outlined (D-170): green the rig chosen; yellow what it could strike, or what the move or strike pointed at would reach or
    // affect; red what the invaders will hurt
    const aimed = new Set<number>();
    const unitAt = (k: number) => (c.occ[k]! >= 0 ? aimed.add(c.occ[k]!) : aimed);
    if (this.selected >= 0 && this.phase === "strike") for (const k of this.targets(this.selected).keys()) unitAt(k);
    for (const k of reach) unitAt(k);
    if (this.preview) for (let u = 0; u < c.roster.length; u++) if (this.preview.state.hp[u] !== c.hp[u] || this.preview.state.pos[u] !== c.pos[u]) aimed.add(u);
    for (let u = 0; u < c.roster.length; u++) {
      const e = this.entities[u];
      if (!e) continue;
      e.outline = u === this.selected ? CHOSEN : aimed.has(u) ? AIMED : c.hp[u]! > 0 && danger.has(c.pos[u]!) ? THREATENED : null;
    }
    // the fight's buildings cut away, each drawn as itself over the cut (D-162), far to near: solid, but faint where in the way (D-166)
    const alphas = this.ghostAlphas(shown, focus);
    this.view.cutaway.setGhosts(this.cutting ? this.ghosts.map((id, n) => ({ object: c.arena.structures[id]!.object, alpha: alphas[n] ?? GHOST })) : null);
    const goals = (this.puzzle.objectives ?? []).flatMap((ob) => (ob.kind === "evacuate" && objectiveState(ob, this.start, shown, false) === "open" ? [ob.structure] : []));
    this.glass.set({
      state: shown,
      marks,
      cursor: this.cursor,
      hover: this.hover,
      reach,
      hidden: this.hiddenNow(shown, alphas),
      // glass outlines on the faint ones only: a solid building needs none
      ghosts: this.ghosts.filter((_, n) => (alphas[n] ?? 1) < 1),
      stump: STUMP_M / c.arena.metersPerStep,
      arrows: [...this.aims(shown), ...(this.preview?.arrows ?? []), ...this.hint],
      arrivals: arriving(shown).map((x) => x.at),
      flashes: this.flashes,
      shots: this.shots,
      hurt: this.preview?.hurt ?? [],
      slides: this.preview?.slides ?? [],
      goals,
      blocked: this.blockedNow,
      lines,
    });
    this.inspect(shown, focus);
    const arrows = [...this.aims(shown), ...(this.preview?.arrows ?? []), ...this.hint];
    this.map.draw({ state: shown, marks, arrows, acted: this.acted, striking: this.striking, order: this.order(shown), cursor: this.cursor, reach, blocked: this.blockedNow, lines, hits: plan?.hits, hurt: this.preview?.hurt, goals });

    // labels: hit points over every unit, the invaders' order, arrivals, what a hovered strike would do
    const keep = new Set<string>();
    const order = this.order(shown);
    for (let u = 0; u < shown.roster.length; u++) {
      const id = `unit-${u}`;
      if (shown.hp[u]! <= 0) continue;
      keep.add(id);
      const f = FIGHTERS[shown.roster[u]!];
      const n = order.get(u);
      this.label(id, shown.pos[u]!, `${n ? `${n} ` : ""}${pips(shown.hp[u]!, f.hp)}`, teamOf(shown, u) === SQUAD ? (this.acted.has(u) ? "rig done" : "rig") : u === this.striking ? "invader striking" : "invader");
    }
    arriving(shown).forEach(({ kind, at }, i) => {
      keep.add(`arrive-${i}`);
      this.label(`arrive-${i}`, at, `▼ ${FIGHTERS[kind].name}`, "arrive", 16);
    });
    this.preview?.tags.forEach((t, i) => {
      keep.add(`tag-${i}`);
      this.label(`tag-${i}`, t.k, t.text, `${t.cls} preview`, 52);
    });
    // each building standing on the board (D-191): its hit points and the people in it; red when the invaders strike it, pulsing when
    // the strike looked at hurts it, faint when it's empty
    if (this.phase !== "over")
      shown.arena.structures.forEach((st, id) => {
        if (shown.structHp[id]! <= 0 || !st.cells.length) return;
        const bid = `bld-${id}`;
        keep.add(bid);
        const at = this.middleCell(st.cells);
        const people = shown.evacuated[id] ? "empty" : `${st.people >= 1000 ? `${(st.people / 1000).toFixed(1)}k` : st.people} people`;
        const cls = this.preview?.hurt.includes(id) ? "building hurt preview" : st.cells.some((k) => danger.has(k)) ? "building threat" : shown.evacuated[id] ? "building empty" : "building";
        this.label(bid, at, `${pips(shown.structHp[id]!, st.hp)} ${people} · ${Math.round(riseAt(shown, at))} m`, cls, 8);
      });
    // each cell the invaders will hit (D-194): a badge with the damage, where it lands
    if (plan)
      for (const [k, n] of plan.hits) {
        const hid = `hit-${k}`;
        keep.add(hid);
        this.label(hid, k, `${n}`, "badge", -4);
      }
    for (const [id, l] of this.labels)
      if (l.until === undefined && !keep.has(id)) {
        l.el.remove();
        this.labels.delete(id);
      }
    this.panels();
  }

  /**
   * A rig's lines of fire (C): each shot's and charge's, a weapon's or all of
   * them, from where it stands, to what it strikes first or the board's edge.
   */
  private fireLines(c: Combat, u: number, only?: number): FireLine[] {
    const out: FireLine[] = [];
    const from = c.pos[u]!;
    weaponsOf(c, u).forEach((w, weapon) => {
      if ((only !== undefined && weapon !== only) || (w.kind !== "shot" && w.kind !== "charge")) return;
      for (let dir = 0; dir < 4; dir++) {
        const t = strikeCell(c, u, { weapon, dir, range: 1 });
        if (t >= 0) {
          out.push({ from, to: t, ends: c.occ[t]! >= 0 ? "unit" : "wall" });
          continue;
        }
        // a charge with nothing to strike doesn't go; a shot flies off the board
        if (w.kind === "charge") continue;
        let k = from;
        for (let n = step(c.arena, k, dir); n >= 0; n = step(c.arena, k, dir)) k = n;
        if (k !== from) out.push({ from, to: k, ends: "edge" });
      }
    });
    return out;
  }

  /** The cell of a building nearest its middle: where its label stands. */
  private middleCell(cells: readonly number[]): number {
    const w = this.c.arena.w;
    const mx = cells.reduce((n, k) => n + (k % w), 0) / cells.length;
    const my = cells.reduce((n, k) => n + Math.floor(k / w), 0) / cells.length;
    return cells.reduce((a, b) => (Math.hypot((b % w) - mx, Math.floor(b / w) - my) < Math.hypot((a % w) - mx, Math.floor(a / w) - my) ? b : a));
  }

  private panels(): void {
    const c = this.c;
    const a = c.arena;
    const o = outcome(this.start, c);
    const rigs = c.roster
      .map((k, u) => ({ k, u }))
      .filter(({ u }) => teamOf(c, u) === SQUAD)
      .map(({ k, u }) => {
        const f = FIGHTERS[k];
        const state = c.hp[u]! <= 0 ? "down" : this.acted.has(u) ? "done" : u === this.selected ? "selected" : "";
        const roof = structureAt(c, c.pos[u]!) >= 0 ? `<span class="tag">on a roof</span>` : "";
        // each weapon a card (D-172): its name, what it does in short, the whole on hover
        const weapons = weaponsOf(c, u)
          .map(
            (w, i) =>
              `<button class="weapon${u === this.selected && i === this.weapon && this.phase === "strike" ? " on" : ""}" data-rig="${u}" data-weapon="${i}" title="${w.name}: ${weaponWhat(w)}">${w.name}<small>${weaponShort(w)}</small></button>`,
          )
          .join("");
        // a joint finale (D-187): the other squad's rigs named as theirs
        const theirs = this.joint && !this.joint.mine.has(u) ? ` <small class="theirs">${this.joint.partner}</small>` : "";
        return `<div class="card ${state}${theirs ? " partner" : ""}" data-rig="${u}"><b>${f.name}</b>${theirs} <span class="hp">${pips(c.hp[u]!, f.hp)}</span> ${roof}<div class="weapons">${weapons}</div></div>`;
      })
      .join("");
    const order = this.order(c);
    const threats = [...order.entries()]
      .map(([u, n]) => {
        const f = FIGHTERS[c.roster[u]!];
        const { unit: v, structure: sid } = strikeTarget(c, u, aimOf(c, u));
        const st = sid >= 0 ? a.structures[sid]! : null;
        const at = v >= 0
          ? FIGHTERS[c.roster[v]!].name
          : st
            ? `${st.name.replace(/^building\./, "").replace(/\./g, " ")} · ${c.evacuated[sid] ? "empty" : `${st.people} people`}${st.topple ? ` · topples ${st.topple}` : ""}`
            : "nothing";
        return `<div class="threat"><b>${n}</b> ${f.name} <span class="hp">${pips(c.hp[u]!, f.hp)}</span> → ${weaponsOf(c, u)[0]!.name} ${DIR_NAMES[c.aim[u]!]}: ${at}</div>`;
      })
      .join("");
    const arrivals = arriving(c)
      .map(({ kind }) => `<div class="threat arrive">▼ ${FIGHTERS[kind].name} arrives at the round's end</div>`)
      .join("");
    const outlook = !this.assist
      ? ""
      : `<div class="outlook ${this.outlook}">${
          {
            checking: "Outlook: thinking…",
            fight: "Outlook: the block can be held to the end",
            round: this.rounds - this.c.round > 1 ? "Outlook: this round can be held, not every round after" : "Outlook: this round can be held",
            lost: "Outlook: this round can't be held without losses",
            unknown: "Outlook: unclear",
          }[this.outlook]
        }</div>`;
    const round = Math.min(this.rounds, c.round + 1);
    // the bonus objectives (D-199): each with where it stands
    const ICON = { met: "✓", failed: "✗", open: "○" } as const;
    const bonus = this.puzzle.objectives?.length
      ? `<div class="bonus"><span class="head">Bonus</span>${this.puzzle.objectives
          .map((ob) => {
            const st = objectiveState(ob, this.start, c, this.phase === "over");
            return `<span class="goal ${st}">${ICON[st]} ${objectiveText(ob, this.start)}</span>`;
          })
          .join("")}<span class="pay">★ ${BONUS_REPUTATION} each</span></div>`
      : "";
    this.hud.innerHTML = `
      <div class="top"><b>${this.title}</b> · round ${round} of ${this.rounds} · ${Math.round(o.lost)} people lost${outlook}</div>
      ${bonus}
      <div class="squad">${rigs}<div class="keys">Click a rig, a cell, a target. <kbd>←↑→↓</kbd> cursor · <kbd>Space</kbd> act there · <kbd>Tab</kbd> next rig / weapon · <kbd>X</kbd> hold fire · right-click, <kbd>Esc</kbd> back · <kbd>WASD</kbd>/drag pan · <kbd>Q</kbd>/<kbd>E</kbd> turn · <kbd>1</kbd>–<kbd>6</kbd> zoom · <kbd>M</kbd> larger map · <kbd>C</kbd> the city · <kbd>V</kbd> cutaway always</div></div>
      <div class="threats"><div class="head">Invaders strike in order</div>${threats || "<div class=threat>none aiming</div>"}${arrivals}</div>
      <div class="bar">
        <button data-act="end" ${this.phase === "busy" || this.phase === "over" ? "disabled" : ""}>End turn <kbd>Enter</kbd></button>
        <button data-act="reset" ${this.resets <= 0 || this.phase === "busy" || this.phase === "over" ? "disabled" : ""}>Reset turn <kbd>U</kbd> · ${this.resets} left</button>
        <button data-act="hint" ${this.hints <= 0 || this.phase === "busy" || this.phase === "over" ? "disabled" : ""}>Hint <kbd>H</kbd> · ${this.hints} left</button>
        <button data-act="assist">Outlook ${this.assist ? "on" : "off"} <kbd>O</kbd></button>
      </div>
      <div class="say"></div>`;
    this.hud.querySelector<HTMLElement>(".say")!.textContent = this.message;
    this.hud.onclick = (e) => {
      const t = e.target as HTMLElement;
      const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act) return void this.key({ end: "enter", reset: "u", hint: "h", assist: "o" }[act]!);
      const weapon = t.closest<HTMLElement>("[data-weapon]");
      if (weapon) return this.chooseWeapon(Number(weapon.dataset.rig), Number(weapon.dataset.weapon));
      const card = t.closest<HTMLElement>("[data-rig]");
      if (card) this.select(Number(card.dataset.rig));
    };
  }

  private message = "";
  private say(text: string): void {
    this.message = text;
    const el = this.hud.querySelector<HTMLElement>(".say");
    if (el) el.textContent = text;
  }

  private checkOutlook(): void {
    if (!this.assist || this.phase === "over") return;
    const token = ++this.outlookToken;
    this.outlook = "checking";
    void this.brain.outlook(this.c, this.rounds - this.c.round, [...this.acted]).then((o) => {
      if (token !== this.outlookToken) return;
      this.outlook = o;
      this.panels();
    });
  }

  // ---------------------------------------------------------------- input

  private select(u: number): void {
    const c = this.c;
    if (this.phase === "busy" || this.phase === "over" || teamOf(c, u) !== SQUAD || c.hp[u]! <= 0 || this.acted.has(u)) return;
    // a joint finale (D-187): this squad's rigs, one rig at a time across both squads
    if (this.joint && (!this.joint.mine.has(u) || this.partnerActing)) {
      this.say(!this.joint.mine.has(u) ? `That's ${this.joint.partner}'s rig.` : `${this.joint.partner} is acting: a moment.`);
      return this.paint();
    }
    // in the strike phase, the rig moved put back first (itself chosen again: its move taken again, from where it started)
    if (this.phase === "strike") this.cancelMove();
    this.joint?.take(u);
    if (u !== this.selected) this.hopAt.set(u, this.now);
    this.selected = u;
    this.moveFrom = c.pos[u]!;
    this.weapon = 0;
    this.lift = -1;
    this.phase = "move";
    this.hint = [];
    this.confirmEnd = false;
    this.say(`${FIGHTERS[c.roster[u]!].name}: click where it moves (its own cell to stay). Right-click to cancel.`);
    this.paint();
  }

  private chooseWeapon(u: number, w: number): void {
    if (u !== this.selected || this.phase !== "strike") return;
    this.weapon = w;
    this.lift = -1;
    this.preview = null;
    this.say(this.strikePrompt());
    this.paint();
  }

  private strikePrompt(): string {
    const w = weaponsOf(this.c, this.selected)[this.weapon]!;
    if (w.kind === "hoist") return this.lift >= 0 ? "Click where to set it down." : "Hoist: click the unit beside the crane to lift.";
    if (w.kind === "evacuate") return "Evacuate: click the building beside it (its people are out by the round's end).";
    return `${w.name}: ${weaponWhat(w)}. Point at a target to see what it does, click to strike. Tab for another weapon, X to hold fire, right-click to take the move back.`;
  }

  /** Take back the selected rig's move this activation. */
  private cancelMove(): void {
    if (this.selected < 0) return;
    this.joint?.cancel();
    if (this.phase === "strike" && this.moveFrom >= 0) {
      moveUnit(this.c, this.selected, this.moveFrom);
      this.sync();
    }
    this.selected = -1;
    this.phase = "pick";
    this.lift = -1;
    this.preview = null;
  }

  /**
   * How much of each cut building of the fight shows (D-166): all of it,
   * solid, unless it stands in the way, in front of a unit or of the cell
   * looked at, where it's faint; the building under the selected unit or the
   * cell looked at nearly solid, even in the way, so where they are reads.
   */
  private ghostAlphas(c: Combat, focus: number): number[] {
    if (!this.cutting) return [];
    const side = this.side(this.view.camera.rotation);
    const a = c.arena;
    const inWay = new Set<number>();
    for (let u = 0; u < c.roster.length; u++) if (c.hp[u]! > 0) for (const id of side.blockers[c.pos[u]!] ?? []) inWay.add(id);
    if (focus >= 0) for (const id of side.blockers[focus] ?? []) inWay.add(id);
    const lit = new Set<number>();
    for (const u of [this.selected, this.striking]) if (u >= 0 && a.struct[c.pos[u]!]! >= 0) lit.add(a.struct[c.pos[u]!]!);
    if (focus >= 0 && a.struct[focus]! >= 0) lit.add(a.struct[focus]!);
    return this.ghosts.map((id) => (lit.has(id) ? GHOST_LIT : inWay.has(id) ? GHOST : 1));
  }

  /** The cells hidden now (dashed on the glass): behind a building left whole, or one of the fight's drawn solid (D-166). */
  private hiddenNow(c: Combat, alphas: readonly number[]): Uint8Array {
    const side = this.side(this.view.camera.rotation);
    if (!this.cutting) return side.hiddenRest;
    const solid = new Set(this.ghosts.filter((_, n) => (alphas[n] ?? 1) >= GHOST_LIT));
    const out = new Uint8Array(side.hidden);
    for (let k = 0; k < out.length; k++) if (!out[k] && (side.blockers[k] ?? []).some((id) => id !== c.arena.struct[k] && solid.has(id))) out[k] = 1;
    return out;
  }

  /**
   * Whether the cutaway shows (D-167): the board's buildings stand whole, a
   * unit they hide seen as a silhouette, till it's looked at closely: a rig
   * chosen, a move playing out, a unit or a hidden cell under the pointer or
   * the cursor (or V, always). It stays a moment after.
   */
  private cutawayWanted(c: Combat, focus: number): boolean {
    const hidden = this.side(this.view.camera.rotation).hiddenRest;
    const want = this.pinned || this.selected >= 0 || this.phase === "busy" || (focus >= 0 && (c.occ[focus]! >= 0 || !!hidden[focus]));
    if (want || this.phase === "over") {
      this.cutTill = 0;
      return want;
    }
    // it stays a moment from when it stopped being called for
    const now = performance.now();
    if (this.cutting && !this.cutTill) this.cutTill = now + CUT_LINGER_MS;
    if (now < this.cutTill) {
      clearTimeout(this.cutTimer);
      this.cutTimer = window.setTimeout(() => this.paint(), this.cutTill - now + 10);
      return true;
    }
    this.cutTill = 0;
    return false;
  }

  /** The cell looked at: the pointer's, else the keyboard's. */
  private focus(): number {
    return this.hover >= 0 ? this.hover : this.cursor;
  }

  /** What stands on a cell, said beside it: a unit's moves and weapons or aim, a building's height, people and strength, the ground's dangers. */
  private inspect(c: Combat, k: number): void {
    if (k < 0 || this.phase === "busy" || this.phase === "over") {
      this.tip.hidden = true;
      return;
    }
    const a = c.arena;
    const lines: string[] = [];
    const u = c.occ[k]!;
    if (u >= 0) {
      const f = FIGHTERS[c.roster[u]!];
      const squad = teamOf(c, u) === SQUAD;
      lines.push(`<b class="${squad ? "rig" : "invader"}">${f.name}</b> ${pips(c.hp[u]!, f.hp)}${squad && this.acted.has(u) ? " · done" : ""}`);
      lines.push(`moves ${f.move} · ${f.flying ? "flies" : f.climb >= 1e3 ? "climbs any wall" : `climbs ${f.climb} m`}${f.leaps ? " · leaps roof to roof" : ""}`);
      const arms = weaponsOf(c, u);
      for (const w of squad ? arms : arms.slice(0, 1)) lines.push(`· ${w.name}: ${weaponWhat(w)}`);
      if (arms.some((w) => w.damage > 0)) lines.push(`a point more striking from ${HIGH_GROUND_M} m above`);
      if (!squad && c.aim[u]! >= 0) {
        const { unit: v, structure: sid } = strikeTarget(c, u, aimOf(c, u));
        lines.push(`aims ${DIR_NAMES[c.aim[u]!]} at ${v >= 0 ? FIGHTERS[c.roster[v]!].name : sid >= 0 ? `a building (${a.structures[sid]!.people} people)` : "nothing"}; strikes ${this.order(c).get(u) ?? "—"}${["st", "nd", "rd"][(this.order(c).get(u) ?? 4) - 1] ?? "th"}`);
      }
    }
    const sid = a.struct[k]!;
    if (sid >= 0) {
      const st = a.structures[sid]!;
      const m = Math.round(riseAt(c, k));
      if (c.structHp[sid]! <= 0) lines.push("<b>rubble</b>");
      else {
        lines.push(`<b>${st.name.replace(/^building\./, "").replace(/\./g, " ")}</b> · ${m} m tall`);
        lines.push(`${c.evacuated[sid] ? "empty" : `${st.people} people`} · ${c.structHp[sid]} hp${st.topple ? ` · topples ${st.topple} cells` : ""}${st.flammable ? " · burns" : ""}`);
        if (a.floor === undefined) lines.push(m <= 15 ? "rigs can climb onto it" : "too tall for the rigs to climb; crawlers can");
      }
    } else if (a.flags[k]! & A_WATER) lines.push("<b>water</b>: a unit pushed in drowns (not flyers)");
    if (isBurning(c, k)) lines.push(`<b>burning</b>: hurts who stands here; spreads to the trees and grass beside it at the round's end${c.fire[k] === 2 ? ", then burns out" : ""}`);
    else if (c.fire[k] === FIRE_ASH) lines.push("<b>burnt out</b>: won't burn again");
    else if (a.flags[k]! & A_BURNS && sid < 0) lines.push("trees or grass: burns, and fire spreads through it");
    // out of the rig in hand's reach by a climb (B)
    const up = this.blockedNow.get(k);
    if (up !== undefined && this.selected >= 0) {
      const f = FIGHTERS[c.roster[this.selected]!];
      lines.push(`<b>out of reach</b> for the ${f.name.toLowerCase()}: ${Number.isFinite(up) ? `${Math.ceil(up)} m up from where it gets to` : "behind a climb"}; it climbs ${f.climb} m`);
    }
    const arrival = arriving(c).find((x) => x.at === k);
    if (arrival) lines.push(`▼ a ${FIGHTERS[arrival.kind].name} lands here at the round's end: stand here to block it (1 damage)`);
    if (!lines.length) {
      this.tip.hidden = true;
      return;
    }
    this.tip.innerHTML = lines.join("<br>");
    this.tip.hidden = false;
    this.tipAt = k;
  }

  /** The first rig still to act's cell (where the cursor starts). */
  private firstRig(): number {
    const u = this.c.roster.findIndex((_, v) => teamOf(this.c, v) === SQUAD && this.c.hp[v]! > 0 && !this.acted.has(v));
    return u >= 0 ? this.c.pos[u]! : 0;
  }

  /** The pointer over a world point (and its height, as picked): in the strike phase, what the strike there would do. */
  /**
   * A tap on a touch screen (D-190): as a click, but a strike's target is
   * tapped twice, the first showing what the strike does (there's no hover to
   * show it).
   */
  tap(x: number, y: number, object?: number, h?: number): void {
    const k = this.cellUnder(x, y, object, h);
    if (this.phase === "strike" && k >= 0 && k !== this.tapped && this.targets(this.selected).has(k)) {
      this.tapped = k;
      this.pointer(x, y, object, h);
      return;
    }
    this.tapped = -1;
    this.click(x, y, object, h);
  }

  pointer(x: number, y: number, object?: number, h?: number): void {
    const hk = this.cellUnder(x, y, object, h);
    if (hk !== this.hover) {
      this.hover = hk;
      this.paint();
    }
    if (this.phase !== "strike") {
      if (this.preview) {
        this.preview = null;
        this.paint();
      }
      return;
    }
    const k = hk;
    const s = k >= 0 ? this.targets(this.selected).get(k) : undefined;
    if (!s || s.to === -1) {
      if (this.preview) {
        this.preview = null;
        this.say(this.strikePrompt());
        this.paint();
      }
      return;
    }
    const key = `${this.selected}:${this.weapon}:${k}:${s.dir}:${s.range}:${s.to ?? -1}`;
    if (this.preview?.key === key) return;
    const c = this.c;
    const d = cloneCombat(c);
    const log: CombatEvent[] = [];
    strike(d, this.selected, s, log);
    const arrows: Arrow[] = [];
    const tags: { k: number; text: string; cls: string }[] = [];
    const slides: { from: number; to: number }[] = [];
    for (const e of log) {
      if (e.t === "push" || e.t === "hoist") slides.push({ from: e.from, to: e.to });
      if (e.t === "push" || e.t === "hoist") arrows.push({ from: this.ij(e.from), to: this.ij(e.to), kind: "move", style: e.t === "hoist" ? "arc" : "path" });
      if (e.t === "damage") tags.push({ k: d.pos[e.unit]!, text: `−${e.amount}`, cls: "hurt" });
      if (e.t === "down") tags.push({ k: e.at, text: e.drowned ? "drowns" : "down", cls: "hurt" });
      if (e.t === "fall") tags.push({ k: d.pos[e.unit]!, text: "falls", cls: "hurt" });
      if (e.t === "structure") tags.push({ k: d.arena.structures[e.id]!.cells[0]!, text: e.people >= 0.5 ? `−${Math.round(e.people)} people` : `−${e.amount}`, cls: "lost" });
      if (e.t === "evacuate") tags.push({ k: d.arena.structures[e.id]!.cells[0]!, text: "evacuate", cls: "good" });
    }
    const hurt = d.arena.structures.flatMap((_, id) => (d.structHp[id]! < c.structHp[id]! ? [id] : []));
    const text = this.consequences(c, d, log);
    this.preview = { state: d, arrows, tags, hurt, slides, text, key };
    this.say(this.tapped === k ? `${text} Tap it again to strike.` : text);
    this.paint();
  }

  /**
   * What a strike does, in words (D-191): each unit it hurts, downs or moves, each building it hurts or brings down and the people
   * lost there; then the round's end if nothing else acts, with the people it loses against those lost without the strike.
   */
  private consequences(c: Combat, d: Combat, log: readonly CombatEvent[]): string {
    const name = (u: number) => FIGHTERS[c.roster[u]!].name;
    const said: string[] = [];
    for (let u = 0; u < c.roster.length; u++) {
      if (c.hp[u]! <= 0 || u === this.selected) continue;
      const bits: string[] = [];
      if (d.hp[u]! <= 0) bits.push(log.some((e) => e.t === "down" && e.unit === u && e.drowned) ? "drowns" : "down");
      else if (d.hp[u]! < c.hp[u]!) bits.push(`${c.hp[u]}→${d.hp[u]} hp`);
      if (d.hp[u]! > 0 && d.pos[u] !== c.pos[u]) bits.push("pushed");
      if (bits.length) said.push(`${name(u)} ${bits.join(", ")}`);
    }
    d.arena.structures.forEach((st, id) => {
      if (d.structHp[id]! >= c.structHp[id]!) return;
      const people = log.reduce((n, e) => n + (e.t === "structure" && e.id === id ? e.people : 0), 0);
      const what = st.name.replace(/^building\./, "").replace(/\./g, " ");
      said.push(`${what} ${d.structHp[id]! <= 0 ? "comes down" : `${c.structHp[id]}→${d.structHp[id]} hp`}${people >= 0.5 ? `, ${Math.round(people)} people lost` : ""}`);
    });
    // the round played out from here, the invaders striking where they now aim
    const lostBy = (from: Combat) => {
      const e = cloneCombat(from);
      resolveInvaders(e);
      endRound(e);
      return Math.round(e.lost - c.lost);
    };
    const withIt = lostBy(d);
    const without = lostBy(c);
    const end = withIt === without ? `the round ends with ${withIt} people lost, as without it` : `the round ends with ${withIt} people lost (${without} without it)`;
    return `${said.length ? `${said.join(" · ")}. ` : "It hits nothing. "}If nothing else acts, ${end}.`;
  }

  /**
   * The cell a click or hover means; for a building's face in the strike
   * phase, the cell of it a strike lands on. The board's cell under a picked point (the ground's, and its height): up
   * the view ray from it, the first cell whose drawn top it meets, from the
   * camera's side: a roof, a rooftop board's floor over its chasm (D-180),
   * else the ground. The pick sees only the ground, through buildings. As
   * drawn: a building the cutaway cuts is glass, met only at its roof, what's
   * behind it seen through; of what's seen there, a cell the move or strike in
   * hand can take is picked first, then a unit, then a unit's silhouette behind.
   */
  private cellUnder(x: number, y: number, object?: number, h?: number): number {
    let k = boardCellAt(this.board, x, y);
    const side = this.side(this.view.camera.rotation);
    const glass = this.cutting ? side.cuts : null;
    if (h !== undefined) {
      const c = this.c;
      const [tx, ty] = towardCamera(this.view, this.view.camera.rotation);
      const hidden = this.cutting ? side.hidden : side.hiddenRest;
      const silhouette = (q: number) => c.occ[q]! >= 0 && !!hidden[q];
      let top = h;
      for (let q = 0; q < c.arena.w * c.arena.h; q++) top = Math.max(top, planeAt(c, q));
      const rise = rayRise(this.view);
      // the cells drawn under the pointer, nearest first: what the ray meets, through glass what's behind it, the ground last
      const seen: number[] = [];
      const behind: number[] = [];
      let opaque = false;
      const meet = (q: number, isGlass: boolean) => {
        if (seen.includes(q)) return;
        if (opaque) {
          if (silhouette(q) && !behind.includes(q)) behind.push(q);
          return;
        }
        seen.push(q);
        if (!isGlass) opaque = true;
      };
      for (let t = (top - h) / rise; t > 0; t -= 0.05) {
        const q = boardCellAt(this.board, x + t * tx, y + t * ty);
        if (q < 0 || h + rise * t > planeAt(c, q)) continue;
        const sid = structureAt(c, q);
        const isGlass = !!glass && sid >= 0 && glass.has(c.arena.structures[sid]!.object);
        // glass is met at its roof only
        if (isGlass && boardCellAt(this.board, x + ((planeAt(c, q) - h) / rise) * tx, y + ((planeAt(c, q) - h) / rise) * ty) !== q) continue;
        meet(q, isGlass);
      }
      if (k >= 0) meet(k, false);
      // a cell the move or strike in hand can take, else another unit drawn there, else one's silhouette behind, else the nearest
      const usable = (q: number) =>
        this.selected >= 0 && (this.phase === "move" ? movesOf(c, this.selected).includes(q) : this.phase === "strike" && this.targets(this.selected).has(q));
      k = [...seen, ...behind].find(usable) ?? seen.find((q) => c.occ[q]! >= 0 && c.occ[q] !== this.selected) ?? behind[0] ?? seen[0] ?? k;
    }
    if (this.phase === "strike" && object !== undefined && !glass?.has(object))
      for (const t of this.targets(this.selected).keys()) {
        const sid = this.c.arena.struct[t]!;
        if (sid >= 0 && this.c.arena.structures[sid]!.object === object) k = t;
      }
    return k;
  }

  click(x: number, y: number, object?: number, h?: number): void {
    if (this.phase === "busy" || this.phase === "over") return;
    const c = this.c;
    const k = this.cellUnder(x, y, object, h);
    if (k < 0) return;
    const u = c.occ[k]!;
    if (u >= 0 && teamOf(c, u) === SQUAD && !this.acted.has(u) && !(this.phase === "move" && u === this.selected) && (this.phase !== "strike" || (this.lift < 0 && !this.targets(this.selected).has(k)))) return this.select(u);
    if (this.phase === "move" && movesOf(c, this.selected).includes(k)) {
      const log: CombatEvent[] = [];
      moveUnit(c, this.selected, k, log);
      this.phase = "busy";
      this.paint();
      void this.steps(this.animate(log)).then(() => {
        this.phase = "strike";
        if (this.cursor >= 0) {
          // the keyboard's cursor on a target: an invader's first, else anyone's, else the first
          const ts = [...this.targets(this.selected).keys()];
          const who = (t: number) => (this.c.occ[t]! >= 0 ? (teamOf(this.c, this.c.occ[t]!) === INVADERS ? 2 : 1) : 0);
          this.cursor = ts.sort((p, q) => who(q) - who(p))[0] ?? this.cursor;
        }
        this.sync();
        this.say(this.strikePrompt());
        this.paint();
      });
      return;
    }
    // a cell it can't reach (D-190): said, not passed over in silence
    if (this.phase === "move") {
      const f = FIGHTERS[c.roster[this.selected]!];
      const up = this.blockedNow.get(k);
      const why = up !== undefined && Number.isFinite(up) ? `${Math.ceil(up)} m up, and the ${f.name.toLowerCase()} climbs ${f.climb} m` : `the ${f.name.toLowerCase()} moves ${f.move} and climbs ${f.climb} m`;
      this.say(`Out of reach: ${why}. Click a green cell, or right-click to cancel.`);
      return this.paint();
    }
    if (this.phase !== "strike") return;
    const s = this.targets(this.selected).get(k);
    if (!s) return;
    if (s.to === -1) {
      this.lift = s.dir;
      this.say(this.strikePrompt());
      return this.paint();
    }
    this.act(s);
  }

  private act(s: Strike | null): Promise<void> {
    const u = this.selected;
    const log: CombatEvent[] = [];
    // where it struck from: a charge moves it on
    const a: Action = { unit: u, dest: this.c.pos[u]!, strike: s };
    this.turns[this.turns.length - 1]!.push(a);
    this.joint?.act(a);
    if (s) strike(this.c, u, s, log);
    this.acted.add(u);
    this.selected = -1;
    this.preview = null;
    this.hint = [];
    this.confirmEnd = false;
    this.phase = "busy";
    this.paint();
    return this.steps(this.animate(log)).then(() => {
      this.sync();
      this.phase = "pick";
      this.checkOutlook();
      const left = this.c.roster.some((_, v) => teamOf(this.c, v) === SQUAD && this.c.hp[v]! > 0 && !this.acted.has(v) && (!this.joint || this.joint.mine.has(v)));
      this.say(this.routed() ? "Every invader down: end the turn to finish the fight." : left ? "Click another rig, or end the turn." : "Every rig has acted: end the turn.");
      this.paint();
    });
  }

  /** Every invader down and none still to arrive: the next turn's end finishes the fight. */
  private routed(): boolean {
    return !this.c.roster.some((_, u) => teamOf(this.c, u) === INVADERS && this.c.hp[u]! > 0) && !this.c.schedule.slice(this.c.round).some((r) => r.length);
  }

  key(k: string): boolean {
    if (k === "v") {
      this.pinned = !this.pinned;
      this.say(this.pinned ? "What hides the board stays cut down (V: only while you look closely)." : "What hides the board is cut down while you look closely (V: always).");
      this.paint();
      return true;
    }
    if (k === "m") {
      this.map.toggle();
      return true;
    }
    if (k === "o") {
      this.assist = !this.assist;
      if (this.assist) this.checkOutlook();
      this.panels();
      return true;
    }
    if (this.phase === "busy" || this.phase === "over") return false;
    if (k === "escape") {
      this.cancelMove();
      this.say("Click a rig.");
      this.paint();
      return true;
    }
    const step = { arrowright: this.stepU, arrowdown: this.stepV, arrowleft: [-this.stepU[0], -this.stepU[1]], arrowup: [-this.stepV[0], -this.stepV[1]] }[k];
    if (step) {
      const a = this.c.arena;
      const from = this.cursor >= 0 ? this.cursor : this.selected >= 0 ? this.c.pos[this.selected]! : this.firstRig();
      const i = Math.max(0, Math.min(a.w - 1, (from % a.w) + step[0]!));
      const j = Math.max(0, Math.min(a.h - 1, Math.floor(from / a.w) + step[1]!));
      this.cursor = this.cursor < 0 ? from : j * a.w + i;
      const p = this.centre(this.cursor);
      this.pointer(p.x, p.y);
      this.paint();
      return true;
    }
    if (k === " " && this.cursor >= 0) {
      const p = this.centre(this.cursor);
      this.click(p.x, p.y);
      return true;
    }
    if (k === "tab" && (this.phase === "pick" || this.phase === "move")) {
      // the next rig still to act, after the one selected (or under the cursor)
      const rigs = this.c.roster.map((_, u) => u).filter((u) => teamOf(this.c, u) === SQUAD && this.c.hp[u]! > 0 && !this.acted.has(u) && (!this.joint || this.joint.mine.has(u)));
      if (!rigs.length) return true;
      const at = this.selected >= 0 ? this.selected : rigs.find((u) => this.c.pos[u] === this.cursor);
      const u = rigs[(at === undefined ? 0 : rigs.indexOf(at) + 1) % rigs.length]!;
      this.cursor = this.c.pos[u]!;
      this.select(u);
      return true;
    }
    if (k === "tab" && this.phase === "strike") {
      this.chooseWeapon(this.selected, (this.weapon + 1) % weaponsOf(this.c, this.selected).length);
      return true;
    }
    if (k === "x" && this.phase === "strike") {
      void this.act(null);
      return true;
    }
    if (k === "enter") {
      void this.askEndTurn();
      return true;
    }
    if (k === "u" && this.resets > 0) {
      this.resets--;
      this.c = cloneCombat(this.turnStart);
      this.turns[this.turns.length - 1] = [];
      if (this.razedThisTurn.length) {
        this.view.edits.restore(this.razedThisTurn);
        this.resetSides();
        this.refreshArt();
      }
      this.razed = this.razed.filter((o) => !this.razedThisTurn.includes(o));
      this.razedThisTurn = [];
      this.acted = new Set();
      this.selected = -1;
      this.phase = "pick";
      this.preview = null;
      this.hint = [];
      this.sync();
      this.checkOutlook();
      this.say(`The turn taken back (${this.resets} reset${this.resets === 1 ? "" : "s"} left).`);
      this.paint();
      return true;
    }
    if (k === "h" && this.hints > 0) {
      this.hints--;
      this.say("Thinking…");
      this.panels();
      void this.brain.hint(this.c, this.rounds - this.c.round, [...this.acted]).then((h) => {
        if (!h) return this.say("No turn left to play.");
        const d = cloneCombat(this.c);
        this.hint = [];
        const words: string[] = [];
        for (const x of h.plan) {
          const f = FIGHTERS[d.roster[x.unit]!];
          if (x.dest !== d.pos[x.unit]) this.hint.push({ from: this.ij(d.pos[x.unit]!), to: this.ij(x.dest), kind: "move" });
          moveUnit(d, x.unit, x.dest);
          const t = x.strike ? strikeCell(d, x.unit, x.strike) : -1;
          if (t >= 0) this.hint.push({ from: this.ij(x.dest), to: this.ij(x.strike?.to ?? t), kind: "info", style: arrowStyle(weaponsOf(d, x.unit)[x.strike!.weapon]!.kind) });
          words.push(`${f.name}: ${x.strike ? weaponsOf(d, x.unit)[x.strike.weapon]!.name : "stand"}`);
          if (x.strike) strike(d, x.unit, x.strike);
        }
        const holds = { fight: "keeps the whole fight winnable", round: "holds this round (no turn keeps every later round safe)", best: "loses the fewest (no turn loses nobody)" }[h.holds];
        this.say(`Hint, a turn that ${holds}: ${words.join(" · ")} (green arrows: moves; yellow: strikes).`);
        this.paint();
      });
      return true;
    }
    return false;
  }

  /** Right-click: back a step (take the move back, or drop the selection). */
  back(): void {
    if (this.phase === "busy" || this.phase === "over") return;
    if (this.phase === "strike" && this.lift >= 0) this.lift = -1;
    else this.cancelMove();
    this.say(this.phase === "strike" ? this.strikePrompt() : "Click a rig.");
    this.paint();
  }

  // ---------------------------------------------------------------- the round

  /** Enter: the selected rig holds fire; with rigs still to act, the first press asks, the second ends the turn. */
  private async askEndTurn(): Promise<void> {
    if (this.phase === "strike") await this.act(null);
    else if (this.phase === "move") this.cancelMove();
    const idle = this.c.roster.filter((_, u) => teamOf(this.c, u) === SQUAD && this.c.hp[u]! > 0 && !this.acted.has(u) && (!this.joint || this.joint.mine.has(u))).length;
    if (idle && !this.confirmEnd && !this.routed()) {
      this.confirmEnd = true;
      this.say(`${idle === 1 ? "A rig hasn't" : `${idle} rigs haven't`} acted: Enter again to end the turn anyway.`);
      return this.paint();
    }
    this.confirmEnd = false;
    if (this.joint) {
      // the invaders' turn comes once the other squad has ended its turn too (`jointTurn`)
      this.waiting = true;
      this.phase = "busy";
      this.say(`Waiting for ${this.joint.partner} to end the turn…`);
      this.paint();
      return this.joint.end();
    }
    await this.endTurn();
  }

  /** Who has the baton in a joint finale (D-187): this page, the other squad, or nobody. */
  jointBaton(mine: boolean | null): void {
    this.partnerActing = mine === false;
    // the other squad asked first: this page's rig put back
    if (mine === false && this.selected >= 0 && !this.waiting) {
      if (this.phase === "strike" && this.moveFrom >= 0) moveUnit(this.c, this.selected, this.moveFrom);
      this.selected = -1;
      this.phase = "pick";
      this.preview = null;
      this.sync();
      this.say(`${this.joint?.partner ?? "The other squad"} is acting: a moment.`);
    }
    this.paint();
  }

  /** The other squad's rig acted (D-187): its move and strike, shown. */
  jointAct(a: Action): void {
    this.partnerActing = false;
    const log: CombatEvent[] = [];
    if (a.dest !== this.c.pos[a.unit]) moveUnit(this.c, a.unit, a.dest, log);
    if (a.strike) strike(this.c, a.unit, a.strike, log);
    this.acted.add(a.unit);
    this.turns[this.turns.length - 1]!.push(a);
    void this.steps(this.animate(log)).then(() => {
      this.sync();
      this.checkOutlook();
      this.paint();
    });
    this.paint();
  }

  /** Both squads have ended the turn (D-187): the invaders' turn. */
  jointTurn(): void {
    this.waiting = false;
    this.partnerActing = false;
    this.phase = "pick";
    void this.endTurn();
  }

  private async endTurn(): Promise<void> {
    if (this.phase === "busy" || this.phase === "over") return;
    this.phase = "busy";
    this.selected = -1;
    this.preview = null;
    this.hint = [];
    this.say("The invaders strike…");
    this.paint();
    const before = cloneCombat(this.c);
    // each invader in turn, so the eye can follow
    for (let u = 0; u < this.c.roster.length; u++) {
      if (teamOf(this.c, u) !== INVADERS || this.c.hp[u]! <= 0 || this.c.aim[u]! < 0) continue;
      // a beat with the striker marked, then its strike
      this.striking = u;
      this.paint();
      await this.steps([{ ms: 380 }]);
      const log: CombatEvent[] = [];
      strike(this.c, u, aimOf(this.c, u), log);
      await this.steps([...this.animate(log), { ms: 250 }]);
      this.striking = -1;
      this.struck.add(u);
      this.sync();
      this.paint();
    }
    const log: CombatEvent[] = [];
    endRound(this.c, log);
    await this.steps(this.animate(log));
    this.sync();
    const o = outcome(before, this.c);
    if (o.perfect) this.roundsHeld++;
    const squad = this.c.roster.some((_, u) => teamOf(this.c, u) === SQUAD && this.c.hp[u]! > 0);
    if (this.routed() || !squad || this.c.round >= this.rounds) return this.over(squad);
    // the invaders move and aim again
    const aiming = cloneCombat(this.c);
    planInvaders(this.c);
    const moves: Step[] = [];
    for (let u = 0; u < this.c.roster.length; u++)
      if (teamOf(this.c, u) === INVADERS && this.c.hp[u]! > 0 && aiming.pos[u] !== this.c.pos[u]) moves.push(...this.animate([{ t: "move", unit: u, from: aiming.pos[u]!, to: this.c.pos[u]! }]));
    await this.steps(moves);
    this.sync();
    this.struck.clear();
    this.turnStart = cloneCombat(this.c);
    this.turns.push([]);
    this.acted = new Set();
    this.razedThisTurn = [];
    this.phase = "pick";
    this.checkOutlook();
    this.say(`${o.perfect ? "Nobody lost." : `${Math.round(o.lost)} people lost.`} Round ${this.c.round + 1}: the invaders have moved and aimed.`);
    this.paint();
  }

  private over(squad: boolean): void {
    this.phase = "over";
    const o = outcome(this.start, this.c);
    const result: FightOutcome = {
      held: squad && o.lost <= 0.5 && o.rigsDown === 0,
      bonuses: (this.puzzle.objectives ?? []).map((ob) => ({ text: objectiveText(ob, this.start), met: objectiveMet(ob, this.start, this.c) })),
      lost: o.lost,
      atStake: this.start.arena.structures.reduce((n, s) => n + s.people, 0),
      squadDown: !squad,
      roundsHeld: this.roundsHeld,
      rounds: this.c.round,
      invadersDown: this.c.roster.filter((_, u) => teamOf(this.c, u) === INVADERS && this.c.hp[u]! <= 0).length,
      razed: [...this.razed],
      turns: this.turns.map((t) => [...t]),
    };
    this.paint();
    setTimeout(() => this.finish(result), 700);
  }

  /** Leave the world as the fight left it (its fallen buildings stay fallen), with the fight's own things gone. */
  dispose(): void {
    this.offFrame();
    clearTimeout(this.cutTimer);
    for (const e of this.entities) e?.remove();
    for (const f of this.fx) for (const e of f.entities) e.remove();
    this.fx.clear();
    this.view.cutaway.clear();
    this.view.layers.remove(this.veil.id);
    if (this.under) this.view.layers.remove(this.under.id);
    for (const l of this.labels.values()) l.el.remove();
    this.labels.clear();
    this.hud.remove();
    this.map.el.remove();
    this.glass.dispose();
    this.tip.remove();
  }

  /** The puzzle, for a retry. */
  get source(): Pick<Puzzle, "combat" | "fight" | "objectives"> {
    return this.puzzle;
  }
}

/** What a weapon does, said whole (D-172). */
export function weaponWhat(w: Weapon): string {
  if (w.kind === "hoist") return "lifts the unit beside it up to 2 cells";
  if (w.kind === "evacuate") return "empties the building beside it by the round's end";
  const where = w.range ? `${w.range[0]}–${w.range[1]} cells` : w.kind === "shot" ? "first thing in line" : w.kind === "charge" ? "drives into the first unit in line" : "next cell";
  return `${w.damage ? `${w.damage} damage` : "no damage"}${w.push ? ", pushes" : ""}, ${where}${w.ignites ? ", sets alight" : ""}${w.douses ? ", douses" : ""}`;
}

/** What a weapon does, in a few marks for its card: damage, a push, where it reaches. */
export function weaponShort(w: Weapon): string {
  if (w.kind === "hoist") return "lift ⤴ 2";
  if (w.kind === "evacuate") return "empty a building";
  const where = w.range ? `${w.range[0]}–${w.range[1]}` : w.kind === "shot" ? "line" : w.kind === "charge" ? "charge" : "1";
  return [w.damage ? "■".repeat(w.damage) : "0", w.push ? "push" : "", `↦ ${where}`, w.ignites ? "fire" : "", w.douses ? "water" : ""].filter(Boolean).join(" · ");
}

function manhattan(w: number, p: number, q: number): number {
  return Math.abs((p % w) - (q % w)) + Math.abs(Math.floor(p / w) - Math.floor(q / w));
}
