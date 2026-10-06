import { Option, Schema, SchemaAST } from "effect";
import { InputInvalid, mcpFailurePresentation, ToolCallFailed } from "@executor-js/sdk/core";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import {
  ApiErrorResponse,
  maxApiErrorInstructionsLength,
  maxApiErrorMessageLength,
} from "apps/contracts";
import { CodeMode } from "@opencode-ai/codemode";

const encodeResponse = Schema.encodeSync(Schema.fromJsonString(ApiErrorResponse));

/** An app's own error detail can make an explanation long; shorten it rather than drop it. */
const bounded = (text: string, maximum: number) =>
  text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;

/** A product error's curated presentation. Arbitrary Error.message, causes and authored recovery never pass. */
const presentation = (error: Error): Option.Option<typeof ApiErrorResponse.Type> => {
  const tool = Schema.decodeUnknownOption(ToolCallFailed)(error);
  if (Option.isSome(tool)) {
    if (tool.value.response !== undefined) return Option.some(tool.value.response);
    // The reason is a fixed SDK text, the app's own bounded, secret-free error message, or its
    // MCP server's failure with the server's bounded JSON-RPC error.
    return Schema.decodeUnknownOption(ApiErrorResponse)({
      code: "ToolCallFailed",
      status: 502,
      message: bounded(tool.value.reason, maxApiErrorMessageLength),
      recovery:
        tool.value.mcp !== undefined
          ? mcpFailurePresentation(tool.value.mcp).recovery
          : tool.value.failure === undefined
            ? {
                action: "Check whether the tool already made changes before retrying.",
                instructions:
                  "The tool failed after it started, so external effects may already have occurred. Retry safety is not implied. Inspect current state with a safe read before repeating the call.",
              }
            : tool.value.failure.source === "service"
              ? {
                  action: "Check the API's response and the app's OpenAPI document, then retry.",
                  instructions:
                    "An API the app calls returned a failure its OpenAPI document does not describe, so no response body is shown. Check the API's own logs or status, and whether the document declares this error. Retry safety is not implied; inspect current state with a safe read before repeating the call.",
                }
              : tool.value.failure.source === "storage"
                ? {
                    action: "Change the operation so it stays within app data rules, then retry.",
                    instructions: `The app's data storage rejected this operation (${tool.value.failure.code ?? tool.value.failure.errorName}). Read the message, change the app's query or mutation to respect it, deploy, and verify the call succeeds. A failed mutation's writes were rolled back, but any external effects it made may already have occurred.`,
                  }
                : {
                    action: "Fix the input or the app code that threw this error, then retry.",
                    instructions:
                      "The app's own code threw this error; the message is the app's text. Decide from it whether the input was wrong or the app has a bug. Fix the input, or find where the app throws it and deploy a fix. A failed mutation's writes were rolled back, but any external effects it made may already have occurred.",
                  },
    });
  }
  const input = Schema.decodeUnknownOption(InputInvalid)(error);
  if (Option.isSome(input)) {
    // Problems name input paths and expected shapes; supplied values are never included.
    return Schema.decodeUnknownOption(ApiErrorResponse)({
      code: "InputInvalid",
      status: 422,
      message: `Input failed validation: ${input.value.problems.join("; ")}`.slice(0, 4096),
      recovery: {
        action: "Fix the listed input fields and call the tool again.",
        instructions:
          "The tool did not run. Compare the input with the tool's signature from tools.search before retrying.",
      },
    });
  }
  const schema = error.constructor;
  // Product errors carry a curated description and recovery, so agents can act on
  // deterministic failures such as a missing account instead of retrying them.
  if (!UserFacingError.is(error) || !Schema.isSchema(schema)) return Option.none();
  return Schema.decodeUnknownOption(ApiErrorResponse)({
    code: error.code,
    // This is the Executor API status; an upstream status remains in the explanation.
    status: SchemaAST.resolveAt<number>("httpApiStatus")(schema.ast),
    message: bounded(error.description, maxApiErrorMessageLength),
    recovery: {
      action: error.recovery.action,
      instructions: bounded(error.recovery.instructions, maxApiErrorInstructionsLength),
    },
  });
};
const identifier = (error: Error) => {
  const schema = error.constructor;
  return Schema.isSchema(schema) ? (SchemaAST.resolveIdentifier(schema.ast) ?? "Error") : "Error";
};
/** One line for agents: code, status, message and the declared recovery action. */
const summary = ({ code, status, message, recovery }: typeof ApiErrorResponse.Type) =>
  `${code} (HTTP ${status}): ${message}${recovery === undefined ? "" : ` Recovery: ${recovery.action}`}`;

/**
 * Preserve bounded, curated framework recovery as JSON, which a program can read from a caught
 * tool error; unknown errors expose only their schema identifier.
 */
export const diagnostic = (error: Error): string =>
  Option.match(presentation(error), { onSome: encodeResponse, onNone: () => identifier(error) });

/** The same presentation as a single readable line, for failures agents read but never parse. */
export const diagnosticSummary = (error: Error): string =>
  Option.match(presentation(error), { onSome: summary, onNone: () => identifier(error) });

/** CodeMode transports tool errors as messages, including inside agent try/catch.
 * Decode our safe JSON projection back into structured MCP details for uncaught failures.
 * A declared recovery action is appended to the summary line; full recovery stays in `response`.
 */
export const executionDiagnostic = <A extends CodeMode.Result>(execution: A) => {
  if (
    execution.ok ||
    (execution.error.kind !== "ToolFailure" && execution.error.kind !== "ExecutionFailure")
  )
    return execution;
  const response = Schema.decodeUnknownOption(Schema.fromJsonString(ApiErrorResponse))(
    execution.error.message,
  );
  if (Option.isNone(response)) return execution;
  return {
    ...execution,
    error: { ...execution.error, message: summary(response.value), response: response.value },
  };
};
