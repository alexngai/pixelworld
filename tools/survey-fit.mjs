#!/usr/bin/env node
/**
 * The map survey's weights fitted to the gallery's ratings (D-176,
 * docs/tactics/map-survey.md). A site's score is a weighted sum of its terms;
 * the fit looks for the weights that put every site rated better above every
 * site rated worse (a pairwise logistic loss), each set of weights summing to
 * one, pulled toward the weights now so that a few ratings move them a little
 * and many move them more.
 *
 *   node tools/survey-fit.mjs              # how well the weights now and the fitted agree with the ratings
 *   node tools/survey-fit.mjs --write      # and write the fitted to apps/tactics/survey/weights.json
 *   node tools/survey-fit.mjs --ratings other.json --pull 0.5
 *
 * Then `node tools/survey-sites.mjs` scores the cities again with them.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const WEIGHTS = `${REPO}apps/tactics/survey/weights.json`;
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const ratingsFile = opt("ratings", `${REPO}apps/tactics/survey/ratings.json`);
/** How strongly the weights stay near the ones now (per rated pair's worth of loss). */
const PULL = Number(opt("pull", "0.3"));
/** How sharply a score difference decides a pair: 20 makes a difference of 0.1 count about as a sure order. */
const SHARP = 20;
const GRADE = { bad: 0, fine: 1, good: 2 };

const now = JSON.parse(readFileSync(WEIGHTS, "utf8"));
const PARTS = ["readability", "interactables", "character"];
const TERMS = PARTS.flatMap((p) => Object.keys(now[p]).map((t) => [p, t]));
const flat = (w) => TERMS.map(([p, t]) => w.parts[p] * w[p][t]);
const nest = (beta) => {
  const out = { parts: {} };
  for (const p of PARTS) {
    const idx = TERMS.map(([q], i) => (q === p ? i : -1)).filter((i) => i >= 0);
    const sum = idx.reduce((s, i) => s + beta[i], 0);
    out.parts[p] = sum;
    out[p] = Object.fromEntries(idx.map((i) => [TERMS[i][1], sum > 0 ? beta[i] / sum : now[p][TERMS[i][1]]]));
  }
  out.penalty = now.penalty;
  return out;
};

let ratings;
try {
  ratings = Object.entries(JSON.parse(readFileSync(ratingsFile, "utf8")));
} catch {
  console.log(`No ratings yet (${ratingsFile}): rate some sites in the gallery first.`);
  process.exit(0);
}
/** The hidden penalty, as apps/tactics/src/survey.ts `hiddenPenalty` takes it off (D-177): not fitted, a board of 8 × 8, 30 % hidden at most. */
const penalty = (hiddenCells = 0) => now.penalty.hidden * (hiddenCells / (0.3 * 64)) ** 2;
const rows = ratings.map(([key, r]) => ({ key, y: GRADE[r.rating], x: TERMS.map(([, t]) => r.terms[t] ?? 0), pen: penalty(r.hiddenCells), tags: r.tags ?? [] }));
const counts = Object.fromEntries(Object.keys(GRADE).map((g) => [g, rows.filter((r) => r.y === GRADE[g]).length]));
console.log(`${rows.length} ratings: ${counts.good} good, ${counts.fine} fine, ${counts.bad} bad (${[...new Set(rows.map((r) => r.key.split(":")[0]))].join(", ")})`);

const pairsOf = (rs) => {
  const out = [];
  for (const a of rs) for (const b of rs) if (a.y > b.y) out.push([a, b]);
  return out;
};
const score = (beta, r) => r.x.reduce((s, v, i) => s + v * beta[i], 0) - r.pen;
/** The share of differently rated pairs the weights order as the ratings do (ties count half). */
const agreement = (beta, pairs) => pairs.reduce((s, [a, b]) => s + (score(beta, a) > score(beta, b) ? 1 : score(beta, a) === score(beta, b) ? 0.5 : 0), 0) / (pairs.length || 1);

/** The closest point of the simplex (non-negative, summing to one). */
function simplex(v) {
  const u = [...v].sort((a, b) => b - a);
  let css = 0;
  let theta = 0;
  for (let i = 0; i < u.length; i++) {
    css += u[i];
    const t = (css - 1) / (i + 1);
    if (u[i] - t > 0) theta = t;
  }
  return v.map((x) => Math.max(0, x - theta));
}

function fit(pairs) {
  const beta0 = flat(now);
  let beta = [...beta0];
  if (!pairs.length) return beta;
  for (let it = 0; it < 600; it++) {
    const grad = beta.map((b, i) => 2 * PULL * (b - beta0[i]));
    for (const [a, b] of pairs) {
      const d = SHARP * (score(beta, a) - score(beta, b));
      const g = -SHARP / (1 + Math.exp(d)) / pairs.length;
      for (let i = 0; i < beta.length; i++) grad[i] += g * (a.x[i] - b.x[i]);
    }
    beta = simplex(beta.map((b, i) => b - 0.05 * grad[i]));
  }
  return beta;
}

const pairs = pairsOf(rows);
if (!pairs.length) {
  console.log("Every rating is the same grade: nothing to order. Rate some sites good and some bad.");
  process.exit(0);
}
const beta = fit(pairs);
// cross-validated: fitted on four fifths of the sites, judged on the pairs within the fifth left out
const folds = 5;
let cvNow = 0;
let cvFit = 0;
let cvN = 0;
for (let f = 0; f < folds; f++) {
  const test = rows.filter((_, i) => i % folds === f);
  const testPairs = pairsOf(test);
  if (!testPairs.length) continue;
  const b = fit(pairsOf(rows.filter((_, i) => i % folds !== f)));
  cvNow += agreement(flat(now), testPairs) * testPairs.length;
  cvFit += agreement(b, testPairs) * testPairs.length;
  cvN += testPairs.length;
}
const pc = (v) => `${Math.round(v * 100)}%`;
console.log(`\nPairs ordered as rated: weights now ${pc(agreement(flat(now), pairs))}, fitted ${pc(agreement(beta, pairs))} (on all ${pairs.length} pairs)`);
if (cvN) console.log(`Held out (${folds}-fold): weights now ${pc(cvNow / cvN)}, fitted ${pc(cvFit / cvN)}`);

const next = nest(beta);
const f2 = (v) => v.toFixed(2);
console.log("\n             now   fitted");
for (const p of PARTS) {
  console.log(`${p.padEnd(13)} ${f2(now.parts[p])}  ${f2(next.parts[p])}`);
  for (const t of Object.keys(now[p])) console.log(`  ${t.padEnd(11)} ${f2(now[p][t])}  ${f2(next[p][t])}`);
}

// what the tags say: the terms furthest from the average among the sites given each
const mean = (rs, i) => rs.reduce((s, r) => s + r.x[i], 0) / (rs.length || 1);
const tags = [...new Set(rows.flatMap((r) => r.tags))];
const notes = tags.flatMap((tag) => {
  const tagged = rows.filter((r) => r.tags.includes(tag));
  if (tagged.length < 3) return [];
  const deltas = TERMS.map(([, t], i) => [t, mean(tagged, i) - mean(rows, i)]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return [`  ${tag} (${tagged.length}): ${deltas
    .slice(0, 3)
    .map(([t, d]) => `${t} ${d > 0 ? "+" : ""}${f2(d)}`)
    .join(", ")}`];
});
if (notes.length) console.log(`\nTags, and the terms that set their sites apart from the rest:\n${notes.join("\n")}`);

if (args.includes("--write")) {
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 1000) / 1000 : round(v)]));
  writeFileSync(WEIGHTS, `${JSON.stringify(round(next), null, 1)}\n`);
  console.log(`\nWrote ${WEIGHTS.replace(REPO, "")}: score the cities again with node tools/survey-sites.mjs`);
}
