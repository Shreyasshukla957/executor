/**
 * Repository lint rules. `.oxlintrc.jsonc` chooses the files each rule covers.
 * Adapted from the rat-stack Oxlint plugins.
 */
import { definePlugin, defineRule, type ESTree } from "@oxlint/plugins";

/** True when a `var` binding is hoisted to module scope rather than into a function. */
const hoistedToModule = (node: ESTree.Node) => {
  for (let current = node.parent; current !== null; current = current.parent) {
    switch (current.type) {
      case "Program":
        return true;
      case "ArrowFunctionExpression":
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "StaticBlock":
      case "TSModuleBlock":
        return false;
    }
  }
  return false;
};

/** `let` is module state only when declared directly in the module body. */
const declaredInModuleBody = (node: ESTree.VariableDeclaration) =>
  node.parent.type === "Program" ||
  (node.parent.type === "ExportNamedDeclaration" && node.parent.parent.type === "Program");

const noModuleLevelMutableState = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Keep mutable state out of module-level let and var bindings." },
    messages: {
      moduleState:
        "Module-level let and var are shared by every request a Worker isolate or server process handles. Keep state in a Ref or service owned by a Layer, or in storage.",
    },
  },
  create: (context) => ({
    VariableDeclaration(node) {
      if (node.declare || (node.kind !== "let" && node.kind !== "var")) return;
      if (node.kind === "let" ? declaredInModuleBody(node) : hoistedToModule(node))
        context.report({ node, messageId: "moduleState" });
    },
  }),
});

const runners = new Set([
  "runCallback",
  "runCallbackWith",
  "runFork",
  "runForkWith",
  "runPromise",
  "runPromiseExit",
  "runPromiseExitWith",
  "runPromiseWith",
  "runSync",
  "runSyncExit",
  "runSyncExitWith",
  "runSyncWith",
]);

/** `Effect.runPromise(...)` and friends, or `ManagedRuntime.make(...)`. */
const manualRunner = (callee: ESTree.Node) => {
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.object.type !== "Identifier" ||
    callee.property.type !== "Identifier"
  )
    return undefined;
  const call = `${callee.object.name}.${callee.property.name}`;
  if (callee.object.name === "Effect" && runners.has(callee.property.name)) return call;
  if (call === "ManagedRuntime.make") return call;
  return undefined;
};

const noManualEffectRuntimeInTests = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Run scenario Effects through @effect/vitest instead of starting a runtime by hand.",
    },
    messages: {
      manualRunner:
        "{{call}} runs an Effect outside the scenario's runtime. Use @effect/vitest `layer` and `it.effect`, and inject capabilities as services. Bridges to Promise callbacks need a disable comment saying which API requires one.",
    },
  },
  create: (context) => ({
    CallExpression(node) {
      const call = manualRunner(node.callee);
      if (call !== undefined)
        context.report({ node: node.callee, messageId: "manualRunner", data: { call } });
    },
  }),
});

/** Effects whose waiters resume when another fiber finishes shared, in-flight work. */
const sharedWaits = new Map([
  ["Effect", new Set(["cached", "cachedWithTTL", "cachedInvalidateWithTTL"])],
  ["Deferred", new Set(["make", "makeUnsafe"])],
  ["Semaphore", new Set(["make", "makeUnsafe"])],
  ["Latch", new Set(["make", "makeUnsafe"])],
  ["Cache", new Set(["make", "makeWith"])],
  ["RcMap", new Set(["make"])],
]);

/** `Effect.cached(...)` and the other constructors above, by their written name. */
const sharedWait = (callee: ESTree.Node) => {
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.object.type !== "Identifier" ||
    callee.property.type !== "Identifier"
  )
    return undefined;
  return sharedWaits.get(callee.object.name)?.has(callee.property.name)
    ? `${callee.object.name}.${callee.property.name}`
    : undefined;
};

/** `Effect.gen(...)`, possibly followed by `.pipe(...)`, unwrapped to its generator. */
const generatorOf = (node: ESTree.Node): ESTree.Node | undefined => {
  if (node.type !== "CallExpression") return undefined;
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || callee.computed) return undefined;
  if (callee.property.type === "Identifier" && callee.property.name === "pipe")
    return generatorOf(callee.object);
  if (
    callee.object.type === "Identifier" &&
    callee.object.name === "Effect" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "gen"
  )
    return node.arguments.find((argument) => argument.type === "FunctionExpression");
  return undefined;
};

/**
 * The generator that initializes a Worker's handlers: the second argument of
 * `export default Entrypoint.make(props, Effect.gen(...))`. It runs once per isolate, and every
 * request the isolate serves uses what it returns.
 */
const isWorkerInitialization = (fn: ESTree.Node) => {
  const gen = fn.parent;
  if (gen?.type !== "CallExpression") return false;
  let handlers: ESTree.Node = gen;
  while (
    handlers.parent?.type === "MemberExpression" &&
    handlers.parent.parent?.type === "CallExpression"
  )
    handlers = handlers.parent.parent;
  const make = handlers.parent;
  return (
    make?.type === "CallExpression" &&
    make.arguments.length === 2 &&
    make.arguments[1] === handlers &&
    generatorOf(handlers) === fn &&
    make.callee.type === "MemberExpression" &&
    make.callee.property.type === "Identifier" &&
    make.callee.property.name === "make" &&
    make.parent?.type === "ExportDefaultDeclaration"
  );
};

/** The nearest function around a node. */
const enclosingFunction = (node: ESTree.Node) => {
  for (let current = node.parent; current !== null; current = current.parent)
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression"
    )
      return current;
  return undefined;
};

const noSharedWaitInWorkerInitialization = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep in-flight work that several requests can wait on out of a Worker's initialization.",
    },
    messages: {
      sharedWait:
        "{{call}} in a Worker's initialization is shared by every request the isolate serves. A request that waits on it resumes in the I/O context of the request that finished it: its timers can be dropped when that request ends, and its Dynamic Workers count against that request's limit. Create it per call, or keep only settled values.",
    },
  },
  create: (context) => ({
    CallExpression(node) {
      const call = sharedWait(node.callee);
      if (call === undefined) return;
      const fn = enclosingFunction(node);
      if (fn !== undefined && isWorkerInitialization(fn))
        context.report({ node: node.callee, messageId: "sharedWait", data: { call } });
    },
  }),
});

/** The named type of `x as T`, `<T>x` or `x satisfies T`, including `ns.T`. */
const assertedTypeName = (type: ESTree.TSType) => {
  if (type.type !== "TSTypeReference") return undefined;
  const name = type.typeName;
  if (name.type === "Identifier") return name.name;
  if (name.type === "TSQualifiedName") return name.right.name;
  return undefined;
};

const noProofForgery = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Mint authorization proofs only in their proofs module." },
    messages: {
      forged:
        "{{name}} is evidence that a policy check passed. Obtain it from the proofs module that runs the check instead of asserting the type.",
    },
  },
  create: (context) => {
    const check = (node: ESTree.TSAsExpression | ESTree.TSTypeAssertion) => {
      const name = assertedTypeName(node.typeAnnotation);
      if (name !== undefined && name.endsWith("Proof"))
        context.report({ node, messageId: "forged", data: { name } });
    };
    return { TSAsExpression: check, TSTypeAssertion: check };
  },
});

/** Calls along a fluent chain such as `endpoint.annotate(...).pipe(...)`, outermost first. */
function* chainCalls(node: ESTree.Node): Generator<ESTree.CallExpression> {
  let current: ESTree.Node = node;
  while (current.type === "CallExpression") {
    yield current;
    const callee: ESTree.Node = current.callee;
    if (callee.type !== "MemberExpression") return;
    current = callee.object;
  }
}

/** The outermost call of the fluent chain that `node` belongs to. */
const chainRoot = (node: ESTree.CallExpression) => {
  let current: ESTree.Node = node;
  for (;;) {
    const member: ESTree.Node | null = current.parent;
    if (member?.type !== "MemberExpression" || member.object !== current) return current;
    const call: ESTree.Node | null = member.parent;
    if (call?.type !== "CallExpression" || call.callee !== member) return current;
    current = call;
  }
};

const isMethodCall = (node: ESTree.CallExpression, method: string, argument: RegExp) =>
  node.callee.type === "MemberExpression" &&
  !node.callee.computed &&
  node.callee.property.type === "Identifier" &&
  node.callee.property.name === method &&
  node.arguments[0]?.type === "Identifier" &&
  argument.test(node.arguments[0].name);

/** `.pipe(..., requireAccount.<action>, ...)` */
const pipesRequireAccount = (node: ESTree.CallExpression) =>
  node.callee.type === "MemberExpression" &&
  node.callee.property.type === "Identifier" &&
  node.callee.property.name === "pipe" &&
  node.arguments.some(
    (argument) =>
      argument.type === "MemberExpression" &&
      argument.object.type === "Identifier" &&
      argument.object.name === "requireAccount",
  );

const accountMiddlewareThroughHelper = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Declare account endpoints only through requireAccount." },
    messages: {
      bare: "Use endpoint.pipe(requireAccount.<action>): it checks that the endpoint decodes an `account` path parameter, which {{name}} reads.",
      action:
        "requireAccount sets this endpoint's RequiredAction from its account middleware; do not annotate it separately.",
    },
  },
  create: (context) => ({
    CallExpression(node) {
      if (isMethodCall(node, "middleware", /^RequireAccount[A-Z]/)) {
        const argument = node.arguments[0];
        if (argument?.type === "Identifier")
          context.report({ node, messageId: "bare", data: { name: argument.name } });
        return;
      }
      if (!isMethodCall(node, "annotate", /^RequiredAction$/)) return;
      if ([...chainCalls(chainRoot(node))].some(pipesRequireAccount))
        context.report({ node, messageId: "action" });
    },
  }),
});

export default definePlugin({
  meta: { name: "executor" },
  rules: {
    "no-module-level-mutable-state": noModuleLevelMutableState,
    "no-manual-effect-runtime-in-tests": noManualEffectRuntimeInTests,
    "no-shared-wait-in-worker-initialization": noSharedWaitInWorkerInitialization,
    "no-proof-forgery": noProofForgery,
    "account-middleware-through-helper": accountMiddlewareThroughHelper,
  },
});
