/** Remote skill catalogs kept in the app cache, through the real app compiler, runtime and HTTP. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { App } from "../support/contracts.ts";
import { skillUpstream } from "../support/skill-upstream.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { appsManifest } from "../support/apps-release.ts";

const Bundle = Schema.Struct({
  revision: Schema.String,
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
    }),
  ),
});
layer(HostedLive, { excludeTestServices: true })("Cached skills", (it) => {
  it.effect(scenarios.cachedSkills.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry;
        const upstream = yield* skillUpstream;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Cached skills ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, dynamicSkills, query, object, router } from "apps";
import { githubSkills, wellKnownSkills } from "apps/skills";
export default defineApp({ accounts: {} }, async (ctx) => ({
  tools: router({ ping: query({ input: object({}) }, async () => "pong") }),
  dynamicSkills: dynamicSkills({ list: async () => [
    ...await wellKnownSkills({ url: ${JSON.stringify(upstream.url)}, cache: ctx.cache, freshFor: "1 hour", fetch: ctx.fetch, signal: ctx.signal }),
    ...await githubSkills({ repo: "synthetic/skills", path: "skills", cache: ctx.cache, freshFor: "1 hour", signal: ctx.signal, fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return ctx.fetch(${JSON.stringify(upstream.url)} + "/github" + url.pathname + url.search, init);
    } }),
  ] }),
}));`,
            },
            appsManifest,
          ],
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const base = `${prefix}/${app.id}`;
        const read = Effect.gen(function* () {
          const bundle = yield* api.request(actors.owner, "GET", `${base}/skill-bundle`);
          expect(
            bundle.status,
            JSON.stringify({ response: bundle.body, requests: yield* upstream.requests }),
          ).toBe(200);
          return yield* body(Bundle, bundle);
        });
        /** How the latest request's skill read was served, from its own trace. */
        const outcome = Effect.gen(function* () {
          const request = (yield* evidence.requests).at(-1);
          if (request === undefined) return yield* Effect.fail(new Error("Missing request"));
          const spans = yield* telemetry.query(request.traceId).pipe(
            Effect.map((result) =>
              result.data.filter(
                ({ span }) =>
                  span.operationName === "sdk.declarations.read" &&
                  span.tags["executor.declarations.command"] === "skills",
              ),
            ),
            Effect.flatMap((spans) =>
              spans.length === 0
                ? Effect.fail(new Error("Missing skill read span"))
                : Effect.succeed(spans),
            ),
            Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 80 }),
          );
          return spans[0]?.span.tags["executor.declarations.cache"];
        });

        const first = yield* read;
        expect(first.skills.map((skill) => skill.name)).toEqual(["github-guide", "remote-guide"]);
        expect(
          first.skills.every((skill) =>
            skill.files.some((file) => file.content.includes("Reference 1")),
          ),
        ).toBe(true);
        const loaded = (yield* upstream.requests).length;
        expect(loaded).toBeGreaterThan(0);

        // A loader that reads through the app cache has its catalog kept, so the next read
        // neither evaluates the app nor contacts either source.
        const second = yield* read;
        expect(second).toEqual(first);
        expect(yield* outcome).toBe("hit");
        expect((yield* upstream.requests).length).toBe(loaded);

        // Within freshFor, a new publication is not fetched; the kept catalog stays current.
        yield* upstream.publish(2);
        const third = yield* read;
        expect(third.revision).toBe(first.revision);
        expect((yield* upstream.requests).length).toBe(loaded);
        const file = yield* api.request(
          actors.owner,
          "GET",
          `${base}/skills/remote-guide?revision=${first.revision}&file=references/example.md`,
        );
        expect(file.status).toBe(200);
        expect((yield* body(Schema.Struct({ content: Schema.String }), file)).content).toBe(
          "# Reference 1",
        );
        expect((yield* upstream.requests).length).toBe(loaded);
      }),
    ),
  );

  it.effect(scenarios.cachedSkillsRefresh.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const upstream = yield* skillUpstream;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Refreshed skills ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, query, object, router } from "apps";
import { wellKnownSkills } from "apps/skills";
export default defineApp({ accounts: {} }, async (ctx) => ({
  tools: router({
    reference: query({ input: object({}) }, async () => {
      const skills = await wellKnownSkills({ url: ${JSON.stringify(upstream.url)}, cache: ctx.cache, freshFor: "1 second", fetch: ctx.fetch, signal: ctx.signal });
      return skills.flatMap((skill) => skill.files).find((file) => file.path === "references/example.md")?.content ?? null;
    }),
  }),
}));`,
            },
            appsManifest,
          ],
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        /** The reference file of the catalog the tool read, as the tool call returned it. */
        const reference = Effect.gen(function* () {
          const called = yield* api.request(
            actors.owner,
            "POST",
            `${prefix}/${app.id}/tools/call`,
            {
              tool: "reference",
              kind: "query",
              input: {},
            },
          );
          expect(called.status, JSON.stringify(called.body)).toBe(200);
          const text = JSON.stringify(called.body);
          return text.includes("# Reference 2") ? 2 : text.includes("# Reference 1") ? 1 : 0;
        });

        expect(yield* reference).toBe(1);
        const loaded = (yield* upstream.requests).length;

        // Past freshFor, a read returns the kept catalog while a background refresh loads the new
        // publication with the author's fetch; the refresh outlives the call that started it.
        yield* upstream.publish(2);
        yield* Effect.sleep("1500 millis");
        expect(yield* reference).toBe(1);
        const refreshed = yield* reference.pipe(
          Effect.flatMap((version) =>
            version === 2 ? Effect.succeed(version) : Effect.fail(new Error("Not refreshed")),
          ),
          Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 20 }),
          Effect.orElseSucceed(() => 1),
        );
        expect(refreshed, JSON.stringify(yield* upstream.requests)).toBe(2);
        expect((yield* upstream.requests).length).toBeGreaterThan(loaded);
      }),
    ),
  );
});
