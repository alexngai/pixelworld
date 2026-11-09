#!/usr/bin/env node
/**
 * Offline hero bakes (M3, D-053). Bakes each hero landmark of a built world
 * alone, in all four rotations, with the same renderer the client uses
 * (Chromium + SwiftShader), and writes the bakes next to the landmark's
 * registry file:
 *
 *   worlds/_landmarks/<id>/hero/<world>/r<n>.png       RGBA: index, depth hi, depth lo, coverage
 *   worlds/_landmarks/<id>/hero/<world>/r<n>.json      where the bake sits on screen
 *   worlds/_landmarks/<id>/hero/<world>/r<n>-view.png  the bake in palette colours, for artists
 *   worlds/_landmarks/<id>/paint/<world>/r<n>.png      the paint-over (indexed, 0 = keep the bake)
 *
 * A paint-over is never overwritten. When a re-bake moves or reshapes a
 * landmark, its paint is re-registered: shifted by the offset that best lines
 * the old silhouette up with the new one. Then `uv run pixelworld heroes
 * <spec>` copies bakes and paints into the package. The bakes come from the
 * viewer (apps/web), which loads the generator plugins the world's style pack
 * names (San Francisco's city pack, D-071).
 *
 *   node tools/hero-bake.mjs --world southwest              bake every hero in fixtures/southwest
 *   node tools/hero-bake.mjs --world southwest --check      exit 1 if a fresh bake differs from the stored one
 *   node tools/hero-bake.mjs --world southwest --demo-paint replace paints with the demo touch-ups
 *   options: --landmark <id> (repeatable), --url <running dev server>
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync, gunzipSync, inflateSync } from "node:zlib";
import { chromium } from "@playwright/test";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = join(REPO, "worlds", "_landmarks");
const SHADES = 6;
const SPECIAL = 253; // indices from here up are not ramp shades
const SWIFTSHADER = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

// ---------------------------------------------------------------- PNG I/O

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/** An 8-bit PNG: RGBA (channels 4) or indexed (channels 1, with `palette` as 256 RGBA entries). */
export function encodePng(width, height, channels, data, palette) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr)];
  if (channels === 1) {
    const plte = Buffer.alloc(256 * 3);
    for (let i = 0; i < 256; i++) plte.set(palette.slice(i * 4, i * 4 + 3), i * 3);
    parts.push(chunk("PLTE", plte), chunk("tRNS", Buffer.from([0]))); // index 0 is transparent
  }
  parts.push(chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** Decode an 8-bit, non-interlaced indexed or RGBA PNG (what this tool and paint programs write). */
export function decodePng(buf) {
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || (body[9] !== 3 && body[9] !== 6) || body[12] !== 0)
        throw new Error("paint files must be 8-bit indexed (or RGBA bakes), not interlaced");
      channels = body[9] === 3 ? 1 : 4;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

// ---------------------------------------------------------------- paint helpers

const covered = (bake, i) => bake.pixels[i * 4 + 3] > 0;

/**
 * The best integer offset (within ±r px) from the old silhouette to the new
 * one, in absolute screen pixels, and how well they overlap there (IoU).
 */
export function register(oldBake, newBake, r = 4) {
  let best = { dx: 0, dy: 0, iou: -1 };
  let oldCount = 0;
  let newCount = 0;
  for (let i = 0; i < oldBake.width * oldBake.height; i++) oldCount += covered(oldBake, i) ? 1 : 0;
  for (let i = 0; i < newBake.width * newBake.height; i++) newCount += covered(newBake, i) ? 1 : 0;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      let both = 0;
      for (let y = 0; y < oldBake.height; y++)
        for (let x = 0; x < oldBake.width; x++) {
          if (!covered(oldBake, y * oldBake.width + x)) continue;
          const nx = oldBake.left + x + dx - newBake.left;
          const ny = oldBake.top + y + dy - newBake.top;
          if (nx >= 0 && ny >= 0 && nx < newBake.width && ny < newBake.height && covered(newBake, ny * newBake.width + nx)) both++;
        }
      const iou = both / Math.max(1, oldCount + newCount - both);
      if (iou > best.iou || (iou === best.iou && Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy)))
        best = { dx, dy, iou };
    }
  return best;
}

/** Move a paint-over from the old bake's frame to the new one's, shifted by (dx, dy). */
export function reregister(paint, oldBake, newBake, dx, dy) {
  const out = new Uint8Array(newBake.width * newBake.height);
  let dropped = 0;
  for (let y = 0; y < oldBake.height; y++)
    for (let x = 0; x < oldBake.width; x++) {
      const p = paint[y * oldBake.width + x];
      if (!p) continue;
      const nx = oldBake.left + x + dx - newBake.left;
      const ny = oldBake.top + y + dy - newBake.top;
      if (nx >= 0 && ny >= 0 && nx < newBake.width && ny < newBake.height) out[ny * newBake.width + nx] = p;
      else dropped++;
    }
  return { paint: out, dropped };
}

const isShade = (idx) => idx > 0 && idx < SPECIAL;
const shadeOf = (idx) => (idx - 1) % SHADES;
const withShade = (idx, s) => idx - shadeOf(idx) + Math.max(0, Math.min(SHADES - 1, s));

/** Demo touch-ups per landmark (see demoPaint); others get "selout" alone. */
export const DEMO_RECIPES = {
  "strat-tower": ["selout", "beacon", "windows"],
  "hoover-dam": ["selout", "lifts"],
  "desert-view-watchtower": ["selout", "masonry"],
};

/**
 * The demo paint-over, a stand-in for an artist's (D-053), built from recipes:
 *   selout   top and left silhouette edges take a lit shade instead of the outline
 *   beacon   a warning light just above the top pixel (painted beyond the silhouette)
 *   windows  a band of lit windows across the widest rows (an observation pod)
 *   lifts    concrete lift joints: every 6th screen row a shade darker
 *   masonry  stone coursing: mortar rows and staggered joints a shade darker
 * Texture recipes touch interior pixels of the bake's main ramp only, and use
 * absolute screen rows and columns so a re-bake that moves the landmark keeps them.
 * `ramps` gives the palette index of shade 0 of the "marker" and "lit" ramps.
 */
export function demoPaint(bake, recipe, ramps) {
  const { width: w, height: h, left, top } = bake;
  const out = new Uint8Array(w * h);
  const cov = (x, y) => x >= 0 && y >= 0 && x < w && y < h && covered(bake, y * w + x);
  const idxAt = (x, y) => bake.pixels[(y * w + x) * 4];
  const interior = (x, y) => cov(x, y) && cov(x - 1, y) && cov(x + 1, y) && cov(x, y - 1) && cov(x, y + 1);
  const rampOf = (idx) => Math.floor((idx - 1) / SHADES);
  const counts = new Map();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (interior(x, y) && isShade(idxAt(x, y))) counts.set(rampOf(idxAt(x, y)), (counts.get(rampOf(idxAt(x, y))) ?? 0) + 1);
  const main = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const set = (x, y, p) => {
    if (p && p !== idxAt(x, y)) out[y * w + x] = p;
  };
  const darker = (x, y) => {
    const idx = idxAt(x, y);
    if (interior(x, y) && isShade(idx) && rampOf(idx) === main && shadeOf(idx) > 1) set(x, y, withShade(idx, shadeOf(idx) - 1));
  };
  for (const step of recipe) {
    if (step === "selout") {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const idx = idxAt(x, y);
          if (!cov(x, y) || !isShade(idx) || cov(x, y - 1) && cov(x - 1, y)) continue;
          const inner = cov(x + 1, y + 1) ? idxAt(x + 1, y + 1) : idx;
          if (isShade(inner)) set(x, y, withShade(inner, shadeOf(inner) - 1));
        }
    } else if (step === "beacon") {
      for (let y = 0; y < h; y++) {
        const x = [...Array(w).keys()].find((i) => cov(i, y));
        if (x === undefined) continue;
        if (y > 0) out[(y - 1) * w + x] = ramps.marker + 4;
        break;
      }
    } else if (step === "windows") {
      const widths = [...Array(h).keys()].map((y) => [...Array(w).keys()].filter((x) => cov(x, y)).length);
      const max = Math.max(...widths);
      const rows = widths.map((v, y) => (v >= 0.8 * max ? y : -1)).filter((y) => y >= 0);
      const y = rows[Math.floor(rows.length / 2)];
      if (y !== undefined) for (let x = 0; x < w; x++) if (interior(x, y) && (left + x) % 2 === 0) set(x, y, ramps.lit + 5);
    } else if (step === "lifts") {
      for (let y = 0; y < h; y++) if ((top + y) % 6 === 0) for (let x = 0; x < w; x++) darker(x, y);
    } else if (step === "masonry") {
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const ay = top + y;
          const ax = left + x;
          if (ay % 3 === 0 || (ax + 2 * (Math.floor(ay / 3) % 2)) % 4 === 0) darker(x, y);
        }
    } else throw new Error(`unknown demo paint step ${step}`);
  }
  return out;
}

// ---------------------------------------------------------------- main

function args(argv) {
  const out = { world: "southwest", landmarks: [], url: null, check: false, demoPaint: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--world") out.world = argv[++i];
    else if (a === "--landmark") out.landmarks.push(argv[++i]);
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--check") out.check = true;
    else if (a === "--demo-paint") out.demoPaint = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function heroIds() {
  return readdirSync(REGISTRY)
    .filter((f) => f.endsWith(".yaml") && /^hero:\s*true\b/m.test(readFileSync(join(REGISTRY, f), "utf8")))
    .map((f) => f.slice(0, -5));
}

async function devServer(url) {
  if (url) return { url, stop: () => {} };
  const port = 5197;
  const child = spawn("pnpm", ["--filter", "@pixelworld/web", "exec", "vite", "--port", String(port), "--strictPort"], {
    cwd: REPO,
    stdio: "ignore",
    detached: true,
  });
  const base = `http://localhost:${port}`;
  for (let t = 0; t < 120; t++) {
    try {
      if ((await fetch(base)).ok) return { url: base, stop: () => process.kill(-child.pid) };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  process.kill(-child.pid);
  throw new Error("dev server did not start");
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

function loadStored(dir, r) {
  const png = join(dir, `r${r}.png`);
  const meta = join(dir, `r${r}.json`);
  if (!existsSync(png) || !existsSync(meta)) return null;
  const img = decodePng(readFileSync(png));
  return { ...readJson(meta), pixels: img.data };
}

async function main() {
  const opt = args(process.argv.slice(2));
  const pkg = join(REPO, "fixtures", opt.world);
  const manifest = readJson(join(pkg, "manifest.json"));
  if (!manifest.objects) throw new Error(`${opt.world} has no objects`);
  const objects = JSON.parse(gunzipSync(readFileSync(join(pkg, manifest.objects.path))).toString());
  const present = new Set(objects.instances.map((o) => o.id).filter(Boolean));
  const wanted = (opt.landmarks.length ? opt.landmarks : heroIds()).filter((id) => present.has(id));
  if (!wanted.length) {
    console.log(`no hero landmarks in ${opt.world}`);
    return 0;
  }

  const server = await devServer(opt.url);
  const browser = await chromium.launch({ args: SWIFTSHADER });
  let failed = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await page.goto(`${server.url}/?world=/${opt.world}/&hud=0&cache=0&paint=0&scatter=0`);
    await page.waitForFunction(() => !!window.__pixelworld, null, { timeout: 120_000 });
    await page.evaluate(() => window.__pixelworld.ready());
    const palette = await page.evaluate(() => window.__pixelworld.palette());
    const style = readJson(join(REPO, "worlds", "_styles", manifest.style, "style.json"));
    const rampBase = (name) => 1 + Object.keys(style.ramps).indexOf(name) * SHADES;
    const ramps = { marker: rampBase("marker"), lit: rampBase("lit") };

    for (const id of wanted) {
      const bakes = await page.evaluate((lid) => window.__pixelworld.bakeHero(lid), id);
      const heroDir = join(REGISTRY, id, "hero", opt.world);
      const paintDir = join(REGISTRY, id, "paint", opt.world);
      for (const bake of bakes) {
        if (!bake) continue;
        const r = bake.rotation;
        const fresh = { ...bake, pixels: Uint8Array.from(bake.pixels) };
        const meta = { left: fresh.left, top: fresh.top, width: fresh.width, height: fresh.height, depthBase: fresh.depthBase };
        const stored = loadStored(heroDir, r);
        if (opt.check) {
          const same =
            stored &&
            ["left", "top", "width", "height"].every((k) => stored[k] === meta[k]) &&
            Math.abs(stored.depthBase - meta.depthBase) < 1e-6 &&
            Buffer.compare(Buffer.from(stored.pixels), Buffer.from(fresh.pixels)) === 0;
          if (!same) {
            failed++;
            const reg = stored ? register(stored, fresh) : null;
            console.log(`${id} r${r}: fresh bake differs${reg ? ` (best offset ${reg.dx},${reg.dy}, IoU ${reg.iou.toFixed(3)})` : " (none stored)"}`);
          } else console.log(`${id} r${r}: unchanged`);
          continue;
        }
        mkdirSync(heroDir, { recursive: true });
        mkdirSync(paintDir, { recursive: true });
        writeFileSync(join(heroDir, `r${r}.png`), encodePng(meta.width, meta.height, 4, fresh.pixels));
        writeFileSync(join(heroDir, `r${r}.json`), JSON.stringify({ ...meta, world: opt.world, packageHash: manifest.packageHash }, null, 2) + "\n");
        const view = new Uint8Array(meta.width * meta.height);
        for (let i = 0; i < view.length; i++) view[i] = covered(fresh, i) ? fresh.pixels[i * 4] : 0;
        writeFileSync(join(heroDir, `r${r}-view.png`), encodePng(meta.width, meta.height, 1, view, palette));

        const paintPath = join(paintDir, `r${r}.png`);
        let paint;
        let note = "";
        if (opt.demoPaint || !existsSync(paintPath)) {
          paint = opt.demoPaint ? demoPaint(fresh, DEMO_RECIPES[id] ?? ["selout"], ramps) : new Uint8Array(meta.width * meta.height);
          note = opt.demoPaint ? "demo paint" : "blank paint";
        } else {
          const old = decodePng(readFileSync(paintPath));
          if (stored && old.width === stored.width && old.height === stored.height) {
            const reg = register(stored, fresh);
            const moved = reregister(old.data, stored, fresh, reg.dx, reg.dy);
            paint = moved.paint;
            note = `paint kept, offset ${reg.dx},${reg.dy}, IoU ${reg.iou.toFixed(3)}${moved.dropped ? `, ${moved.dropped} px dropped` : ""}`;
          } else if (old.width === meta.width && old.height === meta.height) {
            paint = old.data;
            note = "paint kept";
          } else throw new Error(`${paintPath} does not match its bake; re-register it by hand`);
        }
        writeFileSync(paintPath, encodePng(meta.width, meta.height, 1, paint, palette));
        console.log(`${id} r${r}: ${meta.width}×${meta.height} at ${meta.left},${meta.top} (${note})`);
      }
    }
  } finally {
    await browser.close();
    server.stop();
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
