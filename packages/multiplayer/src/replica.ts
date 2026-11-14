import { Reader, Schema, Writer, type Wire } from "./codec";

/**
 * A room's moving things in compact binary (D-123): the server's `Replicator`
 * writes each group of pages one message a snapshot, and each page's `Replica`
 * reads it back. Pages that have had every message of their group since they
 * joined it get only what changed (a keyframe, then diffs: a reliable,
 * ordered connection loses none); a page new to its group, or back from being
 * skipped, gets a keyframe of everything it sees. Each thing's state is
 * written at most twice a snapshot, whole and as a diff, whatever the number
 * of groups and pages; a group's message is those pieces put together.
 *
 * A message: `W`, the server's tick, flags (1: keyframe), the things (each its
 * number × 2, + 1 for a diff; whole ones with their id), the numbers of those
 * gone, and the game's own JSON for the group (`TickRoom.shared(group)`).
 */

/** The first byte of a replicated world message. */
export const WORLD_BYTE = 0x57;
/** The first byte of a player's own snapshot in binary (`TickRoom.snapSchema`): then its tick, its ack, its fields whole. */
export const SNAP_BYTE = 0x53;

/** What a page's `Replica` read from one message. */
export interface ReplicaUpdate<S> {
  /** The server's tick: times the room's tick length is its time. */
  tick: number;
  /** A keyframe: everything the page sees now; anything else it had is gone (and in `gone`). */
  keyframe: boolean;
  /** The things in the message, with their state now. */
  states: [string, S][];
  /** The things gone from what the page sees. */
  gone: string[];
  /** The game's own part of the snapshot (`TickRoom.shared(group)`), or null. */
  extras: object | null;
}

/** A page's copy of what the server replicates to it. */
export class Replica<S extends object> {
  private readonly known = new Map<number, { id: string; w: Wire }>();

  constructor(readonly schema: Schema<S>) {}

  read(buf: Uint8Array): ReplicaUpdate<S> {
    const r = new Reader(buf);
    if (r.byte() !== WORLD_BYTE) throw new Error("not a replicated world message");
    const tick = r.uint();
    const keyframe = (r.byte() & 1) === 1;
    const before = keyframe ? new Map(this.known) : null;
    if (keyframe) this.known.clear();
    const states: [string, S][] = [];
    for (let n = r.uint(); n > 0; n--) {
      const tag = r.uint();
      const net = Math.floor(tag / 2);
      if (tag % 2 === 0) {
        const id = r.str();
        const w = this.schema.readFull(r);
        this.known.set(net, { id, w });
        states.push([id, this.schema.value(w)]);
      } else {
        const had = this.known.get(net);
        const w = this.schema.readDiff(r, had?.w ?? this.schema.wire({} as S));
        if (!had) continue; // never seen whole: can't be, on an ordered connection
        had.w = w;
        states.push([had.id, this.schema.value(w)]);
      }
    }
    const gone: string[] = [];
    for (let n = r.uint(); n > 0; n--) {
      const net = r.uint();
      const had = this.known.get(net);
      if (!had) continue;
      this.known.delete(net);
      gone.push(had.id);
    }
    if (before) for (const [net, had] of before) if (!this.known.has(net)) gone.push(had.id);
    const len = r.uint();
    const extras = len ? (JSON.parse(new TextDecoder().decode(r.bytes(len))) as object) : null;
    return { tick, keyframe, states, gone, extras };
  }

  /** The ids of everything the page has. */
  ids(): string[] {
    return [...this.known.values()].map((k) => k.id);
  }
}

export interface ReplicatorOptions<S> {
  /** Every replicated thing's state now (players, bots, anything that moves): asked once a snapshot. */
  states(): Iterable<readonly [string, S]>;
  /**
   * What a group of pages sees (its interest group, D-120; undefined for pages
   * in none): the near, every snapshot, and the far, every `farEvery`th.
   * Default: everything, near.
   */
  view?(group: string | undefined): { near: Iterable<string>; far?: Iterable<string> };
  /** Far things go every this many snapshots (default 4: 5 a second at 20). */
  farEvery?: number;
}

interface Thing {
  net: number;
  w: Wire;
  /** Its state at the snapshot before, or null if it is new. */
  prev: Wire | null;
  full?: Uint8Array;
  diff?: Uint8Array;
}

/** A group's stream: what its pages were last sent of each thing (a snapshot's number, or -1 for one only joiners had whole). */
type Stream = Map<string, number>;

/** What a room sends its pages each snapshot, compactly (server; see `Replica`). */
export class Replicator<S extends object> {
  private readonly things = new Map<string, Thing>();
  private readonly streams = new Map<string, Stream>();
  /** Each page in step with a group's stream: that group's key. */
  private readonly inStep = new Map<string, string>();
  private snap = 0;
  private next = 1;
  /** Last snapshot's messages, their bytes, and how many were keyframes. */
  readonly last = { messages: 0, bytes: 0, keyframes: 0 };

  constructor(
    readonly schema: Schema<S>,
    private readonly opts: ReplicatorOptions<S>,
  ) {}

  /**
   * One snapshot: to each group's pages in step a diff of what it sees, and a
   * keyframe to those that aren't. `groups` holds every page to send to (not
   * the skipped); `extras(group)` is the game's own part, serialized once a
   * group. `send` sends one message to some pages, serialized once.
   */
  send(tick: number, groups: Map<string | undefined, string[]>, extras: (group: string | undefined) => object | null, send: (data: Uint8Array, to: readonly string[]) => void): void {
    this.update();
    const snap = this.snap;
    const farTick = snap % (this.opts.farEvery ?? 4) === 0;
    const was = new Map(this.inStep);
    this.inStep.clear();
    Object.assign(this.last, { messages: 0, bytes: 0, keyframes: 0 });
    const out = (data: Uint8Array, to: string[], keyframe: boolean) => {
      send(data, to);
      this.last.messages++;
      this.last.bytes += data.length * to.length;
      if (keyframe) this.last.keyframes++;
    };
    for (const [group, pages] of groups) {
      if (!pages.length) continue;
      const key = group ?? "\0";
      let stream = this.streams.get(key);
      if (!stream) this.streams.set(key, (stream = new Map()));
      const view = this.opts.view?.(group) ?? { near: this.things.keys() };
      const near = [...new Set(view.near)].filter((id) => this.things.has(id));
      const nearSet = new Set(near);
      const far = [...new Set(view.far ?? [])].filter((id) => this.things.has(id) && !nearSet.has(id));
      const extra = extras(group);
      const extraBytes = extra ? new TextEncoder().encode(JSON.stringify(extra)) : null;
      const steady = pages.filter((p) => was.get(p) === key);
      const joiners = pages.filter((p) => was.get(p) !== key);
      if (steady.length) {
        const w = this.header(tick, false);
        const sent: Uint8Array[] = [];
        for (const id of near) {
          const t = this.things.get(id)!;
          sent.push(stream.get(id) === snap - 1 && t.prev ? this.diffOf(t) : this.fullOf(id, t));
          stream.set(id, snap);
        }
        if (farTick)
          for (const id of far) {
            sent.push(this.fullOf(id, this.things.get(id)!));
            stream.set(id, snap);
          }
        const gone: number[] = [];
        const farSet = new Set(far);
        for (const id of [...stream.keys()])
          if (!nearSet.has(id) && !farSet.has(id)) {
            stream.delete(id);
            const t = this.things.get(id);
            if (t) gone.push(t.net);
            else gone.push(this.gone.get(id) ?? -1);
          }
        out(this.finish(w, sent, gone, extraBytes), steady, false);
      } else stream.clear();
      if (joiners.length) {
        const w = this.header(tick, true);
        const sent = [...near, ...far].map((id) => this.fullOf(id, this.things.get(id)!));
        for (const id of near) stream.set(id, snap);
        for (const id of far) if (!stream.has(id)) stream.set(id, steady.length ? -1 : snap);
        out(this.finish(w, sent, [], extraBytes), joiners, true);
      }
      for (const p of pages) this.inStep.set(p, key);
    }
    for (const key of [...this.streams.keys()]) if (![...this.inStep.values()].includes(key)) this.streams.delete(key);
    this.gone.clear();
  }

  /** Things gone since the last snapshot: their numbers, for the streams that had them. */
  private readonly gone = new Map<string, number>();

  private update(): void {
    this.snap++;
    const seen = new Set<string>();
    for (const [id, s] of this.opts.states()) {
      seen.add(id);
      const w = this.schema.wire(s);
      const t = this.things.get(id);
      if (t) Object.assign(t, { prev: t.w, w, full: undefined, diff: undefined });
      else this.things.set(id, { net: this.next++, w, prev: null });
    }
    for (const [id, t] of this.things)
      if (!seen.has(id)) {
        this.things.delete(id);
        this.gone.set(id, t.net);
      }
  }

  private header(tick: number, keyframe: boolean): Writer {
    const w = new Writer();
    w.byte(WORLD_BYTE);
    w.uint(tick);
    w.byte(keyframe ? 1 : 0);
    return w;
  }

  private finish(w: Writer, sent: Uint8Array[], gone: number[], extras: Uint8Array | null): Uint8Array {
    w.uint(sent.length);
    for (const b of sent) w.bytes(b);
    const known = gone.filter((n) => n >= 0);
    w.uint(known.length);
    for (const n of known) w.uint(n);
    w.uint(extras?.length ?? 0);
    if (extras) w.bytes(extras);
    return w.done();
  }

  private fullOf(id: string, t: Thing): Uint8Array {
    if (!t.full) {
      const w = new Writer();
      w.uint(t.net * 2);
      w.str(id);
      this.schema.writeFull(w, t.w);
      t.full = w.done();
    }
    return t.full;
  }

  private diffOf(t: Thing): Uint8Array {
    if (!t.diff) {
      const w = new Writer();
      w.uint(t.net * 2 + 1);
      this.schema.writeDiff(w, t.w, t.prev!);
      t.diff = w.done();
    }
    return t.diff;
  }
}
