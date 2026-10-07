/** Members see the agents they authorized over OAuth and can revoke one at once. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema } from "effect";
import type { Page } from "playwright";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { McpClient } from "../support/mcp-client.ts";

const Agent = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  connectedAt: Schema.String,
  lastActiveAt: Schema.NullOr(Schema.String),
  access: Schema.Struct({ kind: Schema.String }),
});

layer(HostedLive, { excludeTestServices: true })("Connected agents", (it) => {
  it.effect(scenarios.connectedAgents.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          evidence = yield* Evidence,
          oauth = yield* McpOAuth,
          mcp = yield* McpClient;
        const path = `/api/organizations/${actors.organization.id}/mcp-agents`;
        const agents = (session: typeof actors.owner) =>
          api
            .request(session, "GET", path)
            .pipe(Effect.flatMap((response) => body(Schema.Array(Agent), response)));
        yield* browser.login(actors.owner);
        const grant = yield* evidence.step("Authorize an MCP client", oauth.authorize);
        const access = Redacted.make(Redacted.value(grant.tokens).access_token);
        const client = yield* mcp.connect(access, "connected-agent");
        yield* client.use("The agent lists tools", (session) => session.listTools());

        const listed = yield* agents(actors.owner);
        const agent = listed.find((item) => item.id === grant.grantId);
        expect(agent).toMatchObject({ name: "Executor E2E client", access: { kind: "all" } });
        expect(agent?.lastActiveAt).not.toBeNull();
        // Each member sees only the agents they authorized.
        expect((yield* agents(actors.member)).some((item) => item.id === grant.grantId)).toBe(
          false,
        );

        yield* browser.use("Open Connections", (page) =>
          page.goto(`/org/${actors.organization.slug}/connect`),
        );
        const row = (page: Page) =>
          page
            .getByRole("region", { name: "Connected agents" })
            .getByRole("listitem")
            .filter({ hasText: "Executor E2E client" });
        yield* browser.use("The agent is listed with its access", (page) =>
          row(page).filter({ hasText: "Every app" }).waitFor(),
        );
        yield* browser.checkpoint("Connected agents on Connections");
        yield* browser.use("Revoke the agent", (page) =>
          row(page)
            .getByRole("button", { name: "Revoke Executor E2E client", exact: true })
            .click(),
        );
        yield* browser.checkpoint("Confirm revoking the agent");
        yield* browser.use("Confirm", (page) =>
          page.getByRole("button", { name: "Revoke agent", exact: true }).click(),
        );
        // The dialog closes only after the server confirms the revocation.
        yield* browser.use("The confirmation closes", (page) =>
          page.getByRole("dialog").waitFor({ state: "detached" }),
        );
        yield* browser.use("The agent leaves the list", (page) =>
          row(page).waitFor({ state: "detached" }),
        );

        expect((yield* agents(actors.owner)).some((item) => item.id === grant.grantId)).toBe(false);
        yield* evidence.step(
          "The revoked agent can no longer call MCP or refresh",
          Effect.gen(function* () {
            const denied = yield* api.request(yield* api.session(), "GET", "/mcp", undefined, {
              authorization: `Bearer ${Redacted.value(access)}`,
            });
            expect(denied.status).toBe(401);
            expect(yield* oauth.refreshStatus(grant)).toBe(400);
          }),
        );
        const again = yield* api.request(actors.owner, "POST", `${path}/${grant.grantId}/revoke`);
        expect(again.status).toBe(404);
      }).pipe(Effect.provide(Layer.mergeAll(McpOAuth.layer, McpClient.layer))),
    ),
  );
});
