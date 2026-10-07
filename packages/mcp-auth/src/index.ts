/** Shared grant contracts and enforcement for product hosts. */
export {
  GrantId,
  ApprovalMode,
  ConnectionId,
  McpAddress,
  GrantTarget,
  requestedMcpAddress,
  mcpResource,
  mcpOAuthResources,
  grantTarget,
  mcpResourceMetadataUrl,
  GrantPolicy,
  grantAuthorization,
  Grant,
  AppPermission,
  GrantForbidden,
  GrantRefusal,
  deliveryRefusal,
  permitsBrowserApproval,
} from "./contracts/grant.ts";
export { restrictMcpBackend } from "./implementation/backend.ts";
