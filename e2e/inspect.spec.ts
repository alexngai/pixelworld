import { expect, test, type Page } from "@playwright/test";

/** The viewer's pixel inspector (`__pixelworld.inspect`, apps/web/src/inspect.ts). */

async function open(page: Page, query: string, width = 640, height = 360) {
  await page.setViewportSize({ width, height });
  await page.goto(`/?hud=0&cache=0&ground=0&traffic=0&fog=0&w=${width}&h=${height}&${query}`);
  await page.waitForFunction(() => window.__pixelworld !== undefined, null, { timeout: 60_000 });
  await page.evaluate(() => window.__pixelworld!.ready());
}

/** Inspect a grid of canvas points. */
const scan = (page: Page, every: number) =>
  page.evaluate((every) => {
    const c = document.getElementById("view") as HTMLCanvasElement;
    const out = [];
    for (let y = every / 2; y < c.height; y += every)
      for (let x = every / 2; x < c.width; x += every) out.push(window.__pixelworld!.inspect(x, y));
    return out;
  }, every);

test.describe("Pixel inspector", () => {
  test("a canyon pixel: its colour's ramp and shade, the strata band, the ground under it", { tag: "@smoke" }, async ({ page }) => {
    await open(page, "world=/grand-canyon-m0/&zoom=2&rot=2&rover=71,100");
    const all = await scan(page, 40);
    const palette = await page.evaluate(() => window.__pixelworld!.palette());
    for (const p of all) {
      // every pixel of the world is a palette colour, and the inspector names its entry
      expect(p.index, `${p.x},${p.y} ${p.color}`).not.toBeNull();
      const [r, g, b] = palette.slice(p.index! * 4, p.index! * 4 + 3);
      expect(p.color).toBe("#" + [r!, g!, b!].map((v) => v.toString(16).padStart(2, "0")).join(""));
      expect(p.ground, `${p.x},${p.y}`).not.toBeNull();
      expect(p.object).toBeNull(); // the M0 slice has no placed objects
    }
    // the canyon's walls are strata: the inspector says which band draws them
    const strata = all.filter((p) => p.usedBy.some((u) => u.startsWith("strata:grand-canyon/")));
    expect(strata.length).toBeGreaterThan(all.length / 4);
    // the ground point is where the view ray meets the drawn ground
    const mid = await page.evaluate(() => window.__pixelworld!.inspect(320, 180));
    expect(mid.cell).toEqual({ x: mid.ground!.x, y: mid.ground!.y, h: mid.ground!.h });
    expect(mid.lonLat).toBeNull(); // the M0 slice has no geo grid
  });

  test("a building's pixel: its asset group, the city pack's generator and the cell it stands on", { tag: "@smoke" }, async ({ page }) => {
    // Alamo Square's rows: San Francisco's own generators (the city pack, D-071)
    await open(page, "world=/sf-walk/&marker=0&zoom=3&rot=0&at=-122.4327,37.7760");
    const all = await scan(page, 24);
    const buildings = all.filter((p) => p.object?.group.startsWith("building."));
    expect(buildings.length).toBeGreaterThan(all.length / 5);
    const rows = buildings.filter((p) => p.object!.generator === "rowhouse");
    expect(rows.length).toBeGreaterThan(10);
    for (const p of rows) {
      const o = p.object!;
      expect(o.source).toBe("@pixelworlds/city-sf");
      expect(o.roles.length).toBeGreaterThan(0);
      expect(p.usedBy.some((u) => o.roles.some((role) => u.endsWith(`/${role}`)))).toBe(true);
      // the ray enters the building inside its footprint and between its base and top
      const [x0, y0, x1, y1] = o.bounds;
      expect(p.cell!.x).toBeGreaterThanOrEqual(x0 - 0.2);
      expect(p.cell!.x).toBeLessThanOrEqual(x1 + 0.2);
      expect(p.cell!.y).toBeGreaterThanOrEqual(y0 - 0.2);
      expect(p.cell!.y).toBeLessThanOrEqual(y1 + 0.2);
      expect(p.cell!.h).toBeGreaterThanOrEqual(o.base! - 0.2);
    }
    // the streets between them are ground: no object, a road or path surface
    expect(all.some((p) => p.object === null && p.ground !== null)).toBe(true);
  });
});
