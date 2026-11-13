import type { Game } from "@pixelworlds/game/src/game";
import { flyPlane } from "@pixelworlds/game/src/plane";
import { PLANE } from "@pixelworlds/game/src/tuning";
import type { Entity } from "pixelworld/engine";
import { RemotePlayers, SERVER, TickClient, joinRoom, type Pose, type Room } from "../../index";
import { GUN, TICK, fireRound, type DogfightInput, type PlaneNet, type Round, type ServerMsg } from "./rules";

/**
 * The dogfight, in the page (D-113, D-114): planes over the Grand Canyon, run
 * by the server (server.ts) on `/dogfight?room=`. The example game's plane
 * controller only draws the page's own plane; a `TickClient` flies it a fixed
 * tick at a time with the keys, sends each input, and corrects to each
 * snapshot. The others are drawn a little behind (`RemotePlayers`). Hits,
 * health, kills and respawns are the server's; the page draws them.
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
}

type Snapshot = Extract<ServerMsg, { k: "snap" }>;

export async function startDogfight(game: Game, opts: { room: string; name?: string | null; path?: string }): Promise<void> {
  const plane = game.plane;
  if (!plane) throw new Error("the dogfight starts in the air");
  game.stay = true;
  const view = game.view;
  const hud = game.hud;
  let room: Room;
  try {
    room = await joinRoom(opts.path ?? "/dogfight", opts.room);
  } catch (e) {
    hud?.say(`Dogfight: ${e instanceof Error ? e.message : String(e)} · flying alone`, 6);
    return;
  }
  const w = view.world;
  const size = { length: PLANE.voxels.length * w.renderScale, width: PLANE.voxels.width * w.renderScale, height: PLANE.voxels.height * w.renderScale };
  const model = (id: string) => ({ group: PLANE.group, seed: 1 + (Number(id) % 4), size });
  const remotes = new RemotePlayers(view.entities, (id) => ({ model: model(id), headings: PLANE.headings, silhouette: true }));
  const now = () => performance.now() / 1000;
  const client = new TickClient<DogfightInput>(room, {
    tick: TICK,
    step: (i) => void flyPlane(plane.state, i, plane.fly, plane.params, TICK),
    seen: () => {
      const anyone = remotes.ids()[0];
      return anyone ? remotes.smoothing.time(anyone, now()) : null;
    },
  });
  client.hello((opts.name || `Pilot ${room.id}`).slice(0, 20));
  plane.paused = true; // the TickClient flies it; the controller only draws it

  const peers = new Map<string, Peer>();
  let me: PlaneNet | null = null;
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
  const draw = (r: Round) => rounds.push({ ...r, life: GUN.life, e: view.entities.add({ model: roundModel, x: r.x, y: r.y, h: r.h, headings: 1, wait: false }) });

  // ---------------------------------------------------------------- the server's word

  let firing = false;
  let cooldown = 0;
  /** How far the last snapshot moved the plane (cells): 0 when the prediction was right. */
  let correction = 0;

  const snapshot = (m: Snapshot) => {
    const t = now();
    for (const net of m.planes) {
      if (net.id === room.id) {
        me = net;
        continue;
      }
      let p = peers.get(net.id);
      if (!p) {
        const tag = document.createElement("div");
        tag.className = "label";
        tag.style.color = "#ffb38a";
        document.body.append(tag);
        peers.set(net.id, (p = { net, tag, shadow: null, flash: 0 }));
      }
      p.net = net;
      remotes.push(net.id, m.t, { x: net.x, y: net.y, h: net.h, heading: net.hd, pitch: net.p, roll: net.r }, net.jump ?? false, t);
    }
    const s = plane.state;
    const before = { x: s.x, y: s.y, h: s.h };
    if (me?.jump) plane.place(m.you.x, m.you.y, m.you.heading, m.you.h); // a respawn: the camera goes with it
    client.reconcile(m, () => Object.assign(s, m.you));
    correction = me?.jump ? 0 : Math.hypot(s.x - before.x, s.y - before.y, (s.h - before.h) / PLANE.stepsPerCell);
  };

  room.onMessage = (from, data) => {
    if (from !== SERVER) return;
    const m = data as ServerMsg;
    if (m.k === "snap") snapshot(m);
    else if (m.k === "fire") {
      if (m.by !== room.id) draw(m);
    } else if (m.k === "hit") {
      const p = peers.get(m.to);
      if (p && m.by === room.id) p.flash = 0.25;
    } else if (m.k === "down") {
      puff(m.x, m.y, m.h);
      const what =
        m.who === room.id
          ? m.by
            ? `Shot down by ${nameOf(m.by)}`
            : "You crashed"
          : m.by === room.id
            ? `You shot down ${nameOf(m.who)}`
            : m.by
              ? `${nameOf(m.by)} shot down ${nameOf(m.who)}`
              : `${nameOf(m.who)} crashed`;
      hud?.say(what, 2.5);
    }
  };
  room.onLeave = (id) => {
    const p = peers.get(id);
    p?.tag.remove();
    p?.shadow?.remove();
    peers.delete(id);
    remotes.remove(id);
    hud?.say(`${p?.net.name ?? "A pilot"} left`, 2);
  };
  room.onClose = () => {
    plane.paused = false; // flying alone, by the controller again
    hud?.say("Dogfight: the server went away · flying alone", 6);
  };

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
    if (plane.paused)
      client.advance(
        dt,
        () => ({ ...plane.input(), fire: firing }),
        // its own rounds drawn at once, as the server will fire them; the others' come from the server
        (i) => {
          cooldown = Math.max(0, cooldown - TICK);
          if (!i.fire || cooldown > 0) return;
          cooldown = GUN.interval;
          draw(fireRound(plane.state, plane.params, remotes.ids().map((id) => remotes.pose(id)!)));
        },
      );
    remotes.update(now());
    for (let i = rounds.length - 1; i >= 0; i--) {
      const r = rounds[i]!;
      r.x += r.vx * dt;
      r.y += r.vy * dt;
      r.h += r.vh * dt;
      r.life -= dt;
      if (r.life <= 0 || r.h < (view.query.heightAt(r.x, r.y) ?? -Infinity)) {
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
    for (const p of peers.values()) p.flash = Math.max(0, p.flash - dt);
    drawPage();
  });

  /** Shadows under the others, their name tags (at the canvas edge, pointing, when out of view), the scores. */
  function drawPage(): void {
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
      const text = `${peer.net.name} ${Math.max(0, peer.net.hp)}% · ${km.toFixed(1)} km${up === null ? "" : ` · ${up >= 0 ? "▲" : "▼"}${Math.abs(up)} m`}`;
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
    const row = (n: PlaneNet) => `${n.name.padEnd(12)} ${String(n.kills).padStart(2)} down ${String(n.deaths).padStart(2)} lost`;
    board.textContent = [
      `DOGFIGHT · room ${room.name} · server`,
      me ? `${row(me)} · ${Math.max(0, me.hp)}%` : "joining…",
      ...[...peers.values()].map((p) => row(p.net)),
      peers.size ? "Space: guns" : "waiting for others: open this page in another window",
      `prediction: ${client.prediction.unacknowledged} ahead · corr ${correction.toFixed(3)}`,
    ].join("\n");
  }

  hud?.say(`Dogfight · room ${room.name} · Space fires`, 4);
  window.__dogfight = { game, room, me: () => me, remotes, peers, client, correction: () => correction };
}

declare global {
  interface Window {
    __dogfight?: {
      game: Game;
      room: Room;
      me: () => PlaneNet | null;
      remotes: RemotePlayers;
      peers: ReadonlyMap<string, Peer>;
      client: TickClient<DogfightInput>;
      correction: () => number;
    };
  }
}
