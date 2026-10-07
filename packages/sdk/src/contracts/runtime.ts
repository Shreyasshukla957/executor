/** Pluggable Effect runtime. The caller resolves accounts; no database or owner policy lives here. */
import { Context, Effect, Schema, type Stream } from "effect";
import {
  HostDeclarationInvalid,
  DeclaredRequirements,
  type AccountCheckResult,
  type HostAccountCheckError,
  type HostInspectError,
  type HostCallError,
  type HostDataError,
  type HostedCatalog,
  type HostedCatalogSummary,
  type SkillCatalog,
  type HostContext,
  type WebhookCommand,
  type WorkflowCommand,
} from "apps/contracts";
import { DatabaseFieldReserved } from "@executor-js/app-data/contracts";
import { BuildStage, SourceFiles, SourceLocation, type BuildMemoryExceeded } from "./deployment.ts";
import { BuildId, Json } from "./shared.ts";

/**
 * Runtimes report that an invocation invalidated or explicitly refreshed the app's cached
 * upstream data, such as an MCP catalog after `notifications/tools/list_changed`, including one
 * that happens after the invocation. The SDK then stops reusing results it evaluated for that app
 * from the earlier data. Routine refreshes are not reported; kept results pick them up when they
 * refresh.
 */
export const AppCacheChanges = Context.Reference<{
  readonly changed: (app: string) => Effect.Effect<void>;
}>("executor/AppCacheChanges", { defaultValue: () => ({ changed: () => Effect.void }) });

/**
 * The scheduled run an app invocation serves, if any. The runner records it on the build loads it
 * makes for the invocation, so a query can tell a run's own build loads from those of other runs
 * that share its scheduler trace. Telemetry only: nothing decides on it.
 */
export const InvocationRun = Context.Reference<string | undefined>("executor/InvocationRun", {
  defaultValue: () => undefined,
});

/** Retained compiled output and declarations obtained without running the app factory. */
export const UiAsset = Schema.Struct({
  path: Schema.NonEmptyString,
  contentType: Schema.NonEmptyString,
});
/** Browser assets retained atomically with the server bundle. */
export const BuiltApp = Schema.Struct({
  build: BuildId,
  requirements: DeclaredRequirements,
  ui: Schema.optional(Schema.Array(UiAsset)),
});
/** A private browser asset returned to an authenticated serving host. */
export interface RuntimeAsset {
  readonly body: Uint8Array;
  readonly contentType: string;
}
/** Parsed successful build result. */
export type BuiltApp = typeof BuiltApp.Type;

/** Longest build or protocol diagnostic retained on an error. */
export const maxBuildMessageLength = 4096;
/** Bounded diagnostic text about the deployer's own source, such as a compiler error. */
export const BuildMessage = Schema.String.check(Schema.isMaxLength(maxBuildMessageLength));
/** Truncate diagnostic text to its bound. */
export const boundBuildMessage = (message: string) =>
  message.length <= maxBuildMessageLength
    ? message
    : `${message.slice(0, maxBuildMessageLength - 1)}…`;
/**
 * Describe an underlying failure as `Name: message`, bounded. Executor's own wrappers of an
 * underlying failure contribute only their message.
 */
export const describeBuildCause = (cause: unknown) =>
  boundBuildMessage(
    cause instanceof Error
      ? cause.message.length > 0
        ? Schema.is(RuntimeProtocolFailed)(cause) || Schema.is(HostDeclarationInvalid)(cause)
          ? cause.message
          : `${cause.name}: ${cause.message}`
        : cause.name
      : typeof cause === "string"
        ? cause
        : (JSON.stringify(cause) ?? String(cause)),
  );

/**
 * A build failed; no build reference is returned and staging output is removed. `message`
 * describes the underlying failure in the deployer's own source when it is known, with the
 * first failing source location. It never contains credentials: builds bind no accounts.
 */
export class RuntimeBuildFailed extends Schema.TaggedError<RuntimeBuildFailed>()(
  "RuntimeBuildFailed",
  {
    stage: BuildStage,
    dependency: Schema.optional(Schema.String),
    /** A named declaration problem the author can fix, reported with the failed deploy. */
    declaration: Schema.optional(DatabaseFieldReserved),
    message: Schema.optional(BuildMessage),
    location: Schema.optional(SourceLocation),
  },
) {}
/** The retained build was absent, invalid or could not load in this host. */
export class RuntimeBuildUnavailable extends Schema.TaggedError<RuntimeBuildUnavailable>()(
  "RuntimeBuildUnavailable",
  {},
) {}
/**
 * The framework handler returned an invalid protocol response, or its Worker failed to load.
 * `message` is the underlying runtime failure; tool callers never receive it.
 */
export class RuntimeProtocolFailed extends Schema.TaggedError<RuntimeProtocolFailed>()(
  "RuntimeProtocolFailed",
  { message: Schema.optional(BuildMessage) },
) {}
/**
 * The app's `apps` framework speaks a host protocol this host does not run. Builds fail before
 * compiling, and retained builds fail before loading, rather than at module link or decode time.
 */
export class RuntimeProtocolUnsupported extends Schema.TaggedError<RuntimeProtocolUnsupported>()(
  "RuntimeProtocolUnsupported",
  { protocol: Schema.Int, supported: Schema.Array(Schema.Int) },
) {
  override get message() {
    return `This app's apps framework uses host protocol ${this.protocol}. This host supports protocol ${this.supported.join(", ")}.`;
  }
}
/**
 * The app's `package.json` declares no `apps` version. Every app declares the exact release it uses;
 * `version` is the one this host ships, which new apps pin.
 */
export class RuntimeAppsDependencyMissing extends Schema.TaggedError<RuntimeAppsDependencyMissing>()(
  "RuntimeAppsDependencyMissing",
  { version: Schema.NonEmptyString },
) {
  override get message() {
    return `Add "apps": "${this.version}" to package.json dependencies. Every app declares the exact apps version it uses; ${this.version} is this host's.`;
  }
}
/** Loading retained code and decoding the framework protocol are host failures. */
export type RuntimeLoadError =
  | RuntimeBuildUnavailable
  | RuntimeProtocolFailed
  | RuntimeProtocolUnsupported;

/** Framework-facing operations, independent of Node or Cloudflare bindings. */
export interface Runtime<Requirements = never> {
  /** Optional cross-process invalidation feed. The initial event follows registration.
   * A revision identifies all writes before that event; unversioned hosts emit void.
   */
  readonly changes?: (app: string) => Stream.Stream<number | void, RuntimeLoadError>;
  /** Sources build with the `apps` package they declare; sources without one are rejected. */
  readonly build: (input: {
    readonly files: SourceFiles;
  }) => Effect.Effect<
    BuiltApp,
    | RuntimeBuildFailed
    | RuntimeProtocolUnsupported
    | RuntimeAppsDependencyMissing
    | BuildMemoryExceeded,
    Requirements
  >;
  readonly asset?: (input: {
    readonly build: BuildId;
    readonly path: string;
  }) => Effect.Effect<RuntimeAsset | undefined, RuntimeBuildUnavailable, Requirements>;
  /**
   * Evaluate the current app skill catalog with the same selected account context as tools.
   * `sources` also reports whether a live loader contributed; send it only to builds that
   * declare the skillSources capability.
   */
  readonly skills: (
    input: {
      readonly app: string;
      readonly build: BuildId;
      readonly sources?: boolean;
    } & HostContext,
  ) => Effect.Effect<SkillCatalog, RuntimeLoadError | typeof HostInspectError.Type, Requirements>;
  /** Describe the current tools, or only the named ones. Unknown names are omitted. */
  readonly inspect: (
    input: {
      readonly app: string;
      readonly build: BuildId;
      readonly tools?: readonly string[];
      /** Describe only declared operations with schedules. Send only to scheduledTools builds. */
      readonly scheduled?: true;
    } & HostContext,
  ) => Effect.Effect<HostedCatalog, RuntimeLoadError | typeof HostInspectError.Type, Requirements>;
  /** List the current tools without their schemas. */
  readonly index: (
    input: { readonly app: string; readonly build: BuildId } & HostContext,
  ) => Effect.Effect<
    HostedCatalogSummary,
    RuntimeLoadError | typeof HostInspectError.Type,
    Requirements
  >;
  readonly query: (
    input: {
      readonly app: string;
      readonly build: BuildId;
      readonly database: boolean;
      /** Report the storage revision read by this successful query, never an authored result. */
      readonly observeRevision?: (revision: number) => void;
      readonly name: string;
      readonly input: Json;
    } & HostContext,
  ) => Effect.Effect<Json, RuntimeLoadError | typeof HostDataError.Type, Requirements>;
  readonly mutate: (
    input: {
      readonly app: string;
      readonly build: BuildId;
      readonly database: boolean;
      readonly name: string;
      readonly input: Json;
    } & HostContext,
  ) => Effect.Effect<Json, RuntimeLoadError | typeof HostDataError.Type, Requirements>;
  /** Execute a webhook lifecycle command against its retained build. */
  readonly webhook: (
    input: {
      readonly app: string;
      readonly build: BuildId;
      readonly database: boolean;
      readonly command: WebhookCommand;
    } & HostContext,
  ) => Effect.Effect<Json, RuntimeLoadError | typeof HostCallError.Type, Requirements>;
  /** Discover or execute workflows against the same retained app build. */
  readonly workflow: (
    input: {
      readonly app: string;
      readonly build: BuildId;
      readonly command: WorkflowCommand;
    } & HostContext,
  ) => Effect.Effect<Json, RuntimeLoadError | typeof HostCallError.Type, Requirements>;
  readonly call: (
    input: {
      readonly app: string;
      readonly build: BuildId;
      readonly database: boolean;
      readonly tool: string;
      /** Decides the storage mode before the app runs; the host verifies it. */
      readonly kind?: "query" | "mutation";
      readonly input: Json;
    } & HostContext,
  ) => Effect.Effect<Json, RuntimeLoadError | typeof HostCallError.Type, Requirements>;
  /**
   * Run one slot's provider check with the single account in `accounts`, without evaluating the
   * app. Send only to builds whose requirements declare a check for that slot.
   */
  readonly checkAccount: (
    input: {
      readonly app: string;
      readonly build: BuildId;
      readonly requirement: string;
    } & HostContext,
  ) => Effect.Effect<
    AccountCheckResult,
    RuntimeLoadError | typeof HostAccountCheckError.Type,
    Requirements
  >;
}
