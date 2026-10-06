/**
 * The SQL client one Worker event (or Durable Object call) uses for every database consumer:
 * the executor, hosted permission checks and Better Auth. A TLS login to PgBouncer costs about
 * 70 ms from a placed Worker, so consumers share one pool and sequential work reuses one connection.
 */
import { PgClient } from "@effect/sql-pg";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Context, Effect, Layer, Option } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import { cloudDatabaseConnection } from "./database.ts";
import { ObjectDatabase } from "./object-database.ts";

export type SqlServices = PgClient.PgClient | SqlClient.SqlClient;

/**
 * Connections one Worker event may hold. The pool opens them on demand and reuses an idle one,
 * so sequential work, including Better Auth's session check followed by the executor, opens one.
 * The second exists so a Better Auth transaction and the executor never wait on each other,
 * which two separate one-connection pools guaranteed before.
 */
export const invocationConnectionLimit = 2;

export class InvocationDatabase extends Context.Service<
  InvocationDatabase,
  Effect.Effect<Context.Context<SqlServices>, SqlError.SqlError>
>()("executor/cloud/InvocationDatabase") {}

/**
 * One client per execution, closed with the event. A Durable Object lends its own held client
 * instead. PgBouncer pools in transaction mode, so no consumer may rely on session state
 * (`prepare: false`; no session `SET`, advisory locks or `LISTEN`).
 */
export const cloudInvocationDatabase = Layer.effect(
  InvocationDatabase,
  Effect.gen(function* () {
    const connection = yield* cloudDatabaseConnection;
    return yield* makeExecutionMemo(
      Effect.gen(function* () {
        const object = yield* Effect.serviceOption(ObjectDatabase);
        if (Option.isSome(object)) return yield* object.value.sql;
        const url = yield* connection.connectionString;
        return yield* Layer.build(
          PgClient.layer({ url, maxConnections: invocationConnectionLimit, prepare: false }),
        );
      }).pipe(Effect.withSpan("runtime.cloud.database.initialize")),
    );
  }),
);
