import type { ObjectsFile } from "./manifest";

/** Objects file versions this reader understands (docs/world-format.md). */
export const READABLE_OBJECTS_VERSIONS = [1, 2] as const;

export class ObjectsFormatError extends Error {}

/** v in hundredths of a cell, rounded half up in double precision, as the pipeline writes it. */
const hundredths = (v: number): number => Math.floor(v * 100 + 0.5);

/**
 * Validate a parsed objects file and return it with absolute footprints.
 *
 * Version 1 stores footprint points in cells. Version 2 stores each point as
 * integer hundredths of a cell from its instance's anchor rounded to
 * hundredths, so a point is `(⌊100·x + ½⌋ + dx) / 100`: the same numbers
 * version 1 held. Instances with a footprint are copied, not changed in place.
 */
export function parseObjects(json: unknown): ObjectsFile {
  if (typeof json !== "object" || json === null) throw new ObjectsFormatError("objects file must be an object");
  const file = json as Partial<ObjectsFile>;
  if (!READABLE_OBJECTS_VERSIONS.includes(file.version as 1 | 2))
    throw new ObjectsFormatError(`unsupported objects file version ${String(file.version)}`);
  if (!Array.isArray(file.instances)) throw new ObjectsFormatError("objects file has no instances");
  if (file.version === 1) return file as ObjectsFile;
  const instances = file.instances.map((inst) => {
    if (!inst.fp) return inst;
    const ax = hundredths(inst.x);
    const ay = hundredths(inst.y);
    const fp = inst.fp.map(([dx, dy]) => [(ax + dx) / 100, (ay + dy) / 100] as [number, number]);
    if (!inst.fh) return { ...inst, fp };
    const fh = inst.fh.map((ring) => ring.map(([dx, dy]) => [(ax + dx) / 100, (ay + dy) / 100] as [number, number]));
    return { ...inst, fp, fh };
  });
  return { version: 2, instances };
}
