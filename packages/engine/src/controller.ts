import type { Controller, ControllerHost, ControllerView, FrameClock } from "./types";

/** The host each controller is attached to: a controller is in one view at a time. */
const owners = new WeakMap<Controller, Controllers>();

/**
 * The view's current controller: at most one at a time. Using a controller
 * that another view has (a level switch keeping the player's controller)
 * detaches it there first, so the old view neither updates it nor detaches
 * it again when it is destroyed.
 */
export class Controllers implements ControllerHost {
  private active: Controller | null = null;

  constructor(private readonly view: ControllerView) {}

  get current(): Controller | null {
    return this.active;
  }

  async use(controller: Controller | null): Promise<void> {
    if (controller === this.active) return;
    if (this.active) this.release(this.active);
    if (!controller) return;
    owners.get(controller)?.release(controller);
    await controller.attach(this.view);
    this.active = controller;
    owners.set(controller, this);
  }

  /** Detach a controller if it is this view's. */
  private release(controller: Controller): void {
    if (this.active !== controller) return;
    this.active = null;
    owners.delete(controller);
    controller.detach?.();
  }

  /** Each frame, before the layers (game seconds; the clock defaults to a running one). */
  update(dt: number, clock: FrameClock = { dt, realDt: dt, time: 0, started: true, paused: false }): void {
    this.active?.update?.(dt, clock);
  }
}

/**
 * Forward DOM input to a controller: keys (and the window losing focus) from
 * one target, pointer drags from another. Returns a function that stops
 * listening. An app that handles some keys itself forwards events instead.
 */
export function listenTo(
  controller: Controller,
  targets: { keys?: EventTarget | null; pointer?: EventTarget | null },
): () => void {
  const offs: (() => void)[] = [];
  const on = <E extends Event>(target: EventTarget, type: string, fn: (e: E) => void) => {
    const handler = fn as (e: Event) => void;
    target.addEventListener(type, handler);
    offs.push(() => target.removeEventListener(type, handler));
  };
  const { keys, pointer } = targets;
  if (keys) {
    on<KeyboardEvent>(keys, "keydown", (e) => controller.keyDown?.(e));
    on<KeyboardEvent>(keys, "keyup", (e) => controller.keyUp?.(e));
    on(keys, "blur", () => controller.blur?.());
  }
  if (pointer) {
    on<PointerEvent>(pointer, "pointerdown", (e) => controller.pointerDown?.(e));
    on<PointerEvent>(pointer, "pointermove", (e) => controller.pointerMove?.(e));
    on<PointerEvent>(pointer, "pointerup", (e) => controller.pointerUp?.(e));
  }
  return () => offs.splice(0).forEach((off) => off());
}
