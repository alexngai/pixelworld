import { expect, test, type Page, type Route } from "@playwright/test";
import { EDITOR_PORT } from "../playwright.config";

/**
 * Editor v0 (M2) against a mocked pipeline server: the UI sends the right
 * warp specs and shows what the server answers. The real server is covered by
 * pipeline/tests/test_server.py.
 */

const EDITOR = `http://localhost:${EDITOR_PORT}/`;
// 2×2 opaque PNG (grey)
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGNoaGhgYGBgYGAAAA0QAQGZtmqpAAAAAElFTkSuQmCC",
  "base64",
);
const REGION = {
  id: "mock",
  name: "Mock Region",
  baseMetersPerCell: 400,
  sourceMeters: [80_000, 56_000],
  source: { url: "/api/source.png", width: 200, height: 140, metersPerPixel: 400 },
  warp: {
    background: 500,
    focus: [{ name: "city", lon: -115, lat: 36, sx: 40_000, sy: 28_000, radiusKm: 5, falloffKm: 10, metersPerCell: 100 }],
    pins: [],
  },
  places: [{ label: "City", sitelinks: 100, x: 40_000, y: 28_000 }],
};

interface Warp {
  focus: { name: string; sx: number; sy: number }[];
  pins: { name: string; sx: number; sy: number; x: number; y: number }[];
  background: number;
}

/** Mock /api: answers like the server, recording solve and save bodies. */
async function mockApi(page: Page, region: object = REGION) {
  const solves: Warp[] = [];
  const saves: Warp[] = [];
  // an identity-like lattice: source metres / 500 m per cell
  const xs = Array.from({ length: 9 }, (_, i) => i * 10_000);
  const ys = Array.from({ length: 7 }, (_, j) => j * 10_000);
  const lattice = {
    xs,
    ys,
    cx: ys.map(() => xs.map((x) => x / 500)),
    cy: ys.map((y) => xs.map(() => y / 500)),
  };
  await page.route("**/api/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/region") return json(region);
    if (url.pathname === "/api/source.png" || url.pathname.startsWith("/api/preview/"))
      return route.fulfill({ contentType: "image/png", body: PNG });
    if (url.pathname === "/api/solve") {
      const warp = (route.request().postDataJSON() as { warp: Warp }).warp;
      solves.push(warp);
      return json({
        warp,
        cells: [160, 112],
        preview: `/api/preview/${solves.length}`,
        lattice,
        stats: {
          folds: 0,
          maxAnisotropy: 1.8,
          focus: warp.focus.map((f) => ({ name: f.name, target: 100, achieved: 101.2, error: 0.012 })),
          pins: warp.pins.map((p) => ({ name: p.name, cells: 0.1 })),
        },
        timing: { solve: 1.2, total: 1.6 },
      });
    }
    if (url.pathname === "/api/save") {
      saves.push((route.request().postDataJSON() as { warp: Warp }).warp);
      return json({ saved: "worlds/mock/warp.yaml" });
    }
    return json({ state: "idle", log: "" });
  });
  return { solves, saves };
}

/** Page point for source-frame metres on the source canvas (image fitted, centred). */
async function sourcePoint(page: Page, sx: number, sy: number) {
  const box = (await page.locator("#source").boundingBox())!;
  const s = Math.min(box.width / 200, box.height / 140);
  const ox = box.x + (box.width - 200 * s) / 2;
  const oy = box.y + (box.height - 140 * s) / 2;
  return { x: ox + (sx / 400) * s, y: oy + (sy / 400) * s };
}

async function worldPoint(page: Page, cx: number, cy: number) {
  const box = (await page.locator("#world").boundingBox())!;
  const s = Math.min(box.width / 160, box.height / 112);
  return { x: box.x + (box.width - 160 * s) / 2 + cx * s, y: box.y + (box.height - 112 * s) / 2 + cy * s };
}

const solveCount = (page: Page) => page.evaluate(() => window.__editor!.solves());

test.describe("Editor v0 (M2)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 700 });
  });

  test("loads the region, solves it and shows the result", { tag: "@smoke" }, async ({ page }) => {
    const api = await mockApi(page);
    await page.goto(EDITOR);
    await expect(page.locator("#title")).toHaveText("Pixelworld editor · Mock Region");
    await expect.poll(() => solveCount(page)).toBe(1);
    expect(api.solves[0]!.focus).toHaveLength(1);
    await expect(page.locator("#status")).toContainText("160×112 cells · 0 folds");
    await expect(page.locator("#stats")).toContainText("city");
    await expect(page.locator("#stats")).toContainText("1.2%");
  });

  test("adding a focus area re-solves with it", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto(EDITOR);
    await expect.poll(() => solveCount(page)).toBe(1);
    await page.click("[data-tool=focus]");
    const p = await sourcePoint(page, 70_000, 12_000);
    await page.mouse.click(p.x, p.y);
    await expect.poll(() => solveCount(page)).toBe(2);
    const last = api.solves.at(-1)!;
    expect(last.focus).toHaveLength(2);
    expect(last.focus[1]!.sx).toBeCloseTo(70_000, -3);
    expect(last.focus[1]!.sy).toBeCloseTo(12_000, -3);
    await expect(page.locator("#selection")).toContainText("Focus area");
  });

  test("dragging a focus area moves it", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto(EDITOR);
    await expect.poll(() => solveCount(page)).toBe(1);
    const from = await sourcePoint(page, 40_000, 28_000);
    const to = await sourcePoint(page, 50_000, 30_000);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => solveCount(page)).toBe(2);
    expect(api.solves.at(-1)!.focus[0]!.sx).toBeCloseTo(50_000, -3);
  });

  test("a pin starts where the map puts its place and follows a drag on the world map", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto(EDITOR);
    await expect.poll(() => solveCount(page)).toBe(1);
    await page.click("[data-tool=pin]");
    const p = await sourcePoint(page, 20_000, 40_000);
    await page.mouse.click(p.x, p.y);
    await expect.poll(() => solveCount(page)).toBe(2);
    const pin = api.solves.at(-1)!.pins[0]!;
    // the mock lattice maps 500 m to a cell
    expect(pin.x).toBeCloseTo(40, 0);
    expect(pin.y).toBeCloseTo(80, 0);
    const from = await worldPoint(page, pin.x, pin.y);
    const to = await worldPoint(page, pin.x + 12, pin.y - 6);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => solveCount(page)).toBe(3);
    const moved = api.solves.at(-1)!.pins[0]!;
    expect(moved.x).toBeCloseTo(pin.x + 12, 0);
    expect(moved.y).toBeCloseTo(pin.y - 6, 0);
  });

  test("save sends the current warp", async ({ page }) => {
    const api = await mockApi(page);
    await page.goto(EDITOR);
    await expect.poll(() => solveCount(page)).toBe(1);
    await page.fill("#background", "650");
    await page.locator("#background").dispatchEvent("change");
    await expect.poll(() => solveCount(page)).toBe(2);
    await page.click("#save");
    await expect.poll(() => api.saves.length).toBe(1);
    expect(api.saves[0]!.background).toBe(650);
    await expect(page.locator("#status")).toContainText("saved worlds/mock/warp.yaml");
  });

  test("a town-sized region gets town-sized focus areas and background range", async ({ page }) => {
    // Jerome: about 2.9 km across at 20 m per cell, built outside fixtures/
    const town = {
      ...REGION,
      id: "jerome",
      name: "Jerome",
      baseMetersPerCell: 20,
      sourceMeters: [2_900, 2_700],
      source: { url: "/api/source.png", width: 725, height: 675, metersPerPixel: 4 },
      warp: { background: 20, focus: [], pins: [], meshKm: 0.04 },
      places: [],
      out: "/tmp/worlds/jerome",
      viewer: null,
    };
    const api = await mockApi(page, town);
    await page.goto(EDITOR);
    await expect.poll(() => solveCount(page)).toBe(1);
    const bg = page.locator("#background");
    expect([await bg.getAttribute("min"), await bg.getAttribute("max")]).toEqual(["5", "100"]);
    await page.fill("#background", "1");
    await bg.dispatchEvent("change");
    await expect.poll(() => solveCount(page)).toBe(2);
    expect(api.solves.at(-1)!.background).toBe(5); // clamped to the floor, not to 50 m
    await page.click("[data-tool=focus]");
    const box = (await page.locator("#source").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => solveCount(page)).toBe(3);
    const focus = api.solves.at(-1)!.focus[0] as unknown as { radiusKm: number; falloffKm: number; metersPerCell: number };
    expect(focus).toMatchObject({ radiusKm: 0.18, falloffKm: 0.36, metersPerCell: 10 });
    // its build lands outside fixtures/: the viewer link says how to serve it
    await expect(page.locator("#viewer")).toHaveText("View: pixelworld view <out>");
  });
});
