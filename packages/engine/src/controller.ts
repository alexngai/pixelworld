import type { Controller, ControllerHost, ControllerView } from "./types";

/** The view's current controller: at most one at a time. */
export class Controllers implements ControllerHost {
  private active: Controller | null = null;

  constructor(private readonly view: ControllerView) {}

  get current(): Controller | null {
    return this.active;
  }

  async use(controller: Controller | null): Promise<void> {
    if (controller === this.active) return;
    this.active?.detach?.();
    this.active = null;
    if (!controller) return;
    await controller.attach(this.view);
    this.active = controller;
  }

  /** Each frame, before the layers. */
  update(dt: number): void {
    this.active?.update?.(dt);
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
