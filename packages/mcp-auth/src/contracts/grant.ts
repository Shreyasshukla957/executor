/** Product-owned MCP authority. No organization, browser session, or token is a grant. */
import {
  AppPermission,
  fullAuthority,
  selectedAuthority,
  type AuthorizationPolicy,
} from "@executor-js/authorization";
export { AppPermission } from "@executor-js/authorization";
import { Schema } from "effect";

/** Stable authorization identity shared by access tokens, refresh tokens, and continuations. */
export const GrantId = Schema.NonEmptyString.pipe(Schema.brand("McpGrantId"));
export type GrantId = typeof GrantId.Type;
/** Scope selects ordinary apps. All apps includes any Executor app the caller may use. */
export const GrantPolicy = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tools"),
    apps: Schema.Array(AppPermission),
    approval: Schema.Literals(["browser", "client"]),
  }),
  Schema.Struct({ kind: Schema.Literal("all") }),
]);
export type GrantPolicy = typeof GrantPolicy.Type;
/** Revoked grants are absent from authentication, not converted to empty or unrestricted policies. */
export const ApprovalMode = Schema.Literals(["model", "native", "browser"]);
export type ApprovalMode = typeof ApprovalMode.Type;
/** A user's named MCP access boundary. URL-safe because it appears in the MCP URL and OAuth resource. */
export const ConnectionId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)).pipe(
  Schema.brand("McpConnectionId"),
);
export type ConnectionId = typeof ConnectionId.Type;
/** What an MCP URL selects: its approval mode and, for a scoped connection, that connection. */
export const McpAddress = Schema.Struct({
  mode: ApprovalMode,
  connection: Schema.optionalKey(ConnectionId),
});
export type McpAddress = typeof McpAddress.Type;
/** The OAuth resource approved for this grant, preserved through refresh. */
export const GrantTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("mcp"), ...McpAddress.fields }),
  Schema.Struct({ kind: Schema.Literal("api") }),
]);
export type GrantTarget = typeof GrantTarget.Type;
export const Grant = Schema.Struct({ id: GrantId, policy: GrantPolicy, target: GrantTarget });
export type Grant = typeof Grant.Type;
/** A current grant does not authorize this operation. No private resource details are exposed. */
export class GrantForbidden extends Schema.TaggedError<GrantForbidden>()("GrantForbidden", {}) {}

/** OAuth resources must be provisioned before this host accepts requests. */
export class OAuthResourceProvisioningFailed extends Schema.TaggedError<OAuthResourceProvisioningFailed>()(
  "OAuthResourceProvisioningFailed",
  {},
) {}

/** Adapt the OAuth grant DTO to shared product authority. Approval delivery stays in this module. */
export const grantAuthorization = (policy: GrantPolicy): AuthorizationPolicy =>
  policy.kind === "all"
    ? fullAuthority
    : selectedAuthority(["discover", "run"], { kind: "tools", apps: policy.apps });
/** An issued MCP grant cannot change mode or connection by changing the request URL. */
export const permitsDelivery = (grant: Grant, address: McpAddress) =>
  grant.target.kind === "mcp" &&
  grant.target.mode === address.mode &&
  grant.target.connection === address.connection &&
  (grant.policy.kind === "all" || grant.policy.approval === "client" || address.mode === "browser");
/** Browser approval pages answer only grants issued for a browser-mode URL. */
export const permitsBrowserApproval = (grant: Grant) =>
  grant.target.kind === "mcp" && permitsDelivery(grant, { ...grant.target, mode: "browser" });

/**
 * Missing URL mode retains the original model-mode default. A connection is optional;
 * duplicates and malformed values of either parameter are invalid.
 */
export const requestedMcpAddress = (url: URL): McpAddress | undefined => {
  const modes = url.searchParams.getAll("elicitation_mode");
  const connections = url.searchParams.getAll("connection");
  if (modes.length > 1 || connections.length > 1) return undefined;
  const mode = modes.length === 0 ? "model" : modes[0];
  if (!Schema.is(ApprovalMode)(mode)) return undefined;
  if (connections.length === 0) return { mode };
  const connection = connections[0];
  return Schema.is(ConnectionId)(connection) ? { mode, connection } : undefined;
};
const mcpQuery = (address: McpAddress) => {
  const query = new URLSearchParams();
  if (address.connection !== undefined) query.set("connection", address.connection);
  if (address.mode !== "model") query.set("elicitation_mode", address.mode);
  const encoded = query.toString();
  return encoded === "" ? "" : `?${encoded}`;
};
/** Canonical OAuth audience for each MCP address. Query parameters are valid RFC 8707 resource URIs. */
export const mcpResource = (origin: string, address: McpAddress) =>
  `${origin}/mcp${mcpQuery(address)}`;
/** Every approval mode for the full-access URL, or for one connection's URL. */
export const mcpOAuthResources = (origin: string, connection?: ConnectionId) =>
  ApprovalMode.literals.map((mode) => ({
    identifier: mcpResource(origin, connection === undefined ? { mode } : { mode, connection }),
    allowedScopes: ["mcp", "offline_access"],
  }));
/**
 * RFC 8707 makes `resource` optional. A request that names none is for the plain MCP URL
 * that discovery advertises, in its original model mode: no approval mode or connection is
 * implied. API authority is never a default; a request for the `executor` scope has none.
 */
export const defaultResource = (origin: string, scope: string | undefined) =>
  scope?.split(" ").includes("executor") === true
    ? undefined
    : mcpResource(origin, { mode: "model" });
/** Select exactly one known resource. Multi-resource consent must not combine approval modes. */
export const grantTarget = (
  origin: string,
  resources: readonly string[],
): GrantTarget | undefined => {
  if (resources.length !== 1) return undefined;
  const resource = resources[0];
  if (resource === undefined) return undefined;
  if (resource === `${origin}/api`) return { kind: "api" };
  const url = URL.parse(resource);
  if (url === null || `${url.origin}${url.pathname}` !== `${origin}/mcp`) return undefined;
  const address = requestedMcpAddress(url);
  // Only the canonical spelling is a resource; reordered or extra parameters are not.
  return address !== undefined && mcpResource(origin, address) === resource
    ? { kind: "mcp", ...address }
    : undefined;
};
/** Discovery and the authentication challenge carry the requested address into standard OAuth. */
export const mcpResourceMetadataUrl = (origin: string, address: McpAddress) => {
  const query = new URLSearchParams();
  if (address.connection !== undefined) query.set("connection", address.connection);
  query.set("elicitation_mode", address.mode);
  return `${origin}/.well-known/oauth-protected-resource/mcp?${query.toString()}`;
};
