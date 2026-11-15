import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { expect, test, type Page } from "@playwright/test";
import { decodePng } from "../packages/world-format/src/png";

/**
 * Open a fixed-size view and wait until every visible tile is baked and drawn.
 * Ambient traffic (D-060) and fog are off unless the query asks for them, so
 * scenes stay still and goldens made before them still hold.
 */
async function open(page: Page, query: string, width = 640, height = 360) {
  await page.setViewportSize({ width, height });
  const traffic = /(^|&)traffic=/.test(query) ? "" : "&traffic=0";
  const fog = /(^|&)fog=/.test(query) ? "" : "&fog=0";
  await page.goto(`/?hud=0&cache=0&ground=0&w=${width}&h=${height}&${query}${traffic}${fog}`);
  await page.waitForFunction(() => window.__pixelworld !== undefined, null, { timeout: 60_000 });
  await page.evaluate(() => window.__pixelworld!.ready());
  // every model generated: none drawn as a missing-model marker (D-072)
  if (!/(^|&)plugins=0/.test(query)) expect(await page.evaluate(() => window.__pixelworld!.stats().modelsFailed)).toBe(0);
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
  test("rotation 0, 1× overview matches golden", { tag: "@smoke" }, async ({ page }) => {
    await open(page, M0 + "&zoom=1&rot=0&fx=64&fy=70&rover=71,100");
    await expect(page.locator("#view")).toHaveScreenshot("overview-r0.png");
  });

  test("rotation 2, 2× South Rim strata matches golden", { tag: "@smoke" }, async ({ page }) => {
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

  test("Las Vegas at 2× matches golden (roads, urban blocks)", { tag: "@smoke" }, async ({ page }) => {
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
    const url = "/?hud=0&w=640&h=360&zoom=2&rot=1&traffic=0";
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

  test("the sources screen lists every attribution from the manifest", { tag: "@smoke" }, async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 540 });
    await page.goto("/?cache=0&ground=0&w=960&h=540&zoom=2&traffic=0");
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
    // three levels baked in software rendering: about 3 minutes on a CI runner, near the default limit
    test.setTimeout(480_000);
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
    test.setTimeout(480_000); // two levels baked in software rendering
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
    // the dam stands a wall's height above the river now, not a tower's (relief cap, reservoir)
    await page.evaluate(() => window.__pixelworld!.pan(0, -40));
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

test.describe("New York (D-078, D-080, D-081)", () => {
  test("brownstone rows in Brooklyn Heights: the walking level typed from NYC Open Data", async ({ page }) => {
    // the new-york style pack and its city pack, named by the world
    await open(page, "world=/nyc-walk/&marker=0&zoom=2&rot=0&at=-73.9952,40.6944");
    await expect(page.locator("#view")).toHaveScreenshot("nyc-walk-heights-r0.png");
  });

  test("the Flatiron Building on its own wedge in Midtown (D-083)", async ({ page }) => {
    // a landmark drawn on its building's footprint, with Madison Square's lawn beside it
    await open(page, "world=/nyc-walk/&marker=0&zoom=2&rot=0&at=-73.9897,40.7411");
    await expect(page.locator("#view")).toHaveScreenshot("nyc-walk-flatiron-r0.png");
  });

  test("brownstone rows in Harlem: the driving level (D-083)", async ({ page }) => {
    // Strivers' Row: rows typed from PLUTO's classes in Harlem's neighbourhoods
    await open(page, "world=/nyc/&marker=0&zoom=2&rot=0&at=-73.9445,40.8180");
    await expect(page.locator("#view")).toHaveScreenshot("nyc-harlem-r0.png");
  });
});

test.describe("Paris (D-084, D-085, D-086)", () => {
  test("Haussmann blocks in the Gros-Caillou: the walking level typed from APUR and IGN", async ({ page }) => {
    // the paris style pack and its city pack, named by the world
    await open(page, "world=/paris-walk/&marker=0&zoom=2&rot=0&at=2.3027,48.8570");
    await expect(page.locator("#view")).toHaveScreenshot("paris-walk-gros-caillou-r0.png");
  });
});

test.describe("Kyoto (D-089, D-090, D-091, D-100, D-101)", () => {
  test("machiya streets under the Yasaka Pagoda: the walking level typed from PLATEAU", async ({ page }) => {
    // the kyoto style pack and its city pack, named by the world: machiya and
    // wooden houses under grey tile round a pagoda landmark
    await open(page, "world=/kyoto-walk/&marker=0&zoom=2&rot=0&at=135.7790,34.9985");
    await expect(page.locator("#view")).toHaveScreenshot("kyoto-walk-yasaka-r0.png");
  });

  test("Tō-ji's pagoda among the town: the driving level (D-101)", async ({ page }) => {
    // 25 m cells: the machiya and houses as small tile-roofed blocks round a temple's grounds
    await open(page, "world=/kyoto/&marker=0&zoom=2&rot=0&at=135.7487,34.9799");
    await expect(page.locator("#view")).toHaveScreenshot("kyoto-toji-r0.png");
  });
});

test.describe("Tokyo (D-092, D-093)", () => {
  test("houses, apartment slabs and utility poles in Yoyogi: the walking level typed from PLATEAU", async ({ page }) => {
    // the tokyo style pack and its city pack, named by the world
    await open(page, "world=/tokyo-walk/&marker=0&zoom=2&rot=0&at=139.6912,35.6796");
    await expect(page.locator("#view")).toHaveScreenshot("tokyo-walk-yoyogi-r0.png");
  });

  test("the Yamanote's tracks by Harajuku as one corridor along its centre line (D-097)", async ({ page }) => {
    await open(page, "world=/tokyo-walk/&marker=0&zoom=2&rot=0&at=139.7027,35.6700");
    await expect(page.locator("#view")).toHaveScreenshot("tokyo-walk-harajuku-rails-r0.png");
  });
});

test.describe("Hong Kong (D-107, D-108, D-109, D-117, D-133)", () => {
  test("Yau Ma Tei's tong lau under neon signs: Kowloon on open data alone", async ({ page }) => {
    // the hongkong style pack and its city pack; terrain from GLO-30 with its
    // buildings filtered off, heights from OSM or each neighbourhood's (D-107)
    await open(page, "world=/hongkong-walk/&marker=0&zoom=2&rot=0&at=114.1700,22.3120");
    await expect(page.locator("#view")).toHaveScreenshot("hongkong-walk-yaumatei-r0.png");
  });

  test("Central's towers over the harbour: the whole of Hong Kong Island (D-115, D-117)", async ({ page }) => {
    // Two IFC and the Bank of China Tower (generic), the Mid-Levels behind;
    // the ground filtered only in town, the woods the client's scatter
    await open(page, "world=/hongkong-island/&marker=0&zoom=1&rot=0&at=114.1600,22.2820");
    await expect(page.locator("#view")).toHaveScreenshot("hongkong-island-central-r0.png");
  });

  test("Victoria Harbour between two skylines: the driving level (D-133)", async ({ page }) => {
    // the Convention Centre's curved roof on Wan Chai's waterfront, junks
    // under red sails out on the harbour
    await open(page, "world=/hongkong/&marker=0&zoom=1&rot=0&at=114.1750,22.2860");
    await expect(page.locator("#view")).toHaveScreenshot("hongkong-harbour-r0.png");
  });
});

test.describe("San Francisco (D-055, D-056)", () => {
  test("Victorian rows by Alamo Square: typologies on the walking level", { tag: "@smoke" }, async ({ page }) => {
    // the city's own style pack (bay-area), named by the world
    await open(page, "world=/sf-walk/&marker=0&zoom=3&rot=0&at=-122.4327,37.7760");
    await expect(page.locator("#view")).toHaveScreenshot("sf-walk-alamo-r0.png");
  });

  test("Telegraph Hill and Coit Tower over the rows of North Beach", async ({ page }) => {
    await open(page, "world=/sf/&marker=0&zoom=2&rot=0&at=-122.40583,37.80237");
    await expect(page.locator("#view")).toHaveScreenshot("sf-coit-r0.png");
  });

  test("the Bay Bridge spans its tiles whole, from pieces that join", async ({ page }) => {
    const t0 = Date.now();
    await open(page, "world=/sf/&marker=0&zoom=1&rot=0&at=-122.382,37.797");
    expect(Date.now() - t0).toBeLessThan(90_000); // was 215 s as one diagonal voxel box
    await expect(page.locator("#view")).toHaveScreenshot("sf-bay-bridge-r0.png");
  });
});

test.describe("Ambient traffic (D-060)", () => {
  type Drawn = { id: number; kind: string; part: number; x: number; y: number; h: number; sx: number; sy: number };
  const traffic = (page: Page) =>
    page.evaluate(() => window.__pixelworld!.traffic()!) as Promise<{ ticks: number; counts: Record<string, number>; vehicles: Drawn[] }>;

  /** Pixels that differ between two captures inside a box around the canvas centre. */
  function changedNearCentre(a: { width: number; height: number; data: number[] }, b: typeof a, half: number) {
    let n = 0;
    for (let y = a.height / 2 - half; y < a.height / 2 + half; y++)
      for (let x = a.width / 2 - half; x < a.width / 2 + half; x++) {
        const i = (y * a.width + x) * 4;
        if (hex(a.data, i) !== hex(b.data, i)) n++;
      }
    return n;
  }

  test("vehicles move along the streets between two steps", async ({ page }) => {
    await open(page, "world=/sf/&marker=0&zoom=2&rot=0&at=-122.4195,37.8000&traffic=1&trafficPause=1&trafficTime=5");
    const a = await traffic(page);
    expect(a.counts.car).toBeGreaterThan(10);
    expect(a.counts.cablecar).toBeGreaterThan(0);
    const before = await pixels(page);
    await page.evaluate(() => window.__pixelworld!.trafficStep(2));
    await page.evaluate(() => window.__pixelworld!.ready());
    const b = await traffic(page);
    expect(b.ticks).toBe(a.ticks + 60);
    const was = new Map(a.vehicles.map((v) => [`${v.id}/${v.part}`, v]));
    let moved = 0;
    let both = 0;
    for (const v of b.vehicles) {
      const p = was.get(`${v.id}/${v.part}`);
      if (!p) continue;
      both++;
      if (Math.hypot(v.x - p.x, v.y - p.y) > 0.2) moved++;
    }
    expect(both).toBeGreaterThan(10);
    expect(moved / both).toBeGreaterThan(0.5); // most move; some wait behind others
    const after = await pixels(page);
    let changed = 0;
    for (let i = 0; i < after.data.length; i += 4) if (hex(after.data, i) !== hex(before.data, i)) changed++;
    expect(changed).toBeGreaterThan(100);
  });

  test("a car on the Golden Gate is drawn on its deck", async ({ page }) => {
    await open(page, "world=/sf/&marker=0&zoom=3&rot=0&fx=147&fy=112&traffic=1&trafficPause=1&trafficTime=20");
    // the deck's height from the bridge landmark (objects file)
    const objects = JSON.parse(gunzipSync(readFileSync("fixtures/sf/objects.json.gz")).toString());
    const deck = objects.instances.find((o: { id?: string; top?: number }) => o.id === "golden-gate-bridge" && o.top).top;
    const { vehicles } = await traffic(page);
    const car = vehicles.find((v) => v.kind === "car" && v.y > 90 && v.y < 140 && Math.abs(v.x - 147) < 4);
    expect(car, "a car on the bridge's water span").toBeTruthy();
    expect(car!.h).toBeCloseTo(deck, 1);
    // centred on the car at deck height: it is drawn there, over the deck
    await page.evaluate(([x, y, h]) => window.__pixelworld!.lookAt(x!, y!, h), [car!.x, car!.y, car!.h]);
    await page.evaluate(() => window.__pixelworld!.ready());
    const withCars = await pixels(page);
    await page.evaluate(() => window.__pixelworld!.setTraffic({ enabled: false }));
    await page.evaluate(() => window.__pixelworld!.ready());
    const without = await pixels(page);
    expect(changedNearCentre(withCars, without, 12)).toBeGreaterThan(20);
  });

  test("sublayers switch on and off on their own, from the URL and the layer panel", async ({ page }) => {
    await open(page, "world=/sf/&marker=0&zoom=2&rot=0&at=-122.4195,37.8000&traffic=1&trafficPause=1&trafficTime=5&trafficLayers=rail");
    const kinds = async () => new Set((await traffic(page)).vehicles.map((v) => v.kind));
    expect([...(await kinds())].sort()).toEqual(["cablecar"]);
    // the panel shows with the HUD; ticking road vehicles adds the cars
    await page.goto(
      "/?cache=0&ground=0&w=640&h=360&world=/sf/&marker=0&zoom=2&rot=0&at=-122.4195,37.8000&traffic=1&trafficPause=1&trafficTime=5&trafficLayers=rail",
    );
    await page.waitForFunction(() => window.__pixelworld !== undefined, null, { timeout: 60_000 });
    await expect(page.locator("#layers")).toBeVisible();
    await page.getByLabel("road vehicles").check();
    await page.evaluate(() => window.__pixelworld!.ready());
    expect(await kinds()).toContain("car");
    // the simulation is the same whichever sublayers are drawn
    await page.evaluate(() => window.__pixelworld!.setTraffic({ layers: ["rail"] }));
    await page.evaluate(() => window.__pixelworld!.ready());
    expect([...(await kinds())].sort()).toEqual(["cablecar"]);
    // and the whole layer: off leaves the baked world as it was
    await page.keyboard.press("v");
    await expect(page.getByLabel("Traffic (V)")).not.toBeChecked();
    await page.evaluate(() => window.__pixelworld!.ready());
    expect((await traffic(page)).vehicles.length).toBe(0);
  });

  test("cable cars and cars on Russian Hill at a fixed time match golden", async ({ page }) => {
    await open(page, "world=/sf/&marker=0&zoom=3&rot=0&at=-122.4195,37.8000&traffic=1&trafficPause=1&trafficTime=5");
    await page.evaluate(() => window.__pixelworld!.lookAt(356.7, 203.0));
    await page.evaluate(() => window.__pixelworld!.ready());
    const t = await traffic(page);
    expect(t.counts.cablecar).toBeGreaterThan(0);
    await expect(page.locator("#view")).toHaveScreenshot("sf-traffic-hyde-r0.png");
  });
});

test.describe("Fog (an atmosphere layer)", () => {
  type FogState = { enabled: boolean; paused: boolean; time: number; drawn: boolean } | null;
  const fog = (page: Page) => page.evaluate(() => window.__pixelworld!.fog()) as Promise<FogState>;
  const changed = (a: { data: number[] }, b: { data: number[] }) => {
    let n = 0;
    for (let i = 0; i < a.data.length; i += 4) if (hex(a.data, i) !== hex(b.data, i)) n++;
    return n;
  };
  // the Golden Gate from the city side: water, Fort Point and the north tower rising out of the fog
  const GATE = "world=/sf/&marker=0&zoom=1&rot=0&at=-122.4770,37.8130";

  test("fog through the Golden Gate at a fixed time matches golden; off, the frame is as without it", async ({ page }) => {
    await open(page, GATE + "&fog=1&fogTime=30&fogPause=1");
    expect(await fog(page)).toEqual({ enabled: true, paused: true, time: 30, drawn: true });
    await expect(page.locator("#view")).toHaveScreenshot("sf-fog-golden-gate-r0.png");
    const foggy = await pixels(page);
    // the drift is a function of the time alone
    await page.evaluate(() => window.__pixelworld!.setFog({ time: 90 }));
    await page.evaluate(() => window.__pixelworld!.ready());
    expect(changed(await pixels(page), foggy)).toBeGreaterThan(1000);
    await page.evaluate(() => window.__pixelworld!.setFog({ time: 30 }));
    await page.evaluate(() => window.__pixelworld!.ready());
    expect(changed(await pixels(page), foggy)).toBe(0);
    // G switches it off: the frame is exactly the one drawn without fog
    await page.keyboard.press("g");
    await page.evaluate(() => window.__pixelworld!.ready());
    expect((await fog(page))!.enabled).toBe(false);
    const toggled = await pixels(page);
    await open(page, GATE); // fog=0
    const plain = await pixels(page);
    expect(changed(toggled, plain)).toBe(0);
    expect(changed(foggy, plain)).toBeGreaterThan(foggy.data.length / 4 / 3);
  });

  test("no fog on the walking level, nor where the style's areas don't reach", async ({ page }) => {
    await open(page, "world=/sf-walk/&marker=0&zoom=3&rot=0&at=-122.4327,37.7760&fog=1");
    expect(await fog(page)).toBeNull(); // the bay-area pack turns fog off when walking
    // North Beach is out of the fog: the layer is on, draws nothing, and the golden still holds
    await open(page, "world=/sf/&marker=0&zoom=2&rot=0&at=-122.40583,37.80237&fog=1");
    expect(await fog(page)).toMatchObject({ enabled: true, drawn: false });
    await expect(page.locator("#view")).toHaveScreenshot("sf-coit-r0.png");
    // nor in a world whose style has none
    await open(page, "zoom=2&rot=0&fog=1");
    expect(await fog(page)).toBeNull();
  });
});

test.describe("Failures (D-072)", () => {
  test("a wrong world URL names the URL and what came back", async ({ page }) => {
    // the dev server answers a path it doesn't have with its index.html
    await page.goto("/?w=320&h=180&world=/no-such-world/");
    await expect(page.locator("#hud")).toContainText(
      'not a world package: /no-such-world/manifest.json returned an HTML page (expected a world manifest); check worldUrl ("/no-such-world/")',
    );
  });

  test("models whose plugin isn't loaded are drawn as markers, reported once per generator", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    // San Francisco's buildings without the city pack: North Beach, below Coit Tower
    await open(page, "world=/sf/&marker=0&zoom=3&rot=0&at=-122.40583,37.80237&plugins=0", 320, 180);
    const s = (await page.evaluate(() => window.__pixelworld!.stats())) as { modelsFailed: number; tilesBaked: number; gpuTiles: number };
    expect(s.modelsFailed).toBeGreaterThan(100);
    // every tile baked (the markers in it), none left blank
    expect(s.tilesBaked).toBeGreaterThan(0);
    expect(s.gpuTiles).toBe(s.tilesBaked);
    const failed = errors.filter((e) => e.startsWith("model failed: "));
    const generators = failed.map((e) => /generator '(\w+)'/.exec(e)?.[1]);
    expect(new Set(generators).size).toBe(failed.length); // once per generator
    expect(generators).toEqual(expect.arrayContaining(["rowhouse", "sfTower"]));
    for (const e of failed) {
      expect(e).toMatch(/^model failed: building\.[\w.]+ at cell [\d.]+,[\d.]+, seed \d+, footprint [\d.]+×[\d.]+ cells/);
      expect(e).toContain("comes with the plugin @pixelworlds/city-sf, which isn't loaded here");
    }
    // the markers are drawn in the pack's marker ramp
    const marker = new Set(["#8a1f2c", "#c0302d", "#e6553a", "#ff8a4c"]);
    const { data } = await pixels(page);
    let red = 0;
    for (let i = 0; i < data.length; i += 4) if (marker.has(hex(data, i))) red++;
    expect(red).toBeGreaterThan(500);
    // with the tile cache on, a tile with markers isn't kept: a reload bakes it again and says why
    await page.goto("/?hud=0&w=320&h=180&traffic=0&fog=0&world=/sf/&marker=0&zoom=3&rot=0&at=-122.40583,37.80237&plugins=0");
    await page.waitForFunction(() => window.__pixelworld !== undefined, null, { timeout: 60_000 });
    await page.evaluate(() => window.__pixelworld!.ready());
    const cached = (await page.evaluate(() => window.__pixelworld!.stats())) as { tilesBaked: number; cacheWrites: number; cache: string };
    expect(cached.cache).toBe("indexeddb");
    expect(cached.tilesBaked).toBeGreaterThan(0);
    expect(cached.cacheWrites).toBe(0);
  });
});
