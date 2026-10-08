import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { accountToolSource } from "../support/tool-account-context.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Index = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });

layer(HostedLive, { excludeTestServices: true })("Cloud build reuse", (it) => {
  it.effect(scenarios.cloudBuildReuse.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          telemetry = yield* Telemetry,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Build reuse ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: accountToolSource }, appsManifest],
        });
        expect(deployed.status).toBe(200);
        // The deploy writes its retained build to this data centre's Cache API in the background.
        const deployRequest = (yield* evidence.requests).at(-1);
        if (deployRequest === undefined)
          return yield* Effect.die("Deploy request evidence missing");
        const warmed = yield* telemetry.query(deployRequest.traceId).pipe(
          Effect.flatMap((result) => {
            // The record is always written; the framework only when the isolate did not hold it.
            const write = result.data.find(
              ({ span }) =>
                span.operationName === "runtime.cloud.build.cache_write" &&
                span.tags["executor.build.cache_part"] === "record",
            );
            return write === undefined
              ? Effect.fail(new Error("The deploy's build cache write has not been delivered"))
              : Effect.succeed({ result, write });
          }),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
        );
        yield* evidence.json("deploy.json", warmed.result);
        expect(warmed.write.span.tags["executor.build.cache_write"]).toBe("stored");
        for (const { span } of warmed.result.data)
          if (span.operationName === "runtime.cloud.build.cache_write")
            expect(
              span.tags["executor.build.cache_write"],
              span.tags["executor.build.cache_part"],
            ).toBe("stored");
        const app = yield* body(App, deployed);
        const profile = yield* createProfile(actors.owner, `${prefix}/apps/${app.id}`);
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
            for (const account of accounts)
              yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        const add = (label: string, token: string) =>
          Effect.gen(function* () {
            const connection = yield* body(
              Resource,
              yield* api.request(actors.owner, "POST", `${prefix}/apps/${app.id}/connections`, {
                requirement: "workspaces",
                profile: profile.id,
              }),
            );
            const account = yield* body(
              Resource,
              yield* api.request(
                actors.owner,
                "POST",
                `${prefix}/connections/${connection.id}/submit`,
                {
                  method: "key",
                  label,
                  fields: { token },
                },
              ),
            );
            accounts.push(account.id);
            return account.id;
          });
        const work = yield* add("Work", "work"),
          personal = yield* add("Personal", "personal");

        // Each account selection is a separate Worker identity, so each index starts a cold
        // Worker for the same immutable build. The runner in the AppData Worker reads the build
        // itself: the API that sends the call never loads, decodes or transfers app code.
        const coldIndex = (account: string, tool: string) =>
          Effect.gen(function* () {
            const selected = yield* selectProfileAccounts(
              actors.owner,
              `${prefix}/apps/${app.id}`,
              profile.id,
              { workspaces: [account] },
            );
            expect(selected.status).toBe(200);
            const traceId = randomUUID().replaceAll("-", "");
            const response = yield* actors.owner.send(
              "GET",
              `${prefix}/apps/${app.id}/tools/index?profile=${profile.id}`,
              undefined,
              { traceparent: `00-${traceId}-1234567890abcdef-01` },
            );
            expect(response.status).toBe(200);
            const index = yield* body(Index, response);
            expect(index.items.map((item) => item.name)).toContain(tool);
            const trace = yield* telemetry.query(traceId).pipe(
              Effect.flatMap((result) =>
                result.data.some(({ span }) => span.operationName === "runtime.cloud.build.cached")
                  ? Effect.succeed(result)
                  : Effect.fail(new Error("The cold Worker's build load has not been delivered")),
              ),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
            );
            yield* evidence.json(`cold-index-${tool}.json`, trace);
            const loads = trace.data.filter(
              ({ span }) => span.operationName === "runtime.cloud.build.cached",
            );
            expect(loads, "One cold Worker start loads its build once").toHaveLength(1);
            const spans = new Map(trace.data.map(({ span }) => [span.spanId, span]));
            const ancestors: string[] = [];
            for (
              let parent = loads[0]?.span.parentSpanId;
              parent !== undefined && parent !== null;
              parent = spans.get(parent)?.parentSpanId
            )
              ancestors.push(spans.get(parent)?.operationName ?? "[missing]");
            expect(ancestors, "The runner, not the calling Worker, reads the build").toContain(
              "runtime.app.serve",
            );
            return {
              source: loads[0]?.span.tags["executor.build.cache"],
              framework: loads[0]?.span.tags["executor.build.framework_cache"],
              blobReads: trace.data.filter(({ span }) => span.operationName === "storage.blob.get")
                .length,
            };
          });

        const first = yield* coldIndex(work, "work");
        expect(first.source, "The runner reads the record the deploy cached").toBe("hit");
        // The framework is stored apart from the record. The deploy cached it unless the cache
        // already held it; the runner may also hold it decoded from an earlier build, or be
        // decoding it for another app on this apps release, whose read this one waits for.
        expect(["hit", "memory", "shared"], "The runner reads a cached framework").toContain(
          first.framework,
        );
        expect(first.blobReads, "A freshly deployed build is not read from R2").toBe(0);
        const second = yield* coldIndex(personal, "personal");
        expect(second.source, "The runner reuses the build it already decoded").toBe("memory");
        expect(second.blobReads, "A reused build is not read from R2 again").toBe(0);
      }),
    ),
  );
});
