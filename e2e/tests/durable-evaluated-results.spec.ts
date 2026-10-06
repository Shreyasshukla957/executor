/**
 * Cloud keeps evaluated tool listings in each app's data supervisor, so a read that misses the
 * isolate's memory is served from it, and an app cache invalidation forgets it for every isolate.
 * A background refresh of a stale listing replaces the supervisor's copy.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";

/**
 * A listing over the isolate store's 2 MB entry bound: 1,500 tools with 800-character
 * descriptions. The isolate never keeps it, so every read after the first tests the supervisor.
 * The revision tool is named after a value kept in the app cache, so an invalidation renames it.
 */
const source = `import { defineApp, query, object, router, string } from "apps";
export default defineApp({ accounts: {} }, async (ctx) => {
  const revision = await ctx.cache.get({
    key: "revision",
    schema: string(),
    freshFor: "1 day",
    load: async () => crypto.randomUUID().replaceAll("-", "").slice(0, 12),
  });
  const padding = "x".repeat(800);
  const listed = Object.fromEntries(
    Array.from({ length: 1500 }, (_, index) => [
      "tool_" + index,
      query({ description: padding, input: object({}) }, async () => index),
    ]),
  );
  return {
    tools: router({
      ...listed,
      ["revision_" + revision]: query({ input: object({}) }, async () => revision),
      bump: query({ input: object({}) }, async () => {
        await ctx.cache.invalidate("revision");
        return true;
      }),
    }),
  };
});`;

const Listing = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });

/** Deploy the large-listing app and read its tool listing with the spans of each request. */
const listingApp = Effect.gen(function* () {
  const api = yield* Api,
    actors = yield* Actors,
    telemetry = yield* Telemetry,
    evidence = yield* Evidence;
  const prefix = `/api/organizations/${actors.organization.id}/apps`;
  const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
    name: `Durable listing ${randomUUID().slice(0, 8)}`,
    files: [{ path: "index.ts", content: source }, appsManifest],
  });
  expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
  const app = yield* body(App, deployed);
  yield* Effect.addFinalizer(() =>
    api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
  );
  const path = `${prefix}/${app.id}`;

  /** The listing's tool names and the spans of the request's own trace. */
  const read = (label: string, settled: (names: ReadonlyArray<string>) => boolean) =>
    Effect.gen(function* () {
      const response = yield* api.request(actors.owner, "GET", `${path}/tools`);
      expect(response.status, label).toBe(200);
      const names = (yield* body(Listing, response)).items.map((item) => item.name);
      const request = (yield* evidence.requests).at(-1);
      if (request === undefined) return yield* Effect.die(new Error("Missing request"));
      const spans = yield* telemetry.query(request.traceId).pipe(
        Effect.map((result) => result.data.map((row) => row.span)),
        Effect.flatMap((spans) =>
          settled(spans.map((span) => span.operationName))
            ? Effect.succeed(spans)
            : Effect.fail(new Error(`The ${label} trace has not arrived`)),
        ),
        Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
      );
      yield* evidence.json(`${label}.json`, spans);
      const listing = spans.find((span) => span.operationName === "sdk.tools.listing");
      return {
        names,
        spans: spans.map((span) => span.operationName),
        revision: names.find((name) => name.startsWith("revision_")),
        cache: listing?.tags["executor.declarations.cache"],
        source: listing?.tags["executor.declarations.source"],
        age: Number(listing?.tags["executor.declarations.age_ms"]),
      };
    });
  return { api, actors, path, read };
});

const listed = (names: ReadonlyArray<string>) => names.includes("sdk.tools.listing");
/** A read that evaluated, and kept its result in the supervisor after responding. */
const written = (names: ReadonlyArray<string>) =>
  listed(names) && names.includes("storage.evaluated.write");

layer(HostedLive, { excludeTestServices: true })("Durable evaluated results", (it) => {
  it.effect(scenarios.durableEvaluatedResults.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, path, read } = yield* listingApp;

        // The first read evaluates and keeps the listing in the supervisor after responding.
        const first = yield* read("first-listing", written);
        expect(first.cache).toBe("miss");
        // Pages are sorted by name, so the first holds bump and the revision tool.
        expect(first.names).toContain("bump");
        expect(first.revision).toBeDefined();

        // The isolate cannot keep a listing this large, so the next read is the supervisor's copy.
        const second = yield* read("durable-listing", listed);
        expect(second.source).toBe("durable");
        expect(second.cache).toBe("hit");
        expect(second.names).toEqual(first.names);

        // An app cache invalidation forgets it in the supervisor, for every isolate at once.
        const bumped = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "bump",
          kind: "query",
          input: {},
        });
        expect(bumped.status, JSON.stringify(bumped.body)).toBe(200);
        const third = yield* read("after-invalidation", listed);
        expect(third.cache).toBe("miss");
        expect(third.source).toBeUndefined();
        expect(third.revision).toBeDefined();
        expect(third.revision).not.toBe(first.revision);
      }),
    ),
  );

  it.effect(
    scenarios.durableEvaluatedRefresh.title,
    (context) =>
      withHostedCase(
        context,
        Effect.gen(function* () {
          const { read } = yield* listingApp;
          const first = yield* read("first-listing", written);
          expect(first.cache).toBe("miss");

          // Past the listing's 30 s fresh period, the supervisor's copy is served while a
          // background evaluation replaces it. The refresh finishes after the response, so it
          // must still keep its result in the supervisor.
          yield* Effect.sleep("31 seconds");
          const stale = yield* read("stale-listing", (names) =>
            names.includes("sdk.tools.listing.evaluate"),
          );
          expect(stale.source).toBe("durable");
          expect(stale.cache).toBe("stale");
          expect(stale.age).toBeGreaterThanOrEqual(30_000);
          expect(stale.spans).toContain("storage.evaluated.write");

          // The refreshed copy is fresh: the next read is served from it without evaluating.
          const refreshed = yield* read("refreshed-listing", listed);
          expect(refreshed.source).toBe("durable");
          expect(refreshed.cache).toBe("hit");
          expect(refreshed.age).toBeLessThan(stale.age);
          expect(refreshed.spans).not.toContain("sdk.tools.listing.evaluate");
          expect(refreshed.names).toEqual(first.names);
        }),
      ),
    { timeout: 120_000 },
  );
});
