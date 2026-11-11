/**
 * Smooth changes of view: the frame from before a change is held over the
 * canvas and let go — faded, and for a change of scale (a zoom, a level of
 * another scale) zoomed, while the canvas zooms in step under it, so the
 * same world point stays put on screen throughout. CSS transforms and the Web
 * Animations API on the elements; the canvas's own pixels are never touched.
 */

export interface Release {
  /** Duration (ms). */
  ms: number;
  /** The new frame's scale over the held one's: its pixels per metre over theirs (default 1). */
  scale?: number;
  /** The anchor (CSS px of the canvas): where it is in the held frame, and in the new one (default the middle). */
  from?: { x: number; y: number };
  to?: { x: number; y: number };
  /** Turn the held frame away by this much (degrees) as it fades: a quarter turn of the view. */
  turn?: number;
}

export class ViewTransitions {
  private readonly held: HTMLCanvasElement;
  private anims: Animation[] = [];
  /** Each hold's number: a release for an older hold does nothing. */
  private gen = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const held = document.createElement("canvas");
    Object.assign(held.style, { position: "fixed", pointerEvents: "none", imageRendering: "pixelated", display: "none" });
    canvas.after(held);
    this.held = held;
  }

  /** Copy the canvas's frame now (`show`: over it at once; else kept hidden until `release`); returns the hold's number. */
  hold(show = true): number {
    this.stop();
    const c = this.canvas;
    const h = this.held;
    if (h.width !== c.width || h.height !== c.height) {
      h.width = c.width;
      h.height = c.height;
    }
    h.getContext("2d")?.drawImage(c, 0, 0);
    const r = c.getBoundingClientRect();
    Object.assign(h.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, opacity: "1", transform: "none" });
    h.style.display = show ? "block" : "none";
    return ++this.gen;
  }

  /** Copy the canvas's frame again into the current hold (a level loading behind it: its frames go on). */
  refresh(): void {
    const c = this.canvas;
    this.held.getContext("2d")?.drawImage(c, 0, 0);
  }

  /** Let hold `gen`'s frame go (shown first if it wasn't); nothing if another hold came since. */
  release(gen: number, o: Release): Promise<void> {
    if (gen !== this.gen) return Promise.resolve();
    for (const a of this.anims) a.cancel();
    const h = this.held;
    const c = this.canvas;
    h.style.display = "block";
    const r = c.getBoundingClientRect();
    const mid = { x: r.width / 2, y: r.height / 2 };
    const from = o.from ?? mid;
    const to = o.to ?? mid;
    const s = o.scale ?? 1;
    const easing = "cubic-bezier(0.45, 0, 0.25, 1)";
    const opts = { duration: o.ms, easing };
    // the held frame: scaled by s about its anchor and carried to the new one's, fading late (a zoom-in keeps the edges covered)
    const end = `translate(${to.x - from.x}px, ${to.y - from.y}px) scale(${s}) rotate(${o.turn ?? 0}deg)`;
    this.anims = [
      h.animate(
        [
          { transformOrigin: `${from.x}px ${from.y}px`, transform: "translate(0px, 0px) scale(1) rotate(0deg)", opacity: 1 },
          { opacity: s > 1 ? 1 : 0.9, offset: s > 1 ? 0.8 : 0.5 },
          { transformOrigin: `${from.x}px ${from.y}px`, transform: end, opacity: 0 },
        ],
        opts,
      ),
    ];
    // the canvas: from the held frame's scale and place to its own
    if (s !== 1 || from.x !== to.x || from.y !== to.y)
      this.anims.push(
        c.animate(
          [
            { transformOrigin: `${to.x}px ${to.y}px`, transform: `translate(${from.x - to.x}px, ${from.y - to.y}px) scale(${1 / s})` },
            { transformOrigin: `${to.x}px ${to.y}px`, transform: "translate(0px, 0px) scale(1)" },
          ],
          opts,
        ),
      );
    const done = this.anims[0]!.finished.then(
      () => {
        if (this.anims[0]?.playState === "finished") this.stop();
      },
      () => {},
    );
    return done;
  }

  /** Drop the held frame and any zoom in progress. */
  stop(): void {
    for (const a of this.anims) a.cancel();
    this.anims = [];
    this.held.style.display = "none";
  }
}
