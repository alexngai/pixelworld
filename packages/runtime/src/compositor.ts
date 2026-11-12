import { INDEX_SILHOUETTE } from "@pixelworlds/style";
import {
  Uniforms,
  compileProgram,
  framebuffer,
  rgba8Texture,
  type BakedImage,
  type GL,
} from "@pixelworlds/bake";
import type { FogField } from "./fog";
import { FogPass, type FogFrame } from "./fogPass";

/** How far back (depth units) `behind` tiles are drawn: beyond a depth's 1/256 quantisation, short of anything standing in front. */
const BEHIND_DEPTH = 0.5;

/**
 * Runtime compositor (architecture §8.2): draws baked tiles and sprites into
 * an index + depth framebuffer at the canvas's own resolution, each art pixel
 * a zoom × zoom block, then maps indices through the palette. Tiles sit on
 * the art-pixel grid; sprites may sit between its lines (to the canvas
 * pixel), so a moving sprite glides over the world instead of stepping a whole
 * art pixel at a time, and the camera's sub-pixel offset is just where the
 * blocks fall. An atmosphere pass (fog) may rewrite the indices in between,
 * reading the depth the tiles also write beside each index; without one the
 * palette pass reads the indices directly. Dithers (fog, the reveal, the
 * silhouette) are worked out per art pixel, so they stay pixel art.
 */

const QUAD_VS = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRectOrigin;   // target px, top-left
uniform vec2 uRectSize;     // art px
uniform float uZoom;        // target px per art px
uniform vec2 uTarget;       // framebuffer size (target px)
void main() {
  vec2 unit = vec2(float(gl_VertexID == 1 || gl_VertexID == 2 || gl_VertexID == 4),
                   float(gl_VertexID == 2 || gl_VertexID == 4 || gl_VertexID == 5));
  vec2 p = uRectOrigin + unit * uRectSize * uZoom;
  gl_Position = vec4(2.0 * p / uTarget - 1.0, 0.0, 1.0);  // row 0 = top of image
}
`;

const QUAD_FS = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uImage;
uniform vec2 uRectOrigin;   // target px
uniform vec2 uRectArt;      // absolute screen (art) px of the image's top-left
uniform float uZoom;
uniform float uDepthBase;
uniform vec2 uDepthRange;
uniform int uMode;          // 0 = normal, 1 = occluded silhouette, 2 = bare tile inside the reveal
uniform float uSilhouette;  // palette index / 255
uniform int uRevealOn;      // tiles in front of a player see-through (normal mode)
uniform vec4 uReveal;       // the reveal ellipse: centre, radii (absolute art px)
uniform float uRevealS;     // the player's u + v
uniform float uRevealDensity;
out vec4 o;

const float BAYER[16] = float[16](
   0.0,  8.0,  2.0, 10.0,
  12.0,  4.0, 14.0,  6.0,
   3.0, 11.0,  1.0,  9.0,
  15.0,  7.0, 13.0,  5.0);

void main() {
  // the image's art pixel under this target pixel, and where that art pixel is on the (absolute) screen
  vec2 tf = floor((gl_FragCoord.xy - uRectOrigin) / uZoom);
  ivec2 tp = ivec2(tf);
  vec2 art = uRectArt + tf + 0.5;
  vec4 t = texelFetch(uImage, tp, 0);
  if (t.a < 0.5) discard;
  float local = (floor(t.g * 255.0 + 0.5) * 256.0 + floor(t.b * 255.0 + 0.5)) / 256.0;
  float d = uDepthBase + local;
  float z = clamp(1.0 - (d - uDepthRange.x) / (uDepthRange.y - uDepthRange.x), 0.0, 1.0);
  if (uRevealOn == 1 || uMode == 2) {
    float r = length((art - uReveal.xy) / uReveal.zw);
    if (uMode == 2) {
      if (r >= 1.0) discard;  // a bare tile fills only the reveal, where the tiles let it through
    } else if (r < 1.0) {
      // sx = 16(u − v), sy = 8(u + v) − 8h, depth = u + v + h/3: the surface's u + v from sy and depth
      float s = art.y / 32.0 + 0.75 * d;
      if (s > uRevealS + 0.5) {
        ivec2 ap = ivec2(floor(art));
        float k = uRevealDensity * smoothstep(1.0, 0.7, r);  // a dithered edge
        if ((BAYER[(ap.y & 3) * 4 + (ap.x & 3)] + 0.5) / 16.0 < k) discard;
      }
    }
  }
  gl_FragDepth = z;
  if (uMode == 1) {
    if (((tp.x + tp.y) & 1) == 1) discard;  // a checker on the sprite's own art pixels
    o = vec4(uSilhouette, 0.0, 0.0, 1.0);
  } else {
    // the depth again, 24 bits in the spare channels, for atmosphere passes
    // (cheaper to read back than a depth texture; the palette pass reads R only)
    float e = floor(z * 16777215.0 + 0.5);
    o = vec4(t.r, floor(e / 65536.0) / 255.0, mod(floor(e / 256.0), 256.0) / 255.0, mod(e, 256.0) / 255.0);
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
uniform int uLut;
out vec4 o;
void main() {
  ivec2 q = ivec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y);  // the target's rows run top down
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
  /** Screen position (absolute art px) of the object's origin: fractions place it between art pixels. */
  sx: number;
  sy: number;
  /** Depth of the object's origin. */
  depth: number;
  silhouette: boolean;
  /**
   * Show what this sprite stands behind (D-079): within `margin` px of it,
   * world pixels in front of it are dithered away (`density` of them, 0–1)
   * over the bare tiles (`TileRequest.bare`). The first such sprite of a frame counts.
   */
  reveal?: Reveal | null;
}

export interface Reveal {
  margin: number;
  density: number;
}

/** The ellipse a revealing sprite clears (absolute screen px), for choosing bare tiles. */
export function revealRect(s: SpriteInstance): { left: number; top: number; right: number; bottom: number } | null {
  if (!s.reveal) return null;
  const img = s.sprite.image;
  const m = s.reveal.margin;
  const left = s.sx + img.left - m;
  const top = s.sy + img.top - m;
  return { left, top, right: left + img.width + 2 * m, bottom: top + img.height + 2 * m };
}

export interface FrameParams {
  left: number; // integer internal-px origin
  top: number;
  fracX: number;
  fracY: number;
  zoom: number;
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
    /** The fog pass's output, made when a frame first has fog. */
    fogColor: WebGLTexture | null;
    fogFb: WebGLFramebuffer | null;
  } | null = null;
  private fogPass: FogPass | null = null;
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

  private releaseTarget(): void {
    const gl = this.gl;
    const t = this.target;
    if (!t) return;
    gl.deleteFramebuffer(t.fb);
    gl.deleteTexture(t.color);
    gl.deleteRenderbuffer(t.depth);
    if (t.fogFb) gl.deleteFramebuffer(t.fogFb);
    if (t.fogColor) gl.deleteTexture(t.fogColor);
    this.target = null;
  }

  /**
   * Let go of the compositor's own GPU objects (programs, frame targets,
   * palette, fog pass). The canvas's context stays: another compositor may
   * share it (a view replacing another on the same canvas). Textures handed
   * out by `upload` are the owner's to release.
   */
  dispose(): void {
    const gl = this.gl;
    this.releaseTarget();
    if (this.paletteTex) gl.deleteTexture(this.paletteTex);
    this.paletteTex = null;
    this.fogPass?.dispose();
    this.fogPass = null;
    gl.deleteProgram(this.quadProg);
    gl.deleteProgram(this.palProg);
    gl.deleteVertexArray(this.vao);
  }

  private ensureTarget(w: number, h: number) {
    const gl = this.gl;
    if (this.target && this.target.w === w && this.target.h === h) return this.target;
    this.releaseTarget();
    const color = rgba8Texture(gl, w, h);
    const fb = framebuffer(gl, color, null);
    const depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    this.target = { w, h, color, depth, fb, fogColor: null, fogFb: null };
    return this.target;
  }

  /** The fog layer's coverage over the world's cells (null: no fog). */
  setFogField(field: FogField | null): void {
    if (!field && !this.fogPass) return;
    this.fogPass ??= new FogPass(this.gl);
    this.fogPass.setField(field);
  }

  /**
   * Draw a frame. With `bare` tiles (those under a revealing sprite, all of
   * them baked), the first sprite with `reveal` sees through what stands in
   * front of it. `behind` (tiles' ground alone, while they bake) fills only
   * what nothing else covers: drawn a little further back than it stands.
   */
  render(
    frame: FrameParams,
    tiles: GpuImage[],
    sprites: SpriteInstance[],
    fog: FogFrame | null = null,
    bare: GpuImage[] = [],
    behind: GpuImage[] = [],
  ): void {
    const gl = this.gl;
    // the canvas's own pixels; the view's top-left in absolute art px, and target px per art px
    const w = this.canvas.width;
    const h = this.canvas.height;
    const t = this.ensureTarget(w, h);
    const ox = frame.left + frame.fracX;
    const oy = frame.top + frame.fracY;
    const k = frame.zoom;

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
    gl.uniform1f(u.loc("uZoom"), k);
    gl.uniform2fv(u.loc("uDepthRange"), frame.depthRange);
    gl.uniform1f(u.loc("uSilhouette"), INDEX_SILHOUETTE / 255);
    gl.uniform1i(u.loc("uImage"), 0);
    gl.activeTexture(gl.TEXTURE0);

    const draw = (img: GpuImage, left: number, top: number, depthBase: number, mode: number) => {
      const x = (left - ox) * k;
      const y = (top - oy) * k;
      if (x >= w || y >= h || x + img.image.width * k <= 0 || y + img.image.height * k <= 0) return;
      gl.bindTexture(gl.TEXTURE_2D, img.texture);
      gl.uniform2f(u.loc("uRectOrigin"), x, y);
      gl.uniform2f(u.loc("uRectArt"), left, top);
      gl.uniform2f(u.loc("uRectSize"), img.image.width, img.image.height);
      gl.uniform1f(u.loc("uDepthBase"), depthBase);
      gl.uniform1i(u.loc("uMode"), mode);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    const spriteAt = (s: SpriteInstance) =>
      [
        s.sx + s.sprite.image.left,
        s.sy + s.sprite.image.top,
        s.depth + s.sprite.image.depthBase,
      ] as const;
    const rv = bare.length ? sprites.find((s) => s.reveal) : undefined;
    const box = rv && revealRect(rv);
    if (box) {
      // the ellipse in absolute art px
      gl.uniform4f(u.loc("uReveal"), (box.left + box.right) / 2, (box.top + box.bottom) / 2, (box.right - box.left) / 2, (box.bottom - box.top) / 2);
      gl.uniform1f(u.loc("uRevealS"), rv!.sy / 32 + 0.75 * rv!.depth); // its u + v, as the shader works it out
      gl.uniform1f(u.loc("uRevealDensity"), Math.min(1, Math.max(0, rv!.reveal!.density)));
    }
    gl.uniform1i(u.loc("uRevealOn"), box ? 1 : 0);
    for (const tile of tiles) draw(tile, tile.image.left, tile.image.top, tile.image.depthBase, 0);
    gl.uniform1i(u.loc("uRevealOn"), 0);
    // the bare tiles fill what the reveal let through: the depth test keeps what's still there
    if (box) for (const tile of bare) draw(tile, tile.image.left, tile.image.top, tile.image.depthBase, 2);
    // a tile's own baked ground is at the same depth as its ground alone: pushed back, the baked one wins
    for (const tile of behind) draw(tile, tile.image.left, tile.image.top, tile.image.depthBase - BEHIND_DEPTH, 0);
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

    // Atmosphere: fog dithered into the indices, from the depth beside them.
    let shown = t.color;
    if (fog && this.fogPass?.hasField) {
      if (!t.fogFb) {
        t.fogColor = rgba8Texture(gl, w, h);
        t.fogFb = framebuffer(gl, t.fogColor, null);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fogFb);
      gl.viewport(0, 0, w, h);
      this.fogPass.draw(fog, t.color, [ox, oy], k, frame.depthRange);
      shown = t.fogColor!;
    }

    // Palette + integer upscale to the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.palProg);
    const p = this.palU;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, shown);
    gl.uniform1i(p.loc("uIndex"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.uniform1i(p.loc("uPalette"), 1);
    gl.uniform2f(p.loc("uCanvas"), this.canvas.width, this.canvas.height);
    gl.uniform1i(p.loc("uLut"), this.lut);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }
}
