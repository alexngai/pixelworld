#!/usr/bin/env node
/**
 * The boards the game draws from (D-178, docs/tactics/map-survey.md): each
 * city's surveyed pool with the gallery's ratings applied, written to
 * apps/tactics/survey/boards.json. A site rated bad is left out, and one no
 * fight could be made on (tools/survey-play.mjs); one rated good is drawn more
 * often, and a sample (not elected) rated good is put in.
 *
 *   node tools/survey-boards.mjs     # after rating; tools/survey-sites.mjs runs it too
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../apps/tactics/survey/", import.meta.url));
const WORLDS = ["nyc-walk", "hongkong-walk", "kyoto-walk", "paris-walk", "sf-walk", "tokyo-walk"];
/** Added to the score of a site rated good: about one rank in ten of a city's pool. */
const GOOD = 0.05;

const read = (f) => (existsSync(`${DIR}${f}`) ? JSON.parse(readFileSync(`${DIR}${f}`, "utf8")) : {});
const ratings = read("ratings.json");
const play = read("play.json");
const out = {};
for (const world of WORLDS) {
  if (!existsSync(`${DIR}${world}.json`)) continue;
  const pool = JSON.parse(readFileSync(`${DIR}${world}.json`, "utf8"));
  const key = (s) => `${world}:${s.x0},${s.y0},${s.cell}`;
  const rated = (s) => ratings[key(s)]?.rating;
  const listed = [...pool.sites.filter((s) => rated(s) !== "bad"), ...pool.samples.filter((s) => rated(s) === "good")];
  // boards not yet tried are kept: the game draws another when no fight comes of one
  const sites = listed.filter((s) => play[key(s)]?.ok !== false);
  out[world] = sites
    .map((s) => ({
      name: s.name[0].toUpperCase() + s.name.slice(1),
      zone: s.zone,
      x0: s.x0,
      y0: s.y0,
      cell: s.cell,
      score: Math.round((s.score + (rated(s) === "good" ? GOOD : 0)) * 1000) / 1000,
    }))
    .sort((a, b) => b.score - a.score);
  const n = (g) => pool.sites.concat(pool.samples).filter((s) => rated(s) === g).length;
  const untried = sites.filter((s) => !play[key(s)]).length;
  console.log(`${world}: ${out[world].length} boards (${pool.sites.length} elected, ${n("bad")} rated bad left out, ${n("good")} rated good, ${listed.length - sites.length} without a fight left out${untried ? `, ${untried} not tried` : ""})`);
}
// a board a line, so the file diffs as the ratings and weights change
const body = Object.entries(out)
  .map(([w, bs]) => `"${w}": [\n${bs.map((b) => `  ${JSON.stringify(b)}`).join(",\n")}\n]`)
  .join(",\n");
writeFileSync(`${DIR}boards.json`, `{\n${body}\n}\n`);
