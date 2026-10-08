import { describe, expect, it } from "@effect/vitest";

import { protectedResourceMetadataUrlFor, resourceUrlFor, toolkitSlugFromRequest } from "./auth";
import { classifyMcpPath, prepareMcpOrgScope } from "./mount";

describe("cloud MCP toolkit route normalization", () => {
  it("classifies toolkit MCP and protected-resource metadata paths", () => {
    expect(classifyMcpPath("/mcp/toolkits/deploy")).toEqual({
      kind: "mcp",
      organizationId: null,
      toolkitSlug: "deploy",
    });
    expect(classifyMcpPath("/acme/mcp/toolkits/deploy")).toEqual({
      kind: "mcp",
      organizationId: "acme",
      toolkitSlug: "deploy",
    });
    expect(classifyMcpPath("/.well-known/oauth-protected-resource/mcp/toolkits/deploy")).toEqual({
      kind: "oauth-protected-resource",
      organizationId: null,
      toolkitSlug: "deploy",
    });
    expect(
      classifyMcpPath("/.well-known/oauth-protected-resource/acme/mcp/toolkits/deploy"),
    ).toEqual({
      kind: "oauth-protected-resource",
      organizationId: "acme",
      toolkitSlug: "deploy",
    });
  });

  it("rewrites org-scoped toolkit metadata to the mounted toolkit metadata route", () => {
    const request = new Request(
      "https://executor.sh/.well-known/oauth-protected-resource/acme/mcp/toolkits/deploy?x=1",
      { headers: { "x-executor-mcp-organization": "spoofed" } },
    );

    const rewritten = prepareMcpOrgScope(request);
    const url = new URL(rewritten.url);

    expect(url.pathname).toBe("/.well-known/oauth-protected-resource/mcp/toolkits/deploy");
    expect(url.search).toBe("?x=1");
    expect(rewritten.headers.get("x-executor-mcp-organization")).toBe("acme");
    expect(toolkitSlugFromRequest(rewritten)).toBe("deploy");
  });

  it("builds toolkit-specific resource and metadata URLs", () => {
    expect(resourceUrlFor(null, "deploy")).toBe("https://executor.sh/mcp/toolkits/deploy");
    expect(resourceUrlFor("acme", "deploy")).toBe("https://executor.sh/acme/mcp/toolkits/deploy");
    expect(protectedResourceMetadataUrlFor(null, "deploy")).toBe(
      "https://executor.sh/.well-known/oauth-protected-resource/mcp/toolkits/deploy",
    );
    expect(protectedResourceMetadataUrlFor("acme", "deploy")).toBe(
      "https://executor.sh/.well-known/oauth-protected-resource/acme/mcp/toolkits/deploy",
    );
  });
});

// Executor v2 will own `executor.sh/mcp`'s root discovery documents, so plain
// `/mcp` names a v1-only alias of the bare document in its challenge.
describe("cloud MCP plain-/mcp resource metadata alias", () => {
  it("challenges plain /mcp with the v1 alias, and org and toolkit URLs with their own documents", () => {
    expect(protectedResourceMetadataUrlFor(null)).toBe(
      "https://executor.sh/.well-known/oauth-protected-resource/_v1/mcp",
    );
    expect(protectedResourceMetadataUrlFor("acme")).toBe(
      "https://executor.sh/.well-known/oauth-protected-resource/acme/mcp",
    );
    expect(protectedResourceMetadataUrlFor("org_01ABCDEF")).toBe(
      "https://executor.sh/.well-known/oauth-protected-resource/org_01ABCDEF/mcp",
    );
  });

  it("classifies the alias as the bare document, not an org", () => {
    expect(classifyMcpPath("/.well-known/oauth-protected-resource/_v1/mcp")).toEqual({
      kind: "oauth-protected-resource",
      organizationId: null,
    });
    expect(classifyMcpPath("/.well-known/oauth-protected-resource/mcp")).toEqual({
      kind: "oauth-protected-resource",
      organizationId: null,
    });
    // `_v1` only names the bare document; it is not an org selector.
    expect(classifyMcpPath("/_v1/mcp")).toBeNull();
    expect(
      classifyMcpPath("/.well-known/oauth-protected-resource/_v1/mcp/toolkits/deploy"),
    ).toBeNull();
  });

  it("rewrites the alias to the mounted bare document and drops any org header", () => {
    const request = new Request(
      "https://executor.sh/.well-known/oauth-protected-resource/_v1/mcp",
      { headers: { "x-executor-mcp-organization": "spoofed" } },
    );

    const rewritten = prepareMcpOrgScope(request);

    expect(new URL(rewritten.url).pathname).toBe("/.well-known/oauth-protected-resource/mcp");
    expect(rewritten.headers.has("x-executor-mcp-organization")).toBe(false);
    expect(toolkitSlugFromRequest(rewritten)).toBeNull();
  });
});
