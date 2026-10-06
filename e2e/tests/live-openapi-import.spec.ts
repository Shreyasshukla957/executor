import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import {
  clientCredentialsScheme,
  deployPublicApp,
  invalidSchemaDocument,
  jsonLines,
  malformedSwaggerDocument,
  openapi32Upstream,
  otherHostDocument,
  unsupportedAuthDocument,
} from "../support/openapi-import.ts";
import { scenarios } from "../test-plan.ts";

/** A router's listing failure; the importer's failures carry every field. */
const RouterFailure = Schema.Struct({
  _tag: Schema.String,
  errorName: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
});
const Catalog = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ name: Schema.String, readOnly: Schema.optionalKey(Schema.Boolean) }),
  ),
  routers: Schema.Array(
    Schema.Struct({ path: Schema.String, error: Schema.optionalKey(RouterFailure) }),
  ),
});
const EvaluationFailed = Schema.Struct({
  _tag: Schema.Literal("AppEvaluationFailed"),
  message: Schema.String,
  failure: Schema.Struct({
    source: Schema.String,
    errorName: Schema.String,
    code: Schema.String,
    message: Schema.String,
  }),
});
const Recorded = Schema.Struct({ method: Schema.String, url: Schema.String, body: Schema.String });

/** Definitions the importer cannot fully use, each mounted under its own key. */
const diagnosed = `import { defineApp, router } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
const common = { securitySchemes: {}, methods: {}, oauth: [] };
export default defineApp({ accounts: {} }, async ({ cache, fetch, signal }) => ({
  tools: router({
    mail: liveOpenapiRouter({ ...common, cache, fetch, signal,
      source: { document: ${JSON.stringify(otherHostDocument)} },
      allowedOrigin: "https://www.example.com" }),
    teams: liveOpenapiRouter({ ...common, cache, fetch, signal,
      source: { document: ${JSON.stringify(invalidSchemaDocument)} },
      allowedOrigin: "https://api.example.com" }),
    status: liveOpenapiRouter({ ...common, cache, fetch, signal,
      source: { document: ${JSON.stringify(malformedSwaggerDocument)} },
      allowedOrigin: "https://status.example.com" }),
    jobs: liveOpenapiRouter({ ...common, cache, fetch, signal,
      source: { document: ${JSON.stringify(unsupportedAuthDocument)} },
      securitySchemes: ${JSON.stringify(clientCredentialsScheme)},
      allowedOrigin: "https://jobs.example.com" }),
  }),
}));
`;

layer(HostedLive, { excludeTestServices: true })("Live OpenAPI import", (it) => {
  it.effect(scenarios.liveOpenapiDiagnostics.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const app = yield* deployPublicApp(diagnosed);
        const listed = yield* app.tools;
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        const catalog = yield* body(Catalog, listed);
        const routers = catalog.routers;
        const failure = (path: string) => routers.find((router) => router.path === path)?.error;

        // An allowed origin no operation uses names the origins they do use, and each operation.
        expect(failure("mail")).toMatchObject({
          errorName: "OpenapiCompileError",
          code: "no_supported_operations",
        });
        expect(failure("mail")?.message).toContain(
          "allowedOrigin https://www.example.com is not the origin of any operation. They resolve to https://mail.example.com.",
        );
        expect(failure("mail")?.message).toContain(
          "GET /mail/v1/users/{userId}/messages and 1 more (multiple_hosts:",
        );

        // An operation whose schema holds an unresolvable reference is left out; the rest import,
        // including an invalid schema without a reference.
        expect(failure("teams")).toBeUndefined();
        const teams = catalog.items.filter((tool) => tool.name.startsWith("teams."));
        expect(teams.map((tool) => tool.name)).toEqual(["teams.teams.listTeams"]);

        // Reading or calling the left-out tool names the invalid schema by its JSON Pointer and
        // the operation that reaches it.
        const pointer =
          "#/components/schemas/Team/allOf/1/properties/_embedded/properties/members/items";
        const leftOut = {
          source: "app",
          errorName: "OpenapiCompileError",
          code: "schema_keyword",
          message: `The schema at ${pointer} is invalid: "items" must be a schema, not an array, so the reference inside it cannot be resolved. Left out: GET /teams/{team}.`,
        };
        const read = yield* app.tool("teams.teams.getTeam");
        expect(read.status, JSON.stringify(read.body)).toBe(502);
        const evaluation = yield* body(EvaluationFailed, read);
        expect(evaluation.failure).toEqual(leftOut);
        expect(evaluation.message).toContain(pointer);
        const called = yield* app.call("teams.teams.getTeam", "query", {
          path: { team: "core" },
        });
        expect(called.status, JSON.stringify(called.body)).toBe(502);
        expect((yield* body(EvaluationFailed, called)).failure).toEqual(leftOut);

        // A malformed Swagger 2.0 definition is named by its JSON Pointer before it is upgraded.
        expect(failure("status")).toEqual({
          _tag: "HostEvaluationFailed",
          errorName: "OpenapiCompileError",
          code: "invalid_document",
          message:
            "The response at #/paths/~1status/get/responses/200 is invalid: Expected object.",
        });

        // When no operation can be called, each one says which authentication or response it
        // needs.
        expect(failure("jobs")).toMatchObject({
          errorName: "OpenapiCompileError",
          code: "no_supported_operations",
        });
        expect(failure("jobs")?.message).toContain(
          "GET /jobs (auth_method: Executor cannot authenticate with any of its security requirements: client (oauth2 clientCredentials)); GET /jobs/events (event_stream: It responds with text/event-stream",
        );
      }),
    ),
  );

  it.effect(scenarios.liveOpenapi32.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const upstream = yield* openapi32Upstream;
        const app = yield* deployPublicApp(`import { defineApp } from "apps";
import { liveOpenapiRouter } from "apps/openapi";
export default defineApp({ accounts: {} }, async ({ cache, fetch, signal }) => ({
  tools: liveOpenapiRouter({ cache, fetch, signal,
    source: { url: ${JSON.stringify(`${upstream.origin}/openapi.json`)} },
    allowedOrigin: ${JSON.stringify(upstream.origin)},
    // The definition's paths omit the project segment every route needs.
    pathPrefix: "/projects/{project}",
    securitySchemes: {}, methods: {}, oauth: [] }),
}));
`);
        const listed = yield* app.tools;
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        // Unnamed operations in one group are told apart by their paths, not hashes. QUERY is a
        // query; a method Executor cannot send is left out.
        const tools = (yield* body(Catalog, listed)).items;
        expect(tools.map((tool) => tool.name).sort()).toEqual([
          "artifacts.findArtifacts",
          "builds.getBuilds",
          "builds.getBuildsByBuildNum",
          "builds.searchBuilds",
          "events.getEvents",
        ]);
        expect(tools.every((tool) => tool.readOnly === true)).toBe(true);

        const call = (tool: string, input: unknown) =>
          app.call(tool, "query", input).pipe(
            Effect.tap((response) =>
              Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
            ),
            Effect.flatMap((response) => body(Recorded, response)),
          );
        const project = { project: "alpha" };
        expect(yield* call("builds.getBuilds", { path: project })).toEqual({
          method: "GET",
          url: "/projects/alpha/builds",
          body: "",
        });
        expect(
          yield* call("builds.getBuildsByBuildNum", { path: { ...project, build_num: 7 } }),
        ).toMatchObject({ method: "GET", url: "/projects/alpha/builds/7" });
        expect(
          yield* call("builds.searchBuilds", { path: project, body: { status: "failed" } }),
        ).toEqual({ method: "QUERY", url: "/projects/alpha/builds", body: '{"status":"failed"}' });
        expect(
          yield* call("artifacts.findArtifacts", {
            path: project,
            querystring: { filter: { name: "app log", tag: ["x", "y"] } },
          }),
        ).toMatchObject({
          method: "GET",
          url: "/projects/alpha/artifacts?name=app+log&tag=x&tag=y",
        });
        // JSON Lines are returned as their text, not parsed as one JSON value.
        const events = yield* app.call("events.getEvents", "query", { path: project });
        expect(events.status, JSON.stringify(events.body)).toBe(200);
        expect(yield* body(Schema.String, events)).toBe(jsonLines);
        expect((yield* upstream.requests).map((request) => request.method)).toEqual([
          "GET",
          "GET",
          "QUERY",
          "GET",
        ]);
      }),
    ),
  );
});
