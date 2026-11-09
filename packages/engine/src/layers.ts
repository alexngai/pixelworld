import type { Layer, LayerContext, LayerRegistry } from "./types";

/**
 * A view's runtime layers, in the order they were added (which is also the
 * order their sprites are drawn in). A layer joins through `init`; one that
 * has nothing in the world (no routes, no fog over it) is left out.
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
    if (!(await layer.init(this.context(layer)))) return false;
    if (this.get(layer.id)) throw new Error(`the view already has a layer "${layer.id}"`);
    this.items.push(layer);
    this.invalidate();
    return true;
  }

  remove(id: string): void {
    const i = this.items.findIndex((l) => l.id === id);
    if (i < 0) return;
    const [layer] = this.items.splice(i, 1);
    layer?.dispose?.();
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
    for (const l of this.items.splice(0)) l.dispose?.();
  }
}
