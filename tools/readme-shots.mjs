// The README's screenshots (docs/images/readme/), taken from the viewer.
//   pnpm dev                                   # the viewer, on :5173
//   node tools/readme-shots.mjs [name ...]     # all of them, or those named
// VIEWER=http://localhost:5283 points it at another port; OUT=<dir> writes elsewhere.
// The README shows each at half its width in the file: a pixel to a pixel on a
// high-DPI screen. The hero is taken at twice the size (scale 2), sharp on any screen.
// Each is saved with a palette of its own colours (a view has a few hundred at most;
// lossless), through Pillow under uv when uv is on the PATH.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

// w × h: the view in CSS pixels (default 800 × 450); zoom: the viewer's zoom at that size
export const SHOTS = [
  { name: "hero-golden-gate-fog", world: "sf-fly", at: "-122.4783,37.8150", zoom: 1, fog: true, scale: 2 },
  // San Francisco
  { name: "sf-chinatown", world: "sf-walk", at: "-122.4065,37.7955", zoom: 2, rot: 1 },
  { name: "sf-hills", world: "sf", at: "-122.4300,37.7800", zoom: 1 },
  { name: "sf-golden-gate", world: "sf-fly", at: "-122.4783,37.8150", zoom: 1, rot: 1 },
  { name: "sf-downtown-night", world: "sf-fly", at: "-122.4100,37.7900", zoom: 1, night: true },
  // New York
  { name: "nyc-village", world: "nyc-walk", at: "-74.0010,40.7340", zoom: 2 },
  { name: "nyc-midtown", world: "nyc-walk", at: "-73.9840,40.7500", zoom: 1 },
  { name: "nyc-bridges", world: "nyc", at: "-73.9950,40.7060", zoom: 1, rot: 3 },
  { name: "nyc-midtown-night", world: "nyc", at: "-73.9840,40.7550", zoom: 1, night: true },
  // Kyoto
  { name: "kyoto-yasaka", world: "kyoto-walk", at: "135.7790,34.9986", zoom: 2 },
  { name: "kyoto-station", world: "kyoto", at: "135.7593,34.9875", zoom: 1 },
  { name: "kyoto-gion", world: "kyoto-walk", at: "135.7750,35.0030", zoom: 2 },
  { name: "kyoto-gion-night", world: "kyoto-walk", at: "135.7750,35.0030", zoom: 2, night: true },
  // more places
  { name: "paris-etoile", world: "paris-walk", at: "2.2950,48.8725", zoom: 1 },
  { name: "paris-cite", world: "paris-walk", at: "2.3480,48.8535", zoom: 1 },
  { name: "tokyo-shinjuku", world: "tokyo-walk", at: "139.6930,35.6880", zoom: 1 },
  { name: "hk-mongkok", world: "hongkong-walk", at: "114.1705,22.3190", zoom: 2 },
  { name: "hk-temple-street-night", world: "hongkong-walk", at: "114.1700,22.3065", zoom: 2, night: true },
  { name: "sw-grand-canyon", world: "southwest-fly", at: "-112.1130,36.0560", zoom: 1 },
  { name: "sw-hoover-dam", world: "southwest", at: "-114.7377,36.0160", zoom: 1 },
  // one place in four rotations
  ...[0, 1, 2, 3].map((rot) => ({ name: `rot-${rot}`, world: "kyoto-walk", at: "135.7790,34.9986", zoom: 2, rot })),
  // one place at each scale level
  { name: "level-fly", world: "sf-fly", at: "-122.4100,37.7980", zoom: 1 },
  { name: "level-drive", world: "sf", at: "-122.4100,37.7980", zoom: 1 },
  { name: "level-walk", world: "sf-walk", at: "-122.4100,37.7980", zoom: 1 },
];

// a palette of the image's own colours, when it has 256 or fewer
const PALETTE = `
import sys
from PIL import Image
for f in sys.argv[1:]:
    im = Image.open(f).convert("RGB")
    cs = im.getcolors(256)
    if cs is None:
        continue
    index = {bytes(c): i for i, (_, c) in enumerate(cs)}
    rgb = im.tobytes()
    p = Image.frombytes("P", im.size, bytes(index[rgb[i : i + 3]] for i in range(0, len(rgb), 3)))
    p.putpalette([v for _, c in cs for v in c])
    p.save(f, optimize=True)
`;

const base = process.env.VIEWER ?? "http://localhost:5173";
const out = process.env.OUT ?? fileURLToPath(new URL("../docs/images/readme/", import.meta.url));
const only = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const files = [];
const browser = await chromium.launch();
for (const s of SHOTS.filter((s) => !only.length || only.includes(s.name))) {
  const scale = Number(process.env.SCALE ?? s.scale ?? 1);
  const W = (s.w ?? 800) * scale, H = (s.h ?? 450) * scale;
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const q = new URLSearchParams({
    world: `/${s.world}/`, at: s.at, zoom: String(s.zoom * scale), rot: String(s.rot ?? 0),
    w: String(W), h: String(H), hud: "0", marker: "0", cache: "0",
    traffic: s.traffic ? "1" : "0", fog: s.fog ? "1" : "0",
  });
  if (s.night) q.set("palette", "night");
  const t = Date.now();
  await page.goto(`${base}/?${q}`);
  await page.waitForFunction(() => window.__pixelworld !== undefined, null, { timeout: 600_000 });
  await page.evaluate(() => window.__pixelworld.ready());
  await page.waitForTimeout(s.traffic ? 6000 : 500);
  const file = `${out}/${s.name}.png`;
  await page.locator("#view").screenshot({ path: file });
  files.push(file);
  console.log(`${s.name} ${((Date.now() - t) / 1000).toFixed(0)} s`);
  await page.close();
}
await browser.close();

try {
  execFileSync("uv", ["run", "--no-project", "--quiet", "--with", "pillow", "python", "-c", PALETTE, ...files], { stdio: "inherit" });
} catch {
  console.warn("uv or Pillow unavailable: the PNGs keep their full colour (larger files)");
}
