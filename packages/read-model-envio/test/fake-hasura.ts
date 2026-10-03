// In-test fake of Envio's Hasura GraphQL endpoint, serving committed entity snapshots that the real indexer-envio
// handlers produced (never rows mapped by hand). Hasura semantics reproduced (and tested in fake-hasura.test.ts):
// - root fields `<Entity>(where, order_by, limit, offset)`, `<Entity>_by_pk(id)` and `_meta`;
// - variable types must be Hasura's (`<Entity>_bool_exp`, `[<Entity>_order_by!]`, `Int`, `String!`);
// - BigInt (Postgres numeric) values are returned as decimal strings (stringified numerics) and compared numerically
//   by `_eq/_neq/_gt/_lt/_gte/_lte/_in`, with numeric inputs accepted as decimal strings or integers;
// - String/ID comparisons and ordering use code-point order (equal to Postgres collation order for the fixed-length
//   lowercase hex ids the read model compares);
// - Int as JSON numbers, Boolean as booleans, Json as stored, nullable fields as null, enums as their names;
// - unknown fields, arguments or types give a GraphQL `errors` response (HTTP 200), as Hasura does.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike, FetchResponseLike } from "../src/read-model.js";
import { parseOperation, type Field, type Value } from "./graphql-parser.js";
import type { EntitySnapshot, Row } from "./snapshots.js";

const SCHEMA_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../indexer-envio/schema.graphql");

export interface FieldType {
  base: string;
  nonNull: boolean;
}

/** Entity -> field -> type, read from the indexer's real schema.graphql. */
export function loadSchema(text = readFileSync(SCHEMA_PATH, "utf8")): Map<string, Map<string, FieldType>> {
  const entities = new Map<string, Map<string, FieldType>>();
  let current: Map<string, FieldType> | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const open = /^type (\w+) \{$/.exec(line);
    if (open) {
      current = new Map();
      entities.set(open[1]!, current);
      continue;
    }
    if (line === "}") {
      current = null;
      continue;
    }
    const field = /^(\w+): (\[?\w+!?\]?)(!?)/.exec(line);
    if (current && field) current.set(field[1]!, { base: field[2]!.replace(/[[\]!]/g, ""), nonNull: field[3] === "!" || field[2]!.endsWith("!") });
  }
  return entities;
}

class GraphqlError extends Error {}

/** A response whose body is a byte stream, as fetch's is (the read model reads it incrementally under its cap). */
export function jsonResponse(payload: unknown, status = 200): FetchResponseLike {
  return { ok: status >= 200 && status < 300, status, body: new Response(JSON.stringify(payload)).body };
}

export interface FakeRequest {
  url: string;
  headers: Record<string, string>;
  operationName: unknown;
  query: string;
  variables: Record<string, unknown>;
}

export interface FakeHasuraOptions {
  url: string;
  /** When set, requests without this x-hasura-admin-secret get a GraphQL access error. */
  adminSecret?: string;
  chainId?: number;
  /** _meta.sourceBlock - progressBlock (Envio's block lag). */
  blockLag?: number;
}

export interface FakeHasura {
  fetch: FetchLike;
  requests: FakeRequest[];
}

export function createFakeHasura(snapshot: EntitySnapshot, options: FakeHasuraOptions): FakeHasura {
  const schema = loadSchema();
  const requests: FakeRequest[] = [];
  const chainId = options.chainId ?? 100;

  const progress = snapshot.entities.IndexerProgress?.find((row) => row.id === String(chainId));
  const progressBlock = progress ? Number(progress.blockNumber) : 0;

  const fetch: FetchLike = async (url, init) => {
    if (url !== options.url) throw new TypeError("fake: request to an unexpected URL");
    if (init.method !== "POST" || init.redirect !== "error") throw new TypeError("fake: unexpected request options");
    const body = JSON.parse(init.body) as { operationName?: unknown; query?: unknown; variables?: unknown };
    const variables = (body.variables ?? {}) as Record<string, unknown>;
    requests.push({ url, headers: { ...init.headers }, operationName: body.operationName, query: String(body.query), variables });
    const respond = (payload: unknown) => jsonResponse(payload);
    if (options.adminSecret !== undefined && init.headers["x-hasura-admin-secret"] !== options.adminSecret) {
      return respond({ errors: [{ message: "x-hasura-admin-secret/x-hasura-access-key required, but not found", extensions: { code: "access-denied" } }] });
    }
    try {
      if (typeof body.query !== "string") throw new GraphqlError("query is required");
      return respond({ data: execute(body.query, variables) });
    } catch (error) {
      if (error instanceof GraphqlError || error instanceof SyntaxError) return respond({ errors: [{ message: error.message, extensions: { code: "validation-failed" } }] });
      throw error;
    }
  };

  function execute(query: string, variables: Record<string, unknown>): Record<string, unknown> {
    const operation = parseOperation(query);
    const declared = new Map(operation.variables.map((item) => [item.name, item.type]));
    for (const [name, type] of declared) {
      if (type.endsWith("!") && (variables[name] === undefined || variables[name] === null)) throw new GraphqlError(`expecting a value for non-nullable variable: ${name}`);
    }
    const data: Record<string, unknown> = {};
    for (const field of operation.selections) data[field.alias ?? field.name] = resolveRoot(field, declared, variables);
    return data;
  }

  function argValue(value: Value, declared: Map<string, string>, variables: Record<string, unknown>, expectedType: string | null): unknown {
    switch (value.kind) {
      case "variable": {
        const type = declared.get(value.name);
        if (type === undefined) throw new GraphqlError(`unbound variable ${value.name}`);
        if (expectedType !== null && !typeMatches(type, expectedType)) throw new GraphqlError(`variable ${value.name} of type ${type} is used where ${expectedType} is expected`);
        return variables[value.name] ?? null;
      }
      case "string":
        return value.value;
      case "int":
        return Number(value.value);
      case "boolean":
        return value.value;
      case "null":
        return null;
      case "enum":
        return value.value;
      case "list":
        return value.values.map((item) => argValue(item, declared, variables, null));
      case "object":
        return Object.fromEntries(value.fields.map((item) => [item.name, argValue(item.value, declared, variables, null)]));
    }
  }

  function resolveRoot(field: Field, declared: Map<string, string>, variables: Record<string, unknown>): unknown {
    if (field.name === "_meta") {
      if (field.args.length > 0) throw new GraphqlError("fake: _meta arguments are not served");
      const row: Row = { chainId, progressBlock, sourceBlock: progressBlock + (options.blockLag ?? 40), isReady: true };
      return [project(row, field.selections, null, "_meta")];
    }
    const byPk = /^(\w+)_by_pk$/.exec(field.name);
    const entityName = byPk ? byPk[1]! : field.name;
    const types = schema.get(entityName);
    if (!types) throw new GraphqlError(`field '${field.name}' not found in type: 'query_root'`);
    const rows = snapshot.entities[entityName] ?? [];
    if (byPk) {
      const args = new Map(field.args.map((arg) => [arg.name, arg.value]));
      if (args.size !== 1 || !args.has("id")) throw new GraphqlError(`${field.name} takes exactly the argument id`);
      const id = argValue(args.get("id")!, declared, variables, "String!");
      if (typeof id !== "string") throw new GraphqlError("id must be a String");
      const row = rows.find((item) => item.id === id);
      return row ? project(row, field.selections, types, entityName) : null;
    }
    let result = [...rows];
    let limit: number | null = null;
    let offset = 0;
    for (const arg of field.args) {
      if (arg.name === "where") {
        const where = argValue(arg.value, declared, variables, `${entityName}_bool_exp`);
        result = result.filter((row) => matches(row, where, types, entityName));
      } else if (arg.name === "order_by") {
        const orderBy = argValue(arg.value, declared, variables, `[${entityName}_order_by!]`);
        result.sort(comparator(Array.isArray(orderBy) ? orderBy : [orderBy], types, entityName));
      } else if (arg.name === "limit" || arg.name === "offset") {
        const number = argValue(arg.value, declared, variables, "Int");
        if (typeof number !== "number" || !Number.isInteger(number) || number < 0) throw new GraphqlError(`${arg.name} must be a non-negative Int`);
        if (arg.name === "limit") limit = number;
        else offset = number;
      } else {
        throw new GraphqlError(`'${field.name}' has no argument named '${arg.name}'`);
      }
    }
    result = result.slice(offset, limit === null ? undefined : offset + limit);
    return result.map((row) => project(row, field.selections, types, entityName));
  }

  return { fetch, requests };
}

/** Hasura accepts a variable whose type is the expected one, optionally non-null (lists may hold non-null items). */
function typeMatches(declared: string, expected: string): boolean {
  const strip = (type: string) => type.replace(/!$/, "");
  const normalize = (type: string) => strip(type).replace(/^\[(.+?)!?\]$/, "[$1]");
  if (expected.endsWith("!") && !declared.endsWith("!")) return false;
  return normalize(declared) === normalize(expected);
}

function project(row: Row, selections: Field[] | null, types: Map<string, FieldType> | null, entity: string): Record<string, unknown> {
  if (selections === null) throw new GraphqlError(`field '${entity}' must have a selection of subfields`);
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    if (field.args.length > 0 || field.selections !== null) throw new GraphqlError(`fake: nested selections on ${entity} are not served`);
    if (types !== null && !types.has(field.name)) throw new GraphqlError(`field '${field.name}' not found in type: '${entity}'`);
    out[field.alias ?? field.name] = row[field.name] ?? null;
  }
  return out;
}

const NUMERIC = /^-?(0|[1-9][0-9]*)$/;

function numericInput(value: unknown): bigint {
  if (typeof value === "string" && NUMERIC.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new GraphqlError("invalid input for a numeric column");
}

function compareValues(left: unknown, right: unknown, type: FieldType): number {
  if (type.base === "BigInt" || type.base === "Int") {
    const a = numericInput(left);
    const b = numericInput(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof left === "boolean" || typeof right === "boolean") return left === right ? 0 : left === false ? -1 : 1;
  if (typeof left !== "string" || typeof right !== "string") throw new GraphqlError("unexpected value for a text column");
  return left < right ? -1 : left > right ? 1 : 0;
}

function matches(row: Row, where: unknown, types: Map<string, FieldType>, entity: string): boolean {
  if (where === null || typeof where !== "object" || Array.isArray(where)) throw new GraphqlError(`expected an object for ${entity}_bool_exp`);
  for (const [key, condition] of Object.entries(where)) {
    if (key === "_and" || key === "_or") {
      if (!Array.isArray(condition)) throw new GraphqlError(`${key} expects a list`);
      const results = condition.map((item) => matches(row, item, types, entity));
      if (key === "_and" ? !results.every(Boolean) : !results.some(Boolean)) return false;
      continue;
    }
    if (key === "_not") {
      if (matches(row, condition, types, entity)) return false;
      continue;
    }
    const type = types.get(key);
    if (!type || type.base === "Json") throw new GraphqlError(`field '${key}' not found in type: '${entity}_bool_exp'`);
    if (condition === null || typeof condition !== "object" || Array.isArray(condition)) throw new GraphqlError(`expected a comparison for ${key}`);
    const value = row[key] ?? null;
    for (const [operator, operand] of Object.entries(condition)) {
      if (operand === null) throw new GraphqlError(`unexpected null for ${key}.${operator}`);
      let ok: boolean;
      if (operator === "_in") {
        if (!Array.isArray(operand)) throw new GraphqlError("_in expects a list");
        ok = value !== null && operand.some((item) => compareValues(value, item, type) === 0);
      } else if (operator === "_is_null") {
        ok = (value === null) === operand;
      } else {
        if (value === null) return false; // SQL: comparisons with NULL are not true.
        const order = compareValues(value, operand, type);
        const results: Record<string, boolean> = { _eq: order === 0, _neq: order !== 0, _gt: order > 0, _lt: order < 0, _gte: order >= 0, _lte: order <= 0 };
        if (!(operator in results)) throw new GraphqlError(`field '${operator}' not found in type: '${type.base}_comparison_exp'`);
        ok = results[operator]!;
      }
      if (!ok) return false;
    }
  }
  return true;
}

function comparator(orderBy: unknown[], types: Map<string, FieldType>, entity: string): (a: Row, b: Row) => number {
  const keys = orderBy.flatMap((item) => {
    if (item === null || typeof item !== "object") throw new GraphqlError(`expected ${entity}_order_by objects`);
    return Object.entries(item).map(([field, direction]) => {
      const type = types.get(field);
      if (!type || type.base === "Json") throw new GraphqlError(`field '${field}' not found in type: '${entity}_order_by'`);
      if (direction !== "asc" && direction !== "desc") throw new GraphqlError(`unexpected order_by value ${String(direction)}`);
      return { field, type, sign: direction === "asc" ? 1 : -1 };
    });
  });
  return (a, b) => {
    for (const key of keys) {
      const left = a[key.field] ?? null;
      const right = b[key.field] ?? null;
      if (left === null || right === null) {
        if (left === right) continue;
        return (left === null ? 1 : -1) * key.sign; // Postgres: NULLS LAST for asc, FIRST for desc.
      }
      const order = compareValues(left, right, key.type);
      if (order !== 0) return order * key.sign;
    }
    return 0;
  };
}
