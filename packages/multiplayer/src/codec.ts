/**
 * Compact binary for what a room sends often (D-123): a `Schema` says how
 * each field of a thing is written (a fixed step, an angle in steps, an
 * integer, a flag, text), and its states go out whole or as the fields that
 * changed since one the page has. Numbers go as variable-length integers, so a
 * position on a 1/64-cell step is two or three bytes and a small change one.
 * Used by `Replicator` (server) and `Replica` (page).
 */

const TEXT_OUT = new TextEncoder();
const TEXT_IN = new TextDecoder();

/** Bytes written in order, growing as needed. */
export class Writer {
  private buf = new Uint8Array(256);
  private n = 0;

  private room(k: number): void {
    if (this.n + k <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
    next.set(this.buf.subarray(0, this.n));
    this.buf = next;
  }

  byte(b: number): void {
    this.room(1);
    this.buf[this.n++] = b;
  }

  /** A whole number ≥ 0, seven bits a byte (exact to 2^53). */
  uint(v: number): void {
    while (v >= 0x80) {
      this.byte((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.byte(v);
  }

  /** A whole number, small ones short whatever their sign (zigzag). */
  int(v: number): void {
    this.uint(v >= 0 ? v * 2 : -v * 2 - 1);
  }

  bytes(b: Uint8Array): void {
    this.room(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  }

  str(s: string): void {
    const b = TEXT_OUT.encode(s);
    this.uint(b.length);
    this.bytes(b);
  }

  /** A number exactly (eight bytes). */
  f64(v: number): void {
    this.room(8);
    new DataView(this.buf.buffer).setFloat64(this.n, v, true);
    this.n += 8;
  }

  get length(): number {
    return this.n;
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
}

/** Reads what a `Writer` wrote; past the end throws. */
export class Reader {
  private i = 0;

  constructor(private readonly buf: Uint8Array) {}

  byte(): number {
    if (this.i >= this.buf.length) throw new RangeError("a message cut short");
    return this.buf[this.i++]!;
  }

  uint(): number {
    let v = 0;
    let scale = 1;
    for (;;) {
      const b = this.byte();
      v += (b & 0x7f) * scale;
      if (b < 0x80) return v;
      scale *= 0x80;
    }
  }

  int(): number {
    const z = this.uint();
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }

  bytes(k: number): Uint8Array {
    if (this.i + k > this.buf.length) throw new RangeError("a message cut short");
    const b = this.buf.subarray(this.i, this.i + k);
    this.i += k;
    return b;
  }

  str(): string {
    return TEXT_IN.decode(this.bytes(this.uint()));
  }

  f64(): number {
    const b = this.bytes(8);
    return new DataView(b.buffer, b.byteOffset, 8).getFloat64(0, true);
  }

  get done(): boolean {
    return this.i >= this.buf.length;
  }
}

/** How a field is written. */
export type Field = { kind: "fixed"; step: number } | { kind: "angle"; steps: number } | { kind: "int" } | { kind: "bool" } | { kind: "str" } | { kind: "exact" };

/** A number on a fixed step: `fixed(1 / 64)` for a position to a 64th of a cell. */
export const fixed = (step: number): Field => ({ kind: "fixed", step });
/** An angle (radians) in `steps` to the turn (default 256: 1.4°), read back in [−π, π). */
export const angle = (steps = 256): Field => ({ kind: "angle", steps });
/** A whole number (rounded). */
export const int: Field = { kind: "int" };
export const bool: Field = { kind: "bool" };
export const str: Field = { kind: "str" };
/** A number exactly, in eight bytes: for state a page's prediction puts back as the server has it. */
export const exact: Field = { kind: "exact" };

/** A state's fields as written: integers on their steps, text as it is. */
export type Wire = (number | string)[];

/**
 * How one kind of thing goes on the wire (D-123): its fields, in order, and
 * how each is written. At most 52 fields.
 *
 *   const PLANE = new Schema({ x: fixed(1 / 64), y: fixed(1 / 64), h: fixed(1 / 32), hd: angle(), hp: int });
 */
export class Schema<S extends object> {
  private readonly names: string[];
  private readonly kinds: Field[];

  constructor(fields: { [K in keyof S]: Field }) {
    this.names = Object.keys(fields);
    this.kinds = this.names.map((k) => (fields as Record<string, Field>)[k]!);
    if (this.names.length > 52) throw new Error("a schema has at most 52 fields");
  }

  /** A state as written: each field on its step. */
  wire(s: S): Wire {
    return this.kinds.map((f, i) => {
      const v = (s as Record<string, unknown>)[this.names[i]!];
      switch (f.kind) {
        case "fixed":
          return Math.round(Number(v) / f.step) || 0;
        case "angle": {
          const q = Math.round((Number(v) / (2 * Math.PI)) * f.steps) % f.steps;
          return q < 0 ? q + f.steps : q || 0;
        }
        case "int":
          return Math.round(Number(v)) || 0;
        case "bool":
          return v ? 1 : 0;
        case "str":
          return String(v ?? "");
        case "exact":
          return Number(v);
      }
    });
  }

  /** The state a page reads back. */
  value(w: Wire): S {
    const out: Record<string, unknown> = {};
    this.kinds.forEach((f, i) => {
      const v = w[i]!;
      const name = this.names[i]!;
      if (f.kind === "fixed") out[name] = (v as number) * f.step;
      else if (f.kind === "angle") out[name] = (((v as number) >= f.steps / 2 ? (v as number) - f.steps : (v as number)) / f.steps) * 2 * Math.PI;
      else if (f.kind === "bool") out[name] = v === 1;
      else out[name] = v;
    });
    return out as S;
  }

  writeFull(out: Writer, w: Wire): void {
    this.kinds.forEach((f, i) => {
      if (f.kind === "str") out.str(w[i] as string);
      else if (f.kind === "bool") out.byte(w[i] as number);
      else if (f.kind === "exact") out.f64(w[i] as number);
      else out.int(w[i] as number);
    });
  }

  readFull(r: Reader): Wire {
    return this.kinds.map((f) => (f.kind === "str" ? r.str() : f.kind === "bool" ? r.byte() : f.kind === "exact" ? r.f64() : r.int()));
  }

  /** The fields that changed since `base`: a mask, then each change (numbers as the difference, an angle the short way round). */
  writeDiff(out: Writer, w: Wire, base: Wire): void {
    let mask = 0;
    for (let i = this.kinds.length - 1; i >= 0; i--) mask = mask * 2 + (w[i] !== base[i] ? 1 : 0);
    out.uint(mask);
    this.kinds.forEach((f, i) => {
      if (w[i] === base[i] || f.kind === "bool") return; // a flag that changed flipped: its bit says so
      if (f.kind === "str") return out.str(w[i] as string);
      if (f.kind === "exact") return out.f64(w[i] as number);
      let d = (w[i] as number) - (base[i] as number);
      if (f.kind === "angle") d = ((((d + f.steps / 2) % f.steps) + f.steps) % f.steps) - f.steps / 2;
      out.int(d);
    });
  }

  readDiff(r: Reader, base: Wire): Wire {
    let mask = r.uint();
    return this.kinds.map((f, i) => {
      const changed = mask % 2 === 1;
      mask = Math.floor(mask / 2);
      const b = base[i]!;
      if (!changed) return b;
      if (f.kind === "bool") return 1 - (b as number);
      if (f.kind === "str") return r.str();
      if (f.kind === "exact") return r.f64();
      const v = (b as number) + r.int();
      return f.kind === "angle" ? ((v % f.steps) + f.steps) % f.steps : v;
    });
  }
}
