// JSON Schema post-processor for arktype-produced schemas.
//
// arktype's `toJsonSchema()` emits string-valued enums as
// `{ enum: ["a", "b"] }` — standard-JSON-Schema-correct (the type is
// inferred from the values), but Moonshot's "flavored" tool-parameters
// validator rejects any property without an explicit `type`. This
// walks the schema and stamps `type: "string"` onto any node that has
// a string-only `enum` and no `type` already.
//
// Every node access goes through an arktype schema so the traversal is
// typed end-to-end, not just `unknown` casts.

import { type, type Type } from "arktype";

const objectNode = type("Record<string, unknown>");
const stringArrayValue = type("string[]");
const arrayOfUnknown = type("unknown[]");

/**
 * Convert an arktype `Type` into the JSON-Schema-shaped `inputSchema`
 * an `@intx/agent` `AgentTool` carries, with the strict-validator
 * fixup applied. Every site that wires an arktype schema into a tool
 * definition should go through here so Moonshot-flavored providers
 * accept the resulting tool surface.
 */
export function toolInputSchema(schema: Type): Record<string, unknown> {
  const raw = { ...schema.toJsonSchema() };
  const fixed = fixupJsonSchemaForStrictValidators(raw);
  const validated = objectNode(fixed);
  if (validated instanceof type.errors) {
    throw new Error(
      `toolInputSchema: fixupJsonSchemaForStrictValidators returned a non-object root: ${validated.summary}`,
    );
  }
  return validated;
}

/**
 * Walk a JSON-Schema document and stamp `type: "string"` onto any
 * object node that carries an all-string `enum` and no `type`.
 * Recurses into `properties`, `items`, `additionalProperties`,
 * `oneOf`, `anyOf`, `allOf`. Idempotent on already-correct schemas.
 */
export function fixupJsonSchemaForStrictValidators(input: unknown): unknown {
  const validatedNode = objectNode(input);
  if (validatedNode instanceof type.errors) return input;
  return fixupObjectNode(validatedNode);
}

function fixupObjectNode(node: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...node };

  if (shouldStampStringType(node)) {
    result["type"] = "string";
  }

  const properties = objectNode(result["properties"]);
  if (!(properties instanceof type.errors)) {
    result["properties"] = mapObjectValues(properties);
  }

  // arktype emits tuples in draft-2020-12 shape:
  //   { type:"array", minItems:N, prefixItems:[...], items:false }
  // Moonshot rejects `items: false` ("items must be an object") and does
  // not understand `prefixItems`. Collapse the whole tuple description
  // into a permissive `items: <single-schema-or-empty>` form.
  if ("prefixItems" in result || result["items"] === false) {
    const prefixItems = arrayOfUnknown(result["prefixItems"]);
    if (!(prefixItems instanceof type.errors)) {
      result["items"] = collapseTupleToSingleItem(
        prefixItems.map((child) =>
          fixupJsonSchemaForStrictValidators(child),
        ),
      );
    } else if (result["items"] === false) {
      result["items"] = {};
    }
    delete result["prefixItems"];
  } else {
    result["items"] = recurseIntoItems(result["items"]);
  }
  result["additionalProperties"] = recurseIntoMaybeSchema(result["additionalProperties"]);

  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const composites = arrayOfUnknown(result[key]);
    if (!(composites instanceof type.errors)) {
      result[key] = composites.map((child) =>
        fixupJsonSchemaForStrictValidators(child),
      );
    }
  }

  return result;
}

function collapseTupleToSingleItem(fixedChildren: unknown[]): unknown {
  if (fixedChildren.length === 0) return {};
  const [head, ...rest] = fixedChildren;
  const allEqual = rest.every(
    (child) => JSON.stringify(child) === JSON.stringify(head),
  );
  return allEqual ? head : {};
}

function shouldStampStringType(node: Record<string, unknown>): boolean {
  if ("type" in node) return false;
  const enumValues = stringArrayValue(node["enum"]);
  return !(enumValues instanceof type.errors);
}

function mapObjectValues(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    mapped[key] = fixupJsonSchemaForStrictValidators(value);
  }
  return mapped;
}

function recurseIntoItems(items: unknown): unknown {
  // arktype emits tuple types (e.g. `[number, number]`) as a JSON Schema
  // `items` field whose value is an ARRAY of per-position schemas. That
  // is valid draft-2019 tuple validation but Moonshot's flavored
  // validator rejects it with "items must be an object". Collapse the
  // array form into a single schema:
  //   - if every position has the same shape, use that shape;
  //   - otherwise use `{}` (no per-item constraint).
  // The runtime check on the orchestrator side still validates against
  // the original arktype tuple — Moonshot only sees the relaxed surface.
  const asArray = arrayOfUnknown(items);
  if (!(asArray instanceof type.errors)) {
    const fixedChildren = asArray.map((child) =>
      fixupJsonSchemaForStrictValidators(child),
    );
    if (fixedChildren.length === 0) return {};
    const [head, ...rest] = fixedChildren;
    const allEqual = rest.every(
      (child) => JSON.stringify(child) === JSON.stringify(head),
    );
    return allEqual ? head : {};
  }
  return recurseIntoMaybeSchema(items);
}

function recurseIntoMaybeSchema(value: unknown): unknown {
  const asObject = objectNode(value);
  if (asObject instanceof type.errors) return value;
  return fixupObjectNode(asObject);
}
