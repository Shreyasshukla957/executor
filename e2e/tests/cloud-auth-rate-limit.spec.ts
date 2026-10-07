/**
 * Managed Cloud and deployed test stages turn Better Auth's per-address limit off, because every
 * scenario's request comes from one address. This scenario runs alone on a local Cloud started
 * with the limit on (`e2e:cloud --auth-rate-limit`), so its requests are the only ones counted.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { scenarios } from "../test-plan.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";

/** Seconds named by Better Auth's X-Retry-After header, within the limit's window. */
const retryAfter = (window: number) =>
  Schema.decodeUnknownEffect(
    Schema.NumberFromString.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(window)),
  );

layer(TestLive, { excludeTestServices: true })("Cloud auth rate limit", (it) => {
  it.effect(scenarios.cloudAuthRateLimit.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          http = yield* HttpClient.HttpClient;
        const origin = target.metadata.origin;
        const post = (path: string, data: unknown) =>
          Effect.scoped(
            Effect.gen(function* () {
              const request = yield* HttpClientRequest.post(`${origin}${path}`).pipe(
                HttpClientRequest.setHeaders({ origin }),
                HttpClientRequest.bodyJson(data),
              );
              const response = yield* http.execute(request);
              yield* response.text;
              return { status: response.status, retryAfter: response.headers["x-retry-after"] };
            }),
          ).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
        const register = post("/api/auth/oauth2/register", {
          client_name: "Rate limit client",
          redirect_uris: ["http://127.0.0.1:9/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
        const signIn = post("/api/auth/sign-in/social", {
          provider: "github",
          callbackURL: "/login",
          errorCallbackURL: "/login",
        });

        // Anonymous client registration allows five requests a minute from one address.
        const registrations = yield* Effect.forEach(Array.from({ length: 6 }), () => register, {
          concurrency: 1,
        });
        expect(registrations.map((response) => response.status)).toEqual([
          201, 201, 201, 201, 201, 429,
        ]);
        yield* retryAfter(60)(registrations[5]!.retryAfter);

        // Sign-in allows three requests in ten seconds, counted apart from registration.
        const signIns = yield* Effect.forEach(Array.from({ length: 4 }), () => signIn, {
          concurrency: 1,
        });
        expect(signIns.map((response) => response.status)).toEqual([200, 200, 200, 429]);
        const wait = yield* retryAfter(10)(signIns[3]!.retryAfter);
        // The named time is when the address may sign in again.
        yield* Effect.sleep(`${wait} seconds`);
        expect((yield* signIn).status).toBe(200);
      }),
    ),
  );
});
