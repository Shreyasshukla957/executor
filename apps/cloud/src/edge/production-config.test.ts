import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { unstable_readConfig } from "wrangler";

import { parseV2Edge, v2EdgeResponse, type V2EdgeEnv, type V2Service } from "./marketing";

// The deployed edge reads its v2 settings from wrangler.jsonc. These tests read
// that file the way wrangler does and run the edge with the values it ships.
// wrangler's config arrives untyped here, so it is decoded first.
const WranglerConfig = Schema.Struct({
  vars: Schema.Record(Schema.String, Schema.Unknown),
  services: Schema.Array(Schema.Struct({ binding: Schema.String, service: Schema.String })),
});
const config = Schema.decodeUnknownSync(WranglerConfig)(
  unstable_readConfig({ config: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)) }),
);

const stringVar = (name: string): string | undefined => {
  const value = config.vars[name];
  return typeof value === "string" ? value : undefined;
};

const standIn: V2Service = { fetch: () => Promise.resolve(new Response("v2")) };

/** The shipped settings, with a stand-in for v2's Worker. */
const shipped: V2EdgeEnv = {
  V2: standIn,
  V2_SIGN_UP_URL: stringVar("V2_SIGN_UP_URL"),
  V2_OAUTH_STATE_PREFIX: stringVar("V2_OAUTH_STATE_PREFIX"),
};

describe("production v2 edge settings", () => {
  it("binds V2 to exactly one Worker", () => {
    const bindings = config.services.filter((service) => service.binding === "V2");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.service).toMatch(/^[a-z0-9-]+$/);
  });

  it("redirects sign-up to v2's sign-up page on app.executor.sh", async () => {
    const response = await v2EdgeResponse(new Request("https://executor.sh/sign-up"), shipped);

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe("https://app.executor.sh/login?mode=signup");
  });

  it("ships v2's connected-account state prefix", () => {
    const edge = parseV2Edge(shipped);
    if (edge === null || typeof edge === "string") return expect.unreachable("settings must parse");
    expect(edge.oauthStatePrefix).toBe("x2.");
  });
});
