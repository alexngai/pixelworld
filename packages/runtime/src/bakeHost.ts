import { TerrainGrid } from "@pixelworld/grid";
import { Baker } from "@pixelworld/bake";
import { buildBoxesMesh, buildTerrainMesh, type MeshData } from "@pixelworld/generators";
import type { FromWorker, ToWorker } from "./protocol";

/**
 * Executes bake requests against a WebGL2 context. Used inside the bake
 * worker, or directly on the main thread when workers can't create WebGL2.
 */
export class BakeHost {
  private baker: Baker;
  private grid: TerrainGrid | null = null;
  private init: Extract<ToWorker, { type: "init" }> | null = null;
  private meshCache = new Map<string, MeshData>();
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
          this.grid = new TerrainGrid(msg.cellsX, msg.cellsY, {
            base: msg.base,
            shape: msg.shape,
            surface: msg.surface,
            water: msg.water,
          });
          this.baker.setStyle(msg.style);
          this.meshCache.clear();
          break;
        case "bakeTile":
          this.bakeTile(msg.id, msg.rotation, msg.tx, msg.ty);
          break;
        case "bakeSprite": {
          const t0 = performance.now();
          const mesh = buildBoxesMesh(msg.boxes);
          const meshMs = performance.now() - t0;
          const res = this.baker.bake(mesh, msg.rotation, "all", { shadows: false });
          this.baker.release(mesh);
          this.reply(msg.id, res, meshMs, mesh.vertexCount);
          break;
        }
      }
    } catch (e) {
      this.post({ type: "error", id: "id" in msg ? msg.id : undefined, message: String(e) });
    }
  }

  private bakeTile(id: number, rotation: 0 | 1 | 2 | 3, tx: number, ty: number): void {
    const init = this.init;
    const grid = this.grid;
    if (!init || !grid) throw new Error("bake host not initialised");
    const s = init.tileSize;
    const owned = { x0: tx * s, y0: ty * s, x1: (tx + 1) * s, y1: (ty + 1) * s };
    const key = `${tx},${ty}`;
    const t0 = performance.now();
    let mesh = this.meshCache.get(key);
    if (!mesh) {
      const m = init.margin;
      mesh = buildTerrainMesh(
        grid,
        { x0: owned.x0 - m, y0: owned.y0 - m, x1: owned.x1 + m, y1: owned.y1 + m },
        { floor: init.floor },
      );
      this.meshCache.set(key, mesh);
      if (this.meshCache.size > BakeHost.MESH_CACHE) {
        const oldest = this.meshCache.keys().next().value!;
        this.baker.release(this.meshCache.get(oldest)!);
        this.meshCache.delete(oldest);
      }
    }
    const meshMs = performance.now() - t0;
    const res = this.baker.bake(mesh, rotation, owned, { shadows: true });
    this.reply(id, res, meshMs, mesh.vertexCount);
  }

  private reply(
    id: number,
    res: ReturnType<Baker["bake"]>,
    meshMs: number,
    vertices: number,
  ): void {
    const stats = {
      meshMs,
      bakeMs: res?.timings.totalMs ?? 0,
      vertices,
      shadowMapSize: res?.timings.shadowMapSize ?? ([0, 0] as [number, number]),
    };
    if (!res) {
      this.post({ type: "baked", id, image: null, stats });
      return;
    }
    this.post({ type: "baked", id, image: res.image, stats }, [res.image.pixels.buffer]);
  }
}
