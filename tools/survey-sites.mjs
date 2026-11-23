#!/usr/bin/env node
/**
 * The map survey (docs/tactics/map-survey.md, D-174): every board position in
 * each walking-level city scored, the city split into character zones, each
 * zone's best elected; one pool of sites per city written to
 * apps/tactics/survey/<world>.json, and a summary printed.
 *
 *   node tools/survey-sites.mjs                 # every city
 *   node tools/survey-sites.mjs nyc-walk        # one
 *   node tools/survey-sites.mjs --step 8        # a coarser scan, quicker
 *
 * The worlds are read from fixtures/; the TypeScript (apps/tactics/src/survey.ts
 * and the packages it uses) is loaded through Vite.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { createServer } from "vite";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const WORLDS = ["nyc-walk", "hongkong-walk", "kyoto-walk", "paris-walk", "sf-walk", "tokyo-walk"];
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args.splice(i, 2)[1]) : dflt;
};
const step = flag("step", 4);
const only = args.filter((a) => !a.startsWith("--"));
const worlds = only.length ? only : WORLDS;

const objectsOf = (world) => {
  const d = JSON.parse(gunzipSync(readFileSync(`${REPO}fixtures/${world}/objects.json.gz`)).toString());
  return d.instances ?? d;
};

// each group's inverse document frequency over the cities: the city's own types score
const groupsBy = new Map(WORLDS.map((w) => [w, new Set(objectsOf(w).map((o) => o.g))]));
const df = new Map();
for (const set of groupsBy.values()) for (const g of set) df.set(g, (df.get(g) ?? 0) + 1);
const idf = new Map([...df].map(([g, n]) => [g, Math.log(WORLDS.length / n)]));

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
try {
  const { surveyCity } = await server.ssrLoadModule("/apps/tactics/src/survey.ts");
  const { openWorld } = await server.ssrLoadModule("/packages/engine/src/index.ts");
  const { CITIES } = await server.ssrLoadModule("/apps/tactics/src/sites.ts");
  mkdirSync(`${REPO}apps/tactics/survey`, { recursive: true });
  for (const world of worlds) {
    const t0 = performance.now();
    const w = await openWorld({ worldUrl: `${world}/`, base: "https://pixelworld.test/", style });
    const places = (CITIES.find((c) => c.world === world)?.sites ?? []).flatMap((s) => {
      const at = w.query.lonLatToCell(s.lon, s.lat);
      return at ? [{ name: s.name, x: at[0], y: at[1] }] : [];
    });
    const r = await surveyCity(w, {
      objects: objectsOf(world),
      idf,
      cities: WORLDS.length,
      places,
      step,
      onProgress: (m) => console.log(`  ${world}: ${m}`),
    });
    const round = (v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v);
    const json = JSON.stringify(r, (_, v) => (Array.isArray(v) ? v : typeof v === "object" && v ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : round(v)), 1);
    writeFileSync(`${REPO}apps/tactics/survey/${world}.json`, `${json}\n`);
    const s = (x) => x.toFixed(2);
    console.log(`\n${world}: ${r.sites.length} sites from ${r.passed} of ${r.candidates} positions, ${r.zones} ${r.zoning} zones (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
    for (const site of r.sites.slice(0, 12))
      console.log(
        `  ${s(site.score)}  read ${s(site.parts.readability)} play ${s(site.parts.interactables)} char ${s(site.parts.character)}  ${site.name}  (${site.x0},${site.y0} ×${site.cell}, hidden ${site.facts.hiddenCells}, cut ${site.facts.cut})`,
      );
    for (const ref of r.references) console.log(`  reference ${ref.name}: ${ref.score === null ? "nothing passes the gates nearby" : `best ${s(ref.score)}, top ${Math.round(ref.rank * 100)}%`}`);
  }
} finally {
  await server.close();
}
