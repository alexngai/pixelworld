import type { RoadInfo } from "@pixelworlds/engine";

/**
 * The drawn road network as the game reads it, through `query.roadAt`: each
 * road cell's centre line runs from the cell's middle toward the neighbours
 * it connects to (as the bake draws it, and as traffic routes run).
 */

/** The road queries the game needs (a `WorldQuery` has them). */
export interface RoadQuery {
  roadAt(x: number, y: number): RoadInfo | null;
}

export interface Point {
  x: number;
  y: number;
}

/** Distance from a point to a segment. */
export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** Distance from a point to the centre line of one road cell (its half-segments toward its neighbours). */
export function cellRoadDistance(px: number, py: number, cx: number, cy: number, road: RoadInfo): number {
  const mx = cx + 0.5;
  const my = cy + 0.5;
  if (!road.connections.length) return Math.hypot(px - mx, py - my);
  let best = Infinity;
  for (const [dx, dy] of road.connections) best = Math.min(best, segmentDistance(px, py, mx, my, mx + dx * 0.5, my + dy * 0.5));
  return best;
}

/** The road under a point, if the point is on its drawn asphalt (its half-width plus `margin` cells from the centre line). */
export function roadUnder(q: RoadQuery, x: number, y: number, margin = 0): RoadInfo | null {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  let best: RoadInfo | null = null;
  let bestD = Infinity;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const road = q.roadAt(cx + i + 0.5, cy + j + 0.5);
      if (!road) continue;
      const d = cellRoadDistance(x, y, cx + i, cy + j, road);
      if (d <= road.width / 2 + margin && d < bestD) {
        best = road;
        bestD = d;
      }
    }
  return best;
}

/** The angle between two directions (0–π). */
export function angleBetween(a: number, b: number): number {
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

const NEIGHBOURS: [number, number][] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/**
 * Follow the road from a place along a heading, cell by cell: at each cell
 * the connection closest to the way it is going (at most `maxTurn` off),
 * never straight back. Where the road ends that way but another road cell
 * lies ahead beside it (a divided road's carriageways jogging at a junction),
 * it steps across. Returns the cell centres passed, the first one the cell
 * under the place; empty off the road.
 */
export function traceRoad(q: RoadQuery, x: number, y: number, heading: number, cells: number, maxTurn = (70 * Math.PI) / 180): Point[] {
  let cx = Math.floor(x);
  let cy = Math.floor(y);
  let road = q.roadAt(cx + 0.5, cy + 0.5);
  if (!road) return [];
  const out: Point[] = [{ x: cx + 0.5, y: cy + 0.5 }];
  let dir = heading;
  let from: [number, number] | null = null;
  for (let n = 0; n < cells && road; n++) {
    let pick: [number, number] | null = null;
    let pickTurn = maxTurn;
    for (const [dx, dy] of road.connections) {
      if (from && dx === -from[0] && dy === -from[1]) continue;
      const t = angleBetween(Math.atan2(dy, dx), dir);
      if (t <= pickTurn) {
        pick = [dx, dy];
        pickTurn = t;
      }
    }
    if (!pick) {
      // a road cell ahead and beside (within 50°) that the road doesn't connect to
      let jogTurn = Math.min(maxTurn, (50 * Math.PI) / 180);
      for (const [dx, dy] of NEIGHBOURS) {
        const t = angleBetween(Math.atan2(dy, dx), dir);
        if (t <= jogTurn && q.roadAt(cx + dx + 0.5, cy + dy + 0.5)) {
          pick = [dx, dy];
          jogTurn = t;
        }
      }
    }
    if (!pick) break;
    cx += pick[0];
    cy += pick[1];
    dir = Math.atan2(pick[1], pick[0]);
    from = pick;
    road = q.roadAt(cx + 0.5, cy + 0.5);
    if (!road) break;
    out.push({ x: cx + 0.5, y: cy + 0.5 });
  }
  return out;
}

/**
 * How far the road runs straight ahead of a place (cells): the traced road's
 * length while it stays within `slack` cells of the line along the heading.
 */
export function straightAhead(q: RoadQuery, x: number, y: number, heading: number, cells: number, slack = 0.75): number {
  const pts = traceRoad(q, x, y, heading, cells, Math.PI / 4);
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  let run = 0;
  for (const p of pts) {
    const along = (p.x - x) * c + (p.y - y) * s;
    const across = Math.abs(-(p.x - x) * s + (p.y - y) * c);
    if (across > slack || along < run - 1) break;
    run = Math.max(run, along);
  }
  return run;
}

/** The nearest road cell to a place within a radius (cells), by its centre; null without one. */
export function nearestRoad(q: RoadQuery, x: number, y: number, radius: number): (Point & { road: RoadInfo }) | null {
  let best: (Point & { road: RoadInfo }) | null = null;
  let bestD = Infinity;
  const r = Math.ceil(radius);
  for (let j = -r; j <= r; j++)
    for (let i = -r; i <= r; i++) {
      const cx = Math.floor(x) + i + 0.5;
      const cy = Math.floor(y) + j + 0.5;
      const d = Math.hypot(cx - x, cy - y);
      if (d > radius || d >= bestD) continue;
      const road = q.roadAt(cx, cy);
      if (!road) continue;
      best = { x: cx, y: cy, road };
      bestD = d;
    }
  return best;
}

/** The direction of a road cell's connection nearest a heading (radians), or the heading for a cell without any. */
export function roadDirection(road: RoadInfo, heading: number): number {
  let best = heading;
  let bestT = Infinity;
  for (const [dx, dy] of road.connections) {
    const a = Math.atan2(dy, dx);
    const t = angleBetween(a, heading);
    if (t < bestT) {
      best = a;
      bestT = t;
    }
  }
  return best;
}
