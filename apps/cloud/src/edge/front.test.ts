import { describe, expect, it } from "@effect/vitest";

import { frontResponse, type FrontEnv } from "./front";

/** A Worker stand-in that records what it receives and answers with `respond`. */
const recordingWorker = (respond: () => Response) => {
  const received: Request[] = [];
  return {
    received,
    worker: {
      fetch: (request: Request) => {
        received.push(request);
        return Promise.resolve(respond());
      },
    },
  };
};

const settings = (v2: FrontEnv["V2"], marketing?: FrontEnv["MARKETING"]): FrontEnv => ({
  V2: v2,
  MARKETING: marketing,
  V2_SIGN_UP_URL: "https://app.executor.sh/login?mode=signup",
  V2_OAUTH_STATE_PREFIX: "x2.",
  V2_ANALYTICS_PROXY_PATH: "/api/0123456789abcdef",
  V2_ERROR_TUNNEL_PATH: "/api/fedcba9876543210/submit",
});

const IMMUTABLE = "public, max-age=31536000, immutable";

describe("frontResponse", () => {
  it("returns v2's asset with its caching, status and body unchanged, adding only the referrer policy", async () => {
    const v2 = recordingWorker(
      () =>
        new Response("console.log(1)", {
          status: 200,
          headers: {
            "cache-control": IMMUTABLE,
            "content-type": "text/javascript",
            etag: '"abc"',
          },
        }),
    );

    const response = await frontResponse(
      new Request("https://executor.sh/_astro/page.abc123.js"),
      settings(v2.worker),
    );

    expect(v2.received.map((request) => request.url)).toEqual([
      "https://executor.sh/_astro/page.abc123.js",
    ]);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe(IMMUTABLE);
    expect(response?.headers.get("content-type")).toBe("text/javascript");
    expect(response?.headers.get("etag")).toBe('"abc"');
    expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response?.text()).toBe("console.log(1)");
  });

  it("answers v2's redirects itself, as executor-cloud does", async () => {
    const v2 = recordingWorker(() => new Response("v2"));

    const response = await frontResponse(
      new Request("https://executor.sh/sign-up"),
      settings(v2.worker),
    );

    expect(v2.received).toHaveLength(0);
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe("https://app.executor.sh/login?mode=signup");
    expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("sends v1's legal pages to v1's marketing worker", async () => {
    const v2 = recordingWorker(() => new Response("v2"));
    const marketing = recordingWorker(() => new Response("terms"));

    const response = await frontResponse(
      new Request("https://executor.sh/terms"),
      settings(v2.worker, marketing.worker),
    );

    expect(v2.received).toHaveLength(0);
    expect(marketing.received.map((request) => request.url)).toEqual(["https://executor.sh/terms"]);
    expect(await response?.text()).toBe("terms");
    expect(response?.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("passes on every request executor-cloud serves itself", () => {
    const v2 = recordingWorker(() => new Response("v2"));
    const marketing = recordingWorker(() => new Response("terms"));
    const env = settings(v2.worker, marketing.worker);

    for (const request of [
      new Request("https://executor.sh/", { headers: { cookie: "wos-session=sealed" } }),
      new Request("https://executor.sh/login"),
      new Request("https://executor.sh/mcp", { method: "POST" }),
      new Request("https://executor.sh/api/auth/callback?code=c&state=s"),
      new Request("https://executor.sh/api/oauth/callback?code=c&state=abc"),
      new Request("https://executor.sh/acme"),
      new Request("https://executor.sh/favicon.ico"),
    ]) {
      expect(frontResponse(request, env), request.url).toBeNull();
    }
    expect(v2.received).toHaveLength(0);
    expect(marketing.received).toHaveLength(0);
  });

  it("passes everything on when v2's settings are absent", () => {
    expect(frontResponse(new Request("https://executor.sh/_astro/page.abc123.js"), {})).toBeNull();
  });
});
