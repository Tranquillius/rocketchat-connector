// Minimal schema builder for tool and prompt arguments.
// Produces JSON Schema for tools/list and validates incoming arguments, so the
// server needs no third-party packages. API modelled on a small subset of zod:
//
//   s.string().min(1).describe("…"), s.number().int().min(1).max(500).optional(),
//   s.boolean(), s.enum(["a", "b"]), s.array(item), s.union([a, b]), s.record(), s.any()

export class SchemaError extends Error {}

class Schema {
  constructor(kind, props = {}) {
    this.kind = kind;
    this.props = props;
  }
  with(patch) {
    return new Schema(this.kind, { ...this.props, ...patch });
  }
  optional() {
    return this.with({ optional: true });
  }
  describe(description) {
    return this.with({ description });
  }
  int() {
    return this.with({ int: true });
  }
  min(min) {
    return this.with({ min });
  }
  max(max) {
    return this.with({ max });
  }
  regex(pattern, message) {
    return this.with({ pattern, patternMessage: message });
  }
  get isOptional() {
    return !!this.props.optional;
  }

  /** JSON Schema of this value (draft 2020-12 compatible subset). */
  toJSON() {
    const p = this.props;
    let out;
    switch (this.kind) {
      case "string":
        out = { type: "string" };
        if (p.min !== undefined) out.minLength = p.min;
        if (p.max !== undefined) out.maxLength = p.max;
        if (p.pattern) out.pattern = p.pattern.source;
        break;
      case "number":
        out = { type: p.int ? "integer" : "number" };
        if (p.min !== undefined) out.minimum = p.min;
        if (p.max !== undefined) out.maximum = p.max;
        break;
      case "boolean":
        out = { type: "boolean" };
        break;
      case "enum":
        out = { type: "string", enum: [...p.values] };
        break;
      case "array":
        out = { type: "array", items: p.item.toJSON() };
        if (p.min !== undefined) out.minItems = p.min;
        if (p.max !== undefined) out.maxItems = p.max;
        break;
      case "union":
        out = { anyOf: p.options.map((o) => o.toJSON()) };
        break;
      case "record":
        out = { type: "object", additionalProperties: true };
        break;
      default:
        out = {};
    }
    if (p.description) out.description = p.description;
    return out;
  }

  /**
   * Validates (and lightly coerces) a value. Throws SchemaError with a readable path.
   * Numeric strings and "true"/"false" are accepted because some clients send them.
   */
  parse(value, path = "value") {
    const p = this.props;
    const fail = (msg) => {
      throw new SchemaError(`${path}: ${msg}`);
    };
    if (value === undefined || value === null) {
      if (p.optional) return undefined;
      fail("required");
    }
    switch (this.kind) {
      case "string": {
        if (typeof value !== "string") fail("expected a string");
        if (p.min !== undefined && value.length < p.min) fail(p.min === 1 ? "must not be empty" : `must be at least ${p.min} characters`);
        if (p.max !== undefined && value.length > p.max) fail(`must be at most ${p.max} characters`);
        if (p.pattern && !p.pattern.test(value)) fail(p.patternMessage ?? `must match ${p.pattern}`);
        return value;
      }
      case "number": {
        const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
        if (typeof n !== "number" || !Number.isFinite(n)) fail("expected a number");
        if (p.int && !Number.isInteger(n)) fail("expected an integer");
        if (p.min !== undefined && n < p.min) fail(`must be ≥ ${p.min}`);
        if (p.max !== undefined && n > p.max) fail(`must be ≤ ${p.max}`);
        return n;
      }
      case "boolean": {
        if (value === "true") return true;
        if (value === "false") return false;
        if (typeof value !== "boolean") fail("expected true or false");
        return value;
      }
      case "enum": {
        if (!p.values.includes(value)) fail(`expected one of ${p.values.map((v) => `"${v}"`).join(", ")}`);
        return value;
      }
      case "array": {
        if (!Array.isArray(value)) fail("expected an array");
        if (p.min !== undefined && value.length < p.min) fail(`needs at least ${p.min} entr${p.min === 1 ? "y" : "ies"}`);
        if (p.max !== undefined && value.length > p.max) fail(`allows at most ${p.max} entries`);
        return value.map((v, i) => p.item.parse(v, `${path}[${i}]`));
      }
      case "union": {
        const errors = [];
        for (const option of p.options) {
          try {
            return option.parse(value, path);
          } catch (err) {
            if (!(err instanceof SchemaError)) throw err;
            errors.push(err.message.slice(path.length + 2));
          }
        }
        return fail(errors.join(" or "));
      }
      case "record": {
        if (typeof value !== "object" || Array.isArray(value)) fail("expected an object");
        return value;
      }
      default:
        return value;
    }
  }
}

export const s = {
  string: () => new Schema("string"),
  number: () => new Schema("number"),
  boolean: () => new Schema("boolean"),
  enum: (values) => new Schema("enum", { values }),
  array: (item) => new Schema("array", { item }),
  union: (options) => new Schema("union", { options }),
  record: () => new Schema("record"),
  any: () => new Schema("any"),
};

/** JSON Schema for an argument object {name: Schema}. */
export function objectSchema(shape = {}) {
  const properties = {};
  const required = [];
  for (const [key, schema] of Object.entries(shape)) {
    properties[key] = schema.toJSON();
    if (!schema.isOptional) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/** Validates an argument object; unknown keys are dropped. */
export function parseObject(shape = {}, value = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SchemaError("arguments: expected an object");
  const out = {};
  for (const [key, schema] of Object.entries(shape)) {
    const v = schema.parse(value[key], key);
    if (v !== undefined) out[key] = v;
  }
  return out;
}
