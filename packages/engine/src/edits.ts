import type { WorldEdit, WorldEdits } from "./types";

/**
 * A world's runtime edits (D-124): placed objects taken out and put back, by
 * their index in the objects file, as a log of the ops that changed
 * something. The queries read `isRemoved`; a view also keeps `TileEdits`.
 */
export class EditLog implements WorldEdits {
  private readonly gone = new Set<number>();
  private readonly ops: WorldEdit[] = [];
  private readonly listeners = new Set<(e: WorldEdit) => void>();

  /** @param count The world's placed objects: indices outside them are left out. */
  constructor(private readonly count: number) {}

  get version(): number {
    return this.ops.length;
  }

  remove(objects: Iterable<number>): WorldEdit | null {
    return this.apply({ op: "remove", objects: [...objects] });
  }

  restore(objects: Iterable<number> = this.gone): WorldEdit | null {
    return this.apply({ op: "restore", objects: [...objects] });
  }

  apply(edit: WorldEdit): WorldEdit | null {
    // ops come from the network too: a bad one changes nothing
    if ((edit?.op !== "remove" && edit?.op !== "restore") || !Array.isArray(edit.objects)) return null;
    const remove = edit.op === "remove";
    const changed: number[] = [];
    for (const i of edit.objects) {
      if (!Number.isInteger(i) || i < 0 || i >= this.count || this.gone.has(i) === remove) continue;
      if (remove) this.gone.add(i);
      else this.gone.delete(i);
      changed.push(i);
    }
    if (!changed.length) return null;
    const done: WorldEdit = { op: edit.op, objects: changed };
    this.ops.push(done);
    for (const f of [...this.listeners]) f({ op: done.op, objects: [...changed] });
    return { op: done.op, objects: [...changed] };
  }

  isRemoved(object: number): boolean {
    return this.gone.has(object);
  }

  removed(): number[] {
    return [...this.gone];
  }

  list(): WorldEdit[] {
    return this.ops.map((o) => ({ op: o.op, objects: [...o.objects] }));
  }

  onChange(listener: (edit: WorldEdit) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Which removed objects each bake tile's bake reaches (D-124): what it leaves
 * out, what its kept scene and cache key are made from, and which tiles an op
 * makes out of date.
 */
export class TileEdits {
  private readonly byTile = new Map<string, Set<number>>();

  /** @param tilesOf The tiles whose bake builds an object (`objectInSlice`), as [tx, ty]. */
  constructor(private readonly tilesOf: (object: number) => [number, number][]) {}

  /** Note an op that changed something; the tiles it touches. */
  apply(e: WorldEdit): [number, number][] {
    const touched = new Map<string, [number, number]>();
    for (const i of e.objects)
      for (const t of this.tilesOf(i)) {
        const at = `${t[0]},${t[1]}`;
        touched.set(at, t);
        let set = this.byTile.get(at);
        if (e.op === "remove") {
          if (!set) this.byTile.set(at, (set = new Set()));
          set.add(i);
        } else if (set) {
          set.delete(i);
          if (!set.size) this.byTile.delete(at);
        }
      }
    return [...touched.values()];
  }

  /** The removed objects a tile's bake reaches, in order. */
  removedFor(tx: number, ty: number): number[] {
    const set = this.byTile.get(`${tx},${ty}`);
    return set ? [...set].sort((a, b) => a - b) : [];
  }
}
