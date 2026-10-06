/**
 * Legacy storage fixtures: rows that only an older product version could have written.
 * The runner applies SQL to the stopped product's own database; the next start of the
 * current server then migrates, recovers and serves over that state like an upgrade.
 * Scenarios must declare `legacyStorage: true` in the test plan. Normal setup uses public APIs.
 */
import { PGlite } from "@electric-sql/pglite";
import { Effect, Exit, Schema } from "effect";
import { driver, Target } from "./platform.ts";
import { Evidence } from "./evidence.ts";
import { controlRequest } from "./server-control.ts";

/** One parameterized statement against the product's actual tables. */
export const LegacyStatement = Schema.Struct({
  sql: Schema.NonEmptyString,
  params: Schema.optional(
    Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])),
  ),
});
export const LegacyStatements = Schema.NonEmptyArray(LegacyStatement);
/** Rows returned by each statement, in order. Timestamps stay as stored UTC text. */
export const LegacyResults = Schema.Array(
  Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
);

/** A fixture statement failed; the whole write was rolled back. */
export class LegacyStatementFailed extends Schema.TaggedError<LegacyStatementFailed>()(
  "LegacyStatementFailed",
  { index: Schema.Number, message: Schema.String },
) {}

/** The product database inside a runner-owned data directory. */
export const productDatabase = (dataDirectory: string, target: "self-host" | "local") =>
  `${dataDirectory}/${target === "self-host" ? "hosted.pglite" : "executor.pglite"}`;

/** Runner side: apply statements in one transaction. The caller guarantees the product is stopped. */
export const applyLegacyStatements = (database: string, statements: typeof LegacyStatements.Type) =>
  Effect.acquireUseRelease(
    driver("open product database", () =>
      // Match the product's codec: naive timestamps are UTC text, not local-time Dates.
      PGlite.create(database, { parsers: { 1082: (value) => value, 1114: (value) => value } }),
    ),
    (db) =>
      Effect.acquireUseRelease(
        driver("begin legacy write", () => db.exec("BEGIN")),
        () =>
          Effect.forEach(statements, (statement, index) =>
            Effect.tryPromise({
              try: () =>
                db.query<Record<string, unknown>>(statement.sql, [...(statement.params ?? [])]),
              // Statements and their database errors are synthetic fixture text, safe to report.
              catch: (cause) =>
                new LegacyStatementFailed({
                  index,
                  message: cause instanceof Error ? cause.message : "Unknown database error",
                }),
            }).pipe(Effect.map((result) => result.rows)),
          ),
        (_, exit) =>
          driver("finish legacy write", () =>
            db.exec(Exit.isSuccess(exit) ? "COMMIT" : "ROLLBACK"),
          ).pipe(Effect.orDie),
      ),
    (db) => driver("close product database", () => db.close()).pipe(Effect.orDie),
  );

/**
 * Scenario side: stop the product, apply the statements, and leave it stopped.
 * Start it with `serverControl("start")` so the current server boots over the written state.
 */
export const legacyStorage = (statements: typeof LegacyStatements.Type) =>
  Effect.gen(function* () {
    const target = yield* Target,
      evidence = yield* Evidence;
    if (target.metadata.target === "cloud")
      return yield* Effect.die("Legacy storage requires a runner-owned product database");
    return yield* evidence.step(
      `Legacy storage write (${statements.length} statements)`,
      controlRequest("storage/legacy", 200, { statements }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(LegacyResults))),
        Effect.orDie,
      ),
    );
  });
