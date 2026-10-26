import {
  Kind,
  parse,
  visit,
  type DocumentNode,
  type FieldNode,
  type OperationDefinitionNode,
  type ValueNode,
} from "graphql";

/**
 * One GraphQL operation a page asked for, read with the real GraphQL parser:
 * what kind of operation the server will run, its root fields, and every
 * value it carries, from inline arguments, variable defaults and the
 * variables object alike. Comments, line endings and string escapes are the
 * parser's business, never a pattern's.
 */
export interface GraphQlOperation {
  type: "query" | "mutation" | "subscription";
  rootFields: FieldNode[];
  /** Inline argument values and variable defaults, decoded. */
  literals: string[];
  /** The variables object sent with it, parsed from JSON. */
  variables: unknown;
  /** Arguments given a value other than a variable. */
  inlineArguments: number;
  /** Variables declared with a default value. */
  variableDefaults: number;
}

function valueStrings(value: ValueNode, into: string[]): void {
  switch (value.kind) {
    case Kind.STRING:
    case Kind.ENUM:
    case Kind.INT:
    case Kind.FLOAT:
      into.push(value.value);
      return;
    case Kind.BOOLEAN:
      into.push(String(value.value));
      return;
    case Kind.LIST:
      for (const item of value.values) valueStrings(item, into);
      return;
    case Kind.OBJECT:
      for (const field of value.fields) valueStrings(field.value, into);
      return;
    default:
      return;
  }
}

function describe(
  document: DocumentNode,
  operation: OperationDefinitionNode,
  variables: unknown,
): GraphQlOperation {
  const literals: string[] = [];
  let inlineArguments = 0;
  let variableDefaults = 0;
  visit(document, {
    Argument(node) {
      if (node.value.kind !== Kind.VARIABLE) inlineArguments += 1;
      valueStrings(node.value, literals);
    },
    VariableDefinition(node) {
      if (node.defaultValue) {
        variableDefaults += 1;
        valueStrings(node.defaultValue, literals);
      }
    },
  });
  return {
    type: operation.operation as GraphQlOperation["type"],
    rootFields: operation.selectionSet.selections.filter(
      (selection): selection is FieldNode =>
        selection.kind === Kind.FIELD && selection.name.value !== "__typename",
    ),
    literals,
    variables,
    inlineArguments,
    variableDefaults,
  };
}

/**
 * The operation each entry of a GraphQL request body would run, or null when
 * the body is not one the parser reads cleanly: not JSON, a key other than
 * operationName/query/variables/extensions, a document that does not parse,
 * a fragment-only or ambiguous document, or an operationName it lacks.
 */
export function readGraphQlRequest(
  bodyText: string | null | undefined,
): GraphQlOperation[] | null {
  if (!bodyText || bodyText.length > 65_536) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.length === 0) return null;
  const operations: GraphQlOperation[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return null;
    const request = entry as Record<string, unknown>;
    if (
      Object.keys(request).some(
        (key) =>
          !["operationName", "query", "variables", "extensions"].includes(key),
      ) ||
      typeof request.query !== "string"
    )
      return null;
    let document: DocumentNode;
    try {
      document = parse(request.query, { noLocation: true });
    } catch {
      return null;
    }
    const defined = document.definitions.filter(
      (definition): definition is OperationDefinitionNode =>
        definition.kind === Kind.OPERATION_DEFINITION,
    );
    const name =
      typeof request.operationName === "string" && request.operationName
        ? request.operationName
        : null;
    const chosen = name
      ? defined.filter((definition) => definition.name?.value === name)
      : defined;
    // The server runs exactly one operation per entry; anything ambiguous is
    // not read at all.
    if (chosen.length !== 1) return null;
    operations.push(describe(document, chosen[0]!, request.variables ?? null));
  }
  return operations;
}

/** Every string and number in a variables object, for answer checks. */
export function variableStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (typeof value === "number" || typeof value === "boolean")
    into.push(String(value));
  else if (Array.isArray(value))
    for (const item of value) variableStrings(item, into);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) variableStrings(item, into);
  return into;
}
