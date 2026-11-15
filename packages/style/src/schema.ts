/**
 * The style pack schema (D-075, docs/style-guide.md §18): a JSON Schema
 * (draft-07) for `style.json`, and the source of truth for a pack's shape.
 * `validateStyle` walks it for types, ranges and unknown keys, so the schema
 * editors read and the checks the loader runs can't disagree; what a schema
 * can't say (a ramp a surface names exists, strata run highest first) is
 * checked in index.ts.
 *
 * The editor-facing file, `schema/style-pack.v1.schema.json`, is generated
 * from this module (`styleSchemaDocument`) by its test (`pnpm vitest run
 * packages/style -u`), which fails while it is stale. It adds each key's
 * description (schemaDocs.ts, kept out of the runtime schema so bundles that
 * validate don't carry them), and a lenient variant for packs that `extends`
 * another: every key optional, and `null` allowed to delete one.
 *
 * Versioning: the major version is in the file name and `$id`. Adding an
 * optional key keeps it; removing or renaming a key, or changing what one
 * means, makes a v2 beside v1, and a pack whose `$schema` names a version this
 * library doesn't read is rejected.
 */

import { describe, didYouMean, formatPath, suggest, type PathSegment, type StyleIssue } from "./issues";
import { STYLE_PACK_DOCS } from "./schemaDocs";

export const STYLE_SCHEMA_VERSION = 1;
export const STYLE_SCHEMA_FILE = `style-pack.v${STYLE_SCHEMA_VERSION}.schema.json`;
export const STYLE_SCHEMA_ID = `https://raw.githubusercontent.com/alexngai/pixelworld/main/packages/style/schema/${STYLE_SCHEMA_FILE}`;

/** The subset of JSON Schema (draft-07) the style pack schema uses, and `checkSchema` reads. */
export interface JsonSchema {
  $ref?: string;
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  minProperties?: number;
  maxProperties?: number;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  enum?: readonly (string | number)[];
  const?: string | number;
  pattern?: string;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  anyOf?: JsonSchema[];
  definitions?: Record<string, JsonSchema>;
  /** Editors' message for a value that doesn't match `pattern` (VS Code reads it). */
  patternErrorMessage?: string;
  /** Why a count or range limit exists, added to the message when the value breaks it (VS Code shows it alone). */
  errorMessage?: string;
}

/** Keywords `checkSchema` understands; the schema uses no others (a test checks). */
export const SCHEMA_KEYWORDS: readonly string[] = [
  "$ref",
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "minProperties",
  "maxProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "enum",
  "const",
  "pattern",
  "minLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "anyOf",
  "definitions",
  "patternErrorMessage",
  "errorMessage",
];

export const HEX_PATTERN = "^#[0-9a-fA-F]{6}$";

/** Mirrors index.ts's limits (a test checks): the palette's 256 indices hold 42 ramps of 6 shades. */
const MAX_RAMPS = 42;
const SHADES = 6;
const PATTERN_NAMES = ["none", "trees", "speckle", "sparkle", "fields", "blocks"];

/** Built in a function marked pure, so a bundle that doesn't validate (the bake worker) leaves it out. */
function packSchema(): JsonSchema {
  const ref = (name: string): JsonSchema => ({ $ref: `#/definitions/${name}` });
  const str: JsonSchema = { type: "string", minLength: 1 };
  const num = (range: JsonSchema = {}): JsonSchema => ({ type: "number", ...range });
  const unit = num({ minimum: 0, maximum: 1 });
  const map = (values: JsonSchema, extra: JsonSchema = {}): JsonSchema => ({ type: "object", additionalProperties: values, ...extra });
  const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  });
  const triple: JsonSchema = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 };
  return {
    ...obj(
      {
        $schema: { type: "string" },
        extends: str,
        id: str,
        name: { type: "string" },
        plugins: { type: "array", items: str, uniqueItems: true },
        shades: { type: "integer", const: SHADES },
        background: ref("colour"),
        silhouette: ref("colour"),
        outline: obj({ depthThreshold: num({ exclusiveMinimum: 0 }) }, ["depthThreshold"]),
        ao: obj({ strength: num({ minimum: 0 }) }, ["strength"]),
        terrain: obj({ steepRockSlope: num({ exclusiveMinimum: 0 }) }),
        ramps: map(ref("ramp"), {
          minProperties: 1,
          maxProperties: MAX_RAMPS,
          errorMessage:
            "A pack holds at most 42 ramps: the palette is 256 indexed colours, index 0 the background, 6 shades a ramp " +
            "from index 1, and 253 the silhouette, so 1 + 42 × 6 = 253 (docs/style-guide.md §2).",
        }),
        strataSets: map({ type: "array", minItems: 1, maxItems: 16, items: ref("strataBand") }, { minProperties: 1, maxProperties: 4 }),
        defaultStrata: str,
        provinces: map(str),
        surfaces: map(ref("surface")),
        roads: obj(
          {
            asphalt: str,
            marking: str,
            rail: str,
            lanes: obj(
              {
                ramp: str,
                minPixels: num({ exclusiveMinimum: 0 }),
                dash: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
                median: num({ minimum: 0 }),
              },
              ["ramp", "minPixels"],
            ),
            classes: map(
              obj({ halfWidth: num({ minimum: 0 }), centerLine: { type: "boolean" }, ramp: str, lanes: { type: "boolean" } }, [
                "halfWidth",
                "centerLine",
              ]),
            ),
          },
          ["asphalt", "marking", "classes"],
        ),
        paths: obj({ classes: map(obj({ ramp: str, stripes: { type: "boolean" } }, ["ramp"])) }, ["classes"]),
        assets: map(
          obj(
            {
              generator: str,
              ramps: map(str),
              params: map({ anyOf: [{ type: "number" }, { type: "array", items: { type: "number" } }] }),
            },
            ["generator", "ramps"],
          ),
        ),
        objects: obj(
          { heightStretch: num({ exclusiveMinimum: 0 }), variants: { type: "integer", minimum: 1 }, surfaces: map(ref("surface")) },
          ["heightStretch", "variants"],
        ),
        scatter: map({ type: "array", items: obj({ group: str, perCell: num({ minimum: 0 }) }, ["group", "perCell"]) }),
        night: obj(
          {
            background: ref("colour"),
            saturation: num({ minimum: 0 }),
            multiply: { ...triple, items: num({ minimum: 0 }) },
            add: triple,
            emissive: map(ref("ramp")),
          },
          ["background", "saturation", "multiply", "add", "emissive"],
        ),
        atmosphere: obj({ fog: ref("fog"), steam: ref("steam") }),
      },
      ["id", "name", "shades", "background", "silhouette", "outline", "ao", "ramps", "strataSets", "defaultStrata", "surfaces"],
    ),
    definitions: {
      colour: { type: "string", pattern: HEX_PATTERN, patternErrorMessage: 'A colour is "#rrggbb".' },
      ramp: {
        type: "array",
        items: ref("colour"),
        minItems: SHADES,
        maxItems: SHADES,
        errorMessage: "A ramp is 6 colours, from shade 0 (the outline, darkest) to 5 (the lightest).",
      },
      surface: obj(
        {
          ramp: str,
          pattern: { type: "string", enum: PATTERN_NAMES },
          density: num({ minimum: 0 }),
          light: { type: "string", enum: ["tiles", "slope"] },
        },
        ["ramp", "pattern"],
      ),
      strataBand: obj({ name: { type: "string" }, aboveMeters: num(), ramp: str }, ["name", "aboveMeters", "ramp"]),
      fog: obj(
        {
          ramp: str,
          shade: { type: "integer", minimum: 0, maximum: SHADES - 1 },
          veil: { type: "array", items: unit, minItems: 1 },
          ceilingMeters: num(),
          fadeMeters: num({ exclusiveMinimum: 0 }),
          areas: {
            type: "array",
            items: obj(
              {
                name: { type: "string" },
                polygon: { type: "array", minItems: 3, items: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 } },
                density: unit,
                edgeMeters: num({ minimum: 0 }),
              },
              ["polygon", "density"],
            ),
          },
          drift: obj({ speed: num({ minimum: 0 }), toward: num(), sizeMeters: num({ exclusiveMinimum: 0 }), contrast: unit }, [
            "speed",
            "toward",
            "sizeMeters",
            "contrast",
          ]),
          levels: map(num({ minimum: 0 })),
          night: obj({ density: num({ minimum: 0 }) }, ["density"]),
        },
        ["ramp", "shade", "veil", "ceilingMeters", "fadeMeters", "areas"],
      ),
      steam: obj(
        {
          ramp: str,
          shade: { type: "integer", minimum: 0, maximum: SHADES - 1 },
          veil: { type: "array", items: unit, minItems: 1 },
          sources: map(
            obj(
              {
                heightMeters: num({ exclusiveMinimum: 0 }),
                radiusMeters: num({ exclusiveMinimum: 0 }),
                density: unit,
                minAreaMeters: num({ minimum: 0 }),
              },
              ["heightMeters", "radiusMeters", "density"],
            ),
            { minProperties: 1 },
          ),
          wind: obj({ toward: num(), speed: num({ minimum: 0 }) }, ["toward", "speed"]),
          night: obj({ density: num({ minimum: 0 }) }, ["density"]),
        },
        ["ramp", "shade", "veil", "sources"],
      ),
    },
  };
}

/** The pack's shape: what a resolved pack (no `extends` left) must be. */
export const STYLE_PACK_SCHEMA: JsonSchema = /* @__PURE__ */ packSchema();

/**
 * Where a schema node's description lives in STYLE_PACK_DOCS: `ramps`,
 * `assets.*.generator` (`*` any name), `scatter.*[].group` (`[]` an array's
 * items); definitions start with `#`: `#fog.areas[].density`.
 */
type DocPath = string;
const step = (path: DocPath, s: string) => (path === "" || path === "#" ? `${path}${s}` : `${path}.${s}`);

/** A copy of a schema with the descriptions from `docs` added; `used` collects the paths that had one. */
export function documented(s: JsonSchema, docs: Readonly<Record<DocPath, string>>, path: DocPath, used: Set<DocPath>): JsonSchema {
  const out: JsonSchema = { ...s };
  if (docs[path] !== undefined) {
    out.description = docs[path];
    used.add(path);
  }
  if (s.properties)
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, p]) => [k, documented(p, docs, step(path, k), used)]));
  if (typeof s.additionalProperties === "object") out.additionalProperties = documented(s.additionalProperties, docs, step(path, "*"), used);
  if (s.items) out.items = documented(s.items, docs, `${path}[]`, used);
  if (s.definitions)
    out.definitions = Object.fromEntries(Object.entries(s.definitions).map(([k, d]) => [k, documented(d, docs, `#${k}`, used)]));
  return out;
}

/**
 * The lenient twin of a schema, for packs that extend another: no key is
 * required (the parent has it), and any key may be null (deleting the
 * parent's). Arrays replace whole, so their items keep the strict shape.
 */
function variantOf(s: JsonSchema, defs: Record<string, JsonSchema>, made: Record<string, JsonSchema>): JsonSchema {
  const nullable = (p: JsonSchema): JsonSchema => ({ anyOf: [variantOf(p, defs, made), { type: "null" }] });
  if (s.$ref) {
    const name = s.$ref.replace("#/definitions/", "");
    const target = defs[name]!;
    // only objects change; a ref to anything else stays strict
    if (target.type !== "object") return s;
    if (!made[`${name}Variant`]) made[`${name}Variant`] = variantOf(target, defs, made);
    const { $ref: _ref, ...rest } = s;
    return { ...rest, $ref: `#/definitions/${name}Variant` };
  }
  if (s.type !== "object") return s;
  const { required: _required, minProperties: _min, ...rest } = s;
  const out: JsonSchema = { ...rest };
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, p]) => [k, nullable(p)]));
  if (typeof s.additionalProperties === "object") out.additionalProperties = nullable(s.additionalProperties);
  return out;
}

/** The schema file editors read (`schema/style-pack.v1.schema.json`): strict packs, and lenient ones that extend another. */
export function styleSchemaDocument(): Record<string, unknown> {
  const { definitions = {}, ...pack } = documented(STYLE_PACK_SCHEMA, STYLE_PACK_DOCS, "", new Set());
  const variants: Record<string, JsonSchema> = {};
  const variant = variantOf(pack, definitions, variants);
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: STYLE_SCHEMA_ID,
    title: `pixelworld style pack, v${STYLE_SCHEMA_VERSION}`,
    $comment:
      "Generated from packages/style/src/schema.ts and schemaDocs.ts by their test (pnpm vitest run packages/style -u); edit those, not this. docs/style-guide.md §18.",
    description: pack.description,
    type: "object",
    if: { properties: { extends: { type: "string" } }, required: ["extends"] },
    then: { $ref: "#/definitions/variant" },
    else: { $ref: "#/definitions/pack" },
    definitions: {
      pack,
      variant: {
        ...variant,
        required: ["id", "extends"],
        description: "A pack that extends another: every key is optional, and null deletes the parent's.",
      },
      ...definitions,
      ...variants,
    },
  };
}

// --- checking a value against the schema -------------------------------------------------

const TYPE_NAMES: Record<string, string> = {
  object: "an object",
  array: "an array",
  string: "a string",
  number: "a number",
  integer: "a whole number",
  boolean: "true or false",
  null: "null",
};

function hasType(v: unknown, type: NonNullable<JsonSchema["type"]>): boolean {
  switch (type) {
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return Number.isInteger(v);
    case "null":
      return v === null;
    default:
      return typeof v === type;
  }
}

function resolveRef(s: JsonSchema, root: JsonSchema): JsonSchema {
  if (!s.$ref) return s;
  const target = root.definitions?.[s.$ref.replace("#/definitions/", "")];
  if (!target) throw new Error(`schema: unknown $ref ${s.$ref}`);
  // a $ref's siblings (a description) add to its target
  const { $ref: _ref, ...rest } = s;
  return { ...target, ...rest };
}

/**
 * Check a value against a schema (the subset in SCHEMA_KEYWORDS), adding an
 * issue per problem with its path. Unknown keys get a "did you mean".
 */
export function checkSchema(
  value: unknown,
  schema: JsonSchema = STYLE_PACK_SCHEMA,
  path: PathSegment[] = [],
  issues: StyleIssue[] = [],
  root: JsonSchema = STYLE_PACK_SCHEMA,
): StyleIssue[] {
  const s = resolveRef(schema, root);
  const add = (message: string, at: PathSegment[] = path) => issues.push({ path: formatPath(at), message });
  const why = s.errorMessage ? ` ${s.errorMessage}` : "";

  if (s.anyOf) {
    const tries = s.anyOf.map((branch) => checkSchema(value, branch, path, [], root));
    if (tries.some((t) => t.length === 0)) return issues;
    // a value of one branch's type: that branch's problems; else what the branches want
    const typed = s.anyOf.findIndex((b) => {
      const t = resolveRef(b, root).type;
      return t !== undefined && hasType(value, t);
    });
    if (typed >= 0) issues.push(...tries[typed]!);
    else add(`want ${s.anyOf.map((b) => TYPE_NAMES[resolveRef(b, root).type ?? ""] ?? "a value").join(" or ")}, not ${describe(value)}`);
    return issues;
  }
  if (s.type && !hasType(value, s.type)) {
    add(`want ${TYPE_NAMES[s.type]}, not ${describe(value)}`);
    return issues;
  }
  if (s.const !== undefined && value !== s.const) add(`must be ${JSON.stringify(s.const)}, not ${describe(value)}${why}`);
  if (s.enum && !s.enum.includes(value as string | number))
    add(
      `want one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}, not ${describe(value)}` +
        (typeof value === "string" ? suggest(value, s.enum.map(String)) : ""),
    );

  if (typeof value === "string") {
    if (s.minLength !== undefined && value.length < s.minLength) add(value.length ? `too short` : `must not be empty`);
    if (s.pattern && !new RegExp(s.pattern).test(value))
      add(s.pattern === HEX_PATTERN ? `bad colour ${JSON.stringify(value)}: want "#rrggbb"` : `${JSON.stringify(value)} doesn't match ${s.pattern}`);
  }
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum) add(`want ≥ ${s.minimum}, not ${value}${why}`);
    if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum) add(`want > ${s.exclusiveMinimum}, not ${value}${why}`);
    if (s.maximum !== undefined && value > s.maximum) add(`want ≤ ${s.maximum}, not ${value}${why}`);
  }

  if (Array.isArray(value)) {
    const n = value.length;
    const items = (k: number) => `${k} ${k === 1 ? "entry" : "entries"}`;
    if (s.minItems !== undefined && s.minItems === s.maxItems && n !== s.minItems) add(`has ${items(n)}, want ${s.minItems}.${why}`);
    else {
      if (s.minItems !== undefined && n < s.minItems) add(`has ${items(n)}, want at least ${s.minItems}.${why}`);
      if (s.maxItems !== undefined && n > s.maxItems) add(`has ${items(n)}, want at most ${s.maxItems}.${why}`);
    }
    if (s.uniqueItems) {
      const seen = new Set<string>();
      value.forEach((v, i) => {
        const k = JSON.stringify(v);
        if (seen.has(k)) add(`${describe(v)} is listed twice`, [...path, i]);
        seen.add(k);
      });
    }
    if (s.items) value.forEach((v, i) => checkSchema(v, s.items, [...path, i], issues, root));
  }

  if (s.type === "object" && hasType(value, "object")) {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o);
    const n = keys.length;
    if (s.minProperties !== undefined && n < s.minProperties) add(`has ${n} entries, want at least ${s.minProperties}.${why}`);
    if (s.maxProperties !== undefined && n > s.maxProperties) add(`has ${n} entries, want at most ${s.maxProperties}.${why}`);
    for (const r of s.required ?? []) if (!(r in o)) add(`missing ${JSON.stringify(r)}`, path);
    const known = Object.keys(s.properties ?? {});
    for (const k of keys) {
      const p = s.properties?.[k];
      if (p) checkSchema(o[k], p, [...path, k], issues, root);
      else if (typeof s.additionalProperties === "object") checkSchema(o[k], s.additionalProperties, [...path, k], issues, root);
      else if (s.additionalProperties === false) {
        const hint = didYouMean(k, known);
        add(
          hint !== null
            ? `unknown key ${JSON.stringify(k)} (did you mean ${JSON.stringify(hint)}?)`
            : `unknown key ${JSON.stringify(k)}; ${path.length ? "known here" : "a pack's keys"}: ${known.join(", ")}`,
        );
      }
    }
  }
  return issues;
}
