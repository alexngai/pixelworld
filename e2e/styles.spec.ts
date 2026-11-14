import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

/**
 * Style packs in the viewer (D-075): each is read only for the worlds that
 * use it, so a pack that isn't JSON, or has problems, fails those worlds
 * alone, and the HUD names the pack, the place and the problem.
 */

/** Serve other text for a pack, as Vite's `?raw` module of its file would. */
async function replacePack(page: Page, id: string, text: string) {
  await page.route(new RegExp(`/worlds/_styles/${id}/style\\.json\\?`), (route) =>
    route.fulfill({ contentType: "text/javascript", body: `export default ${JSON.stringify(text)};` }),
  );
}

const pack = (id: string) => readFileSync(`worlds/_styles/${id}/style.json`, "utf8");

test.describe("Style packs (D-075)", () => {
  test("a pack that isn't JSON fails only the worlds that use it, naming its file and line", async ({ page }) => {
    await replacePack(page, "bay-area", pack("bay-area").replace('"id": "bay-area",', '"id": "bay-area",,'));
    await page.goto("/?cache=0&ground=0&traffic=0&fog=0&world=/sf-fly/");
    const hud = page.locator("#hud");
    await expect(hud).toContainText("error: StyleError: worlds/_styles/bay-area/style.json: invalid JSON at line 3, column 20: ", {
      timeout: 60_000,
    });
    await expect(hud).toHaveClass(/error/);

    // the Southwest's pack is fine, so its worlds still open
    await page.goto("/?hud=0&cache=0&ground=0&traffic=0&fog=0&w=320&h=180&world=/grand-canyon-m0/");
    await page.waitForFunction(() => window.__pixelworld !== undefined, null, { timeout: 60_000 });
    await page.evaluate(() => window.__pixelworld!.ready());
    expect(await page.evaluate(() => window.__pixelworld!.stats().tilesBaked)).toBeGreaterThan(0);
  });

  test("a pack's problems are listed with their paths, and a misspelt key gets a did-you-mean", async ({ page }) => {
    const desert = JSON.parse(pack("desert-southwest")) as { assets: Record<string, Record<string, unknown>> };
    const house = desert.assets["building.residential"]!;
    house.generater = house.generator;
    delete house.generator;
    await replacePack(page, "desert-southwest", JSON.stringify(desert, null, 2));
    await page.goto("/?cache=0&ground=0&traffic=0&fog=0&world=/grand-canyon-m0/");
    const hud = page.locator("#hud");
    await expect(hud).toContainText('style pack "desert-southwest" has 2 problems:', { timeout: 60_000 });
    await expect(hud).toContainText('assets["building.residential"]: missing "generator"');
    await expect(hud).toContainText('assets["building.residential"]: unknown key "generater" (did you mean "generator"?)');
  });
});
