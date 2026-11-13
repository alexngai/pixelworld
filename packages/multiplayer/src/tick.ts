import type { TickEvent, TickMessage, TickShared, TickSnapshot } from "./index";
import type { HostedRoom, RoomHost } from "./server";

/** What a page is in a `TickRoom`: one who plays, or one who watches (gets the shared snapshot, sends no inputs). */
export type TickRole = "player" | "spectator";

export interface TickRoomOptions<W> {
  /** The fixed step (s; default 1/60): the pages' `TickClient` steps at the same. */
  tick?: number;
  /** A snapshot every this many ticks (default 3: 20 a second at 60). */
  snapshotEvery?: number;
  /** Inputs a player may have waiting (default 15): past it, the oldest waiting is dropped and its page's prediction corrected. */
  maxQueue?: number;
  /** Inputs a player may step in one tick after a stall (default 8). */
  maxBurst?: number;
  /** Inputs credited a tick (default 1.02): a little over one, so a backlog left by a stall drains instead of lagging for good. */
  credit?: number;
  /**
   * A player whose page shows the others this much later than its own best
   * (s, default 0.25) is behind: its connection is backed up. It gets only
   * every `behindEvery`th snapshot (default 10) until it catches up, so it
   * doesn't play back seconds of old ones.
   */
  behind?: number;
  behindEvery?: number;
  /** The game's world: players are admitted once it resolves (`world` holds it); if it fails, the room closes saying why. */
  ready?: Promise<W>;
  /** Run in real time (default); off for tests, which call `tick()`. */
  clock?: boolean;
}

/** How a room's clock is keeping up (`TickRoom.stats`). */
export interface TickStats {
  ticks: number;
  /** Milliseconds a tick takes: on average (recent), and the most. */
  stepMs: number;
  maxStepMs: number;
  /** Times the clock fell so far behind that it dropped time (a stall over a quarter second). */
  overruns: number;
  /** Players whose connection is backed up now. */
  behind: number;
}

interface Seat<I, J> {
  role: TickRole;
  join: J;
  queue: { seq: number; i: I; seen: number | null }[];
  ack: number;
  /** The last numbered command taken (D-121), 0 before one. */
  cmd: number;
  budget: number;
  /** A bot's driver, and its own count of inputs. */
  drive?: () => I;
  /** The page's lag (how much later than now it shows the others), at its smallest lately; and whether it is behind that now. */
  base: number | null;
  behind: boolean;
}

/** How much a player's smallest lag may creep up an input (s): a route that got slower for good becomes its new normal in a few seconds. */
const LAG_CREEP = 0.0005;

/**
 * A room whose game the server runs at a fixed tick (D-113, D-114, D-116,
 * D-118): the `host` of `attachRelay`.
 *
 * - **Joining:** a page says who it is (`hello`, the game's own join data,
 *   which `parseJoin` checks) and is admitted once the game's world is ready:
 *   `added` makes it a player, a spectator, or turns it away.
 * - **Inputs:** a player's numbered inputs (`TickMessage`, from a
 *   `TickClient`) queue and are stepped one a tick, a little credit over so
 *   a backlog after a stall drains; out-of-order, invalid and excess inputs
 *   are dropped. **Commands** (`cmd`: a team pick, a ready, a build) reach
 *   `command` from players and spectators alike, reliably and once; a
 *   player's snapshots say the last one taken (`cmd`, D-121). A game run by
 *   commands alone (a strategy game) has no inputs: `input` gives null.
 * - **Bots** (`addBot`): players the server drives itself, each tick.
 * - **Snapshots,** every `snapshotEvery` ticks: one shared part for every
 *   page (`shared`, serialized once), and to each player its own (`snapshot`,
 *   with `t` and its `ack`). A player whose connection is backed up gets
 *   fewer until it catches up.
 * - **Events** (`emit`): stamped with the server time, for pages to show when
 *   they show that time of the others (`TickClient.due`).
 * - **Errors:** a throw in the game closes this room (`HostedRoom.fail`), not
 *   the server.
 */
export abstract class TickRoom<I, J = unknown, W = undefined, E = unknown> implements RoomHost {
  /** Server time (s): whole ticks. */
  time = 0;
  readonly tickLength: number;
  /** The game's world, from `ready`: in place before any page is admitted. */
  protected world!: W;
  private readonly seats = new Map<string, Seat<I, J>>();
  /** Connected, not admitted: their join (null until their `hello`). */
  private readonly pending = new Map<string, J | null>();
  private isReady: boolean;
  private ticks = 0;
  private snapshots = 0;
  private botSeq = 0;
  private last = performance.now();
  private acc = 0;
  private timer: ReturnType<typeof setInterval> | null;
  private readonly health = { stepMs: 0, maxStepMs: 0, overruns: 0, loggedAt: -Infinity };

  constructor(
    protected readonly room: HostedRoom,
    private readonly opts: TickRoomOptions<W> = {},
  ) {
    this.tickLength = opts.tick ?? 1 / 60;
    this.isReady = !opts.ready;
    opts.ready?.then(
      (w) => {
        this.world = w;
        this.isReady = true;
        try {
          for (const [id, join] of this.pending) if (join !== null) this.admit(id, join);
        } catch (e) {
          this.fail(e);
        }
      },
      (e: unknown) => this.room.close(`the game didn't start: ${e instanceof Error ? e.message : String(e)}`),
    );
    this.timer = opts.clock === false ? null : setInterval(() => this.run(), (this.tickLength * 1000) / 2);
  }

  // ---------------------------------------------------------------- the game's part

  /** A page's join data (untrusted), as the game's own: checked, cleaned; null turns the page away. */
  protected abstract parseJoin(data: unknown): J | null;
  /** A page (or a bot) arrives with its join: a player, a spectator, or null to turn it away. It counts among the seats already. */
  protected abstract added(id: string, join: J): TickRole | null;
  /** A player or spectator went (left, was kicked, or a bot removed). */
  protected abstract removed(id: string): void;
  /** A player's input (untrusted), as the game's own (clamped, checked), or null to drop it. */
  protected abstract input(data: unknown): I | null;
  /**
   * One tick of a player with its input: `seen` as its page sent it (`lagOf`
   * makes it a rewind; null for a bot), and `seq` the input's number (its
   * page's, so an effect the page drew at once can be matched to the server's).
   */
  protected abstract step(id: string, input: I, seen: number | null, seq: number): void;
  /** The world's own tick, after the players' steps. */
  protected update(): void {}
  /** What every page's snapshot shares (the others, the score, the match's phase): serialized once. */
  protected shared(): object {
    return {};
  }
  /** What one player's own snapshot carries besides `t` and `ack` (its own state, for its prediction). */
  protected snapshot(_id: string): object {
    return {};
  }
  /** A command from a player or spectator (untrusted): a team pick, a ready, a build. */
  protected command(_id: string, _c: unknown): void {}
  /** What the lobby lists for this room besides its players (a mode, a map, time left). */
  protected describe(): object {
    return {};
  }

  // ---------------------------------------------------------------- RoomHost

  join(id: string): void {
    this.pending.set(id, null);
  }

  leave(id: string): void {
    this.pending.delete(id);
    if (this.seats.delete(id)) this.removed(id);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  message(id: string, data: unknown): void {
    const m = data as Partial<TickMessage<unknown>> | null;
    if (!m || typeof m !== "object") return;
    if (m.k === "hello") {
      if (this.pending.get(id) !== null) return; // once, and not once in
      const join = this.parseJoin(m.join);
      if (join === null) return this.room.kick(id, "the game can't take that join");
      this.pending.set(id, join);
      if (this.isReady) this.admit(id, join);
      return;
    }
    const seat = this.seats.get(id);
    if (!seat) return;
    if (m.k === "cmd") {
      if (Number.isInteger(m.n) && m.n! > seat.cmd) seat.cmd = m.n!; // taken as it comes: the next snapshot has it
      return this.command(id, m.c);
    }
    if (m.k !== "in" || seat.role !== "player" || seat.drive || !Number.isInteger(m.seq) || m.seq! <= (seat.queue.at(-1)?.seq ?? seat.ack)) return;
    const i = this.input(m.i);
    if (i === null) return;
    if (seat.queue.length >= (this.opts.maxQueue ?? 15)) seat.queue.shift();
    seat.queue.push({ seq: m.seq!, i, seen: typeof m.seen === "number" && Number.isFinite(m.seen) ? m.seen : null });
  }

  info(): object {
    const players = this.playerIds();
    return { players: players.filter((id) => !this.isBot(id)).length, bots: players.filter((id) => this.isBot(id)).length, spectators: this.spectatorIds().length, ...this.describe() };
  }

  // ---------------------------------------------------------------- for the game

  /** An event to every page (or one), stamped with the server time: pages show it when they show that time of the others. */
  emit(e: E, to?: string): void {
    const m: TickEvent<E> = { k: "ev", t: this.time, e };
    if (to === undefined) this.room.broadcast(m);
    else this.room.send(to, m);
  }

  /** A bot: a player the server drives itself, with `drive()` each tick (no page, no queue). False if the id is taken or the game turns it away. */
  addBot(id: string, join: J, drive: () => I): boolean {
    if (this.seats.has(id) || this.pending.has(id)) return false;
    const seat: Seat<I, J> = { role: "player", join, queue: [], ack: 0, cmd: 0, budget: 0, drive, base: null, behind: false };
    this.seats.set(id, seat);
    if (this.added(id, join) !== null) return true;
    this.seats.delete(id);
    return false;
  }

  removeBot(id: string): void {
    if (this.seats.get(id)?.drive && this.seats.delete(id)) this.removed(id);
  }

  /** Send a page away, saying why. */
  kick(id: string, why: string): void {
    this.room.kick(id, why);
  }

  roleOf(id: string): TickRole | null {
    return this.seats.get(id)?.role ?? null;
  }

  joinOf(id: string): J | null {
    return this.seats.get(id)?.join ?? null;
  }

  isBot(id: string): boolean {
    return !!this.seats.get(id)?.drive;
  }

  /** Whether a player's connection is backed up now (it gets fewer snapshots). */
  isBehind(id: string): boolean {
    return !!this.seats.get(id)?.behind;
  }

  /** The players (bots among them), in the order they arrived. */
  playerIds(): string[] {
    return [...this.seats].filter(([, s]) => s.role === "player").map(([id]) => id);
  }

  spectatorIds(): string[] {
    return [...this.seats].filter(([, s]) => s.role === "spectator").map(([id]) => id);
  }

  /** The last of a player's inputs stepped. */
  ackOf(id: string): number {
    return this.seats.get(id)?.ack ?? 0;
  }

  /** How far back to rewind for what a page saw at `seen` (s), at most `max`. */
  lagOf(seen: number | null, max: number): number {
    return seen === null ? 0 : Math.max(0, Math.min(max, this.time - seen));
  }

  stats(): TickStats {
    const h = this.health;
    return { ticks: this.ticks, stepMs: h.stepMs, maxStepMs: h.maxStepMs, overruns: h.overruns, behind: [...this.seats.values()].filter((s) => s.behind).length };
  }

  /** One tick: the players' steps, the world's, and the snapshots every `snapshotEvery`. */
  tick(): void {
    this.time = ++this.ticks * this.tickLength;
    if (!this.isReady) return;
    const burst = this.opts.maxBurst ?? 8;
    const credit = this.opts.credit ?? 1.02;
    const behind = this.opts.behind ?? 0.25;
    for (const [id, seat] of [...this.seats]) {
      if (seat.role !== "player" || !this.seats.has(id)) continue;
      if (seat.drive) {
        this.step(id, seat.drive(), null, ++this.botSeq);
        continue;
      }
      seat.budget = Math.min(burst, seat.budget + credit);
      while (seat.budget >= 1 && seat.queue.length) {
        seat.budget--;
        const next = seat.queue.shift()!;
        seat.ack = next.seq;
        if (next.seen !== null) {
          const lag = this.time - next.seen;
          seat.base = seat.base === null ? lag : Math.min(seat.base + LAG_CREEP, lag);
          seat.behind = lag - seat.base > behind;
        }
        this.step(id, next.i, next.seen, next.seq);
      }
    }
    this.update();
    if (this.ticks % (this.opts.snapshotEvery ?? 3)) return;
    // a backed-up player gets every `behindEvery`th snapshot
    const everyone = ++this.snapshots % (this.opts.behindEvery ?? 10) === 0;
    const skip = new Set([...this.seats].filter(([, s]) => s.behind && !everyone).map(([id]) => id));
    this.room.broadcast({ k: "world", t: this.time, ...this.shared() } satisfies TickShared, skip);
    for (const [id, seat] of this.seats)
      if (seat.role === "player" && !seat.drive && !skip.has(id))
        this.room.send(id, { k: "snap", t: this.time, ack: seat.ack, ...(seat.cmd ? { cmd: seat.cmd } : {}), ...this.snapshot(id) } satisfies TickSnapshot);
  }

  private admit(id: string, join: J): void {
    this.pending.delete(id);
    const seat: Seat<I, J> = { role: "player", join, queue: [], ack: 0, cmd: 0, budget: 0, base: null, behind: false };
    this.seats.set(id, seat);
    const role = this.added(id, join);
    if (role === null) {
      this.seats.delete(id);
      return this.room.kick(id, "the game turned you away");
    }
    seat.role = role;
  }

  private fail(e: unknown): void {
    this.close();
    this.room.fail(e);
  }

  /** Whole ticks for the time gone by; a throw in the game closes the room. */
  private run(): void {
    const now = performance.now();
    const gone = (now - this.last) / 1000;
    this.last = now;
    const h = this.health;
    if (gone > 0.25) {
      h.overruns++;
      this.note(`the clock fell ${Math.round((gone - 0.25) * 1000)} ms behind`);
    }
    this.acc += Math.min(0.25, gone);
    try {
      while (this.acc >= this.tickLength) {
        this.acc -= this.tickLength;
        const t0 = performance.now();
        this.tick();
        const ms = performance.now() - t0;
        h.stepMs = h.stepMs * 0.95 + ms * 0.05;
        h.maxStepMs = Math.max(h.maxStepMs, ms);
        if (ms > this.tickLength * 1000) this.note(`a tick took ${ms.toFixed(1)} ms of its ${(this.tickLength * 1000).toFixed(1)}`);
      }
    } catch (e) {
      this.fail(e);
    }
  }

  /** A note for the server's log, at most one every 10 s. */
  private note(message: string): void {
    const now = performance.now();
    if (now - this.health.loggedAt < 10_000) return;
    this.health.loggedAt = now;
    this.room.log(message);
  }
}

// ---------------------------------------------------------------- a match's phases

/**
 * A match's phases on the server's clock (D-118): staging, playing, the end
 * screen, as the game names them. Put `net()` in the shared snapshot; a page
 * shows `until - client.seen()` as the time left.
 */
export class Phases<P extends string> {
  /** When this phase ends (server time, s), or null for open-ended. */
  until: number | null;

  constructor(
    public phase: P,
    until: number | null = null,
  ) {
    this.until = until;
  }

  /** Into a phase at server time `now`, for `seconds` (open-ended without). */
  set(phase: P, now: number, seconds?: number): void {
    this.phase = phase;
    this.until = seconds === undefined ? null : now + seconds;
  }

  /** Seconds left at `now` (Infinity for open-ended). */
  left(now: number): number {
    return this.until === null ? Infinity : Math.max(0, this.until - now);
  }

  /** Whether the phase's time is up at `now`. */
  over(now: number): boolean {
    return this.until !== null && now >= this.until;
  }

  net(): { phase: P; until: number | null } {
    return { phase: this.phase, until: this.until };
  }
}

// ---------------------------------------------------------------- where things were

/** A point: cells across, height in steps (as a `Pose`'s). */
export interface Place {
  x: number;
  y: number;
  h: number;
}

/** Where something was, by server time, a few seconds back: to test a shot against where its shooter saw the target (lag compensation). */
export class History {
  private readonly at_: (Place & { t: number })[] = [];

  /** @param keep Seconds kept. */
  constructor(private readonly keep: number) {}

  record(t: number, p: Place): void {
    this.at_.push({ t, x: p.x, y: p.y, h: p.h });
    while (this.at_.length && t - this.at_[0]!.t > this.keep) this.at_.shift();
  }

  /** Where it was at t: between the two records around it; the oldest before them; `now` after the newest. */
  at(t: number, now: Place): Place {
    const hs = this.at_;
    if (!hs.length || t >= hs[hs.length - 1]!.t) return { x: now.x, y: now.y, h: now.h };
    if (t <= hs[0]!.t) return hs[0]!;
    let i = hs.length - 1;
    while (hs[i - 1]!.t > t) i--;
    const [a, b] = [hs[i - 1]!, hs[i]!];
    const f = (t - a.t) / (b.t - a.t);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, h: a.h + (b.h - a.h) * f };
  }

  /** A jump (a respawn): don't rewind across it. */
  clear(): void {
    this.at_.length = 0;
  }
}
