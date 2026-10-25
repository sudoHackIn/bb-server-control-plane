import Ajv from "ajv";
import type { JsonSchema, JsonValue } from "./types.js";
export const SCHEMA_LIMITS = { bytes: 64 * 1024, nodes: 4_096, depth: 64 };
export const VALUE_LIMITS = { bytes: 1024 * 1024, nodes: 100_000, depth: 128 };
export function assertBoundedJson(
  value: unknown,
  path: string,
  limits: { bytes: number; nodes: number; depth: number },
): void {
  const ancestors = new Set<object>();
  let nodes = 0;

  function visit(current: unknown, depth: number): void {
    nodes += 1;
    if (nodes > limits.nodes) {
      throw new Error(`${path} exceeds the ${limits.nodes} node limit`);
    }
    if (depth > limits.depth) {
      throw new Error(`${path} exceeds the maximum depth of ${limits.depth}`);
    }
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new Error(`${path} contains a non-finite number`);
      }
      return;
    }
    if (typeof current !== "object") {
      throw new Error(`${path} contains a non-JSON value`);
    }
    if (ancestors.has(current)) {
      throw new Error(`${path} contains a cyclic value`);
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const keys = Object.keys(current);
        if (
          keys.length !== current.length ||
          keys.some((key, index) => key !== String(index))
        ) {
          throw new Error(`${path} contains a sparse or decorated array`);
        }
        for (const item of current) visit(item, depth + 1);
        return;
      }

      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${path} contains an object with an unsafe prototype`);
      }
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key !== "string") {
          throw new Error(`${path} contains a symbol-keyed property`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          throw new Error(`${path} contains an unsafe property`);
        }
        visit(descriptor.value, depth + 1);
      }
    } finally {
      ancestors.delete(current);
    }
  }

  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error(`${path} is not JSON`);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > limits.bytes) {
    throw new Error(`${path} exceeds the ${limits.bytes} byte limit`);
  }
}

export function validateValue(
  schema: JsonSchema,
  value: JsonValue,
): { valid: true } | { valid: false; error: string } {
  try {
    assertBoundedJson(schema, "JSON Schema", SCHEMA_LIMITS);
    assertBoundedJson(value, "JSON value", VALUE_LIMITS);
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    if (validate(value)) return { valid: true };
    return {
      valid: false,
      error: ajv.errorsText(validate.errors, {
        separator: "; ",
        dataVar: "value",
      }),
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
