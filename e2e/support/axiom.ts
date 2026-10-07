/** Read delivered Cloud traces through Axiom's public query API; never log credentials or raw failures. */
import { Clock, Config, Effect, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { SpanQuery } from "./contracts.ts";

const Tabular = Schema.Struct({
  status: Schema.Struct({ isPartial: Schema.Boolean }),
  tables: Schema.Array(
    Schema.Struct({
      fields: Schema.Array(Schema.Struct({ name: Schema.String })),
      columns: Schema.Array(Schema.Array(Schema.Unknown)),
    }),
  ),
});
const Row = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.NullOr(Schema.String),
  operationName: Schema.String,
  serviceName: Schema.String,
  startTime: Schema.String,
  durationMs: Schema.Number,
  status: Schema.String,
  tags: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
  standard: Schema.Record(Schema.String, Schema.Json),
  build: Schema.NullOr(Schema.String),
  links: Schema.NullOr(
    Schema.Array(Schema.Struct({ trace_id: Schema.String, span_id: Schema.String })),
  ),
  events: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        attributes: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Json))),
      }),
    ),
  ),
  statusMessage: Schema.NullOr(Schema.String),
});
/** Delivered values keep their text; structured values are serialized so checks still see them. */
const text = (values: Readonly<Record<string, Schema.Json>>) =>
  Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== null)
      .map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
  );

/**
 * Axiom stores OpenTelemetry attributes it recognizes in their own `attributes.*` columns and only
 * the rest in `attributes.custom`. Read the recognized ones back under their OpenTelemetry names.
 * The list matches the columns Axiom defines for trace datasets.
 */
const recognizedAttributes = [
  "client.address",
  "cloud.platform",
  "cloud.provider",
  "code.column.number",
  "code.file.path",
  "code.line.number",
  "db.collection.name",
  "db.namespace",
  "db.operation.name",
  "db.query.text",
  "db.response.status_code",
  "db.system.name",
  "deployment.id",
  "error.type",
  "exception.type",
  "faas.cron",
  "faas.invocation_id",
  "faas.invoked_region",
  "faas.name",
  "faas.trigger",
  "faas.version",
  "geo.continent.code",
  "geo.locality.name",
  "graphql.operation.type",
  "http.request.body.size",
  "http.request.method",
  "http.response.body.size",
  "http.response.status_code",
  "http.route",
  "network.protocol.name",
  "network.protocol.version",
  "rpc.method",
  "server.address",
  "server.port",
  "service.name",
  "telemetry.sdk.language",
  "telemetry.sdk.name",
  "url.full",
  "url.path",
  "url.query",
  "url.scheme",
  "user_agent.original",
  "user_agent.os.name",
  "user_agent.os.version",
] as const;
const standard = `pack(${recognizedAttributes
  .map((name) => `'${name}', column_ifexists('attributes.${name}', dynamic(null))`)
  .join(", ")})`;

/** Queries remain limited to one validated trace and the current run's time window. */
export const axiomTraceQuery = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const start = yield* Clock.currentTimeMillis;
  return (traceId: string) =>
    Effect.gen(function* () {
      const id = yield* Schema.decodeUnknownEffect(
        Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
      )(traceId);
      const token = yield* Config.Redacted("E2E_AXIOM_TOKEN");
      const organization = yield* Config.option(Config.NonEmptyString("E2E_AXIOM_ORG_ID"));
      const dataset = yield* Config.String("E2E_AXIOM_DATASET").pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]+$/))),
        ),
      );
      const now = yield* Clock.currentTimeMillis;
      const request = yield* HttpClientRequest.post(
        "https://api.axiom.co/v1/datasets/_apl?format=tabular",
      ).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(token)}`),
        HttpClientRequest.setHeaders(
          Option.isSome(organization) ? { "x-axiom-org-id": organization.value } : {},
        ),
        HttpClientRequest.bodyJson({
          apl: `['${dataset}'] | where trace_id == '${id}' | project traceId=trace_id, spanId=span_id, parentSpanId=parent_span_id, operationName=name, serviceName=['service.name'], startTime=_time, durationMs=duration/1ms, status=['status.code'], tags=['attributes.custom'], build=['resource.custom']['executor.build.id'], links, events=column_ifexists('events', dynamic(null)), statusMessage=column_ifexists('status.message', ''), standard=${standard} | take 5000`,
          startTime: new Date(start - 60_000).toISOString(),
          endTime: new Date(now + 60_000).toISOString(),
        }),
      );
      const response = yield* client.pipe(HttpClient.filterStatusOk).execute(request);
      const payload = yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Tabular)),
      );
      if (payload.status.isPartial)
        return yield* Effect.fail(new Error("Axiom returned partial trace data"));
      const rows = [];
      for (const table of payload.tables) {
        if (table.fields.length !== table.columns.length)
          return yield* Effect.fail(new Error("Axiom returned inconsistent columns"));
        const count = table.columns[0]?.length ?? 0;
        if (count === 5000 || table.columns.some((column) => column.length !== count))
          return yield* Effect.fail(new Error("Axiom trace result is incomplete"));
        for (let row = 0; row < count; row++) {
          const value = Object.fromEntries(
            table.fields.map((field, index) => [field.name, table.columns[index]?.[row]]),
          );
          rows.push(yield* Schema.decodeUnknownEffect(Row)(value));
        }
      }
      return yield* Schema.decodeUnknownEffect(SpanQuery)({
        data: rows.map((row) => ({
          traceId: row.traceId,
          span: {
            spanId: row.spanId,
            parentSpanId: row.parentSpanId === "" ? null : row.parentSpanId,
            operationName: row.operationName,
            serviceName: row.serviceName,
            startTime: row.startTime,
            durationMs: row.durationMs,
            status: row.status === "Error" || row.status === "ERROR" ? "error" : "ok",
            links: (row.links ?? []).map((link) => ({
              traceId: link.trace_id,
              spanId: link.span_id,
            })),
            events: (row.events ?? []).map((event) => ({
              name: event.name,
              attributes: text(event.attributes ?? {}),
            })),
            ...(row.statusMessage === null || row.statusMessage === ""
              ? {}
              : { statusMessage: row.statusMessage }),
            tags: {
              ...text({ ...row.tags, ...row.standard }),
              ...(row.build === null ? {} : { "executor.build.id": row.build }),
            },
          },
        })),
      });
    }).pipe(Effect.scoped, Effect.timeout("10 seconds"));
});
