import { carSize } from "@pixelworlds/game/src/car";
import type { Game } from "@pixelworlds/game/src/game";
import { Decks, DriveWorld, type TrafficSource } from "@pixelworlds/game/src/ground";
import { CAR } from "@pixelworlds/game/src/tuning";
import type { Entity } from "pixelworld/engine";
import { Correction, RemotePlayers, TickClient, joinRoom, type Pose, type Room } from "@pixelworlds/multiplayer";
import {
  Ghosts,
  RACE,
  TICK,
  contacts,
  courseHeading,
  finished,
  lapOf,
  nextCheckpoint,
  planCourse,
  raceCar,
  raceClock,
  raceTick,
  type CarNet,
  type Course,
  type RaceEvent,
  type RaceInput,
  type RaceJoin,
  type RaceNet,
  type RaceSnap,
  type RaceWorldNet,
  type Racer,
} from "./rules";

/**
 * The race, in the page (D-119): cars round the Strip, run by the server
 * (server.ts) on `/race?room=`. As a driver, the example game's car
 * controller only draws the page's own car; a `TickClient` drives it a fixed
 * tick at a time with the keys, bumping into the other cars where the page
 * draws them, and corrects to the newest snapshot once a frame, a
 * correction drawn easing out (`Correction`) so a bump judged otherwise
 * doesn't snap the car or the camera. R puts it back at its last checkpoint.
 * As a watcher (`watch`), the page drives nothing and follows the others
 * (Space for the next). The board has the race, the standings, ping and the
 * room's code to share.
 */

/** A car's model seed from its id: a few bodies and colours. */
const seedOf = (id: string) => 1 + (Math.abs([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 6);
const ord = (n: number) => (n ? `P${n}` : "–");

export async function startRace(game: Game, opts: { room: string; name?: string | null; watch?: boolean; path?: string }): Promise<void> {
  const car = game.car;
  if (!car) throw new Error("the race starts in the car");
  const routes = game.routes;
  if (!routes) throw new Error("the race's world has no routes");
  game.stay = true;
  const view = game.view;
  const hud = game.hud;
  car.paused = true; // the TickClient drives it; the controller only draws it
  let room: Room;
  try {
    room = await joinRoom(opts.path ?? "/race", opts.room, { version: import.meta.env.PLAY_BUILD });
  } catch (e) {
    car.paused = false;
    hud?.say(`Race: ${e instanceof Error ? e.message : String(e)} · driving alone`, 6);
    return;
  }
  const watching = opts.watch === true;
  const w = view.world;
  const params = raceCar(car.params); // as the server's
  const course = planCourse(routes, view.query);
  // the course loaded, as the server loads it: the prediction reads the same ground
  const xs = course.path.points.map((p) => p.x);
  const ys = course.path.points.map((p) => p.y);
  await view.query.ensure(Math.min(...xs) - 12, Math.min(...ys) - 12, Math.max(...xs) + 12, Math.max(...ys) + 12);

  // the page's own racer: its car is the controller's state (the controller draws it)
  const me: Racer = { car: car.state, steps: 0, cps: 0, laps: [], held: true };
  /** The other cars each input was stepped against: where the page drew them then (a replay bumps the same). */
  const saw = new WeakMap<RaceInput, TrafficSource>();
  let bumping: TrafficSource | null = null;
  const drive = new DriveWorld(view.query, w.cellsX, w.cellsY, new Decks(routes), () => bumping);
  const correction = new Correction();
  let before: Pose = { x: 0, y: 0, h: 0, heading: 0 };
  /** How far the last snapshot moved the car (cells): 0 when the prediction was right. */
  let corrected = 0;

  let cars: CarNet[] = [];
  const ghosts = new Ghosts(); // which cars the others drove through when, as the server judges it
  let race: RaceNet | null = null;
  let watched: string | null = null;
  const tags = new Map<string, HTMLElement>();

  const client: TickClient<RaceInput, RaceSnap, RaceWorldNet, RaceEvent> = new TickClient(room, {
    tick: TICK,
    step: watching
      ? undefined
      : (i) => {
          bumping = saw.get(i) ?? null;
          raceTick(me, i, drive, course, params);
          bumping = null;
        },
    restore: (snap) => {
      const s = car.state;
      before = { x: s.x, y: s.y, h: s.h, heading: s.heading };
      Object.assign(s, snap.you.car);
      Object.assign(me, { steps: snap.you.steps, cps: snap.you.cps, laps: snap.you.laps, held: snap.you.held });
    },
    reconciled: () => {
      const s = car.state;
      const moved = Math.hypot(s.x - before.x, s.y - before.y);
      corrected = me.held || moved > correction.snap ? 0 : moved; // held, or past it: the grid or a jump, not a correction
      correction.moved(before, s);
    },
    onWorld: (m) => world(m),
  });
  const size = carSize(w);
  const remotes = new RemotePlayers(view.entities, (id) => ({ model: { group: CAR.group, seed: seedOf(id), size }, silhouette: true }), { clock: client.clock });
  client.hello({ name: (opts.name || "Driver").slice(0, 20), watch: watching } satisfies RaceJoin);
  if (watching) {
    car.follow = false;
    car.car.visible = false;
  }

  // ---------------------------------------------------------------- the course drawn: gates at the checkpoints, the line chequered

  const pal = w.palette.rampIds;
  const ramp = (...names: string[]) => names.map((n) => pal.get(n)).find((r) => r !== undefined) ?? 0;
  const white = ramp("marking", "concrete", "tower-gold");
  const dark = ramp("asphalt", "basalt");
  const orange = ramp("marker", "roof-tile");
  const gold = ramp("tower-gold", "marker", "marking");
  const pylons = (z: number, r: number) => [
    { x0: -0.06, y0: 0.42, z0: 0, x1: 0.06, y1: 0.54, z1: z, ramp: r },
    { x0: -0.06, y0: -0.54, z0: 0, x1: 0.06, y1: -0.42, z1: z, ramp: r },
  ];
  const gate = { boxes: pylons(1.2, orange), key: "race.gate" };
  const chequer = Array.from({ length: 8 }, (_, i) => ({ x0: -0.05, y0: -0.4 + i * 0.1, z0: 0, x1: 0.05, y1: -0.3 + i * 0.1, z1: 0.06, ramp: i % 2 ? white : dark }));
  const line = { boxes: [...pylons(1.6, white), { x0: -0.04, y0: -0.54, z0: 1.4, x1: 0.04, y1: 0.54, z1: 1.6, ramp: white }, ...chequer], key: "race.line" };
  const next = { boxes: pylons(2.4, gold), key: "race.next" };
  course.checkpoints.forEach((cp, i) =>
    view.entities.add({ model: i === 0 ? line : gate, x: cp.x, y: cp.y, h: drive.groundAt(cp.x, cp.y, view.query.heightAt(cp.x, cp.y) ?? 0) ?? 0, heading: cp.heading, wait: false }),
  );
  const nextGate: Entity | null = watching ? null : view.entities.add({ model: next, x: course.checkpoints[0]!.x, y: course.checkpoints[0]!.y, heading: course.checkpoints[0]!.heading, wait: false });

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
  const nameOf = (id: string | null) => (id === room.id ? "you" : (id && cars.find((c) => c.id === id)?.name) || "someone");

  // ---------------------------------------------------------------- the server's word

  /** The page's place last snapshot, to say when it changes in the race. */
  let place = 0;
  function world(m: RaceWorldNet & { t: number }): void {
    if (race?.phase !== m.race.phase && m.race.phase === "countdown") hud?.say("On the grid: get ready", 2.5);
    const now = m.cars.find((c) => c.id === room.id)?.place ?? 0;
    if (m.race.phase === "racing" && place && now && now !== place && !watching) hud?.say(now < place ? `Up to ${ord(now)}` : `Down to ${ord(now)}`, 1.5);
    place = now;
    race = m.race;
    cars = m.cars;
    for (const c of cars) ghosts.record(c.id, m.t, !!c.ghost);
    const others = cars.filter((c) => c.id !== room.id);
    for (const c of others) remotes.push(c.id, m.t, { x: c.x, y: c.y, h: c.h, heading: c.hd, life: c.life });
    const here = new Set(others.map((c) => c.id));
    remotes.retain(here);
    for (const [id, tag] of tags)
      if (!here.has(id)) {
        tag.remove();
        tags.delete(id);
      }
    if (watching && (!watched || !here.has(watched))) watched = others[0]?.id ?? null;
  }

  /** An event, shown when the page shows its time of the others. */
  const play = (e: RaceEvent) => {
    if (e.kind === "lap") {
      if (e.who === room.id) hud?.say(`Lap ${e.lap}: ${raceClock(e.time)}`, 2);
    } else if (e.kind === "finish") hud?.say(e.who === room.id ? `You finish ${ord(e.place)} in ${raceClock(e.time)}!` : `${nameOf(e.who)} finishes ${ord(e.place)}`, 3);
    else if (e.phase === "results") {
      const winner = race?.results[0];
      hud?.say(winner ? (winner.id === room.id ? "You win the race!" : `${winner.name} wins the race`) : "The race is over", 4);
    }
  };

  room.onLeave = (id) => hud?.say(`${nameOf(id)} left`, 2);
  room.onClose = (why) => {
    car.paused = false; // driving alone, by the controller again
    correction.reset();
    Object.assign(car.drawOffset, correction.offset);
    if (watching) car.car.visible = car.follow = true;
    hud?.say(`Race: ${why ?? "the server went away"} · driving alone`, 6);
  };

  let reset = false;
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "r" && !watching) reset = true;
    else if (e.code === "Space" && watching) {
      e.preventDefault();
      const ids = remotes.ids();
      watched = ids[(ids.indexOf(watched ?? "") + 1) % ids.length] ?? null;
      if (watched) hud?.say(`Watching ${nameOf(watched)}`, 1.5);
    }
  });

  // ---------------------------------------------------------------- each frame

  let wasHeld = true;
  let shownCount: number | null = null;
  view.onFrame(({ dt }) => {
    const t = performance.now() / 1000;
    // the others where the page draws them now: what this frame's inputs bump into
    remotes.update(t);
    const seen = client.seen(t);
    const solid = cars.filter((c) => c.id !== room.id && !(seen === null ? c.ghost : ghosts.at(c.id, seen, c.ghost))).flatMap((c) => remotes.pose(c.id) ?? []);
    const bumps = contacts(solid, params);
    if (!watching && car.paused)
      client.advance(dt, () => {
        const i: RaceInput = { ...car.input(), reset };
        reset = false;
        saw.set(i, bumps);
        return i;
      });
    correction.update(dt);
    Object.assign(car.drawOffset, correction.offset);
    for (const e of client.due(t)) play(e);
    if (watching && watched) {
      const p = remotes.pose(watched);
      if (p) view.camera.setFocus(p.x, p.y, p.h);
    }
    // the countdown, as the page's own inputs will reach the server; go, when its car is let go
    if (race?.phase === "countdown" && race.until !== null) {
      const serverNow = client.clock.time(t);
      const n = serverNow === null ? null : Math.ceil(race.until - serverNow - (client.ping ?? 0) / 2000);
      if (n !== null && n !== shownCount && n >= 1 && n <= 3) hud?.say(String(n), 0.9);
      shownCount = n;
    }
    if (!watching && wasHeld && !me.held && race?.phase === "racing") hud?.say("Go!", 1.2);
    wasHeld = me.held;
    if (nextGate) {
      const n = nextCheckpoint(course, me);
      nextGate.moveTo(n.x, n.y, view.query.heightAt(n.x, n.y) ?? 0);
      nextGate.heading = courseHeading(course, n.d);
      nextGate.visible = !finished(me) && race?.phase !== "results";
    }
    drawPage(t);
  });

  /** Name tags over the others, and the board. */
  function drawPage(t: number): void {
    const canvas = view.canvas.getBoundingClientRect();
    for (const c of cars) {
      if (c.id === room.id) continue;
      const p = remotes.pose(c.id);
      if (!p) continue;
      let tag = tags.get(c.id);
      if (!tag) {
        tag = Object.assign(document.createElement("div"), { className: "label" });
        document.body.append(tag);
        tags.set(c.id, tag);
      }
      const at = view.camera.project(p.x, p.y, p.h);
      tag.style.display = at.onScreen ? "" : "none";
      // names come from other players: text, never markup
      tag.textContent = `${c.place ? ord(c.place) + " " : ""}${c.name}${c.bot ? " (bot)" : ""}${c.ghost && !c.done && c.place && !c.passing ? " · stalled" : ""}`;
      tag.style.color = c.id === watched ? "#ffffff" : "#ffb38a";
      tag.style.left = `${canvas.left + at.x}px`;
      tag.style.top = `${canvas.top + at.y - 12}px`;
    }
    const shown = client.seen(t);
    const left = race?.until != null && shown !== null ? Math.max(0, race.until - shown) : null;
    const phase = !race
      ? "joining…"
      : race.phase === "waiting"
        ? "waiting for drivers"
        : race.phase === "countdown"
          ? `starts in ${Math.ceil(left ?? 0)}`
          : race.phase === "racing"
            ? `${RACE.laps} laps${left === null ? "" : ` · ${raceClock(left)} left`}`
            : `results · next in ${Math.ceil(left ?? 0)}`;
    const mine = cars.find((c) => c.id === room.id);
    const lapTimes = me.laps.map((s, i) => (s - (me.laps[i - 1] ?? 0)) * TICK);
    const you = watching
      ? `watching ${watched ? nameOf(watched) : "nobody yet"} · Space: next`
      : !mine
        ? ""
        : !mine.place
          ? "you're in the next race"
          : `${ord(mine.place)} · lap ${lapOf(me)}/${RACE.laps} · ${raceClock(me.steps * TICK)}${lapTimes.length ? ` · best ${raceClock(Math.min(...lapTimes))}` : ""}${finished(me) ? " · finished" : ""}`;
    const standings =
      race?.phase === "results"
        ? race.results.map((r, i) => `${i + 1}. ${(r.name + (r.bot ? " (bot)" : "")).padEnd(16)} ${r.time === null ? "  –   " : raceClock(r.time)}  best ${r.best === null ? "–" : raceClock(r.best)}`)
        : [...cars]
            .filter((c) => c.place)
            .sort((a, b) => a.place - b.place)
            .map((c) => `${c.place}. ${(c.name + (c.bot ? " (bot)" : "") + (c.id === room.id ? " (you)" : "")).padEnd(16)} ${c.done ? raceClock(c.time) : `lap ${c.lap}`}`);
    board.textContent = [
      `RACE · room ${room.name} · ${phase}`,
      you,
      ...standings,
      watching ? "" : "R: back to the last checkpoint",
      watching ? "" : `ping ${client.ping === null ? "–" : Math.round(client.ping)} ms · ${client.prediction.unacknowledged} ahead · corr ${corrected.toFixed(3)}`,
      `invite: ${location.origin}${location.pathname}?room=${room.name}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  hud?.say(watching ? `Race · room ${room.name} · watching (Space: next car)` : `Race · room ${room.name} · ${RACE.laps} laps of the Strip`, 4);
  window.__race = { game, room, course, me, race: () => race, cars: () => cars, remotes, client, corrected: () => corrected, correction, watched: () => watched };
}

declare global {
  interface Window {
    __race?: {
      game: Game;
      room: Room;
      course: Course;
      me: Racer;
      race: () => RaceNet | null;
      cars: () => CarNet[];
      remotes: RemotePlayers;
      client: TickClient<RaceInput, RaceSnap, RaceWorldNet, RaceEvent>;
      corrected: () => number;
      correction: Correction;
      watched: () => string | null;
    };
  }
}
