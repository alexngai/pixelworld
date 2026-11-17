import { EDGE_NEIGHBOR, NO_WATER, PIECES, STEP_WORLD, SUN_DIR, rotateXY, rotationMat2, type Rotation } from "@pixelworlds/grid";
import { TEXEL_ROW, type InstancedBatch, type MeshData, type TerrainField } from "@pixelworlds/generators";
import { SHADES, type MaterialTables } from "@pixelworlds/style";
import { ISO_PROJECTION, asScene, lightBasis, lightBounds, pixelRect, screenBounds, type BakeScene, type Ownership, type Projection } from "./bounds";
import { Uniforms, compileProgram, createTexture, depthTexture, framebuffer, rgba8Texture, type GL } from "./gl";
import {
  COMPOSITE_FS,
  FIELD_AO_FS,
  FIELD_SHAPE_FS,
  FIELD_GBUFFER_FS,
  FIELD_GBUFFER_VS,
  FIELD_SHADOW_VS,
  FULLSCREEN_VS,
  GBUFFER_FS,
  GBUFFER_VS,
  SHADOW_FS,
  SHADOW_VS,
} from "./shaders";

/**
 * A baked image in indexed color with per-pixel depth.
 * pixels: RGBA8, row 0 = top. R = palette index, G/B = depth above `depthBase`
 * in 1/256 units (big-endian), A = 255 where covered, 0 where empty.
 */
export interface BakedImage {
  left: number;
  top: number;
  width: number;
  height: number;
  depthBase: number;
  pixels: Uint8Array;
}

export interface BakeTimings {
  totalMs: number;
  shadowMapSize: [number, number];
}

export interface BakeOptions {
  shadows: boolean;
  /** Meshes of the scene that cast shadows but aren't drawn (a tile's buildings, for its bare variant). */
  hide?: ReadonlySet<MeshData>;
  /** Shadow-map texel size in render units (default 0.03 × render scale). */
  shadowTexel?: number;
  /** How the world is laid out (default the iso view; `topDownProjection` from above, D-155). */
  projection?: Projection;
  /**
   * Buildings cut down (D-159): for each cell of a rectangle, the height
   * (render steps) the objects it owns are cut at, 0 for none; what's above
   * isn't drawn, and the inside of their far walls shows dark, as solid.
   */
  cut?: { x0: number; y0: number; w: number; h: number; heights: Float32Array };
}

export interface StyleParams {
  tables: MaterialTables;
  aoStrength: number;
  outlineThreshold: number;
  /**
   * Render units per world cell. 1 for normal worlds; below 1 for fine worlds
   * whose cells are drawn smaller than a 32 px tile (mesh positions are then
   * already scaled; patterns and road decals still work in world cells).
   */
  renderScale?: number;
  /**
   * Micro-terrain: tops at least `drop` micro-steps above a neighbouring
   * micro-cell are drawn as `rockSurface` (bare strata), except water and snow.
   */
  steepRock?: { drop: number; rockSurface: number; waterSurface: number; snowSurface: number };
}

// Persistent tile caches key on the bake code's identity, BAKE_CODE (code.ts, D-072): nothing to bump here.

const PAD = 2;
const MAX_SHADOW = 4096;
/** The texture unit of a mesh's texels (units 0–8 are the shadow map and the field textures). */
const TEXEL_UNIT = 9;
/** The texture unit of a field's ground shape (FIELD_SHAPE_FS). */
const SHAPE_UNIT = 10;
/** The cut-down heights (D-159). */
const CUT_UNIT = 11;

interface UploadedMesh {
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  count: number;
  /** Instance count for instanced batches; 0 for plain meshes. */
  instances: number;
  /** One-pixel lines (MeshData.primitive "lines", D-098), instanced or not: drawn as GL lines, and casting no shadow. */
  lines: boolean;
  /** The mesh's texels (MeshData.texels), or null. */
  texels: WebGLTexture | null;
}

/** uWallEdge for the water planes (shaders.ts WATER_PLANE). */
const WATER_PLANE = -2;

interface UploadedField {
  corners: WebGLTexture;
  cells: WebGLTexture;
  vmap: WebGLTexture;
  ways: WebGLTexture;
  rails: WebGLTexture;
  /** Centre-line pieces (D-082), or a 1×1 empty texture. */
  segs: WebGLTexture;
  ao: WebGLTexture;
  /** Natural ground's slope and hollowness at every micro-corner (FIELD_SHAPE_FS). */
  shape: WebGLTexture;
  instances: number;
  /** Per edge: an R32I texture (4096 per row) listing the micro-cells with a wall there. */
  walls: { list: WebGLTexture; count: number }[];
  /** Whether any cell has water: only then is the water plane drawn. */
  water: boolean;
}

/**
 * Instance order for a rotation: 1 where x (y) should run from high to low so
 * the nearest micro-cells (largest u + v) are drawn first.
 */
export function nearFirst(rotation: Rotation): [number, number] {
  const [ux, vx] = rotateXY(1, 0, rotation);
  const [uy, vy] = rotateXY(0, 1, rotation);
  return [ux + vx > 0 ? 1 : 0, uy + vy > 0 ? 1 : 0];
}

/** The two cell edges (0 N, 1 E, 2 S, 3 W) whose walls face the viewer in a rotation. */
export function frontEdges(rotation: Rotation): [number, number] {
  const out: number[] = [];
  EDGE_NEIGHBOR.forEach(([x, y], e) => {
    const [u, v] = rotateXY(x, y, rotation);
    if (u > 0.5 || v > 0.5) out.push(e);
  });
  return [out[0]!, out[1]!];
}

interface Program {
  prog: WebGLProgram;
  u: Uniforms;
}

/** Bakes meshes into indexed pixel art with depth. Runs in a worker or on the main thread. */
export class Baker {
  private shadow: Program;
  private g: Program;
  private comp: Program;
  private fieldShadow: Program;
  private fieldG: Program;
  private fieldAo: Program;
  private fieldShape: Program;
  private meshes = new WeakMap<MeshData, UploadedMesh>();
  private batches = new WeakMap<InstancedBatch, UploadedMesh>();
  private fields = new WeakMap<TerrainField, UploadedField>();
  private style: StyleParams | null = null;
  private emptyVao: WebGLVertexArrayObject;
  /** Bound for meshes without texels: the texel sampler wants an integer texture. */
  private noTexels: WebGLTexture;

  constructor(private readonly gl: GL) {
    const program = (vs: string, fs: string): Program => {
      const prog = compileProgram(gl, vs, fs);
      return { prog, u: new Uniforms(gl, prog) };
    };
    this.shadow = program(SHADOW_VS, SHADOW_FS);
    this.g = program(GBUFFER_VS, GBUFFER_FS);
    this.comp = program(FULLSCREEN_VS, COMPOSITE_FS);
    this.fieldShadow = program(FIELD_SHADOW_VS, SHADOW_FS);
    this.fieldG = program(FIELD_GBUFFER_VS, FIELD_GBUFFER_FS);
    this.fieldAo = program(FULLSCREEN_VS, FIELD_AO_FS);
    this.fieldShape = program(FULLSCREEN_VS, FIELD_SHAPE_FS);
    this.emptyVao = gl.createVertexArray()!;
    this.noTexels = createTexture(gl, 1, 1, gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(1));
  }

  setStyle(style: StyleParams): void {
    this.style = style;
  }

  upload(mesh: MeshData): UploadedMesh {
    const existing = this.meshes.get(mesh);
    if (existing) return existing;
    const up = this.createVao(mesh, null);
    this.meshes.set(mesh, up);
    return up;
  }

  uploadBatch(batch: InstancedBatch): UploadedMesh {
    const existing = this.batches.get(batch);
    if (existing) return existing;
    const up = this.createVao(batch.mesh, batch);
    this.batches.set(batch, up);
    return up;
  }

  private createVao(mesh: MeshData, batch: InstancedBatch | null): UploadedMesh {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buffers: WebGLBuffer[] = [];
    const attrib = (loc: number, data: Float32Array, size: number, divisor = 0) => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(loc, divisor);
      buffers.push(b);
    };
    attrib(0, mesh.position, 3);
    attrib(1, mesh.normal, 3);
    attrib(2, mesh.material, 3);
    attrib(3, mesh.cell, 2);
    attrib(4, mesh.road, 2);
    attrib(5, mesh.geology, 1);
    // Plain meshes leave 6/7 disabled: the generic value (0, 0, 0) applies.
    if (batch) {
      attrib(6, batch.offsets, 3, 1);
      attrib(7, batch.cells, 2, 1);
    }
    if (mesh.faceUv && mesh.faceRef) {
      attrib(8, mesh.faceUv, 2);
      attrib(9, mesh.faceRef, 4);
    }
    gl.bindVertexArray(null);
    const texels = mesh.texels?.length ? this.texelTexture(mesh.texels) : null;
    return { vao, buffers, count: mesh.vertexCount, instances: batch ? batch.offsets.length / 3 : 0, lines: mesh.primitive === "lines", texels };
  }

  /** Texels as an R8UI texture TEXEL_ROW wide, row after row. */
  private texelTexture(texels: Uint8Array): WebGLTexture {
    const gl = this.gl;
    const w = Math.min(TEXEL_ROW, texels.length);
    const h = Math.ceil(texels.length / w);
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (h > max) throw new Error(`a mesh's ${texels.length} texels need a ${w}×${h} texture; this GPU allows ${max} rows`);
    const data = texels.length === w * h ? texels : new Uint8Array(w * h);
    if (data !== texels) data.set(texels);
    return createTexture(gl, w, h, gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE, data);
  }

  private free(up: UploadedMesh): void {
    this.gl.deleteVertexArray(up.vao);
    up.buffers.forEach((b) => this.gl.deleteBuffer(b));
    if (up.texels) this.gl.deleteTexture(up.texels);
  }

  release(mesh: MeshData): void {
    const up = this.meshes.get(mesh);
    if (!up) return;
    this.free(up);
    this.meshes.delete(mesh);
  }

  /** Release GPU buffers of everything in a scene. */
  releaseScene(scene: MeshData | BakeScene): void {
    const sc = asScene(scene);
    for (const m of sc.meshes) this.release(m);
    for (const b of sc.batches) {
      const up = this.batches.get(b);
      if (!up) continue;
      this.free(up);
      this.batches.delete(b);
    }
    for (const f of sc.fields ?? []) {
      const up = this.fields.get(f);
      if (!up) continue;
      for (const t of [up.corners, up.cells, up.vmap, up.ways, up.rails, up.segs, up.ao, up.shape]) this.gl.deleteTexture(t);
      for (const w of up.walls) this.gl.deleteTexture(w.list);
      this.fields.delete(f);
    }
  }

  /** Upload a micro-terrain field and compute its corner AO (independent of rotation). */
  uploadField(f: TerrainField): UploadedField {
    const existing = this.fields.get(f);
    if (existing) return existing;
    const gl = this.gl;
    const mw = f.width * f.k;
    const mh = f.height * f.k;
    const corners = createTexture(gl, mw, mh, gl.RGBA16I, gl.RGBA_INTEGER, gl.SHORT, f.corners);
    const cells = createTexture(gl, f.width, f.height, gl.RGBA16I, gl.RGBA_INTEGER, gl.SHORT, f.cells);
    const vmap = createTexture(gl, f.width, f.height, gl.RG16I, gl.RG_INTEGER, gl.SHORT, f.vmap);
    const ways = createTexture(gl, f.width, f.height, gl.RGBA16I, gl.RGBA_INTEGER, gl.SHORT, f.ways);
    const rails = createTexture(gl, f.width, f.height, gl.R16I, gl.RED_INTEGER, gl.SHORT, f.rails);
    const segs = f.segs
      ? createTexture(gl, f.width * 3 * PIECES, f.height, gl.RGBA8UI, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, f.segs)
      : createTexture(gl, 1, 1, gl.RGBA8UI, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(4));
    // per micro-corner prepasses: AO, and natural ground's shape (D-095)
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.emptyVao);
    const [ao, shape] = [this.fieldAo, this.fieldShape].map(({ prog, u }) => {
      const tex = rgba8Texture(gl, mw + 1, mh + 1);
      const fb = framebuffer(gl, tex, null);
      gl.viewport(0, 0, mw + 1, mh + 1);
      gl.useProgram(prog);
      this.setFieldUniforms(u, f, corners, cells, vmap, ways, rails, segs, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      return tex;
    }) as [WebGLTexture, WebGLTexture];
    const walls = f.walls.map((list) => {
      const w = Math.max(1, Math.min(4096, list.length));
      const h = Math.max(1, Math.ceil(list.length / 4096));
      const data = new Int32Array(w * h);
      data.set(list);
      return { list: createTexture(gl, w, h, gl.R32I, gl.RED_INTEGER, gl.INT, data), count: list.length };
    });
    let water = false;
    for (let i = 3; i < f.cells.length && !water; i += 4) water = f.cells[i] !== NO_WATER;
    const up = { corners, cells, vmap, ways, rails, segs, ao, shape, instances: mw * mh, walls, water };
    this.fields.set(f, up);
    return up;
  }

  /** Field textures on units 1–3 and 5–7 (unit 0 is the shadow map, 4 the wall list) and the field's geometry uniforms. */
  private setFieldUniforms(
    u: Uniforms,
    f: TerrainField,
    corners: WebGLTexture,
    cells: WebGLTexture,
    vmap: WebGLTexture,
    ways: WebGLTexture,
    rails: WebGLTexture,
    segs: WebGLTexture,
    rotation: Rotation,
    ao: WebGLTexture | null = null,
  ): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, corners);
    gl.uniform1i(u.loc("uFieldCorners"), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, cells);
    gl.uniform1i(u.loc("uFieldCells"), 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, ao);
    gl.uniform1i(u.loc("uFieldAo"), 3);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, vmap);
    gl.uniform1i(u.loc("uFieldVmap"), 5);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, ways);
    gl.uniform1i(u.loc("uFieldWays"), 6);
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, rails);
    gl.uniform1i(u.loc("uFieldRails"), 7);
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, segs);
    gl.uniform1i(u.loc("uFieldSegs"), 8);
    gl.uniform1i(u.loc("uHasSegs"), f.segs ? 1 : 0);
    gl.uniform1i(u.loc("uWayReach"), f.wayReach);
    gl.uniform1i(u.loc("uK"), f.k);
    gl.uniform2i(u.loc("uSliceOrigin"), f.origin[0], f.origin[1]);
    gl.uniform2i(u.loc("uSliceSize"), f.width, f.height);
    gl.uniform2i(u.loc("uWorldSize"), f.world.width, f.world.height);
    gl.uniform1f(u.loc("uFloor"), f.floor);
    gl.uniform2iv(u.loc("uNearFirst"), nearFirst(rotation));
    gl.uniform1f(u.loc("uStepWorld"), STEP_WORLD);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** water: also draw the water planes (D-094; the G-buffer pass, not the shadow map's). */
  private drawFields(u: Uniforms, fields: TerrainField[], rotation: Rotation, water = false): void {
    const gl = this.gl;
    for (const f of fields) {
      const up = this.uploadField(f);
      this.setFieldUniforms(u, f, up.corners, up.cells, up.vmap, up.ways, up.rails, up.segs, rotation, up.ao);
      gl.activeTexture(gl.TEXTURE0 + SHAPE_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, up.shape);
      gl.uniform1i(u.loc("uFieldShape"), SHAPE_UNIT);
      gl.uniform1i(u.loc("uShores"), f.shores ? 1 : 0);
      gl.bindVertexArray(this.emptyVao);
      gl.uniform1i(u.loc("uWallList"), 4);
      // tops: every micro-cell
      gl.uniform1i(u.loc("uWallEdge"), -1);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, up.walls[0]!.list); // unused, but an integer texture
      gl.drawArrays(gl.TRIANGLES, 0, 6 * up.instances);
      // walls: only micro-cells that have one on an edge facing the viewer
      for (const e of frontEdges(rotation)) {
        const w = up.walls[e]!;
        if (!w.count) continue;
        gl.uniform1i(u.loc("uWallEdge"), e);
        gl.bindTexture(gl.TEXTURE_2D, w.list);
        gl.drawArrays(gl.TRIANGLES, 0, 6 * w.count);
      }
      if (water && f.shores && up.water) {
        gl.uniform1i(u.loc("uWallEdge"), WATER_PLANE);
        gl.bindTexture(gl.TEXTURE_2D, up.walls[0]!.list);
        gl.drawArrays(gl.TRIANGLES, 0, 6 * up.instances);
      }
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.bindVertexArray(null);
  }

  /** Draw meshes and batches; `texels`: bind each one's texels (the G-buffer pass). */
  private drawScene(draws: UploadedMesh[], texels = false): void {
    const gl = this.gl;
    for (const d of draws) {
      if (!d.count) continue;
      if (texels) {
        gl.activeTexture(gl.TEXTURE0 + TEXEL_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, d.texels ?? this.noTexels);
        gl.activeTexture(gl.TEXTURE0);
      }
      gl.bindVertexArray(d.vao);
      if (d.instances) gl.drawArraysInstanced(d.lines ? gl.LINES : gl.TRIANGLES, 0, d.count, d.instances);
      else gl.drawArrays(d.lines ? gl.LINES : gl.TRIANGLES, 0, d.count);
    }
  }

  /**
   * Bake the parts of `scene` owned by `owned` (a cell rectangle, or "all").
   * The rest of the scene is context: it casts shadows and occludes, and is
   * used for outlines, but its pixels are left empty for its own tile.
   */
  bake(
    input: MeshData | BakeScene,
    rotation: Rotation,
    owned: Ownership,
    options: BakeOptions,
  ): { image: BakedImage; timings: BakeTimings } | null {
    const style = this.style;
    if (!style) throw new Error("Baker.setStyle must be called before bake");
    const t0 = performance.now();
    const gl = this.gl;
    const scene = asScene(input);
    const proj = options.projection ?? ISO_PROJECTION;
    const ownedBounds = screenBounds(scene, rotation, owned, proj);
    if (!ownedBounds) return null;
    const all = screenBounds(scene, rotation, "all", proj)!;
    const rect = pixelRect(ownedBounds);
    const gw = rect.width + 2 * PAD;
    const gh = rect.height + 2 * PAD;
    const origin: [number, number] = [rect.left - PAD, rect.top - PAD];
    const depthRange: [number, number] = [all.minDepth - 1, all.maxDepth + 1];
    const depthBase = Math.floor(ownedBounds.minDepth);
    if (ownedBounds.maxDepth - depthBase >= 256)
      console.warn(
        `bake: tile depth span ${(ownedBounds.maxDepth - depthBase).toFixed(1)} exceeds the 16-bit local range; ` +
          "occlusion will clamp (reduce vertical exaggeration or tile size)",
      );
    const rot = rotationMat2(rotation);
    const basis = lightBasis(SUN_DIR);
    const draws = [...scene.meshes.map((m) => this.upload(m)), ...scene.batches.map((b) => this.uploadBatch(b))];
    const fields = scene.fields ?? [];
    fields.forEach((f) => this.uploadField(f)); // AO prepasses before any pass state is set
    const scale = style.renderScale ?? 1;

    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);

    // 1. Shadow map
    const lb = lightBounds(scene, rotation, owned, basis, 0.5 * scale);
    const texel = options.shadowTexel ?? 0.03 * scale;
    const sw = Math.min(MAX_SHADOW, Math.max(1, Math.ceil((lb.rect[2] - lb.rect[0]) / texel)));
    const sh = Math.min(MAX_SHADOW, Math.max(1, Math.ceil((lb.rect[3] - lb.rect[1]) / texel)));
    let shadowTex: WebGLTexture | null = null;
    let shadowFb: WebGLFramebuffer | null = null;
    if (options.shadows) {
      shadowTex = depthTexture(gl, sw, sh);
      shadowFb = framebuffer(gl, null, shadowTex);
      gl.viewport(0, 0, sw, sh);
      gl.clearDepth(1);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      for (const { prog, u } of [this.shadow, this.fieldShadow]) {
        gl.useProgram(prog);
        gl.uniformMatrix2fv(u.loc("uRot"), false, rot);
        gl.uniform1f(u.loc("uStepWorld"), STEP_WORLD);
        gl.uniform3fv(u.loc("uSun"), basis.sun);
        gl.uniform3fv(u.loc("uLightRight"), basis.right);
        gl.uniform3fv(u.loc("uLightUp"), basis.up);
        gl.uniform4fv(u.loc("uLightRect"), lb.rect);
        gl.uniform2fv(u.loc("uLightDepth"), lb.depth);
      }
      gl.useProgram(this.shadow.prog);
      this.drawScene(draws.filter((d) => !d.lines));
      if (fields.length) {
        gl.useProgram(this.fieldShadow.prog);
        this.drawFields(this.fieldShadow.u, fields, rotation);
      }
    }

    // the cut's heights, and which way the camera is: across the projection's screen axes, the way depth grows
    const cut = options.cut;
    const cutTex = cut ? createTexture(gl, cut.w, cut.h, gl.R32F, gl.RED, gl.FLOAT, cut.heights) : null;
    const [px, py, pd] = [proj.x, proj.y, proj.d];
    let toward = [px[1] * py[2] - px[2] * py[1], px[2] * py[0] - px[0] * py[2], px[0] * py[1] - px[1] * py[0]];
    if (toward[0]! * pd[0] + toward[1]! * pd[1] + toward[2]! * pd[2] < 0) toward = toward.map((v) => -v);

    // 2. G-buffer: ramp, light level, AO, flags + depth
    const gTex = rgba8Texture(gl, gw, gh);
    const gDepth = depthTexture(gl, gw, gh);
    const gFb = framebuffer(gl, gTex, gDepth);
    gl.viewport(0, 0, gw, gh);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    for (const { prog, u } of [this.g, this.fieldG]) {
      gl.useProgram(prog);
      const t = style.tables;
      gl.uniformMatrix2fv(u.loc("uRot"), false, rot);
      gl.uniform3fv(u.loc("uProjX"), proj.x);
      gl.uniform3fv(u.loc("uProjY"), proj.y);
      gl.uniform3fv(u.loc("uProjD"), proj.d);
      gl.uniform2f(u.loc("uOrigin"), origin[0], origin[1]);
      gl.uniform2f(u.loc("uSize"), gw, gh);
      gl.uniform2fv(u.loc("uDepthRange"), depthRange);
      gl.uniform1f(u.loc("uStepWorld"), STEP_WORLD);
      gl.uniform1f(u.loc("uScale"), scale);
      gl.uniform3fv(u.loc("uSun"), basis.sun);
      gl.uniform3fv(u.loc("uLightRight"), basis.right);
      gl.uniform3fv(u.loc("uLightUp"), basis.up);
      // A lit top face lands on shade 4; the right (+x) face two shades lower.
      const spacing = (basis.sun[2] - basis.sun[0]) / 2;
      gl.uniform3f(u.loc("uLightLevels"), basis.sun[2], spacing, 1.6);
      gl.uniform1i(u.loc("uShadowEnabled"), options.shadows ? 1 : 0);
      gl.uniform4fv(u.loc("uLightRect"), lb.rect);
      gl.uniform2fv(u.loc("uLightDepth"), lb.depth);
      const o = owned === "all" ? [-1e9, -1e9, 1e9, 1e9] : [owned.x0, owned.y0, owned.x1, owned.y1];
      gl.uniform4fv(u.loc("uOwned"), o);
      gl.uniform1f(u.loc("uAoStrength"), style.aoStrength);
      gl.uniform4fv(u.loc("uSurfaces"), t.surfaces);
      gl.uniform4fv(u.loc("uStrataMin"), t.strataMin);
      gl.uniform4iv(u.loc("uStrataRamp"), t.strataRamp);
      gl.uniform4iv(u.loc("uStrataCount"), t.strataCount);
      gl.uniform4iv(u.loc("uProvinceSet"), t.provinceSet);
      gl.uniform4fv(u.loc("uRoads"), t.roads);
      gl.uniform4fv(u.loc("uPaths"), t.paths);
      gl.uniform1i(u.loc("uAsphaltRamp"), t.asphaltRamp);
      gl.uniform1i(u.loc("uMarkingRamp"), t.markingRamp);
      gl.uniform1i(u.loc("uRailRamp"), t.railRamp);
      gl.uniform4fv(u.loc("uLanes"), t.lanes);
      gl.uniform1i(u.loc("uLaneRamp"), t.laneRamp);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, shadowTex);
      gl.uniform1i(u.loc("uShadowMap"), 0);
      gl.uniform1i(u.loc("uFaceTexels"), TEXEL_UNIT);
      gl.uniform1i(u.loc("uCutOn"), cutTex ? 1 : 0);
      gl.uniform1i(u.loc("uCutMask"), CUT_UNIT);
      gl.uniform2i(u.loc("uCutOrigin"), cut?.x0 ?? 0, cut?.y0 ?? 0);
      gl.uniform3fv(u.loc("uToward"), toward);
      const sr = style.steepRock;
      gl.uniform1i(u.loc("uSteepDrop"), sr?.drop ?? 0);
      gl.uniform1i(u.loc("uRockSurface"), sr?.rockSurface ?? -1);
      gl.uniform1i(u.loc("uWaterSurface"), sr?.waterSurface ?? -1);
      gl.uniform1i(u.loc("uSnowSurface"), sr?.snowSurface ?? -1);
    }
    gl.activeTexture(gl.TEXTURE0 + CUT_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, cutTex);
    gl.activeTexture(gl.TEXTURE0);
    gl.useProgram(this.g.prog);
    const hide = options.hide;
    // draws are the scene's meshes, then its batches
    this.drawScene(hide?.size ? draws.filter((_, i) => i >= scene.meshes.length || !hide.has(scene.meshes[i]!)) : draws, true);
    if (fields.length) {
      gl.useProgram(this.fieldG.prog);
      this.drawFields(this.fieldG.u, fields, rotation, true);
    }

    // 3. Composite: cleanup, AO dither, outlines → palette index + local depth
    const outTex = rgba8Texture(gl, rect.width, rect.height);
    const outFb = framebuffer(gl, outTex, null);
    gl.viewport(0, 0, rect.width, rect.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.comp.prog);
    {
      const u = this.comp.u;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, gTex);
      gl.uniform1i(u.loc("uG"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, gDepth);
      gl.uniform1i(u.loc("uDepth"), 1);
      gl.uniform2i(u.loc("uPad"), PAD, PAD);
      gl.uniform2i(u.loc("uOrigin"), rect.left, rect.top);
      gl.uniform2fv(u.loc("uDepthRange"), depthRange);
      gl.uniform1f(u.loc("uDepthBase"), depthBase);
      gl.uniform1f(u.loc("uOutlineThreshold"), style.outlineThreshold * scale);
      gl.uniform1i(u.loc("uShades"), SHADES);
    }
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const pixels = new Uint8Array(rect.width * rect.height * 4);
    gl.readPixels(0, 0, rect.width, rect.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    for (const unit of [CUT_UNIT, SHAPE_UNIT, TEXEL_UNIT, 8, 7, 6, 5, 4, 3, 2, 1, 0]) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    for (const fb of [shadowFb, gFb, outFb]) if (fb) gl.deleteFramebuffer(fb);
    for (const tex of [shadowTex, gTex, gDepth, outTex, cutTex]) if (tex) gl.deleteTexture(tex);

    return {
      image: { ...rect, depthBase, pixels },
      timings: { totalMs: performance.now() - t0, shadowMapSize: [sw, sh] },
    };
  }
}
