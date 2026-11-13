import { axes, type PlaneInput, type PlaneParams, type PlaneState } from "./plane";
import { PLANE } from "./tuning";

/**
 * The dogfight's rules and messages, the same on the server
 * (dogfightServer.ts, which runs the game) and in the page (dogfight.ts,
 * which predicts its own plane and draws the rest): D-113.
 */

/** Where the planes start: over the inner canyon, between the village and Phantom Ranch. */
export const DOGFIGHT_START = { lon: -112.11, lat: 36.08 };
/** The fixed step both sides fly at (s): one input each. */
export const TICK = 1 / 60;
/** A snapshot every this many ticks: 20 a second. */
export const SNAPSHOT_TICKS = 3;
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

// ---------------------------------------------------------------- messages

/** The page to the server. `seen`: when what it draws of the others happened, on the server's clock (for rewinding its hits). */
export type ClientMsg = { k: "hello"; name: string } | { k: "in"; seq: number; i: PlaneInput; f: boolean; seen: number | null };

/** A plane in a snapshot: where it is drawn (its nose's yaw, the drawn pitch, its roll) and its score. */
export interface PlaneNet extends Point {
  id: string;
  name: string;
  hd: number;
  p: number;
  r: number;
  hp: number;
  kills: number;
  deaths: number;
  /** It respawned: don't slide it there. */
  jump?: boolean;
}

/** The server to the pages. A snapshot carries, for each page, the last input it stepped and that page's own plane after it. */
export type ServerMsg =
  | { k: "snap"; t: number; ack: number; you: PlaneState | null; planes: PlaneNet[] }
  | ({ k: "fire"; by: string } & Round)
  | { k: "hit"; by: string; to: string }
  | ({ k: "down"; who: string; by: string | null } & Point);
