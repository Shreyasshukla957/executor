/**
 * Host protocol 8: protocol 7 plus upstream failure detail.
 *
 * Declaration, evaluation and operation failures may carry the thrown error's own scalar fields,
 * such as a spec compiler's `reason` and `pointer`, beside its name, code and message. A provider
 * failure may carry the phase it happened in and the error code and description the service
 * stated, and an MCP failure the JSON-RPC error the server answered with. Older bundles never send
 * them, so their replies are protocol 8 replies without the detail. Every other message is
 * protocol 7's, re-exported unchanged.
 *
 * Once released this protocol is frozen like the earlier ones: `bun run check` compares `protocol8`
 * with `packages/apps/protocols/8.json`. Define the next protocol instead of editing this file.
 * See notes/apps-publishing.md.
 */
import { Schema } from "effect";
import { DatabaseFieldReserved, DatabaseLimitExceeded } from "@executor-js/app-data/contracts";
import { OpenapiResponseError } from "../api-response-error.ts";
import { ElicitationFailed } from "../elicitation.ts";
import { FailureDetail } from "../failure.ts";
import { McpError } from "../mcp.ts";
import { ProviderError } from "../provider-error.ts";
import { JsonValue } from "../schema.ts";
import { SkillLoadFailed } from "../skills.ts";
import { WorkflowFailure } from "../workflows.ts";
import {
  HostAccountsInvalid,
  HostedRouter as PreviousRouter,
  HostedCatalog as PreviousCatalog,
  HostedCatalogSummary as PreviousCatalogSummary,
  HostInputInvalid,
  HostKindMismatch,
  HostOperationNotFound,
  HostOutputInvalid,
  HostRequestInvalid,
  HostToolApprovalRequired,
  HostToolBlocked,
  HostToolNotFound,
  HostToolPolicyFailed,
  protocol7,
} from "./7.ts";

export * from "./7.ts";

/**
 * The module or declared capability shape could not be hosted. The detail names what the app
 * declared wrongly; declarations bind no accounts.
 */
export class HostDeclarationInvalid extends Schema.TaggedError<HostDeclarationInvalid>()(
  "HostDeclarationInvalid",
  FailureDetail,
) {}
/** Fresh app evaluation failed before calling a tool. */
export class HostEvaluationFailed extends Schema.TaggedError<HostEvaluationFailed>()(
  "HostEvaluationFailed",
  FailureDetail,
) {}
/** An app operation failed. Carries the app's own error name, code, fields and bounded message. */
export class HostOperationFailed extends Schema.TaggedError<HostOperationFailed>()(
  "HostOperationFailed",
  FailureDetail,
) {}

/** Why one router's tools could not be read. The rest of the app's catalog is unaffected. */
export const HostRouterError = Schema.Union([
  ProviderError,
  McpError,
  SkillLoadFailed,
  HostDeclarationInvalid,
  HostEvaluationFailed,
]);
export type HostRouterError = typeof HostRouterError.Type;

/** One router in a live catalog, whose error carries protocol 8's detail. */
export const HostedRouter = Schema.Struct({
  ...PreviousRouter.fields,
  error: Schema.optionalKey(HostRouterError),
});
export type HostedRouter = typeof HostedRouter.Type;

/** A live evaluation's tools and the routers that group them. */
export const HostedCatalog = Schema.Struct({
  ...PreviousCatalog.fields,
  routers: Schema.Array(HostedRouter),
});
export type HostedCatalog = typeof HostedCatalog.Type;

/** A catalog without tool schemas. Browsing lists these and reads one full tool on selection. */
export const HostedCatalogSummary = Schema.Struct({
  ...PreviousCatalogSummary.fields,
  routers: Schema.Array(HostedRouter),
});
export type HostedCatalogSummary = typeof HostedCatalogSummary.Type;

/**
 * Safe error envelope. Author failures carry only their name, code, scalar fields and bounded
 * message with account secrets replaced; no stack or cause value is serialized.
 */
export const HostError = Schema.Union([
  OpenapiResponseError,
  ProviderError,
  McpError,
  SkillLoadFailed,
  WorkflowFailure,
  HostRequestInvalid,
  HostAccountsInvalid,
  HostDeclarationInvalid,
  HostEvaluationFailed,
  HostOperationNotFound,
  HostOperationFailed,
  DatabaseLimitExceeded,
  DatabaseFieldReserved,
  HostToolNotFound,
  HostInputInvalid,
  HostOutputInvalid,
  HostToolBlocked,
  HostToolApprovalRequired,
  HostToolPolicyFailed,
  ElicitationFailed,
  HostKindMismatch,
]);
/** Expected host failures. */
export type HostError = typeof HostError.Type;

/** Portable response envelope; callers parse the success value for their operation. */
export const HostResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    value: JsonValue,
    toolError: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: HostError }),
]);
/** Parsed response envelope. */
export type HostResponse = typeof HostResponse.Type;

/** Every message of protocol 8, in the order its snapshot records them. */
export const protocol8 = {
  version: 8,
  schemas: {
    ...protocol7.schemas,
    response: HostResponse,
    catalog: HostedCatalog,
    catalogSummary: HostedCatalogSummary,
  },
} as const;
