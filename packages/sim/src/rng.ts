/**
 * Small deterministic RNG (mulberry32). Its whole state is one 32-bit
 * integer, so a simulation that owns one serializes exactly.
 */
export class Rng {
  constructor(public state: number) {
    this.state = state >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  int(n: number): number {
    return Math.min(n - 1, Math.floor(this.next() * n));
  }

  /** An index picked with probability proportional to its weight (−1 if none). */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return -1;
    let t = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      t -= Math.max(0, weights[i]!);
      if (t < 0) return i;
    }
    return weights.length - 1;
  }
}
