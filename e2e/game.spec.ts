import { expect, test, type Page } from "@playwright/test";
// the debug API's types: apps/game/src/main.ts declares `window.__game`
import type { Sample } from "../apps/game/src/run";
import { GAME_PORT } from "../playwright.config";

/**
 * The example game (apps/game, M4): a car and a plane on the engine's public
 * API. The run is scripted through the debug API (`window.__game`), which
 * steps the controllers' physics with a fixed dt, so it doesn't depend on
 * frame timing; traffic and fog are off.
 */
test.use({ baseURL: `http://localhost:${GAME_PORT}` });

async function open(page: Page, query: string, width = 640, height = 360) {
  await page.setViewportSize({ width, height });
  await page.goto(`/?hud=0&cache=0&traffic=0&fog=0&paused=1&w=${width}&h=${height}&${query}`);
  await page.waitForFunction(() => window.__game !== undefined, null, { timeout: 120_000 });
  await page.evaluate(() => window.__game!.ready());
  await page.evaluate(() => window.__game!.pause(true));
}

const state = (page: Page) => page.evaluate(() => window.__game!.state());

/** Canvas pixels of a colour. */
async function countColour(page: Page, rgb: [number, number, number]): Promise<number> {
  return page.evaluate((rgb) => {
    const c = document.getElementById("view") as HTMLCanvasElement;
    const t = document.createElement("canvas");
    t.width = c.width;
    t.height = c.height;
    const ctx = t.getContext("2d")!;
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, t.width, t.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] === rgb[0] && d[i + 1] === rgb[1] && d[i + 2] === rgb[2]) n++;
    return n;
  }, rgb);
}

const SILHOUETTE: [number, number, number] = [0xff, 0xe3, 0x6e];
const BACKGROUND: [number, number, number] = [0x1e, 0x1c, 0x2b];

test.describe("the game (M4)", () => {
  test("starts on Las Vegas Boulevard, drives along it on the road surface's height, and stops at a building", async ({ page }) => {
    await open(page, "");
    const s0 = await state(page);
    expect(s0).toMatchObject({ mode: "car", world: "southwest", level: "Driving" });
    expect(s0.road).toBe("primary");
    expect(s0.heading).toBeCloseTo(Math.PI / 2, 3); // south, down the Strip
    // the car is behind a casino tower here: a dithered silhouette shows it
    expect(await countColour(page, SILHOUETTE)).toBeGreaterThan(20);

    // full throttle down the boulevard, the road assist keeping to it
    const samples = (await page.evaluate(() => window.__game!.drive({ throttle: 1 }, 4, 1 / 30))) as Sample[];
    const s1 = await state(page);
    // a few hundred metres: the Strip is 100 m per cell
    expect(s1.y - s0.y).toBeGreaterThan(4);
    for (const s of samples) {
      expect(s.road, `on the road at ${s.x.toFixed(2)}, ${s.y.toFixed(2)}`).not.toBeNull();
      expect(s.h).toBeCloseTo(s.ground!, 6);
    }
    expect(s1.speed).toBeGreaterThan(5);
    // the drawn ground, as the engine's query reads it
    expect(s1.h).toBeCloseTo((await page.evaluate(({ x, y }) => window.__game!.heightAt(x, y), s1))!, 6);

    // off the road, toward a building (a point inside its footprint): it stops at its wall
    const b = await page.evaluate(({ x, y }) => window.__game!.findBuilding(x, y, 6), s1);
    expect(b).not.toBeNull();
    // a clear place beside it (the car's length clear of anything), facing it
    const start = await page.evaluate(({ x, y }) => {
      const g = window.__game!;
      for (let d = 1.2; d < 4; d += 0.1)
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const)
          if ([0, 0.4, 0.8].every((k) => !g.objectsAt(x + dx * (d + k), y + dy * (d + k)).length))
            return { x: x + dx * (d + 0.4), y: y + dy * (d + 0.4), heading: Math.atan2(-dy, -dx) };
      return null;
    }, b!);
    expect(start).not.toBeNull();
    await page.evaluate(({ x, y, heading }) => window.__game!.place(x, y, heading), start!);
    // the wheel held straight (the road assist only steers a car whose wheel is centred)
    const hits = (await page.evaluate(() => window.__game!.drive({ throttle: 1, steer: 1e-4 }, 3, 1 / 30))) as Sample[];
    const s2 = await state(page);
    expect(hits.some((s) => s.blocked === "building")).toBe(true);
    expect(s2.bump).toMatchObject({ reason: "building" });
    const travelled = Math.hypot(s2.x - start!.x, s2.y - start!.y);
    const left = Math.hypot(b!.x - s2.x, b!.y - s2.y);
    expect(travelled).toBeGreaterThan(0.3); // it drove up to the wall…
    expect(left).toBeGreaterThan(0.3); // …and not into the building
    expect(travelled + left).toBeCloseTo(Math.hypot(b!.x - start!.x, b!.y - start!.y), 1); // straight at it
    expect(Math.abs(s2.speed)).toBeLessThan(1);
  });

  test("takes off from a straight road into the flying level without a flash, flies over its shadow, and lands back on a road", async ({ page }) => {
    await open(page, "");
    // a straight stretch of the boulevard south of the Strip, heading south
    await page.evaluate(() => window.__game!.place(193.5, 405.5, Math.PI / 2));
    await page.evaluate(() => window.__game!.drive({ throttle: 1 }, 3, 1 / 30));
    const ground = await state(page);
    expect(ground.canTakeOff).toBe(true);
    const from = ground.lonLat!;
    await page.evaluate(() => window.__game!.ready());

    // sample the canvas every frame while the flying level loads: never the empty background
    await page.evaluate(() => {
      const w = window as unknown as { __worst: number; __sampling: boolean };
      w.__worst = 0;
      w.__sampling = true;
      const c = document.getElementById("view") as HTMLCanvasElement;
      const t = document.createElement("canvas");
      t.width = 160;
      t.height = 90;
      const ctx = t.getContext("2d", { willReadFrequently: true })!;
      const sample = () => {
        if (!w.__sampling) return;
        ctx.drawImage(c, 0, 0, 160, 90);
        const d = ctx.getImageData(0, 0, 160, 90).data;
        let bg = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] === 0x1e && d[i + 1] === 0x1c && d[i + 2] === 0x2b) bg++;
        w.__worst = Math.max(w.__worst, bg / (160 * 90));
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    expect(await page.evaluate(() => window.__game!.takeOff())).toBe(true);
    const worst = await page.evaluate(() => {
      const w = window as unknown as { __worst: number; __sampling: boolean };
      w.__sampling = false;
      return w.__worst;
    });
    expect(worst).toBeLessThan(0.02);
    expect(await countColour(page, BACKGROUND)).toBeLessThan(640 * 360 * 0.02);

    // the same place on the flying level, in the air
    const air = await state(page);
    expect(air).toMatchObject({ mode: "plane", world: "southwest-fly", level: "Flying" });
    const km = Math.hypot((air.lonLat![0] - from[0]) * 90, (air.lonLat![1] - from[1]) * 111);
    expect(km).toBeLessThan(1.5);
    expect(air.agl as number).toBeGreaterThan(1);

    // fly on: the plane stays up, its shadow on the ground straight below it
    const flight = (await page.evaluate(() => window.__game!.fly({ pitch: 0.3 }, 4, 1 / 30))) as Sample[];
    expect(flight.every((s) => s.blocked === null)).toBe(true);
    const up = await state(page);
    const shadow = up.shadow as { x: number; y: number; h: number };
    expect(shadow.x).toBe(up.x);
    expect(shadow.y).toBe(up.y);
    expect(shadow.h).toBeGreaterThanOrEqual(up.ground!);
    expect(shadow.h).toBeLessThan(up.ground! + 1);
    expect(up.agl as number).toBeGreaterThan(1.5);
    expect(up.h).toBeGreaterThan(air.h);
    expect(up.altitudeMeters as number).toBeGreaterThan(up.aglMeters as number);
    await page.evaluate(() => window.__game!.ready());

    // down low and slow over the nearest road: it lands, back on the driving level
    expect(await page.evaluate(() => window.__game!.approachRoad(30))).not.toBeNull();
    await page.evaluate(() => window.__game!.fly(null, 60, 1 / 30));
    await page.waitForFunction(() => window.__game!.state().mode === "car", null, { timeout: 120_000 });
    await page.evaluate(() => window.__game!.ready());
    const landed = await state(page);
    expect(landed).toMatchObject({ mode: "car", world: "southwest", level: "Driving" });
    expect(landed.road).not.toBeNull();
    expect(landed.h).toBeCloseTo(landed.ground!, 6);
  });

  test("starts San Francisco on the Embarcadero, and anywhere with start=lon,lat", async ({ page }) => {
    await open(page, "world=/sf/");
    const sf = await state(page);
    expect(sf).toMatchObject({ mode: "car", world: "sf" });
    expect(sf.road).not.toBeNull();
    expect(sf.place).toMatch(/Ferry Building|Embarcadero/);
    // heading north-west along the waterfront, toward Fisherman's Wharf
    expect(Math.cos(sf.heading)).toBeLessThan(0);
    expect(Math.sin(sf.heading)).toBeLessThan(0);
    await open(page, "start=-114.7294,36.0099");
    const dam = await state(page);
    expect(dam.place).toMatch(/Hoover Dam/);
    expect(dam.road).toBe("motorway");
  });
});
