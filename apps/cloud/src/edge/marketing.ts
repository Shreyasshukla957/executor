// ---------------------------------------------------------------------------
// The `executor.sh` edge — decides which Worker answers a public request.
//
// On the production domain (`executor.sh`):
//  - marketing paths and the unauthenticated landing page go to the separate
//    `executor-marketing` worker;
//  - sign-up goes to v2 (a redirect to v2's sign-up page);
//  - a fixed list of exact v2 paths (sign-in issuer metadata, social sign-in
//    callbacks, the OAuth client metadata document, Git smart HTTP and the
//    agent skills index) is forwarded to v2's Worker over a service binding.
// v1 owns everything not listed. This module deliberately has no TanStack
// Start or cloud application imports: the Worker entry calls it before
// loading the Start server graph.
// ---------------------------------------------------------------------------

import { parseCookie } from "../auth/cookies";

const MARKETING_PATHS = [
  "/home",
  "/setup",
  "/privacy",
  "/terms",
  "/pricing",
  "/about-executor",
  "/google-oauth",
  "/google-workspace",
  "/blog",
  "/llms.txt",
  "/index.md",
  "/setup-prompt.md",
  "/pricing.md",
  "/api/detect",
  "/_astro",
  "/authors",
  "/og-image.png",
  "/pattern-graph-paper.svg",
];

const SESSION_COOKIE = "wos-session";

const PRODUCTION_HOST = "executor.sh";

/** Whether an exact pathname belongs to the public marketing worker. */
export const isMarketingPath = (pathname: string): boolean =>
  MARKETING_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

/**
 * Project a production request onto the marketing service-binding request.
 * Returns `null` when the cloud application owns the request instead.
 */
export const marketingProxyRequest = (request: Request): Request | null => {
  const url = new URL(request.url);
  if (url.hostname !== PRODUCTION_HOST) return null;

  const shouldProxy =
    isMarketingPath(url.pathname) ||
    (url.pathname === "/" && !parseCookie(request.headers.get("cookie"), SESSION_COOKIE));
  if (!shouldProxy) return null;

  if (url.pathname === "/home") url.pathname = "/";
  return new Request(url, request);
};

// ---------------------------------------------------------------------------
// v2 on `executor.sh`
// ---------------------------------------------------------------------------

const SIGN_UP_PATHS: ReadonlySet<string> = new Set(["/sign-up", "/signup"]);

/** Paths v2 answers on `executor.sh`, matched exactly. */
const V2_EXACT_PATHS: ReadonlySet<string> = new Set([
  // Sign-in issuer metadata for the issuer `https://executor.sh/api/auth`.
  "/.well-known/oauth-authorization-server/api/auth",
  "/api/auth/.well-known/openid-configuration",
  // Outbound OAuth client metadata document. v1's own document lives at
  // `/oauth/client-id-metadata.json`, which stays with v1.
  "/oauth/client-metadata.json",
]);

/** Path trees v2 answers on `executor.sh`. Each prefix ends in `/`, so
 *  `/gitlab/...` never matches `/git/`. */
const V2_PATH_PREFIXES: ReadonlyArray<string> = ["/git/", "/.well-known/agent-skills/"];

/** v2's social sign-in callback is `/api/auth/callback/<provider>`. v1's
 *  WorkOS callback is the bare `/api/auth/callback`, which stays with v1. */
const SOCIAL_CALLBACK_PREFIX = "/api/auth/callback/";

const isSocialCallbackPath = (pathname: string): boolean => {
  if (!pathname.startsWith(SOCIAL_CALLBACK_PREFIX)) return false;
  const provider = pathname.slice(SOCIAL_CALLBACK_PREFIX.length);
  return provider.length > 0 && !provider.includes("/");
};

/** Whether a pathname is a sign-up entry point that redirects to v2. */
export const isSignUpPath = (pathname: string): boolean => SIGN_UP_PATHS.has(pathname);

/** Whether `executor.sh` forwards a pathname to v2's Worker. */
export const isV2Path = (pathname: string): boolean =>
  V2_EXACT_PATHS.has(pathname) ||
  V2_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
  isSocialCallbackPath(pathname);

/** Request headers v1 never passes to v2. The cookie header carries v1's
 *  `wos-session` (v2's cookies are host-only on its own hosts, so nothing of
 *  v2's travels on `executor.sh`). Client-sent forwarding headers are dropped
 *  so v2 sees no host claim other than the request URL's. */
const V2_STRIPPED_HEADERS = ["cookie", "x-forwarded-host", "x-forwarded-proto"] as const;

/**
 * Project an `executor.sh` request onto the request sent to v2's Worker.
 *
 * Keeps the URL (so v2 sees host `executor.sh`, path and query unchanged),
 * method, body stream and every header except {@link V2_STRIPPED_HEADERS},
 * including `Authorization`. Redirects are returned to the client, not
 * followed: v2 answers callbacks with a redirect to its own host.
 */
export const v2ForwardRequest = (request: Request): Request => {
  const headers = new Headers(request.headers);
  for (const name of V2_STRIPPED_HEADERS) headers.delete(name);
  return new Request(request, { headers, redirect: "manual" });
};

/** The Worker that serves v2, reached over a service binding. */
export interface V2Service {
  readonly fetch: (request: Request) => Promise<Response>;
}

/** What the edge needs to hand requests to v2. */
export interface V2Edge {
  /** v2's Worker. */
  readonly service: V2Service;
  /** Absolute URL of v2's sign-up page (the `V2_SIGN_UP_URL` var). */
  readonly signUpUrl: URL;
}

/**
 * Parse the edge's v2 settings from the Worker environment. Returns `null`
 * when the binding or the sign-up URL is absent or the URL is not absolute,
 * so hosts without them (local dev, test workers) keep serving everything
 * from v1.
 */
export const parseV2Edge = (
  service: V2Service | undefined,
  signUpUrl: string | undefined,
): V2Edge | null => {
  if (service === undefined || signUpUrl === undefined) return null;
  const parsed = URL.parse(signUpUrl);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return null;
  }
  return { service, signUpUrl: parsed };
};

/**
 * Answer a production request that belongs to v2: redirect sign-up (`GET`,
 * any query) to v2's sign-up page, or forward a {@link isV2Path} request to
 * v2's Worker and return its response unchanged (status, headers and body
 * stream). Returns `null` when v1 owns the request.
 */
export const v2EdgeResponse = (request: Request, edge: V2Edge): Promise<Response> | null => {
  const url = new URL(request.url);
  if (url.hostname !== PRODUCTION_HOST) return null;

  if (isSignUpPath(url.pathname) && request.method === "GET") {
    return Promise.resolve(Response.redirect(edge.signUpUrl.href, 302));
  }
  if (isV2Path(url.pathname)) return edge.service.fetch(v2ForwardRequest(request));
  return null;
};
