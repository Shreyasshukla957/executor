import dashboardRoutes from "@executor-js/hosted-cloud-web/routes" with { type: "json" };

/**
 * Paths the Worker handles before the static assets. An allowlist, so everything
 * else is served from the assets. The documentation under /docs and /docs/* is
 * static and must stay off this list.
 */
export const workerFirstRoutes = [
  "/",
  // The Worker renders every dashboard document; see `cloudflare-routes.ts`. Its
  // `/org/*` rule also covers each organization's `/org/*/mcp` endpoint.
  ...dashboardRoutes,
  "/api",
  "/api/*",
  "/health",
  "/openapi.json",
  "/mcp",
  "/git/*",
  "/.well-known/*",
];
