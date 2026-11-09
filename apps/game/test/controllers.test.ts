import type { WorldManifest } from "@pixelworld/engine";
import { describe, expect, it } from "vitest";
import { CarController } from "../src/carController";
import { Bob, Follow } from "../src/follow";
import { geoToPose, levelLabel, levelUrl, poseToGeo, startFor } from "../src/levels";
import { distanceKm, landmarkName, landmarkPlaces, nearestPlace } from "../src/places";
import { PlaneController } from "../src/planeController";
import { PLANE, TAKEOFF, pace } from "../src/tuning";
import { FakeWorld, building, fakeView } from "./fake";

/**
 * The controllers on a fake view (the engine's public types): a desert at 1
 * step with a long straight primary road along row 10 (x 2–60), a short one
 * along row 20 (x 5–9), and a building beside the long road.
 */
function world() {
  const w = new FakeWorld(80, 40, () => ({ h: 1, surface: "desert" }));
  const long: [number, number][] = [];
  for (let x = 2; x <= 60; x++) long.push([x, 10]);
  w.road("primary", long);
  const short: [number, number][] = [];
  for (let x = 5; x <= 9; x++) short.push([x, 20]);
  w.road("secondary", short);
  w.objects.push(building(20, 12, 24, 15));
  return w;
}

describe("the car controller", () => {
  it("starts on the nearest road, facing along it toward where it is heading, as a player car with a silhouette", async () => {
    const w = world();
    const { view, focus, entities } = fakeView(w);
    const car = new CarController({ start: { x: 30.2, y: 12.6 }, toward: { x: 0, y: 10 } });
    await car.attach(view);
    expect([car.state.x, car.state.y, car.state.h]).toEqual([30.5, 10.5, 1]);
    expect(car.state.heading).toBeCloseTo(Math.PI, 9);
    const e = entities.items[0]!;
    expect(e.spec.model).toMatchObject({ group: "vehicle.car.player" });
    expect(e.silhouette).toBe(true);
    expect([focus.x, focus.y]).toEqual([30.5, 10.5]);
    // a lon/lat start, through the geo grid
    const b = new CarController({ start: { lon: 0.075, lat: -0.205 } });
    await b.attach(fakeView(w).view);
    expect([b.state.x, b.state.y]).toEqual([7.5, 20.5]);
  });

  it("drives on its keys, with the camera ahead of it, and stops at a building", async () => {
    const w = world();
    const { view, focus } = fakeView(w);
    const car = new CarController({ start: { x: 10.5, y: 10.5 }, heading: 0 });
    await car.attach(view);
    car.keyDown({ key: "ArrowUp" });
    for (let i = 0; i < 60; i++) car.update(1 / 30);
    expect(car.state.x).toBeGreaterThan(14);
    expect(car.state.speed).toBeGreaterThan(3);
    expect(focus.x).toBeGreaterThan(car.state.x - 0.5); // looking ahead
    car.keyUp({ key: "ArrowUp" });
    // across the desert into the building
    car.place(22, 17, -Math.PI / 2);
    car.paused = true;
    car.update(1 / 30);
    expect(car.state.y).toBe(17); // paused: the loop doesn't step it
    for (let i = 0; i < 90; i++) car.step(1 / 30, { throttle: 1, brake: 0, steer: 0 });
    expect(car.bump?.reason).toBe("building");
    expect(car.state.y).toBeGreaterThan(15);
    expect(car.state.speed).toBeLessThan(1);
  });

  it("keeps to the road with the assist, and may take off fast on a long straight", async () => {
    const w = world();
    const { view } = fakeView(w);
    const car = new CarController({ start: { x: 4.5, y: 10.5 }, heading: 0.15 });
    await car.attach(view);
    expect(car.state.heading).toBe(0); // set along the road
    car.state.heading = 0.12; // a little off it
    for (let i = 0; i < 90; i++) car.step(1 / 30, car.inputFrom({ throttle: 1 }));
    expect(Math.abs(car.state.y - 10.5)).toBeLessThan(0.25);
    expect(car.drive.roadClassAt(car.state.x, car.state.y, car.state.h)).toBe("primary");
    expect(car.state.speed).toBeGreaterThan(TAKEOFF.speed);
    expect(car.canTakeOff).toBe(true);
    // not on the short road: too short to be a runway
    car.place(5.5, 20.5, 0);
    car.state.speed = 8;
    expect(car.canTakeOff).toBe(false);
  });

  it("is paced to its level", async () => {
    const coarse = new CarController({ start: { x: 10.5, y: 10.5 } });
    await coarse.attach(fakeView(world(), { metersPerCell: 400 }).view);
    const fine = new CarController({ start: { x: 10.5, y: 10.5 } });
    await fine.attach(fakeView(world(), { metersPerCell: 25 }).view);
    expect(coarse.params.pace).toBe(1);
    expect(fine.params.pace).toBe(0.55);
    expect(pace(100, 400, 0.55)).toBeCloseTo(Math.pow(0.25, 0.3), 9);
  });
});

describe("the plane controller", () => {
  it("flies over the ground with its dithered shadow straight below, and lands low and slow over a road", async () => {
    const w = world();
    const { view, entities } = fakeView(w, { level: "fly", metersPerCell: 1500 });
    const plane = new PlaneController({ start: { x: 4.5, y: 10.5 }, heading: 0, agl: 2 });
    await plane.attach(view);
    const [shadow, body] = entities.items;
    expect(body!.spec.model).toMatchObject({ group: "vehicle.plane" });
    expect(shadow!.spec.model).toMatchObject({ group: "vehicle.plane", part: 1 });
    expect(body!.silhouette).toBe(true);
    expect(shadow!.silhouette).toBe(false);
    expect(plane.state.h).toBe(3);
    for (let i = 0; i < 30; i++) plane.update(1 / 30);
    expect(shadow!.x).toBe(body!.x);
    expect(shadow!.y).toBe(body!.y);
    expect(shadow!.h).toBeCloseTo(1 + PLANE.shadowLift, 9);
    expect(plane.agl).toBeGreaterThan(1.5);
    expect(plane.canLand).toBe(false);
    // down low and slow along the road: it lands by itself
    let landed = 0;
    plane.onLand = () => landed++;
    plane.paused = true;
    Object.assign(plane.state, { h: 1.8, speed: 3, throttle: 0.05, climb: 0 });
    for (let i = 0; i < 40 && !landed; i++) plane.step(1 / 30, { pitch: 0, roll: 0, throttle: 0 });
    expect(plane.canLand).toBe(true);
    expect(landed).toBe(1);
  });

  it("puts the plane back a few seconds earlier, higher up, after a crash", async () => {
    const w = world();
    const { view } = fakeView(w, { level: "fly", metersPerCell: 1500 });
    const plane = new PlaneController({ start: { x: 30.5, y: 25.5 }, heading: 0, agl: 2 });
    await plane.attach(view);
    plane.paused = true;
    for (let i = 0; i < 300 && !plane.crashes; i++) plane.step(1 / 30, { pitch: -1, roll: 0, throttle: 0 });
    expect(plane.crashes).toBe(1);
    expect(plane.lastCrash?.reason).toBe("ground");
    expect(plane.agl).toBeGreaterThanOrEqual(PLANE.resetAgl - 1e-9);
    expect(plane.state.climb).toBe(0);
  });
});

describe("moving between levels", () => {
  const manifest = {
    id: "southwest",
    name: "US Southwest",
    level: "drive",
    levels: [
      { name: "fly", world: "southwest-fly", label: "Flying" },
      { name: "drive", world: "southwest", label: "Driving" },
    ],
  } as unknown as WorldManifest;

  it("finds a level's package beside this one", () => {
    expect(levelUrl("/southwest/", manifest, "fly")).toBe("/southwest-fly/");
    expect(levelUrl("/worlds/southwest", manifest, "fly")).toBe("/worlds/southwest-fly/");
    expect(levelUrl("/southwest/", manifest, "walk")).toBeNull();
    expect(levelLabel(manifest)).toBe("Driving");
  });

  it("carries a place and a heading across levels with different grids, through lon/lat", () => {
    // level A: 100 cells per degree; level B: 25 cells per degree, turned a quarter
    const a = { cellToLonLat: (x: number, y: number): [number, number] => [x / 100, -y / 100], lonLatToCell: (lon: number, lat: number): [number, number] => [lon * 100, -lat * 100] };
    const b = { cellToLonLat: (x: number, y: number): [number, number] => [y / 25, x / 25], lonLatToCell: (lon: number, lat: number): [number, number] => [lat * 25, lon * 25] };
    const pose = poseToGeo(a, 50, -20, 0)!; // heading east in A
    expect([pose.lon, pose.lat]).toEqual([0.5, 0.2]);
    const there = geoToPose(b, pose)!;
    expect(there.x).toBeCloseTo(5, 9);
    expect(there.y).toBeCloseTo(12.5, 9);
    expect(there.heading).toBeCloseTo(Math.PI / 2, 9); // east is +y in B
    expect(geoToPose({ ...b, lonLatToCell: () => null }, pose)).toBeNull();
  });

  it("starts each region where the game says", () => {
    expect(startFor(manifest)?.name).toBe("Las Vegas Boulevard");
    expect(startFor({ ...manifest, id: "southwest-fly" })?.name).toBe("Las Vegas Boulevard");
    expect(startFor({ ...manifest, id: "sf", levels: [] })?.name).toBe("the Embarcadero");
    expect(startFor({ ...manifest, id: "elsewhere", levels: [] })).toBeNull();
  });
});

describe("places and the camera", () => {
  it("names the nearest landmark close by, else the nearest town", () => {
    expect(landmarkName("hoover-dam")).toBe("Hoover Dam");
    expect(landmarkName("some-new-tower")).toBe("Some New Tower");
    expect(distanceKm(0, 0, 0, 1)).toBeCloseTo(111.2, 0);
    const places = [
      ...landmarkPlaces([{ id: "hoover-dam", group: "landmark.dam", x: 10, y: 10, parts: 1 }], (x, y) => [x / 1000, y / 1000]),
      { name: "Boulder City", lon: 0.0, lat: 0.0 },
    ];
    expect(nearestPlace(0.011, 0.01, places)).toEqual({ name: "Hoover Dam", km: expect.closeTo(0.111, 2) });
    expect(nearestPlace(-0.03, 0.0, places)?.name).toBe("Boulder City"); // the landmark is over 3 km away
    expect(nearestPlace(5, 5, places)).toBeNull();
  });

  it("looks ahead of a moving vehicle, eases toward it, and snaps after a jump", () => {
    const f = new Follow();
    f.update(10, 10, 0, 0, 0, 1 / 60);
    expect([f.x, f.y]).toEqual([10, 10]);
    for (let i = 0; i < 120; i++) f.update(10, 10, 0, 0, 8, 1 / 60);
    expect(f.x).toBeGreaterThan(12);
    expect(f.x).toBeLessThanOrEqual(14);
    f.update(100, 100, 5, 0, 0, 1 / 60);
    expect([f.x, f.y, f.h]).toEqual([100, 100, 5]);
    const b = new Bob();
    b.update(0, 1 / 60);
    b.update(0, 1 / 60);
    b.update(0.25, 1 / 60); // a step in the road
    let moved = 0;
    for (let i = 0; i < 6; i++) moved = Math.max(moved, Math.abs(b.update(0.25, 1 / 60)));
    expect(moved).toBeGreaterThan(0);
    for (let i = 0; i < 120; i++) b.update(0.25 + i * 0.01, 1 / 60); // a steady climb settles
    expect(Math.abs(b.offset)).toBeLessThan(0.01);
  });
});
