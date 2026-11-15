import { readFileSync } from "node:fs";
import { stylePack } from "@pixelworlds/game/src/styles";
import { openWorld } from "pixelworld/engine";
import { TrafficSim, loadRoutes, type Pose, type RouteNetwork } from "pixelworld/traffic";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { RemoteTraffic, ServerClock, vehiclesNet } from "../src/index";

/**
 * Traffic a server runs (D-126): the simulation in Node over San Francisco's
 * routes (`openWorld`'s package), the cars on the wire, and a page drawing
 * them in between snapshots.
 */

const ROOT = new URL("../../../", import.meta.url);
/** The Presidio, from Baker Beach to Crissy Field (Fogfront's map). */
const AREA = { x0: 118, y0: 140, w: 144, h: 110 };

describe("the traffic simulation on a server (D-126)", () => {
  let net: RouteNetwork;
  let make: (seed?: number) => TrafficSim;

  beforeAll(async () => {
    vi.stubGlobal("fetch", async (url: string | URL) => new Response(readFileSync(new URL(`fixtures${new URL(String(url)).pathname}`, ROOT))));
    const { world } = await openWorld({ worldUrl: "https://pixelworld.test/sf/", style: stylePack });
    net = (await loadRoutes(world.url, world.manifest))!;
    const m = world.manifest;
    make = (seed = 1) => {
      const sim = new TrafficSim(net, {
        seed,
        metersPerCell: m.scale.metersPerCell,
        level: m.level,
        heightStretch: m.depiction?.heightStretch,
        vehicleScale: m.depiction?.vehicleScale,
        kinds: ["car"],
        density: 0.5,
        routes: (r) => r.cls === "motorway" || r.cls === "trunk",
      });
      sim.setFocus(AREA.x0 + AREA.w / 2, AREA.y0 + AREA.h / 2, Math.hypot(AREA.w, AREA.h) / 2);
      return sim;
    };
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("loads the level's routes in Node, as openWorld opens its package", () => {
    expect(net.routes.length).toBe(16426);
    const nets = new Map<string, number>();
    for (const r of net.routes) nets.set(r.net, (nets.get(r.net) ?? 0) + 1);
    expect(Object.fromEntries(nets)).toMatchObject({ rail: 134, ferry: 20 }); // trains and ferries, for maps that cross them
  });

  it("keeps cars on the motorway over the Presidio, and none turns back at a slip road's end", () => {
    const sim = make();
    const poses: Pose[][] = [];
    for (let i = 0; i < 20 * 120; i++) {
      sim.advance(1 / 20);
      for (const v of sim.vehicles) {
        expect(["motorway", "trunk"]).toContain(net.routes[v.cur.route]!.cls);
        expect(v.dwell).toBe(0);
      }
      if (i % 200 === 0) poses.push(sim.poses(sim.alpha));
    }
    const inArea = poses.slice(1).map((p) => vehiclesNet(p, AREA).length);
    expect(Math.min(...inArea)).toBeGreaterThan(25);
    expect(Math.max(...inArea)).toBeLessThan(80);
  });

  it("is deterministic and serializable: the same seed, or a restored state, runs the same", () => {
    const [a, b] = [make(4), make(4)];
    for (let i = 0; i < 600; i++) [a, b].forEach((s) => s.advance(1 / 20));
    expect(b.poses(b.alpha)).toEqual(a.poses(a.alpha));
    const c = new TrafficSim(net, { metersPerCell: 25, level: "drive", kinds: ["car"], density: 0.5, routes: (r) => r.cls === "motorway" || r.cls === "trunk" }, JSON.parse(JSON.stringify(a.serialize())));
    for (let i = 0; i < 100; i++) [a, c].forEach((s) => s.advance(1 / 20));
    expect(c.vehicles.map((v) => [v.id, v.s])).toEqual(a.vehicles.map((v) => [v.id, v.s]));
  });

  it("costs a server little: a tick and its poses well under a millisecond", () => {
    const sim = make();
    for (let i = 0; i < 400; i++) sim.advance(1 / 20);
    const t0 = performance.now();
    for (let i = 0; i < 400; i++) {
      sim.advance(1 / 20);
      sim.poses(sim.alpha);
    }
    expect((performance.now() - t0) / 400).toBeLessThan(1);
  });
});

describe("cars on the wire (D-126)", () => {
  const car = (id: number, x: number, y: number, heading = 0): Pose => ({ id, kind: "car", variant: 3, part: 0, x, y, h: 1.234, heading });

  it("keeps those in the area, cells to a hundredth, heights to a tenth, in under 45 bytes a car", () => {
    const list = vehiclesNet([car(1, 10.123456, 5.5, 1.23456), car(2, 99, 5)], { x0: 0, y0: 0, w: 50, h: 50 });
    expect(list).toEqual([[1, "car", 3, 0, 10.12, 5.5, 1.2, 1.23]]);
    expect(JSON.stringify(vehiclesNet([car(12345, 123.45, 234.56, -2.34)])).length).toBeLessThan(45);
  });

  it("a page draws each car in between snapshots on the server's clock, and lets go of the ones gone", () => {
    const clock = new ServerClock();
    const remote = new RemoteTraffic({ delay: 0.3, clock });
    // snapshots five a second at server time t, each arriving 0.05 s later on the page's clock (100 s ahead)
    const at = (t: number) => vehiclesNet([car(1, 10 + 2 * t, 5), ...(t < 0.6 ? [car(2, 20, 5 + t)] : [])]);
    for (const t of [0, 0.2, 0.4, 0.6]) {
      clock.sample(t, 100 + t + 0.05);
      remote.push(t, at(t), 100 + t + 0.05);
    }
    // at page time 100.7 it shows server time 0.35 (0.7 − 0.05 − 0.3): car 2 is still there, gone by 0.6
    const now = remote.poses(100.7);
    expect(now.map((p) => p.id)).toEqual([1, 2]);
    expect(now[0]!.x).toBeCloseTo(10.7, 5);
    expect(now[0]).toMatchObject({ kind: "car", variant: 3, part: 0, h: 1.2 });
    const later = remote.poses(100.85); // 0.5 s: in between, and past car 2's last
    expect(later.map((p) => p.id)).toEqual([1]);
    expect(later[0]!.x).toBeCloseTo(11, 5);
    // it comes back: drawn again
    clock.sample(0.8, 100.85);
    remote.push(0.8, vehiclesNet([car(1, 11.6, 5), car(2, 20, 6)]), 100.85);
    expect(remote.poses(101.2).map((p) => p.id)).toEqual([1, 2]);
  });
});
