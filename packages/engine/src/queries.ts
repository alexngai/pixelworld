import {
  LANE_COUNT,
  LANE_DIVIDED,
  LANE_ONEWAY,
  NO_WATER,
  ROAD_DIRS,
  roadConnects,
  unprojectAtHeight,
  type Rotation,
  type TerrainGrid,
} from "@pixelworlds/grid";
import type { StylePack } from "@pixelworlds/style";
import type { WorldManifest } from "@pixelworlds/world-format";
import type { LandmarkInfo, ObjectHit, PickResult, RoadInfo, SurfaceInfo, WorldQuery } from "./types";

/** The loaded terrain the queries read (a ChunkStore). */
export interface QuerySource {
  readonly cellsX: number;
  readonly cellsY: number;
  cell(x: number, y: number): { terrain: TerrainGrid; i: number } | null;
  surfaceHeightAt(x: number, y: number): number | null;
  realHeightAt(x: number, y: number, h: number): number;
  metersPerCellAt(x: number, y: number): number;
  ensureRect(x0: number, y0: number, x1: number, y1: number): Promise<void>;
}

/** Lon/lat ↔ cells (a GeoGrid). */
export interface GeoSource {
  cellToLonLat(x: number, y: number): [number, number];
  lonLatToCell(lon: number, lat: number): [number, number] | null;
}

/** Where the view stands, for picking: canvas pixels to render pixels. */
export interface PickView {
  rotation: Rotation;
  /** Whole-pixel top-left of the view (render px) and the sub-pixel remainder. */
  left: number;
  top: number;
  fracX: number;
  fracY: number;
  zoom: number;
  /** Device pixels per CSS pixel. */
  pixelRatio: number;
}

export interface QueryWorld {
  manifest: Pick<WorldManifest, "surfaces" | "roadClasses" | "scale">;
  style: Pick<StylePack, "roads">;
  renderScale: number;
  heightRange: [number, number];
}

/** Placed objects for occupancy queries (an ObjectIndex). */
export interface ObjectSource {
  at(x: number, y: number): ObjectHit[];
  landmarks(): LandmarkInfo[];
}

/** Height resolution of `pick`'s march along the view ray (steps). */
const PICK_STEP = 1 / 8;

export function createQuery(
  src: QuerySource,
  world: QueryWorld,
  geo: GeoSource | null,
  view: () => PickView,
  objects: ObjectSource | null = null,
): WorldQuery {
  const rs = world.renderScale;
  const { metersPerStep, elevationDatumMeters } = world.manifest.scale;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < src.cellsX && y < src.cellsY;

  const waterAt = (x: number, y: number): number | null => {
    const c = src.cell(x, y);
    if (!c) return null;
    const w = c.terrain.water[c.i]!;
    return w === NO_WATER ? null : w;
  };

  const heightAt = (x: number, y: number): number | null => (inside(x, y) ? src.surfaceHeightAt(x, y) : null);

  /** The top of what is drawn: the ground, or water standing over it. */
  const drawnTop = (x: number, y: number): number | null => {
    const g = heightAt(x, y);
    if (g === null) return null;
    const w = waterAt(x, y);
    return w === null ? g : Math.max(g, w);
  };

  return {
    heightAt,

    surfaceAt(x, y): SurfaceInfo | null {
      if (!inside(x, y)) return null;
      const c = src.cell(x, y);
      if (!c) return null;
      const id = c.terrain.surface[c.i]!;
      const w = c.terrain.water[c.i]!;
      return { id, name: world.manifest.surfaces[String(id)] ?? "unknown", waterLevel: w === NO_WATER ? null : w };
    },

    roadAt(x, y): RoadInfo | null {
      if (!inside(x, y)) return null;
      const c = src.cell(x, y);
      if (!c) return null;
      const t = c.terrain;
      const mask = t.road[c.i]!;
      const classId = t.roadClass[c.i]!;
      const connections = ROAD_DIRS.filter((_, d) => roadConnects(mask, d)).map(([dx, dy]) => [dx, dy] as [number, number]);
      if (!connections.length && classId === 0) return null;
      const name = world.manifest.roadClasses?.[String(classId)] ?? null;
      const real = t.roadWidth[c.i]!;
      // real half-widths are in 1/32 cell; the style's are render units, at most half a cell (as drawn)
      const styled = name ? world.style.roads?.classes[name]?.halfWidth : undefined;
      const half = real > 0 ? real / 32 : styled !== undefined ? Math.min(0.5, styled / rs) : 0;
      const lane = t.lane[c.i]!;
      return {
        classId,
        class: name,
        width: half * 2,
        connections,
        lanes: lane & LANE_COUNT,
        oneWay: (lane & LANE_ONEWAY) !== 0,
        divided: (lane & LANE_DIVIDED) !== 0,
      };
    },

    pick(screenX, screenY): PickResult | null {
      const v = view();
      // canvas CSS px → device px → render px (the palette pass: floor(device / zoom + frac))
      const sx = v.left + (screenX * v.pixelRatio) / v.zoom + v.fracX;
      const sy = v.top + (screenY * v.pixelRatio) / v.zoom + v.fracY;
      const at = (h: number): [number, number] => {
        const [ux, uy] = unprojectAtHeight(sx, sy, h * rs, v.rotation);
        return [ux / rs, uy / rs];
      };
      // March down the view ray from the highest ground: the first point under the drawn top is the hit.
      const [lo, hi] = world.heightRange;
      const above = (h: number) => {
        const [x, y] = at(h);
        const top = drawnTop(x, y);
        return top === null ? null : top < h;
      };
      let prev = hi + 1;
      for (let h = hi + 1 - PICK_STEP; h >= lo - 2; h -= PICK_STEP) {
        const a = above(h);
        if (a === false) {
          // refine between the last point above and this one
          let up = prev;
          let down = h;
          for (let k = 0; k < 24; k++) {
            const mid = (up + down) / 2;
            if (above(mid) === false) down = mid;
            else up = mid;
          }
          const [x, y] = at(down);
          const top = drawnTop(x, y) ?? down;
          return { x, y, h: top, cellX: Math.floor(x), cellY: Math.floor(y) };
        }
        prev = h;
      }
      return null;
    },

    lonLatToCell: (lon, lat) => (geo ? geo.lonLatToCell(lon, lat) : null),
    cellToLonLat: (x, y) => (geo ? geo.cellToLonLat(x, y) : null),

    elevationAt(x, y, h) {
      const drawn = h ?? heightAt(x, y);
      if (drawn === null) return null;
      return src.realHeightAt(x, y, drawn) * metersPerStep + elevationDatumMeters;
    },

    metersPerCellAt: (x, y) => src.metersPerCellAt(x, y),

    ensure: (x0, y0, x1, y1) => src.ensureRect(Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1)),

    objectsAt: (x, y) => (objects ? objects.at(x, y) : []),
    landmarks: () => (objects ? objects.landmarks() : []),
  };
}
