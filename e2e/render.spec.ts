import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { decodePng } from "../packages/world-format/src/png";

/** Open a fixed-size view and wait until every visible tile is baked and drawn. */
async function open(page: Page, query: string, width = 640, height = 360) {
  await page.setViewportSize({ width, height });
  await page.goto(`/?hud=0&cache=0&w=${width}&h=${height}&${query}`);
  await page.waitForFunction(() => window.__pixelworld !== undefined, null, { timeout: 60_000 });
  await page.evaluate(() => window.__pixelworld!.ready());
}

/** Canvas pixels as RGBA, row 0 = top. */
async function pixels(page: Page): Promise<{ width: number; height: number; data: number[] }> {
  return page.evaluate(() => {
    const c = document.getElementById("view") as HTMLCanvasElement;
    const tmp = document.createElement("canvas");
    tmp.width = c.width;
    tmp.height = c.height;
    const ctx = tmp.getContext("2d")!;
    ctx.drawImage(c, 0, 0);
    return { width: c.width, height: c.height, data: Array.from(ctx.getImageData(0, 0, c.width, c.height).data) };
  });
}

const hex = (d: number[], i: number) =>
  "#" + [d[i]!, d[i + 1]!, d[i + 2]!].map((v) => v.toString(16).padStart(2, "0")).join("");

const M0 = "world=/grand-canyon-m0/";

test.describe("Grand Canyon M0 slice", () => {
  test("rotation 0, 1× overview matches golden", async ({ page }) => {
    await open(page, M0 + "&zoom=1&rot=0&fx=64&fy=70&rover=71,100");
    await expect(page.locator("#view")).toHaveScreenshot("overview-r0.png");
  });

  test("rotation 2, 2× South Rim strata matches golden", async ({ page }) => {
    await open(page, M0 + "&zoom=2&rot=2&rover=71,100");
    await expect(page.locator("#view")).toHaveScreenshot("south-rim-r2.png");
  });

  test("every rotation is hole-free inside the world", async ({ page }) => {
    for (const rot of [0, 1, 2, 3]) {
      await open(page, `${M0}&zoom=2&rot=${rot}&fx=64&fy=64&rover=71,100`);
      const { data } = await pixels(page);
      let background = 0;
      for (let i = 0; i < data.length; i += 4) if (hex(data, i) === "#1e1c2b") background++;
      expect(background, `background pixels at rotation ${rot}`).toBe(0);
    }
  });

  test("sub-pixel scrolling moves the image rigidly (no shimmer)", async ({ page }) => {
    await open(page, M0 + "&zoom=4&rot=0&fx=64.3&fy=60.1&rover=71,100");
    const a = await pixels(page);
    // a quarter internal pixel at 4× is exactly one device pixel
    await page.evaluate(() => window.__pixelworld!.pan(0.25, 0));
    await page.evaluate(() => window.__pixelworld!.ready());
    const b = await pixels(page);
    let mismatches = 0;
    for (let y = 0; y < a.height; y++)
      for (let x = 0; x < a.width - 1; x++) {
        const ia = (y * a.width + x + 1) * 4;
        const ib = (y * b.width + x) * 4;
        if (hex(a.data, ia) !== hex(b.data, ib)) mismatches++;
      }
    expect(mismatches).toBe(0);
  });

  test("a hidden rover shows a dithered silhouette; a visible one does not", async ({ page }) => {
    const silhouettePixels = async () => {
      const { data } = await pixels(page);
      let n = 0;
      for (let i = 0; i < data.length; i += 4) if (hex(data, i) === "#ffe36e") n++;
      return n;
    };
    await open(page, M0 + "&zoom=3&rot=0&rover=40.5,110.5"); // open South Rim woodland
    expect(await silhouettePixels()).toBe(0);
    await open(page, M0 + "&zoom=3&rot=0"); // default start: inner gorge, behind the south wall
    expect(await silhouettePixels()).toBeGreaterThan(20);
    await expect(page.locator("#view")).toHaveScreenshot("silhouette-r0.png");
  });
});

test.describe("US Southwest (M1)", () => {
  interface Stats {
    chunksLoaded: number;
    chunksTotal: number;
    tilesBaked: number;
    tilesFromCache: number;
    cacheWrites: number;
  }
  const stats = (page: Page) =>
    page.evaluate(() => window.__pixelworld!.stats()) as Promise<unknown> as Promise<Stats>;

  test("Las Vegas at 2× matches golden (roads, urban blocks)", async ({ page }) => {
    await open(page, "zoom=2&rot=0");
    await expect(page.locator("#view")).toHaveScreenshot("southwest-vegas-r0.png");
  });

  test("streams only the chunks it needs and stays hole-free far from the start", async ({ page }) => {
    // Grand Canyon Village, ~720 cells east of the Las Vegas start in the warped layout.
    await open(page, "zoom=2&rot=2&rover=913.8,401.6");
    const s = await stats(page);
    expect(s.chunksLoaded).toBeGreaterThan(0);
    expect(s.chunksLoaded).toBeLessThan(s.chunksTotal / 4);
    // the warp gives the South Rim 150 m cells (the Strip, at the start, 100 m)
    expect((s as unknown as { metersPerCell: number }).metersPerCell).toBeCloseTo(150, -1);
    const { data } = await pixels(page);
    let background = 0;
    for (let i = 0; i < data.length; i += 4) if (hex(data, i) === "#1e1c2b") background++;
    expect(background).toBe(0);
  });

  test("micro-terrain is hole-free in every rotation, and the rover rides on it", async ({ page }) => {
    for (const rot of [0, 1, 2, 3]) {
      // Grand Canyon Village: canyon walls, the rim, AZ-64
      await open(page, `zoom=2&rot=${rot}&rover=913.8,401.6`);
      const { data } = await pixels(page);
      let background = 0;
      for (let i = 0; i < data.length; i += 4) if (hex(data, i) === "#1e1c2b") background++;
      expect(background, `rotation ${rot}`).toBe(0);
    }
    // heights come from micro-terrain: quarter steps, not whole cell corners
    const heights = await page.evaluate(() => {
      const out: number[] = [];
      for (let i = 0; i < 8; i++) {
        window.__pixelworld!.setRover(913.2 + i * 0.25, 401.8);
        out.push((window.__pixelworld!.stats() as { rover: { h: number } }).rover.h);
      }
      return out;
    });
    expect(heights.some((h) => !Number.isInteger(h * 2))).toBe(true);
    expect(new Set(heights).size).toBeGreaterThan(2);
  });

  test("baked tiles persist in IndexedDB across a reload", async ({ page }) => {
    const url = "/?hud=0&w=640&h=360&zoom=2&rot=1";
    await page.setViewportSize({ width: 640, height: 360 });
    await page.goto(url);
    await page.waitForFunction(() => window.__pixelworld !== undefined, null, { timeout: 60_000 });
    await page.evaluate(() => window.__pixelworld!.ready());
    const first = await stats(page);
    expect(first.tilesBaked).toBeGreaterThan(0);
    await page.waitForFunction(
      () => {
        const s = window.__pixelworld!.stats() as { cacheWrites: number; tilesBaked: number };
        return s.cacheWrites >= s.tilesBaked;
      },
      null,
      { timeout: 60_000 },
    );
    const before = await pixels(page);
    await page.reload();
    await page.waitForFunction(() => window.__pixelworld !== undefined, null, { timeout: 60_000 });
    await page.evaluate(() => window.__pixelworld!.ready());
    const second = await stats(page);
    expect(second.tilesFromCache).toBeGreaterThanOrEqual(first.tilesBaked);
    expect(second.tilesBaked).toBe(0);
    const after = await pixels(page);
    expect(after.data).toEqual(before.data);
  });

  test("the sources screen lists every attribution from the manifest", async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 540 });
    await page.goto("/?cache=0&w=960&h=540&zoom=2");
    await page.waitForFunction(() => window.__pixelworld !== undefined, null, { timeout: 60_000 });
    await expect(page.locator("#sources")).toBeHidden();
    await page.keyboard.press("i");
    const modal = page.locator("#sources");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("USGS 3D Elevation Program");
    await expect(modal).toContainText("ESA WorldCover");
    await expect(modal).toContainText("OpenStreetMap contributors");
    await expect(modal).toContainText("ODbL");
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
  });
});

test.describe("Pixel detail experiment (M1.5)", () => {
  interface ExpStats {
    tilesBaked: number;
    tilesPerRotation: number;
    renderScale: number;
    objects: number;
    palette: string;
  }
  const stats = (page: Page) =>
    page.evaluate(() => window.__pixelworld!.stats()) as Promise<unknown> as Promise<ExpStats>;
  const STRIP = "world=/exp-strip-k4/&zoom=2&rot=0";

  test("a fine world bakes as one tile at its render scale, with objects", async ({ page }) => {
    await open(page, STRIP);
    const s = await stats(page);
    expect(s.renderScale).toBe(0.25);
    expect(s.tilesPerRotation).toBe(1);
    expect(s.tilesBaked).toBe(1);
    expect(s.objects).toBeGreaterThan(1000);
    await expect(page.locator("#view")).toHaveScreenshot("exp-strip-k4-r0.png");
    const withObjects = await pixels(page);
    await open(page, STRIP + "&objects=0");
    expect((await stats(page)).objects).toBe(0);
    const terrainOnly = await pixels(page);
    let changed = 0;
    for (let i = 0; i < withObjects.data.length; i += 4) if (hex(withObjects.data, i) !== hex(terrainOnly.data, i)) changed++;
    expect(changed).toBeGreaterThan(withObjects.data.length / 4 / 5); // objects cover a good part of the view
  });

  test("night swaps the palette without rebaking", async ({ page }) => {
    await open(page, STRIP);
    const day = await pixels(page);
    await page.keyboard.press("t");
    await page.waitForFunction(() => (window.__pixelworld!.stats() as { palette: string }).palette === "night");
    await page.evaluate(() => window.__pixelworld!.pan(0, 0)); // force a redraw
    await page.evaluate(() => window.__pixelworld!.ready());
    const s = await stats(page);
    expect(s.tilesBaked).toBe(1);
    const night = await pixels(page);
    let darker = 0;
    let glowing = 0;
    const lum = (d: number[], i: number) => 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
    for (let i = 0; i < day.data.length; i += 4) {
      if (lum(night.data, i) < lum(day.data, i) * 0.6) darker++;
      if (lum(night.data, i) > lum(day.data, i) + 40) glowing++; // lit windows and neon
    }
    expect(darker).toBeGreaterThan(day.data.length / 4 / 2);
    expect(glowing).toBeGreaterThan(50);
  });
});

test.describe("Scale levels (D-046)", () => {
  const lonLat = (page: Page) => page.evaluate(() => window.__pixelworld!.lonLat()) as Promise<[number, number]>;
  const level = (page: Page) =>
    page.evaluate(() => (window.__pixelworld!.stats() as { level: string | null }).level);
  /** Metres between two lon/lat points (short distances). */
  const metres = (a: [number, number], b: [number, number]) =>
    Math.hypot((a[0] - b[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 110_540);
  async function switchTo(page: Page, name: string) {
    await page.evaluate((n) => setTimeout(() => window.__pixelworld!.switchLevel(n), 0), name);
    await page.waitForURL(new RegExp(`world=%2Fsouthwest-${name}%2F|world=%2Fsouthwest%2F`));
    await page.waitForFunction(() => window.__pixelworld !== undefined, null, { timeout: 60_000 });
    await page.evaluate(() => window.__pixelworld!.ready());
  }

  test("the flying level draws the Strip as an oversized skyline", async ({ page }) => {
    await open(page, "world=/southwest-fly/&zoom=1&rot=0");
    expect(await level(page)).toBe("fly");
    await expect(page.locator("#view")).toHaveScreenshot("southwest-fly-strip-r0.png");
  });

  test("the walking level draws roads at their real width, with sidewalks and crosswalks", async ({ page }) => {
    // Las Vegas Boulevard at Flamingo Road, terrain and ways only (D-050)
    await open(page, "world=/southwest-walk/&zoom=2&rot=0&objects=0");
    expect(await level(page)).toBe("walk");
    await expect(page.locator("#view")).toHaveScreenshot("southwest-walk-ways-r0.png");
  });

  test("switching levels keeps the rover at the same place", async ({ page }) => {
    await open(page, "zoom=1&rot=0"); // driving, at the Strip
    expect(await level(page)).toBe("drive");
    const strip = await lonLat(page);
    await switchTo(page, "fly");
    expect(await level(page)).toBe("fly");
    expect(metres(await lonLat(page), strip)).toBeLessThan(400); // a fly cell here is ~400 m
    await switchTo(page, "walk");
    expect(await level(page)).toBe("walk");
    expect(metres(await lonLat(page), strip)).toBeLessThan(400);
    expect(await page.evaluate(() => (window.__pixelworld!.stats() as { rotation: number }).rotation)).toBe(0);
  });

  test("a place outside the walking level starts at its start instead", async ({ page }) => {
    await open(page, "zoom=1&rot=2&rover=913.8,401.6"); // Grand Canyon Village
    await switchTo(page, "walk");
    expect(await level(page)).toBe("walk");
    const start = await lonLat(page);
    expect(metres(start, [-115.1728, 36.1147])).toBeLessThan(50); // the Strip start
  });
});

test.describe("Hero landmarks (D-053)", () => {
  /** Hoover Dam from downstream: the bypass bridge in front, the intake towers and Lake Mead behind. */
  async function openDam(page: Page, extra = "") {
    await open(page, "zoom=2&rot=3&rover=383.5,452" + extra);
    await page.evaluate(() => window.__pixelworld!.pan(0, -120));
    await page.evaluate(() => window.__pixelworld!.ready());
  }

  test("painted-over heroes survive a full re-bake", async ({ page }) => {
    // every tile baked fresh (cache=0) with the paint-overs, then without them
    await openDam(page);
    const painted = await pixels(page);
    await expect(page.locator("#view")).toHaveScreenshot("southwest-hoover-hero-r3.png");
    await openDam(page, "&paint=0");
    const plain = await pixels(page);
    let changed = 0;
    for (let i = 0; i < painted.data.length; i += 4)
      if (painted.data.slice(i, i + 3).some((v, k) => v !== plain.data[i + k])) changed++;
    expect(changed).toBeGreaterThan(200);
    expect(changed).toBeLessThan(5000); // the dam only

    // the offline bake still matches a fresh one, so the paint stays registered
    const manifest = JSON.parse(readFileSync("fixtures/southwest/manifest.json", "utf8"));
    const ref = manifest.heroes.find((h: { id: string; rotation: number }) => h.id === "hoover-dam" && h.rotation === 3);
    const stored = await decodePng(new Uint8Array(readFileSync(`fixtures/southwest/${ref.bake}`)).buffer);
    const fresh = (await page.evaluate(() => window.__pixelworld!.bakeHero("hoover-dam")))[3]!;
    expect([fresh.left, fresh.top, fresh.width, fresh.height]).toEqual([ref.left, ref.top, ref.width, ref.height]);
    expect(fresh.depthBase).toBeCloseTo(ref.depthBase, 6);
    let same = 0;
    for (let i = 0; i < fresh.pixels.length; i++) if (fresh.pixels[i] === stored.data[i]) same++;
    expect(same / fresh.pixels.length).toBeGreaterThan(0.999);
  });
});
