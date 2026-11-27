/**
 * The city's front (D-179): an operation over a whole city, shared by every
 * squad defending it. The city's surveyed boards (sites) are grouped into
 * districts; the invaders land at the city's edge and spread from district to
 * district. Each wave opens threats on sites in the districts under most
 * pressure, one more than there are players, and each player takes one and
 * fights it on their own. A block held calms its district; one fought but not
 * held leaves it threatened and costs the city's trust; every district under
 * pressure that nobody fought this wave is pressed harder, and one overrun
 * costs more trust and spreads to a neighbour. The operation is held when
 * the last wave ends with trust left, and lost when trust runs out.
 *
 * Plain JSON, changed in place: a co-op room's server keeps one and sends it
 * to every page after each change; a page playing alone keeps its own. The
 * same calls run it either way (`newFront`, `frontJoined`, `frontAct`, `frontLeft`).
 */

/** A board the front can open a threat on: its middle (world cells), name and survey score. */
export interface FrontSite {
  name: string;
  x: number;
  y: number;
  score: number;
}

export interface District {
  name: string;
  /** Its middle (world cells). */
  x: number;
  y: number;
  /** Its sites (indices into the city's). */
  sites: number[];
  neighbours: number[];
  /** On the city's outer half, where invaders land. */
  edge: boolean;
}

export const CALM = 0;
export const THREATENED = 1;
export const ATTACKED = 2;
export const OVERRUN = 3;
export const PRESSURE = ["calm", "threatened", "under attack", "overrun"] as const;

export interface ThreatResult {
  held: boolean;
  /** People lost. */
  lost: number;
}

export interface Threat {
  id: number;
  district: number;
  site: number;
  /** The player defending it (a joint one's lead). */
  by: string | null;
  result: ThreatResult | null;
  /** The finale for two squads (D-187): the last wave's most pressed threat, in a room of two or more. */
  joint?: boolean;
  /** A joint threat's second squad. */
  with?: string | null;
}

/** Is this a squad's block this wave (its own, or a joint one it joined)? */
const holds = (t: Threat, p: string) => t.by === p || t.with === p;
/** Can a squad still take or join this threat? */
const open = (t: Threat) => !t.result && (!t.by || (t.joint === true && !t.with));

export interface Front {
  districts: District[];
  /** The wave being fought (1-based), of `waves`. */
  wave: number;
  waves: number;
  trust: number;
  /** The most squads that have defended it at once: each past the first brought trust with it. */
  squads: number;
  /** Each district's: CALM to OVERRUN. */
  pressure: number[];
  threats: Threat[];
  /** Sites fought or given up on: not offered again. */
  spent: number[];
  /** The level's objects brought down in every fight so far: each page takes them out of its world. */
  razed: number[];
  /** The squads sitting this wave out (D-182). */
  passed: string[];
  /** What the last wave's end did, a line each. */
  news: string[];
  over: "held" | "lost" | null;
  /** The next threat's id. */
  next: number;
  rand: number;
}

export type FrontMessage =
  | { k: "claim"; threat: number }
  /** No fight could be made on its site (`site`, when given: refused if the threat has moved since): another in the district instead. */
  | { k: "swap"; threat: number; site?: number }
  | { k: "report"; threat: number; held: boolean; lost: number; razed: number[] }
  /** The squad sits this wave out (D-182): it takes no block, and the wave needn't wait for it. */
  | { k: "pass" }
  /** A joint threat's lead fights it alone, nobody left to join (D-187). */
  | { k: "alone"; threat: number };

/** The front's tuning (D-179). */
export const FRONT = {
  waves: 4,
  trust: 7,
  /** Trust lost for a block fought and not held, and for a district overrun. */
  lostCost: 1,
  overrunCost: 2,
  /** Trust each squad past the first brings: more squads fight more blocks a wave, and lose more. */
  perSquad: 2,
  /** Sites a district, roughly; at least 3 districts and at most 10. */
  perDistrict: 12,
  /** How much likelier a site is than one scoring 0.05 less: e (as the operation's draw, D-178). */
  temperature: 0.05,
};

const random = (f: Front) => (f.rand = (Math.imul(f.rand, 1664525) + 1013904223) >>> 0) / 4294967296;
const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const PLACE = /\b(?:near|by) (.+)$/i;
const COMPASS = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"];

/**
 * The city's sites in districts: k-means from the sites farthest apart, so the
 * same sites always make the same districts; each named for the place its
 * sites are most often named after ("Towers near SoHo"), else its best site,
 * with a compass point where two would share a name (and a number where that's not enough); neighbours are each
 * district's three nearest, both ways.
 */
export function districtsOf(sites: readonly FrontSite[], count = Math.min(10, Math.max(3, Math.round(sites.length / FRONT.perDistrict)))): District[] {
  if (!sites.length) return [];
  const mid = { x: sites.reduce((s, p) => s + p.x, 0) / sites.length, y: sites.reduce((s, p) => s + p.y, 0) / sites.length };
  let centres = [sites.reduce((a, b) => (d2(b, mid) > d2(a, mid) ? b : a))].map((s) => ({ x: s.x, y: s.y }));
  while (centres.length < Math.min(count, sites.length)) {
    const far = sites.reduce((a, b) => (Math.min(...centres.map((c) => d2(b, c))) > Math.min(...centres.map((c) => d2(a, c))) ? b : a));
    centres.push({ x: far.x, y: far.y });
  }
  let of: number[] = [];
  for (let it = 0; it < 16; it++) {
    of = sites.map((s) => centres.reduce((best, c, j) => (d2(s, c) < d2(s, centres[best]!) ? j : best), 0));
    centres = centres.map((c, j) => {
      const mine = sites.filter((_, i) => of[i] === j);
      return mine.length ? { x: mine.reduce((s, p) => s + p.x, 0) / mine.length, y: mine.reduce((s, p) => s + p.y, 0) / mine.length } : c;
    });
  }
  const groups = centres.map((c, j) => ({ ...c, sites: sites.flatMap((_, i) => (of[i] === j ? [i] : [])) })).filter((g) => g.sites.length);
  const far = groups.map((g) => d2(g, mid)).sort((a, b) => a - b);
  const districts: District[] = groups.map((g) => {
    const counts = new Map<string, number>();
    for (const i of g.sites) {
      const place = PLACE.exec(sites[i]!.name)?.[1];
      if (place) counts.set(place, (counts.get(place) ?? 0) + 1);
    }
    const best = g.sites.reduce((a, b) => (sites[b]!.score > sites[a]!.score ? b : a));
    const name = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? sites[best]!.name;
    return { name, x: g.x, y: g.y, sites: g.sites, neighbours: [], edge: d2(g, mid) >= far[Math.floor(far.length / 2)]! };
  });
  const shared = districts.filter((d) => districts.filter((o) => o.name === d.name).length > 1);
  for (const d of shared) {
    const a = Math.round((Math.atan2(d.y - mid.y, d.x - mid.x) / (2 * Math.PI)) * 8 + 8) % 8;
    d.name = `${d.name}, ${COMPASS[a]}`;
  }
  districts.forEach((d, j) => {
    const before = districts.slice(0, j).filter((o) => o.name === d.name || o.name.startsWith(`${d.name} (`)).length;
    if (before) d.name = `${d.name} (${before + 1})`;
  });
  districts.forEach((d, j) => {
    const near = districts
      .map((o, k) => ({ k, far: d2(d, o) }))
      .filter((o) => o.k !== j)
      .sort((a, b) => a.far - b.far)
      .slice(0, 3);
    for (const { k } of near) {
      if (!d.neighbours.includes(k)) d.neighbours.push(k);
      if (!districts[k]!.neighbours.includes(j)) districts[k]!.neighbours.push(j);
    }
  });
  return districts;
}

/** A front over a city's sites: the invaders landing at `players + 1` districts on its edge, the first wave's threats open. */
export function newFront(sites: readonly FrontSite[], opts: { seed: number; players?: number; waves?: number; trust?: number }): Front {
  const districts = districtsOf(sites);
  const f: Front = {
    districts,
    wave: 1,
    waves: opts.waves ?? FRONT.waves,
    trust: (opts.trust ?? FRONT.trust) + FRONT.perSquad * ((opts.players ?? 1) - 1),
    squads: opts.players ?? 1,
    pressure: districts.map(() => CALM),
    threats: [],
    spent: [],
    razed: [],
    passed: [],
    news: [],
    over: null,
    next: 1,
    rand: opts.seed >>> 0 || 1,
  };
  land(f, (opts.players ?? 1) + 1);
  offer(f, sites, (opts.players ?? 1) + 1);
  return f;
}

/** Invaders land at calm districts on the city's edge (any calm one when the edge is taken), but not where a squad just fought. */
function land(f: Front, n: number, rest: ReadonlySet<number> = new Set()): string[] {
  const landed: string[] = [];
  for (let i = 0; i < n; i++) {
    const calm = f.districts.flatMap((_, j) => (f.pressure[j] === CALM && !rest.has(j) ? [j] : []));
    const edge = calm.filter((j) => f.districts[j]!.edge);
    const from = edge.length ? edge : calm;
    if (!from.length) break;
    const j = from[Math.floor(random(f) * from.length)]!;
    f.pressure[j] = THREATENED;
    landed.push(f.districts[j]!.name);
  }
  return landed;
}

/** A site in a district not yet spent, likelier the better it scores (the last wave's, the best: a finale), or -1. */
const freeSites = (f: Front, d: number) => f.districts[d]!.sites.filter((i) => !f.spent.includes(i) && !f.threats.some((t) => t.site === i));

function drawSite(f: Front, sites: readonly FrontSite[], d: number): number {
  const free = freeSites(f, d);
  if (!free.length) return -1;
  const temperature = f.wave === f.waves ? 0.005 : FRONT.temperature;
  const top = Math.max(...free.map((i) => sites[i]!.score));
  const weights = free.map((i) => Math.exp((sites[i]!.score - top) / temperature));
  let r = random(f) * weights.reduce((p, q) => p + q, 0);
  for (let k = 0; k < free.length; k++) if ((r -= weights[k]!) < 0) return free[k]!;
  return free[free.length - 1]!;
}

/**
 * Threats opened up to `want` this wave: in the districts most pressed first,
 * then calm ones beside them, then any; one a district. In the last wave with
 * two squads or more, the most pressed one not taken is the finale, for two
 * (D-187).
 */
function offer(f: Front, sites: readonly FrontSite[], want: number): void {
  openThreats(f, sites, want);
  if (f.wave === f.waves && want >= 3 && !f.threats.some((t) => t.joint !== undefined)) {
    const t = f.threats.find((x) => !x.by);
    if (t) Object.assign(t, { joint: true, with: null });
  }
}

function openThreats(f: Front, sites: readonly FrontSite[], want: number): void {
  const all = f.districts.map((_, j) => j);
  while (f.threats.length < want) {
    const open = all.filter((j) => f.pressure[j]! < OVERRUN && !f.threats.some((t) => t.district === j) && freeSites(f, j).length > 0);
    const pressed = open.filter((j) => f.pressure[j]! > CALM);
    const beside = open.filter((j) => f.districts[j]!.neighbours.some((n) => f.pressure[n]! > CALM));
    const from = pressed.length ? pressed : beside.length ? beside : open;
    if (!from.length) return;
    const top = Math.max(...from.map((j) => f.pressure[j]!));
    const most = from.filter((j) => f.pressure[j] === top);
    const d = most[Math.floor(random(f) * most.length)]!;
    f.threats.push({ id: f.next++, district: d, site: drawSite(f, sites, d), by: null, result: null });
    if (f.pressure[d] === CALM) f.pressure[d] = THREATENED;
  }
}

/** Every claimed threat fought, and every player has fought one, sat the wave out, or has none left to take. */
export function waveDone(f: Front, players: readonly string[]): boolean {
  if (!players.length || f.threats.some((t) => t.by && !t.result)) return false;
  const free = f.threats.some(open);
  return players.every((p) => f.threats.some((t) => holds(t, p)) || f.passed.includes(p) || !free);
}

/** The players the wave waits on to choose: neither a block taken nor sat out, while a block is left to take (D-182). */
export function choosing(f: Front, players: readonly string[]): string[] {
  if (f.over || !f.threats.some(open)) return [];
  return players.filter((p) => !f.passed.includes(p) && !f.threats.some((t) => holds(t, p)));
}

/** The wave's end: districts calmed, pressed and overrun, trust spent, invaders landing anew; then the next wave, or the end. */
function closeWave(f: Front, sites: readonly FrontSite[], players: readonly string[]): void {
  const news: string[] = [];
  const name = (d: number) => f.districts[d]!.name;
  const fought = new Set<number>();
  for (const t of f.threats) {
    if (!t.result) continue;
    fought.add(t.district);
    if (t.result.held) {
      f.pressure[t.district] = CALM;
      news.push(`${name(t.district)} held: calm again.`);
    } else {
      f.pressure[t.district] = THREATENED;
      f.trust -= FRONT.lostCost;
      news.push(`${name(t.district)} fought, ${Math.round(t.result.lost)} people lost: still threatened (trust −${FRONT.lostCost}).`);
    }
  }
  const overrun: number[] = [];
  f.pressure.forEach((p, d) => {
    if (fought.has(d) || p === CALM || p === OVERRUN) return;
    f.pressure[d] = p + 1;
    if (p + 1 === OVERRUN) overrun.push(d);
    else news.push(`${name(d)} left alone: now ${PRESSURE[p + 1]}.`);
  });
  for (const d of overrun) {
    f.trust -= FRONT.overrunCost;
    // it spreads to one calm neighbour
    const calm = f.districts[d]!.neighbours.filter((n) => f.pressure[n] === CALM && !fought.has(n));
    const n = calm.length ? calm[Math.floor(random(f) * calm.length)]! : -1;
    if (n >= 0) f.pressure[n] = THREATENED;
    news.push(`${name(d)} overrun (trust −${FRONT.overrunCost})${n >= 0 ? `; it spreads to ${name(n)}` : ""}.`);
  }
  f.threats = [];
  f.passed = [];
  if (f.trust <= 0) {
    f.trust = 0;
    f.over = "lost";
    news.push("The city has lost its trust in the squads: the operation is lost.");
  } else if (f.wave >= f.waves) {
    f.over = "held";
    news.push(`The last wave is over with trust left: the city is held.`);
  } else {
    f.wave++;
    const landed = land(f, Math.max(1, players.length), fought);
    if (landed.length) news.push(`Invaders land at ${landed.join(", ")}.`);
    offer(f, sites, players.length + 1);
    if (!f.threats.length) {
      f.over = "held";
      news.push("Nowhere left to fight: the city is held.");
    }
  }
  f.news = news.map((n) => n[0]!.toUpperCase() + n.slice(1));
}

function settle(f: Front, sites: readonly FrontSite[], players: readonly string[]): void {
  if (!f.over && waveDone(f, players)) closeWave(f, sites, players);
}

/** Someone joined: the wave's threats topped up to one more than there are players, and the city's trust for a squad more than ever before. */
export function frontJoined(f: Front, sites: readonly FrontSite[], players: readonly string[]): void {
  if (f.over) return;
  if (players.length > f.squads) {
    f.trust += FRONT.perSquad * (players.length - f.squads);
    f.squads = players.length;
  }
  offer(f, sites, players.length + 1);
}

/** Someone left (`players` without them): the threat they took and hadn't fought let go, and the wave closed if only they were awaited. */
export function frontLeft(f: Front, sites: readonly FrontSite[], players: readonly string[], id: string): void {
  for (const t of f.threats) {
    if (t.result) continue;
    if (t.with === id) t.with = null;
    // a joint threat's lead gone: its second squad leads
    if (t.by === id) {
      t.by = t.with ?? null;
      if (t.joint) t.with = null;
    }
  }
  settle(f, sites, players);
}

/** A player's message carried out: null, or why it couldn't be. */
export function frontAct(f: Front, sites: readonly FrontSite[], players: readonly string[], by: string, m: FrontMessage): string | null {
  if (f.over) return "the operation is over";
  if (m.k === "pass") {
    if (f.threats.some((o) => holds(o, by))) return "your squad has its block this wave";
    if (!f.passed.includes(by)) f.passed.push(by);
    settle(f, sites, players);
    return null;
  }
  const t = f.threats.find((o) => o.id === m.threat);
  if (!t) return "that threat is gone";
  if (m.k === "claim") {
    if (f.threats.some((o) => holds(o, by))) return "your squad has its block this wave";
    if (f.passed.includes(by)) return "your squad sits this wave out";
    if (!open(t)) return "another squad is on it";
    if (t.by) t.with = by;
    else t.by = by;
    return null;
  }
  if (m.k === "alone") {
    if (!t.joint || t.by !== by || t.with || t.result) return "that finale isn't yours to fight alone";
    t.joint = false;
    return null;
  }
  // a threat nobody has taken may be swapped too: no fight could be made on its block, made ahead (D-185)
  if ((t.by !== by && !(m.k === "swap" && !t.by)) || t.result) return "that block isn't yours to fight";
  if (m.k === "swap") {
    // two pages that made no fight on it, or one behind the room: swapped once
    if (m.site !== undefined && m.site !== t.site) return "that threat has moved";
    f.spent.push(t.site);
    const s = drawSite(f, sites, t.district);
    if (s >= 0) t.site = s;
    else {
      f.threats.splice(f.threats.indexOf(t), 1);
      offer(f, sites, players.length + 1);
    }
    settle(f, sites, players);
    return null;
  }
  t.result = { held: m.held, lost: m.lost };
  f.spent.push(t.site);
  for (const o of m.razed) if (!f.razed.includes(o)) f.razed.push(o);
  settle(f, sites, players);
  return null;
}

/** A message from a page, checked (a server takes them from anyone): null when it isn't one. */
export function frontMessage(m: unknown): FrontMessage | null {
  const o = m as Record<string, unknown> | null;
  if (o && typeof o === "object" && o.k === "pass") return { k: "pass" };
  if (!o || typeof o !== "object" || !Number.isInteger(o.threat)) return null;
  const threat = o.threat as number;
  if (o.k === "swap") return Number.isInteger(o.site) ? { k: "swap", threat, site: o.site as number } : { k: "swap", threat };
  if (o.k === "claim" || o.k === "alone") return { k: o.k, threat };
  if (o.k !== "report" || typeof o.held !== "boolean" || typeof o.lost !== "number" || !Number.isFinite(o.lost)) return null;
  const razed = Array.isArray(o.razed) ? o.razed.filter((x): x is number => Number.isInteger(x) && x >= 0).slice(0, 400) : [];
  return { k: "report", threat, held: o.held, lost: Math.max(0, o.lost), razed };
}
