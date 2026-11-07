import { TerrainGrid } from "@pixelworld/grid";
import { Baker } from "@pixelworld/bake";
import { buildBoxesMesh, buildTerrainMesh, type MeshData } from "@pixelworld/generators";
import type { BakeTileMessage, FromWorker, InitMessage, ToWorker } from "./protocol";

/**
 * Executes bake requests against a WebGL2 context. Used inside the bake
 * worker, or directly on the main thread when workers can't create WebGL2.
 */
export class BakeHost {
  private baker: Baker;
  private init: InitMessage | null = null;
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
          this.baker.setStyle(msg.style);
          for (const m of this.meshCache.values()) this.baker.release(m);
          this.meshCache.clear();
          break;
        case "bakeTile":
          this.bakeTile(msg);
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

  private bakeTile(msg: BakeTileMessage): void {
    const init = this.init;
    if (!init) throw new Error("bake host not initialised");
    const s = init.tileSize;
    const owned = { x0: msg.tx * s, y0: msg.ty * s, x1: (msg.tx + 1) * s, y1: (msg.ty + 1) * s };
    const { slice } = msg;
    const key = `${msg.tx},${msg.ty}`;
    const t0 = performance.now();
    let mesh = this.meshCache.get(key);
    if (!mesh) {
      const grid = new TerrainGrid(slice.width, slice.height, slice.layers);
      mesh = buildTerrainMesh(
        grid,
        { x0: 0, y0: 0, x1: slice.width, y1: slice.height },
        {
          floor: init.floor,
          offset: [slice.x0, slice.y0],
          world: { width: init.worldWidth, height: init.worldHeight },
        },
      );
      this.meshCache.set(key, mesh);
      if (this.meshCache.size > BakeHost.MESH_CACHE) {
        const oldest = this.meshCache.keys().next().value!;
        this.baker.release(this.meshCache.get(oldest)!);
        this.meshCache.delete(oldest);
      }
    }
    const meshMs = performance.now() - t0;
    const res = this.baker.bake(mesh, msg.rotation, owned, { shadows: true });
    this.reply(msg.id, res, meshMs, mesh.vertexCount);
  }

  private reply(id: number, res: ReturnType<Baker["bake"]>, meshMs: number, vertices: number): void {
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
