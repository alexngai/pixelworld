import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { stylePack } from "@pixelworlds/game/src/styles";
import { fogSampler, openWorld, type FogSampler, type WorldInfo } from "pixelworld/engine";
import { TrafficSim, loadRoutes, type Pose } from "pixelworld/traffic";
import { cleanName, vehiclesNet, type RoomInfo, type VehicleNet } from "../../index";
import { Phases, TickRoom, attachRelay, lobbyHandler, type HostedRoom, type Relay, type RelayLog, type TickRole } from "../../server";
import { Bot } from "./bot";
import { RtsGame, parseCommand, type GameEvent } from "./game";
import {
  MAP,
  MATCH,
  RTS_WORLD,
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
  type RtsSnap,
  type RtsWorldNet,
  type Team,
  nextLight,
  TRAFFIC,
  trafficArea,
} from "./rules";

/**
 * Fogfront's server (D-121): a `TickRoom` per room on `/rts?room=`, run by
 * commands. Pages send orders (`TickClient.command`), never per-tick inputs;
 * the room checks each and carries it out in the match (game.ts), and says
 * why when it can't. Each player's snapshot is what its side sees (the fog
 * of war); the shared one has the match and who plays. Two pages play each
 * other; a page alone gets the bot after `MATCH.wait` seconds (at once with
 * `vs: "bot"`), which plays through the same orders. A side whose hearth
 * falls, or whose player leaves, loses; after the result the next match
 * starts with whoever is there. The level's buildings knocked down this
 * match are in the shared snapshot, so a page that comes late takes them out
 * of its world too (D-124). Each room runs the level's cars on the motorway
 * (D-126): they are in the shared snapshot, the same for every page, and
 * units wait for them to pass.
 */

/** The bot's id. */
export const BOT = "bot";

export interface RtsWorld {
  /** The play area's cells and buildings, as the level has them: each room's match gets its own copy of the cells. */
  grid: MapGrid;
  /** The level's fog as a number (D-125), or null where its style has none: each room reads it on its own clock. */
  fog: FogSampler | null;
  /** The level's cars on its big roads, a simulation for each room (D-126); none where the level has no routes. */
  traffic?: (() => TrafficSim) | null;
}

/** The level's cars on its big roads over the map (D-126): a new simulation for each room, or null where the level has no routes. */
export async function rtsTraffic(world: Pick<WorldInfo, "url" | "manifest">, map = MAP): Promise<(() => TrafficSim) | null> {
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

/** Open the driving level over HTTP and read the play area's cells. */
export async function openRtsWorld(worldUrl: string): Promise<RtsWorld> {
  const { world, query } = await openWorld({ worldUrl, style: stylePack });
  await query.ensure(MAP.x0, MAP.y0, MAP.x0 + MAP.w, MAP.y0 + MAP.h);
  return { grid: buildGrid(query), fog: fogSampler(world, query), traffic: await rtsTraffic(world) };
}

export function logLine(l: RelayLog): void {
  const what = l.kind === "error" ? `the game hit an error: ${l.error instanceof Error ? (l.error.stack ?? l.error.message) : String(l.error)}` : [l.kind, l.id, l.message].filter(Boolean).join(" ");
  (l.kind === "error" ? console.error : console.log)(`rts room ${l.room}: ${what}`);
}

/** Fogfront on an HTTP server that also serves the page and the world package: `/rts?room=`. */
export function attachRts(server: Server, opts: { lag?: number; maxRooms?: number; log?: (l: RelayLog) => void } = {}): Relay {
  let opened: Promise<RtsWorld> | null = null;
  const world = () => {
    if (!opened) {
      const { port } = server.address() as AddressInfo;
      opened = openRtsWorld(`http://localhost:${port}${RTS_WORLD}`);
      opened.catch((e: unknown) => {
        console.error("rts: the world didn't open:", e);
        opened = null;
      });
    }
    return opened;
  };
  return attachRelay(server, {
    path: "/rts",
    lag: opts.lag,
    maxRooms: opts.maxRooms,
    maxPlayers: 8,
    idle: { named: 60_000 },
    log: opts.log ?? logLine,
    host: (room) => new RtsRoom(room, world()),
  });
}

/** The lobby: quick play puts a page in a room waiting for a second side. */
export function rtsLobby(relay: Relay): (req: IncomingMessage, res: ServerResponse) => boolean {
  return lobbyHandler(relay, { fits: (r: RoomInfo) => (r.info as Partial<RtsInfo>).open === true });
}

/** One room's match. */
export class RtsRoom extends TickRoom<RtsCommand[], RtsJoin, RtsWorld, RtsEvent> {
  game: RtsGame | null = null;
  readonly match = new Phases<MatchPhase>("waiting");
  private winner: Team | null = null;
  /** Each player's side. */
  private readonly sides = new Map<string, Team>();
  private bot: Bot | null = null;
  /** When the first page began waiting (server time), and whether one asked for the bot. */
  private waitingSince: number | null = null;
  private wantsBot = false;
  /** The level's cars (D-126): the room's own, run in every phase; where they are now. */
  traffic: TrafficSim | null = null;
  private cars: Pose[] = [];

  /** @param clock Run in real time (default); off for tests, which call `tick`. */
  constructor(room: HostedRoom, world: Promise<RtsWorld>, clock = true) {
    super(room, { tick: TICK, snapshotEvery: SNAPSHOT_EVERY, ready: world, clock });
  }

  // ---------------------------------------------------------------- joining

  protected parseJoin(data: unknown): RtsJoin | null {
    const j = (data ?? {}) as Partial<RtsJoin>;
    if (typeof j !== "object") return null;
    return { name: cleanName(j.name) || "Commander", vs: j.vs === "bot" ? "bot" : "any" };
  }

  protected added(id: string, join: RtsJoin): TickRole | null {
    if (!this.game) {
      const g = this.world.grid;
      // the cells a match changes are its own: what walls them, their tops, its buildings
      this.game = new RtsGame({ ...g, flags: g.flags.slice(), top: g.top.slice(), building: new Int32Array(g.building.length) });
      const fog = this.world.fog;
      // the fog on the room's clock: the pages draw it at the server time they show
      if (fog) this.game.fogAt = (x, y, h, night) => fog.at(x, y, h, this.time, night);
      this.traffic = this.world.traffic?.() ?? null;
    }
    const free = TEAMS.find((t) => ![...this.sides.values()].includes(t));
    if (!free || (this.bot && id !== BOT)) {
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
    const side = this.sides.get(id);
    this.sides.delete(id);
    if (id === BOT) this.bot = null;
    if (side && this.match.phase === "playing") this.end(side === "kiln" ? "tide" : "kiln");
    if (!this.humans().length) {
      this.waitingSince = null;
      this.wantsBot = false;
    }
  }

  private humans(): string[] {
    return [...this.sides.keys()].filter((id) => id !== BOT);
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

  /** Two sides: play. One page alone: the bot, when it asked or has waited long enough. */
  private waiting(): void {
    if (this.sides.size === 1 && this.humans().length === 1 && (this.wantsBot || this.time - (this.waitingSince ?? this.time) >= MATCH.wait)) {
      const side = TEAMS.find((t) => ![...this.sides.values()].includes(t))!;
      let n = 0;
      if (this.addBot(BOT, { name: "Bot", vs: "any" }, () => (n++ % 20 === 0 && this.bot ? this.bot.orders() : []))) this.bot = new Bot(this.game!, side);
    }
    if (this.sides.size < 2) return;
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

  /** An event to the players whose side sees where it happened (its own side's always). */
  private tell(e: GameEvent): void {
    const game = this.game!;
    // a landmark taken: everyone hears it
    if (e.kind === "taken") return this.emit(e);
    const out: RtsEvent = e.kind === "hit" ? e : { kind: "die", id: e.id, x: e.x, y: e.y };
    for (const [id, side] of this.sides)
      if (id !== BOT && (e.kind === "die" ? side === e.team || game.seesPoint(side, e) : game.seesPoint(side, e))) this.emit(out, id);
  }

  // ---------------------------------------------------------------- snapshots

  protected override shared(): RtsWorldNet {
    return {
      match: { ...this.match.net(), winner: this.winner },
      players: [...this.sides].map(([id, side]) => ({ id, name: this.joinOf(id)?.name ?? TEAM_NAMES[side], side, ...(id === BOT ? { bot: true as const } : {}) })),
      razed: this.game?.razed ?? [],
      marks: this.game?.marksNet() ?? [],
      ...this.light(),
      ...this.carsNet(),
    };
  }

  /** The cars round the map, in every `TRAFFIC.every`th shared snapshot by the server's clock (D-126): the same for every group, were there any. */
  private carsNet(): { cars?: VehicleNet[] } {
    if (!this.traffic || Math.round(this.time / (TICK * SNAPSHOT_EVERY)) % TRAFFIC.every) return {};
    return { cars: vehiclesNet(this.cars, trafficArea()) };
  }

  /** Night now, and when the light changes next on the server's clock: by the match's own time, while it is played. */
  private light(): { night: boolean; light: number | null } {
    const g = this.game;
    if (!g || this.match.phase !== "playing") return { night: false, light: null };
    return { night: g.night, light: this.time + (nextLight(g.time) - g.time) };
  }

  /** What the player's side sees. */
  protected override snapshot(id: string): RtsSnap {
    return this.game!.view(this.sides.get(id)!);
  }

  protected override describe(): RtsInfo {
    return { phase: this.match.phase, open: this.sides.size < 2 && this.match.phase === "waiting" };
  }

  sideOf(id: string): Team | null {
    return this.sides.get(id) ?? null;
  }
}
