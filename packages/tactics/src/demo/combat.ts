import { boardCellAt, toWorld, type Board, type Boards, type Entity, type WorldView } from "@pixelworlds/engine";
import {
  A_WATER,
  BoardOverlay,
  DIRS,
  FIGHTERS,
  INVADERS,
  SQUAD,
  arenaFromBoard,
  cloneCombat,
  describePlan,
  endRound,
  entityModel,
  generatePuzzle,
  movesOf,
  outcome,
  planInvaders,
  solveTurn,
  strike,
  strikeCell,
  strikesOf,
  structureAt,
  teamOf,
  moveUnit,
  type Arrow,
  type Combat,
  type CombatEvent,
  type FxKind,
  type Mark,
  type Puzzle,
  type Role,
  type Strike,
} from "../index";

/**
 * The sandbox's combat (D-150): a puzzle made on a board cut where the
 * pointer is, played turn by turn. Click a rig, a cell to move to, then a
 * target; Enter ends the turn and the invaders strike; U takes the turn back,
 * H shows a turn that loses nobody, N makes another puzzle, Esc leaves. A
 * building that falls is taken out of the world (D-124).
 */

export interface CombatEnv {
  view: WorldView;
  boards: Boards;
  ramps: Record<Role, number>;
  say: (s: string) => void;
  status: HTMLElement;
  effect: (kind: FxKind, x: number, y: number, frames: number, seconds?: number) => { entities: Entity[]; until: number };
}

export interface CombatMode {
  /** A click on the ground at a world point, or on a placed object (`ObjectHit.index`). */
  click(x: number, y: number, object?: number): void;
  key(k: string): boolean;
  stop(): void;
  /** The fight as it stands, and its board (for the console). */
  state(): { combat: Combat; board: Board };
}

const ROUNDS = 3;
const angle = (dir: number) => Math.atan2(DIRS[dir]![1], DIRS[dir]![0]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start a fight round a world point: a board cut there, a puzzle made on it. Null where no puzzle comes of it. */
export async function startCombat(env: CombatEnv, x: number, y: number, seed = 1): Promise<CombatMode | null> {
  const { view, boards, say } = env;
  const { query, world } = view;
  const mpc = world.manifest.scale.metersPerCell;
  // two world cells a board cell where buildings are big; one where they are small
  let board: Board | null = null;
  let arena = null;
  for (const cell of [2, 1]) {
    board = await boards.add({ x0: Math.floor(x - 4 * cell), y0: Math.floor(y - 4 * cell), w: 8, h: 8, cell });
    arena = arenaFromBoard(board, query, world.manifest.surfaces, { metersPerCell: mpc });
    if (arena.structures.length >= 5) break;
    boards.remove(board);
  }
  if (!board || !arena || arena.structures.length < 5) {
    say("too few buildings here for a fight: try a denser block");
    return null;
  }
  const b = board;
  const puzzle = await generatePuzzle(arena, {
    seed,
    timeMs: 5000,
    attempts: 400,
    onProgress: (n, best) => say(`making a puzzle… ${n} positions tried${best !== null ? `, the hardest ${best.toFixed(1)} bits` : ""}`),
  });
  if (!puzzle) {
    boards.remove(b);
    say("no solvable puzzle here: try another block");
    return null;
  }
  return play(env, b, puzzle);
}

function play(env: CombatEnv, board: Board, puzzle: Puzzle): CombatMode {
  const { view, ramps, say, status } = env;
  const a = puzzle.combat.arena;
  const rs = view.world.renderScale;
  let c = cloneCombat(puzzle.combat);
  let turnStart = cloneCombat(c);
  let round = 1;
  let acted = new Set<number>();
  let razedThisTurn: number[] = [];
  let selected = -1;
  let phase: "pick" | "move" | "strike" | "invaders" | "over" = "pick";
  let hint: Arrow[] = [];
  const start = cloneCombat(c);

  const overlay = new BoardOverlay(board, { id: "combat" });
  void view.layers.add(overlay);
  const centre = (k: number) => toWorld(board, { x: (k % a.w) + 0.5, y: Math.floor(k / a.w) + 0.5 });
  const stand = (k: number) => board.height[k]!;
  const entities = c.roster.map((kind, u) => {
    const p = centre(c.pos[u]!);
    return view.entities.add({
      model: entityModel(kind, ramps, { scale: board.cell, renderScale: rs }),
      x: p.x,
      y: p.y,
      h: stand(c.pos[u]!),
      heading: teamOf(c, u) === INVADERS && c.aim[u]! >= 0 ? angle(c.aim[u]!) : 0,
      silhouette: true,
    });
  });
  const fires = new Map<number, { entities: Entity[]; until: number }>();
  // a window through the towers onto the board (D-079): a speck at its middle, revealing as far as the board reaches on screen
  const middle = toWorld(board, { x: a.w / 2, y: a.h / 2 });
  const side = Math.max(a.w, a.h) * board.cell * rs;
  const window_ = view.entities.add({
    model: { boxes: [{ x0: -0.01, y0: -0.01, z0: 0, x1: 0.01, y1: 0.01, z1: 0.01, ramp: 0 }], key: "combat-window" },
    x: middle.x,
    y: middle.y,
    reveal: { margin: 16 * side + 24, density: 0.9 },
    wait: false,
  });

  /** Put each unit's entity where the state has it; the fallen go, with a blast or a splash. */
  const sync = () => {
    c.roster.forEach((_, u) => {
      const e = entities[u]!;
      const p = centre(c.pos[u]!);
      if (c.hp[u]! <= 0) {
        if (e.visible) env.effect(a.flags[c.pos[u]!]! & A_WATER ? "jet" : "blast", p.x, p.y, 4, 1.2); // drowned, or brought down
        e.visible = false;
        return;
      }
      e.visible = true;
      e.moveTo(p.x, p.y, stand(c.pos[u]!));
      if (teamOf(c, u) === INVADERS && c.aim[u]! >= 0) e.heading = angle(c.aim[u]!);
    });
    for (let k = 0; k < c.fire.length; k++) {
      const f = fires.get(k);
      if (c.fire[k] && !f) {
        const p = centre(k);
        fires.set(k, env.effect("fire", p.x, p.y, 3));
      } else if (!c.fire[k] && f) {
        f.until = 0;
        fires.delete(k);
      }
    }
  };

  /** Buildings that fell: out of the world, rubble where they stood. */
  const fallen = (log: CombatEvent[]) => {
    for (const e of log) {
      if (e.t !== "structure" || !e.destroyed) continue;
      const s = a.structures[e.id]!;
      if (s.object >= 0) {
        view.edits.remove([s.object]);
        if (phase !== "invaders") razedThisTurn.push(s.object);
      }
      for (let k = 0; k < a.struct.length; k++)
        if (a.struct[k] === e.id) {
          const p = centre(k);
          env.effect("rubble", p.x, p.y, 1);
        }
    }
  };

  const strikeTargets = (u: number) => {
    const out = new Map<number, Strike>();
    for (const s of strikesOf(c, u)) {
      const k = strikeCell(c, u, s);
      if (k >= 0 && !out.has(k)) out.set(k, s);
    }
    return out;
  };

  const draw = () => {
    const marks: Mark[] = [];
    const arrows: Arrow[] = [];
    const ij = (k: number): [number, number] => [k % a.w, Math.floor(k / a.w)];
    const mark = (k: number, kind: Mark["kind"]) => marks.push({ i: k % a.w, j: Math.floor(k / a.w), kind });
    for (let u = 0; u < c.roster.length; u++) {
      if (c.hp[u]! <= 0) continue;
      if (teamOf(c, u) === INVADERS) {
        mark(c.pos[u]!, "enemy");
        if (c.aim[u]! < 0) continue;
        const t = strikeCell(c, u, { dir: c.aim[u]!, range: c.reach[u]! });
        if (t < 0) continue;
        mark(t, "danger");
        arrows.push({ from: ij(c.pos[u]!), to: ij(t), kind: "attack" });
      } else mark(c.pos[u]!, u === selected ? "select" : acted.has(u) ? "info" : "ally");
    }
    if (selected >= 0 && phase === "move") for (const k of movesOf(c, selected)) if (k !== c.pos[selected]) mark(k, "move");
    if (selected >= 0 && phase === "strike") for (const k of strikeTargets(selected).keys()) mark(k, "attack");
    overlay.setMarks(marks);
    overlay.setArrows([...arrows, ...hint]);
    // the panel: whose turn, the squad, the invaders' aims, what is at stake
    const lines: string[] = [`Round ${round} of ${ROUNDS} · ${phaseText()}`];
    for (let u = 0; u < c.roster.length; u++) {
      const f = FIGHTERS[c.roster[u]!];
      if (teamOf(c, u) === SQUAD) lines.push(`${f.name} ${c.hp[u]}/${f.hp}${c.hp[u]! <= 0 ? " down" : acted.has(u) ? " · done" : ""}`);
    }
    for (let u = 0, order = 1; u < c.roster.length; u++) {
      if (teamOf(c, u) !== INVADERS || c.hp[u]! <= 0) continue;
      const f = FIGHTERS[c.roster[u]!];
      const t = c.aim[u]! >= 0 ? strikeCell(c, u, { dir: c.aim[u]!, range: c.reach[u]! }) : -1;
      const sid = t >= 0 ? structureAt(c, t) : -1;
      const at = sid >= 0 ? `${a.structures[sid]!.name.replace("building.", "")} (${a.structures[sid]!.people} people)` : t >= 0 && c.occ[t]! >= 0 ? FIGHTERS[c.roster[c.occ[t]!]!].name : "nothing";
      lines.push(`${order++}. ${f.name} ${c.hp[u]}/${f.hp} → ${f.weapon.name} at ${at}`);
    }
    const o = outcome(start, c);
    lines.push(`People lost ${Math.round(o.lost)} · puzzle ${puzzle.difficulty.toFixed(1)} bits, ${puzzle.stats.perfectLeaves} of ${puzzle.stats.leaves} end states lose nobody`);
    status.textContent = lines.join("\n");
  };

  const phaseText = () =>
    ({
      pick: "click a rig (Enter ends the turn, H a hint, U undoes, N another puzzle, Esc leaves)",
      move: "click where it moves (its own cell to stay)",
      strike: "click a target (Space to hold fire)",
      invaders: "the invaders strike…",
      over: "over: N for another puzzle, Esc to leave",
    })[phase];

  const done = (u: number) => {
    acted.add(u);
    selected = -1;
    phase = "pick";
    hint = [];
  };

  const endTurn = async () => {
    phase = "invaders";
    selected = -1;
    hint = [];
    draw();
    // each invader in turn, so the eye can follow
    for (let u = 0; u < c.roster.length; u++) {
      if (teamOf(c, u) !== INVADERS || c.hp[u]! <= 0 || c.aim[u]! < 0) continue;
      const log: CombatEvent[] = [];
      strike(c, u, { dir: c.aim[u]!, range: c.reach[u]! }, log);
      fallen(log);
      const hitAt = log.find((e) => e.t === "strike");
      if (hitAt?.t === "strike") {
        const p = centre(hitAt.at);
        env.effect("blast", p.x, p.y, 3, 0.6);
      }
      sync();
      draw();
      await sleep(450);
    }
    const log: CombatEvent[] = [];
    endRound(c, log);
    fallen(log);
    sync();
    const o = outcome(turnStart, c);
    const invaders = c.roster.some((_, u) => teamOf(c, u) === INVADERS && c.hp[u]! > 0);
    const squad = c.roster.some((_, u) => teamOf(c, u) === SQUAD && c.hp[u]! > 0);
    say(o.perfect ? `Round ${round}: nobody lost.` : `Round ${round}: ${Math.round(o.lost)} people lost, ${o.razed} hits on buildings${o.rigsDown ? `, ${o.rigsDown} rig down` : ""}.`);
    if (!invaders || !squad || round >= ROUNDS) {
      phase = "over";
      const total = outcome(start, c);
      say(`${!squad ? "The squad is down." : !invaders ? "The invaders are down." : "The incursion is held."} ${Math.round(total.lost)} people lost in all.`);
      return draw();
    }
    round++;
    planInvaders(c);
    sync();
    turnStart = cloneCombat(c);
    acted = new Set();
    razedThisTurn = [];
    phase = "pick";
    draw();
  };

  const showHint = () => {
    const res = solveTurn(c, { acted: [...acted], keep: 1, maxNodes: 100_000 });
    const sol = res.perfect[0] ?? solveTurn(c, { acted: [...acted], mode: "best", maxNodes: 100_000 }).best;
    if (!sol) return say("no turn left to play");
    const ij = (k: number): [number, number] => [k % a.w, Math.floor(k / a.w)];
    const d = cloneCombat(c);
    hint = [];
    for (const x of sol.plan) {
      if (x.dest !== d.pos[x.unit]) hint.push({ from: ij(d.pos[x.unit]!), to: ij(x.dest), kind: "move" });
      moveUnit(d, x.unit, x.dest);
      const t = x.strike ? strikeCell(d, x.unit, x.strike) : -1;
      if (t >= 0) hint.push({ from: ij(x.dest), to: ij(t), kind: "info" });
      if (x.strike) strike(d, x.unit, x.strike);
    }
    say(`${res.perfect.length ? "A turn that loses nobody" : "No turn loses nobody now; the best"}:\n${describePlan(c, sol.plan).join("\n")}`);
    draw();
  };

  draw();
  say(`A puzzle: ${puzzle.stats.perfectLeaves} of ${puzzle.stats.leaves} ways to play this turn lose nobody. Click a rig.`);

  return {
    click(x, y, object) {
      if (phase === "invaders" || phase === "over") return;
      let k = boardCellAt(board, x, y);
      // a click on a building's face: the cell of it a strike lands on
      if (phase === "strike" && object !== undefined)
        for (const t of strikeTargets(selected).keys()) if (a.struct[t]! >= 0 && a.structures[a.struct[t]!]!.object === object) k = t;
      if (k < 0) return;
      const u = c.occ[k]!;
      if (u >= 0 && teamOf(c, u) === SQUAD && !acted.has(u) && phase !== "strike") {
        selected = u;
        phase = "move";
      } else if (phase === "move" && movesOf(c, selected).includes(k)) {
        moveUnit(c, selected, k);
        sync();
        phase = "strike";
      } else if (phase === "strike") {
        const s = strikeTargets(selected).get(k);
        if (!s) return;
        const log: CombatEvent[] = [];
        strike(c, selected, s, log);
        fallen(log);
        sync();
        done(selected);
      }
      draw();
    },
    key(k) {
      if (k === "escape") {
        this.stop();
        return true;
      }
      if (phase === "invaders") return true;
      if (k === "enter" && phase !== "over") {
        void endTurn();
        return true;
      }
      if (k === " " && phase === "strike") {
        done(selected);
        draw();
        return true;
      }
      if (k === "h" && phase !== "over") {
        showHint();
        return true;
      }
      if (k === "u" && phase !== "over") {
        c = cloneCombat(turnStart);
        if (razedThisTurn.length) view.edits.restore(razedThisTurn);
        razedThisTurn = [];
        acted = new Set();
        selected = -1;
        phase = "pick";
        hint = [];
        sync();
        draw();
        say("the turn taken back");
        return true;
      }
      return false;
    },
    state: () => ({ combat: c, board }),
    stop() {
      for (const e of entities) e.remove();
      window_.remove();
      for (const f of fires.values()) f.until = 0;
      view.layers.remove("combat");
      env.boards.remove(board);
      status.textContent = "";
      say("left the fight");
    },
  };
}
