// Cloud: an MCP SDK client whose plain-`/mcp` token has expired follows the
// 401's `resource_metadata` back to this product's authorization server.
//
// Executor v2 will serve `executor.sh/mcp`'s root discovery documents
// (`/.well-known/oauth-protected-resource/mcp`,
// `/.well-known/oauth-authorization-server`) while v1 still answers plain
// `/mcp` requests that carry a v1 token. So the challenge must name a v1-only
// document, and a spec-following client must never consult the root ones on
// the way to re-authorizing. Driven with the real @modelcontextprotocol/sdk
// client; the run stops where the SDK would open the browser.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { scenario } from "../src/scenario";
import { Target } from "../src/services";

const V1_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource/_v1/mcp";
const ROOT_DISCOVERY_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
];

const base64url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** A JWT shaped like an expired access token from `issuer`. The signature is
 *  junk: the server must reject it either way, and the router only reads `iss`. */
const expiredAccessToken = (issuer: string): string =>
  [
    base64url({ alg: "RS256", typ: "JWT" }),
    base64url({
      iss: issuer,
      sub: "user_e2e_expired",
      exp: Math.floor(Date.now() / 1000) - 3600,
    }),
    base64url("expired"),
  ].join(".");

type Hop = { readonly method: string; readonly url: string; readonly status: number };

scenario(
  "MCP protocol · an expired plain-/mcp token re-authorizes through the v1 discovery document",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const mcpUrl = new URL("/mcp", target.baseUrl);

    const bare = (yield* Effect.promise(async () =>
      (await fetch(new URL("/.well-known/oauth-protected-resource/mcp", target.baseUrl))).json(),
    )) as { readonly authorization_servers: ReadonlyArray<string> };
    const authorizationServer = bare.authorization_servers[0] ?? "";
    expect(authorizationServer, "the product advertises an authorization server").not.toBe("");

    const hops: Array<Hop> = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await fetch(request);
      hops.push({ method: request.method, url: request.url, status: response.status });
      return response;
    };

    let tokens: OAuthTokens | undefined = {
      access_token: expiredAccessToken(authorizationServer),
      token_type: "Bearer",
      refresh_token: "refresh_e2e_revoked",
    };
    let clientInformation: OAuthClientInformationMixed | undefined;
    let authorizationUrl: URL | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: "http://127.0.0.1:1/callback",
      clientMetadata: {
        client_name: "executor-e2e-expired-token",
        redirect_uris: ["http://127.0.0.1:1/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      clientInformation: () => clientInformation,
      saveClientInformation: (info) => {
        clientInformation = info;
      },
      tokens: () => tokens,
      saveTokens: (next) => {
        tokens = next;
      },
      invalidateCredentials: (scope) => {
        if (scope === "all" || scope === "tokens") tokens = undefined;
        if (scope === "all" || scope === "client") clientInformation = undefined;
      },
      redirectToAuthorization: (url) => {
        authorizationUrl = url;
      },
      saveCodeVerifier: () => undefined,
      codeVerifier: () => "",
    };

    const client = new Client({ name: "executor-e2e-expired-token", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      authProvider: provider,
      fetch: recordingFetch,
    });
    const connected = yield* Effect.promise(() =>
      client.connect(transport).then(
        () => "connected" as const,
        (error: unknown) => (error instanceof UnauthorizedError ? "unauthorized" : String(error)),
      ),
    );
    yield* Effect.promise(() => client.close());

    yield* Effect.annotateCurrentSpan({ "e2e.hops": JSON.stringify(hops) });
    expect(connected, "the expired token cannot connect; the client must re-authorize").toBe(
      "unauthorized",
    );

    const first = hops[0];
    expect(first?.url, "the client first calls plain /mcp with the expired token").toBe(
      mcpUrl.toString(),
    );
    expect(first?.status, "the expired token is challenged").toBe(401);

    const aliasUrl = new URL(V1_RESOURCE_METADATA_PATH, target.baseUrl).toString();
    expect(
      hops.some((hop) => hop.url === aliasUrl && hop.status === 200),
      "the client fetches the v1 discovery document the challenge named",
    ).toBe(true);
    for (const path of ROOT_DISCOVERY_PATHS) {
      const rootUrl = new URL(path, target.baseUrl).toString();
      expect(
        hops.some((hop) => hop.url === rootUrl),
        `the client never consults the root discovery document ${path}`,
      ).toBe(false);
    }

    const authServerOrigin = new URL(authorizationServer).origin;
    expect(
      hops.some(
        (hop) =>
          hop.url.startsWith(`${authServerOrigin}/.well-known/oauth-authorization-server`) &&
          hop.status === 200,
      ),
      "the client reads the advertised authorization server's metadata",
    ).toBe(true);
    const tokenEndpoint = (yield* Effect.promise(async () =>
      (await fetch(new URL("/.well-known/oauth-authorization-server", authorizationServer))).json(),
    )) as { readonly token_endpoint: string };
    expect(
      hops.some((hop) => hop.method === "POST" && hop.url === tokenEndpoint.token_endpoint),
      "the client tries its refresh token at the advertised authorization server",
    ).toBe(true);
    expect(
      authorizationUrl?.origin,
      "the browser sign-in opens on the advertised authorization server",
    ).toBe(authServerOrigin);
    expect(
      authorizationUrl?.searchParams.get("resource"),
      "the sign-in asks for the plain MCP resource",
    ).toBe(mcpUrl.toString());
  }),
);
