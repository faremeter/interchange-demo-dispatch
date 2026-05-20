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

  result["items"] = recurseIntoItems(result["items"]);
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
  const asArray = arrayOfUnknown(items);
  if (!(asArray instanceof type.errors)) {
    return asArray.map((child) => fixupJsonSchemaForStrictValidators(child));
  }
  return recurseIntoMaybeSchema(items);
}

function recurseIntoMaybeSchema(value: unknown): unknown {
  const asObject = objectNode(value);
  if (asObject instanceof type.errors) return value;
  return fixupObjectNode(asObject);
}
