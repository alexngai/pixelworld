import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { openWorld } from "@pixelworlds/engine";
import { Boards } from "@pixelworlds/engine/boards";
import { it, vi } from "vitest";
import { FIGHTERS, SQUAD, SQUADS, arenaFromBoard, cloneCombat, generatePuzzle, loadoutOf, solveFight, solveTurn, teamOf, type Combat, type Squad } from "../src/index";

/**
 * Squad balance (D-173), on demand (`BALANCE=1`, and `POOL=<file>` to keep the
 * positions and measure every later change on the same ones): positions
 * pooled from every squad's puzzles on four of the Financial District's
 * boards; each squad put in the rigs' places on each; how often it holds the
 * round and the whole fight.
 */
const swap = (c0: Combat, sq: Squad): Combat => {
  const c = cloneCombat(c0);
  let i = 0;
  for (let u = 0; u < c.roster.length; u++) {
    if (teamOf(c, u) !== SQUAD) continue;
    const r = sq.rigs[i++]!;
    const l = loadoutOf(r.kind, r.slots.map((id) => (id ? { id, ups: [] } : null)));
    c.roster[u] = r.kind;
    c.arms[u] = l.arms;
    c.hp[u] = FIGHTERS[r.kind].hp;
  }
  return c;
};

it.skipIf(!process.env.BALANCE)("squads hold about as often as each other", async () => {
  const ROOT = new URL("../../../", import.meta.url);
  const style = (id: string) => JSON.parse(readFileSync(new URL(`worlds/_styles/${id}/style.json`, ROOT), "utf8")) as object;
  vi.stubGlobal("fetch", async (url: string | URL) => {
    try { return new Response(readFileSync(new URL(`fixtures${new URL(String(url)).pathname}`, ROOT))); } catch { return new Response("nf", { status: 404 }); }
  });
  const w = await openWorld({ worldUrl: "nyc-walk/", base: "https://pixelworld.test/", style });
  const [x, y] = w.query.lonLatToCell(-74.0125, 40.7055)!;
  const boards = new Boards(w);
  const POOL = process.env.POOL ?? "";
  const TA = { Uint8Array, Int8Array, Int16Array, Float32Array } as Record<string, new (a: number[]) => unknown>;
  const freeze = (v: unknown) => JSON.stringify(v, (_, x) => (ArrayBuffer.isView(x) ? { __t: x.constructor.name, v: Array.from(x as Uint8Array) } : x));
  const thaw = (s: string) => JSON.parse(s, (_, x) => (x && typeof x === "object" && "__t" in x ? new TA[x.__t]!(x.v) : x)) as Combat[];
  const pool: Combat[] = POOL && existsSync(POOL) ? thaw(readFileSync(POOL, "utf8")) : [];
  if (!pool.length) for (const [dx, dy] of [[0, 0], [8, 0], [0, 8], [-8, 0]] as const) {
    const board = await boards.add({ x0: Math.floor(x) - 8 + dx, y0: Math.floor(y) - 8 + dy, w: 8, h: 8, cell: 2 });
    const a = arenaFromBoard(board, w.query, w.world.manifest.surfaces, { metersPerCell: 10 });
    for (const sq of SQUADS)
      for (const seed of [1, 2]) {
        const squad = sq.rigs.map((r) => loadoutOf(r.kind, r.slots.map((id) => (id ? { id, ups: [] } : null))));
        // a position for the round (one round's puzzle: the fight check is what's measured)
        const p = await generatePuzzle(a, { seed, timeMs: 2500, attempts: 120, rounds: 1, arrivals: 1, squad, target: 6, clever: false });
        if (p) pool.push(p.combat);
      }
  }
  if (POOL && !existsSync(POOL)) writeFileSync(POOL, freeze(pool));
  const rows: string[] = [`${pool.length} positions`];
  for (const sq of SQUADS) {
    let round = 0;
    let fight = 0;
    let strikes = 0;
    const t0 = performance.now();
    for (const c0 of pool) {
      const c = swap(c0, sq);
      const t = solveTurn(c, { keep: 1, maxNodes: 60_000 });
      if (t.perfect.length) {
        round++;
        strikes += t.minStrikes;
        if (solveFight(c, { rounds: 3, maxNodes: 150_000 }).winnable) fight++;
      }
    }
    rows.push(`${sq.id.padEnd(10)} holds the round ${round}/${pool.length} (${Math.round((100 * round) / pool.length)}%), the fight ${fight}/${pool.length} (${Math.round((100 * fight) / pool.length)}%), fewest strikes ${(strikes / Math.max(1, round)).toFixed(2)}, ${Math.round(performance.now() - t0)} ms`);
  }
  console.log(rows.join("\n"));
}, 1_800_000);
