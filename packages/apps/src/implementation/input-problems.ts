import { Match, Schema, SchemaAST, SchemaIssue } from "effect";
import { HostInputInvalid, maxInputProblems } from "../contracts/host.ts";
import {
  allowedValues,
  echoableKey,
  maxAlternativeKeys,
  objectShape,
  unionShape,
} from "./schema.ts";

/** A native object by its declared keys, as imported JSON Schema objects are described. */
const nativeObjectShape = (ast: SchemaAST.Objects, limit?: number) =>
  objectShape(
    ast.propertySignatures.flatMap(({ name, type }) =>
      typeof name === "string"
        ? [{ name, optional: SchemaAST.isOptional(SchemaAST.toEncoded(type)) }]
        : [],
    ),
    ast.indexSignatures.length > 0,
    limit,
  );

/** The members of a union that JSON input can match. `undefined` only marks an optional key. */
const unionMembers = (ast: SchemaAST.AST): readonly SchemaAST.AST[] =>
  SchemaAST.isUnion(ast)
    ? ast.types.flatMap(unionMembers)
    : SchemaAST.isUndefined(ast) || SchemaAST.isVoid(ast)
      ? []
      : [ast];

/** The values a schema of literals and enums allows; undefined when it accepts other values. */
const fixedValues = (ast: SchemaAST.AST): readonly unknown[] | undefined => {
  if (SchemaAST.isLiteral(ast)) return [ast.literal];
  if (SchemaAST.isEnum(ast)) return ast.enums.map(([, value]) => value);
  if (!SchemaAST.isUnion(ast)) return undefined;
  const members = unionMembers(ast).map(fixedValues);
  return members.length > 0 &&
    members.every((values): values is readonly unknown[] => values !== undefined)
    ? members.flat()
    : undefined;
};

/** A union member by its type and object keys, as JSON Schema alternatives are described. */
const describeMember = (ast: SchemaAST.AST): string =>
  Match.value(ast).pipe(
    Match.when(SchemaAST.isObjects, (objects) =>
      objects.propertySignatures.length > 0
        ? nativeObjectShape(objects, maxAlternativeKeys)
        : "object",
    ),
    Match.when(SchemaAST.isArrays, () => "array"),
    Match.when(SchemaAST.isTemplateLiteral, () => "a string matching a template"),
    Match.when(SchemaAST.isString, () => "string"),
    Match.when(SchemaAST.isNumber, () => "number"),
    Match.when(SchemaAST.isBoolean, () => "boolean"),
    Match.when(SchemaAST.isNull, () => "null"),
    Match.orElse(() => "a value with other constraints"),
  );

/** The key every object member fixes to its own value, such as an account router's account. */
const memberSelector = (members: readonly SchemaAST.AST[]) => {
  const [first] = members;
  if (members.length < 2 || first === undefined || !SchemaAST.isObjects(first)) return undefined;
  return first.propertySignatures
    .map(({ name }) => name)
    .find(
      (name): name is string =>
        typeof name === "string" &&
        members.every(
          (member) =>
            SchemaAST.isObjects(member) &&
            member.propertySignatures.some(
              (property) =>
                property.name === name &&
                fixedValues(SchemaAST.toEncoded(property.type)) !== undefined,
            ),
        ),
    );
};

/**
 * A union that no member applied to, by the values its literal members allow and its other
 * members' shapes. The native message lists literals without a bound and describes objects by
 * their types rather than their keys.
 */
const expectedUnion = (ast: SchemaAST.Union) => {
  const members = unionMembers(ast);
  const fixed = members.map(fixedValues);
  const values = fixed.flatMap((memberValues) => (memberValues === undefined ? [] : memberValues));
  const others = members.filter((_, index) => fixed[index] === undefined);
  if (others.length === 0) return `Expected ${allowedValues(values)}`;
  return `Expected ${unionShape(
    [
      ...(values.length === 0 ? [] : [allowedValues(values)]),
      ...new Set(others.map(describeMember)),
    ],
    memberSelector(members),
  )}`;
};

// Reported input only exists when a parser opts in; never render it either way.
const leafHook: SchemaIssue.LeafHook = (issue) =>
  SchemaIssue.hasInput(issue)
    ? "Invalid value"
    : Match.value(issue).pipe(
        Match.tag("InvalidType", ({ ast }) => {
          const values = fixedValues(ast);
          return values !== undefined
            ? `Expected ${allowedValues(values)}`
            : SchemaAST.isObjects(ast) && ast.propertySignatures.length > 0
              ? `Expected ${nativeObjectShape(ast)}`
              : SchemaIssue.defaultLeafHook(issue);
        }),
        Match.orElse(SchemaIssue.defaultLeafHook),
      );
const checkHook: SchemaIssue.CheckHook = (issue) =>
  SchemaIssue.hasInput(issue) || SchemaIssue.hasInput(issue.issue)
    ? (SchemaIssue.defaultCheckHook(issue) ?? "Invalid value")
    : SchemaIssue.defaultCheckHook(issue);
const format = SchemaIssue.makeFormatterStandardSchemaV1({ leafHook, checkHook });

interface Located {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/**
 * Problems by path, as the Standard Schema formatter flattens them, except that a union no member
 * applied to is described by {@link expectedUnion}.
 */
const located = (issue: SchemaIssue.Issue, path: readonly PropertyKey[]): readonly Located[] =>
  Match.value(issue).pipe(
    Match.tag("Pointer", (pointer) => located(pointer.issue, [...path, ...pointer.path])),
    Match.tag("Composite", ({ issues }) => issues.flatMap((issue) => located(issue, path))),
    Match.tag("Encoding", (encoding) => located(encoding.issue, path)),
    Match.tag("AnyOf", ({ ast, issues }) =>
      issues.length === 0
        ? [{ path, message: expectedUnion(ast) }]
        : issues.flatMap((issue) => located(issue, path)),
    ),
    Match.orElse((issue) =>
      format(issue).issues.map((problem) => ({
        path: [
          ...path,
          ...(problem.path ?? []).map((key) => (typeof key === "object" ? key.key : key)),
        ],
        message: problem.message,
      })),
    ),
  );

// Field names and indexes locate the problem; keys that could carry supplied data are not echoed.
const segment = (key: PropertyKey) =>
  typeof key === "number"
    ? `[${key}]`
    : typeof key === "string" && echoableKey(key)
      ? `.${key}`
      : "[key]";

/**
 * Failing input paths and what each expects, from a schema decode failure, without supplied
 * values. An expected object names its keys, so a caller can correct nesting from the problem.
 */
export const inputInvalid = (error: unknown): HostInputInvalid => {
  if (!Schema.isSchemaError(error)) return new HostInputInvalid();
  const problems = located(error.issue, [])
    .slice(0, maxInputProblems)
    .map(({ path, message }) => {
      const location = path.map(segment);
      return `${location.length === 0 ? "input" : `input${location.join("")}`}: ${message}`.slice(
        0,
        512,
      );
    });
  return new HostInputInvalid({ problems });
};
