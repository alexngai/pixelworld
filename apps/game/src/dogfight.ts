import type { Entity } from "@pixelworlds/engine";
import { RemotePlayers, joinRoom, type Pose, type Room } from "@pixelworlds/multiplayer";
import type { Game } from "./game";
import { axes } from "./plane";
import { PLANE } from "./tuning";

/**
 * The dogfight (D-112): planes over the Grand Canyon, one per window, through
 * `@pixelworlds/multiplayer`'s relay. Relay-first: each window flies its own
 * plane and says where it is 20 times a second; a shooter judges its own hits
 * against the others as it draws them and tells the one it hit, which takes
 * the damage. A crash soon after a hit counts for the shooter.
 *
 * `?dogfight=<room>` (`&name=`): the flying level at the canyon, guns on Space.
 */

/** Where the planes start: over the inner canyon, between the village and Phantom Ranch. */
export const DOGFIGHT_START = { lon: -112.11, lat: 36.08 };

const SEND_EVERY_MS = 50;
const HP = 100;
const GUN = {
  /** Seconds between rounds while Space is held. */
  interval: 0.09,
  /** Muzzle speed over the plane's (× cruise at the level's pace). */
  muzzle: 2.5,
  /** Seconds a round flies. */
  life: 1.1,
  damage: 10,
  /** Rounds aim themselves at a plane within this angle of the nose (rad): aiming in depth is hard in an isometric view. */
  assist: 0.2,
  /** A round hits within this many plane lengths of a plane's middle. */
  reach: 0.8,
};
/** A crash within this many seconds of being hit counts as shot down. */
const CREDIT_S = 6;
/** Respawns land within this many cells of the start. */
const SPAWN_SPREAD = 8;

type Msg =
  | { k: "s"; t: number; name: string; x: number; y: number; h: number; hd: number; p: number; r: number; hp: number; kills: number; deaths: number; jump?: boolean }
  | { k: "f"; x: number; y: number; h: number; vx: number; vy: number; vh: number }
  | { k: "hit"; to: string; dmg: number }
  | { k: "down"; by: string | null };

interface Round {
  x: number;
  y: number;
  h: number;
  /** Cells/s across, steps/s up. */
  vx: number;
  vy: number;
  vh: number;
  life: number;
  mine: boolean;
  e: Entity;
}

interface Peer {
  name: string;
  hp: number;
  kills: number;
  deaths: number;
  tag: HTMLElement;
  shadow: Entity | null;
}

/** The closest a segment from a to b passes to p (3D). */
function passes(a: [number, number, number], b: [number, number, number], p: [number, number, number]): number {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = d[0]! ** 2 + d[1]! ** 2 + d[2]! ** 2;
  const f = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0]! + (p[1] - a[1]) * d[1]! + (p[2] - a[2]) * d[2]!) / len2)) : 0;
  return Math.hypot(a[0] + d[0]! * f - p[0], a[1] + d[1]! * f - p[1], a[2] + d[2]! * f - p[2]);
}

export async function startDogfight(game: Game, opts: { room: string; name?: string | null; relay?: string }): Promise<void> {
  const plane = game.plane;
  if (!plane) throw new Error("the dogfight starts in the air");
  game.stay = true;
  const view = game.view;
  const hud = game.hud;
  let room: Room;
  try {
    room = await joinRoom(opts.relay ?? "/relay", opts.room);
  } catch (e) {
    hud?.say(`Dogfight: ${e instanceof Error ? e.message : String(e)} · flying alone`, 6);
    return;
  }
  const me = { name: (opts.name || `Pilot ${room.id}`).slice(0, 20), hp: HP, kills: 0, deaths: 0 };
  const w = view.world;
  const size = { length: PLANE.voxels.length * w.renderScale, width: PLANE.voxels.width * w.renderScale, height: PLANE.voxels.height * w.renderScale };
  const model = (id: string) => ({ group: PLANE.group, seed: 1 + (Number(id) % 4), size });
  const remotes = new RemotePlayers(view.entities, (id) => ({ model: model(id), headings: PLANE.headings, silhouette: true }));
  const peers = new Map<string, Peer>();
  const pal = w.palette.rampIds;
  // the style's ramps where it has them (the desert's): pale tracers, fire, smoke
  const ramp = (...names: string[]) => names.map((n) => pal.get(n)).find((r) => r !== undefined) ?? 0;
  const tracer = ramp("marking", "tower-gold", "marker");
  const flame = ramp("marker", "roof-tile");
  const gold = ramp("tower-gold", "marking", "marker");
  const smoke = ramp("basalt", "asphalt");
  const roundModel = { boxes: [{ x0: -0.1, y0: -0.1, z0: 0, x1: 0.1, y1: 0.1, z1: 0.5, ramp: tracer }], key: "dogfight.round" };
  const puffModel = {
    boxes: [
      { x0: -0.4, y0: -0.3, z0: 0, x1: 0.3, y1: 0.4, z1: 1.2, ramp: flame },
      { x0: -0.15, y0: -0.15, z0: 0.3, x1: 0.45, y1: 0.15, z1: 1.6, ramp: gold },
      { x0: -0.3, y0: -0.45, z0: 1.2, x1: 0.25, y1: 0.05, z1: 2.4, ramp: smoke },
    ],
    key: "dogfight.puff",
  };
  // hidden ones keep the models' sprites baked while none fly
  for (const m of [roundModel, puffModel]) view.entities.add({ model: m, x: plane.state.x, y: plane.state.y, headings: 1, visible: false, wait: false });
  const rounds: Round[] = [];
  const puffs: { e: Entity; life: number }[] = [];
  let firing = false;
  let cooldown = 0;
  let jump = false;
  let lastHit: { by: string; at: number } | null = null;
  let crashes = plane.crashes;

  // ---------------------------------------------------------------- the page

  const board = document.createElement("div");
  Object.assign(board.style, {
    position: "fixed",
    left: "8px",
    bottom: "46px", // over the mode buttons
    padding: "6px 10px",
    background: "rgba(20, 19, 32, 0.8)",
    borderRadius: "4px",
    whiteSpace: "pre",
    pointerEvents: "none",
  });
  document.body.append(board);
  const tagFor = () => {
    const tag = document.createElement("div");
    tag.className = "label";
    tag.style.color = "#ffb38a";
    document.body.append(tag);
    return tag;
  };
  const nameOf = (id: string | null) => (id === room.id ? "you" : (id && peers.get(id)?.name) || "someone");
  const now = () => performance.now() / 1000;

  // ---------------------------------------------------------------- the room

  const send = (m: Msg) => room.send(m);
  const shout = setInterval(() => {
    const e = plane.entity;
    const s = plane.state;
    send({ k: "s", t: now(), x: s.x, y: s.y, h: s.h, hd: e.heading, p: e.pitch, r: e.roll, ...me, ...(jump ? { jump } : {}) });
    jump = false;
  }, SEND_EVERY_MS);

  const peerFor = (id: string): Peer => {
    let p = peers.get(id);
    if (!p) peers.set(id, (p = { name: `Pilot ${id}`, hp: HP, kills: 0, deaths: 0, tag: tagFor(), shadow: null }));
    return p;
  };
  const puff = (x: number, y: number, h: number) => puffs.push({ e: view.entities.add({ model: puffModel, x, y, h, headings: 1, wait: false }), life: 0.7 });
  const addRound = (r: Omit<Round, "e" | "life">) =>
    rounds.push({ ...r, life: GUN.life, e: view.entities.add({ model: roundModel, x: r.x, y: r.y, h: r.h, headings: 1, wait: false }) });

  room.onMessage = (from, data) => {
    const m = data as Msg;
    if (m.k === "s") {
      const p = peerFor(from);
      Object.assign(p, { name: String(m.name).slice(0, 20), hp: m.hp, kills: m.kills, deaths: m.deaths });
      remotes.push(from, m.t, { x: m.x, y: m.y, h: m.h, heading: m.hd, pitch: m.p, roll: m.r }, m.jump ?? false);
    } else if (m.k === "f") addRound({ x: m.x, y: m.y, h: m.h, vx: m.vx, vy: m.vy, vh: m.vh, mine: false });
    else if (m.k === "hit" && m.to === room.id) {
      me.hp -= m.dmg;
      lastHit = { by: from, at: now() };
      if (me.hp <= 0) down(from);
    } else if (m.k === "down") {
      const at = remotes.pose(from);
      if (at) puff(at.x, at.y, at.h);
      if (m.by === room.id) me.kills++;
      hud?.say(m.by === room.id ? `You shot down ${nameOf(from)}` : m.by ? `${nameOf(m.by)} shot down ${nameOf(from)}` : `${nameOf(from)} crashed`, 2.5);
    }
  };
  room.onLeave = (id) => {
    const p = peers.get(id);
    p?.tag.remove();
    p?.shadow?.remove();
    peers.delete(id);
    remotes.remove(id);
    hud?.say(`${p?.name ?? "A pilot"} left`, 2);
  };
  room.onClose = () => {
    clearInterval(shout);
    hud?.say("Dogfight: the relay went away · flying alone", 6);
  };

  // ---------------------------------------------------------------- dying and coming back

  async function respawn(): Promise<void> {
    const c = view.query.lonLatToCell(DOGFIGHT_START.lon, DOGFIGHT_START.lat) ?? [plane!.state.x, plane!.state.y];
    const a = Math.random() * 2 * Math.PI;
    const x = c[0] + Math.cos(a) * SPAWN_SPREAD * Math.random();
    const y = c[1] + Math.sin(a) * SPAWN_SPREAD * Math.random();
    await view.query.ensure(x - 6, y - 6, x + 6, y + 6);
    plane!.place(x, y, Math.random() * 2 * Math.PI);
    plane!.safeReset(); // clear of the walls around
    crashes = plane!.crashes;
    jump = true;
  }

  function down(by: string | null): void {
    const s = plane!.state;
    puff(s.x, s.y, s.h);
    me.deaths++;
    me.hp = HP;
    lastHit = null;
    send({ k: "down", by });
    hud?.say(by ? `Shot down by ${nameOf(by)}` : "You crashed", 2.5);
    void respawn();
  }

  // ---------------------------------------------------------------- guns

  function fire(): void {
    const s = plane!.state;
    const { f } = axes(s.yaw, s.pitch, s.roll);
    const k = PLANE.stepsPerCell;
    const reach = (s.speed + GUN.muzzle * PLANE.cruiseSpeed * plane!.params.pace) * GUN.life;
    // a plane near where the nose points: aim at it
    let dir: [number, number, number] = f;
    let best = GUN.assist;
    for (const id of remotes.ids()) {
      const p = remotes.pose(id)!;
      const d: [number, number, number] = [p.x - s.x, p.y - s.y, (p.h - s.h) / k];
      const len = Math.hypot(...d);
      if (len > reach || len === 0) continue;
      const off = Math.acos(Math.max(-1, Math.min(1, (d[0] * f[0] + d[1] * f[1] + d[2] * f[2]) / len)));
      if (off < best) {
        best = off;
        dir = [d[0] / len, d[1] / len, d[2] / len];
      }
    }
    const v = s.speed + GUN.muzzle * PLANE.cruiseSpeed * plane!.params.pace;
    const half = plane!.params.length / 2;
    const r = { x: s.x + f[0] * half, y: s.y + f[1] * half, h: s.h + f[2] * half * k, vx: dir[0] * v, vy: dir[1] * v, vh: dir[2] * v * k };
    addRound({ ...r, mine: true });
    send({ k: "f", ...r });
  }

  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    e.preventDefault();
    firing = true;
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") firing = false;
  });
  window.addEventListener("blur", () => (firing = false));

  // ---------------------------------------------------------------- each frame

  view.onFrame(({ dt }) => {
    const t = now();
    remotes.update(t);
    if (plane.crashes !== crashes) down(lastHit && t - lastHit.at < CREDIT_S ? lastHit.by : null);

    cooldown -= dt;
    if (firing && dt > 0 && cooldown <= 0) {
      fire();
      cooldown = GUN.interval;
    }
    const k = PLANE.stepsPerCell;
    const hitReach = GUN.reach * plane.params.length;
    for (let i = rounds.length - 1; i >= 0; i--) {
      const r = rounds[i]!;
      const from: [number, number, number] = [r.x, r.y, r.h / k];
      r.x += r.vx * dt;
      r.y += r.vy * dt;
      r.h += r.vh * dt;
      r.life -= dt;
      let gone = r.life <= 0 || r.h < (view.query.heightAt(r.x, r.y) ?? -Infinity);
      if (!gone && r.mine)
        for (const id of remotes.ids()) {
          const p = remotes.pose(id)!;
          if (passes(from, [r.x, r.y, r.h / k], [p.x, p.y, p.h / k]) > hitReach) continue;
          send({ k: "hit", to: id, dmg: GUN.damage });
          gone = true;
          break;
        }
      if (gone) {
        r.e.remove();
        rounds.splice(i, 1);
      } else r.e.moveTo(r.x, r.y, r.h);
    }
    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        p.e.remove();
        puffs.splice(i, 1);
      }
    }
    draw();
  });

  /** Shadows under the others, their name tags (at the canvas edge, pointing, when out of view), the scores. */
  function draw(): void {
    const canvas = view.canvas.getBoundingClientRect();
    const mine = plane!.state;
    const myAlt = view.query.elevationAt(mine.x, mine.y, mine.h);
    for (const [id, peer] of peers) {
      const p: Pose | null = remotes.pose(id);
      if (!p) continue;
      const ground = view.query.heightAt(p.x, p.y);
      if (ground !== null) {
        peer.shadow ??= view.entities.add({ model: { ...model(id), part: 1 }, x: p.x, y: p.y, h: ground, headings: PLANE.headings, wait: false });
        peer.shadow.moveTo(p.x, p.y, ground + PLANE.shadowLift);
        peer.shadow.heading = p.heading;
      }
      const alt = view.query.elevationAt(p.x, p.y, p.h);
      const up = alt !== null && myAlt !== null ? Math.round(alt - myAlt) : null;
      const km = (Math.hypot(p.x - mine.x, p.y - mine.y) * view.query.metersPerCellAt(p.x, p.y)) / 1000;
      const text = `${peer.name} ${Math.max(0, peer.hp)}% · ${km.toFixed(1)} km${up === null ? "" : ` · ${up >= 0 ? "▲" : "▼"}${Math.abs(up)} m`}`;
      const at = view.camera.project(p.x, p.y, p.h);
      // clear of the HUD's panels at the canvas's corners
      const [mx, my] = [70, 100];
      let x = at.x;
      let y = at.y - 12;
      const parts: (Node | string)[] = [text];
      if (!at.onScreen) {
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const a = Math.atan2(at.y - cy, at.x - cx);
        const f = Math.min((cx - mx) / Math.abs(Math.cos(a) || 1e-9), (cy - my) / Math.abs(Math.sin(a) || 1e-9));
        x = cx + Math.cos(a) * f;
        y = cy + Math.sin(a) * f;
        const arrow = Object.assign(document.createElement("span"), { textContent: "➤ " });
        Object.assign(arrow.style, { display: "inline-block", transform: `rotate(${a}rad)` });
        parts.unshift(arrow);
      }
      peer.tag.replaceChildren(...parts); // names come from other players: text, never markup
      peer.tag.style.left = `${canvas.left + x}px`;
      peer.tag.style.top = `${canvas.top + y}px`;
    }
    const rows = [...peers.values()].map((p) => `${p.name.padEnd(12)} ${String(p.kills).padStart(2)} down ${String(p.deaths).padStart(2)} lost`);
    board.textContent = [
      `DOGFIGHT · room ${room.name}`,
      `${me.name.padEnd(12)} ${String(me.kills).padStart(2)} down ${String(me.deaths).padStart(2)} lost · ${me.hp}%`,
      ...rows,
      peers.size ? "Space: guns" : "waiting for others: open this page in another window",
    ].join("\n");
  }

  hud?.say(`Dogfight · room ${room.name} · Space fires`, 4);
  window.__dogfight = { room, me, remotes, peers }; // for tests and the console
}

declare global {
  interface Window {
    __dogfight?: { room: Room; me: { name: string; hp: number; kills: number; deaths: number }; remotes: RemotePlayers; peers: ReadonlyMap<string, Peer> };
  }
}
