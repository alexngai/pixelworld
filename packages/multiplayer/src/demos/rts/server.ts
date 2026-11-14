import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { stylePack } from "@pixelworlds/game/src/styles";
import { fogSampler, openWorld, type FogSampler, type WorldInfo } from "pixelworld/engine";
import { TrafficSim, loadRoutes, type Pose } from "pixelworld/traffic";
import { cleanName, vehiclesNet, type RoomInfo, type VehicleNet } from "../../index";
import { Phases, TickRoom, attachRelay, lobbyHandler, type HostedRoom, type Relay, type RelayLog, type TickRole } from "../../server";
import { Bot } from "./bot";
import { RtsGame, parseCommand, type GameEvent } from "./game";
import { DEFAULT_MAP, MAPS, mapOf, planMap, type Layout, type RtsMap } from "./maps";
import {
  MATCH,
  SNAPSHOT_EVERY,
  TEAMS,
  TICK,
  TEAM_NAMES,
  buildGrid,
  type MapGrid,
  type MatchPhase,
  type RtsCommand,
  type RtsEvent,
  type RtsInfo,
  type RtsJoin,
  type RtsWorldNet,
  type Team,
  type Watch,
  WATCHES,
  nextLight,
  TRAFFIC,
  trafficArea,
} from "./rules";

/**
 * Fogfront's server (D-121): a `TickRoom` per room on `/rts?room=`, run by
 * commands. Pages send orders (`TickClient.command`), never per-tick inputs;
 * the room checks each and carries it out in the match (game.ts), and says
 * why when it can't. A side is a team of one or two players (D-127: the
 * room's `size`, from its first page), who share its glim and order any of
 * its units and buildings. The shared snapshot has the match and who plays,
 * and, per side (`groupOf`, D-120's interest groups), what that side sees (the
 * fog of war): serialized once for its players and the spectators watching it
 * (a side, or all). A player's own snapshot says which of its orders were
 * taken (`cmd`). The match starts when
 * both sides are full, or after `MATCH.wait` seconds with someone on each; a
 * side with no one gets the bot then (at once with `vs: "bot"`), which plays
 * through the same orders. A side whose hearth falls, or whose last player
 * leaves, loses; after the result the next match starts with whoever is
 * there. The level's buildings knocked down this match are in the shared
 * snapshot, so a page that comes late takes them out of its world too
 * (D-124). Each room runs the level's cars on the motorway (D-126): they are
 * in every side's shared snapshot, the same for all, and units wait for them
 * to pass.
 */

/** The bot's id. */
export const BOT = "bot";

export interface RtsWorld {
  /** The play area's cells and buildings, as the level has them: each room's match gets its own copy of the cells. */
  grid: MapGrid;
  /** The level's fog as a number (D-125), or null where its style has none: each room reads it on its own clock. */
  fog: FogSampler | null;
  /** The map (D-128), and where each side starts and the glim lies on it: by hand, or chosen from its cells. */
  map: RtsMap;
  layout: Layout;
  /** The level's cars on its big roads, a simulation for each room (D-126); none where the level has no routes. */
  traffic?: (() => TrafficSim) | null;
}

/** The level's cars on its big roads over the map (D-126): a new simulation for each room, or null where the level has no routes. */
export async function rtsTraffic(world: Pick<WorldInfo, "url" | "manifest">, map: RtsMap["rect"]): Promise<(() => TrafficSim) | null> {
  const net = await loadRoutes(world.url, world.manifest);
  if (!net) return null;
  const m = world.manifest;
  const roads = new Set(TRAFFIC.roads);
  const a = trafficArea(map);
  return () => {
    const sim = new TrafficSim(net, {
      metersPerCell: m.scale.metersPerCell,
      level: m.level,
      heightStretch: m.depiction?.heightStretch,
      vehicleScale: m.depiction?.vehicleScale,
      kinds: ["car"],
      density: TRAFFIC.density,
      routes: (r) => roads.has(r.cls),
    });
    // a circle round the area: cars come in at its edge, outside the area
    sim.setFocus(a.x0 + a.w / 2, a.y0 + a.h / 2, Math.hypot(a.w, a.h) / 2);
    return sim;
  };
}

/** Open a map's level over HTTP (`worldUrl`, its package) and read the play area's cells (default the Presidio). */
export async function openRtsWorld(worldUrl: string, map: RtsMap = MAPS[DEFAULT_MAP]!): Promise<RtsWorld> {
  const { world, query } = await openWorld({ worldUrl, style: stylePack });
  const r = map.rect;
  await query.ensure(r.x0, r.y0, r.x0 + r.w, r.y0 + r.h);
  const grid = buildGrid(query, r);
  return { grid, fog: fogSampler(world, query), map, layout: map.layout ?? planMap(grid), traffic: await rtsTraffic(world, r) };
}

/** A room's settings from the lobby (D-128): its map. */
export interface RtsSettings {
  map: string;
}

/** A room's map, from its settings (untrusted): the Presidio for none, or a room a page opened by naming it. */
export const roomMap = (settings: unknown): RtsMap => mapOf((settings as Partial<RtsSettings> | null)?.map) ?? MAPS[DEFAULT_MAP]!;

export function logLine(l: RelayLog): void {
  const what = l.kind === "error" ? `the game hit an error: ${l.error instanceof Error ? (l.error.stack ?? l.error.message) : String(l.error)}` : [l.kind, l.id, l.message].filter(Boolean).join(" ");
  (l.kind === "error" ? console.error : console.log)(`rts room ${l.room}: ${what}`);
}

/** Fogfront on an HTTP server that also serves the page and the world package: `/rts?room=`. */
export function attachRts(server: Server, opts: { lag?: number; maxRooms?: number; log?: (l: RelayLog) => void } = {}): Relay {
  /** Each map's world, opened when a room first plays it (D-128). */
  const opened = new Map<string, Promise<RtsWorld>>();
  const world = (map: RtsMap) => {
    let w = opened.get(map.id);
    if (!w) {
      const { port } = server.address() as AddressInfo;
      opened.set(map.id, (w = openRtsWorld(`http://localhost:${port}/${map.world}/`, map)));
      w.catch((e: unknown) => {
        console.error(`rts: ${map.name} didn't open:`, e);
        opened.delete(map.id);
      });
    }
    return w;
  };
  return attachRelay(server, {
    path: "/rts",
    lag: opts.lag,
    maxRooms: opts.maxRooms,
    maxPlayers: 8,
    idle: { named: 60_000 },
    log: opts.log ?? logLine,
    host: (room) => new RtsRoom(room, world(roomMap(room.settings))),
  });
}

/** The lobby: quick play puts a page in a room on the map it asked for (D-128), waiting for a second side. */
export function rtsLobby(relay: Relay): (req: IncomingMessage, res: ServerResponse) => boolean {
  return lobbyHandler(relay, {
    settings: (body) => {
      const map = mapOf((body as Partial<RtsSettings> | null)?.map);
      return map ? ({ map: map.id } satisfies RtsSettings) : null;
    },
    fits: (r: RoomInfo, settings) => (r.info as Partial<RtsInfo>).open === true && (r.info as Partial<RtsInfo>).map === roomMap(settings).id,
  });
}

/** One room's match. */
export class RtsRoom extends TickRoom<RtsCommand[], RtsJoin, RtsWorld, RtsEvent> {
  game: RtsGame | null = null;
  readonly match = new Phases<MatchPhase>("waiting");
  private winner: Team | null = null;
  /** Each player's side, and what each spectator watches (D-127). */
  private readonly sides = new Map<string, Team>();
  private readonly watchers = new Map<string, Watch>();
  /** Players a side (D-127): the first page in a room with no one playing sets it. */
  size: 1 | 2 = 1;
  private bot: Bot | null = null;
  /** Its map (D-128), from its settings: `world` must be this map's. */
  readonly map: RtsMap;
  /** When the first page began waiting (server time), and whether one asked for the bot. */
  private waitingSince: number | null = null;
  private wantsBot = false;
  /** The level's cars (D-126): the room's own, run in every phase; where they are now. */
  traffic: TrafficSim | null = null;
  private cars: Pose[] = [];

  /** @param clock Run in real time (default); off for tests, which call `tick`. */
  constructor(room: HostedRoom, world: Promise<RtsWorld>, clock = true) {
    super(room, { tick: TICK, snapshotEvery: SNAPSHOT_EVERY, ready: world, clock });
    this.map = roomMap(room.settings);
  }

  // ---------------------------------------------------------------- joining

  protected parseJoin(data: unknown): RtsJoin | null {
    const j = (data ?? {}) as Partial<RtsJoin>;
    if (typeof j !== "object") return null;
    return {
      name: cleanName(j.name) || "Commander",
      vs: j.vs === "bot" ? "bot" : "any",
      size: j.size === 2 ? 2 : 1,
      ...(TEAMS.includes(j.side as Team) ? { side: j.side } : {}),
      ...(WATCHES.includes(j.watch as Watch) ? { watch: j.watch } : {}),
    };
  }

  protected added(id: string, join: RtsJoin): TickRole | null {
    if (!this.game) {
      const g = this.world.grid;
      // the cells a match changes are its own: what walls them, their tops, its buildings
      this.game = new RtsGame({ ...g, flags: g.flags.slice(), top: g.top.slice(), building: new Int32Array(g.building.length) }, this.world.layout);
      const fog = this.world.fog;
      // the fog on the room's clock: the pages draw it at the server time they show
      if (fog) this.game.fogAt = (x, y, h, night) => fog.at(x, y, h, this.time, night);
      this.traffic = this.world.traffic?.() ?? null;
    }
    if (join.watch) {
      this.watchers.set(id, join.watch);
      return "spectator";
    }
    if (id !== BOT && !this.humans().length) this.size = join.size ?? 1;
    // a side with room (not the bot's): the one asked for, else the emptier
    const room = TEAMS.filter((t) => this.on(t) < this.size && !(this.bot && this.sideOf(BOT) === t)).sort((a, b) => this.on(a) - this.on(b));
    const free = room.includes(join.side!) ? join.side! : room[0];
    if (!free) {
      this.kick(id, "this match has both its sides: open another room");
      return null;
    }
    this.sides.set(id, free);
    if (id !== BOT) {
      this.waitingSince ??= this.time;
      this.wantsBot ||= join.vs === "bot";
    }
    return "player";
  }

  protected removed(id: string): void {
    if (this.watchers.delete(id)) return;
    const side = this.sides.get(id);
    this.sides.delete(id);
    if (id === BOT) this.bot = null;
    // its side's last player gone: it loses
    if (side && this.match.phase === "playing" && !this.on(side)) this.end(side === "kiln" ? "tide" : "kiln");
    if (!this.humans().length) {
      this.waitingSince = null;
      this.wantsBot = false;
    }
  }

  private humans(): string[] {
    return [...this.sides.keys()].filter((id) => id !== BOT);
  }

  /** Players on a side (the bot among them). */
  private on(side: Team): number {
    return [...this.sides.values()].filter((s) => s === side).length;
  }

  // ---------------------------------------------------------------- orders

  /** No per-tick inputs: a page plays by commands. */
  protected input(): RtsCommand[] | null {
    return null;
  }

  /** The bot's orders, once a second. */
  protected step(id: string, orders: RtsCommand[]): void {
    const side = this.sides.get(id);
    if (side && this.match.phase === "playing") for (const c of orders) this.game!.order(side, c);
  }

  protected override command(id: string, data: unknown): void {
    const side = this.sides.get(id);
    const c = parseCommand(data);
    if (!side || !c) return;
    const why = this.match.phase === "playing" ? this.game!.order(side, c) : "the match hasn't started";
    if (why) this.emit({ kind: "refused", why }, id);
  }

  // ---------------------------------------------------------------- the match

  protected override update(): void {
    if (this.traffic) {
      this.traffic.advance(TICK);
      this.cars = this.traffic.poses(this.traffic.alpha);
      this.game?.traffic(this.cars);
    }
    const m = this.match;
    if (m.phase === "waiting") return this.waiting();
    if (m.phase === "ended") {
      if (m.over(this.time)) this.next();
      return;
    }
    const game = this.game!;
    game.step(TICK);
    for (const e of game.events) this.tell(e);
    game.events = [];
    if (game.winner) this.end(game.winner);
    else if (m.over(this.time)) this.end(null);
  }

  /** Both sides full: play; someone on each and waited long enough: play as they are. A side with no one: the bot, when asked for or waited long enough. */
  private waiting(): void {
    const waited = this.wantsBot || this.time - (this.waitingSince ?? this.time) >= MATCH.wait;
    const empty = TEAMS.find((t) => !this.on(t));
    if (empty && waited && this.humans().length && !this.bot) {
      let n = 0;
      if (this.addBot(BOT, { name: "Bot", vs: "any", side: empty }, () => (n++ % 20 === 0 && this.bot ? this.bot.orders() : []))) this.bot = new Bot(this.game!, empty);
    }
    if (TEAMS.some((t) => !this.on(t)) || (!waited && TEAMS.some((t) => this.on(t) < this.size))) return;
    this.game!.reset();
    this.match.set("playing", this.time, MATCH.seconds);
    this.winner = null;
    this.emit({ kind: "phase", phase: "playing", winner: null });
  }

  private end(winner: Team | null): void {
    this.winner = winner;
    this.match.set("ended", this.time, MATCH.ended);
    this.emit({ kind: "phase", phase: "ended", winner });
  }

  /** The next match, with whoever is still here: the bot leaves, and comes back if a page is still alone. */
  private next(): void {
    if (this.bot) this.removeBot(BOT);
    this.match.set("waiting", this.time);
    this.waitingSince = this.humans().length ? this.time : null;
    this.game!.reset();
  }

  /** An event to the players whose side sees where it happened (its own side's always), and the spectators watching that side or all. */
  private tell(e: GameEvent): void {
    const game = this.game!;
    // a landmark taken: everyone hears it
    if (e.kind === "taken") return this.emit(e);
    const out: RtsEvent = e.kind === "hit" ? e : { kind: "die", id: e.id, x: e.x, y: e.y };
    for (const [id, side] of [...this.sides, ...this.watchers])
      if (id !== BOT && (side === "all" || (e.kind === "die" && side === e.team) || game.seesPoint(side, e))) this.emit(out, id);
  }

  // ---------------------------------------------------------------- snapshots

  /** The match and who plays; and to a side's group (its players and the spectators watching it, D-127), what it sees. */
  protected override shared(group?: string): RtsWorldNet {
    return {
      ...(group ? { view: this.game!.view(group as Watch) } : {}),
      match: { ...this.match.net(), winner: this.winner },
      players: [...this.sides].map(([id, side]) => ({ id, name: this.joinOf(id)?.name ?? TEAM_NAMES[side], side, ...(id === BOT ? { bot: true as const } : {}) })),
      razed: this.game?.razed ?? [],
      marks: this.game?.marksNet() ?? [],
      ...this.light(),
      ...this.carsNet(),
      map: this.map.id,
    };
  }

  /** The cars round the map, in every `TRAFFIC.every`th shared snapshot by the server's clock (D-126): the same for every group, were there any. */
  private carsNet(): { cars?: VehicleNet[] } {
    if (!this.traffic || Math.round(this.time / (TICK * SNAPSHOT_EVERY)) % TRAFFIC.every) return {};
    return { cars: vehiclesNet(this.cars, trafficArea(this.map.rect)) };
  }

  /** Night now, and when the light changes next on the server's clock: by the match's own time, while it is played. */
  private light(): { night: boolean; light: number | null } {
    const g = this.game;
    if (!g || this.match.phase !== "playing") return { night: false, light: null };
    return { night: g.night, light: this.time + (nextLight(g.time) - g.time) };
  }

  /** A player's side, or what a spectator watches (D-127): the group whose shared snapshot it gets, serialized once for all in it. */
  protected override groupOf(id: string): Watch | undefined {
    return this.sides.get(id) ?? this.watchers.get(id);
  }

  protected override describe(): RtsInfo {
    return { phase: this.match.phase, open: this.match.phase === "waiting" && !this.bot && TEAMS.some((t) => this.on(t) < this.size), size: this.size, map: this.map.id };
  }

  sideOf(id: string): Team | null {
    return this.sides.get(id) ?? null;
  }

  /** What a spectator watches (D-127). */
  watchOf(id: string): Watch | null {
    return this.watchers.get(id) ?? null;
  }
}
