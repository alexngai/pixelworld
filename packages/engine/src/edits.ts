import type { CellEdit, WorldEdit, WorldEdits } from "./types";

/**
 * A world's runtime edits (D-124): placed objects taken out and put back, by
 * their index in the objects file, and terrain cells edited (D-147), as a log
 * of the ops that changed something. The queries read `isRemoved` and the
 * edited chunks; a view also keeps `TileEdits`.
 */
export class EditLog implements WorldEdits {
  private readonly gone = new Set<number>();
  private readonly ops: WorldEdit[] = [];
  private readonly listeners = new Set<(e: WorldEdit) => void>();

  /**
   * @param count The world's placed objects: indices outside them are left out.
   * @param editCells Applies cell edits to the world's terrain, returning those that applied (`cellEditor`); without it there are none.
   */
  constructor(
    private readonly count: number,
    private readonly editCells: ((cells: CellEdit[]) => CellEdit[]) | null = null,
  ) {}

  get version(): number {
    return this.ops.length;
  }

  remove(objects: Iterable<number>): WorldEdit | null {
    return this.apply({ op: "remove", objects: [...objects] });
  }

  restore(objects: Iterable<number> = this.gone): WorldEdit | null {
    return this.apply({ op: "restore", objects: [...objects] });
  }

  cells(cells: Iterable<CellEdit>): WorldEdit | null {
    return this.apply({ op: "cells", cells: [...cells] });
  }

  apply(edit: WorldEdit): WorldEdit | null {
    // ops come from the network too: a bad one changes nothing
    if (edit?.op === "cells") {
      const done = Array.isArray(edit.cells) && this.editCells ? this.editCells(edit.cells) : [];
      return done.length ? this.record({ op: "cells", cells: done }) : null;
    }
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
    return this.record({ op: edit.op, objects: changed });
  }

  /** Log an op that changed something and tell the listeners: each gets its own copy. */
  private record(done: WorldEdit): WorldEdit {
    this.ops.push(done);
    for (const f of [...this.listeners]) f(copy(done));
    return copy(done);
  }

  isRemoved(object: number): boolean {
    return this.gone.has(object);
  }

  removed(): number[] {
    return [...this.gone];
  }

  list(): WorldEdit[] {
    return this.ops.map(copy);
  }

  onChange(listener: (edit: WorldEdit) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const copy = (e: WorldEdit): WorldEdit => (e.op === "cells" ? { op: e.op, cells: e.cells.map((c) => ({ ...c })) } : { op: e.op, objects: [...e.objects] });

/** The cells an edit of these changes, half-open [x0, y0, x1, y1]: a height's neighbours too (they share its corners). */
export function cellsArea(cells: readonly CellEdit[]): [number, number, number, number] | null {
  if (!cells.length) return null;
  const a: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of cells) {
    const r = c.height !== undefined ? 1 : 0;
    a[0] = Math.min(a[0], c.x - r);
    a[1] = Math.min(a[1], c.y - r);
    a[2] = Math.max(a[2], c.x + 1 + r);
    a[3] = Math.max(a[3], c.y + 1 + r);
  }
  return a;
}

/** Terrain edits as a view's tiles see them (D-147): the tiles whose slice an area reaches, and a tile's edits (`ChunkStore.editsIn`). */
export interface TileCells {
  tiles(area: [number, number, number, number]): [number, number][];
  key(tx: number, ty: number): string;
}

/**
 * Which removed objects each bake tile's bake reaches (D-124), and which
 * terrain edits its slice holds (D-147): what it leaves out and is made from,
 * what its kept scene and cache key are made from, and which tiles an op
 * makes out of date.
 */
export class TileEdits {
  private readonly byTile = new Map<string, Set<number>>();

  /**
   * @param tilesOf The tiles whose bake builds an object (`objectInSlice`), as [tx, ty].
   * @param terrain The tiles terrain edits reach, and each one's edits.
   */
  constructor(
    private readonly tilesOf: (object: number) => [number, number][],
    private readonly terrain: TileCells | null = null,
  ) {}

  /** Note an op that changed something; the tiles it touches. */
  apply(e: WorldEdit): [number, number][] {
    if (e.op === "cells") {
      const area = cellsArea(e.cells);
      return area && this.terrain ? this.terrain.tiles(area) : [];
    }
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

  /** The terrain edits a tile's slice holds (D-147), or "" for none. */
  cellsFor(tx: number, ty: number): string {
    return this.terrain?.key(tx, ty) ?? "";
  }
}
