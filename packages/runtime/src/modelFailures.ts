import type { ModelFailure } from "@pixelworlds/generators";

/**
 * Models that failed to generate in a view's bakes (D-072). Each is drawn as
 * a missing-model marker; this counts them, once per model however many
 * tiles and rotations bake it, and reports one error per generator and cause.
 */
export class ModelFailures {
  private readonly models = new Set<string>();
  private readonly causes = new Set<string>();

  /**
   * @param report gets each new (generator, cause) once, as a message.
   * @param unloaded plugins the style pack names that the view didn't load (named for a generator nobody registered).
   */
  constructor(
    private readonly report: (message: string, failure: ModelFailure) => void,
    public unloaded: readonly string[] = [],
  ) {}

  /** Distinct models that failed: a footprint object or landmark by place and seed, a repeated object's variant once. */
  get count(): number {
    return this.models.size;
  }

  add(failures: readonly ModelFailure[]): void {
    for (const f of failures) {
      this.models.add(f.repeated ? `${f.group}#${f.seed}` : `${f.group}@${f.x},${f.y}#${f.seed}`);
      const cause = f.source === null ? "missing" : causeKey(f.error);
      const key = `${f.generator}\u0000${cause}`;
      if (this.causes.has(key)) continue;
      this.causes.add(key);
      this.report(modelFailureMessage(f, this.unloaded), f);
    }
  }
}

/** A cause, the same for messages that differ only in their numbers ("lot too big (11x12)", "(12x9)"). */
function causeKey(error: string): string {
  return error.replace(/-?\d+(\.\d+)?/g, "#");
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/**
 * The error for a model that failed: its group, generator, place, seed and
 * footprint, what went wrong, and for a generator nobody registered, the
 * plugin it comes with (known, or named by the style pack but not loaded).
 */
export function modelFailureMessage(f: ModelFailure, unloaded: readonly string[] = []): string {
  const where = [`cell ${fmt(f.x)},${fmt(f.y)}`, `seed ${f.seed}`];
  if (f.footprint) {
    const { cells, voxels } = f.footprint;
    where.push(`footprint ${fmt(cells[0])}×${fmt(cells[1])} cells (${voxels[0]}×${voxels[1]} voxels)`);
  }
  if (f.heightVox !== undefined) where.push(`${fmt(f.heightVox)} voxels tall`);
  const what = f.repeated ? `a repeated ${f.group} model (first placed at ${where.join(", ")})` : `${f.group} at ${where.join(", ")}`;
  let cause: string;
  if (f.source === null) {
    cause = `generator '${f.generator}' isn't registered: ${f.error}`;
    if (!f.plugin && unloaded.length)
      cause +=
        ` The style pack names the plugin${unloaded.length > 1 ? "s" : ""} ${unloaded.join(", ")}, which this view didn't load: ` +
        `'${f.generator}' likely comes with ${unloaded.length > 1 ? "one of them" : "it"}.`;
  } else {
    cause = `generator '${f.generator}' (${f.source}) failed: ${f.error}`;
  }
  return (
    `model failed: ${what}: ${cause} ` +
    `It is drawn as a missing-model marker; other models of '${f.generator}' that fail alike are only counted (stats().modelsFailed).`
  );
}
