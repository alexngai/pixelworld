import { BONUS_REPUTATION, FIGHTERS, SQUADS, WEAPONS, WEAPON_IDS, armed, loadoutOf, type Armed, type FighterKind, type Loadout, type Squad, type WeaponId } from "@pixelworlds/tactics";
import type { Front } from "@pixelworlds/tactics";
import { weaponShort, weaponWhat } from "./fight";
import type { Block } from "./sites";

/**
 * Runs and what they unlock (D-172), after Into the Breach: an operation (a
 * city's blocks) is a run, played with a preset squad. Each block held earns
 * reputation, a perfect one a core too; between blocks a depot sells weapons
 * for a rig's empty slot and cores, and a core powers one of a weapon's
 * upgrades. What every run has done is kept in the browser, and unlocks
 * squads.
 */

export interface Profile {
  /** Blocks held over every run, cities held to their last wave (D-179), runs begun. */
  blocksHeld: number;
  operationsHeld: number;
  runs: number;
}

const KEY = "pixelworld.tactics.profile";
const FRESH: Profile = { blocksHeld: 0, operationsHeld: 0, runs: 0 };

export function loadProfile(): Profile {
  try {
    return { ...FRESH, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Profile>) };
  } catch {
    return { ...FRESH };
  }
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // private browsing, storage full: the run's unlocks just aren't kept
  }
}

export const isUnlocked = (p: Profile, s: Squad) => !s.unlock || (p.blocksHeld >= (s.unlock.blocksHeld ?? 0) && p.operationsHeld >= (s.unlock.operationsHeld ?? 0));

const unlockText = (s: Squad) =>
  s.unlock?.operationsHeld ? `Hold a city to its last wave to unlock.` : s.unlock?.blocksHeld ? `Hold ${s.unlock.blocksHeld} blocks to unlock.` : "";

export interface RunRig {
  kind: FighterKind;
  slots: [Armed | null, Armed | null];
}

export interface Run {
  squad: Squad;
  rigs: RunRig[];
  reputation: number;
  cores: number;
  /** Weapons bought and not in a slot. */
  store: Armed[];
}

/** A core's price in a depot (reputation). */
export const CORE_COST = 3;

export function newRun(squad: Squad): Run {
  const arm = (id: WeaponId | null): Armed | null => (id ? { id, ups: [] } : null);
  return { squad, rigs: squad.rigs.map((r) => ({ kind: r.kind, slots: [arm(r.slots[0]), arm(r.slots[1])] })), reputation: 0, cores: 1, store: [] };
}

/** The squad as the rules take it, a weapon's powered upgrades marked on its name (◆ each). */
export function loadouts(run: Run): Loadout[] {
  return run.rigs.map((r) => {
    const l = loadoutOf(r.kind, r.slots);
    const marks = r.slots.flatMap((s) => (s ? [s.ups.length] : []));
    return { kind: l.kind, arms: l.arms.map((w, i) => (marks[i] ? { ...w, name: `${w.name} ${"◆".repeat(marks[i]!)}` } : w)) };
  });
}

/** What a block pays: a point of reputation a round held without loss, two more for the block held; a core when every round was. */
export function reward(o: { held: boolean; roundsHeld: number; rounds: number; bonuses?: readonly { met: boolean }[] }): { reputation: number; cores: number } {
  const bonuses = o.held ? (o.bonuses ?? []).filter((b) => b.met).length : 0;
  return { reputation: o.roundsHeld + (o.held ? 2 : 0) + BONUS_REPUTATION * bonuses, cores: o.held && o.roundsHeld === o.rounds ? 1 : 0 };
}

/** Pick a squad among those unlocked; the locked ones shown with what unlocks them. */
export function pickSquad(ui: HTMLElement, profile: Profile): Promise<Squad> {
  const el = document.createElement("div");
  el.className = "screen";
  const rig = (r: Squad["rigs"][number]) =>
    `<div class="rig"><b>${FIGHTERS[r.kind].name}</b>${r.slots
      .flatMap((id) => (id ? [WEAPONS[id].weapon] : []))
      .map((w) => `<span title="${w.name}: ${weaponWhat(w)}">${w.name} <small>${weaponShort(w)}</small></span>`)
      .join("")}</div>`;
  el.innerHTML = `<div class="box wide">
    <h2>Choose a squad</h2>
    <div class="squads">${SQUADS.map((s, i) => {
      const open = isUnlocked(profile, s);
      return `<button class="squad-card" data-squad="${i}" ${open ? "" : "disabled"}>
        <b>${s.name}</b><span>${s.about}</span>
        <div class="rigs">${s.rigs.map(rig).join("")}</div>
        ${open ? "" : `<em>${unlockText(s)}</em>`}
      </button>`;
    }).join("")}</div>
    <p class="dim">Blocks held: ${profile.blocksHeld} · operations held: ${profile.operationsHeld} · runs: ${profile.runs}</p>
  </div>`;
  ui.append(el);
  return new Promise((done) =>
    el.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-squad]");
      if (!b || b.disabled) return;
      el.remove();
      done(SQUADS[Number(b.dataset.squad)]!);
    }),
  );
}

/**
 * The depot between blocks: what the last block paid, weapons for sale (three
 * the squad hasn't got), a core; the rigs' slots, where a weapon held (from
 * the store or a slot) goes, swapping with what's there; and each weapon's
 * upgrades, a core each. Resolves when the squad moves on.
 */
export function depot(ui: HTMLElement, run: Run, title: string, paid: string, seed: number, go = "On to the next block"): Promise<void> {
  const owned = new Set([...run.rigs.flatMap((r) => r.slots.flatMap((s) => (s ? [s.id] : []))), ...run.store.map((s) => s.id)]);
  let r = seed >>> 0 || 1;
  const rand = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
  const offers = WEAPON_IDS.filter((id) => !owned.has(id))
    .map((id) => ({ id, k: rand() }))
    .sort((p, q) => p.k - q.k)
    .slice(0, 3)
    .map((x) => x.id);
  // the weapon in hand: a slot's (rig, slot) or the store's (−1, index)
  let held: [number, number] | null = null;
  const el = document.createElement("div");
  el.className = "screen depot";
  const card = (a: Armed, where: string, extra = "") => {
    const def = WEAPONS[a.id];
    const w = armed(a);
    const ups = def.upgrades
      .map((u, i) =>
        a.ups.includes(i)
          ? `<span class="up on">◆ ${u.name}</span>`
          : `<button class="up" data-up="${where}:${i}" ${run.cores > 0 ? "" : "disabled"} title="Power with a core">◇ ${u.name}</button>`,
      )
      .join("");
    return `<div class="weapon-card${extra}" data-hold="${where}" title="${def.about}"><b>${def.weapon.name}</b><small>${weaponShort(w)}</small><div class="ups">${ups}</div></div>`;
  };
  const draw = () => {
    el.innerHTML = `<div class="box wide">
      <h2>${title}: the depot</h2>
      <p>${paid}</p>
      <p class="wallet">Reputation <b>★ ${run.reputation}</b> · cores <b>◆ ${run.cores}</b></p>
      <div class="hangar">${run.rigs
        .map(
          (rig, ri) => `<div class="rig"><b>${FIGHTERS[rig.kind].name}</b>${rig.slots
            .map((s, si) => {
              const at = `${ri}.${si}`;
              const sel = held && held[0] === ri && held[1] === si ? " held" : "";
              return s ? card(s, at, sel) : `<div class="weapon-card empty${held ? " target" : ""}" data-hold="${at}">empty slot</div>`;
            })
            .join("")}</div>`,
        )
        .join("")}</div>
      <h3>In store</h3>
      <div class="store${held && held[0] >= 0 ? " target" : ""}" data-hold="-1.${run.store.length}">${run.store.length ? run.store.map((s, i) => card(s, `-1.${i}`, held && held[0] === -1 && held[1] === i ? " held" : "")).join("") : `<span class="dim">Nothing: weapons bought wait here till they go in a slot.</span>`}</div>
      <h3>For sale</h3>
      <div class="sale">${offers
        .map((id) => {
          const def = WEAPONS[id];
          return `<div class="weapon-card" title="${def.about}"><b>${def.weapon.name}</b><small>${weaponShort(def.weapon)}</small><button data-buy="${id}" ${run.reputation >= def.cost ? "" : "disabled"}>Buy ★ ${def.cost}</button></div>`;
        })
        .join("")}<div class="weapon-card"><b>Core</b><small>powers an upgrade</small><button data-core ${run.reputation >= CORE_COST ? "" : "disabled"}>Buy ★ ${CORE_COST}</button></div></div>
      <p class="dim">Click a weapon to take it, then a slot to put it in (or the store). Every rig can evacuate besides.</p>
      <button data-go>${go}</button>
    </div>`;
  };
  const slotAt = (where: string): { get(): Armed | null; set(a: Armed | null): void } => {
    const [a, b] = where.split(".").map(Number) as [number, number];
    if (a < 0) return { get: () => run.store[b] ?? null, set: (x) => (x ? (run.store[b] = x) : run.store.splice(b, 1)) };
    const rig = run.rigs[a]!;
    return { get: () => rig.slots[b]!, set: (x) => (rig.slots[b] = x) };
  };
  draw();
  ui.append(el);
  return new Promise((done) =>
    el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const buy = t.closest<HTMLElement>("[data-buy]")?.dataset.buy as WeaponId | undefined;
      const up = t.closest<HTMLElement>("[data-up]")?.dataset.up;
      const hold = t.closest<HTMLElement>("[data-hold]")?.dataset.hold;
      if (t.closest("[data-go]")) {
        el.remove();
        return done();
      }
      if (buy) {
        run.reputation -= WEAPONS[buy].cost;
        run.store.push({ id: buy, ups: [] });
        offers.splice(offers.indexOf(buy), 1);
      } else if (t.closest("[data-core]")) {
        run.reputation -= CORE_COST;
        run.cores++;
      } else if (up) {
        const [where, i] = [up.slice(0, up.lastIndexOf(":")), Number(up.slice(up.lastIndexOf(":") + 1))];
        const a = slotAt(where).get();
        if (a && run.cores > 0) {
          a.ups.push(i);
          run.cores--;
        }
      } else if (hold) {
        if (!held) {
          if (slotAt(hold).get()) held = hold.split(".").map(Number) as [number, number];
        } else {
          const from = slotAt(held.join("."));
          const to = slotAt(hold);
          const [a, b] = [from.get(), to.get()];
          if (held[0] >= 0 && hold.startsWith("-1")) {
            // a slot's weapon back to the store
            if (a) run.store.push(a);
            from.set(null);
          } else if (held[0] < 0 && hold.startsWith("-1")) {
            // store to store: nothing
          } else if (held[0] < 0) {
            // from the store into a slot, what was there back to the store
            const i = held[1];
            to.set(a);
            run.store.splice(i, 1);
            if (b) run.store.push(b);
          } else {
            // slot to slot: swapped
            to.set(a);
            from.set(b);
          }
          held = null;
        }
      } else return;
      draw();
    }),
  );
}

/**
 * A run kept across reloads (D-188): its city and room (null alone), the
 * squad, its rigs and wallet, the blocks fought, and alone the city's front
 * (a room keeps its own). One at a time: a new run overwrites it, and the end
 * of a run clears it.
 */
export interface SavedRun {
  world: string;
  /** Boards in the city's pool when it was saved: a front's sites are places in it, so another pool can't resume it. */
  boards: number;
  room: string | null;
  squad: string;
  name: string;
  rigs: RunRig[];
  reputation: number;
  cores: number;
  store: Armed[];
  played: { site: Block; outcome: { held: boolean; lost: number } | null; where?: string }[];
  front?: Front;
}

const SAVE = "pixelworld.tactics.run";

export function saveRun(s: SavedRun | null): void {
  try {
    if (s) localStorage.setItem(SAVE, JSON.stringify(s));
    else localStorage.removeItem(SAVE);
  } catch {
    // no storage: the run isn't kept
  }
}

export function loadRun(): SavedRun | null {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE) ?? "null") as SavedRun | null;
    return s && typeof s.world === "string" && Array.isArray(s.rigs) && Array.isArray(s.played) ? s : null;
  } catch {
    return null;
  }
}

