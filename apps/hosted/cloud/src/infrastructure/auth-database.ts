/** The hosted auth database is Postgres; other SQL drivers do not belong in this Worker. */
import { AsyncLocalStorage } from "node:async_hooks";
import { HostedAppSessions, hostedAppSessions } from "@executor-js/hosted-server/app-ui";
import { RuntimeContext } from "alchemy";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Context, Effect, Exit, Layer, Option, Schema, Scope, Tracer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type Driver,
  type QueryId,
  type QueryResult,
} from "kysely";
import { cloudInvocationDatabase, InvocationDatabase } from "./invocation-database.ts";

const DriverCode = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^(?:[0-9A-Z]{5}|E[A-Z_]{2,40})$/)),
});
class AuthDatabaseFailed extends Schema.TaggedError<AuthDatabaseFailed>()("AuthDatabaseFailed", {
  code: Schema.String,
}) {}

/**
 * The invocation whose Promise work is calling Better Auth: the SQL client it shares with the
 * executor, the scope its reservations belong to, the background tasks it must keep alive, and
 * the context and span its SQL reports to.
 */
interface AuthInvocation {
  readonly sql: SqlClient.SqlClient;
  readonly scope: Scope.Scope;
  readonly pending: Array<Promise<unknown>>;
  readonly context: Context.Context<never>;
  readonly parent: Option.Option<Tracer.AnySpan>;
}

/**
 * Better Auth and its Kysely instance live for the isolate, but workerd sockets
 * belong to one invocation. Every call into Better Auth runs inside
 * {@link AuthDatabaseService.bind}, and each connection comes from that caller's client.
 */
const invocation = new AsyncLocalStorage<AuthInvocation>();

const current = () => {
  const store = invocation.getStore();
  // A query outside a bound call has no invocation that may own its socket.
  if (store === undefined) throw new Error("Auth database used outside a bound invocation");
  return store;
};

/** The invocation's context, with the span that issued the call as parent when one was bound. */
const callerContext = ({ context, parent }: AuthInvocation) =>
  Option.match(parent, {
    onNone: () => context,
    onSome: (span) => Context.add(context, Tracer.ParentSpan, span),
  });

const RawResult = Schema.Struct({
  command: Schema.String,
  rowCount: Schema.Number,
  rows: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  fields: Schema.Array(Schema.Struct({ name: Schema.String, dataTypeId: Schema.Number })),
});

/** PostgreSQL `int8` and `int8[]`, which node-postgres returns as strings. */
const int8Types = new Set([20, 1016]);

const int8Text = (value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : Array.isArray(value) ? value.map(int8Text) : value;

const quoted = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Better Auth was written against node-postgres, which sends every parameter as untyped text
 * and lets the server infer its type. The native client binds JavaScript numbers, booleans and
 * dates with concrete types, so convert them the way node-postgres does before binding.
 */
const textParameter = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return arrayLiteral(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const arrayLiteral = (values: ReadonlyArray<unknown>): string =>
  `{${values
    .map((value) => {
      if (value === null || value === undefined) return "NULL";
      if (Array.isArray(value)) return arrayLiteral(value);
      if (value instanceof Uint8Array) return quoted(`\\x${Buffer.from(value).toString("hex")}`);
      return quoted(String(textParameter(value)));
    })
    .join(",")}}`;

/** One Kysely checkout: a connection reserved from the invocation's client until released. */
class ReservedConnection implements DatabaseConnection {
  constructor(
    private readonly connection: Effect.Success<SqlClient.SqlClient["reserve"]>,
    private readonly owner: AuthInvocation,
    readonly release: Effect.Effect<void>,
  ) {}

  executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    return Effect.runPromiseWith(callerContext(this.owner))(
      Effect.suspend(() =>
        this.connection.executeRaw(query.sql, query.parameters.map(textParameter)),
      ).pipe(
        // Each query already records `auth.sql.timing`; the native wire span would repeat it.
        Effect.withTracerEnabled(false),
        // Reject with the server's error fields (`code`, `constraint`), as node-postgres does.
        Effect.mapError((error) =>
          error.reason.cause instanceof Error ? error.reason.cause : error,
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(RawResult)),
        Effect.map(({ command, rowCount, rows, fields }) => {
          const int8 = fields.filter(({ dataTypeId }) => int8Types.has(dataTypeId));
          return {
            rows: (int8.length === 0
              ? rows
              : rows.map((row) => {
                  const converted = { ...row };
                  for (const { name } of int8) converted[name] = int8Text(row[name]);
                  return converted;
                })) as Array<R>,
            ...(["INSERT", "UPDATE", "DELETE", "MERGE"].includes(command)
              ? { numAffectedRows: BigInt(rowCount) }
              : {}),
          };
        }),
      ),
    );
  }

  async *streamQuery<R>(query: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    yield await this.executeQuery<R>(query);
  }
}

const transactionControl = (connection: DatabaseConnection, sql: string) =>
  connection.executeQuery(CompiledQuery.raw(sql)).then(() => undefined);

/**
 * Kysely's driver over the invocation's shared client. Each checkout reserves one connection
 * for itself, including a whole transaction, so Better Auth never joins or commits an executor
 * transaction. Releasing returns the connection to the client's pool.
 */
const invocationDriver: Driver = {
  init: () => Promise.resolve(),
  acquireConnection: () => {
    const owner = current();
    return Effect.runPromiseWith(callerContext(owner))(
      Effect.gen(function* () {
        const scope = yield* Scope.fork(owner.scope, "sequential");
        const connection = yield* owner.sql.reserve.pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
        return new ReservedConnection(connection, owner, Scope.close(scope, Exit.void));
      }),
    );
  },
  beginTransaction: (connection, settings) =>
    transactionControl(
      connection,
      [
        "begin",
        settings.isolationLevel === undefined ? "" : `isolation level ${settings.isolationLevel}`,
        settings.accessMode ?? "",
      ].join(" "),
    ),
  commitTransaction: (connection) => transactionControl(connection, "commit"),
  rollbackTransaction: (connection) => transactionControl(connection, "rollback"),
  releaseConnection: (connection) =>
    connection instanceof ReservedConnection
      ? Effect.runPromise(connection.release)
      : Promise.resolve(),
  // Each invocation's client closes with its event scope.
  destroy: () => Promise.resolve(),
};

/**
 * Better Auth's Kysely instance. Each query records an `auth.sql.timing` span
 * under the span that issued it, or under its invocation when no span was bound.
 */
const timedAuthDatabase = () => {
  const started = new WeakMap<QueryId, number>();
  return new Kysely<unknown>({
    dialect: {
      createDriver: () => invocationDriver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [
      {
        transformQuery: ({ queryId, node }) => {
          started.set(queryId, Date.now());
          return node;
        },
        transformResult: ({ result }) => Promise.resolve(result),
      },
    ],
    log: (event) => {
      const start = started.get(event.query.queryId);
      started.delete(event.query.queryId);
      return Effect.runPromiseWith(callerContext(current()))(
        (event.level === "error"
          ? Effect.fail(
              new AuthDatabaseFailed({
                code: Option.match(Schema.decodeUnknownOption(DriverCode)(event.error), {
                  onNone: () => "UnknownDriverError",
                  onSome: ({ code }) => code,
                }),
              }),
            )
          : Effect.void
        ).pipe(
          Effect.withSpan("auth.sql.timing", {
            attributes: {
              "db.query.kind": event.query.query.kind,
              "db.query.duration_ms": event.queryDurationMillis,
              "db.query.success": event.level === "query",
              "db.query.parameter_count": event.query.parameters.length,
              "db.query.clock": "cloudflare-io",
              ...(start === undefined
                ? {}
                : { "db.query.compile_to_result_ms": Date.now() - start }),
            },
          }),
          Effect.withErrorReporting,
          Effect.ignore,
        ),
      );
    },
  });
};

export interface AuthDatabaseService {
  /** Better Auth's `database` option. It holds no connection of its own. */
  readonly options: {
    readonly db: Kysely<unknown>;
    readonly type: "postgres";
    // SSO account resolution and membership provisioning require real
    // transactions; the Kysely adapter otherwise runs callbacks without one.
    readonly transaction: true;
  };
  /** Better Auth's background tasks join the invocation that started them. */
  readonly background: (task: Promise<unknown>) => void;
  /**
   * Bind Promise work to this invocation's client and the calling span, so its SQL
   * uses this event's socket and its timing spans become children of the caller.
   */
  readonly bind: Effect.Effect<<A>(run: () => A) => A, never, RuntimeContext>;
}

export class AuthDatabase extends Context.Service<AuthDatabase, AuthDatabaseService>()(
  "executor/cloud/AuthDatabase",
) {}

/**
 * App sessions whose Better Auth reads bind the calling operation's invocation when each
 * operation runs, not when the service is built. A layer builds in its own child of the event
 * scope, so binding there kept a second execution memo, and a second SQL client, beside the one
 * the executor uses in the same event; it also parented every auth query to the layer build.
 */
export const appSessionsPerCall = (
  adapters: Effect.Effect<Parameters<typeof hostedAppSessions>[0], never, RuntimeContext>,
): HostedAppSessions["Service"] => {
  const sessions = adapters.pipe(
    Effect.map((context) => hostedAppSessions(context, globalThis.crypto)),
    Effect.provide(RuntimeContext.phantom),
  );
  return HostedAppSessions.of({
    organization: (find) => Effect.flatMap(sessions, (live) => live.organization(find)),
    access: (principal, target) =>
      Effect.flatMap(sessions, (live) => live.access(principal, target)),
    begin: (target, returnTo) => Effect.flatMap(sessions, (live) => live.begin(target, returnTo)),
    pending: (request) => Effect.flatMap(sessions, (live) => live.pending(request)),
    grant: (request, target, principal) =>
      Effect.flatMap(sessions, (live) => live.grant(request, target, principal)),
    complete: (target, request, code, proof) =>
      Effect.flatMap(sessions, (live) => live.complete(target, request, code, proof)),
    current: (target, token) => Effect.flatMap(sessions, (live) => live.current(target, token)),
  });
};

/** An object whose methods run as work bound by {@link AuthDatabaseService.bind}. */
export const boundAuthAdapter = <A extends object>(adapter: A, bind: <B>(run: () => B) => B): A =>
  new Proxy(adapter, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === "function"
        ? (...args: ReadonlyArray<unknown>) => bind(() => Reflect.apply(value, target, args))
        : value;
    },
  });

/**
 * One Kysely instance per isolate. Each invocation's queries use the SQL client the executor
 * uses in the same Worker event or Durable Object call, so they reuse its connections.
 */
const authDatabase = Layer.effect(
  AuthDatabase,
  Effect.gen(function* () {
    const database = yield* InvocationDatabase;
    const resources = yield* makeExecutionMemo(
      Effect.gen(function* () {
        // Building a client opens no connection; a malformed URL is a deployment defect.
        const sql = Context.get(yield* Effect.orDie(database), SqlClient.SqlClient);
        const scope = yield* Effect.scope;
        const pending: Array<Promise<unknown>> = [];
        // Added after the client, so it runs first: background SQL still has its socket.
        yield* Effect.addFinalizer(() => Effect.promise(() => Promise.allSettled(pending)));
        return { sql, scope, pending };
      }),
    );
    return AuthDatabase.of({
      options: { db: timedAuthDatabase(), type: "postgres", transaction: true },
      background: (task) => current().pending.push(task),
      bind: Effect.gen(function* () {
        const { sql, scope, pending } = yield* resources;
        const parent = yield* Effect.option(Effect.currentParentSpan);
        // This trusted host callback needs the complete invocation context.
        const context = yield* Effect.context<never>();
        return <A>(run: () => A) => invocation.run({ sql, scope, pending, context, parent }, run);
      }),
    });
  }),
);

/** Better Auth and the executor's shared client: provide this once where both are built. */
export const cloudAuthDatabase = authDatabase.pipe(Layer.provideMerge(cloudInvocationDatabase));
