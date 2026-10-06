import { httpProviderError, accountProviderError, providerErrorDetail } from "./provider-error.ts";
import { ProviderError } from "../contracts/provider-error.ts";
import type { UpstreamError } from "../contracts/failure.ts";
import { bodyUpstreamError } from "./upstream-error.ts";
/** Official MCP transports at an Effect boundary. Connections belong to one operation. */
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ErrorCode,
  McpError as ProtocolError,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { captureTelemetry } from "@executor-js/telemetry";
import { Deferred, Effect, Option, Redacted, Ref, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";
import {
  defaultMcpClientLimits,
  McpError,
  McpToolsOptions,
  type McpConnection,
} from "../contracts/mcp.ts";
import { adaptMcpTools } from "./mcp-tools.ts";
import { answeredError, mcpClient, mcpJsonSchemaValidator } from "./mcp-client.ts";

/** Safe projection of transport errors. Raw messages can contain credential-bearing URLs. */
const failure = (phase: McpError["phase"], error: unknown): McpError | ProviderError => {
  if (Schema.is(ProviderError)(error) || Schema.is(McpError)(error)) return error;
  const status =
    error instanceof UnauthorizedError
      ? 401
      : error instanceof StreamableHTTPError || error instanceof SseError
        ? error.code
        : undefined;
  const provider = status === undefined ? undefined : httpProviderError(status);
  if (provider !== undefined) return provider;
  const upstream = answeredError(error);
  return new McpError({
    phase,
    reason:
      error instanceof ProtocolError && error.code === ErrorCode.RequestTimeout
        ? "timeout"
        : "request",
    ...(status === undefined ? {} : { status }),
    ...(upstream === undefined ? {} : { upstream }),
  });
};

/** The latest error response of a session, and the error its JSON body stated, if any. */
interface ErrorResponse {
  readonly status: number;
  readonly upstream: UpstreamError | undefined;
}

/** Error bodies are small: read at most this much, for at most this long. */
const errorBodyLimits = { maxBytes: 65_536, readTimeoutMs: 2_000 } as const;

/**
 * A bounded copy of a JSON error body, so the error it states can be reported and the SDK still
 * reads the same body. Other bodies are left unread; an unreadable one becomes empty.
 */
const errorBody = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const json = /^application\/(?:[\w.-]+\+)?json$/i.test(
      response.headers["content-type"]?.split(";")[0]?.trim() ?? "",
    );
    const length = response.headers["content-length"];
    if (!json || (length !== undefined && Number(length) > errorBodyLimits.maxBytes))
      return { body: Stream.toReadableStream(response.stream), upstream: undefined };
    // An unreadable, oversized or stalled body states nothing; the refusal keeps its status.
    const unreadable = new McpError({ phase: "transport", reason: "invalid_response" });
    const read = yield* response.stream.pipe(
      Stream.mapError(() => unreadable),
      Stream.limitBytes(errorBodyLimits.maxBytes, () => Stream.fail(unreadable)),
      Stream.decodeText,
      Stream.mkString,
      Effect.timeout(errorBodyLimits.readTimeoutMs),
      Effect.option,
    );
    if (Option.isNone(read)) return { body: null, upstream: undefined };
    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(read.value);
    return {
      body: read.value,
      upstream: Option.isSome(parsed) ? bodyUpstreamError(parsed.value) : undefined,
    };
  });

// The library consumes Web Responses; Effect owns requests and streaming bodies.
// Retain the transport abort signal after response headers arrive.
const transportFetch =
  (
    connection: McpConnection,
    telemetry: Effect.Success<typeof captureTelemetry>,
    rejected: Deferred.Deferred<never, ProviderError>,
    answered: Ref.Ref<ErrorResponse | undefined>,
  ): FetchLike =>
  (url, init) =>
    Effect.runPromiseWith(telemetry.context)(
      Effect.gen(function* () {
        // Executor's own refusals name the setting or server response at fault, never a network failure.
        const target = yield* Effect.try({
          try: () => new URL(url),
          catch: () => new McpError({ phase: "transport", reason: "invalid_response" }),
        });
        if (connection.url.username || connection.url.password)
          return yield* new McpError({ phase: "transport", reason: "invalid_input" });
        // The server directed the client to another origin or embedded credentials in a URL.
        if (target.origin !== connection.url.origin || target.username || target.password)
          return yield* new McpError({ phase: "transport", reason: "invalid_response" });
        const headers = new Headers(Redacted.value(connection.headers));
        new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
        const request = yield* Effect.try({
          try: () => HttpClientRequest.fromWeb(new Request(target, { ...init, headers })),
          catch: () => failure("transport", undefined),
        });
        const client = yield* HttpClient.HttpClient;
        const response = yield* client.execute(request);
        if (response.status < 400)
          return new Response(
            [204, 205, 304].includes(response.status)
              ? null
              : Stream.toReadableStream(response.stream),
            {
              status: response.status,
              headers: response.headers,
            },
          );
        const { body, upstream } = yield* errorBody(response);
        const provider = httpProviderError(response.status, response.headers);
        if (provider !== undefined) {
          // EventSource replaces rejected fetch errors. Retain our safe failure
          // within this session so SSE cannot erase its status or reason.
          const refused = providerErrorDetail(provider, { upstream });
          yield* Deferred.fail(rejected, refused);
          return yield* refused;
        }
        // The SDK reports only the status of a refused request; keep the error the body stated.
        yield* Ref.set(answered, { status: response.status, upstream });
        return new Response(body, { status: response.status, headers: response.headers });
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.provideService(FetchHttpClient.Fetch, (url, options) =>
          globalThis.fetch(url, {
            ...options,
            signal: AbortSignal.any([
              ...(options?.signal ? [options.signal] : []),
              ...(init?.signal ? [init.signal] : []),
            ]),
          }),
        ),
        Effect.mapError((error) => failure("transport", error)),
      ),
      init?.signal ? { signal: init.signal } : {},
    );

/**
 * Name the phase a provider failure happened in, and give a refused request the error its
 * response stated. Session setup is `connect`; the operation itself is the session's mode.
 */
const explain = <E>(
  error: E,
  phase: "connect" | "discover" | "call",
  response: ErrorResponse | undefined,
) => {
  if (Schema.is(ProviderError)(error)) return providerErrorDetail(error, { phase });
  if (
    !Schema.is(McpError)(error) ||
    error.upstream !== undefined ||
    error.status === undefined ||
    response?.status !== error.status ||
    response.upstream === undefined
  )
    return error;
  return new McpError({
    phase: error.phase,
    reason: error.reason,
    status: error.status,
    upstream: response.upstream,
  });
};

/** Fail with the explained error, reading the session's latest error response. */
const explained =
  (phase: "connect" | "discover" | "call", answered: Ref.Ref<ErrorResponse | undefined>) =>
  <E>(error: E) =>
    Ref.get(answered).pipe(
      Effect.flatMap((response) => Effect.fail(explain(error, phase, response))),
    );

function withClient<A, E>(
  connection: McpConnection,
  mode: "discover" | "call",
  use: (client: Client) => Effect.Effect<A, E>,
  changed?: Effect.Effect<void, unknown>,
) {
  const attempt = (kind: "http" | "sse") =>
    Effect.scoped(
      Effect.gen(function* () {
        const telemetry = yield* captureTelemetry;
        const rejected = yield* Deferred.make<never, ProviderError>();
        const answered = yield* Ref.make<ErrorResponse | undefined>(undefined);
        const pending = new Set<Promise<void>>();
        const { client, transport } = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const fetch = transportFetch(connection, telemetry, rejected, answered);
            const client = new Client(
              { name: "executor-apps", version: "0.1.0" },
              {
                jsonSchemaValidator: mcpJsonSchemaValidator,
                capabilities: mode === "call" ? { elicitation: { form: {} } } : {},
              },
            );
            if (changed !== undefined) {
              client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
                const task = Effect.runPromiseWith(telemetry.context)(
                  changed.pipe(
                    Effect.timeout("5 seconds"),
                    Effect.catchCause(() => Effect.logWarning("MCP catalog invalidation failed")),
                  ),
                );
                pending.add(task);
                return task.finally(() => pending.delete(task));
              });
            }
            return {
              client,
              transport:
                kind === "http"
                  ? new StreamableHTTPClientTransport(connection.url, {
                      fetch,
                      reconnectionOptions: {
                        maxRetries: 0,
                        initialReconnectionDelay: 1_000,
                        maxReconnectionDelay: 1_000,
                        reconnectionDelayGrowFactor: 1,
                      },
                    })
                  : new SSEClientTransport(connection.url, { fetch }),
            };
          }),
          ({ client, transport }) =>
            Effect.gen(function* () {
              client.removeNotificationHandler("notifications/tools/list_changed");
              yield* Effect.promise(async () => {
                await Promise.allSettled(pending);
              });
              if (
                transport instanceof StreamableHTTPClientTransport &&
                transport.sessionId !== undefined
              ) {
                yield* Effect.tryPromise(() => transport.terminateSession()).pipe(
                  Effect.timeout(defaultMcpClientLimits.cleanupTimeoutMs),
                  Effect.ignore,
                );
              }
              yield* Effect.tryPromise(() => client.close()).pipe(
                Effect.timeout(defaultMcpClientLimits.cleanupTimeoutMs),
                Effect.ignore,
              );
            }).pipe(Effect.withSpan("provider.mcp.close")),
        );
        // Hide the SDK getter that conflicts with its own exact-optional Transport type.
        const wire: Omit<StreamableHTTPClientTransport, "sessionId"> | SSEClientTransport =
          transport;
        yield* Effect.tryPromise({
          try: (signal) => client.connect(wire, { signal, timeout: connection.timeoutMs }),
          catch: (error) => failure("connect", error),
        }).pipe(
          Effect.raceFirst(Deferred.await(rejected)),
          Effect.catch(explained("connect", answered)),
          Effect.timeout(connection.timeoutMs),
          Effect.withSpan("provider.mcp.connect"),
        );
        return yield* use(client).pipe(
          Effect.raceFirst(Deferred.await(rejected)),
          Effect.catch(explained(mode, answered)),
        );
      }),
    ).pipe(
      Effect.withSpan("provider.mcp.session", {
        attributes: {
          "mcp.transport": kind,
          "mcp.operation": mode,
          "server.address": connection.url.hostname,
        },
      }),
    );
  return attempt("http").pipe(
    // Fallback is only for negotiation. Tool calls are never automatically replayed.
    Effect.catch((error) =>
      Schema.is(McpError)(error) &&
      error.phase === "connect" &&
      (error.status === 404 || error.status === 405)
        ? attempt("sse")
        : Effect.fail(error),
    ),
    (operation) =>
      mode === "discover" ? operation.pipe(Effect.timeout(connection.timeoutMs)) : operation,
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new McpError({ phase: "transport", reason: "timeout" })),
    ),
  );
}

/** Discover and call with a fresh selected-account transport for each operation. */
export const mcpClientEffect = (input: McpToolsOptions, changed?: Effect.Effect<void, unknown>) =>
  Effect.gen(function* () {
    const options = yield* Schema.decodeUnknownEffect(McpToolsOptions)(input).pipe(
      Effect.mapError(() => new McpError({ phase: "connect", reason: "invalid_input" })),
    );
    const url = new URL(options.url);
    if (url.username || url.password || url.hash)
      return yield* new McpError({ phase: "connect", reason: "invalid_input" });
    const connection: McpConnection = {
      url,
      headers: Redacted.make({ ...options.headers }),
      timeoutMs: options.timeoutMs ?? defaultMcpClientLimits.timeoutMs,
    };
    return mcpClient(
      (mode, use) =>
        withClient(connection, mode, use, changed).pipe(
          Effect.mapError((error) =>
            options.accountId === undefined
              ? error
              : accountProviderError(error, options.accountId),
          ),
        ),
      connection.timeoutMs,
      failure,
    );
  });

/** Discover and compile all tools for connection probes and low-level consumers. */
export const mcpToolsEffect = (input: McpToolsOptions) =>
  mcpClientEffect(input).pipe(Effect.flatMap(adaptMcpTools));
