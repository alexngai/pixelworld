#!/usr/bin/env node
/**
 * Proves the packed `pixelworld` and the packed city pack `@pixelworlds/city-sf`
 * work outside this workspace (docs/npm.md, D-074).
 *
 * Each consumer in examples/consumers/ is copied to a scratch directory with
 * two worlds and their style packs: the Grand Canyon slice
 * (fixtures/grand-canyon-m0, desert-southwest) and San Francisco's flying
 * level (fixtures/sf-fly, bay-area, whose towers come from the city pack). It
 * installs both tarballs with npm as any project would, is built and served,
 * and renders each world in headless Chromium (SwiftShader). A run passes when
 * the page draws with its tiles baked in the bake worker (not the main-thread
 * fallback), the worker's script loaded, and nothing failed or warned. San
 * Francisco must also load the city pack's worker module where the bundler put
 * it, and draw: without its generators, only tiles with none of its buildings
 * bake, and 4% of the frame is drawn.
 *
 *   node tools/consumers.mjs [--tarball pixelworld-x.y.z.tgz] [--city-tarball pixelworlds-city-sf-x.y.z.tgz]
 *                            [--out dir] [vite webpack esm]
 *
 * Without a tarball it packs the package first (`pnpm pack`, which builds it).
 * Needs network for npm installs. Screenshots go to <out>/screenshots.
 */
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const [, value] = args.splice(i, 2);
  return value;
};
const OUT = resolve(flag("--out") ?? join(tmpdir(), "pixelworld-consumers"));
let tarball = flag("--tarball");
let cityTarball = flag("--city-tarball");
const SHOTS = join(OUT, "screenshots");
const only = args.length ? args : ["vite", "webpack", "esm"];

/** The worlds each consumer draws (fixtures/<id>), with the style pack each manifest names. */
const WORLDS = { "grand-canyon-m0": "desert-southwest", "sf-fly": "bay-area" };
/** San Francisco's check: the share of the frame drawn (not the style's background) a working city pack gives at least. */
const SF = { query: "?world=sf-fly", minDrawn: 0.5 };
const styleBackground = async (id) => JSON.parse(await readFile(join(ROOT, `worlds/_styles/${id}/style.json`), "utf8")).background;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".css": "text/css",
  ".png": "image/png",
};

function run(cmd, argv, cwd) {
  console.log(`  $ ${cmd} ${argv.join(" ")}`);
  const r = spawnSync(cmd, argv, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(" ")} failed in ${cwd}`);
}

async function freePort() {
  return new Promise((ok) => {
    const s = createNetServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/** A static file server over one or more roots, as `python -m http.server` (or, with `cors`, a CDN) would serve them. */
async function serve(roots, { cors = false } = {}) {
  const server = createServer(async (req, res) => {
    if (cors) res.setHeader("access-control-allow-origin", "*");
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    for (const root of roots) {
      let file = join(root, path);
      if (!file.startsWith(root)) break;
      try {
        if ((await stat(file)).isDirectory()) file = join(file, "index.html");
        const body = await readFile(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(body);
        return;
      } catch {
        // try the next root
      }
    }
    res.writeHead(404).end("not found");
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://localhost:${server.address().port}/`, close: () => server.close() };
}

/** `vite` (dev server) in the background; resolves once it answers. */
async function viteDev(cwd) {
  const port = await freePort();
  const child = spawn("npx", ["vite", "--port", String(port), "--strictPort"], { cwd, detached: true, stdio: "ignore" });
  const url = `http://localhost:${port}/`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return { url, close: () => process.kill(-child.pid) };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  process.kill(-child.pid);
  throw new Error("vite dev server did not start");
}

/** The share of a screenshot's pixels that aren't `background` (the style's, a hex colour): about 0 for a world that drew nothing. */
async function drawnShare(page, png, background) {
  return page.evaluate(
    async ([b64, hex]) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const g = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d");
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      const bg = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      let drawn = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] !== bg[0] || d[i + 1] !== bg[1] || d[i + 2] !== bg[2]) drawn++;
      return drawn / (d.length / 4);
    },
    [png.toString("base64"), background],
  );
}

/**
 * Open a page, wait for the view to be ready, check the worker baked, screenshot. With
 * `expectPlugin`, a request for the city pack's worker module must match it; with
 * `minDrawn`, tiles must have baked and that share of the frame must not be `background`.
 */
async function check(browser, name, url, { expectWorker, expectPlugin, minDrawn, background } = {}) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const problems = [];
  const workers = [];
  const requests = [];
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("console", (m) => {
    // the engine warns when a style's plugin isn't loaded; failed bakes are errors
    if (m.type() === "error" || (m.type() === "warning" && /plugin|generator/i.test(m.text()))) problems.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on("worker", (w) => workers.push(w.url()));
  page.on("request", (r) => requests.push(r.url()));
  page.on("response", (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()} ${r.url()}`));
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.bakeMode || document.body.dataset.error, null, {
    timeout: 180_000,
  });
  const ms = Date.now() - t0;
  const { bakeMode, tilesBaked, error } = await page.evaluate(() => ({ ...document.body.dataset }));
  const status = await page.textContent("#status");
  const shot = join(SHOTS, `${name}.png`);
  const png = await page.screenshot({ path: shot });
  const drawn = minDrawn ? await drawnShare(page, png, background) : null;
  await page.close();
  if (error) problems.push(`view error: ${error}`);
  if (bakeMode !== "worker") problems.push(`baked in "${bakeMode}", not in the worker`);
  if (!workers.length) problems.push("no worker was created");
  if (expectWorker && !workers.some((w) => expectWorker.test(w))) problems.push(`worker ${workers} is not ${expectWorker}`);
  if (expectPlugin && !requests.some((u) => expectPlugin.test(u)))
    problems.push(`no request for the city pack's worker module (${expectPlugin}): ${requests.filter((u) => /\.js(\?|$)/.test(u)).join(" ")}`);
  if (minDrawn && !(Number(tilesBaked) > 0)) problems.push(`no tiles baked (${tilesBaked})`);
  if (minDrawn && drawn < minDrawn) problems.push(`only ${(drawn * 100).toFixed(1)}% of the frame is drawn, under ${minDrawn * 100}%: a blank world`);
  const result = { name, ok: problems.length === 0, ms, worker: workers[0] ?? "-", status, shot, problems };
  const extra = drawn === null ? "" : `; ${(drawn * 100).toFixed(0)}% drawn`;
  console.log(`  ${result.ok ? "ok  " : "FAIL"} ${name}: ${status} (${ms} ms; worker ${result.worker}${extra})`);
  for (const p of problems) console.log(`       ${p}`);
  return result;
}

/** San Francisco on a consumer's page: its city pack's worker module loaded from `expectPlugin`, and a drawn frame. */
async function checkSF(browser, name, base, expectPlugin, opts = {}) {
  return check(browser, name, `${base}${SF.query}`, { ...opts, expectPlugin, minDrawn: SF.minDrawn, background: await styleBackground("bay-area") });
}

/** Copy a consumer's sources, add the worlds and style packs it draws, install the tarballs. */
async function prepare(name, dataDir) {
  const dir = join(OUT, name);
  await rm(dir, { recursive: true, force: true });
  await cp(join(ROOT, "examples/consumers", name), dir, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|dist|package-lock\.json)$/.test(src),
  });
  const data = join(dir, dataDir);
  for (const [world, style] of Object.entries(WORLDS)) {
    await cp(join(ROOT, "fixtures", world), join(data, "worlds", world), { recursive: true });
    await mkdir(join(data, "styles", style), { recursive: true });
    await cp(join(ROOT, `worlds/_styles/${style}/style.json`), join(data, `styles/${style}/style.json`));
  }
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball, cityTarball], dir);
  return dir;
}

const consumers = {
  async vite(browser) {
    const dir = await prepare("vite", "public");
    run("npx", ["tsc", "--noEmit"], dir); // the package's types, with skipLibCheck off
    const results = [];
    const dev = await viteDev(dir);
    try {
      results.push(await check(browser, "vite-dev", dev.url, { expectWorker: /bake\.worker\.js/ }));
      // the dev server pre-bundles the city pack and serves its worker module from node_modules
      results.push(await checkSF(browser, "vite-dev-sf", dev.url, /\/@pixelworlds\/city-sf\/dist\/worker\.js/));
    } finally {
      dev.close();
    }
    run("npx", ["vite", "build", "--logLevel", "warn"], dir);
    const assets = await readdir(join(dir, "dist/assets"));
    if (!assets.some((f) => /^bake\.worker-.*\.js$/.test(f))) throw new Error(`vite build emitted no worker: ${assets}`);
    if (!assets.some((f) => /^worker-.*\.js$/.test(f))) throw new Error(`vite build emitted no city pack worker module: ${assets}`);
    const built = await serve([join(dir, "dist")]);
    try {
      results.push(await check(browser, "vite-build", built.url, { expectWorker: /assets\/bake\.worker-/ }));
      results.push(await checkSF(browser, "vite-build-sf", built.url, /\/assets\/worker-[\w-]+\.js$/));
    } finally {
      built.close();
    }
    return results;
  },

  async webpack(browser) {
    const dir = await prepare("webpack", "public");
    run("npx", ["webpack", "--no-stats"], dir);
    const built = await serve([join(dir, "dist"), join(dir, "public")]);
    // webpack emits the city pack's worker module as an asset of its own, named by its hash
    const emitted = (await readdir(join(dir, "dist"))).filter((f) => /^[0-9a-f]{8,}\.js$/.test(f));
    if (emitted.length !== 1) throw new Error(`webpack emitted ${emitted.length} hashed assets, not the city pack's worker module alone: ${emitted}`);
    try {
      return [
        await check(browser, "webpack-build", built.url),
        await checkSF(browser, "webpack-build-sf", built.url, new RegExp(`/${emitted[0]}$`)),
      ];
    } finally {
      built.close();
    }
  },

  async esm(browser) {
    const dir = await prepare("esm", ".");
    // the workerUrl option: a copy of the worker somewhere else on the origin
    await mkdir(join(dir, "vendor"), { recursive: true });
    await cp(join(dir, "node_modules/pixelworld/dist/bake.worker.js"), join(dir, "vendor/bake.worker.js"));
    const site = await serve([dir]);
    // the package's dist/ on another origin, as a CDN serves it (cdn.html wraps the worker in a blob: URL)
    const cdn = await serve([join(dir, "node_modules/pixelworld/dist")], { cors: true });
    try {
      return [
        await check(browser, "esm", site.url, { expectWorker: /node_modules\/pixelworld\/dist\/bake\.worker\.js$/ }),
        await check(browser, "esm-workerUrl", `${site.url}?workerUrl=/vendor/bake.worker.js`, {
          expectWorker: /\/vendor\/bake\.worker\.js$/,
        }),
        await check(browser, "esm-cdn", `${site.url}cdn.html?cdn=${encodeURIComponent(cdn.url.replace("localhost", "127.0.0.1"))}`, {
          expectWorker: /^blob:/,
        }),
        await checkSF(browser, "esm-sf", site.url, /\/node_modules\/@pixelworlds\/city-sf\/dist\/worker\.js$/),
      ];
    } finally {
      site.close();
      cdn.close();
    }
  },
};

await mkdir(SHOTS, { recursive: true });
/** Pack a workspace package into OUT (`pnpm pack` builds it first); the tarball's path. */
async function pack(name, file) {
  console.log(`packing ${name}`);
  run("pnpm", ["--filter", name, "pack", "--pack-destination", OUT], ROOT);
  const tgz = (await readdir(OUT)).filter((f) => file.test(f)).sort();
  return join(OUT, tgz.at(-1));
}
tarball = resolve(tarball ?? (await pack("pixelworld", /^pixelworld-.*\.tgz$/)));
cityTarball = resolve(cityTarball ?? (await pack("@pixelworlds/city-sf", /^pixelworlds-city-sf-.*\.tgz$/)));
console.log(`consumers of ${tarball} and ${cityTarball} in ${OUT}`);

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const results = [];
try {
  for (const name of only) {
    if (!consumers[name]) throw new Error(`no consumer "${name}" (have ${Object.keys(consumers)})`);
    console.log(`\n${name}`);
    results.push(...(await consumers[name](browser)));
  }
} finally {
  await browser.close();
}

console.log("\nconsumer              ready     bake worker");
for (const r of results) console.log(`${(r.ok ? "ok   " : "FAIL ") + r.name.padEnd(18)} ${String(r.ms).padStart(6)} ms  ${r.worker}`);
console.log(`screenshots: ${SHOTS}`);
if (results.some((r) => !r.ok)) process.exit(1);
