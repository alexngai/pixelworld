import type { Layer, LayerContext, LayerRegistry } from "./types";

/** The registry each layer is in: a layer belongs to one view at a time. */
const owners = new WeakMap<Layer, Layers>();

/**
 * A view's runtime layers, in the order they were added (which is also the
 * order their sprites are drawn in). A layer joins through `init`; one that
 * has nothing in the world (no routes, no fog over it) is left out.
 *
 * A layer is in one view at a time. Adding it to another view (a level
 * switch reusing it) first takes it out of the view it is in, which calls
 * its `dispose`, then `init`s it in the new one; destroying the old view
 * later leaves it alone.
 */
export class Layers implements LayerRegistry {
  private readonly items: Layer[] = [];

  constructor(
    private readonly context: (layer: Layer) => LayerContext,
    private readonly invalidate: () => void,
  ) {}

  list(): readonly Layer[] {
    return this.items;
  }

  get(id: string): Layer | undefined {
    return this.items.find((l) => l.id === id);
  }

  async add(layer: Layer): Promise<boolean> {
    if (this.get(layer.id)) throw new Error(`the view already has a layer "${layer.id}"`);
    owners.get(layer)?.release(layer);
    if (!(await layer.init(this.context(layer)))) return false;
    if (this.get(layer.id)) throw new Error(`the view already has a layer "${layer.id}"`);
    this.items.push(layer);
    owners.set(layer, this);
    this.invalidate();
    return true;
  }

  remove(id: string): void {
    const layer = this.get(id);
    if (layer) this.release(layer);
  }

  /** Take a layer out of this view, disposing it (it may join another). */
  private release(layer: Layer): void {
    const i = this.items.indexOf(layer);
    if (i < 0) return;
    this.items.splice(i, 1);
    owners.delete(layer);
    layer.dispose?.();
    this.invalidate();
  }

  enable(id: string, on = true, sublayer?: string): void {
    const layer = this.get(id);
    if (!layer) return;
    if (sublayer !== undefined) {
      if (!layer.setSublayerEnabled) throw new Error(`layer "${id}" has no sublayers`);
      layer.setSublayerEnabled(sublayer, on);
    } else layer.setEnabled(on);
    this.invalidate();
  }

  /** The layers that are on, in order. */
  enabled(): Layer[] {
    return this.items.filter((l) => l.enabled);
  }

  /** Every layer's state that has one, by id. */
  serialize(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const l of this.items) if (l.serialize) out[l.id] = l.serialize();
    return out;
  }

  restore(states: Record<string, unknown>): void {
    for (const l of this.items) if (l.restore && l.id in states) l.restore(states[l.id]);
    this.invalidate();
  }

  dispose(): void {
    for (const l of this.items.splice(0)) {
      owners.delete(l);
      l.dispose?.();
    }
  }
}
