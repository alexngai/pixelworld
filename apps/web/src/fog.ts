import { unprojectAtHeight, type Rotation } from "@pixelworld/grid";
import { fogInView, fogPatchOffset, type FogFrame, type FogSetup } from "@pixelworld/runtime";

/**
 * Fog in the viewer (an atmosphere layer): a clock for its drift and the
 * per-frame parameters of the compositor's fog pass. The time is seconds of
 * play, so a fixed `fogTime` with the clock paused always draws the same fog.
 */

/** Redraws per second while the fog drifts on its own (it moves a few pixels a second). */
const DRIFT_FPS = 12;

export class FogLayer {
  enabled = true;
  paused = false;
  /** Seconds of play since the fog's clock started. */
  time = 0;
  /** Whether the last frame asked for fog (some lay in view). */
  inView = false;

  constructor(
    readonly setup: FogSetup,
    private readonly renderScale: number,
    /** The world's lowest height, in steps. */
    private readonly floor: number,
  ) {}

  /** Advance the clock by a frame; true when fog in view has drifted far enough to redraw. */
  update(dt: number): boolean {
    if (!this.enabled || this.paused || (this.setup.drift[0] === 0 && this.setup.drift[1] === 0)) return false;
    const before = Math.floor(this.time * DRIFT_FPS);
    this.time += dt;
    return this.inView && Math.floor(this.time * DRIFT_FPS) !== before;
  }

  /** The fog pass's parameters for a view (render px), or null when no fog is drawn there. */
  frame(
    rotation: Rotation,
    night: boolean,
    view: { left: number; top: number; width: number; height: number },
  ): FogFrame | null {
    const s = this.setup;
    const rs = this.renderScale;
    const strength = s.strength * (night ? s.nightStrength : 1);
    this.inView =
      this.enabled &&
      strength > 0 &&
      // only pixels below the ceiling take fog
      fogInView(
        s.field,
        view,
        (sx, sy, h) => {
          const [x, y] = unprojectAtHeight(sx, sy, h, rotation);
          return [x / rs, y / rs];
        },
        [this.floor * rs, s.ceiling * rs],
      );
    if (!this.inView) return null;
    return {
      rotation,
      renderScale: rs,
      ceiling: s.ceiling * rs,
      fade: s.fade * rs,
      // patches float at the top of the thick fog
      patchHeight: Math.max(0, s.ceiling - s.fade) * rs,
      patchCells: s.patchCells,
      patchOffset: fogPatchOffset(s, this.time),
      contrast: s.contrast,
      strength,
      lut: s.lut,
      night,
    };
  }
}
