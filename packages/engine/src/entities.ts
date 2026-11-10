import type { Box } from "@pixelworlds/generators";
import type { Rotation } from "@pixelworlds/grid";
import type { Entity, EntityList, EntityModel, EntitySpec, Sprite, SpriteDraw } from "./types";

/**
 * Entities: depth-tested sprites placed in world cells and heights, baked
 * from a model per view rotation and heading, on demand (docs/library.md
 * §3.3). A model's sprites are shared by every entity with the same model.
 */

export const DEFAULT_HEADINGS = 16;

export interface EntityDeps {
  /** Bake boxes into a sprite for a rotation (null if the bake failed). */
  bake(rotation: Rotation, boxes: Box[]): Promise<Sprite | null>;
  release(sprite: Sprite): void;
  /** A model group's boxes at heading 0 (the style's generator). */
  groupBoxes(model: Extract<EntityModel, { group: string }>): Box[];
  heightAt(x: number, y: number): number | null;
  /** An entity changed: redraw, and make ready() wait. */
  invalidate(): void;
  /** A sprite arrived: redraw. */
  redraw(): void;
}

function modelKey(model: EntityModel, id: number): string {
  if ("boxes" in model) return model.key ?? `entity:${id}`;
  const s = model.size;
  return ["group", model.group, model.seed, model.variant ?? 0, model.part ?? 0, s ? `${s.length}x${s.width}x${s.height}` : ""].join(":");
}

/** The heading index nearest an angle, of n around the circle. */
export function headingIndex(heading: number, n: number): number {
  const k = Math.round((heading / (2 * Math.PI)) * n) % n;
  return (k + n) % n;
}

/** Boxes turned to heading index k of n; heading 0 is the model as given. */
export function turnBoxes(boxes: Box[], k: number, n: number): Box[] {
  if (k === 0) return boxes;
  const angle = (k * 2 * Math.PI) / n;
  return boxes.map((b) => ({ ...b, rot: (b.rot ?? 0) + angle }));
}

class EntityImpl implements Entity {
  private _x: number;
  private _y: number;
  private _h: number;
  private _heading: number;
  private _visible: boolean;
  private _silhouette: boolean;
  readonly headings: number;
  readonly lift: number;

  constructor(
    readonly id: number,
    readonly model: EntityModel,
    readonly key: string,
    spec: EntitySpec,
    h: number,
    private readonly owner: Entities,
  ) {
    this._x = spec.x;
    this._y = spec.y;
    this._h = h;
    this._heading = spec.heading ?? 0;
    this._visible = spec.visible ?? true;
    this._silhouette = spec.silhouette ?? false;
    this.headings = Math.max(1, Math.round(spec.headings ?? DEFAULT_HEADINGS));
    this.lift = spec.lift ?? 0;
  }

  get x(): number {
    return this._x;
  }
  get y(): number {
    return this._y;
  }
  get h(): number {
    return this._h;
  }

  get heading(): number {
    return this._heading;
  }
  set heading(v: number) {
    if (v === this._heading) return;
    this._heading = v;
    this.owner.changed();
  }

  get visible(): boolean {
    return this._visible;
  }
  set visible(v: boolean) {
    if (v === this._visible) return;
    this._visible = v;
    this.owner.changed();
  }

  get silhouette(): boolean {
    return this._silhouette;
  }
  set silhouette(v: boolean) {
    if (v === this._silhouette) return;
    this._silhouette = v;
    this.owner.changed();
  }

  moveTo(x: number, y: number, h?: number): void {
    const nh = h ?? this.owner.heightAt(x, y) ?? this._h;
    if (x === this._x && y === this._y && nh === this._h) return;
    this._x = x;
    this._y = y;
    this._h = nh;
    this.owner.changed();
  }

  remove(): void {
    this.owner.remove(this);
  }

  /** The sprite key for a rotation: model, headings, rotation and heading index. */
  spriteKey(rotation: Rotation): { key: string; k: number } {
    const k = headingIndex(this._heading, this.headings);
    return { key: `${this.key}|${this.headings}|${rotation}|${k}`, k };
  }
}

export class Entities implements EntityList {
  private readonly items: EntityImpl[] = [];
  private nextId = 1;
  /** Sprites by model, rotation and heading: null while baking, false where the bake failed. */
  private readonly sprites = new Map<string, Sprite | null | false>();
  /** Each model's boxes at heading 0. */
  private readonly boxes = new Map<string, Box[]>();

  constructor(private readonly deps: EntityDeps) {}

  add(spec: EntitySpec): Entity {
    const id = this.nextId++;
    const key = modelKey(spec.model, id);
    if (!this.boxes.has(key))
      this.boxes.set(key, "boxes" in spec.model ? spec.model.boxes : this.deps.groupBoxes(spec.model));
    const h = spec.h ?? this.deps.heightAt(spec.x, spec.y) ?? 0;
    const e = new EntityImpl(id, spec.model, key, spec, h, this);
    this.items.push(e);
    this.deps.invalidate();
    return e;
  }

  remove(entity: Entity): void {
    const i = this.items.findIndex((e) => e === entity);
    if (i < 0) return;
    const [e] = this.items.splice(i, 1);
    // let go of the model's sprites when no other entity shows it
    if (e && !this.items.some((o) => o.key === e.key)) {
      this.boxes.delete(e.key);
      for (const [k, s] of this.sprites)
        if (k.startsWith(`${e.key}|`)) {
          if (s) this.deps.release(s);
          this.sprites.delete(k);
        }
    }
    this.deps.invalidate();
  }

  list(): readonly Entity[] {
    return this.items;
  }

  /** @internal */
  changed(): void {
    this.deps.invalidate();
  }

  /** @internal */
  heightAt(x: number, y: number): number | null {
    return this.deps.heightAt(x, y);
  }

  /** Ask for every entity's sprite in a rotation (hidden ones too, so showing them is instant). */
  request(rotation: Rotation): void {
    for (const e of this.items) {
      const { key, k } = e.spriteKey(rotation);
      if (this.sprites.has(key)) continue;
      this.sprites.set(key, null);
      const boxes = turnBoxes(this.boxes.get(e.key)!, k, e.headings);
      void this.deps.bake(rotation, boxes).then((img) => {
        if (!this.sprites.has(key)) {
          if (img) this.deps.release(img); // the model went away meanwhile
          return;
        }
        this.sprites.set(key, img ?? false); // a failed bake isn't asked for again, nor waited for
        this.deps.redraw();
      });
    }
  }

  /**
   * The visible entities' sprites for a frame; `complete` is false while
   * some are still baking. An entity where the ground isn't drawn yet
   * (`isDrawn`, its tile still baking) is left out, so it doesn't float over
   * the void.
   */
  draws(
    rotation: Rotation,
    project: (x: number, y: number, h: number) => { sx: number; sy: number; depth: number },
    isDrawn: (x: number, y: number) => boolean = () => true,
  ): { list: SpriteDraw[]; complete: boolean } {
    const list: SpriteDraw[] = [];
    let complete = true;
    for (const e of this.items) {
      if (!e.visible) continue;
      const sprite = this.sprites.get(e.spriteKey(rotation).key);
      if (sprite === false || !isDrawn(e.x, e.y)) continue;
      if (!sprite) {
        complete = false;
        continue;
      }
      const p = project(e.x, e.y, e.h + e.lift);
      list.push({ sprite, sx: Math.round(p.sx), sy: Math.round(p.sy), depth: p.depth, silhouette: e.silhouette });
    }
    return { list, complete };
  }

  /** Sprites baked or baking. */
  get spriteCount(): number {
    return this.sprites.size;
  }

  /** Let go of every sprite (the view is going away); sprites still baking are dropped when they arrive. */
  dispose(): void {
    for (const s of this.sprites.values()) if (s) this.deps.release(s);
    this.sprites.clear();
    this.boxes.clear();
    this.items.splice(0);
  }
}
