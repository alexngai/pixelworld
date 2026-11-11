import { TerrainGrid } from "@pixelworlds/grid";
import { Baker, type BakeScene } from "@pixelworlds/bake";
import { applyHeroPaint } from "./heroPaint";
import {
  BIG_FOOTPRINT_CELLS,
  buildBoxesMesh,
  buildObjects,
  footprintBounds,
  occupiedCells,
  scatterInstances,
  buildTerrainField,
  buildTerrainMesh,
  objectVoxelScale,
  scaleMesh,
  type MeshData,
  type ModelFailure,
  type ObjectInstance,
} from "@pixelworlds/generators";
import type { BakeTileMessage, FromWorker, InitMessage, TerrainSlice, ToWorker, WorldObjects } from "./protocol";

/**
 * Executes bake requests against a WebGL2 context. Used inside the bake
 * worker, or directly on the main thread when workers can't create WebGL2.
 */
export class BakeHost {
  private baker: Baker;
  private init: InitMessage | null = null;
  private meshCache = new Map<string, BakeScene>();
  /** Models that failed to generate in a cached scene (D-072). */
  private readonly sceneFailures = new WeakMap<BakeScene, ModelFailure[]>();
  /** A cached scene's placed-objects mesh, left out of its bare variant. */
  private readonly sceneObjects = new WeakMap<BakeScene, MeshData>();
  private static readonly MESH_CACHE = 6;

  constructor(
    gl: WebGL2RenderingContext,
    private readonly post: (msg: FromWorker, transfer?: Transferable[]) => void,
  ) {
    this.baker = new Baker(gl);
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "unknown";
    this.post({ type: "ready", renderer });
  }

  handle(msg: ToWorker): void {
    try {
      switch (msg.type) {
        case "init":
          this.init = msg;
          this.baker.setStyle(msg.style);
          for (const m of this.meshCache.values()) this.baker.releaseScene(m);
          this.meshCache.clear();
          break;
        case "bakeTile":
          this.bakeTile(msg);
          break;
        case "bakeObjects": {
          const t0 = performance.now();
          const { slice } = msg;
          const grid = new TerrainGrid(slice.width, slice.height, { ...slice.layers, micro: slice.micro ?? null });
          const objects = this.init?.objects;
          if (!objects) throw new Error("bakeObjects needs a world with objects");
          const voxel = objectVoxelScale(this.init?.renderScale ?? 1);
          const built = buildObjects(msg.instances, {
            catalog: objects.catalog,
            rampIds: new Map(objects.rampIds),
            voxel,
            voxelMeters: voxel.h * objects.metersPerCell,
            heightStretch: objects.heightStretch,
            variants: objects.variants,
            heightAt: (x, y) => grid.surfaceHeightAt(x - slice.x0, y - slice.y0),
            texels: true,
          });
          const scene = { meshes: [built.merged], batches: built.batches };
          const meshMs = performance.now() - t0;
          const res = this.baker.bake(scene, msg.rotation, "all", { shadows: true });
          this.baker.releaseScene(scene);
          this.reply(msg.id, res, meshMs, built.merged.vertexCount, built.failures);
          break;
        }
        case "bakeSprite": {
          const t0 = performance.now();
          const mesh = buildBoxesMesh(msg.boxes);
          const meshMs = performance.now() - t0;
          const res = this.baker.bake(mesh, msg.rotation, "all", { shadows: true });
          this.baker.releaseScene(mesh);
          this.reply(msg.id, res, meshMs, mesh.vertexCount);
          break;
        }
      }
    } catch (e) {
      const where = msg.type === "bakeTile" ? `bake of tile ${msg.tx},${msg.ty} (rotation ${msg.rotation}) failed: ` : `${msg.type} failed: `;
      this.post({ type: "error", id: "id" in msg ? msg.id : undefined, message: where + String(e) });
    }
  }

  private bakeTile(msg: BakeTileMessage): void {
    const init = this.init;
    if (!init) throw new Error("bake host not initialised");
    const s = init.tileSize;
    const owned = { x0: msg.tx * s, y0: msg.ty * s, x1: (msg.tx + 1) * s, y1: (msg.ty + 1) * s };
    const { slice } = msg;
    const key = `${msg.tx},${msg.ty}`;
    const t0 = performance.now();
    let scene = this.meshCache.get(key);
    if (!scene) {
      const grid = new TerrainGrid(slice.width, slice.height, { ...slice.layers, micro: slice.micro ?? null });
      const world = { width: init.worldWidth, height: init.worldHeight };
      if (grid.micro) {
        // micro-terrain: the GPU builds the geometry from height textures
        const field = buildTerrainField(grid, { offset: [slice.x0, slice.y0], world, floor: init.floor });
        scene = { meshes: [], batches: [], fields: [field] };
      } else {
        const terrain = buildTerrainMesh(
          grid,
          { x0: 0, y0: 0, x1: slice.width, y1: slice.height },
          { floor: init.floor, offset: [slice.x0, slice.y0], world },
        );
        scene = { meshes: [terrain], batches: [] };
      }
      if (init.objects) {
        const objects = this.objectsFor(init.objects, slice, grid, init.renderScale ?? 1, owned);
        scene.meshes.push(objects.merged);
        scene.batches.push(...objects.batches);
        this.sceneObjects.set(scene, objects.merged);
        if (objects.failures.length) this.sceneFailures.set(scene, objects.failures);
      }
      const s = init.renderScale ?? 1;
      if (s !== 1) {
        for (const m of scene.meshes) scaleMesh(m, s);
        for (const b of scene.batches) {
          scaleMesh(b.mesh, s);
          for (let i = 0; i < b.offsets.length; i++) b.offsets[i]! *= s;
        }
      }
      this.meshCache.set(key, scene);
      if (this.meshCache.size > BakeHost.MESH_CACHE) {
        const oldest = this.meshCache.keys().next().value!;
        this.baker.releaseScene(this.meshCache.get(oldest)!);
        this.meshCache.delete(oldest);
      }
    }
    const meshMs = performance.now() - t0;
    // ponytail: a bare variant whose scene left the cache meshes the tile again; bake both together if that shows
    const objects = msg.bare ? this.sceneObjects.get(scene) : undefined;
    const res = this.baker.bake(scene, msg.rotation, owned, { shadows: true, ...(objects ? { hide: new Set([objects]) } : {}) });
    // painted-over hero landmarks go on after every bake, so they survive re-bakes (not on bare tiles: no landmarks there)
    if (res?.image && init.heroes?.length && !msg.bare) applyHeroPaint(res.image, msg.rotation, init.heroes);
    const vertices =
      scene.meshes.reduce((n, m) => n + m.vertexCount, 0) +
      scene.batches.reduce((n, b) => n + (b.mesh.vertexCount * b.offsets.length) / 3, 0) +
      (scene.fields ?? []).reduce((n, f) => n + f.width * f.height * f.k * f.k * 18, 0);
    // every bake of the tile (each rotation) reports its failed models: such a tile isn't kept in the persistent cache
    this.reply(msg.id, res, meshMs, vertices, this.sceneFailures.get(scene));
  }

  /**
   * Objects whose base point lies in the slice, built in world units, plus the
   * decorative scatter (M3) of the tile's cells and a two-cell ring around them
   * (enough for anything that leans into the tile).
   */
  private objectsFor(
    objects: WorldObjects,
    slice: TerrainSlice,
    grid: TerrainGrid,
    renderScale: number,
    owned: { x0: number; y0: number; x1: number; y1: number },
  ) {
    const sx1 = slice.x0 + slice.width;
    const sy1 = slice.y0 + slice.height;
    // big footprints (bridges) reach into slices far from their anchor
    const inSlice = (o: ObjectInstance) => {
      if (o.x >= slice.x0 && o.y >= slice.y0 && o.x < sx1 && o.y < sy1) return true;
      if (!o.fp) return false;
      const [x0, y0, x1, y1] = footprintBounds(o.fp);
      return x1 - x0 > BIG_FOOTPRINT_CELLS / 2 || y1 - y0 > BIG_FOOTPRINT_CELLS / 2
        ? x1 >= slice.x0 && y1 >= slice.y0 && x0 < sx1 && y0 < sy1
        : false;
    };
    const placed = objects.instances.filter(inSlice);
    let instances = placed;
    if (objects.scatter && objects.scatter.density > 0) {
      const origin: [number, number] = [slice.x0, slice.y0];
      const occupied = occupiedCells(placed, origin, slice.width, slice.height);
      const ring = 2;
      const rect = {
        x0: owned.x0 - ring - slice.x0,
        y0: owned.y0 - ring - slice.y0,
        x1: owned.x1 + ring - slice.x0,
        y1: owned.y1 + ring - slice.y0,
      };
      instances = placed.concat(scatterInstances(grid, origin, rect, objects.scatter, occupied));
    }
    const voxel = objectVoxelScale(renderScale);
    return buildObjects(instances, {
      catalog: objects.catalog,
      rampIds: new Map(objects.rampIds),
      voxel,
      voxelMeters: voxel.h * objects.metersPerCell,
      heightStretch: objects.heightStretch,
      variants: objects.variants,
      heightAt: (x, y) => grid.surfaceHeightAt(x - slice.x0, y - slice.y0), // clamps to the slice
      texels: true, // a facade of windows is one face, its colours texels (about a tenth of the vertices)
    });
  }

  private reply(id: number, res: ReturnType<Baker["bake"]>, meshMs: number, vertices: number, failures: ModelFailure[] = []): void {
    const stats = {
      meshMs,
      bakeMs: res?.timings.totalMs ?? 0,
      vertices,
      shadowMapSize: res?.timings.shadowMapSize ?? ([0, 0] as [number, number]),
    };
    const failed = failures.length ? { failures } : {};
    if (!res) {
      this.post({ type: "baked", id, image: null, stats, ...failed });
      return;
    }
    this.post({ type: "baked", id, image: res.image, stats, ...failed }, [res.image.pixels.buffer]);
  }
}
