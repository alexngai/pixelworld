#!/usr/bin/env node
/**
 * Start tiles: a world's first view baked ahead, so a first visit shows it at
 * once instead of baking it (seconds to minutes on a dense walking level).
 * Opens the game at the world's start in headless Chromium, waits until
 * everything it asked for is baked, and writes the tiles from the engine's
 * IndexedDB tile cache, keys and gzip pixels as they are, to
 *
 *   fixtures/<world>/start-tiles.bin
 *
 * which createWorldView reads before baking (its `startTiles` option, see
 * StartTiles in packages/runtime/src/tileCache.ts). The keys hold the package,
 * the style, the bake code and the plugins (D-072): after a change to any of
 * them the tiles no longer match and the view bakes as before, so run this
 * again (`--check` says whether a pack still matches).
 *
 *   node tools/prebake.mjs --world nyc-walk               bake and write the pack
 *   node tools/prebake.mjs --world nyc-walk --check       exit 1 unless the pack covers the start view
 *   options: --sizes 1920x1080,390x844 (the views to cover, CSS px: a desktop's and a
 *   phone's, each sees a few tiles the other doesn't), --url <running dev server of apps/game>
 *
 * The plugins' part of the key hashes their code as the page has it, so tiles
 * baked by a dev server don't match a build, nor one app's build another's:
 * bake against the page that will read them. --url also takes a built
 * viewer or game, e.g. the site's (pixelworld.site, D-142):
 *
 *   node tools/prebake.mjs --world sf-walk --url http://localhost:4190/view
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAGIC = "PXST";

function args(argv) {
  const out = { world: null, sizes: "1920x1080,390x844", url: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--world") out.world = argv[++i];
    else if (a === "--sizes") out.sizes = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--check") out.check = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.world) throw new Error("usage: node tools/prebake.mjs --world <package in fixtures/> [--check] [--sizes WxH,...] [--url URL]");
  return out;
}

async function devServer(url) {
  if (url) return { url, stop: () => {} };
  const port = 5198;
  const child = spawn("pnpm", ["--filter", "@pixelworlds/game", "exec", "vite", "--port", String(port), "--strictPort"], {
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

/** The pack file: "PXST", the header's length (u32 LE), the header (JSON), then each tile's gzip pixels. */
export function encodePack(tiles) {
  let offset = 0;
  const head = {
    tiles: tiles.map(({ key, left, top, width, height, depthBase, pixels }) => {
      const t = { key, left, top, width, height, depthBase, offset, length: pixels.length };
      offset += pixels.length;
      return t;
    }),
  };
  const json = Buffer.from(JSON.stringify(head));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  return Buffer.concat([Buffer.from(MAGIC), len, json, ...tiles.map((t) => t.pixels)]);
}

export function decodePackKeys(file) {
  if (file.subarray(0, 4).toString() !== MAGIC) return null;
  const n = file.readUInt32LE(4);
  return JSON.parse(file.subarray(8, 8 + n).toString()).tiles.map((t) => t.key);
}

/** The game (or the viewer) at the world's start; resolves with the view's stats once everything it asked for is baked. */
async function view(page, url, opt) {
  // with --check, the pack in place and no IndexedDB: everything the view needs should come from it
  const query = `world=/${opt.world}/&traffic=0&fog=0&paused=1&hud=0${opt.check ? "&cache=0" : "&startTiles=0"}`;
  await page.goto(`${url}/?${query}`);
  await page.waitForFunction(() => window.__game !== undefined || window.__pixelworld !== undefined, null, { timeout: 1_200_000, polling: 500 });
  // ready() covers the view; also wait for what it asked for around it (look-ahead, the car's reveal) and the cache writes
  return page.evaluate(async () => {
    const view = window.__game?.game.view ?? window.__pixelworld;
    await view.ready();
    let still = 0;
    for (;;) {
      const s = view.stats();
      const settled = s.tilesPending === 0 && (s.cache === "off" || s.cacheWrites >= s.tilesBaked - s.modelsFailed);
      still = settled ? still + 1 : 0;
      if (still >= 4) return s;
      await new Promise((r) => setTimeout(r, 250));
    }
  });
}

async function main() {
  const opt = args(process.argv.slice(2));
  const sizes = opt.sizes.split(",").map((s) => s.split("x").map(Number));
  const out = join(REPO, "fixtures", opt.world, "start-tiles.bin");
  if (!existsSync(join(REPO, "fixtures", opt.world, "manifest.json"))) throw new Error(`no world package fixtures/${opt.world}`);
  const server = await devServer(opt.url);
  // the platform's GPU (headless Chromium would use SwiftShader, many times slower at baking)
  // elsewhere SwiftShader, as the e2e tests and the other tools run on CI's runners (no GPU)
  const gpu = process.platform === "darwin" ? ["--use-angle=metal"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
  const browser = await chromium.launch({ args: [...gpu, "--ignore-gpu-blocklist"] });
  try {
    // one context: each size's view bakes only what the ones before it didn't (the tile cache is shared)
    const context = await browser.newContext();
    let page;
    let stats;
    const t0 = Date.now();
    for (const [w, h] of sizes) {
      page = await context.newPage(); // a context's newPage takes no options: size it after
      await page.setViewportSize({ width: w, height: h });
      stats = await view(page, server.url, opt);
      if (opt.check) {
        const label = `${opt.world} at ${w}×${h}: ${stats.tilesFromCache} tiles from the pack, ${stats.tilesBaked} baked`;
        if (stats.tilesBaked === 0 && stats.tilesFromCache > 0) console.log(label);
        else {
          const why = !existsSync(out) ? "is missing" : stats.tilesFromCache ? "doesn't cover this view" : "no longer matches";
          console.error(`${label}: the start pack ${why}; run node tools/prebake.mjs --world ${opt.world}`);
          process.exitCode = 1;
        }
      }
    }
    if (opt.check) return;
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    if (stats.modelsFailed) throw new Error(`${stats.modelsFailed} models failed to generate: not packing tiles with missing-model markers`);
    const id = JSON.parse(readFileSync(join(REPO, "fixtures", opt.world, "manifest.json"), "utf8")).id;
    const tiles = await page.evaluate(async (prefix) => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open("pixelworld-tiles", 1);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      const all = (op) =>
        new Promise((res, rej) => {
          const r = op(db.transaction("tiles").objectStore("tiles"));
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      const [keys, recs] = [await all((s) => s.getAllKeys()), await all((s) => s.getAll())];
      const base64 = (buf) => {
        const b = new Uint8Array(buf);
        let s = "";
        for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
        return btoa(s);
      };
      return keys
        .map((key, i) => ({ key, rec: recs[i] }))
        .filter(({ key }) => key.startsWith(prefix))
        .map(({ key, rec }) => ({ key, left: rec.left, top: rec.top, width: rec.width, height: rec.height, depthBase: rec.depthBase, pixels: base64(rec.pixels) }));
    }, `${id}|`);
    if (!tiles.length) throw new Error("no tiles in the tile cache: nothing to pack");
    const pack = encodePack(tiles.sort((a, b) => (a.key < b.key ? -1 : 1)).map((t) => ({ ...t, pixels: Buffer.from(t.pixels, "base64") })));
    writeFileSync(out, pack);
    console.log(`${opt.world}: ${tiles.length} tiles baked in ${seconds} s, ${(pack.length / 2 ** 20).toFixed(2)} MB → fixtures/${opt.world}/start-tiles.bin`);
  } finally {
    await browser.close();
    server.stop();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
