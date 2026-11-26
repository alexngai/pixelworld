/**
 * A layer drawn pixel by pixel (D-193): the fight's action indicators (arrows,
 * where a strike lands, a push's ghost, a shot) as pixel art over the screen,
 * flat, at the world's own pixel size. Drawn into a small buffer, no
 * antialiasing, then laid over the screen scaled up without smoothing.
 */

/** A colour as the buffer holds it (little-endian RGBA). */
export const rgba = (r: number, g: number, b: number, a = 255) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;

export class PixelLayer {
  readonly canvas = document.createElement("canvas");
  private readonly g = this.canvas.getContext("2d")!;
  private img: ImageData | null = null;
  private buf = new Uint32Array(0);
  w = 0;
  h = 0;

  /** Size it (pixels) and clear it. */
  begin(w: number, h: number): void {
    if (w !== this.w || h !== this.h || !this.img) {
      [this.w, this.h] = [w, h];
      [this.canvas.width, this.canvas.height] = [w, h];
      this.img = this.g.createImageData(w, h);
      this.buf = new Uint32Array(this.img.data.buffer);
    }
    this.buf.fill(0);
  }

  set(x: number, y: number, c: number): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.buf[y * this.w + x] = c;
  }

  /** A square `size` pixels across centred on a pixel. */
  dot(x: number, y: number, size: number, c: number): void {
    const r = Math.floor((size - 1) / 2);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) this.set(x - r + i, y - r + j, c);
  }

  /** The pixels from one point to another (Bresenham), each once. */
  static line(x0: number, y0: number, x1: number, y1: number, out: [number, number][] = []): [number, number][] {
    [x0, y0, x1, y1] = [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)];
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      const last = out[out.length - 1];
      if (!last || last[0] !== x0 || last[1] !== y0) out.push([x0, y0]);
      if (x0 === x1 && y0 === y1) return out;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  /** The pixels along a polyline, each once. */
  static path(pts: readonly [number, number][]): [number, number][] {
    const out: [number, number][] = [];
    for (let n = 1; n < pts.length; n++) PixelLayer.line(pts[n - 1]![0], pts[n - 1]![1], pts[n]![0], pts[n]![1], out);
    return out;
  }

  /** A polygon filled (even-odd scanlines); `dither` fills every other pixel, a checkerboard, for something seen through. */
  fill(pts: readonly [number, number][], c: number, dither = false): void {
    const ys = pts.map((p) => p[1]);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(this.h - 1, Math.ceil(Math.max(...ys)));
    for (let y = y0; y <= y1; y++) {
      const xs: number[] = [];
      for (let n = 0; n < pts.length; n++) {
        const [ax, ay] = pts[n]!;
        const [bx, by] = pts[(n + 1) % pts.length]!;
        if ((ay <= y + 0.5 && by > y + 0.5) || (by <= y + 0.5 && ay > y + 0.5)) xs.push(ax + ((y + 0.5 - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((p, q) => p - q);
      for (let n = 0; n + 1 < xs.length; n += 2)
        for (let x = Math.ceil(xs[n]! - 0.5); x <= Math.floor(xs[n + 1]! - 0.5); x++) if (!dither || (x + y) % 2 === 0) this.set(x, y, c);
    }
  }

  /** Done: the buffer onto its canvas, to lay over the screen (`drawImage` with smoothing off). */
  end(): HTMLCanvasElement {
    this.g.putImageData(this.img!, 0, 0);
    return this.canvas;
  }
}
