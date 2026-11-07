import { INDEX_SILHOUETTE } from "@pixelworld/style";
import {
  Uniforms,
  compileProgram,
  framebuffer,
  rgba8Texture,
  type BakedImage,
  type GL,
} from "@pixelworld/bake";

/**
 * Runtime compositor (architecture §8.2): draws baked tiles and sprites into
 * an index + depth framebuffer at internal resolution, then maps indices
 * through the palette and upscales by an integer zoom with a sub-pixel offset.
 */

const QUAD_VS = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRectOrigin;   // internal px, top-left
uniform vec2 uRectSize;
uniform vec2 uTarget;       // internal framebuffer size
void main() {
  vec2 unit = vec2(float(gl_VertexID == 1 || gl_VertexID == 2 || gl_VertexID == 4),
                   float(gl_VertexID == 2 || gl_VertexID == 4 || gl_VertexID == 5));
  vec2 p = uRectOrigin + unit * uRectSize;
  gl_Position = vec4(2.0 * p / uTarget - 1.0, 0.0, 1.0);  // row 0 = top of image
}
`;

const QUAD_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uImage;
uniform vec2 uRectOrigin;
uniform float uDepthBase;
uniform vec2 uDepthRange;
uniform int uMode;          // 0 = normal, 1 = occluded silhouette
uniform float uSilhouette;  // palette index / 255
out vec4 o;
void main() {
  ivec2 fp = ivec2(gl_FragCoord.xy);
  ivec2 tp = fp - ivec2(uRectOrigin);
  vec4 t = texelFetch(uImage, tp, 0);
  if (t.a < 0.5) discard;
  float local = (floor(t.g * 255.0 + 0.5) * 256.0 + floor(t.b * 255.0 + 0.5)) / 256.0;
  float d = uDepthBase + local;
  gl_FragDepth = clamp(1.0 - (d - uDepthRange.x) / (uDepthRange.y - uDepthRange.x), 0.0, 1.0);
  if (uMode == 1) {
    if (((fp.x + fp.y) & 1) == 1) discard;
    o = vec4(uSilhouette, 0.0, 0.0, 1.0);
  } else {
    o = vec4(t.r, 0.0, 0.0, 1.0);
  }
}
`;

const PALETTE_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

const PALETTE_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uIndex;
uniform highp sampler2D uPalette;
uniform vec2 uCanvas;
uniform float uZoom;
uniform vec2 uFrac;
uniform int uLut;
out vec4 o;
void main() {
  vec2 cp = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);
  ivec2 q = ivec2(floor(cp / uZoom + uFrac));
  int index = int(texelFetch(uIndex, q, 0).r * 255.0 + 0.5);
  o = texelFetch(uPalette, ivec2(index, uLut), 0);
}
`;

export interface GpuImage {
  image: BakedImage;
  texture: WebGLTexture;
}

export interface SpriteInstance {
  sprite: GpuImage;
  /** Screen position (absolute px) of the object's origin. */
  sx: number;
  sy: number;
  /** Depth of the object's origin. */
  depth: number;
  silhouette: boolean;
}

export interface FrameParams {
  left: number; // integer internal-px origin
  top: number;
  fracX: number;
  fracY: number;
  zoom: number;
  internalWidth: number;
  internalHeight: number;
  depthRange: [number, number];
}

export class Compositor {
  readonly gl: GL;
  private quadProg: WebGLProgram;
  private palProg: WebGLProgram;
  private quadU: Uniforms;
  private palU: Uniforms;
  private vao: WebGLVertexArrayObject;
  private paletteTex: WebGLTexture | null = null;
  private target: {
    w: number;
    h: number;
    color: WebGLTexture;
    depth: WebGLRenderbuffer;
    fb: WebGLFramebuffer;
  } | null = null;
  lut = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error("WebGL2 is required");
    this.gl = gl;
    this.quadProg = compileProgram(gl, QUAD_VS, QUAD_FS);
    this.palProg = compileProgram(gl, PALETTE_VS, PALETTE_FS);
    this.quadU = new Uniforms(gl, this.quadProg);
    this.palU = new Uniforms(gl, this.palProg);
    this.vao = gl.createVertexArray()!;
  }

  setPalette(rgba: Uint8Array, rows = 1): void {
    const gl = this.gl;
    if (this.paletteTex) gl.deleteTexture(this.paletteTex);
    this.paletteTex = rgba8Texture(gl, 256, rows, rgba);
  }

  upload(image: BakedImage): GpuImage {
    return { image, texture: rgba8Texture(this.gl, image.width, image.height, image.pixels) };
  }

  release(img: GpuImage): void {
    this.gl.deleteTexture(img.texture);
  }

  private ensureTarget(w: number, h: number) {
    const gl = this.gl;
    if (this.target && this.target.w === w && this.target.h === h) return this.target;
    if (this.target) {
      gl.deleteFramebuffer(this.target.fb);
      gl.deleteTexture(this.target.color);
      gl.deleteRenderbuffer(this.target.depth);
    }
    const color = rgba8Texture(gl, w, h);
    const fb = framebuffer(gl, color, null);
    const depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    this.target = { w, h, color, depth, fb };
    return this.target;
  }

  render(frame: FrameParams, tiles: GpuImage[], sprites: SpriteInstance[]): void {
    const gl = this.gl;
    // +1 so the sub-pixel offset never samples outside the target
    const w = frame.internalWidth + 1;
    const h = frame.internalHeight + 1;
    const t = this.ensureTarget(w, h);

    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.useProgram(this.quadProg);
    gl.bindVertexArray(this.vao);
    const u = this.quadU;
    gl.uniform2f(u.loc("uTarget"), w, h);
    gl.uniform2fv(u.loc("uDepthRange"), frame.depthRange);
    gl.uniform1f(u.loc("uSilhouette"), INDEX_SILHOUETTE / 255);
    gl.uniform1i(u.loc("uImage"), 0);
    gl.activeTexture(gl.TEXTURE0);

    const draw = (img: GpuImage, left: number, top: number, depthBase: number, mode: number) => {
      const x = left - frame.left;
      const y = top - frame.top;
      if (x >= w || y >= h || x + img.image.width <= 0 || y + img.image.height <= 0) return;
      gl.bindTexture(gl.TEXTURE_2D, img.texture);
      gl.uniform2f(u.loc("uRectOrigin"), x, y);
      gl.uniform2f(u.loc("uRectSize"), img.image.width, img.image.height);
      gl.uniform1f(u.loc("uDepthBase"), depthBase);
      gl.uniform1i(u.loc("uMode"), mode);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    for (const tile of tiles) draw(tile, tile.image.left, tile.image.top, tile.image.depthBase, 0);
    const spriteAt = (s: SpriteInstance) =>
      [
        s.sx + s.sprite.image.left,
        s.sy + s.sprite.image.top,
        s.depth + s.sprite.image.depthBase,
      ] as const;
    for (const s of sprites) {
      const [l, tp, d] = spriteAt(s);
      draw(s.sprite, l, tp, d, 0);
    }
    // Occluded parts of player sprites: dithered highlight where the depth test fails.
    gl.depthFunc(gl.GREATER);
    gl.depthMask(false);
    for (const s of sprites) {
      if (!s.silhouette) continue;
      const [l, tp, d] = spriteAt(s);
      draw(s.sprite, l, tp, d, 1);
    }
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.DEPTH_TEST);

    // Palette + integer upscale to the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.palProg);
    const p = this.palU;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.color);
    gl.uniform1i(p.loc("uIndex"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.uniform1i(p.loc("uPalette"), 1);
    gl.uniform2f(p.loc("uCanvas"), this.canvas.width, this.canvas.height);
    gl.uniform1f(p.loc("uZoom"), frame.zoom);
    gl.uniform2f(p.loc("uFrac"), frame.fracX, frame.fracY);
    gl.uniform1i(p.loc("uLut"), this.lut);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }
}
