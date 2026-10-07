import { Grant, GrantId, type ApprovalMode } from "@executor-js/mcp-auth";
import type {
  Connection,
  ConnectionId,
  ConnectionIdTaken,
  ConnectionNotFound,
  ConnectionPolicy,
} from "@executor-js/mcp-auth/connections";
import { UserFacingError, type ErrorPresentation } from "@executor-js/utils/user-facing-error";
import { Context, Schema } from "effect";
import type { Effect } from "effect";
import { OrganizationAccess, type OrganizationReference } from "./organization.ts";
import { AuthenticationUnavailable } from "./auth.ts";

/** MCP authority from OAuth or a PAT and current membership. Tokens never become browser sessions. */
export const McpAccess = Schema.Struct({
  userId: Schema.NonEmptyString,
  clientId: Schema.NonEmptyString,
  access: OrganizationAccess,
  grant: Grant,
});
export type McpAccess = typeof McpAccess.Type;

/** Invalid/revoked bearer grants need a fresh OAuth connection. */
export class McpUnauthorized extends Schema.TaggedError<McpUnauthorized>()("McpUnauthorized", {}) {}
/** Why a valid credential may not make an MCP request. Each reason needs a different fix. */
export const McpForbiddenReason = Schema.Literals([
  "organization_required",
  "organization_mismatch",
  "membership",
]);
export type McpForbiddenReason = typeof McpForbiddenReason.Type;
const forbidden: { readonly [Reason in McpForbiddenReason]: ErrorPresentation } = {
  organization_required: {
    title: "Organization required",
    description:
      "This full-account token does not name an organization, so Executor cannot choose one for this MCP request.",
    recovery: {
      action:
        "Connect at /org/<organization>/mcp, or send the X-Executor-Organization header, then retry.",
      instructions:
        "A full-account personal access token works in every organization its user belongs to, so each MCP request must name one. Put the organization's ID or slug in the MCP URL path (/org/<organization>/mcp) or in the X-Executor-Organization header, reconnect, and verify that tools are listed.",
    },
  },
  organization_mismatch: {
    title: "Different organization",
    description:
      "This request names a different organization than its credential belongs to, or its URL and X-Executor-Organization header name different organizations.",
    recovery: {
      action: "Use the organization this credential belongs to in the URL and header, then retry.",
      instructions:
        "OAuth connections and organization-pinned tokens work only in their own organization. Make the organization in the MCP URL and in X-Executor-Organization agree with the credential, reconnect, and verify that tools are listed. To work in another organization, connect again from that organization. Do not bypass authorization.",
    },
  },
  membership: {
    title: "Organization access denied",
    description:
      "This account is not a member of the organization this MCP request uses, or that organization does not exist.",
    recovery: {
      action:
        "Check the organization name, and that this account still belongs to it. Copy the fix prompt into your agent to investigate the missing access.",
      instructions:
        "Check which account the credential belongs to and which organization the MCP URL, X-Executor-Organization header or connection names. Correct a wrong organization, or have an organization owner restore the account's membership. Do not bypass authorization or assume changing app code can grant access.",
    },
  },
};
/** A valid credential that may not make this MCP request, with the reason it was refused. */
export const McpForbidden = UserFacingError.define({
  tag: "McpForbidden",
  status: 403,
  fields: { reason: McpForbiddenReason },
  presentation: ({ reason }) => forbidden[reason],
});
export type McpForbidden = typeof McpForbidden.Type;
/** The signed-in browser may not review this grant's requests. Approval pages state no cause. */
export class McpApprovalForbidden extends Schema.TaggedError<McpApprovalForbidden>()(
  "McpApprovalForbidden",
  {},
) {}

/** The verified owner of connection records: one user in one organization. */
export interface ConnectionOwner {
  readonly userId: string;
  readonly resource: string;
}
/** Grant storage owns connection records so grants can read them on every authentication. */
export interface McpConnectionStore {
  readonly list: (
    owner: ConnectionOwner,
  ) => Effect.Effect<readonly Connection[], AuthenticationUnavailable>;
  readonly create: (
    owner: ConnectionOwner,
    input: { readonly id: ConnectionId; readonly name: string; readonly policy: ConnectionPolicy },
  ) => Effect.Effect<Connection, ConnectionIdTaken | AuthenticationUnavailable>;
  readonly update: (
    owner: ConnectionOwner,
    input: { readonly id: ConnectionId; readonly name: string; readonly policy: ConnectionPolicy },
  ) => Effect.Effect<Connection, ConnectionNotFound | AuthenticationUnavailable>;
  /** Revoke the connection, every grant issued through it, and their tokens. */
  readonly revoke: (
    owner: ConnectionOwner,
    id: ConnectionId,
  ) => Effect.Effect<void, ConnectionNotFound | AuthenticationUnavailable>;
}

/** Better Auth owns grant validation; each host supplies its native request lifetime. */
export class McpAuthentication extends Context.Service<
  McpAuthentication,
  {
    readonly origin: string;
    readonly authenticate: (
      headers: Headers,
      mode?: ApprovalMode,
      organization?: OrganizationReference,
    ) => Effect.Effect<McpAccess, McpUnauthorized | McpForbidden | AuthenticationUnavailable>;
    readonly browserGrant: (
      headers: Headers,
      id: GrantId,
    ) => Effect.Effect<
      McpAccess,
      McpUnauthorized | McpApprovalForbidden | AuthenticationUnavailable
    >;
    readonly metadata: Effect.Effect<unknown, AuthenticationUnavailable>;
    readonly connections: McpConnectionStore;
  }
>()("hosted/McpAuthentication") {}
