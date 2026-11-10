/**
 * Style pack problems (D-075): each has a path into the pack, so a message
 * says where to look (`ramps.desert[0]: bad colour "#3a2f3"`), and a misspelt
 * name gets a "did you mean".
 */

/** One problem with a pack: where (a path into it) and what. */
export interface StyleIssue {
  /** `ramps.desert[0]`, `assets["building.residential"].generator`; "" for the pack itself. */
  path: string;
  message: string;
}

export type PathSegment = string | number;

/** A path as people read it: names joined by dots; indices, and keys with dots or spaces, in brackets. */
export function formatPath(segs: readonly PathSegment[]): string {
  let out = "";
  for (const s of segs) {
    if (typeof s === "number") out += `[${s}]`;
    else if (/^[A-Za-z_$][\w$-]*$/.test(s)) out += out ? `.${s}` : s;
    else out += `[${JSON.stringify(s)}]`;
  }
  return out;
}

/** A pack, a generator or a loader got something wrong. `issues` has each problem with its path. */
export class StyleError extends Error {
  override name = "StyleError";
  /** The pack's id, when known. */
  readonly pack: string | null;
  /** The problems, each with its path in the pack (empty for an error about no one place, such as bad JSON). */
  readonly issues: StyleIssue[];

  constructor(message: string, opts: { pack?: string | null; issues?: StyleIssue[]; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.pack = opts.pack ?? null;
    this.issues = opts.issues ?? [];
  }
}

const MAX_LISTED = 12;

/** The error for a pack's problems: one line for one, a list for several. */
export function styleIssuesError(pack: string | null, issues: StyleIssue[]): StyleError {
  const who = pack !== null ? `style pack ${JSON.stringify(pack)}` : "style pack";
  const line = (i: StyleIssue) => (i.path ? `${i.path}: ${i.message}` : i.message);
  const message =
    issues.length === 1
      ? `${who}: ${line(issues[0]!)}`
      : `${who} has ${issues.length} problems:\n` +
        issues
          .slice(0, MAX_LISTED)
          .map((i) => `  ${line(i)}`)
          .join("\n") +
        (issues.length > MAX_LISTED ? `\n  … and ${issues.length - MAX_LISTED} more` : "");
  return new StyleError(message, { pack, issues });
}

/** Edit distance with transpositions (optimal string alignment). */
function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  return d[a.length]![b.length]!;
}

/** The candidate a mistyped name most likely meant, if one is close (case aside, about one edit per three letters). */
export function didYouMean(word: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = distance(word.toLowerCase(), c.toLowerCase());
    if (d < bestD) [best, bestD] = [c, d];
  }
  return best !== null && best !== word && bestD <= Math.max(1, Math.floor(word.length / 3)) ? best : null;
}

/** ` (did you mean "x"?)`, or nothing. */
export function suggest(word: string, candidates: Iterable<string>): string {
  const m = didYouMean(word, candidates);
  return m === null ? "" : ` (did you mean ${JSON.stringify(m)}?)`;
}

/** A value as a message names it: `the string "#3a2f3"`, `the number 5`, `an object`. */
export function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "string") return `the string ${JSON.stringify(v.length > 40 ? v.slice(0, 40) + "…" : v)}`;
  if (typeof v === "object") return "an object";
  return typeof v === "number" ? `the number ${v}` : String(v);
}
