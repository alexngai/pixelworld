#!/usr/bin/env node
/**
 * Can a fight be made on each surveyed board (D-178, docs/tactics/map-survey.md)?
 * A puzzle made on each board in the pools as the game makes one (the first
 * squad, three rounds, six seconds), and the fight played by the
 * simulation's bots and measured (apps/tactics/src/sim.ts, D-181); the
 * outcome kept by board in apps/tactics/survey/play.json, boards already
 * tried not tried again. tools/survey-boards.mjs leaves out the boards no
 * fight came of and reranks the rest with the simulation.
 *
 *   node tools/survey-play.mjs                    # every city, 10 processes
 *   node tools/survey-play.mjs kyoto-walk --jobs 4
 *   node tools/survey-play.mjs --again            # try them all again
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const DIR = `${REPO}apps/tactics/survey/`;
const FILE = `${DIR}play.json`;
const WORLDS = ["nyc-walk", "hongkong-walk", "kyoto-walk", "paris-walk", "sf-walk", "tokyo-walk"];
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : dflt;
};
const jobs = Number(opt("jobs", "10"));
const part = opt("part", null);
const again = args.includes("--again");
const worlds = args.filter((a) => !a.startsWith("--"));
const keyOf = (world, s) => `${world}:${s.x0},${s.y0},${s.cell}`;
const done = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
const todo = (worlds.length ? worlds : WORLDS).flatMap((world) => {
  if (!existsSync(`${DIR}${world}.json`)) return [];
  const pool = JSON.parse(readFileSync(`${DIR}${world}.json`, "utf8"));
  return pool.sites.concat(pool.samples).flatMap((s) => (again || !done[keyOf(world, s)] ? [{ world, x0: s.x0, y0: s.y0, cell: s.cell }] : []));
});

if (part === null) {
  // the parent: the boards split over child processes, their outcomes merged
  if (!todo.length) {
    console.log("Every board has been tried (--again to try them again).");
    process.exit(0);
  }
  console.log(`${todo.length} boards to try, ${jobs} at a time`);
  const t0 = performance.now();
  const outs = await Promise.all(
    Array.from({ length: Math.min(jobs, todo.length) }, (_, k) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...worlds, ...(again ? ["--again"] : []), "--part", `${k}/${jobs}`], { stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        child.stdout.on("data", (c) => (out += c));
        child.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`part ${k} failed (${code})`))));
      }),
    ),
  );
  const all = Object.assign(done, ...outs);
  writeFileSync(FILE, `{\n${Object.keys(all).sort().map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(all[k])}`).join(",\n")}\n}\n`);
  const fresh = outs.flatMap((o) => Object.values(o));
  console.log(`${fresh.filter((r) => r.ok).length} of ${fresh.length} made a fight (${((performance.now() - t0) / 1000).toFixed(0)} s); wrote ${FILE.replace(REPO, "")}`);
  for (const world of worlds.length ? worlds : WORLDS) {
    const rs = Object.entries(all).filter(([k]) => k.startsWith(`${world}:`));
    if (rs.length) console.log(`  ${world}: ${rs.filter(([, r]) => r.ok).length} of ${rs.length}`);
  }
  process.exit(0);
}

// a child: its share of the boards, the outcomes as JSON on stdout
const [k, n] = part.split("/").map(Number);
const mine = todo.filter((_, i) => i % n === k);
globalThis.fetch = async (url) => {
  try {
    return new Response(readFileSync(`${REPO}fixtures${new URL(String(url)).pathname}`));
  } catch {
    return new Response("not found", { status: 404 });
  }
};
const style = (id) => JSON.parse(readFileSync(`${REPO}worlds/_styles/${id}/style.json`, "utf8"));
const server = await createServer({
  configFile: false,
  root: REPO,
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});
const out = {};
try {
  const { openWorld, Boards } = await server.ssrLoadModule("/packages/engine/src/index.ts");
  const { arenaFromBoard, generatePuzzle, SQUADS } = await server.ssrLoadModule("/packages/tactics/src/index.ts");
  const { newRun, loadouts } = await server.ssrLoadModule("/apps/tactics/src/runs.ts");
  const { simulate } = await server.ssrLoadModule("/apps/tactics/src/sim.ts");
  const r2 = (v) => Math.round(v * 100) / 100;
  const squad = loadouts(newRun(SQUADS[0]));
  const opened = new Map();
  for (const b of mine) {
    if (!opened.has(b.world)) {
      const w = await openWorld({ worldUrl: `${b.world}/`, base: "https://pixelworld.test/", style });
      opened.set(b.world, { w, boards: new Boards(w) });
    }
    const { w, boards } = opened.get(b.world);
    const board = await boards.add({ x0: b.x0, y0: b.y0, w: 8, h: 8, cell: b.cell });
    const arena = arenaFromBoard(board, w.query, w.world.manifest.surfaces, { metersPerCell: w.world.manifest.scale.metersPerCell });
    boards.remove(board);
    const t0 = performance.now();
    let tried = 0;
    // as the game makes its first block's (apps/tactics/src/main.ts)
    const puzzle = await generatePuzzle(arena, { seed: 1, timeMs: 6000, attempts: 400, rounds: 3, arrivals: 1, squad, onProgress: (t) => (tried = t) });
    const ms = Math.round(performance.now() - t0);
    if (!puzzle) {
      out[keyOf(b.world, b)] = { ok: false, tried, ms };
      continue;
    }
    const s = simulate(puzzle);
    out[keyOf(b.world, b)] = {
      ok: true,
      tried,
      ms,
      sim: {
        score: r2(s.score),
        kinds: s.kinds,
        held: Object.entries(s.bots).flatMap(([bot, f]) => (f.held ? [bot] : [])),
        room: s.room,
        terms: Object.fromEntries(Object.entries(s.terms).map(([k, v]) => [k, r2(v)])),
      },
    };
  }
} finally {
  await server.close();
}
process.stdout.write(JSON.stringify(out));
