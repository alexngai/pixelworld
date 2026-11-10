#!/usr/bin/env node
/**
 * Prints a style pack's ramps as colour swatches in the terminal, by day and
 * by night, with their palette indices and what in the pack uses each
 * (D-075, docs/style-guide.md §18): to pick a new ramp's colours beside its
 * neighbours, and, with all 42 slots taken, to find one a variant can drop.
 *
 *   node tools/swatches.mjs <pack id | path to a style.json> [--plain]
 *
 * A pack that `extends` another is merged first (the rule in
 * packages/style/src/load.ts; a test keeps the two alike), its parent found
 * beside it or in worlds/_styles/. Swatches need a terminal with 24-bit
 * colour; --plain, NO_COLOR or a pipe prints hex instead.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const STYLES = join(REPO, "worlds/_styles");
const MAX_RAMPS = 42;
const SHADES = 6;
/** Ramps the code names directly, not through the pack. */
const BY_CODE = { marker: "the rover (by name)" };

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** The merge rule of `extends`: objects key by key, anything else replaces, null deletes. */
export function merge(base, over) {
  if (!isObject(over)) return over;
  const out = isObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete out[k];
    else out[k] = merge(out[k], v);
  }
  return out;
}

/** A pack by id or path, with its `extends` chain merged in. */
export function loadPack(arg, seen = []) {
  const file = arg.endsWith(".json") || arg.includes("/") ? resolve(arg) : join(STYLES, arg, "style.json");
  const pack = JSON.parse(readFileSync(file, "utf8"));
  if (typeof pack.extends !== "string") return pack;
  if (seen.includes(pack.extends)) throw new Error(`the packs extend each other in a circle: ${[...seen, pack.id, pack.extends].join(" → ")}`);
  const beside = join(dirname(dirname(file)), pack.extends, "style.json");
  const parent = loadPack(existsSync(beside) ? beside : pack.extends, [...seen, pack.id]);
  const { extends: _extends, ...own } = pack;
  return merge(parent, own);
}

/** Ramp name → what in the pack (or the code) uses it. */
export function rampUses(pack) {
  const uses = new Map(Object.keys(pack.ramps ?? {}).map((r) => [r, []]));
  const use = (ramp, what) => uses.get(ramp)?.push(what);
  for (const [set, bands] of Object.entries(pack.strataSets ?? {})) bands.forEach((b) => use(b.ramp, `strata ${set}`));
  for (const [name, s] of Object.entries(pack.surfaces ?? {})) use(s.ramp, `surface ${name}`);
  for (const [name, s] of Object.entries(pack.objects?.surfaces ?? {})) use(s.ramp, `surface ${name} (objects)`);
  const roads = pack.roads ?? {};
  for (const k of ["asphalt", "marking", "rail"]) if (roads[k]) use(roads[k], `roads.${k}`);
  if (roads.lanes) use(roads.lanes.ramp, "lane lines");
  for (const [name, c] of Object.entries(roads.classes ?? {})) if (c.ramp) use(c.ramp, `road ${name}`);
  for (const [name, c] of Object.entries(pack.paths?.classes ?? {})) use(c.ramp, `path ${name}`);
  for (const [group, a] of Object.entries(pack.assets ?? {}))
    for (const [role, ramp] of Object.entries(a.ramps ?? {})) use(ramp, `${group}:${role}`);
  if (pack.atmosphere?.fog) use(pack.atmosphere.fog.ramp, "fog");
  for (const [ramp, what] of Object.entries(BY_CODE)) use(ramp, what);
  // a strata set's bands, or an asset's roles, read once each
  for (const [ramp, list] of uses) uses.set(ramp, [...new Set(list)]);
  return uses;
}

const rgb = (hex) => {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** A ramp's night colours: its own if it glows, else dimmed as buildPalette does. */
export function nightRamp(pack, ramp) {
  const night = pack.night;
  if (!night) return null;
  if (night.emissive?.[ramp]) return night.emissive[ramp];
  return pack.ramps[ramp].map((hex) => {
    const [r, g, b] = rgb(hex);
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    const c = [r, g, b].map((v, k) => Math.round(Math.min(255, Math.max(0, (l + (v - l) * night.saturation) * night.multiply[k] + night.add[k]))));
    return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
  });
}

/** The listing, as lines of text. */
export function render(pack, { colour = true } = {}) {
  const names = Object.keys(pack.ramps ?? {});
  const uses = rampUses(pack);
  const swatch = (hexes) =>
    !hexes ? "" : colour ? hexes.map((h) => `\x1b[48;2;${rgb(h).join(";")}m  \x1b[0m`).join("") : hexes.join(" ");
  const width = Math.max(...names.map((n) => n.length), 4);
  const lines = [
    `${pack.id} (${pack.name}): ${names.length} of ${MAX_RAMPS} ramps, palette indices 1–${names.length * SHADES}`,
    `  ${"#".padStart(2)}  ${"ramp".padEnd(width)}  ${"day".padEnd(colour ? 12 : 47)}  ${pack.night ? "night".padEnd(colour ? 12 : 47) + "  " : ""}used by`,
  ];
  names.forEach((name, i) => {
    const used = uses.get(name);
    const what = used.length ? used.slice(0, 4).join(", ") + (used.length > 4 ? `, +${used.length - 4} more` : "") : "—";
    const night = pack.night ? swatch(nightRamp(pack, name)) + (pack.night.emissive?.[name] ? "* " : "  ") : "";
    lines.push(`  ${String(i).padStart(2)}  ${name.padEnd(width)}  ${swatch(pack.ramps[name])}  ${night}${what}`);
  });
  const unused = names.filter((n) => uses.get(n).length === 0);
  if (pack.night) lines.push("  * glows at night (night.emissive)");
  lines.push(unused.length ? `unused in the pack: ${unused.join(", ")}` : "every ramp is used");
  return lines;
}

function main() {
  const args = process.argv.slice(2);
  const arg = args.find((a) => !a.startsWith("--"));
  if (!arg) {
    console.error("usage: node tools/swatches.mjs <pack id | path to a style.json> [--plain]");
    process.exit(2);
  }
  const colour = !args.includes("--plain") && !process.env.NO_COLOR && process.stdout.isTTY;
  console.log(render(loadPack(arg), { colour }).join("\n"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
