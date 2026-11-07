/** Minimal WebGL2 helpers shared by the baker and the runtime compositor. */

export type GL = WebGL2RenderingContext;

export function compileProgram(gl: GL, vsSource: string, fsSource: string): WebGLProgram {
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(`shader compile failed: ${log}\n${numbered(src)}`);
    }
    return s;
  };
  const vs = shader(gl.VERTEX_SHADER, vsSource);
  const fs = shader(gl.FRAGMENT_SHADER, fsSource);
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(`program link failed: ${gl.getProgramInfoLog(p)}`);
  return p;
}

function numbered(src: string): string {
  return src
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(4)}: ${l}`)
    .join("\n");
}

/** Cached uniform locations for a program. */
export class Uniforms {
  private cache = new Map<string, WebGLUniformLocation | null>();
  constructor(
    private readonly gl: GL,
    private readonly program: WebGLProgram,
  ) {}
  loc(name: string): WebGLUniformLocation | null {
    let l = this.cache.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.program, name);
      this.cache.set(name, l);
    }
    return l;
  }
}

export function createTexture(
  gl: GL,
  width: number,
  height: number,
  internalFormat: number,
  format: number,
  type: number,
  data: ArrayBufferView | null = null,
): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, data);
  return t;
}

export function rgba8Texture(gl: GL, width: number, height: number, data: Uint8Array | null = null) {
  return createTexture(gl, width, height, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, data);
}

export function depthTexture(gl: GL, width: number, height: number) {
  return createTexture(gl, width, height, gl.DEPTH_COMPONENT32F, gl.DEPTH_COMPONENT, gl.FLOAT);
}

export function framebuffer(
  gl: GL,
  color: WebGLTexture | null,
  depth: WebGLTexture | null,
): WebGLFramebuffer {
  const fb = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  if (color) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
  if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
  gl.drawBuffers(color ? [gl.COLOR_ATTACHMENT0] : [gl.NONE]);
  gl.readBuffer(color ? gl.COLOR_ATTACHMENT0 : gl.NONE);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incomplete: 0x${status.toString(16)}`);
  return fb;
}
