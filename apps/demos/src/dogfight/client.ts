import type { Game } from "@pixelworlds/game/src/game";
import { PLANE } from "@pixelworlds/game/src/tuning";
import type { Entity } from "pixelworld/engine";
import { RemotePlayers, TickClient, joinRoom, type Pose, type Room } from "@pixelworlds/multiplayer";
import {
  GUN,
  PLANE_STATE,
  PLANE_WIRE,
  TICK,
  fireRound,
  flyTick,
  planeOf,
  planesOf,
  type DogfightEvent,
  type DogfightInput,
  type DogfightJoin,
  type DogfightRoster,
  type DogfightSnap,
  type DogfightWorldNet,
  type MatchNet,
  type PlaneNet,
  type PlaneWire,
  type Round,
} from "./rules";

/**
 * The dogfight, in the page (D-113, D-114, D-116, D-118): planes over the
 * Grand Canyon, run by the server (server.ts) on `/dogfight?room=`. As a
 * pilot, the example game's plane controller only draws the page's own plane;
 * a `TickClient` flies it a fixed tick at a time with the keys and corrects
 * to the newest snapshot once a frame. Its own rounds are drawn at once,
 * named by the input they were fired on, and end where the server says they
 * hit. As a watcher (`watch`), the page flies nothing and follows the others
 * (Space for the next). The others are drawn a little behind on the server's
 * clock, and events show when the page shows that time of them. The board
 * has the match, the scores, ping and the room's code to share.
 */

interface Peer {
  net: PlaneNet;
  tag: HTMLElement;
  shadow: Entity | null;
  /** Seconds left of the flash on its tag after a hit of ours. */
  flash: number;
}

interface Drawn extends Round {
  life: number;
  e: Entity;
  /** One of the page's own rounds: the input it was fired on. */
  seq?: number;
}

/** A plane's model seed from its id: a few liveries. */
const seedOf = (id: string) => 1 + (Math.abs([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 4);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export async function startDogfight(game: Game, opts: { room: string; name?: string | null; watch?: boolean; path?: string }): Promise<void> {
  const plane = game.plane;
  if (!plane) throw new Error("the dogfight starts in the air");
  game.stay = true;
  const view = game.view;
  const hud = game.hud;
  let room: Room;
  try {
    room = await joinRoom(opts.path ?? "/dogfight", opts.room, { version: import.meta.env.PLAY_BUILD });
  } catch (e) {
    hud?.say(`Dogfight: ${e instanceof Error ? e.message : String(e)} · flying alone`, 6);
    return;
  }
  const watching = opts.watch === true;
  const w = view.world;
  const size = { length: PLANE.voxels.length * w.renderScale, width: PLANE.voxels.width * w.renderScale, height: PLANE.voxels.height * w.renderScale };
  const model = (id: string) => ({ group: PLANE.group, seed: seedOf(id), size });
  const now = () => performance.now() / 1000;

  const peers = new Map<string, Peer>();
  /** The planes the server replicates (D-123), and the pilots' names and scores. */
  const states = new Map<string, PlaneWire>();
  let pilots: DogfightRoster["pilots"] = {};
  let me: PlaneNet | null = null;
  let match: MatchNet | null = null;
  /** The life the page's own plane was last put at (a new one is a respawn: the camera goes with it). */
  let placed: number | null = null;
  /** The plane a watcher follows. */
  let watched: string | null = null;
  /** How far the last snapshot moved the plane (cells): 0 when the prediction was right. */
  let correction = 0;
  let before = { x: 0, y: 0, h: 0 };
  let respawned = false;

  const client: TickClient<DogfightInput, DogfightSnap, DogfightWorldNet, DogfightEvent, PlaneWire> = new TickClient(room, {
    tick: TICK,
    schema: PLANE_WIRE,
    snapSchema: PLANE_STATE,
    onRoster: (r) => (pilots = (r as unknown as DogfightRoster).pilots),
    step: watching ? undefined : (i) => void flyTick(plane.state, i, plane.fly, plane.params),
    restore: (snap) => {
      const s = plane.state;
      before = { x: s.x, y: s.y, h: s.h };
      respawned = me !== null && me.life !== placed;
      if (respawned) {
        plane.place(snap.x, snap.y, snap.heading, snap.h); // the camera goes with it
        placed = me!.life;
      }
      Object.assign(s, planeOf(snap));
    },
    reconciled: () => {
      const s = plane.state;
      correction = respawned ? 0 : Math.hypot(s.x - before.x, s.y - before.y, (s.h - before.h) / PLANE.stepsPerCell);
    },
    onWorld: (m) => {
      for (const [id, s] of m.entities?.states ?? []) states.set(id, s);
      for (const id of m.entities?.gone ?? []) states.delete(id);
      // every plane is in every message (the dogfight replicates all of them, near)
      world({ ...m, planes: planesOf(states, pilots) });
    },
  });
  const remotes = new RemotePlayers(view.entities, (id) => ({ model: model(id), headings: PLANE.headings, silhouette: true }), { clock: client.clock });
  client.hello({ name: (opts.name || "Pilot").slice(0, 20), watch: watching } satisfies DogfightJoin);
  plane.paused = true; // the TickClient flies it; the controller only draws it
  if (watching) {
    plane.follow = false;
    plane.entity.visible = false;
    plane.shadow.visible = false;
  }

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
  const rounds: Drawn[] = [];
  const puffs: { e: Entity; life: number }[] = [];

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
  const nameOf = (id: string | null) => (id === room.id ? "you" : (id && peers.get(id)?.net.name) || "someone");
  const puff = (x: number, y: number, h: number) => puffs.push({ e: view.entities.add({ model: puffModel, x, y, h, headings: 1, wait: false }), life: 0.7 });
  const draw = (r: Round, seq?: number) =>
    rounds.push({ ...r, seq, life: GUN.life, e: view.entities.add({ model: roundModel, x: r.x, y: r.y, h: r.h, headings: 1, wait: false }) });
  const endRound = (i: number) => {
    rounds[i]!.e.remove();
    rounds.splice(i, 1);
  };

  // ---------------------------------------------------------------- the server's word

  function world(m: DogfightWorldNet & { t: number; planes: PlaneNet[] }): void {
    match = m.match;
    const others = m.planes.filter((n) => n.id !== room.id);
    me = m.planes.find((n) => n.id === room.id) ?? null;
    for (const net of others) {
      let p = peers.get(net.id);
      if (!p) {
        const tag = document.createElement("div");
        tag.className = "label";
        document.body.append(tag);
        peers.set(net.id, (p = { net, tag, shadow: null, flash: 0 }));
      }
      p.net = net;
      remotes.push(net.id, m.t, { x: net.x, y: net.y, h: net.h, heading: net.hd, pitch: net.p, roll: net.r, life: net.life });
    }
    // the planes the snapshot doesn't have went (left, or a bot gone)
    const here = new Set(others.map((n) => n.id));
    remotes.retain(here);
    for (const [id, p] of peers)
      if (!here.has(id)) {
        p.tag.remove();
        p.shadow?.remove();
        peers.delete(id);
      }
    if (watching && (!watched || !here.has(watched))) watched = others[0]?.id ?? null;
  }

  /** An event, shown when the page shows its time of the others. */
  const play = (e: DogfightEvent) => {
    if (e.kind === "fire") {
      if (e.by !== room.id) draw(e); // its own were drawn at once
    } else if (e.kind === "hit") {
      if (e.by === room.id) {
        // its own round that hit: it ends there, not flying on through
        const i = rounds.findIndex((r) => r.seq === e.seq);
        if (i >= 0) endRound(i);
        const p = peers.get(e.to);
        if (p) p.flash = 0.25;
      }
    } else if (e.kind === "down") {
      puff(e.x, e.y, e.h);
      if (match?.phase !== "playing") return;
      const what =
        e.who === room.id
          ? e.by
            ? `Shot down by ${nameOf(e.by)}`
            : "You crashed"
          : e.by === room.id
            ? `You shot down ${nameOf(e.who)}`
            : e.by
              ? `${nameOf(e.by)} shot down ${nameOf(e.who)}`
              : `${nameOf(e.who)} crashed`;
      hud?.say(what, 2.5);
    } else if (e.phase === "staging") hud?.say("Next match: get ready", 3);
    else if (e.phase === "playing") hud?.say(`Fight! First to ${match?.kills ?? 10}`, 3);
    else hud?.say(e.winner ? (e.winner === room.id ? "You win the match!" : `${nameOf(e.winner)} wins the match`) : "The match is over", 5);
  };

  room.onLeave = (id) => hud?.say(`${peers.get(id)?.net.name ?? "A pilot"} left`, 2);
  room.onClose = (why) => {
    plane.paused = false; // flying alone, by the controller again
    if (watching) plane.entity.visible = plane.shadow.visible = plane.follow = true;
    hud?.say(`Dogfight: ${why ?? "the server went away"} · flying alone`, 6);
  };

  let firing = false;
  let cooldown = 0;
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    e.preventDefault();
    if (!watching) firing = true;
    else {
      // the next plane along
      const ids = remotes.ids();
      watched = ids[(ids.indexOf(watched ?? "") + 1) % ids.length] ?? null;
      if (watched) hud?.say(`Watching ${nameOf(watched)}`, 1.5);
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") firing = false;
  });
  window.addEventListener("blur", () => (firing = false));

  // ---------------------------------------------------------------- each frame

  view.onFrame(({ dt }) => {
    const t = now();
    if (!watching && plane.paused)
      client.advance(
        dt,
        () => ({ ...plane.input(), fire: firing }),
        // its own rounds drawn at once, as the server will fire them (guns cold but in play), named by the input
        (i, seq) => {
          cooldown = Math.max(0, cooldown - TICK);
          if (!i.fire || cooldown > 0) return;
          cooldown = GUN.interval;
          if (match?.phase === "playing") draw(fireRound(plane.state, plane.params, remotes.ids().map((id) => remotes.pose(id)!)), seq);
        },
      );
    remotes.update(t);
    for (const e of client.due(t)) play(e);
    if (watching && watched) {
      const p = remotes.pose(watched);
      if (p) view.camera.setFocus(p.x, p.y, p.h);
    }
    for (let i = rounds.length - 1; i >= 0; i--) {
      const r = rounds[i]!;
      r.x += r.vx * dt;
      r.y += r.vy * dt;
      r.h += r.vh * dt;
      r.life -= dt;
      if (r.life <= 0 || r.h < (view.query.heightAt(r.x, r.y) ?? -Infinity)) endRound(i);
      else r.e.moveTo(r.x, r.y, r.h);
    }
    for (let i = puffs.length - 1; i >= 0; i--) {
      const p = puffs[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        p.e.remove();
        puffs.splice(i, 1);
      }
    }
    for (const p of peers.values()) p.flash = Math.max(0, p.flash - dt);
    drawPage(t);
  });

  /** Shadows under the others, their name tags (at the canvas edge, pointing, when out of view), the match and the scores. */
  function drawPage(t: number): void {
    const canvas = view.canvas.getBoundingClientRect();
    const eye = watching && watched ? remotes.pose(watched) : plane!.state;
    const myAlt = eye ? view.query.elevationAt(eye.x, eye.y, eye.h) : null;
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
      const up = alt !== null && myAlt !== null && id !== watched ? Math.round(alt - myAlt) : null;
      const km = eye && id !== watched ? (Math.hypot(p.x - eye.x, p.y - eye.y) * view.query.metersPerCellAt(p.x, p.y)) / 1000 : null;
      const text = `${peer.net.name}${peer.net.bot ? " (bot)" : ""} ${Math.max(0, peer.net.hp)}%${km === null ? "" : ` · ${km.toFixed(1)} km`}${up === null ? "" : ` · ${up >= 0 ? "▲" : "▼"}${Math.abs(up)} m`}`;
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
      peer.tag.style.color = peer.flash > 0 ? "#ffffff" : "#ffb38a";
      peer.tag.style.left = `${canvas.left + x}px`;
      peer.tag.style.top = `${canvas.top + y}px`;
    }
    const shown = client.seen(t);
    const left = match?.until != null && shown !== null ? Math.max(0, match.until - shown) : null;
    const phase = !match
      ? "joining…"
      : match.phase === "staging"
        ? left === null
          ? "waiting for pilots"
          : `starts in ${Math.ceil(left)} · guns cold`
        : match.phase === "playing"
          ? `${left === null ? "" : clock(left) + " left · "}first to ${match.kills}`
          : `${match.winner ? `${nameOf(match.winner)} won` : "over"} · next in ${Math.ceil(left ?? 0)}`;
    const row = (n: PlaneNet) => `${(n.name + (n.bot ? " (bot)" : "")).padEnd(14)} ${String(n.kills).padStart(2)} down ${String(n.deaths).padStart(2)} lost`;
    board.textContent = [
      `DOGFIGHT · room ${room.name} · ${phase}`,
      watching ? `watching ${watched ? nameOf(watched) : "nobody yet"} · Space: next` : me ? `${row(me)} · ${Math.max(0, me.hp)}%` : "",
      ...[...peers.values()].map((p) => row(p.net)),
      watching ? "" : "Space: guns",
      watching ? "" : `ping ${client.ping === null ? "–" : Math.round(client.ping)} ms · ${client.prediction.unacknowledged} ahead · corr ${correction.toFixed(3)}`,
      `invite: ${location.origin}${location.pathname}?room=${room.name}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  hud?.say(watching ? `Dogfight · room ${room.name} · watching (Space: next plane)` : `Dogfight · room ${room.name} · Space fires`, 4);
  window.__dogfight = { game, room, me: () => me, match: () => match, remotes, peers, client, correction: () => correction, watched: () => watched, rounds: () => rounds.length };
}

declare global {
  interface Window {
    __dogfight?: {
      game: Game;
      room: Room;
      me: () => PlaneNet | null;
      match: () => MatchNet | null;
      remotes: RemotePlayers;
      peers: ReadonlyMap<string, Peer>;
      client: TickClient<DogfightInput, DogfightSnap, DogfightWorldNet, DogfightEvent, PlaneWire>;
      correction: () => number;
      watched: () => string | null;
      rounds: () => number;
    };
  }
}
