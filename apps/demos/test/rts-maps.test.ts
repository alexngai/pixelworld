import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TickClient, joinRoom } from "@pixelworlds/multiplayer";
import { serveStatic, type Relay } from "@pixelworlds/multiplayer/server";
import { DEFAULT_MAP, MAPS, planMap, type Layout } from "../src/rts/maps";
import { BUILDINGS, MAX_RISE, OBJECTIVE, RTS_LOBBY, WOODS, cellIndex, findPath, passable, walkFrom, type MapGrid, type RtsEvent, type RtsSnap, type RtsWorldNet } from "../src/rts/rules";
import { BOT, RtsRoom, attachRts, openRtsWorld, rtsLobby, type RtsWorld } from "../src/rts/server";
import { WORLDS } from "../vite.config";
import { loopback } from "@pixelworlds/multiplayer/testing";

/**
 * Fogfront's maps (D-128): the generator's hearths and seeps on each map's
 * level, every one reachable from both hearths and as far a walk for each
 * side; the map a room's setting, from the lobby's quick play; and the bot
 * taking an idle page's hearth on maps other than the Presidio. The levels
 * are served from `fixtures/` over HTTP, as the production server serves them.
 */

const FIXTURES = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
let server: Server;
let base: string;
const worlds = new Map<string, Promise<RtsWorld>>();
const worldOf = (id: string) => {
  const map = MAPS[id]!;
  if (!worlds.has(id)) worlds.set(id, openRtsWorld(`${base}/${map.world}/`, map));
  return worlds.get(id)!;
};

beforeAll(async () => {
  server = createServer(serveStatic(FIXTURES));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

const foot = (g: MapGrid, [x, y]: [number, number], size: number) => Array.from({ length: size * size }, (_, k) => cellIndex(g, x + (k % size), y + Math.floor(k / size)));

describe("Fogfront's maps from a level's cells (D-128)", () => {
  it("every map's level is one a build ships", () => {
    expect(WORLDS).toEqual(expect.arrayContaining(Object.values(MAPS).map((m) => m.world)));
    expect(MAPS[DEFAULT_MAP]!.layout).toBeDefined(); // the Presidio's, by hand
  });

  for (const id of Object.keys(MAPS))
    it(`${id}: two hearths on open, level ground with a way round them, and every seep and landmark reachable from both, as far for each side`, async () => {
      const { grid: g, layout: given } = await worldOf(id);
      // the generator, even where the map has its own (the Presidio): the same each time
      const plans: Layout[] = [planMap(g), ...(MAPS[id]!.layout ? [given] : [])];
      expect(planMap(g)).toEqual(plans[0]);
      for (const plan of plans) {
        const size = BUILDINGS.hearth.size;
        for (const at of plan === plans[0] ? Object.values(plan.hearths) : []) {
          const cells = foot(g, at, size);
          expect(cells.every((i) => i >= 0 && passable(g, (i % g.w) + g.x0, Math.floor(i / g.w) + g.y0) && !(g.flags[i]! & WOODS))).toBe(true);
          const hs = cells.map((i) => g.height[i]!);
          expect(Math.max(...hs) - Math.min(...hs)).toBeLessThanOrEqual(MAX_RISE);
          for (let d = -1; d <= size; d++) for (const [x, y] of [[at[0] + d, at[1] - 1], [at[0] + d, at[1] + size], [at[0] - 1, at[1] + d], [at[0] + size, at[1] + d]] as const) expect(passable(g, x, y)).toBe(true);
        }
        expect(plan.seeps).toHaveLength(8);
        const { kiln, tide } = plan.hearths;
        for (const [hx, hy] of [kiln, tide]) {
          const from = { x: hx - 0.5, y: hy + 1.5 };
          const goals = [...plan.seeps.map(([x, y]) => ({ x: x + 0.5, y: y + 0.5 })), ...(g.objectives ?? []).map(({ x, y }) => ({ x, y })), { x: kiln[0] - 0.5, y: kiln[1] + 1.5 }, { x: tide[0] - 0.5, y: tide[1] + 1.5 }];
          for (const goal of goals) expect(findPath(g, from, goal).at(-1) ?? from).toEqual(goal);
        }
        if (plan !== plans[0]) continue; // the hand-placed Presidio isn't held to the generator's fairness
        // each side's own three as far a walk from its hearth as the other's; the two between as far from either
        const a = walkFrom(g, foot(g, kiln, size));
        const b = walkFrom(g, foot(g, tide, size));
        const walks = plan.seeps.map(([x, y]) => [a[cellIndex(g, x, y)]!, b[cellIndex(g, x, y)]!] as const);
        const kilns = walks.slice(0, 3).map(([own]) => own);
        const tides = walks.slice(3, 6).map(([, own]) => own);
        kilns.forEach((w, k) => expect(Math.abs(w - tides[k]!)).toBeLessThanOrEqual(0.5));
        for (const [fromA, fromB] of walks.slice(6)) expect(Math.abs(fromA - fromB)).toBeLessThanOrEqual(1);
      }
    }, 30_000);

  it("takes in each map's landmarks as objectives", async () => {
    const ids = async (id: string) => (await worldOf(id)).grid.objectives!.map((o) => o.id).sort();
    expect(await ids("midtown")).toEqual(["chrysler-building", "empire-state-building", "flatiron-building", "grand-central-terminal"]);
    expect(await ids("kowloon")).toEqual(["hong-kong-cultural-centre", "the-peninsula", "tsim-sha-tsui-clock-tower"]);
    // the temples, shrines and torii of Higashiyama: a pair held from one spot counts once
    const kyoto = (await worldOf("higashiyama")).grid.objectives!;
    expect(kyoto.length).toBeGreaterThanOrEqual(4);
    for (const a of kyoto) for (const b of kyoto) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(2 * OBJECTIVE.radius);
    // the High Roller, which no cell's middle meets, from its anchor
    expect(await ids("strip")).toEqual(["eiffel-replica", "high-roller"]);
  }, 30_000);
});

describe("Fogfront's map as a room's setting (D-128)", () => {
  /** A room on the loopback, on a map. */
  const opened = async (id: string) => {
    const world = await worldOf(id);
    const lb = loopback((room) => new RtsRoom(room, Promise.resolve(world), false), { fps: 20, settings: { map: id } });
    await new Promise((r) => setTimeout(r, 0)); // the world arrives
    return lb;
  };

  for (const id of ["midtown", "strip"])
    it(`${id}: the bot plays a match against a page that does nothing, and takes its hearth`, async () => {
      const lb = await opened(id);
      const page = lb.join(0.05);
      const worldsSeen: RtsWorldNet[] = [];
      const client = new TickClient<never, RtsSnap, RtsWorldNet, RtsEvent>(page.room, { tick: 1 / 20, now: lb.now, onWorld: (w) => void worldsSeen.push(w) });
      client.hello({ name: "Idle", vs: "bot" });
      const frame = () => {
        client.sync();
        client.due();
      };
      lb.run(1, frame);
      expect(lb.host.match.phase).toBe("playing");
      expect(worldsSeen.at(-1)!.map).toBe(id);
      expect(lb.host.info()).toMatchObject({ map: id });
      let seconds = 0;
      while (lb.host.match.phase === "playing" && seconds < 900) {
        lb.run(10, frame);
        seconds += 10;
      }
      expect(lb.host.match.phase).toBe("ended");
      expect(worldsSeen.at(-1)!.match.winner).toBe(lb.host.sideOf(BOT));
      expect(lb.failed).toBeUndefined();
    }, 120_000);

  it("quick play opens a room on the map a page asks for, puts the next page asking for it there, and refuses a map there isn't; the room opens its map's level", async () => {
    let lobby: ReturnType<typeof rtsLobby> | null = null;
    const files = serveStatic(FIXTURES);
    const http = createServer((req, res) => lobby?.(req, res) || files(req, res));
    await new Promise<void>((r) => http.listen(0, r));
    const relay: Relay = attachRts(http, { log: () => {} });
    lobby = rtsLobby(relay);
    const base = `http://localhost:${(http.address() as AddressInfo).port}`;
    const url = `${base}${RTS_LOBBY}`;
    const quick = async (settings?: unknown) => {
      const res = await fetch(`${url}/quick`, { method: "POST", body: JSON.stringify({ settings }) });
      return { status: res.status, ...((await res.json()) as { room?: string }) };
    };
    try {
      const kowloon = await quick({ map: "kowloon" });
      expect(kowloon.status).toBe(200);
      expect((await quick({ map: "kowloon" })).room).toBe(kowloon.room);
      const presidio = await quick();
      expect(presidio.room).not.toBe(kowloon.room);
      expect((await quick({ map: "presidio" })).room).toBe(presidio.room);
      expect((await quick({ map: "atlantis" })).status).toBe(400);
      const rooms = relay.list();
      expect(Object.fromEntries(rooms.map((r) => [r.name, (r.info as { map: string }).map]))).toEqual({ [kowloon.room!]: "kowloon", [presidio.room!]: "presidio" });
      // a page in each hears its room's map, once the server has opened that map's level
      const hear = async (code: string) => {
        const room = await joinRoom(`${base}/rts`, code);
        const map = await new Promise<string>((resolve) => new TickClient<never, RtsSnap, RtsWorldNet, RtsEvent>(room, { tick: 1 / 20, onWorld: (w) => resolve(w.map) }).hello({ name: "Look", vs: "any" }));
        room.close();
        return map;
      };
      expect(await Promise.all([hear(kowloon.room!), hear(presidio.room!)])).toEqual(["kowloon", "presidio"]);
    } finally {
      relay.close();
      http.close();
    }
  }, 30_000);
});
