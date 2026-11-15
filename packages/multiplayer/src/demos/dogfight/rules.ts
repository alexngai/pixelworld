import type { PlaneWorld } from "@pixelworlds/game/src/ground";
import { axes, flyPlane, type PlaneInput, type PlaneParams, type PlaneState, type PlaneStep } from "@pixelworlds/game/src/plane";
import { PLANE } from "@pixelworlds/game/src/tuning";
import { Schema, angle, exact, fixed, int } from "../../codec";

/**
 * The dogfight's rules and messages, the same on the server (server.ts, a
 * `TickRoom`) and in the page (client.ts, a `TickClient`): D-113, D-114. The
 * planes fly the example game's flight model (apps/game's plane.ts).
 */

/** Where the planes start: over the inner canyon, between the village and Phantom Ranch. */
export const DOGFIGHT_START = { lon: -112.11, lat: 36.08 };
/** The flying level they fly over. */
export const DOGFIGHT_WORLD = "/southwest-fly/";
/** The lobby's paths (D-143): the game's own, beside the other demos' on one server. */
export const DOGFIGHT_LOBBY = "/dogfight/api";
/** The fixed step both sides fly at (s): one input each. */
export const TICK = 1 / 60;
export const HP = 100;
export const GUN = {
  /** Seconds between rounds while the trigger is held. */
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
/** A crash within this many seconds of being hit counts for the shooter. */
export const CREDIT_S = 6;
/** Respawns land within this many cells of the start. */
export const SPAWN_SPREAD = 8;
/** A shooter's view is rewound by its lag for its hits, at most this much (s): more is a lagging or lying client. */
export const MAX_REWIND = 0.5;

/** A page's input for a tick: the stick, and the trigger. */
export interface DogfightInput extends PlaneInput {
  fire: boolean;
}

/** Who a page is: its name, and whether it only watches. */
export interface DogfightJoin {
  name: string;
  watch: boolean;
}

/** The bot's id: one flies whenever a pilot would be alone. */
export const BOT = "bot";

/** A match: a countdown with the guns cold, play to `kills` or `seconds`, the end screen, and the next. */
export const MATCH = { staging: 10, seconds: 300, kills: 10, ended: 10 };
export type MatchPhase = "staging" | "playing" | "ended";

/** The match in the shared snapshot: its phase and when that ends (server time; null: waiting for pilots), the kill limit, and the winner once it ended. */
export interface MatchNet {
  phase: MatchPhase;
  until: number | null;
  kills: number;
  winner: string | null;
}

/** A point in the planes' own space: cells across, heights in steps. */
export interface Point {
  x: number;
  y: number;
  h: number;
}

/** A round in flight: cells/s across, steps/s up. */
export interface Round extends Point {
  vx: number;
  vy: number;
  vh: number;
}

/**
 * One tick of a plane, the same on both sides: the flight model, then any −0
 * in its state made 0. JSON writes −0 as 0, so a page restoring the server's
 * state would otherwise step on from a different number than the server
 * (atan2 of a −0 and of a 0 differ by 2π), and its prediction drift after a
 * roll right round.
 */
export function flyTick(s: PlaneState, input: PlaneInput, world: PlaneWorld, p: PlaneParams): PlaneStep {
  const r = flyPlane(s, input, world, p, TICK);
  for (const k in s) (s as unknown as Record<string, number>)[k]! += 0;
  return r;
}

/** A round from a plane's nose: along it, or at the nearest target within the assist's angle and its reach. */
export function fireRound(s: PlaneState, p: PlaneParams, targets: Iterable<Point>): Round {
  const { f } = axes(s.yaw, s.pitch, s.roll);
  const k = PLANE.stepsPerCell;
  const v = s.speed + GUN.muzzle * PLANE.cruiseSpeed * p.pace;
  let dir: [number, number, number] = f;
  let best = GUN.assist;
  for (const t of targets) {
    const d: [number, number, number] = [t.x - s.x, t.y - s.y, (t.h - s.h) / k];
    const len = Math.hypot(...d);
    if (len === 0 || len > v * GUN.life) continue;
    const off = Math.acos(Math.max(-1, Math.min(1, (d[0] * f[0] + d[1] * f[1] + d[2] * f[2]) / len)));
    if (off < best) {
      best = off;
      dir = [d[0] / len, d[1] / len, d[2] / len];
    }
  }
  const half = p.length / 2;
  return { x: s.x + f[0] * half, y: s.y + f[1] * half, h: s.h + f[2] * half * k, vx: dir[0] * v, vy: dir[1] * v, vh: dir[2] * v * k };
}

/** How close a round passing from a to b comes to a plane at p (cells, in 3D). */
export function passes(a: Point, b: Point, p: Point): number {
  const k = PLANE.stepsPerCell;
  const d = [b.x - a.x, b.y - a.y, (b.h - a.h) / k] as const;
  const len2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
  const rel = [p.x - a.x, p.y - a.y, (p.h - a.h) / k] as const;
  const f = len2 ? Math.max(0, Math.min(1, (rel[0] * d[0] + rel[1] * d[1] + rel[2] * d[2]) / len2)) : 0;
  return Math.hypot(rel[0] - d[0] * f, rel[1] - d[1] * f, rel[2] - d[2] * f);
}

// ---------------------------------------------------------------- messages (the page's are `TickMessage<DogfightInput>`)

/** A plane in the shared snapshot: where it is drawn (its nose's yaw, the drawn pitch, its roll), its score, and which life it is on. */
/** A plane as replicated (D-123): where it is drawn, its heading, pitch and roll, health and life. */
export interface PlaneWire extends Point {
  hd: number;
  p: number;
  r: number;
  hp: number;
  /** Its deaths: a new life is drawn where it respawned at once, not slid there. */
  life: number;
}

/** A plane on the wire: to a 64th of a cell across, a 32nd of a step up, its angles in 1024ths of a turn. */
export const PLANE_WIRE = new Schema<PlaneWire>({ x: fixed(1 / 64), y: fixed(1 / 64), h: fixed(1 / 32), hd: angle(1024), p: angle(1024), r: angle(1024), hp: int, life: int });

/** Each pilot's name and score, sent when they change (`TickRoom.roster`, D-123). */
export interface DogfightRoster {
  pilots: Record<string, { name: string; kills: number; deaths: number; bot?: boolean }>;
}

/** A plane as the page has it: its replicated state and its roster entry. */
export interface PlaneNet extends PlaneWire {
  id: string;
  name: string;
  kills: number;
  deaths: number;
  bot?: boolean;
}

/** The planes a page has (their replicated states) with their names and scores. */
export function planesOf(states: ReadonlyMap<string, PlaneWire>, roster: DogfightRoster["pilots"]): PlaneNet[] {
  return [...states].map(([id, s]) => ({ id, ...s, name: "Pilot", kills: 0, deaths: 0, ...roster[id] }));
}

/**
 * An event (`TickRoom.emit`, at its server time): a page shows it when it
 * shows that time of the others. A round is named by its shooter and the
 * input it was fired on (`seq`), so a page matches it to the one it drew at once.
 */
export type DogfightEvent =
  | ({ kind: "fire"; by: string; seq: number } & Round)
  | { kind: "hit"; by: string; seq: number; to: string }
  | ({ kind: "down"; who: string; by: string | null } & Point)
  | { kind: "phase"; phase: MatchPhase; winner: string | null };

/** The shared snapshot: every plane, and the match. */
/** The shared snapshot's own part, beside the replicated planes. */
export interface DogfightWorldNet {
  match: MatchNet;
}

/** A player's own snapshot: its plane after its last input stepped. */
/** A plane's whole state, exactly (D-123): a player's own snapshot, which its prediction puts back as the server has it. */
export const PLANE_STATE = new Schema<PlaneState>({
  x: exact,
  y: exact,
  h: exact,
  heading: exact,
  speed: exact,
  climb: exact,
  bank: exact,
  rollRate: exact,
  alpha: exact,
  slip: exact,
  throttle: exact,
  yaw: exact,
  pitch: exact,
  roll: exact,
});

/** A player's own snapshot: its plane after its last input stepped (`PLANE_STATE`, in binary). */
export type DogfightSnap = PlaneState;

/** Only a plane's own fields of a snapshot (not its `k`, `t` and `ack`). */
export const planeOf = (snap: PlaneState): PlaneState => PLANE_STATE.value(PLANE_STATE.wire(snap));

/** What the lobby lists of a room: the match's phase and the seconds it has left. */
export interface DogfightInfo {
  phase: MatchPhase;
  left: number | null;
}
