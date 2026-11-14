import type {
  ControllerView,
  Entity,
  EntityList,
  EntitySpec,
  ObjectHit,
  RoadInfo,
  SurfaceInfo,
  ViewCamera,
  WorldInfo,
  WorldQuery,
} from "@pixelworlds/engine";

/**
 * A small world for the game's tests, through the engine's public types
 * only: a grid of cells with heights, surfaces, water, roads (connections
 * and a class) and placed objects, and a fake view for controllers.
 */

export interface FakeCell {
  h: number;
  surface?: string;
  water?: number | null;
  road?: { cls: string; dirs: [number, number][] } | null;
}

export class FakeWorld {
  readonly cells: FakeCell[];
  objects: ObjectHit[] = [];

  constructor(
    readonly w: number,
    readonly hgt: number,
    fill: (x: number, y: number) => FakeCell = () => ({ h: 0 }),
  ) {
    this.cells = [];
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) this.cells.push(fill(x, y));
  }

  cell(x: number, y: number): FakeCell | null {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.hgt) return null;
    return this.cells[cy * this.w + cx]!;
  }

  /** Lay a road through cells, connecting each to the next (8 directions). */
  road(cls: string, path: [number, number][]): void {
    for (let i = 0; i < path.length; i++) {
      const [x, y] = path[i]!;
      const c = this.cell(x, y)!;
      c.road ??= { cls, dirs: [] };
      for (const j of [i - 1, i + 1]) {
        const o = path[j];
        if (!o) continue;
        const d: [number, number] = [Math.sign(o[0] - x), Math.sign(o[1] - y)];
        if (!c.road.dirs.some(([a, b]) => a === d[0] && b === d[1])) c.road.dirs.push(d);
      }
    }
  }

  query(): WorldQuery {
    const roadAt = (x: number, y: number): RoadInfo | null => {
      const c = this.cell(x, y);
      if (!c?.road) return null;
      return { classId: 1, class: c.road.cls, width: 0.25, connections: c.road.dirs, lanes: 0, oneWay: false, divided: false };
    };
    return {
      heightAt: (x, y) => this.cell(x, y)?.h ?? null,
      surfaceAt: (x, y): SurfaceInfo | null => {
        const c = this.cell(x, y);
        return c ? { id: 0, name: c.surface ?? "desert", waterLevel: c.water ?? null } : null;
      },
      roadAt,
      pick: () => null,
      lonLatToCell: (lon, lat) => {
        const x = lon * 100;
        const y = -lat * 100;
        return x < 0 || y < 0 || x > this.w || y > this.hgt ? null : [x, y];
      },
      cellToLonLat: (x, y) => [x / 100, -y / 100],
      elevationAt: (x, y, h) => (h ?? this.cell(x, y)?.h ?? 0) * 10,
      metersPerCellAt: () => 400,
      ensure: async () => {},
      isLoaded: () => true,
      coarseHeightAt: () => null,
      objectsAt: (x, y) =>
        this.objects.filter((o) => x >= o.bounds[0] && y >= o.bounds[1] && x <= o.bounds[2] && y <= o.bounds[3]),
      landmarks: () => [],
    };
  }
}

/** A building occupying a rectangle of cells. */
export function building(x0: number, y0: number, x1: number, y1: number, group = "building.house", top = 3): ObjectHit {
  return { group, id: null, x: (x0 + x1) / 2, y: (y0 + y1) / 2, bounds: [x0, y0, x1, y1], footprint: true, base: 0, top };
}

class FakeEntity implements Entity {
  reveal = null;
  pitch = 0;
  roll = 0;

  constructor(
    readonly id: number,
    public x: number,
    public y: number,
    public h: number,
    public heading: number,
    public visible: boolean,
    public silhouette: boolean,
    readonly spec: EntitySpec,
    private readonly list: FakeEntities,
  ) {}

  moveTo(x: number, y: number, h?: number): void {
    this.x = x;
    this.y = y;
    if (h !== undefined) this.h = h;
  }

  remove(): void {
    this.list.remove(this);
  }
}

class FakeEntities implements EntityList {
  items: FakeEntity[] = [];
  private next = 1;

  add(spec: EntitySpec): Entity {
    const e = new FakeEntity(this.next++, spec.x, spec.y, spec.h ?? 0, spec.heading ?? 0, spec.visible ?? true, spec.silhouette ?? false, spec, this);
    this.items.push(e);
    return e;
  }

  remove(entity: Entity): void {
    this.items = this.items.filter((e) => e !== entity);
  }

  list(): readonly Entity[] {
    return this.items;
  }
}

/** A controller's view of a fake world: a camera that records its focus, entities that record their specs. */
export function fakeView(world: FakeWorld, opts: { metersPerCell?: number; level?: string; heightRange?: [number, number] } = {}) {
  const focus = { x: 0, y: 0, h: 0 };
  const camera = {
    get x() {
      return focus.x;
    },
    get y() {
      return focus.y;
    },
    get h() {
      return focus.h;
    },
    rotation: 0,
    zoom: 2,
    autoZoom: false,
    internalWidth: 640,
    internalHeight: 360,
    setFocus(x: number, y: number, h: number) {
      focus.x = x;
      focus.y = y;
      focus.h = h;
    },
    lookAt: async () => true,
    pan() {},
    rotate() {},
    screenDirToGrid: (dx: number, dy: number) => [dx, dy],
  } as unknown as ViewCamera;
  const entities = new FakeEntities();
  const manifest = {
    id: "test",
    name: "Test",
    cellsX: world.w,
    cellsY: world.hgt,
    start: { x: 1, y: 1 },
    level: opts.level ?? "drive",
    scale: { metersPerCell: opts.metersPerCell ?? 400, metersPerStep: 50, elevationDatumMeters: 0 },
  };
  const info = {
    url: "/test/",
    manifest,
    style: {},
    palette: { rampIds: new Map([["marker", 1]]) },
    renderScale: 1,
    cellsX: world.w,
    cellsY: world.hgt,
    heightRange: opts.heightRange ?? [0, 10],
    floor: -2,
    hasGeo: true,
    objectCount: 0,
    level: manifest.level,
  } as unknown as WorldInfo;
  const view: ControllerView = { canvas: {} as HTMLCanvasElement, world: info, camera, entities, query: world.query(), pixelRatio: 1 };
  return { view, focus, entities };
}
