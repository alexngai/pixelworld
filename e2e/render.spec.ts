import { expect, test, type Page } from "@playwright/test";

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
    // Grand Canyon Village, ~680 cells east of the Las Vegas start.
    await open(page, "zoom=2&rot=2&rover=876.7,404.4");
    const s = await stats(page);
    expect(s.chunksLoaded).toBeGreaterThan(0);
    expect(s.chunksLoaded).toBeLessThan(s.chunksTotal / 4);
    const { data } = await pixels(page);
    let background = 0;
    for (let i = 0; i < data.length; i += 4) if (hex(data, i) === "#1e1c2b") background++;
    expect(background).toBe(0);
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
