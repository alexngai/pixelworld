/**
 * Fights made ahead (D-185): while the squad looks over the city (or is at
 * the depot), the fights for the wave's open blocks are made one after
 * another, the most pressed first, so the one it takes is often ready. Taking
 * one that isn't made yet makes it next; the others made are let go (their
 * boards taken off) once one is taken, and the next look over the city makes
 * them again if they're still open.
 *
 * ponytail: a fight made ahead is made on the city as it was then; a squad
 * that brings buildings down on that block meanwhile (in another district,
 * so rarely) leaves it a little out of date.
 */
export class Ahead<T> {
  private readonly made = new Map<number, Promise<T | null>>();
  private queue: number[] = [];
  private busy = false;
  private last: Promise<unknown> = Promise.resolve();
  /** The site being made and how far it has got, for the page waiting on it. */
  onProgress: ((site: number, tried: number) => void) | null = null;

  constructor(
    private readonly make: (site: number, progress: (tried: number) => void) => Promise<T | null>,
    private readonly drop: (made: T) => void,
  ) {}

  /** Make these sites' fights, in this order, after the one being made; the queue before is forgotten. */
  want(sites: readonly number[]): void {
    this.queue = sites.filter((s) => !this.made.has(s));
    this.pump();
  }

  /** A site's fight: made, being made, or made next; the rest let go. */
  take(site: number): Promise<T | null> {
    const mine = this.made.get(site) ?? this.start(site);
    this.made.delete(site);
    this.clear();
    return mine;
  }

  /** Every fight made or being made let go, and nothing more made till wanted. */
  clear(): void {
    this.queue = [];
    for (const p of this.made.values()) void p.then((f) => f && this.drop(f));
    this.made.clear();
  }

  private start(site: number): Promise<T | null> {
    // one at a time, as the worker makes them: after every one asked for before
    const p = this.last.then(() => this.make(site, (n) => this.onProgress?.(site, n)));
    this.last = p.catch(() => null);
    this.made.set(site, p);
    return p;
  }

  private pump(): void {
    if (this.busy) return;
    const site = this.queue.shift();
    if (site === undefined) return;
    this.busy = true;
    void this.start(site).finally(() => {
      this.busy = false;
      this.pump();
    });
  }
}
