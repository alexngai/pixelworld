import { STEP_WORLD, SUN_DIR, rotationMat2, type Rotation } from "@pixelworld/grid";
import type { InstancedBatch, MeshData } from "@pixelworld/generators";
import { SHADES, type MaterialTables } from "@pixelworld/style";
import { asScene, lightBasis, lightBounds, pixelRect, screenBounds, type BakeScene, type Ownership } from "./bounds";
import { Uniforms, compileProgram, depthTexture, framebuffer, rgba8Texture, type GL } from "./gl";
import {
  COMPOSITE_FS,
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
  /** Shadow-map texel size in render units (default 0.03 × render scale). */
  shadowTexel?: number;
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
}

/**
 * Bump whenever bake output changes for the same inputs (shaders, passes,
 * generators). Persistent tile caches key on it.
 */
export const BAKE_VERSION = "m1.2";

const PAD = 2;
const MAX_SHADOW = 4096;

interface UploadedMesh {
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  count: number;
  /** Instance count for instanced batches; 0 for plain meshes. */
  instances: number;
}

/** Bakes meshes into indexed pixel art with depth. Runs in a worker or on the main thread. */
export class Baker {
  private shadowProg: WebGLProgram;
  private gProg: WebGLProgram;
  private compProg: WebGLProgram;
  private shadowU: Uniforms;
  private gU: Uniforms;
  private compU: Uniforms;
  private meshes = new WeakMap<MeshData, UploadedMesh>();
  private batches = new WeakMap<InstancedBatch, UploadedMesh>();
  private style: StyleParams | null = null;
  private emptyVao: WebGLVertexArrayObject;

  constructor(private readonly gl: GL) {
    this.shadowProg = compileProgram(gl, SHADOW_VS, SHADOW_FS);
    this.gProg = compileProgram(gl, GBUFFER_VS, GBUFFER_FS);
    this.compProg = compileProgram(gl, FULLSCREEN_VS, COMPOSITE_FS);
    this.shadowU = new Uniforms(gl, this.shadowProg);
    this.gU = new Uniforms(gl, this.gProg);
    this.compU = new Uniforms(gl, this.compProg);
    this.emptyVao = gl.createVertexArray()!;
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
    gl.bindVertexArray(null);
    return { vao, buffers, count: mesh.vertexCount, instances: batch ? batch.offsets.length / 3 : 0 };
  }

  private free(up: UploadedMesh): void {
    this.gl.deleteVertexArray(up.vao);
    up.buffers.forEach((b) => this.gl.deleteBuffer(b));
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
  }

  private drawScene(draws: UploadedMesh[]): void {
    const gl = this.gl;
    for (const d of draws) {
      if (!d.count) continue;
      gl.bindVertexArray(d.vao);
      if (d.instances) gl.drawArraysInstanced(gl.TRIANGLES, 0, d.count, d.instances);
      else gl.drawArrays(gl.TRIANGLES, 0, d.count);
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
    const ownedBounds = screenBounds(scene, rotation, owned);
    if (!ownedBounds) return null;
    const all = screenBounds(scene, rotation, "all")!;
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
      gl.useProgram(this.shadowProg);
      const u = this.shadowU;
      gl.uniformMatrix2fv(u.loc("uRot"), false, rot);
      gl.uniform1f(u.loc("uStepWorld"), STEP_WORLD);
      gl.uniform3fv(u.loc("uSun"), basis.sun);
      gl.uniform3fv(u.loc("uLightRight"), basis.right);
      gl.uniform3fv(u.loc("uLightUp"), basis.up);
      gl.uniform4fv(u.loc("uLightRect"), lb.rect);
      gl.uniform2fv(u.loc("uLightDepth"), lb.depth);
      this.drawScene(draws);
    }

    // 2. G-buffer: ramp, light level, AO, flags + depth
    const gTex = rgba8Texture(gl, gw, gh);
    const gDepth = depthTexture(gl, gw, gh);
    const gFb = framebuffer(gl, gTex, gDepth);
    gl.viewport(0, 0, gw, gh);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.gProg);
    {
      const u = this.gU;
      const t = style.tables;
      gl.uniformMatrix2fv(u.loc("uRot"), false, rot);
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
      gl.uniform1i(u.loc("uAsphaltRamp"), t.asphaltRamp);
      gl.uniform1i(u.loc("uMarkingRamp"), t.markingRamp);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, shadowTex);
      gl.uniform1i(u.loc("uShadowMap"), 0);
    }
    this.drawScene(draws);

    // 3. Composite: cleanup, AO dither, outlines → palette index + local depth
    const outTex = rgba8Texture(gl, rect.width, rect.height);
    const outFb = framebuffer(gl, outTex, null);
    gl.viewport(0, 0, rect.width, rect.height);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.compProg);
    {
      const u = this.compU;
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
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    for (const fb of [shadowFb, gFb, outFb]) if (fb) gl.deleteFramebuffer(fb);
    for (const tex of [shadowTex, gTex, gDepth, outTex]) if (tex) gl.deleteTexture(tex);

    return {
      image: { ...rect, depthBase, pixels },
      timings: { totalMs: performance.now() - t0, shadowMapSize: [sw, sh] },
    };
  }
}
