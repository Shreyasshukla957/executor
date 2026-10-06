/** The public app catalog reads a configured remote registry and reports each failure distinctly. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Api, body, SessionClients } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { startFreshSelfHost } from "../support/managed-server.ts";
import { Target } from "../support/platform.ts";
import {
  registryFixtureNames,
  registryPublication,
  registryUpstream,
} from "../support/registry-upstream.ts";
import { scenarios } from "../test-plan.ts";

const Organizations = Schema.NonEmptyArray(Schema.Struct({ id: Schema.String }));

layer(TestLive, { excludeTestServices: true })("Remote registry failures", (it) => {
  it.effect(scenarios.remoteRegistryFailures.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target;
        const registry = yield* registryUpstream;
        const origin = yield* startFreshSelfHost(target, {
          EXECUTOR_REGISTRY_URL: registry.origin,
        });
        const api = yield* Api.pipe(
          Effect.provide(Layer.fresh(Api.layer)),
          Effect.provide(Layer.fresh(SessionClients.layer)),
          Effect.provideService(Target, { ...target, metadata: { ...target.metadata, origin } }),
        );
        const owner = yield* api.session();
        expect(
          (yield* api.request(owner, "POST", "/api/auth/self-host/setup", {
            name: "Registry Owner",
            email: "registry-owner@example.test",
            password: "Synthetic-registry-password-123!",
            organizationName: "Registry lab",
          })).status,
        ).toBe(200);
        const [organization] = yield* body(
          Organizations,
          yield* api.request(owner, "GET", "/api/auth/organization/list"),
        );
        const catalog = (name?: string) =>
          api.request(
            owner,
            "GET",
            `/api/organizations/${organization.id}/app-publications${name === undefined ? "" : `?name=${encodeURIComponent(name)}`}`,
          );
        const failure = (name: string) =>
          catalog(name).pipe(
            Effect.tap((response) =>
              Effect.sync(() =>
                expect(response.status, `${name}: ${JSON.stringify(response.body)}`).toBe(400),
              ),
            ),
            Effect.flatMap((response) =>
              body(
                Schema.Struct({
                  _tag: Schema.Literal("RegistryError"),
                  reason: Schema.String,
                  status: Schema.optional(Schema.Number),
                }),
                response,
              ),
            ),
          );

        const listed = yield* catalog();
        expect(listed.status).toBe(200);
        expect(listed.body).toEqual([registryPublication]);
        expect(yield* failure(registryFixtureNames.redirect), "redirects are not followed").toEqual(
          { _tag: "RegistryError", reason: "status", status: 302 },
        );
        expect(yield* failure(registryFixtureNames.unavailable)).toEqual({
          _tag: "RegistryError",
          reason: "status",
          status: 503,
        });
        expect(yield* failure(registryFixtureNames.garbled)).toEqual({
          _tag: "RegistryError",
          reason: "invalid-response",
        });
        expect(
          yield* failure(registryFixtureNames.missing),
          "registry errors pass through",
        ).toEqual({ _tag: "RegistryError", reason: "not-found" });
        const paths = yield* registry.paths;
        expect(paths, "every read reached the configured registry").toEqual(
          [undefined, ...Object.values(registryFixtureNames)].map(
            (name) =>
              `/api/registry/apps${name === undefined ? "" : `?name=${encodeURIComponent(name)}`}`,
          ),
        );
        yield* registry.close;
        expect(yield* failure(registryPublication.name), "an unreachable registry").toEqual({
          _tag: "RegistryError",
          reason: "network",
        });
      }),
    ),
  );
});
