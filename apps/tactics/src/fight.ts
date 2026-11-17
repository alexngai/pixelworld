import { boardCellAt, toWorld, type Board, type Entity, type WorldView } from "@pixelworlds/engine";
import {
  A_WATER,
  BoardOverlay,
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
  movesOf,
  moveUnit,
  outcome,
  planInvaders,
  rampsFor,
  standAt,
  strike,
  strikeCell,
  strikesOf,
  structureAt,
  teamOf,
  type Arrow,
  type Combat,
  type CombatEvent,
  type FxKind,
  type Mark,
  type Puzzle,
  type Strike,
} from "@pixelworlds/tactics";
import type { Brain, } from "./brain";
import { TacticalMap } from "./map";
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

export interface FightSetup {
  view: WorldView;
  board: Board;
  puzzle: Puzzle;
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
  lost: number;
  /** People in the board's buildings when it began. */
  atStake: number;
  squadDown: boolean;
  roundsHeld: number;
  rounds: number;
  invadersDown: number;
  /** World objects (buildings) the fight brought down. */
  razed: number[];
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
}

type Phase = "pick" | "move" | "strike" | "busy" | "over";

const DIAGONALS = [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
const angle = (dir: number) => Math.atan2(DIRS[dir]![1], DIRS[dir]![0]);
const pips = (hp: number, max: number) => "■".repeat(Math.max(0, hp)) + "□".repeat(Math.max(0, max - hp));

export class Fight {
  readonly done: Promise<FightOutcome>;
  private finish!: (o: FightOutcome) => void;
  private readonly view: WorldView;
  private readonly board: Board;
  private readonly brain: Brain;
  private readonly puzzle: Puzzle;
  private readonly rounds: number;
  private readonly title: string;
  private readonly ramps: ReturnType<typeof rampsFor>;
  private c: Combat;
  private readonly start: Combat;
  private turnStart: Combat;
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
  /** A strike under the pointer, played on a copy: what it would do. */
  private preview: { state: Combat; arrows: Arrow[]; tags: { k: number; text: string; cls: string }[] } | null = null;
  private razed: number[] = [];
  private razedThisTurn: number[] = [];
  private readonly entities: (Entity | null)[] = [];
  private readonly overlay: BoardOverlay;
  private readonly map: TacticalMap;
  /** Buildings in front of the board, out of the world while the fight lasts (D-154), and the rotation they were found for. */
  private hidden: number[] = [];
  private hiddenFor = -1;
  private readonly fires = new Map<number, Entity[]>();
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

  constructor(s: FightSetup) {
    this.done = new Promise((r) => (this.finish = r));
    this.view = s.view;
    this.board = s.board;
    this.brain = s.brain;
    this.puzzle = s.puzzle;
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
    this.overlay = new BoardOverlay(s.board, { id: "fight" });
    void this.view.layers.add(this.overlay);
    this.bestRotation();
    this.clearView();
    this.frameBoard();
    for (let u = 0; u < this.c.roster.length; u++) this.spawnEntity(u);
    this.offFrame = this.view.onFrame((e) => this.frame(e.now));
    this.checkOutlook();
    this.paint();
    const f = s.puzzle.fight;
    const traps = f && f.firstTurns > f.safeFirstTurns ? ` Careful: ${f.firstTurns - f.safeFirstTurns} of the ${f.firstTurns} first turns that lose nobody lose a later round.` : "";
    this.say(`Hold the block for ${this.rounds} rounds. Click a rig to move it.${traps}`);
  }

  /**
   * Turn the camera to the side from which the board's own buildings hide
   * the least of it: the fewest cells behind a taller building of the board
   * (a unit's cell counting three), down each cell's view ray.
   */
  private bestRotation(): void {
    const { camera } = this.view;
    const c = this.c;
    const a = c.arena;
    const start = camera.rotation;
    let best = start;
    let least = Infinity;
    for (let i = 0; i < 4; i++) {
      camera.rotation = ((start + i) % 4) as typeof start;
      // towards the camera along a screen point's ray: a cell across each way, two steps up
      const m = this.centre(0);
      const at = camera.project(m.x, m.y, 0);
      const toward = DIAGONALS.find(([dx, dy]) => {
        const q = camera.project(m.x + dx, m.y + dy, 2);
        return Math.abs(q.x - at.x) < 0.01 && Math.abs(q.y - at.y) < 0.01;
      });
      if (!toward) return void (camera.rotation = start);
      let hidden = 0;
      for (let k = 0; k < a.w * a.h; k++) {
        const p = this.centre(k);
        const h = standAt(c, k);
        for (let t = 0.25; ; t += 0.25) {
          const q = boardCellAt(this.board, p.x + t * toward[0], p.y + t * toward[1]);
          if (q < 0) break;
          if (a.struct[q]! >= 0 && a.struct[q] !== a.struct[k] && standAt(c, q) > h + 2 * t) {
            hidden += c.occ[k]! >= 0 ? 3 : 1;
            break;
          }
        }
      }
      if (hidden < least) [least, best] = [hidden, camera.rotation];
    }
    camera.rotation = best;
  }

  /**
   * Take what stands between the camera and the board out of the world (its
   * tiles bake again without it), and put back what no longer does: only the
   * fight's own buildings stay (and trees), so a slab on the board too thin
   * to count as a building no longer stands over a street the fight thinks
   * open. Picks down the view ray over the board's cells, roofs included,
   * again after each removal, for what stood behind.
   */
  private clearView(): void {
    const { camera, query, edits } = this.view;
    if (camera.rotation === this.hiddenFor) return;
    this.hiddenFor = camera.rotation;
    // the map turned as the view is
    const o = camera.project(this.centre(0).x, this.centre(0).y, 0);
    const pi = camera.project(this.centre(1).x, this.centre(1).y, 0);
    const pj = camera.project(this.centre(this.c.arena.w).x, this.centre(this.c.arena.w).y, 0);
    this.map.orient({ x: pi.x - o.x, y: pi.y - o.y }, { x: pj.x - o.x, y: pj.y - o.y });
    if (this.hidden.length) edits.restore(this.hidden);
    const a = this.c.arena;
    const keep = new Set(a.structures.map((s) => s.object));
    const found = new Set<number>();
    for (let pass = 0; pass < 6; pass++) {
      const more: number[] = [];
      for (let j = 0; j <= 2 * a.h; j++)
        for (let i = 0; i <= 2 * a.w; i++) {
          const k = Math.min(a.h - 1, j >> 1) * a.w + Math.min(a.w - 1, i >> 1);
          const p = toWorld(this.board, { x: i / 2, y: j / 2 });
          const at = camera.project(p.x, p.y, standAt(this.c, k));
          const hit = query.pickObject(at.x, at.y);
          if (hit && !keep.has(hit.index) && !found.has(hit.index) && !hit.group.startsWith("tree")) {
            found.add(hit.index);
            more.push(hit.index);
          }
        }
      if (!more.length) break;
      edits.remove(more);
    }
    this.hidden = [...found];
  }

  /** The camera on the board's middle, zoomed in as far as the board still fits about half the screen. */
  private frameBoard(): void {
    const { camera, query, canvas } = this.view;
    const a = this.c.arena;
    const middle = toWorld(this.board, { x: a.w / 2, y: a.h / 2 });
    camera.setFocus(middle.x, middle.y, query.heightAt(middle.x, middle.y) ?? 0);
    const points = [0, a.w].flatMap((i) => [0, a.h].map((j) => toWorld(this.board, { x: i, y: j }))).map((p) => camera.project(p.x, p.y, query.heightAt(p.x, p.y) ?? 0));
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const fit = Math.min((0.55 * canvas.clientWidth) / (Math.max(...xs) - Math.min(...xs)), (0.5 * canvas.clientHeight) / (Math.max(...ys) - Math.min(...ys)));
    camera.zoom = Math.min(6, Math.max(1, Math.floor(camera.zoom * fit)));
  }

  // ---------------------------------------------------------------- the world: entities, effects, labels

  private centre(k: number) {
    return toWorld(this.board, { x: (k % this.c.arena.w) + 0.5, y: Math.floor(k / this.c.arena.w) + 0.5 });
  }

  private spawnEntity(u: number, h?: number): void {
    const k = this.c.pos[u]!;
    const p = this.centre(k);
    this.entities[u] = this.view.entities.add({
      model: entityModel(this.c.roster[u]!, this.ramps, { scale: this.board.cell, renderScale: this.view.world.renderScale }),
      x: p.x,
      y: p.y,
      h: h ?? standAt(this.c, k),
      heading: teamOf(this.c, u) === INVADERS && this.c.aim[u]! >= 0 ? angle(this.c.aim[u]!) : 0,
      silhouette: true,
      // a clean cut through whatever of the board's own stands in front of it (D-154)
      reveal: { margin: 14, density: 1 },
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
        h: h ?? standAt(this.c, k),
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
    l.el.className = `label ${cls}`;
    l.el.textContent = text;
    Object.assign(l, { x: p.x, y: p.y, h: h ?? standAt(this.c, k), dy });
    if (!id) Object.assign(l, { born: this.now, until: this.now + 1100 });
  }

  private place(u: number, x: number, y: number, h: number): void {
    this.entities[u]?.moveTo(x, y, h);
  }

  /** Every unit's entity where the state has it, the fallen gone; the fires; the invaders facing their aims. */
  private sync(): void {
    const c = this.c;
    for (let u = 0; u < c.roster.length; u++) {
      if (!this.entities[u]) this.spawnEntity(u);
      const e = this.entities[u]!;
      e.visible = c.hp[u]! > 0;
      const p = this.centre(c.pos[u]!);
      e.moveTo(p.x, p.y, standAt(c, c.pos[u]!));
      if (teamOf(c, u) === INVADERS && c.aim[u]! >= 0) e.heading = angle(c.aim[u]!);
    }
    for (let k = 0; k < c.fire.length; k++) {
      const f = this.fires.get(k);
      if (c.fire[k] && !f) this.fires.set(k, this.effect("fire", k, 3, Infinity));
      else if (!c.fire[k] && f) {
        for (const e of f) e.remove();
        for (const x of this.fx) if (x.entities === f) this.fx.delete(x);
        this.fires.delete(k);
      }
    }
  }

  private frame(now: number): void {
    this.now = now;
    this.clearView();
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
      l.el.style.transform = `translate(${p.x}px, ${p.y - l.dy - rise}px)`;
      if (l.until !== undefined) l.el.style.opacity = String(Math.min(1, (l.until - now) / 400));
    }
  }

  /** Play steps in order; resolves when they (and those queued before) are done. */
  private steps(list: Step[]): Promise<void> {
    this.queue.push(...list);
    return new Promise((r) => this.idle.push(r));
  }

  /** The steps that show what a log of events did, in order, from where the entities stood. */
  private animate(log: readonly CombatEvent[]): Step[] {
    const c = this.c;
    const steps: Step[] = [];
    const tween = (u: number, from: number, to: number, ms: number, lift = 0): Step => {
      const a = this.centre(from);
      const b = this.centre(to);
      const ha = this.entities[u]?.h ?? standAt(c, from);
      const hb = standAt(c, to);
      return {
        ms,
        tick: (t) => this.place(u, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, ha + (hb - ha) * t + lift * Math.sin(Math.PI * t)),
      };
    };
    const nudge = (u: number, at: number, ms: number): Step => {
      const e = this.entities[u];
      const x0 = e?.x ?? 0;
      const y0 = e?.y ?? 0;
      const h0 = e?.h ?? 0;
      const b = this.centre(at);
      return { ms, tick: (t) => this.place(u, x0 + (b.x - x0) * 0.3 * Math.sin(Math.PI * t), y0 + (b.y - y0) * 0.3 * Math.sin(Math.PI * t), h0), end: () => this.place(u, x0, y0, h0) };
    };
    const word = (k: number, text: string, cls: string): Step => ({ ms: 0, start: () => this.label(null, k, text, cls) });
    let lastAt = -1;
    for (const e of log) {
      switch (e.t) {
        case "move":
          steps.push(tween(e.unit, e.from, e.to, Math.min(500, 130 * manhattan(c.arena.w, e.from, e.to))));
          break;
        case "strike": {
          lastAt = e.at;
          const w = FIGHTERS[c.roster[e.unit]!].weapons[e.weapon]!;
          steps.push(nudge(e.unit, e.at, 160));
          if (w.kind !== "hoist" && w.kind !== "evacuate") steps.push({ ms: 120, start: () => this.effect(w.douses ? "jet" : "blast", e.at, 3, 0.45) });
          break;
        }
        case "push":
          steps.push(tween(e.unit, e.from, e.to, 150));
          break;
        case "bump":
          steps.push(nudge(e.unit, e.at, 170), word(e.at, "bump", "hurt"));
          break;
        case "fall":
          steps.push({ ms: 0 }, word(c.pos[e.unit]!, `falls ${Math.round(e.drop * c.arena.metersPerStep)} m`, "hurt"));
          break;
        case "damage":
          steps.push(word(c.pos[e.unit]!, `−${e.amount}`, "hurt"));
          break;
        case "down": {
          const at = e.at;
          steps.push({
            ms: 220,
            start: () => this.effect(c.arena.flags[at]! & A_WATER && structureAt(c, at) < 0 ? "jet" : "blast", at, 4, 0.9),
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
          steps.push(word(at, e.people >= 0.5 ? `−${Math.round(e.people)} people` : `−${e.amount}`, "lost"));
          if (e.destroyed)
            steps.push({
              ms: 260,
              start: () => {
                for (const k of s.cells) this.effect("rubble", k, 1, Infinity, c.arena.height[k]);
                this.effect("blast", at, 4, 0.9);
                if (s.object >= 0) {
                  this.view.edits.remove([s.object]);
                  this.razed.push(s.object);
                  this.razedThisTurn.push(s.object);
                }
              },
            });
          break;
        }
        case "topple":
          steps.push(word(e.cells[0] ?? lastAt, "topples!", "lost"));
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
            tick: (t) => {
              const p = this.centre(e.at);
              this.place(e.unit, p.x, p.y, standAt(c, e.at) + 14 * (1 - t));
            },
            end: () => void this.effect("blast", e.at, 3, 0.5),
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
      if (t >= 0) out.push({ from: this.ij(s.pos[u]!), to: this.ij(t), kind: "attack" });
    }
    return out;
  }

  /** The cells a state's round would harm: struck, crushed, buildings hit. */
  private harm(s: Combat): Set<number> {
    const log: CombatEvent[] = [];
    const r = cloneCombat(s);
    for (let u = 0; u < r.roster.length; u++) if (teamOf(r, u) === INVADERS && r.hp[u]! > 0 && r.aim[u]! >= 0) strike(r, u, aimOf(r, u), log);
    const cells = new Set<number>();
    for (const e of log) {
      if (e.t === "crush") cells.add(e.at);
      if (e.t === "structure") for (const k of s.arena.structures[e.id]!.cells) cells.add(k);
      if (e.t === "damage") cells.add(r.pos[e.unit]!);
    }
    return cells;
  }

  private targets(u: number): Map<number, Strike> {
    const out = new Map<number, Strike>();
    const w = FIGHTERS[this.c.roster[u]!].weapons[this.weapon]!;
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
    if (this.phase !== "busy" && this.phase !== "over") for (const k of this.harm(shown)) mark(k, "danger");
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
    this.overlay.setMarks(marks);
    const arrows = [...this.aims(shown), ...(this.preview?.arrows ?? []), ...this.hint];
    this.overlay.setArrows(arrows);
    this.map.draw({ state: shown, marks, arrows, acted: this.acted, striking: this.striking, order: this.order(shown) });

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
      this.label(`tag-${i}`, t.k, t.text, t.cls, 52);
    });
    for (const [id, l] of this.labels)
      if (l.until === undefined && !keep.has(id)) {
        l.el.remove();
        this.labels.delete(id);
      }
    this.panels();
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
        const weapons = f.weapons
          .map((w, i) => `<button class="weapon${u === this.selected && i === this.weapon && this.phase === "strike" ? " on" : ""}" data-rig="${u}" data-weapon="${i}">${w.name}</button>`)
          .join("");
        return `<div class="card ${state}" data-rig="${u}"><b>${f.name}</b> <span class="hp">${pips(c.hp[u]!, f.hp)}</span> ${roof}<div class="weapons">${weapons}</div></div>`;
      })
      .join("");
    const order = this.order(c);
    const threats = [...order.entries()]
      .map(([u, n]) => {
        const f = FIGHTERS[c.roster[u]!];
        const t = strikeCell(c, u, aimOf(c, u));
        const sid = t >= 0 ? structureAt(c, t) : -1;
        const st = sid >= 0 ? a.structures[sid]! : null;
        const at = st
          ? `${st.name.replace(/^building\./, "").replace(/\./g, " ")} · ${c.evacuated[sid] ? "empty" : `${st.people} people`}${st.topple ? ` · topples ${st.topple}` : ""}`
          : t >= 0 && c.occ[t]! >= 0
            ? FIGHTERS[c.roster[c.occ[t]!]!].name
            : "nothing";
        return `<div class="threat"><b>${n}</b> ${f.name} <span class="hp">${pips(c.hp[u]!, f.hp)}</span> → ${f.weapons[0]!.name} ${DIR_NAMES[c.aim[u]!]}: ${at}</div>`;
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
    this.hud.innerHTML = `
      <div class="top"><b>${this.title}</b> · round ${round} of ${this.rounds} · ${Math.round(o.lost)} people lost${outlook}</div>
      <div class="squad">${rigs}<div class="keys">Click a rig, a cell, a target. <kbd>Tab</kbd> weapon · <kbd>Space</kbd> hold fire · right-click back · <kbd>WASD</kbd>/drag pan · <kbd>Q</kbd>/<kbd>E</kbd> turn · <kbd>1</kbd>–<kbd>6</kbd> zoom · <kbd>M</kbd> larger map</div></div>
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
    if (this.phase === "strike" && u !== this.selected) this.cancelMove();
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
    const w = FIGHTERS[this.c.roster[this.selected]!].weapons[this.weapon]!;
    if (w.kind === "hoist") return this.lift >= 0 ? "Click where to set it down." : "Hoist: click the unit beside the crane to lift.";
    if (w.kind === "evacuate") return "Evacuate: click the building beside it (its people are out by the round's end).";
    return `${w.name}: hover a target to see what it does, click to strike. Tab for another weapon, Space to hold fire, right-click to take the move back.`;
  }

  /** Take back the selected rig's move this activation. */
  private cancelMove(): void {
    if (this.selected < 0) return;
    if (this.phase === "strike" && this.moveFrom >= 0) {
      moveUnit(this.c, this.selected, this.moveFrom);
      this.sync();
    }
    this.selected = -1;
    this.phase = "pick";
    this.lift = -1;
    this.preview = null;
  }

  /** The pointer over a world point: in the strike phase, what the strike there would do. */
  pointer(x: number, y: number, object?: number): void {
    if (this.phase !== "strike") {
      if (this.preview) {
        this.preview = null;
        this.paint();
      }
      return;
    }
    const k = this.cellUnder(x, y, object);
    const s = k >= 0 ? this.targets(this.selected).get(k) : undefined;
    if (!s || s.to === -1) {
      if (this.preview) {
        this.preview = null;
        this.paint();
      }
      return;
    }
    const d = cloneCombat(this.c);
    const log: CombatEvent[] = [];
    strike(d, this.selected, s, log);
    const arrows: Arrow[] = [];
    const tags: { k: number; text: string; cls: string }[] = [];
    for (const e of log) {
      if (e.t === "push" || e.t === "hoist") arrows.push({ from: this.ij(e.from), to: this.ij(e.to), kind: "move" });
      if (e.t === "damage") tags.push({ k: d.pos[e.unit]!, text: `−${e.amount}`, cls: "hurt" });
      if (e.t === "down") tags.push({ k: e.at, text: e.drowned ? "drowns" : "down", cls: "hurt" });
      if (e.t === "fall") tags.push({ k: d.pos[e.unit]!, text: "falls", cls: "hurt" });
      if (e.t === "structure") tags.push({ k: d.arena.structures[e.id]!.cells[0]!, text: e.people >= 0.5 ? `−${Math.round(e.people)} people` : `−${e.amount}`, cls: "lost" });
      if (e.t === "evacuate") tags.push({ k: d.arena.structures[e.id]!.cells[0]!, text: "evacuate", cls: "good" });
    }
    this.preview = { state: d, arrows, tags };
    this.paint();
  }

  /** The cell a click or hover means: the ground's, or for a building's face, the cell of it a strike lands on. */
  private cellUnder(x: number, y: number, object?: number): number {
    let k = boardCellAt(this.board, x, y);
    if (this.phase === "strike" && object !== undefined)
      for (const t of this.targets(this.selected).keys()) {
        const sid = this.c.arena.struct[t]!;
        if (sid >= 0 && this.c.arena.structures[sid]!.object === object) k = t;
      }
    return k;
  }

  click(x: number, y: number, object?: number): void {
    if (this.phase === "busy" || this.phase === "over") return;
    const c = this.c;
    const k = this.cellUnder(x, y, object);
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
        this.sync();
        this.say(this.strikePrompt());
        this.paint();
      });
      return;
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
      const left = this.c.roster.some((_, v) => teamOf(this.c, v) === SQUAD && this.c.hp[v]! > 0 && !this.acted.has(v));
      this.say(left ? "Click another rig, or end the turn." : "Every rig has acted: end the turn.");
      this.paint();
    });
  }

  key(k: string): boolean {
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
    if (k === "tab" && this.phase === "strike") {
      this.chooseWeapon(this.selected, (this.weapon + 1) % FIGHTERS[this.c.roster[this.selected]!].weapons.length);
      return true;
    }
    if (k === " " && this.phase === "strike") {
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
      if (this.razedThisTurn.length) this.view.edits.restore(this.razedThisTurn);
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
          if (t >= 0) this.hint.push({ from: this.ij(x.dest), to: this.ij(x.strike?.to ?? t), kind: "info" });
          words.push(`${f.name}: ${x.strike ? f.weapons[x.strike.weapon]!.name : "stand"}`);
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
    const idle = this.c.roster.filter((_, u) => teamOf(this.c, u) === SQUAD && this.c.hp[u]! > 0 && !this.acted.has(u)).length;
    if (idle && !this.confirmEnd) {
      this.confirmEnd = true;
      this.say(`${idle === 1 ? "A rig hasn't" : `${idle} rigs haven't`} acted: Enter again to end the turn anyway.`);
      return this.paint();
    }
    this.confirmEnd = false;
    await this.endTurn();
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
    const invaders = this.c.roster.some((_, u) => teamOf(this.c, u) === INVADERS && this.c.hp[u]! > 0) || this.c.schedule.slice(this.c.round).some((r) => r.length);
    const squad = this.c.roster.some((_, u) => teamOf(this.c, u) === SQUAD && this.c.hp[u]! > 0);
    if (!invaders || !squad || this.c.round >= this.rounds) return this.over(squad);
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
      lost: o.lost,
      atStake: this.start.arena.structures.reduce((n, s) => n + s.people, 0),
      squadDown: !squad,
      roundsHeld: this.roundsHeld,
      rounds: this.c.round,
      invadersDown: this.c.roster.filter((_, u) => teamOf(this.c, u) === INVADERS && this.c.hp[u]! <= 0).length,
      razed: [...this.razed],
    };
    this.paint();
    setTimeout(() => this.finish(result), 700);
  }

  /** Leave the world as the fight left it (its fallen buildings stay fallen), with the fight's own things gone. */
  dispose(): void {
    this.offFrame();
    for (const e of this.entities) e?.remove();
    for (const f of this.fx) for (const e of f.entities) e.remove();
    this.fx.clear();
    if (this.hidden.length) this.view.edits.restore(this.hidden);
    this.view.layers.remove("fight");
    for (const l of this.labels.values()) l.el.remove();
    this.labels.clear();
    this.hud.remove();
    this.map.el.remove();
  }

  /** The puzzle, for a retry. */
  get source(): Puzzle {
    return this.puzzle;
  }
}

function manhattan(w: number, p: number, q: number): number {
  return Math.abs((p % w) - (q % w)) + Math.abs(Math.floor(p / w) - Math.floor(q / w));
}
