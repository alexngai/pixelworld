import type { Box } from "@pixelworlds/generators";
import type { Rotation } from "@pixelworlds/grid";
import type { Entity, EntityList, EntityModel, EntityReveal, EntitySpec, Sprite, SpriteDraw } from "./types";

/**
 * Entities: depth-tested sprites placed in world cells and heights, baked
 * from a model per view rotation and heading, on demand (docs/library.md
 * §3.3). A model's sprites are shared by every entity with the same model.
 */

export const DEFAULT_HEADINGS = 16;

/** Pitch and roll are baked to the nearest of these (radians): 10°. */
export const ATTITUDE_STEP = Math.PI / 18;

/** A posed sprite (pitch or roll) not drawn for this many frames is let go: a long flight passes through many poses. */
const POSE_KEEP_FRAMES = 600;

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

function withRevealDefaults(r: EntitySpec["reveal"] | null | undefined): EntityReveal | null {
  return r ? { margin: Math.max(0, r.margin ?? 24), density: Math.min(1, Math.max(0, r.density ?? 0.75)) } : null;
}

/** The heading index nearest an angle, of n around the circle. */
export function headingIndex(heading: number, n: number): number {
  const k = Math.round((heading / (2 * Math.PI)) * n) % n;
  return (k + n) % n;
}

/**
 * Boxes turned to heading index k of n, and tilted (radians: nose up, right
 * wing down) about their middle height; heading 0 untilted is the model as given.
 */
export function turnBoxes(boxes: Box[], k: number, n: number, tilt?: { pitch: number; roll: number }): Box[] {
  const tilted = !!tilt && (tilt.pitch !== 0 || tilt.roll !== 0);
  if (k === 0 && !tilted) return boxes;
  const angle = (k * 2 * Math.PI) / n;
  let pivot = 0;
  if (tilted) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of boxes) {
      lo = Math.min(lo, b.z0);
      hi = Math.max(hi, b.z1);
    }
    pivot = (lo + hi) / 2;
  }
  return boxes.map((b) => ({ ...b, rot: (b.rot ?? 0) + angle, ...(tilted ? { pitch: tilt.pitch, roll: tilt.roll, pivot } : {}) }));
}

class EntityImpl implements Entity {
  private _x: number;
  private _y: number;
  private _h: number;
  private _heading: number;
  private _pitch: number;
  private _roll: number;
  private _visible: boolean;
  private _silhouette: boolean;
  private _reveal: EntityReveal | null;
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
    this._pitch = spec.pitch ?? 0;
    this._roll = spec.roll ?? 0;
    this._visible = spec.visible ?? true;
    this._silhouette = spec.silhouette ?? false;
    this._reveal = withRevealDefaults(spec.reveal);
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

  get pitch(): number {
    return this._pitch;
  }
  set pitch(v: number) {
    if (v === this._pitch) return;
    this._pitch = v;
    this.owner.changed();
  }

  get roll(): number {
    return this._roll;
  }
  set roll(v: number) {
    if (v === this._roll) return;
    this._roll = v;
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

  get reveal(): EntityReveal | null {
    return this._reveal;
  }
  set reveal(v: EntityReveal | null) {
    this._reveal = withRevealDefaults(v);
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

  /** The last sprite drawn: shown while the next pose's bakes. */
  shown: Sprite | null = null;
  shownRotation: Rotation | null = null;

  /** The sprite key for a rotation: model, headings, rotation, heading index and pitch and roll steps. */
  spriteKey(rotation: Rotation): { key: string; k: number; pitch: number; roll: number; posed: boolean } {
    const k = headingIndex(this._heading, this.headings);
    const p = Math.round(this._pitch / ATTITUDE_STEP);
    const r = Math.round(this._roll / ATTITUDE_STEP);
    const pose = p || r ? `|${p}|${r}` : "";
    return { key: `${this.key}|${this.headings}|${rotation}|${k}${pose}`, k, pitch: p * ATTITUDE_STEP, roll: r * ATTITUDE_STEP, posed: pose !== "" };
  }
}

export class Entities implements EntityList {
  private readonly items: EntityImpl[] = [];
  private nextId = 1;
  /** Sprites by model, rotation and heading: null while baking, false where the bake failed. */
  private readonly sprites = new Map<string, Sprite | null | false>();
  /** Each model's boxes at heading 0. */
  private readonly boxes = new Map<string, Box[]>();
  /** Posed sprites by key: the last frame each was asked for or drawn. */
  private readonly posedUse = new Map<string, number>();
  private frame = 0;

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
          this.posedUse.delete(k);
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
      const { key, k, pitch, roll, posed } = e.spriteKey(rotation);
      if (posed) this.posedUse.set(key, this.frame);
      if (this.sprites.has(key)) continue;
      this.sprites.set(key, null);
      const boxes = turnBoxes(this.boxes.get(e.key)!, k, e.headings, { pitch, roll });
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
   * some are still baking (an entity whose new pose is baking shows its last
   * sprite in the meantime, so it doesn't blink). An entity where the ground isn't drawn yet
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
    if (++this.frame % 120 === 0) this.letGoOfPoses();
    for (const e of this.items) {
      if (!e.visible) continue;
      const { key, posed } = e.spriteKey(rotation);
      if (posed) this.posedUse.set(key, this.frame);
      let sprite = this.sprites.get(key);
      if (sprite === false || !isDrawn(e.x, e.y)) continue;
      if (!sprite) {
        complete = false;
        // the last pose, in this rotation (another rotation's would face the wrong way)
        if (!e.shown || e.shownRotation !== rotation) continue;
        sprite = e.shown;
      }
      e.shown = sprite;
      e.shownRotation = rotation;
      const p = project(e.x, e.y, e.h + e.lift);
      // not rounded: the compositor places sprites between art pixels, so they glide
      list.push({ sprite, sx: p.sx, sy: p.sy, depth: p.depth, silhouette: e.silhouette, reveal: e.reveal });
    }
    return { list, complete };
  }

  /** Let go of posed sprites not drawn for a while (but not one an entity still shows while its next pose bakes). */
  private letGoOfPoses(): void {
    const shown = new Set(this.items.map((e) => e.shown));
    for (const [key, last] of this.posedUse) {
      if (this.frame - last <= POSE_KEEP_FRAMES) continue;
      const s = this.sprites.get(key);
      if (s && shown.has(s)) continue;
      if (s) this.deps.release(s);
      this.sprites.delete(key); // one still baking is let go when it arrives
      this.posedUse.delete(key);
    }
  }

  /** Sprites baked or baking. */
  get spriteCount(): number {
    return this.sprites.size;
  }

  /** Let go of every sprite (the view is going away); sprites still baking are dropped when they arrive. */
  dispose(): void {
    for (const s of this.sprites.values()) if (s) this.deps.release(s);
    this.sprites.clear();
    this.posedUse.clear();
    this.boxes.clear();
    this.items.splice(0);
  }
}
