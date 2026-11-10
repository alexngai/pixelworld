import { describe, expect, it } from "vitest";
import { KINDS, RouteNetwork, TICK, TrafficSim, levelScale, parseRoutes, roadSpeed, vehicleBoxes, vehicleVoxels, type RoutesFile } from "../src";

/**
 * A small town: a 5×5 grid of streets 10 cells apart (primary along y = 20,
 * residential elsewhere), a tram line with dead ends along x = 25, and a
 * ferry across open water east of town.
 */
function town(): RoutesFile {
  const nodes: [number, number, number][] = [];
  const node = new Map<string, number>();
  const at = (x: number, y: number) => {
    const k = `${x},${y}`;
    if (!node.has(k)) {
      node.set(k, nodes.length);
      nodes.push([x + 0.5, y + 0.5, 0]);
    }
    return node.get(k)!;
  };
  const routes: RoutesFile["routes"] = [];
  const road = (x0: number, y0: number, x1: number, y1: number, cls: string) => {
    const pts: number[] = [];
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++)
      pts.push(x0 + ((x1 - x0) * i) / n + 0.5, y0 + ((y1 - y0) * i) / n + 0.5, (x0 + ((x1 - x0) * i) / n) * 0.05);
    routes.push({ net: "road", cls, a: at(x0, y0), b: at(x1, y1), pts, w: 0.4 });
  };
  for (let i = 0; i < 5; i++)
    for (let j = 0; j < 4; j++) {
      road(i * 10, j * 10, i * 10, (j + 1) * 10, "residential");
      road(j * 10, i * 10, (j + 1) * 10, i * 10, i === 2 ? "primary" : "residential");
    }
  // tram: two dead ends, a station node in the middle
  const tram = new Map<number, number>();
  const tnode = (y: number) => {
    if (!tram.has(y)) {
      tram.set(y, nodes.length);
      nodes.push([25.5, y + 0.5, 0]);
    }
    return tram.get(y)!;
  };
  routes.push({ net: "rail", kind: "cablecar", a: tnode(2), b: tnode(20), pts: [25.5, 2.5, 0, 25.5, 20.5, 1] });
  routes.push({ net: "rail", kind: "cablecar", a: tnode(20), b: tnode(38), pts: [25.5, 20.5, 1, 25.5, 38.5, 2] });
  routes.push({ net: "ferry", kind: "ferry", pts: [45, 5, 0, 52, 20, 0, 45, 35, 0] });
  return { version: 1, nodes, routes };
}

const MPC = 25;

function sim(seed = 7) {
  const net = new RouteNetwork(parseRoutes(town()));
  const s = new TrafficSim(net, { seed, metersPerCell: MPC, level: "drive" });
  s.setFocus(25, 20, 40);
  return s;
}

/** Distance from a point to a route's polyline, in plan. */
function distToRoute(net: RouteNetwork, id: number, x: number, y: number): number {
  const p = net.routes[id]!.pts;
  let best = Infinity;
  for (let i = 0; i + 5 < p.length; i += 3) {
    const ax = p[i]!;
    const ay = p[i + 1]!;
    const dx = p[i + 3]! - ax;
    const dy = p[i + 4]! - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y));
  }
  return best;
}

describe("routes", () => {
  it("rejects other versions and short routes", () => {
    expect(() => parseRoutes({ version: 2, nodes: [], routes: [] })).toThrow();
    expect(() => parseRoutes({ version: 1, nodes: [], routes: [{ net: "road", pts: [0, 0, 0] }] })).toThrow();
  });

  it("samples along a route and finds routes near a place", () => {
    const net = new RouteNetwork(parseRoutes(town()));
    const r = net.routes[0]!;
    expect(r.length).toBeCloseTo(10);
    const p = net.at(r, 2.5);
    expect([p.x, p.y]).toEqual([0.5, 3]);
    const near = net.spansNear(25, 20, 3);
    expect(near.some((s) => net.routes[s.route]!.kind === "cablecar")).toBe(true);
    expect(near.every((s) => Math.hypot(s.x - 25, s.y - 20) <= 3)).toBe(true);
  });
});

describe("traffic simulation", () => {
  it("is deterministic for a seed", () => {
    const a = sim(7);
    const b = sim(7);
    const c = sim(8);
    for (let i = 0; i < 300; i++) {
      a.tick();
      b.tick();
      c.tick();
    }
    expect(a.serialize()).toEqual(b.serialize());
    expect(a.poses()).toEqual(b.poses());
    expect(JSON.stringify(a.serialize())).not.toEqual(JSON.stringify(c.serialize()));
  });

  it("restores from its serialized state and carries on identically", () => {
    const a = sim(3);
    for (let i = 0; i < 120; i++) a.tick();
    const saved = JSON.parse(JSON.stringify(a.serialize()));
    const b = new TrafficSim(a.net, { seed: 999, metersPerCell: MPC, level: "drive" }, saved);
    for (let i = 0; i < 200; i++) {
      a.tick();
      b.tick();
    }
    expect(b.serialize()).toEqual(a.serialize());
  });

  it("steps in fixed ticks whatever the frame times", () => {
    const a = sim(5);
    const b = sim(5);
    const frames = [0.016, 0.017, 0.05, 0.001, 0.033, 0.02, 0.016];
    let total = 0;
    for (let k = 0; k < 40; k++)
      for (const dt of frames) {
        a.advance(dt);
        total += dt;
      }
    const ticks = a.ticks;
    expect(Math.abs(ticks * TICK - total)).toBeLessThan(TICK + 1e-9);
    for (let i = 0; i < ticks; i++) b.tick();
    expect(b.vehicles).toEqual(a.vehicles);
  });

  it("spawns every kind that has routes, and vehicles move", () => {
    const s = sim();
    s.tick();
    const counts = s.counts();
    expect(counts.car).toBeGreaterThan(5);
    expect(counts.bus ?? 0).toBeGreaterThan(0);
    expect(counts.cablecar).toBeGreaterThan(0);
    expect(counts.ferry).toBe(1);
    expect(counts.train).toBeUndefined();
    const before = new Map(s.poses().map((p) => [`${p.id}/${p.part}`, p]));
    for (let i = 0; i < 30; i++) s.tick();
    let moved = 0;
    for (const p of s.poses()) {
      const q = before.get(`${p.id}/${p.part}`);
      if (q && Math.hypot(p.x - q.x, p.y - q.y) > 0.1) moved++;
    }
    expect(moved).toBeGreaterThan(5);
  });

  it("keeps vehicles on their routes", () => {
    const s = sim(11);
    const scale = levelScale(MPC, "drive");
    for (let i = 0; i < 600; i++) {
      s.tick();
      if (i % 50) continue;
      for (const v of s.vehicles) {
        const head = s.along(v, 0);
        expect(distToRoute(s.net, v.cur.route, head.x, head.y)).toBeLessThan(1e-6);
        expect(s.along(v, 0).h).toBeGreaterThanOrEqual(0);
      }
      // a drawn car is within its lane offset of the route network, or cuts
      // a corner by less than half its length
      for (const p of s.poses()) {
        const k = KINDS[p.kind];
        const slack = ((k.lane + k.length / 2) / MPC) * scale.sizeScale + 1e-6;
        const d = Math.min(...s.net.routes.map((r) => distToRoute(s.net, r.id, p.x, p.y)));
        expect(d).toBeLessThan(slack + 1e-6);
      }
    }
  });

  it("drops vehicles far from the view and fills the new place", () => {
    const s = sim(2);
    for (let i = 0; i < 10; i++) s.tick();
    expect(s.vehicles.length).toBeGreaterThan(0);
    s.setFocus(5, 5, 12);
    for (let i = 0; i < 5; i++) s.tick();
    for (const v of s.vehicles) {
      const p = s.along(v, 0);
      expect(Math.hypot(p.x - 5, p.y - 5)).toBeLessThanOrEqual(12 * 1.25 + 1e-9);
    }
    expect(s.counts().car).toBeGreaterThan(0);
    // nowhere near a route: nothing
    s.setFocus(500, 500, 10);
    s.tick();
    expect(s.vehicles.length).toBe(0);
  });

  it("turns back at the end of a line", () => {
    const net = new RouteNetwork(parseRoutes(town()));
    const s = new TrafficSim(net, { seed: 1, metersPerCell: MPC, level: "drive", kinds: ["cablecar"] });
    s.setFocus(25, 20, 40);
    s.tick();
    const v = s.vehicles[0]!;
    const seen = new Set<string>();
    for (let i = 0; i < 30 * 200; i++) {
      s.tick();
      seen.add(`${v.cur.route}:${v.cur.dir}`);
    }
    // both legs, both ways
    expect(seen.size).toBe(4);
  });

  it("draws vehicles at least 0.55 cells long, unless the level caps their enlargement", () => {
    const len = (s: ReturnType<typeof levelScale>) => Math.max(...vehicleBoxes("car", 0, 0, 0, s, () => 1).map((b) => b.x1 - b.x0));
    // a flying level at 100 m: legible cars would be 55 m long
    expect(len(levelScale(100, "fly")) * 100).toBeCloseTo(55, 0);
    const capped = levelScale(100, "fly", { maxScale: 4 });
    expect(capped.sizeScale).toBe(4);
    expect(len(capped) * 100).toBeCloseTo(KINDS.car.length * 4, 0);
    // longer kinds are enlarged less, and never drawn smaller than real
    const ferry = Math.max(...vehicleBoxes("ferry", 0, 0, 0, capped, () => 1).map((b) => b.x1 - b.x0));
    expect(ferry * 100).toBeGreaterThanOrEqual(KINDS.ferry.length - 1e-6);
    expect(ferry * 100).toBeLessThan(KINDS.ferry.length * 1.5);
    // a cap above the legible size changes nothing (the driving level's 3x)
    expect(levelScale(MPC, "drive", { maxScale: 4 })).toEqual(levelScale(MPC, "drive"));
    // and the simulation takes the cap from its options
    const net = new RouteNetwork(parseRoutes(town()));
    expect(new TrafficSim(net, { metersPerCell: 100, level: "fly", vehicleScale: 4 }).scale.sizeScale).toBe(4);
  });

  it("crawls down a crooked brick street", () => {
    expect(roadSpeed("brick")).toBeLessThan(roadSpeed("living_street"));
  });

  it("builds a model for every kind facing its heading", () => {
    const scale = levelScale(MPC, "drive");
    for (const kind of Object.keys(KINDS) as (keyof typeof KINDS)[]) {
      const boxes = vehicleBoxes(kind, 0, 0, Math.PI / 4, scale, () => 1);
      expect(boxes.length).toBeGreaterThan(0);
      expect(boxes.every((b) => b.rot === Math.PI / 4 && b.x1 > b.x0 && b.z1 > b.z0)).toBe(true);
    }
    // every kind scales together: a bus is longer than a car
    const len = (k: keyof typeof KINDS) => Math.max(...vehicleBoxes(k, 0, 0, 0, scale, () => 1).map((b) => b.x1));
    expect(len("bus")).toBeGreaterThan(len("car"));
  });
});

describe("vehicle voxel sizes (D-064)", () => {
  it("keep a car legible, buses as wide as cars, and ferries in proportion", () => {
    const drive = levelScale(25, "drive", { heightStretch: 1.5 });
    const fly = levelScale(100, "fly", { heightStretch: 2, maxScale: 4 });
    const car = vehicleVoxels("car", drive);
    const bus = vehicleVoxels("bus", drive);
    const ferry = vehicleVoxels("ferry", drive);
    expect(car).toEqual({ length: 9, width: 4, height: 5 });
    expect(bus.length).toBeGreaterThan(car.length);
    expect(bus.width).toBeGreaterThanOrEqual(car.width);
    expect(bus.height).toBeGreaterThan(car.height);
    expect(ferry.length).toBeGreaterThan(2 * ferry.width);
    // a flying level draws them small; a render scale draws them in more voxels
    expect(vehicleVoxels("car", fly).length).toBeLessThan(car.length);
    expect(vehicleVoxels("car", drive, 2).length).toBe(18);
  });
});
