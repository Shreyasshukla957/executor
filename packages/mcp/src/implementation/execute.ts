/** Build a live catalog and execute code against configured apps. */
import { CodeMode, Tool, toolError } from "@opencode-ai/codemode";
import { tokTypes, tokenizer, type Token } from "acorn";
import {
  Json,
  AppSlug,
  JsonObject,
  routerFailure,
  ToolApprovalRequired,
  ToolListingTimedOut,
  type App,
  type AppId,
  type Cursor,
  type DeploymentId,
  type Tool as AppTool,
  type ToolRouter,
} from "@executor-js/sdk/core";
import { Clock, Deferred, Duration, Effect, Option, Schema, Semaphore } from "effect";
import { diagnostic, executionDiagnostic } from "./diagnostics.ts";
import type { McpTarget } from "../contracts/targets.ts";
import type { McpBackend } from "../contracts/backend.ts";
import {
  AppDiscoveryTimedOut,
  AppProfileRequired,
  defaultMcpRuntimeLimits,
  SearchInput,
  SearchResult,
  type McpLimits,
  type McpToolCall,
  type UnavailableApp,
} from "../contracts/execute.ts";

type Catalog = Record<string, Record<string, Tool.Tool>>;

// Equivalent JSON Schema normalization: the upstream signature renderer only
// renders index signatures when additionalProperties is a schema, rather than true.
function renderableSchema(input: Tool.JsonSchema): Tool.JsonSchema {
  return {
    ...input,
    ...(input.type === "object" && input.additionalProperties !== false
      ? {
          additionalProperties:
            typeof input.additionalProperties === "object"
              ? renderableSchema(input.additionalProperties)
              : {},
        }
      : {}),
    ...(input.properties === undefined
      ? {}
      : {
          properties: Object.fromEntries(
            Object.entries(input.properties).map(([name, schema]) => [
              name,
              renderableSchema(schema),
            ]),
          ),
        }),
    ...(input.items === undefined ? {} : { items: renderableSchema(input.items) }),
    ...(input.anyOf === undefined ? {} : { anyOf: input.anyOf.map(renderableSchema) }),
    ...(input.oneOf === undefined ? {} : { oneOf: input.oneOf.map(renderableSchema) }),
    ...(input.allOf === undefined ? {} : { allOf: input.allOf.map(renderableSchema) }),
    ...(input.$defs === undefined
      ? {}
      : {
          $defs: Object.fromEntries(
            Object.entries(input.$defs).map(([name, schema]) => [name, renderableSchema(schema)]),
          ),
        }),
  };
}

// Codemode treats dots as namespace separators. Leave ordinary names readable;
// only escape characters needed to distinguish inaccessible/reserved segments.
function toolPath(name: string): string {
  return name
    .split(".")
    .map((segment) => {
      if (segment === "") return "%00";
      if (["__proto__", "prototype", "constructor"].includes(segment)) return `%${segment}`;
      return segment.replaceAll("%", "%25");
    })
    .join(".");
}

/** A tool's group, as shown in search results: the router's title, or its path. */
const groupLabel = (router: ToolRouter | undefined) =>
  router === undefined ? "" : ` / ${router.title ?? router.path}`;

function listTools<E extends Error>(
  backend: McpBackend<E>,
  app: AppId,
  target: McpTarget,
  /** Records each page as progress. */
  paged: Effect.Effect<void>,
  /** Discovery's wait bound: a listing another request started longer ago is reported at once. */
  waitMs: number,
) {
  return Effect.gen(function* () {
    const tools: AppTool[] = [];
    let routers: readonly ToolRouter[] = [];
    let cursor: Cursor | undefined;
    let deployment: DeploymentId | undefined;
    const selection =
      target.kind === "app" ? {} : { profile: target.id, expectedProfileRevision: target.revision };
    do {
      const page = yield* backend.listTools(
        { app, ...selection, deployment, cursor, limit: 2_000 },
        { reportRunningAfterMillis: waitMs },
      );
      yield* paged;
      deployment = page.deployment;
      tools.push(...page.items);
      routers = page.routers;
      cursor = page.next;
    } while (cursor !== undefined);
    return { tools, routers, deployment, selection };
  });
}

/**
 * Projections of kept tool listings. The SDK serves every page of a kept listing from the same
 * item objects, so a projection keyed by those objects lives exactly as long as the listing and
 * is not recomputed while the listing is reused. A listing evaluated again has new objects, and
 * nothing here outlives the listing it was derived from.
 */
const renderedSchemas = new WeakMap<
  AppTool,
  { readonly input: Tool.JsonSchema; readonly output: Tool.JsonSchema | undefined }
>();
const renderSchemas = (tool: AppTool) =>
  Effect.gen(function* () {
    const known = renderedSchemas.get(tool);
    if (known !== undefined) return known;
    const input = yield* Schema.decodeUnknownEffect(JsonObject)(tool.inputSchema);
    const rendered = {
      input: renderableSchema(input),
      output: tool.outputSchema === undefined ? undefined : renderableSchema(tool.outputSchema),
    };
    renderedSchemas.set(tool, rendered);
    return rendered;
  });
/** One loaded target of an app, as its search descriptions depend on it. */
type DescribedPart = {
  readonly namespace: string;
  readonly description: string;
  readonly tools: ReadonlyArray<AppTool>;
};
/** An app's rendered search descriptions, keyed by its first listed tool. */
const renderedDescriptions = new WeakMap<
  AppTool,
  {
    readonly slug: string;
    readonly parts: ReadonlyArray<DescribedPart>;
    readonly described: ReadonlyArray<CodeMode.ToolDescription>;
  }
>();
const sameParts = (left: ReadonlyArray<DescribedPart>, right: ReadonlyArray<DescribedPart>) =>
  left.length === right.length &&
  left.every((part, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      part.namespace === other.namespace &&
      part.description === other.description &&
      part.tools.length === other.tools.length &&
      part.tools.every((tool, position) => tool === other.tools[position])
    );
  });

/**
 * The apps a program can reach. Every tool path starts at the `tools` global, so a program whose
 * uses of `tools` are all static members, such as `tools.github` or `tools["my-app"]`, reaches
 * only those apps. Any other use (`tools[name]`, `Object.keys(tools)`, passing `tools` around)
 * and CodeMode's global `search()`, which reads the program's own tool index, reach every app.
 * Source that does not tokenize also reaches every app; CodeMode then reports its parse error.
 */
export const programReach = (code: string) =>
  Effect.try({
    try: () =>
      // Acorn's declarations omit the token value it sets: cooked identifier and string text.
      Array.from(
        tokenizer(code, {
          ecmaVersion: "latest",
          allowReturnOutsideFunction: true,
          allowAwaitOutsideFunction: true,
        }),
        (token: Token & { readonly value?: unknown }) => ({
          type: token.type,
          value: typeof token.value === "string" ? token.value : undefined,
        }),
      ),
    catch: () => "all" as const,
  }).pipe(
    Effect.map((tokens): ReadonlySet<string> | "all" => {
      const at = (index: number) => tokens[index] ?? { type: tokTypes.eof, value: undefined };
      const member = (index: number) =>
        at(index).type === tokTypes.dot || at(index).type === tokTypes.questionDot;
      const slugs = new Set<string>();
      for (const [index, token] of tokens.entries()) {
        if (token.type !== tokTypes.name || member(index - 1)) continue;
        if (token.value === "search") return "all";
        if (token.value !== "tools") continue;
        // tools.slug and tools?.slug; property names may be keywords.
        const name = at(index + 2);
        if (
          member(index + 1) &&
          name.value !== undefined &&
          (name.type === tokTypes.name || name.type.keyword !== undefined)
        ) {
          slugs.add(name.value);
          continue;
        }
        // tools["slug"] and tools?.["slug"]
        const open = at(index + 1).type === tokTypes.questionDot ? index + 2 : index + 1;
        const key = at(open + 1);
        if (
          at(open).type === tokTypes.bracketL &&
          key.type === tokTypes.string &&
          key.value !== undefined &&
          at(open + 2).type === tokTypes.bracketR
        ) {
          slugs.add(key.value);
          continue;
        }
        return "all";
      }
      return slugs;
    }),
    Effect.orElseSucceed(() => "all" as const),
  );

type ListedApp = Pick<App, "id" | "name" | "slug">;

/**
 * Discover apps on demand within one execution. Listing apps is cheap; listing an app's targets
 * and tools can mean evaluating thousands of definitions or reaching an upstream server, so each
 * app is discovered at most once and only when the program or its search needs it. The backend
 * may serve a tool listing it kept from an earlier execution; its rendered schemas and search
 * descriptions are then reused too. Everything else is per execution.
 */
function catalog(backend: McpBackend<Error>, progress: ExecutionProgress) {
  return Effect.gen(function* () {
    const {
      discoveryConcurrency: concurrency,
      discoveryWaitMs,
      discoveryIdleMs,
    } = defaultMcpRuntimeLimits;
    const slots = yield* Semaphore.make(concurrency);
    // Listings share one app runtime, so how long one takes depends on the others. Discovery
    // gives up on an app only when no listing has completed for a while, not on a per-app clock.
    let progressed = yield* Clock.currentTimeMillis;
    const settled = Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        progressed = now;
      }),
    );
    /** Listings each app is running, when it started its first, and when it was given up on. */
    const running = new Map<AppId, number>();
    const started = new Map<AppId, number>();
    const stopped = new Map<AppId, number>();
    const stops = new Map<AppId, Deferred.Deferred<number>>();
    const stopOf = (app: AppId) => {
      const known = stops.get(app);
      if (known !== undefined) return known;
      const created = Deferred.makeUnsafe<number>();
      stops.set(app, created);
      return created;
    };
    /** Give up on an app: its running listings stop and its queued ones fail without running. */
    const stop = (app: AppId) =>
      Effect.gen(function* () {
        if (stopped.has(app)) return;
        const now = yield* Clock.currentTimeMillis;
        stopped.set(app, now);
        yield* Deferred.succeed(stopOf(app), now);
      });
    const timedOut = (app: AppId, at: number) =>
      new AppDiscoveryTimedOut({ app, elapsedMs: at - (started.get(app) ?? at) });
    // A listing holds a permit while it runs and stops with the rest of its app. Once an app is
    // given up on, its queued listings fail without running.
    const discover = <A, E, R>(name: string, app: AppId, work: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const queued = yield* Clock.currentTimeMillis;
        return yield* slots.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            yield* Effect.annotateCurrentSpan("executor.discovery.wait_ms", now - queued);
            const at = stopped.get(app);
            if (at !== undefined) return yield* Effect.fail(timedOut(app, at));
            if (!started.has(app)) started.set(app, now);
            running.set(app, (running.get(app) ?? 0) + 1);
            return yield* work.pipe(
              Effect.tap(() => settled),
              Effect.raceFirst(
                Deferred.await(stopOf(app)).pipe(
                  Effect.flatMap((at) => Effect.fail(timedOut(app, at))),
                ),
              ),
              Effect.ensuring(Effect.sync(() => running.set(app, (running.get(app) ?? 1) - 1))),
            );
          }),
        );
      }).pipe(Effect.withSpan(name));
    const apps = yield* backend.listApps().pipe(Effect.withSpan("mcp.discovery.apps"));
    yield* Effect.annotateCurrentSpan({
      "executor.discovery.apps": apps.length,
      "executor.discovery.concurrency": concurrency,
    });
    const counts = new Map<string, number>();
    for (const app of apps) counts.set(app.slug, (counts.get(app.slug) ?? 0) + 1);
    const unique = (app: ListedApp) => Schema.is(AppSlug)(app.slug) && counts.get(app.slug) === 1;
    const tools: Catalog = Object.create(null);
    const failures = new Map<AppId, Array<typeof UnavailableApp.Type>>();
    // Tool path prefixes that expose no tools in this execution, and those that do. A call is
    // attributed to the longest matching prefix, so a typo inside a loaded namespace stays unknown.
    const namespaces: Namespaces = new Map();
    const unavailableApps = () => apps.flatMap((app) => failures.get(app.id) ?? []);
    /** The loaded targets behind each app's tools, for reusing rendered descriptions. */
    const describedParts = new Map<string, ReadonlyArray<DescribedPart>>();

    const discoverApp = (app: ListedApp) =>
      Effect.gen(function* () {
        if (!unique(app))
          return {
            targets: [],
            error: !Schema.is(AppSlug)(app.slug) ? "AppSlugInvalid" : "AppSlugAmbiguous",
          };
        return yield* discover(
          "mcp.discovery.targets",
          app.id,
          backend.listTargets({ app: app.id }),
        ).pipe(
          Effect.flatMap((targets) =>
            Effect.forEach(
              targets,
              (target) =>
                discover(
                  "mcp.discovery.tools",
                  app.id,
                  listTools(backend, app.id, target, settled, discoveryWaitMs),
                ).pipe(
                  Effect.map((catalog) => ({ target, catalog, error: undefined })),
                  Effect.catch((error) =>
                    Effect.gen(function* () {
                      // This app's listing has run for longer than discovery waits, or recently
                      // timed out. Give up on the app now, as discovery would after waiting,
                      // rather than wait for its other listings again.
                      if (Schema.is(ToolListingTimedOut)(error)) yield* stop(app.id);
                      return { target, catalog: undefined, error: diagnostic(error) };
                    }),
                  ),
                ),
              { concurrency: "unbounded" },
            ),
          ),
          Effect.map((targets) => ({ targets, error: undefined })),
          Effect.catch((error) => Effect.succeed({ targets: [], error: diagnostic(error) })),
        );
      });

    const project = (
      app: ListedApp,
      { targets, error }: Effect.Success<ReturnType<typeof discoverApp>>,
    ) =>
      Effect.gen(function* () {
        const failed: Array<typeof UnavailableApp.Type> = [];
        failures.set(app.id, failed);
        if (error !== undefined) {
          const entry = { app: app.id, name: app.name, reason: error };
          failed.push(entry);
          if (unique(app)) namespaces.set(app.slug, entry);
          return;
        }
        // An app that needs accounts exposes no target when the caller has no enabled profile.
        // Report that only when the program calls into it: most members never set up most of
        // their organization's account apps.
        if (targets.length === 0) {
          namespaces.set(app.slug, {
            app: app.id,
            name: app.name,
            reason: diagnostic(new AppProfileRequired({ app: app.id })),
          });
          tools[app.slug] = {};
          return;
        }
        const entries: Array<readonly [string, Tool.Tool]> = [];
        const parts: Array<DescribedPart> = [];
        for (const { target, catalog, error } of targets) {
          const namespace =
            target.kind === "app" ? app.slug : `${app.slug}.profiles.${toolPath(target.id)}`;
          if (catalog === undefined) {
            const entry = {
              app: app.id,
              name: app.name,
              ...(target.kind === "profile" ? { profile: target.id } : {}),
              reason: error,
            };
            failed.push(entry);
            namespaces.set(namespace, entry);
            continue;
          }
          namespaces.set(namespace, "available");
          // A router that could not list its tools is reported like an app, at its own namespace,
          // so a call into it explains why instead of reporting an unknown tool.
          const groups = new Map(catalog.routers.map((router) => [router.path, router]));
          for (const router of catalog.routers) {
            if (router.error === undefined) continue;
            const entry = {
              app: app.id,
              name: `${app.name} ${router.title ?? router.path}`,
              ...(target.kind === "profile" ? { profile: target.id } : {}),
              router: router.path,
              reason: diagnostic(
                routerFailure({ app: app.id, deployment: catalog.deployment }, router.error),
              ),
            };
            failed.push(entry);
            namespaces.set(`${namespace}.${toolPath(router.path)}`, entry);
          }
          const description =
            target.kind === "app"
              ? app.name
              : `${app.name} (${target.label})${target.accounts === undefined ? "" : ` [${target.accounts}]`}`;
          parts.push({ namespace, description, tools: catalog.tools });
          const projected = yield* Effect.forEach(catalog.tools, (tool) =>
            renderSchemas(tool).pipe(
              Effect.map(
                (schemas) =>
                  [
                    target.kind === "app"
                      ? toolPath(tool.name)
                      : `profiles.${toolPath(target.id)}.${toolPath(tool.name)}`,
                    Tool.make({
                      description: `${description}${groupLabel(tool.router === undefined ? undefined : groups.get(tool.router))}: ${tool.description}`,
                      input: schemas.input,
                      output: schemas.output ?? Schema.Json,
                      execute: (input) =>
                        Schema.decodeUnknownEffect(Json)(input).pipe(
                          Effect.mapError(() => toolError("Tool arguments must be JSON")),
                          Effect.flatMap((input) =>
                            backend
                              .callTool({
                                app: app.id,
                                deployment: catalog.deployment,
                                ...catalog.selection,
                                tool: tool.name,
                                kind: tool.readOnly === true ? "query" : "mutation",
                                input,
                              })
                              .pipe(
                                Effect.flatMap((result) =>
                                  result.status === "completed"
                                    ? Effect.succeed(result.value)
                                    : Effect.fail(
                                        new ToolApprovalRequired({
                                          app: result.invocation.app,
                                          deployment: result.invocation.deployment,
                                          tool: result.invocation.tool,
                                        }),
                                      ),
                                ),
                                Effect.mapError((error) => toolError(diagnostic(error))),
                              ),
                          ),
                        ),
                    }),
                  ] as const,
              ),
            ),
          );
          entries.push(...projected);
        }
        // An app none of whose targets loaded is unavailable as a whole.
        const whole = failed[0];
        if (entries.length === 0 && whole !== undefined && !namespaces.has(app.slug))
          namespaces.set(app.slug, whole);
        tools[app.slug] = Object.fromEntries(entries);
        describedParts.set(app.slug, parts);
      });

    // Each app is discovered at most once, by whichever of the program or a search needs it first.
    const discovered = yield* Effect.forEach(apps, (app) =>
      Effect.cached(
        discoverApp(app).pipe(
          Effect.flatMap((result) => project(app, result)),
          Effect.andThen(
            Effect.sync(() => {
              progress.unavailableApps = unavailableApps();
            }),
          ),
        ),
      ).pipe(Effect.map((load) => ({ app, load }))),
    );
    /**
     * Wait for the selected apps. After `discoveryWaitMs`, once no listing has completed for
     * `discoveryIdleMs`, give up on every selected app still running a listing, however many
     * there are. Apps still queued then start, with a new idle period.
     */
    const load = (selected: ReadonlyArray<(typeof discovered)[number]>) =>
      Effect.gen(function* () {
        const began = yield* Clock.currentTimeMillis;
        let restarted = began;
        const watch: Effect.Effect<never> = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const due = Math.max(
            began + discoveryWaitMs,
            Math.max(progressed, restarted) + discoveryIdleMs,
          );
          if (now < due) {
            yield* Effect.sleep(Duration.millis(due - now));
            return yield* watch;
          }
          const stalled = selected.filter(({ app }) => (running.get(app.id) ?? 0) > 0);
          yield* Effect.annotateCurrentSpan("executor.discovery.stopped", stalled.length);
          for (const { app } of stalled) yield* stop(app.id);
          restarted = now;
          return yield* watch;
        });
        yield* Effect.raceFirst(
          Effect.forEach(selected, ({ load }) => load, { concurrency: "unbounded", discard: true }),
          watch,
        );
      });

    // Search descriptions per app, rendered once per execution.
    const descriptions = new Map<string, ReadonlyArray<CodeMode.ToolDescription>>();
    const describe = (slug: string) => {
      const known = descriptions.get(slug);
      if (known !== undefined) return known;
      const appTools = tools[slug];
      const parts = describedParts.get(slug) ?? [];
      const anchor = parts.find((part) => part.tools.length > 0)?.tools[0];
      const kept = anchor === undefined ? undefined : renderedDescriptions.get(anchor);
      const described =
        kept !== undefined && kept.slug === slug && sameParts(kept.parts, parts)
          ? kept.described
          : appTools === undefined
            ? []
            : CodeMode.make({ tools: { [slug]: appTools } }).catalog();
      if (anchor !== undefined) renderedDescriptions.set(anchor, { slug, parts, described });
      descriptions.set(slug, described);
      return described;
    };
    /** Keep descriptions CodeMode already rendered for the program's own tools. */
    const retain = (catalog: ReadonlyArray<CodeMode.ToolDescription>) => {
      const grouped = new Map<string, Array<CodeMode.ToolDescription>>();
      for (const slug of Object.keys(tools)) grouped.set(slug, []);
      // App tools sit below their slug; the program's own `search` tool has no namespace.
      for (const entry of catalog) {
        const dot = entry.path.indexOf(".");
        if (dot > 0) grouped.get(entry.path.slice(0, dot))?.push(entry);
      }
      for (const [slug, entries] of grouped) descriptions.set(slug, entries);
    };
    /**
     * Search sees every app unless a namespace names one: an app slug, a target namespace below
     * it, or the same path as a tool expression. `tools` alone still covers every app.
     */
    const searchable = (namespace: string | undefined) =>
      Effect.gen(function* () {
        const selected =
          namespace === undefined || namespace === "tools"
            ? discovered
            : discovered.filter(({ app }) => {
                const expression = CodeMode.toolExpression(toolPath(app.slug));
                return (
                  namespace === app.slug ||
                  namespace.startsWith(`${app.slug}.`) ||
                  namespace === expression ||
                  namespace.startsWith(`${expression}.`) ||
                  namespace.startsWith(`${expression}[`)
                );
              });
        yield* load(selected).pipe(Effect.withSpan("mcp.search.discovery"));
        return selected
          .flatMap(({ app }) => (unique(app) ? describe(app.slug) : []))
          .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
      });
    const reachable = (reach: ReadonlySet<string> | "all") =>
      reach === "all" ? discovered : discovered.filter(({ app }) => reach.has(app.slug));
    return { tools, namespaces, load, reachable, retain, searchable, unavailableApps };
  });
}

/** Unavailable namespaces map to their reason; loaded ones are marked available. */
type Namespaces = Map<string, typeof UnavailableApp.Type | "available">;

/** What one execution has done so far, so a result assembled by its driver stays accurate. */
export type ExecutionProgress = {
  /** Calls admitted by the program, updated as each call starts and ends. */
  readonly calls: Array<{
    readonly name: string;
    outcome: McpToolCall["outcome"] | "running";
    durationMs?: number;
  }>;
  /** The call index each running tool fiber serves, so the driver can mark its approval wait. */
  readonly callFibers: Map<number, number>;
  /** `program` once discovery has finished and program code may run. */
  phase: "discovery" | "program";
  unavailableApps: ReadonlyArray<typeof UnavailableApp.Type>;
};
export const executionProgress = (): ExecutionProgress => ({
  calls: [],
  callFibers: new Map(),
  phase: "discovery",
  unavailableApps: [],
});

/**
 * A call into an app that failed to load is not an unknown tool: report why the app is unavailable.
 * CodeMode names the unresolved canonical path in its UnknownTool diagnostic.
 */
const unavailableTarget = (error: CodeMode.Diagnostic, namespaces: Namespaces) => {
  if (error.kind !== "UnknownTool") return undefined;
  const path = /^(?:Unknown tool(?: namespace)? |Tool )'([^']*)'/.exec(error.message)?.[1];
  if (path === undefined) return undefined;
  const segments = path.split(".");
  for (let length = segments.length; length > 0; length--) {
    const found = namespaces.get(segments.slice(0, length).join("."));
    if (found === "available") return undefined;
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * A snapshot for a result. A call still running when the execution ends is reported as
 * interrupted. A driver-assembled result lists only calls whose start was recorded.
 */
export const reportedCalls = (progress: ExecutionProgress): Array<McpToolCall> =>
  progress.calls.flatMap((call) =>
    call === undefined
      ? []
      : [
          {
            name: call.name,
            outcome: call.outcome === "running" ? "interrupted" : call.outcome,
            ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
          },
        ],
  );

/** The phase a timed-out execution was in, so callers can tell slow discovery from a slow program. */
export const timeoutMessage = (timeoutMs: number, phase: "discovery" | "program") =>
  phase === "discovery"
    ? `Execution timed out after ${timeoutMs}ms while loading app tools; no program code ran.`
    : `Execution timed out after ${timeoutMs}ms; earlier tool calls may have completed.`;

/**
 * After the budget is spent, CodeMode interrupts the program and returns its calls and logs.
 * The driver waits this long for that result. If it does not arrive, the driver reports the
 * calls it recorded (without logs); the run's cleanup continues in the background either way.
 */
export const timeoutDeliveryMs = 1_000;

// CodeMode's execution timeout sleeps for exactly `timeoutMs`. End that sleep at the host's
// deadline, so CodeMode stops the program itself and returns the calls and logs it has so far.
// Every other sleep keeps real time.
const deadlineClock = (
  clock: Clock.Clock,
  timeoutMs: number,
  deadline: Effect.Effect<void>,
): Clock.Clock => ({
  currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
  currentTimeMillis: clock.currentTimeMillis,
  currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
  currentTimeNanos: clock.currentTimeNanos,
  monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: clock.monotonicTimeNanos,
  sleep: (duration) =>
    Duration.toMillis(duration) === timeoutMs ? deadline : clock.sleep(duration),
});

/**
 * Internal interpreter entry. `deadline` completes when the execution's budget is spent; the
 * caller decides whether that is wall time or active time. Discovery stops at the deadline;
 * a running program is stopped by CodeMode so its admitted calls and logs are returned.
 */
export function executeProgram(
  backend: McpBackend<Error>,
  limits: McpLimits,
  code: string,
  deadline: Effect.Effect<void>,
  progress: ExecutionProgress,
) {
  return Effect.suspend(() => {
    const failure = (kind: CodeMode.DiagnosticKind, message: string) => ({
      execution: executionDiagnostic({
        ok: false as const,
        error: { kind, message },
        toolCalls: reportedCalls(progress),
      }),
      unavailableApps: progress.unavailableApps,
    });
    return Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      // Tools run on the real clock; only CodeMode's own timeout follows the deadline.
      const tools: McpBackend<Error> = {
        ...backend,
        callTool: (input, options) =>
          backend.callTool(input, options).pipe(Effect.provideService(Clock.Clock, clock)),
      };
      // Discovery covers the apps the program can reach; search discovers others when it runs.
      const reach = yield* programReach(code);
      const loaded = yield* Effect.gen(function* () {
        const discovered = yield* catalog(tools, progress);
        const reachable = discovered.reachable(reach);
        yield* Effect.annotateCurrentSpan("executor.discovery.reachable", reachable.length);
        yield* discovered.load(reachable);
        yield* Effect.annotateCurrentSpan({
          "executor.discovery.tools": Object.values(discovered.tools).reduce(
            (sum, entries) => sum + Object.keys(entries).length,
            0,
          ),
          "executor.discovery.unavailable": progress.unavailableApps.length,
        });
        return discovered;
      }).pipe(
        Effect.withSpan("mcp.catalog"),
        Effect.map(Option.some),
        Effect.raceFirst(deadline.pipe(Effect.as(Option.none()))),
      );
      if (Option.isNone(loaded)) {
        yield* Effect.annotateCurrentSpan("executor.timeout.phase", "discovery");
        return failure("TimeoutExceeded", timeoutMessage(limits.timeoutMs, "discovery"));
      }
      const prepared = loaded.value;
      progress.phase = "program";
      const search = Tool.make({
        description: "Find available app tools and their callable signatures.",
        input: SearchInput,
        output: SearchResult,
        execute: ({ query = "", namespace, limit = 10, offset = 0 }) =>
          Effect.gen(function* () {
            const entries = yield* prepared.searchable(namespace);
            const terms = query
              .replace(/([a-z])([A-Z])/g, "$1 $2")
              .toLowerCase()
              .split(/[^a-z0-9]+/)
              .filter(Boolean);
            const visible = entries.filter(
              (entry) =>
                namespace === undefined ||
                entry.path === namespace ||
                entry.path.startsWith(`${namespace}.`) ||
                CodeMode.toolExpression(entry.path).startsWith(`${namespace}.`),
            );
            const exact = visible.find(
              (entry) => query === entry.path || query === CodeMode.toolExpression(entry.path),
            );
            const matches =
              exact === undefined
                ? visible
                    .map((entry) => ({
                      entry,
                      score: terms.reduce(
                        (sum, term) =>
                          sum +
                          (entry.path.toLowerCase().includes(term) ? 3 : 0) +
                          (entry.description.toLowerCase().includes(term) ? 1 : 0),
                        0,
                      ),
                    }))
                    .filter(({ score }) => terms.length === 0 || score > 0)
                    .sort((a, b) => b.score - a.score)
                    .map(({ entry }) => entry)
                : [exact];
            const items = matches.slice(offset, offset + limit).map((entry) => ({
              ...entry,
              path: CodeMode.toolExpression(entry.path),
            }));
            const remaining = Math.max(0, matches.length - offset - items.length);
            return {
              items,
              remaining,
              next: remaining > 0 ? { offset: offset + items.length } : null,
            };
            // Discovery for a search runs on the real clock, like tool calls.
          }).pipe(Effect.provideService(Clock.Clock, clock)),
      });
      const runtime = CodeMode.make({
        tools: { ...prepared.tools, search },
        limits,
        // Both hooks run on the fiber that makes the call.
        onToolCallStart: ({ index, name }) =>
          Effect.map(Effect.fiberId, (fiber) => {
            progress.calls[index] = { name, outcome: "running" };
            progress.callFibers.set(fiber, index);
          }),
        onToolCallEnd: ({ index, outcome, durationMs }) =>
          Effect.map(Effect.fiberId, (fiber) => {
            progress.callFibers.delete(fiber);
            const call = progress.calls[index];
            if (call === undefined) return;
            // A call interrupted while it waited for approval never ran.
            if (!(outcome === "interrupted" && call.outcome === "awaiting-approval"))
              call.outcome = outcome;
            call.durationMs = durationMs;
          }),
      });
      prepared.retain(runtime.catalog());
      const result = yield* runtime
        .execute(code)
        .pipe(
          Effect.provideService(Clock.Clock, deadlineClock(clock, limits.timeoutMs, deadline)),
          Effect.flatMap(Schema.decodeUnknownEffect(CodeMode.Result)),
        );
      // CodeMode records a call before its start hook runs; report every admitted call in order.
      result.toolCalls.forEach(({ name }, index) => {
        progress.calls[index] ??= { name, outcome: "interrupted" };
      });
      const timedOut = !result.ok && result.error.kind === "TimeoutExceeded";
      const unavailable = result.ok
        ? undefined
        : unavailableTarget(result.error, prepared.namespaces);
      if (unavailable !== undefined)
        yield* Effect.annotateCurrentSpan("executor.unavailable_app.called", true);
      const execution = executionDiagnostic({
        ...result,
        ...(unavailable === undefined
          ? {}
          : {
              error: {
                kind: "ToolFailure" as const,
                message: unavailable.reason.startsWith("{")
                  ? unavailable.reason
                  : `${unavailable.name} could not be loaded in this execution (${unavailable.reason}); its tools cannot be called until it loads.`,
              },
            }),
        ...(timedOut
          ? {
              error: {
                kind: "TimeoutExceeded" as const,
                message: timeoutMessage(limits.timeoutMs, "program"),
              },
            }
          : {}),
        toolCalls: reportedCalls(progress),
      });
      if (timedOut) yield* Effect.annotateCurrentSpan("executor.timeout.phase", "program");
      yield* Effect.annotateCurrentSpan("executor.outcome", execution.ok ? "completed" : "failed");
      return { execution, unavailableApps: prepared.unavailableApps() };
    }).pipe(
      Effect.catch((error) => Effect.succeed(failure("ExecutionFailure", diagnostic(error)))),
    );
  });
}
