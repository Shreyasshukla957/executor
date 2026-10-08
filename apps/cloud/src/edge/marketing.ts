// ---------------------------------------------------------------------------
// The `executor.sh` edge — decides which Worker answers a public request.
//
// On the production domain (`executor.sh`):
//  - marketing paths and the unauthenticated landing page go to the separate
//    `executor-marketing` worker;
//  - sign-up goes to v2 (a redirect to v2's sign-up page);
//  - a fixed list of v2 paths (sign-in issuer metadata, social sign-in
//    callbacks, Git smart HTTP and the agent skills index) is forwarded to
//    v2's Worker over a service binding;
//  - so is a connected-account OAuth callback whose `state` carries v2's
//    prefix.
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

/** A path pattern is an exact path, or `/x/*`, which matches every path
 *  that starts with `/x/` (and not `/x` itself). */
const matchesPathPattern = (pathname: string, pattern: string): boolean =>
  pattern.endsWith("/*") ? pathname.startsWith(pattern.slice(0, -1)) : pathname === pattern;

/** Path patterns v2 answers on `executor.sh`. `/git/*` never matches
 *  `/gitlab/...`. v2's outbound OAuth client metadata document stays off this
 *  list: its move to `executor.sh` is pending, and v1's own document
 *  (`/oauth/client-id-metadata.json`) stays with v1. */
const V2_PATHS: ReadonlyArray<string> = [
  // Sign-in issuer metadata for the issuer `https://executor.sh/api/auth`.
  "/.well-known/oauth-authorization-server/api/auth",
  "/git/*",
  "/.well-known/agent-skills/*",
];

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
  V2_PATHS.some((pattern) => matchesPathPattern(pathname, pattern)) ||
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

/** v1's connected-account OAuth callback. v2 shares it on `executor.sh`:
 *  a callback whose `state` starts with v2's prefix belongs to v2. */
const OAUTH_CALLBACK_PATH = "/api/oauth/callback";

/** A state prefix is URL-safe as is (so the query value carries it
 *  unencoded) and includes a character outside base64url. v1's states are
 *  base64url, so no v1 state can start with such a prefix. */
const OAUTH_STATE_PREFIX_PATTERN = /^[A-Za-z0-9._~-]*[.~][A-Za-z0-9._~-]*$/;

/** The edge's raw v2 settings, as the Worker environment holds them. */
export interface V2EdgeEnv {
  /** Service binding to v2's Worker. */
  readonly V2?: V2Service;
  /** Absolute URL of v2's sign-up page. */
  readonly V2_SIGN_UP_URL?: string;
  /** The prefix v2 puts on every connected-account OAuth `state`. */
  readonly V2_OAUTH_STATE_PREFIX?: string;
}

/** What the edge needs to hand requests to v2. */
export interface V2Edge {
  /** v2's Worker. */
  readonly service: V2Service;
  /** Absolute URL of v2's sign-up page (the `V2_SIGN_UP_URL` var). */
  readonly signUpUrl: URL;
  /** v2's connected-account OAuth state prefix (the `V2_OAUTH_STATE_PREFIX` var). */
  readonly oauthStatePrefix: string;
}

/**
 * Parse the edge's v2 settings from the Worker environment. Returns `null`
 * when none is set (local dev, test workers), so v1 serves everything, and
 * the reason as a string when the deployment is broken: only some of them
 * set, a sign-up URL that is not absolute, or a state prefix that could
 * match a v1 state.
 */
export const parseV2Edge = (env: V2EdgeEnv): V2Edge | string | null => {
  const service = env.V2;
  const signUpUrl = env.V2_SIGN_UP_URL;
  const oauthStatePrefix = env.V2_OAUTH_STATE_PREFIX;
  if (service === undefined && signUpUrl === undefined && oauthStatePrefix === undefined) {
    return null;
  }
  if (service === undefined || signUpUrl === undefined || oauthStatePrefix === undefined) {
    return "The V2 binding, V2_SIGN_UP_URL and V2_OAUTH_STATE_PREFIX must be set together";
  }
  const parsed = URL.parse(signUpUrl);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return "V2_SIGN_UP_URL must be an absolute http(s) URL";
  }
  if (!OAUTH_STATE_PREFIX_PATTERN.test(oauthStatePrefix)) {
    return "V2_OAUTH_STATE_PREFIX must be URL-safe and contain '.' or '~'";
  }
  return { service, signUpUrl: parsed, oauthStatePrefix };
};

/** Whether a connected-account callback carries v2's state prefix. Reads the
 *  query only: a callback without `state` in its query stays with v1. */
const isV2OAuthCallback = (url: URL, prefix: string): boolean =>
  url.searchParams.get("state")?.startsWith(prefix) === true;

/**
 * Answer a production request that belongs to v2: redirect sign-up (`GET`,
 * any query) to v2's sign-up page, or forward a {@link isV2Path} request, or
 * a connected-account callback whose `state` starts with v2's prefix, to
 * v2's Worker and return its response unchanged (status, headers and body
 * stream). Returns `null` when v1 owns the request.
 *
 * Broken settings answer the requests the edge owns with a 500 and leave the
 * rest of v1 serving. The callback is the exception: which callbacks are v2's
 * depends on the settings, so v1 keeps every callback until they parse.
 */
export const v2EdgeResponse = (request: Request, env: V2EdgeEnv): Promise<Response> | null => {
  const url = new URL(request.url);
  if (url.hostname !== PRODUCTION_HOST) return null;

  const signUp = isSignUpPath(url.pathname) && request.method === "GET";
  const callback = url.pathname === OAUTH_CALLBACK_PATH;
  if (!signUp && !callback && !isV2Path(url.pathname)) return null;
  const edge = parseV2Edge(env);
  if (edge === null) return null;
  if (typeof edge === "string") {
    console.error(`executor.sh v2 edge misconfigured: ${edge}`);
    if (callback) return null;
    return Promise.resolve(new Response("Service misconfigured", { status: 500 }));
  }
  if (signUp) return Promise.resolve(Response.redirect(edge.signUpUrl.href, 302));
  if (callback && !isV2OAuthCallback(url, edge.oauthStatePrefix)) return null;
  return edge.service.fetch(v2ForwardRequest(request));
};
