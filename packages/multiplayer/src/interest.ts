/**
 * Who is near whom (D-120), for a `TickRoom` whose pages should get only
 * what is near them: things filed in squares `cell` cells across. A page's
 * group is its square, and what it gets is what is in the squares within
 * `reach` of it: everything within `cell × reach` cells of it, and some up to
 * `cell × (reach + 1)`. Pages in one square share a group, so the room builds
 * and serializes a snapshot once per square with a page in it, not per page.
 *
 *   protected override update() { for (const [id, p] of this.cars) this.interest.place(id, p.x, p.y); }
 *   protected override groupOf(id: string) { return this.interest.groupOf(id); }
 *   protected override shared(group?: string) { return { cars: (group ? this.interest.near(group) : [...this.cars.keys()]).map(net) }; }
 *   this.emit(crash, this.interest.around(x, y));
 */
export class Interest {
  private readonly at = new Map<string, string>();
  private readonly squares = new Map<string, Set<string>>();

  /**
   * @param cell A square's side (cells): what a page sees at least, with `reach` 1.
   * @param reach Squares around a page's own that it sees (default 1).
   */
  constructor(
    readonly cell: number,
    readonly reach = 1,
  ) {}

  /** Where something is now: call it for everything that moves, each tick or before each snapshot. */
  place(id: string, x: number, y: number): void {
    const g = this.groupAt(x, y);
    const was = this.at.get(id);
    if (was === g) return;
    if (was !== undefined) this.leave(id, was);
    this.at.set(id, g);
    let s = this.squares.get(g);
    if (!s) this.squares.set(g, (s = new Set()));
    s.add(id);
  }

  remove(id: string): void {
    const was = this.at.get(id);
    if (was === undefined) return;
    this.at.delete(id);
    this.leave(id, was);
  }

  /** The group of a place: its square. */
  groupAt(x: number, y: number): string {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
  }

  /** The group something was last placed in, or undefined (never placed, or removed). */
  groupOf(id: string): string | undefined {
    return this.at.get(id);
  }

  /** What is within reach of a group: in its square and the squares around it. */
  near(group: string): string[] {
    const [i, j] = group.split(",").map(Number) as [number, number];
    const r = this.reach;
    const out: string[] = [];
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        const s = this.squares.get(`${i + di},${j + dj}`);
        if (s) out.push(...s);
      }
    return out;
  }

  /** What is within reach of a place: who should hear of an event there (with `TickRoom.emit`). */
  around(x: number, y: number): string[] {
    return this.near(this.groupAt(x, y));
  }

  private leave(id: string, g: string): void {
    const s = this.squares.get(g)!;
    s.delete(id);
    if (!s.size) this.squares.delete(g);
  }
}
