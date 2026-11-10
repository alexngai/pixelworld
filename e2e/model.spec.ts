import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/** The model preview page (apps/web/model.html, `pnpm models`). */

async function open(page: Page, query: string) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`/model.html?${query}`);
  await page.waitForFunction(() => window.__models !== undefined, null, { timeout: 60_000 });
  await page.evaluate(() => window.__models!.ready());
  return page.evaluate(() => window.__models!.state());
}

/** Every drawn canvas's pixels, in table order: the row's label, then RGBA. */
const canvases = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLCanvasElement>("#grid td canvas")].map((c) => ({
      width: c.width,
      cssWidth: c.getBoundingClientRect().width,
      data: Array.from(c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data),
    })),
  );

const hexOf = (d: number[], i: number) => "#" + [d[i]!, d[i + 1]!, d[i + 2]!].map((v) => v.toString(16).padStart(2, "0")).join("");
const lum = (d: number[]) => {
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
  return s / (d.length / 4);
};

test.describe("Model preview", () => {
  test("a style pack's building in four rotations, by day and night", { tag: "@smoke" }, async ({ page }) => {
    const s = await open(page, "style=desert-southwest&group=building.residential&seeds=1,2&fp=8x6&h=24&zoom=2");
    expect(s.error).toBeNull();
    expect(s.rows.map((r) => r.label)).toEqual(["seed 1 · 8×6 · h 24", "seed 2 · 8×6 · h 24"]);
    for (const r of s.rows) {
      expect(r.error).toBeNull();
      expect(r.cells.map((c) => `${c.palette}${c.rotation}`)).toEqual(["day0", "day1", "day2", "day3", "night0", "night1", "night2", "night3"]);
    }
    const drawn = await canvases(page);
    expect(drawn).toHaveLength(16);
    // at the zoom asked for
    for (const c of drawn) expect(c.cssWidth).toBe(c.width * 2);
    // drawn in the asset's own ramps: desert-southwest's building.residential has stucco walls and a tiled roof
    const style = JSON.parse(readFileSync("worlds/_styles/desert-southwest/style.json", "utf8"));
    const [day0, day1] = [drawn[0]!, drawn[1]!];
    const colours = new Set<string>();
    for (let i = 0; i < day0.data.length; i += 4) colours.add(hexOf(day0.data, i));
    for (const ramp of ["stucco", "roof-tile"])
      expect((style.ramps[ramp] as string[]).some((c) => colours.has(c.toLowerCase())), ramp).toBe(true);
    // another rotation is another view, and night is darker
    expect(day1.data).not.toEqual(day0.data);
    expect(lum(drawn[4]!.data)).toBeLessThan(lum(day0.data) * 0.8);
  });

  test("a city pack's generator; a generator tried on another pack's group; a generator's error", async ({ page }) => {
    // San Francisco's rows come from the city pack's plugin (D-071)
    const sf = await open(page, "style=bay-area&group=building.rowhouse.victorian&seeds=3&fp=6x16&h=30&hints=front:2&palette=day");
    expect(sf.plugins.map((p) => p.name)).toContain("@pixelworlds/city-sf");
    expect(sf.rows[0]!.error).toBeNull();
    expect(sf.rows[0]!.cells).toHaveLength(4);
    await expect(page.locator("#status")).toContainText("rowhouse (@pixelworlds/city-sf)");
    // the same generator with the Southwest's residential roles: the pack doesn't name the plugin, and the page says so
    await open(page, "style=desert-southwest&group=building.residential&generator=rowhouse&seeds=3&fp=6x16&h=30&palette=day");
    await expect(page.locator("#status")).toContainText("doesn't name the plugin @pixelworlds/city-sf");
    expect((await page.evaluate(() => window.__models!.state())).rows[0]!.cells).toHaveLength(4);
    // a generator that isn't there: the row shows the error
    const missing = await open(page, "style=desert-southwest&group=building.residential&generator=nope&palette=day");
    expect(missing.rows[0]!.error).toContain("nope");
    await expect(page.locator("#grid td.error")).toContainText("nope");
  });

  test("the controls redraw and keep the parameters in the URL; vehicles take a size", async ({ page }) => {
    await open(page, "style=desert-southwest&group=vehicle.bus&seeds=1&palette=day&zoom=3");
    const bus = (await page.evaluate(() => window.__models!.state())).rows[0]!;
    expect(bus.error).toBeNull();
    expect(bus.label).toMatch(/^seed 1 · \d+×\d+×\d+$/);
    await page.locator("select[name=zoom]").selectOption("5");
    await page.waitForURL(/zoom=5/);
    await page.evaluate(() => window.__models!.ready());
    expect((await page.evaluate(() => window.__models!.state())).spec.zoom).toBe(5);
    for (const c of await canvases(page)) expect(c.cssWidth).toBe(c.width * 5);
    await page.locator("input[name=size]").fill("20x6x8");
    await page.locator("input[name=size]").dispatchEvent("change");
    await page.waitForURL(/size=20x6x8/);
    await page.evaluate(() => window.__models!.ready());
    expect((await page.evaluate(() => window.__models!.state())).rows[0]!.label).toBe("seed 1 · 20×6×8");
  });
});
