/**
 * Axiom MCP app: OAuth discovered by the host, tools discovered live for
 * the account selected on this configured app.
 */
import { defineApp, defineProvider, oauth2 } from "apps";
import { mcpRouter } from "apps/mcp";

/** Axiom with one OAuth method; the app sees the access token only. */
export const axiom = defineProvider({
  name: "Axiom",
  auth: {
    oauth: oauth2({ discover: "https://mcp.axiom.co/mcp" }),
  },
});

export default defineApp({ accounts: { axiom } }, async ({ accounts, signal }) => ({
  tools: await mcpRouter({
    url: "https://mcp.axiom.co/mcp",
    account: accounts.axiom,
    headers: { Authorization: `Bearer ${accounts.axiom.fields.access_token}` },
    ...(signal === undefined ? {} : { signal }),
  }),
}));
