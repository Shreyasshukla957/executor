/** The paired local operator's scoped connection limits a real OAuth client and revokes it. */
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Api, body } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence } from "../support/evidence.ts";
import { McpClient } from "../support/mcp-client.ts";
import { deployLocalMcpApp } from "../support/mcp-app.ts";
import { pairLocalOperator } from "../support/mcp-consent.ts";
import {
  ConnectionView,
  Execution,
  consentTo,
  readWriteAppFiles,
  revokeClientGrants,
} from "../support/mcp-connections.ts";
import { Target } from "../support/platform.ts";

layer(TestLive, { excludeTestServices: true })("Local scoped MCP connections", (it) => {
  it.effect(scenarios.localScopedConnections.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          evidence = yield* Evidence,
          mcp = yield* McpClient;
        const operator = yield* pairLocalOperator;
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const receipt = randomUUID();
        const deployed = yield* operator.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Scoped app ${receipt.slice(0, 8)}`,
            files: readWriteAppFiles(receipt),
          },
          headers,
        );
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Schema.Struct({ app: App }), deployed);
        yield* Effect.addFinalizer(() =>
          operator.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const hidden = yield* deployLocalMcpApp;
        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        const created = yield* api.request(operator, "POST", "/dashboard/api/mcp/connections", {
          id: randomUUID(),
          name: "Read only",
          apps: [{ app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "readOnly" } }],
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const connection = yield* body(ConnectionView, created);
        expect(connection.url).toBe(`${target.metadata.origin}/mcp?connection=${connection.id}`);
        const consent = yield* evidence.step(
          "Authorize the connection's URL as the paired operator",
          consentTo(operator, connection.url),
        );
        clients.push(consent.clientId);
        expect(consent.status).toBe(200);
        const client = yield* mcp.connect(yield* consent.tokens, "local-scoped", {
          connection: connection.id,
        });
        const run = (operation: string, code: string) =>
          client
            .use(operation, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Execution)(result.structuredContent),
              ),
            );
        const appPath = `tools[${JSON.stringify(app.slug)}]`;
        const [read, write, excluded] = yield* Effect.all(
          [
            run("Call the read tool", `return await ${appPath}.read({})`),
            run("Call the write tool", `return await ${appPath}.write({message: "x"})`),
            run(
              "Call an excluded app",
              `return await tools[${JSON.stringify(hidden.app.slug)}].echo({message: "x"})`,
            ),
          ],
          { concurrency: 3 },
        );
        expect(read.execution).toEqual({ ok: true, value: { read: receipt } });
        expect(write.execution.ok).toBe(false);
        expect(excluded.execution.ok).toBe(false);
        // The administrative key keeps full access on the plain URL but cannot enter a connection.
        const adminMoved = yield* Effect.exit(
          mcp.connect(Redacted.make(Redacted.value(target.apiKey)), "admin-connection", {
            connection: connection.id,
          }),
        );
        expect(Exit.isFailure(adminMoved)).toBe(true);
        yield* evidence.step(
          "Revoking the connection stops its client",
          Effect.gen(function* () {
            const revoked = yield* api.request(
              operator,
              "POST",
              `/dashboard/api/mcp/connections/${connection.id}/revoke`,
            );
            expect(revoked.status).toBe(200);
            const after = yield* Effect.exit(
              run("Call after revocation", `return await ${appPath}.read({})`),
            );
            expect(Exit.isFailure(after)).toBe(true);
            const listed = yield* body(
              Schema.Array(ConnectionView),
              yield* api.request(operator, "GET", "/dashboard/api/mcp/connections"),
            );
            expect(listed).toEqual([]);
          }),
        );
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
  it.effect(scenarios.localMcpOAuthWithoutResource.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const target = yield* Target,
          evidence = yield* Evidence,
          mcp = yield* McpClient;
        const operator = yield* pairLocalOperator;
        const clients: string[] = [];
        yield* revokeClientGrants(operator, () => clients);
        const consent = yield* evidence.step(
          "Authorize a client that sends no resource parameter",
          consentTo(operator, undefined),
        );
        clients.push(consent.clientId);
        // The consent page names the plain MCP URL the grant is bound to.
        expect(consent.consentResources).toEqual([`${target.metadata.origin}/mcp`]);
        expect(consent.status).toBe(200);
        const token = yield* consent.tokens;
        const client = yield* mcp.connect(token, "local-without-resource");
        const listed = yield* client.use("The plain MCP URL accepts the grant", (client) =>
          client.listTools(),
        );
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
          "execute",
          "resume",
          "skills",
        ]);
        // The default is the plain URL's model mode only, not every approval mode.
        const other = yield* Effect.exit(
          mcp.connect(token, "local-without-resource-browser-mode", { mode: "browser" }),
        );
        expect(Exit.isFailure(other)).toBe(true);
      }).pipe(Effect.provide(McpClient.layer)),
    ),
  );
});
