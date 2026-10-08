import { describe, expect, it } from "@effect/vitest";

import {
  isMarketingPath,
  isSignUpPath,
  isV2Path,
  marketingProxyRequest,
  parseV2Edge,
  v2EdgeResponse,
  type V2Edge,
  type V2Service,
} from "./marketing";

// On executor.sh the marketing middleware proxies an allow-list of paths to the
// `executor-marketing` worker; everything else falls through to the auth-gated
// cloud app (the sign-in page). `/blog` and `/llms.txt` are public content, so
// they must be on the allow-list: without it an unauthenticated visit redirects
// to `/login?returnTo=...` and the reader bounces.
describe("isMarketingPath", () => {
  const marketing = [
    "/home",
    "/privacy",
    "/terms",
    "/pricing",
    "/about-executor",
    "/google-oauth",
    "/google-workspace",
    "/blog",
    "/blog/",
    "/blog/some-post",
    "/llms.txt",
    "/index.md",
    "/setup-prompt.md",
    "/pricing.md",
    "/og-image.png",
    "/_astro/app.css",
    // The blog author card loads its avatar from marketing's public/authors;
    // without this the pfp 404s on every post.
    "/authors/rhys-sullivan.png",
  ];
  for (const pathname of marketing) {
    it(`proxies ${pathname} to marketing`, () => {
      expect(isMarketingPath(pathname)).toBe(true);
    });
  }

  // App-owned routes must reach the Effect handler, not marketing. `/blogger`
  // guards against a bare `startsWith("/blog")` swallowing unrelated words.
  const notMarketing = ["/", "/login", "/cloud", "/mcp", "/dashboard", "/blogger"];
  for (const pathname of notMarketing) {
    it(`leaves ${pathname} alone`, () => {
      expect(isMarketingPath(pathname)).toBe(false);
    });
  }
});

describe("marketingProxyRequest", () => {
  it("routes a signed-out homepage request", () => {
    const request = new Request("https://executor.sh/?source=test");

    const proxied = marketingProxyRequest(request);

    expect(proxied?.url).toBe("https://executor.sh/?source=test");
  });

  it("leaves the signed-in homepage with the cloud application", () => {
    const request = new Request("https://executor.sh/", {
      headers: { cookie: "other=value; wos-session=sealed" },
    });

    expect(marketingProxyRequest(request)).toBeNull();
  });

  it("routes public content even when a session cookie is present", () => {
    const request = new Request("https://executor.sh/blog/post", {
      headers: { cookie: "wos-session=sealed" },
    });

    expect(marketingProxyRequest(request)?.url).toBe("https://executor.sh/blog/post");
  });

  it("routes /pricing to the marketing worker", () => {
    const request = new Request("https://executor.sh/pricing");

    expect(marketingProxyRequest(request)?.url).toBe("https://executor.sh/pricing");
  });

  it("rewrites the public home alias to the marketing root", () => {
    const request = new Request("https://executor.sh/home?source=test");

    expect(marketingProxyRequest(request)?.url).toBe("https://executor.sh/?source=test");
  });

  it("preserves the request method, headers, and body", async () => {
    const request = new Request("https://executor.sh/_astro/_ph/capture", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "request-1" },
      body: JSON.stringify({ event: "test" }),
    });

    const proxied = marketingProxyRequest(request);

    expect(proxied?.method).toBe("POST");
    expect(proxied?.headers.get("x-request-id")).toBe("request-1");
    await expect(proxied?.json()).resolves.toEqual({ event: "test" });
  });

  it("does not proxy non-production hosts or app-owned paths", () => {
    expect(marketingProxyRequest(new Request("http://executor-cloud.localhost/"))).toBeNull();
    expect(marketingProxyRequest(new Request("https://executor.sh/login"))).toBeNull();
  });
});

// v2 on executor.sh: sign-up redirects to v2, and a fixed list of exact paths
// is forwarded to v2's Worker. Everything else stays with v1.
describe("isV2Path", () => {
  const forwarded = [
    "/.well-known/oauth-authorization-server/api/auth",
    "/api/auth/.well-known/openid-configuration",
    "/api/auth/callback/google",
    "/api/auth/callback/github",
    "/oauth/client-metadata.json",
    "/git/acme/tools/info/refs",
    "/git/acme/tools/git-upload-pack",
    "/git/acme/tools/git-receive-pack",
    "/.well-known/agent-skills/",
    "/.well-known/agent-skills/index.json",
  ];
  for (const pathname of forwarded) {
    it(`forwards ${pathname} to v2`, () => {
      expect(isV2Path(pathname)).toBe(true);
    });
  }

  const v1Owned = [
    // v1's WorkOS callback has no provider segment.
    "/api/auth/callback",
    "/api/auth/callback/",
    "/api/auth/callback/google/extra",
    "/api/auth/login",
    "/api/auth/me",
    // v1's own issuer metadata and client metadata document.
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/api/auth/extra",
    "/.well-known/oauth-protected-resource/mcp",
    "/api/auth/.well-known/openid-configuration/extra",
    "/oauth/client-id-metadata.json",
    "/oauth/client-metadata.json/extra",
    // Git remotes need a path under /git/.
    "/git",
    "/gitlab/acme/tools/info/refs",
    "/github",
    "/.well-known/agent-skills",
    "/.well-known/agent-skillset/index.json",
    // Not yet: connected-account callback and marketing.
    "/api/oauth/callback",
    "/pricing",
    // v1 dashboard, org pages and MCP, including org slugs that look similar.
    "/",
    "/login",
    "/mcp",
    "/acme/mcp",
    "/gitops/mcp",
    "/git-team/policies",
    "/oauth-team/mcp",
    "/api/connections",
  ];
  for (const pathname of v1Owned) {
    it(`leaves ${pathname} with v1`, () => {
      expect(isV2Path(pathname)).toBe(false);
    });
  }
});

describe("isSignUpPath", () => {
  it("claims /sign-up and /signup only", () => {
    expect(isSignUpPath("/sign-up")).toBe(true);
    expect(isSignUpPath("/signup")).toBe(true);
    expect(isSignUpPath("/sign-up/")).toBe(false);
    expect(isSignUpPath("/signup/team")).toBe(false);
    expect(isSignUpPath("/sign-in")).toBe(false);
    expect(isSignUpPath("/signups")).toBe(false);
  });
});

describe("parseV2Edge", () => {
  const service: V2Service = { fetch: () => Promise.resolve(new Response(null)) };

  it("needs both the binding and an absolute sign-up URL", () => {
    expect(parseV2Edge(undefined, "https://v2.executor.sh/login?mode=signup")).toBeNull();
    expect(parseV2Edge(service, undefined)).toBeNull();
    expect(parseV2Edge(service, "/login?mode=signup")).toBeNull();
    expect(parseV2Edge(service, "javascript:alert(1)")).toBeNull();
    expect(parseV2Edge(service, "https://v2.executor.sh/login?mode=signup")?.signUpUrl.href).toBe(
      "https://v2.executor.sh/login?mode=signup",
    );
  });
});

describe("v2EdgeResponse", () => {
  const SIGN_UP_URL = "https://v2.executor.sh/login?mode=signup";

  /** A v2 service that records what it receives and answers with `respond`. */
  const recordingService = (respond: (request: Request) => Promise<Response> | Response) => {
    const received: Request[] = [];
    const service: V2Service = {
      fetch: async (request) => {
        received.push(request);
        return respond(request);
      },
    };
    return { received, service };
  };

  const edgeWith = (service: V2Service): V2Edge => {
    const edge = parseV2Edge(service, SIGN_UP_URL);
    if (edge === null) return expect.unreachable("edge settings must parse");
    return edge;
  };

  it("redirects sign-up to v2's configured sign-up page, ignoring the query", async () => {
    const { received, service } = recordingService(() => new Response(null));
    const edge = edgeWith(service);

    for (const url of ["https://executor.sh/sign-up", "https://executor.sh/signup?ref=docs"]) {
      const response = await v2EdgeResponse(new Request(url), edge);
      expect(response?.status).toBe(302);
      expect(response?.headers.get("location")).toBe(SIGN_UP_URL);
    }
    expect(received).toHaveLength(0);
  });

  it("follows the configured sign-up URL", async () => {
    const edge = parseV2Edge(
      { fetch: () => Promise.resolve(new Response(null)) },
      "https://app.executor.sh/sign-up",
    );
    if (edge === null) return expect.unreachable("edge settings must parse");

    const response = await v2EdgeResponse(new Request("https://executor.sh/signup"), edge);
    expect(response?.headers.get("location")).toBe("https://app.executor.sh/sign-up");
  });

  it("leaves non-GET sign-up requests with v1", () => {
    const edge = edgeWith(recordingService(() => new Response(null)).service);
    expect(
      v2EdgeResponse(new Request("https://executor.sh/sign-up", { method: "POST" }), edge),
    ).toBeNull();
  });

  it("only acts on executor.sh", () => {
    const edge = edgeWith(recordingService(() => new Response(null)).service);
    expect(v2EdgeResponse(new Request("http://executor-cloud.localhost/sign-up"), edge)).toBeNull();
    expect(
      v2EdgeResponse(new Request("https://v2.executor.sh/api/auth/callback/google"), edge),
    ).toBeNull();
  });

  it("leaves v1 paths with v1", () => {
    const { received, service } = recordingService(() => new Response(null));
    const edge = edgeWith(service);
    expect(
      v2EdgeResponse(new Request("https://executor.sh/api/auth/callback?code=c"), edge),
    ).toBeNull();
    expect(v2EdgeResponse(new Request("https://executor.sh/gitlab/x/info/refs"), edge)).toBeNull();
    expect(received).toHaveLength(0);
  });

  it("forwards with the public host, path and query, and returns v2's redirect unfollowed", async () => {
    const { received, service } = recordingService(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://app.executor.sh/api/auth/callback/google?code=c&state=s" },
        }),
    );

    const response = await v2EdgeResponse(
      new Request("https://executor.sh/api/auth/callback/google?code=c&state=s"),
      edgeWith(service),
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe(
      "https://app.executor.sh/api/auth/callback/google?code=c&state=s",
    );
    expect(received).toHaveLength(1);
    expect(received[0]?.url).toBe("https://executor.sh/api/auth/callback/google?code=c&state=s");
    expect(received[0]?.redirect).toBe("manual");
  });

  it("strips v1's cookies and client forwarding headers but keeps Authorization", async () => {
    const { received, service } = recordingService(() => new Response("ok"));

    await v2EdgeResponse(
      new Request("https://executor.sh/git/acme/tools/info/refs?service=git-upload-pack", {
        headers: {
          authorization: "Basic dXNlcjp0b2tlbg==",
          cookie: "wos-session=sealed; ph_id=1",
          "git-protocol": "version=2",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "http",
        },
      }),
      edgeWith(service),
    );

    const forwarded = received[0];
    expect(forwarded?.headers.get("authorization")).toBe("Basic dXNlcjp0b2tlbg==");
    expect(forwarded?.headers.get("git-protocol")).toBe("version=2");
    expect(forwarded?.headers.has("cookie")).toBe(false);
    expect(forwarded?.headers.has("x-forwarded-host")).toBe(false);
    expect(forwarded?.headers.has("x-forwarded-proto")).toBe(false);
    expect(new URL(forwarded?.url ?? "").search).toBe("?service=git-upload-pack");
  });

  it("returns v2's response unchanged, status and body stream included", async () => {
    const upstream = new Response("not found", {
      status: 404,
      headers: { "content-type": "text/plain", "www-authenticate": 'Basic realm="git"' },
    });
    const { service } = recordingService(() => upstream);

    const response = await v2EdgeResponse(
      new Request("https://executor.sh/git/acme/tools/info/refs"),
      edgeWith(service),
    );

    expect(response).toBe(upstream);
  });

  it("streams a git push body to v2 without buffering it, preserving the method", async () => {
    const encoder = new TextEncoder();
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(encoder.encode("first-pack-chunk"));
      },
    });
    // v2 reads the first chunk while the client is still sending: a buffering
    // edge would wait for the end of the body and never reach v2.
    const { received, service } = recordingService(async (request) => {
      const reader = request.body?.getReader();
      if (reader === undefined) return new Response("no body", { status: 500 });
      const first = await reader.read();
      source?.enqueue(encoder.encode("second-pack-chunk"));
      source?.close();
      const second = await reader.read();
      const done = await reader.read();
      const decoder = new TextDecoder();
      return new Response(
        `${decoder.decode(first.value)}|${decoder.decode(second.value)}|${done.done}`,
      );
    });

    const response = await v2EdgeResponse(
      new Request("https://executor.sh/git/acme/tools/git-receive-pack", {
        method: "POST",
        headers: { "content-type": "application/x-git-receive-pack-request" },
        body,
        // @ts-expect-error -- Node's fetch needs `duplex` for a stream body; workerd does not.
        duplex: "half",
      }),
      edgeWith(service),
    );

    expect(received[0]?.method).toBe("POST");
    expect(received[0]?.headers.get("content-type")).toBe("application/x-git-receive-pack-request");
    expect(await response?.text()).toBe("first-pack-chunk|second-pack-chunk|true");
  });
});
