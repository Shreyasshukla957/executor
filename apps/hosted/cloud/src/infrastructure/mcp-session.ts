/** One MCP session object: its protocol servers, held connections and request handling. */
import {
  CurrentUserId,
  type McpAuthentication,
  authenticatedMcp,
  browserMcpRequest,
  hostedMcpApproval,
  dispatchHostedMcp,
  makeHostedMcp,
} from "@executor-js/hosted-server";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, type Layer } from "effect";
import { HttpServer, HttpServerRequest } from "effect/unstable/http";
import { cloudSentry } from "../implementation/error-reporting.ts";
import { observeMcpStream } from "../implementation/mcp-stream-observability.ts";
import { cloudAnalytics } from "../implementation/product-analytics.ts";
import type { cloudProduct } from "./product.ts";
import { cloudObjectDatabase, ObjectDatabase } from "./object-database.ts";

/**
 * The isolate's executor and MCP identity, built once and shared by every session object in
 * it. Both use the calling object's held database connections.
 */
export interface McpSessionServices {
  readonly executor: Effect.Success<ReturnType<typeof cloudProduct>>;
  readonly identity: Layer.Layer<McpAuthentication>;
}

export const makeMcpSession = Effect.fn(function* ({ executor, identity }: McpSessionServices) {
  const reportErrors = yield* cloudSentry;
  const analytics = yield* cloudAnalytics;
  const objectDatabase = yield* cloudObjectDatabase;
  return Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    // Every request and MCP operation of this session shares the object's connections.
    const database = yield* objectDatabase(`mcp ${state.id.toString()}`);
    // Opaque object identity is stable across activations; the random activation
    // identifies a fresh in-memory MCP registry without recording session tokens.
    const activation = yield* Effect.sync(() => crypto.randomUUID());
    const handler = yield* makeHostedMcp().pipe(Effect.provide(HttpServer.layerServices));
    const browser = browserMcpRequest((access, address) =>
      hostedMcpApproval(handler.approvals, access, address).pipe(
        Effect.provideService(CurrentUserId, access.userId),
      ),
    ).pipe(
      Effect.provide(executor),
      Effect.provide(identity),
      Effect.provide(HttpServer.layerServices),
    );
    const http = authenticatedMcp((access, address) =>
      dispatchHostedMcp(access, address, handler.http).pipe(
        Effect.provideService(CurrentUserId, access.userId),
      ),
    ).pipe(
      Effect.provide(executor),
      Effect.provide(identity),
      Effect.provide(HttpServer.layerServices),
    );
    return {
      fetch: Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        new URL(request.url, "https://mcp.internal").pathname.startsWith("/api/mcp/approvals/")
          ? browser
          : http,
      ).pipe(
        Effect.flatMap(observeMcpStream("session")),
        Effect.tap((response) =>
          Effect.annotateCurrentSpan("http.response.status_code", response.status),
        ),
        Effect.withSpan("mcp.session.request", {
          attributes: {
            "executor.mcp.object_id": state.id.toString(),
            "executor.mcp.activation_id": activation,
          },
        }),
        analytics.wrap,
        reportErrors,
        Effect.provideService(ObjectDatabase, database),
      ),
    };
  });
});

/** What the gateway binds on a session object. */
export type McpSessionObject = Effect.Success<Effect.Success<ReturnType<typeof makeMcpSession>>>;
