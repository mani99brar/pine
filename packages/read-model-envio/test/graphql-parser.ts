// Minimal GraphQL parser for the fake Hasura endpoint: one `query` operation with variable definitions, root fields with
// arguments (variables, strings, numbers, booleans, null, enums, lists, objects), optional aliases and nested selection
// sets. Fragments, directives and mutations are rejected, as the read model never sends them.

export type Value =
  | { kind: "variable"; name: string }
  | { kind: "string"; value: string }
  | { kind: "int"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "enum"; value: string }
  | { kind: "list"; values: Value[] }
  | { kind: "object"; fields: { name: string; value: Value }[] };

export interface Field {
  alias: string | null;
  name: string;
  args: { name: string; value: Value }[];
  selections: Field[] | null;
}

export interface Operation {
  name: string | null;
  variables: { name: string; type: string }[];
  selections: Field[];
}

type Token = { kind: "punct" | "name" | "string" | "int" | "variable"; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/[\s,]/.test(char)) {
      index += 1;
    } else if (char === "#") {
      while (index < source.length && source[index] !== "\n") index += 1;
    } else if ("{}()[]:!=".includes(char)) {
      tokens.push({ kind: "punct", value: char });
      index += 1;
    } else if (char === "$") {
      const match = /^\$([_A-Za-z][_0-9A-Za-z]*)/.exec(source.slice(index));
      if (!match) throw new SyntaxError("bad variable");
      tokens.push({ kind: "variable", value: match[1]! });
      index += match[0].length;
    } else if (char === '"') {
      const match = /^"((?:[^"\\\n]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*)"/.exec(source.slice(index));
      if (!match) throw new SyntaxError("bad string");
      tokens.push({ kind: "string", value: JSON.parse(`"${match[1]!}"`) as string });
      index += match[0].length;
    } else if (/[-0-9]/.test(char)) {
      const match = /^-?(0|[1-9][0-9]*)(?![.eE0-9])/.exec(source.slice(index));
      if (!match) throw new SyntaxError("only integer literals are supported");
      tokens.push({ kind: "int", value: match[0] });
      index += match[0].length;
    } else if (/[_A-Za-z]/.test(char)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(index))!;
      tokens.push({ kind: "name", value: match[0] });
      index += match[0].length;
    } else {
      throw new SyntaxError(`unexpected character ${JSON.stringify(char)}`);
    }
  }
  return tokens;
}

export function parseOperation(source: string): Operation {
  const tokens = tokenize(source);
  let position = 0;
  const peek = (): Token | undefined => tokens[position];
  const next = (): Token => {
    const token = tokens[position];
    if (!token) throw new SyntaxError("unexpected end of document");
    position += 1;
    return token;
  };
  const expect = (value: string): void => {
    const token = next();
    if (token.kind !== "punct" || token.value !== value) throw new SyntaxError(`expected ${value}`);
  };
  const isPunct = (value: string): boolean => peek()?.kind === "punct" && peek()?.value === value;
  const name = (): string => {
    const token = next();
    if (token.kind !== "name") throw new SyntaxError("expected a name");
    return token.value;
  };

  const type = (): string => {
    let text: string;
    if (isPunct("[")) {
      next();
      text = `[${type()}]`;
      expect("]");
    } else {
      text = name();
    }
    if (isPunct("!")) {
      next();
      text += "!";
    }
    return text;
  };

  const value = (): Value => {
    const token = next();
    if (token.kind === "variable") return { kind: "variable", name: token.value };
    if (token.kind === "string") return { kind: "string", value: token.value };
    if (token.kind === "int") return { kind: "int", value: token.value };
    if (token.kind === "name") {
      if (token.value === "true" || token.value === "false") return { kind: "boolean", value: token.value === "true" };
      if (token.value === "null") return { kind: "null" };
      return { kind: "enum", value: token.value };
    }
    if (token.value === "[") {
      const values: Value[] = [];
      while (!isPunct("]")) values.push(value());
      next();
      return { kind: "list", values };
    }
    if (token.value === "{") {
      const fields: { name: string; value: Value }[] = [];
      while (!isPunct("}")) {
        const key = name();
        expect(":");
        fields.push({ name: key, value: value() });
      }
      next();
      return { kind: "object", fields };
    }
    throw new SyntaxError(`unexpected ${token.value}`);
  };

  const selectionSet = (): Field[] => {
    expect("{");
    const fields: Field[] = [];
    while (!isPunct("}")) {
      let alias: string | null = null;
      let fieldName = name();
      if (isPunct(":")) {
        next();
        alias = fieldName;
        fieldName = name();
      }
      const args: { name: string; value: Value }[] = [];
      if (isPunct("(")) {
        next();
        while (!isPunct(")")) {
          const argName = name();
          expect(":");
          args.push({ name: argName, value: value() });
        }
        next();
      }
      fields.push({ alias, name: fieldName, args, selections: isPunct("{") ? selectionSet() : null });
    }
    next();
    return fields;
  };

  if (name() !== "query") throw new SyntaxError("only query operations are supported");
  const operationName = peek()?.kind === "name" ? name() : null;
  const variables: { name: string; type: string }[] = [];
  if (isPunct("(")) {
    next();
    while (!isPunct(")")) {
      const token = next();
      if (token.kind !== "variable") throw new SyntaxError("expected a variable definition");
      expect(":");
      variables.push({ name: token.value, type: type() });
      if (isPunct("=")) throw new SyntaxError("default values are not supported");
    }
    next();
  }
  const selections = selectionSet();
  if (position !== tokens.length) throw new SyntaxError("only one operation per document");
  return { name: operationName, variables, selections };
}
