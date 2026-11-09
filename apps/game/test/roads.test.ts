import { RouteNetwork, parseRoutes, type RoutesFile } from "@pixelworld/sim";
import { describe, expect, it } from "vitest";
import { NO_INPUT, driveCar, type CarState } from "../src/car";
import { Decks, DriveWorld, FlyWorld, blocksCar, roadSpeed, surfaceSpeed } from "../src/ground";
import { CarPilot, Path, curveSpeed, smoothPath } from "../src/pilot";
import { cellRoadDistance, nearestRoad, roadDirection, roadUnder, straightAhead, traceRoad } from "../src/roads";
import { RoadGraph } from "../src/route";
import { FakeWorld, building } from "./fake";

/**
 * The road network as the game reads it: a 40×30 world of desert at 0 with
 * a primary road along row 5 from x = 2 to 30 that turns south at x = 30, a
 * divided boulevard (two one-cell carriageways, x = 10 and 11) that jogs
 * across at a junction, a lake at x ≥ 34 and a building at (14–16, 7–9).
 */
function world() {
  const w = new FakeWorld(40, 30, (x) => ({ h: 0, surface: "desert", water: x >= 34 ? 0 : null }));
  const row: [number, number][] = [];
  for (let x = 2; x <= 30; x++) row.push([x, 5]);
  for (let y = 6; y <= 20; y++) row.push([30, y]);
  w.road("primary", row);
  // the boulevard: x = 10 south from the road to row 12, then (jogging at 12) x = 11 on to row 25
  const a: [number, number][] = [];
  for (let y = 5; y <= 12; y++) a.push([10, y]);
  w.road("secondary", a);
  const b: [number, number][] = [];
  for (let y = 13; y <= 25; y++) b.push([11, y]);
  w.road("secondary", b);
  w.objects.push(building(14, 7, 16, 9));
  return w;
}

describe("roads", () => {
  it("measures the distance to a cell's centre line and finds the asphalt under a point", () => {
    const w = world();
    const q = w.query();
    const road = q.roadAt(5.5, 5.5)!;
    expect(cellRoadDistance(5.5, 5.9, 5, 5, road)).toBeCloseTo(0.4, 9);
    expect(roadUnder(q, 5.5, 5.6)?.class).toBe("primary");
    expect(roadUnder(q, 5.5, 5.9)).toBeNull(); // 0.4 from the line, the road 0.125 wide
    expect(roadUnder(q, 5.5, 5.9, 0.3)?.class).toBe("primary");
    expect(roadUnder(q, 5.5, 8)).toBeNull();
  });

  it("follows the road along a heading, round its bends and across a divided road's jog", () => {
    const q = world().query();
    const east = traceRoad(q, 20.5, 5.5, 0, 20);
    expect(east.slice(0, 3)).toEqual([{ x: 20.5, y: 5.5 }, { x: 21.5, y: 5.5 }, { x: 22.5, y: 5.5 }]);
    expect(east[east.length - 1]).toEqual({ x: 30.5, y: 5.5 }); // a right-angle corner is the driver's to take
    const round = traceRoad(q, 20.5, 5.5, 0, 20, Math.PI / 2);
    expect(round[round.length - 1]).toEqual({ x: 30.5, y: 15.5 }); // unless it may turn that far
    const south = traceRoad(q, 10.5, 8.5, Math.PI / 2, 10);
    expect(south.map((p) => p.x)).toEqual([10.5, 10.5, 10.5, 10.5, 10.5, 11.5, 11.5, 11.5, 11.5, 11.5, 11.5]);
    expect(traceRoad(q, 20.5, 8.5, 0, 5)).toEqual([]); // off the road
  });

  it("says how far the road runs straight ahead", () => {
    const q = world().query();
    expect(straightAhead(q, 20.5, 5.5, 0, 20)).toBeCloseTo(10, 6);
    expect(straightAhead(q, 5.5, 5.5, Math.PI, 20)).toBeCloseTo(3, 6); // to the road's west end
    expect(straightAhead(q, 20.5, 5.5, Math.PI / 4, 20)).toBeLessThan(1); // across the road
  });

  it("finds the nearest road and its direction nearest a heading", () => {
    const q = world().query();
    const r = nearestRoad(q, 20.2, 7.9, 5)!;
    expect([r.x, r.y]).toEqual([20.5, 5.5]);
    expect(roadDirection(r.road, 0.3)).toBe(0);
    expect(roadDirection(r.road, 2.9)).toBeCloseTo(Math.PI, 9);
    expect(nearestRoad(q, 20, 15, 3)).toBeNull();
  });
});

describe("the world for the car", () => {
  const drive = (w: FakeWorld, net: RouteNetwork | null = null) => new DriveWorld(w.query(), w.w, w.hgt, new Decks(net), () => null);

  it("sets top speeds by road class, surface and water", () => {
    const d = drive(world());
    expect(d.topSpeedAt(20.5, 5.5, 0)).toBe(roadSpeed("primary"));
    expect(d.topSpeedAt(20.5, 8, 0)).toBe(surfaceSpeed("desert"));
    expect(d.topSpeedAt(36, 8, 0)).toBe(0);
    expect(roadSpeed("motorway")).toBeGreaterThan(roadSpeed("primary"));
    expect(roadSpeed("unheard-of")).toBeGreaterThan(surfaceSpeed("desert"));
    expect(surfaceSpeed("sand")).toBeLessThan(surfaceSpeed("urban"));
  });

  it("is stopped by buildings and landmarks, not by trees or bridges, nor where a road runs", () => {
    const w = world();
    const d = drive(w);
    const at = (x: number, y: number) => d.obstacle({ x, y, heading: 0, length: 0.6, width: 0.3, dir: 1 });
    expect(at(13.8, 8)).toBe("building");
    expect(at(12, 8)).toBeNull();
    w.objects.push(building(20, 4.5, 22, 6.5)); // over the road
    expect(at(19.6, 5.5)).toBeNull();
    expect(blocksCar(building(0, 0, 1, 1, "tree.conifer"))).toBe(false);
    expect(blocksCar(building(0, 0, 1, 1, "landmark.bridge.arch"))).toBe(false);
    expect(blocksCar(building(0, 0, 1, 1, "landmark.tower"))).toBe(true);
  });

  it("bumps into traffic ahead, and lets traffic behind pass", () => {
    const w = world();
    let vehicles = [{ id: 1, kind: "car" as const, variant: 0, part: 0, x: 21, y: 5.5, h: 0, heading: 0, length: 0.6, width: 0.3 }];
    const d = new DriveWorld(w.query(), w.w, w.hgt, new Decks(null), () => ({ vehiclesNear: () => vehicles }));
    expect(d.obstacle({ x: 20.5, y: 5.5, heading: 0, length: 0.6, width: 0.3, dir: 1 })).toBe("vehicle");
    expect(d.obstacle({ x: 21.5, y: 5.5, heading: 0, length: 0.6, width: 0.3, dir: 1 })).toBeNull();
    vehicles = [];
    expect(d.obstacle({ x: 20.5, y: 5.5, heading: 0, length: 0.6, width: 0.3, dir: 1 })).toBeNull();
  });

  it("drives on bridge decks over water, and across gaps where a road's routes stop short", () => {
    const w = new FakeWorld(30, 10, (x) => ({ h: x >= 10 && x < 20 ? -4 : 2, water: x >= 10 && x < 20 ? -1 : null }));
    const routes: RoutesFile = {
      version: 1,
      nodes: [[2.5, 5.5, 2], [10.5, 5.5, 2], [12.5, 5.5, 2], [27.5, 5.5, 2]],
      routes: [
        { net: "road", cls: "primary", a: 0, b: 1, pts: [2.5, 5.5, 2, 10.5, 5.5, 2] },
        { net: "road", cls: "primary", a: 2, b: 3, deck: true, pts: [12.5, 5.5, 2, 20.5, 5.5, 2, 27.5, 5.5, 2] },
      ],
    };
    const net = new RouteNetwork(parseRoutes(routes));
    const d = drive(w, net);
    expect(d.groundAt(15, 5.5, 2)).toBe(2); // on the deck
    expect(d.groundAt(11.5, 5.5, 2)).toBe(2); // across the gap between the routes' ends
    expect(d.groundAt(15, 5.5, -4)).toBe(-4); // under it
    expect(d.groundAt(15, 8, 2)).toBe(-4); // beside it
    expect(d.topSpeedAt(15, 5.5, 2)).toBe(roadSpeed("primary"));
    const car: CarState = { x: 3, y: 5.5, h: 2, heading: 0, speed: 0, steer: 0 };
    for (let i = 0; i < 180; i++) driveCar(car, { ...NO_INPUT, throttle: 1 }, d, { pace: 1, length: 0.6, width: 0.3 }, 1 / 30);
    expect(car.x).toBeGreaterThan(22);
    expect(car.h).toBe(2);
  });

  it("rides a road's graded surface from its route, through a cut the terrain beside it stands over", () => {
    // ground at 4, a road cut down to 1.5 in its middle (as traffic's route says)
    const w = new FakeWorld(30, 10, () => ({ h: 4 }));
    const routes: RoutesFile = {
      version: 1,
      nodes: [[2.5, 5.5, 4], [27.5, 5.5, 4]],
      routes: [{ net: "road", cls: "primary", a: 0, b: 1, pts: [2.5, 5.5, 4, 12.5, 5.5, 1.5, 17.5, 5.5, 1.5, 27.5, 5.5, 4] }],
    };
    const d = drive(w, new RouteNetwork(parseRoutes(routes)));
    expect(d.groundAt(15, 5.5, 1.5)).toBe(1.5); // in the cut
    expect(d.groundAt(7.5, 5.6, 3)).toBeCloseTo(2.75, 9); // down its ramp
    expect(d.groundAt(15, 8, 1.5)).toBe(4); // beside the road
    expect(d.groundAt(15, 5.5, 4)).toBe(4); // a car up on the bank isn't in the cut
    expect(d.topSpeedAt(15, 5.6, 1.5)).toBe(roadSpeed("primary"));
    const car: CarState = { x: 3, y: 5.5, h: 4, heading: 0, speed: 0, steer: 0 };
    let lowest = 4;
    for (let i = 0; i < 240; i++) {
      driveCar(car, { ...NO_INPUT, throttle: 1 }, d, { pace: 1, length: 0.6, width: 0.3 }, 1 / 30);
      lowest = Math.min(lowest, car.h);
    }
    expect(car.x).toBeGreaterThan(25);
    expect(lowest).toBe(1.5);
  });

  it("gives the plane the top of the water or the ground, and towers' tops", () => {
    const w = world();
    w.cell(36, 8)!.water = 3;
    w.objects.push({ ...building(5, 20, 6, 21, "building.tower", 9) }, { ...building(7, 20, 8, 21, "landmark.bridge.arch", 6) });
    const f = new FlyWorld(w.query(), w.w, w.hgt);
    expect(f.groundAt(36.5, 8.5)).toBe(3);
    expect(f.groundAt(20, 20)).toBe(0);
    expect(f.objectTopAt(5.5, 20.5)).toBe(9);
    expect(f.objectTopAt(7.5, 20.5)).toBeNull();
  });
});

describe("planning and following a road route", () => {
  /** A square of roads with a short cut, a deck that stops a cell short of the road beyond, and a road under it. */
  function network(): RouteNetwork {
    const line = (pts: [number, number, number][]) => pts.flat();
    const file: RoutesFile = {
      version: 1,
      nodes: [[0.5, 0.5, 0], [20.5, 0.5, 0], [20.5, 20.5, 0], [0.5, 20.5, 0], [22.5, 0.5, 0], [40.5, 0.5, 0], [22.5, 2.5, -3]],
      routes: [
        { net: "road", cls: "primary", a: 0, b: 1, pts: line([[0.5, 0.5, 0], [10.5, 0.5, 0], [20.5, 0.5, 0]]) },
        { net: "road", cls: "secondary", a: 1, b: 2, pts: line([[20.5, 0.5, 0], [20.5, 20.5, 0]]) },
        { net: "road", cls: "secondary", a: 2, b: 3, pts: line([[20.5, 20.5, 0], [0.5, 20.5, 0]]) },
        { net: "road", cls: "motorway", a: 3, b: 0, pts: line([[0.5, 20.5, 0], [0.5, 0.5, 0]]) },
        // a deck from x = 22.5 on, joined across the 2-cell gap from node 1
        { net: "road", cls: "motorway", a: 4, b: 5, deck: true, pts: line([[22.5, 0.5, 0], [40.5, 0.5, 0]]) },
        // a road below, its end within the gap's reach but 3 steps down
        { net: "road", cls: "service", a: 6, b: 2, pts: line([[22.5, 2.5, -3], [22.5, 20.5, 0]]) },
      ],
    };
    return new RouteNetwork(parseRoutes(file));
  }

  it("plans from a route's middle to another's, across a gap at one height but not a drop", () => {
    const g = new RoadGraph(network());
    const plan = g.plan({ x: 10.2, y: 0.9 }, { x: 30, y: 0.2 })!;
    expect(plan.points[0]).toEqual({ x: 10.2, y: 0.9 });
    expect(plan.points[plan.points.length - 1]).toEqual({ x: 30, y: 0.5 });
    expect(plan.length).toBeCloseTo(0.4 + 10.3 + 2 + 7.5, 6);
    expect(plan.byClass).toEqual({ primary: 10.3, gap: 2, motorway: 7.5 });
    // the shorter way round the square
    const round = g.plan({ x: 10.5, y: 0.5 }, { x: 10.5, y: 20.5 })!;
    expect(round.length).toBeCloseTo(40, 6);
    expect(round.byClass.motorway).toBeCloseTo(20, 6);
    // along one route only
    expect(g.plan({ x: 2, y: 0.5 }, { x: 8, y: 0.5 })!.length).toBeCloseTo(6, 6);
    // node 6 (3 steps below the deck's end) isn't joined to it
    const under = g.plan({ x: 30, y: 0.5 }, { x: 22.5, y: 10 })!;
    expect(under.byClass.service).toBeGreaterThan(0);
    expect(under.byClass.gap).toBeCloseTo(2, 6);
  });

  it("smooths octilinear stairs into lines within a third of a cell", () => {
    const stairs: { x: number; y: number }[] = [];
    for (let i = 0; i < 10; i++) stairs.push({ x: 2 * i, y: i }, { x: 2 * i + 1, y: i });
    const raw = new Path(stairs);
    const smooth = smoothPath(stairs);
    for (const p of smooth) expect(Math.hypot(p.x - raw.at(raw.project(p.x, p.y)).x, p.y - raw.at(raw.project(p.x, p.y)).y)).toBeLessThan(0.34);
    expect(smooth[0]).toEqual(stairs[0]);
    expect(smooth[smooth.length - 1]).toEqual(stairs[stairs.length - 1]);
    expect(curveSpeed(0, 1, 11)).toBe(11);
    expect(curveSpeed(0.5, 1, 11)).toBeLessThan(curveSpeed(0.1, 1, 11));
  });

  it("drives a car along a planned route on the roads, and stops at its end", () => {
    const w = world();
    const d = new DriveWorld(w.query(), w.w, w.hgt, new Decks(null), () => null);
    const pts: { x: number; y: number }[] = [];
    for (let x = 3; x <= 30; x++) pts.push({ x: x + 0.5, y: 5.5 });
    for (let y = 6; y <= 18; y++) pts.push({ x: 30.5, y: y + 0.5 });
    const pilot = new CarPilot(pts);
    const car: CarState = { x: 3.5, y: 5.5, h: 0, heading: 0, speed: 0, steer: 0 };
    let off = 0;
    let t = 0;
    for (; t < 30 && !pilot.done; t += 1 / 30) {
      driveCar(car, pilot.input(car, 1, d.topSpeedAt(car.x, car.y, car.h)), d, { pace: 1, length: 0.6, width: 0.3 }, 1 / 30);
      if (!d.onRoad(car.x, car.y, car.h)) off++;
    }
    expect(pilot.done).toBe(true);
    expect(off).toBe(0);
    expect(t).toBeLessThan(10);
    for (let i = 0; i < 60; i++) driveCar(car, pilot.input(car, 1, 8), d, { pace: 1, length: 0.6, width: 0.3 }, 1 / 30);
    expect(car.speed).toBeLessThan(0.5);
    expect(Math.hypot(car.x - 30.5, car.y - 18.5)).toBeLessThan(1.5);
  });
});
