/** Compose the public MCP surface from its area contracts. */
import type { Effect } from "effect";
import { Toolkit } from "effect/unstable/ai";
import type { BrowserDelivery } from "./browser.ts";
import { BrowserExecuteTool, BrowserResumeTool } from "./browser-tools.ts";
import type { McpBackend } from "./backend.ts";
import {
  ExecuteTool,
  NativeExecuteTool,
  ResumeTool,
  type McpLimits,
  type ExecutionRejected,
} from "./execute.ts";
import { SkillsTool } from "./skills.ts";

/** Public MCP tools and their handler requirements. Declaring them performs no I/O. */
export const McpToolkit = Toolkit.make(ExecuteTool, ResumeTool, SkillsTool);

/** Native-mode clients answer prompts directly and cannot submit model-side resume decisions. */
export const NativeMcpToolkit = Toolkit.make(NativeExecuteTool, SkillsTool);

/** Browser mode exposes a collector-only resume tool. */
export const BrowserMcpToolkit = Toolkit.make(BrowserExecuteTool, BrowserResumeTool, SkillsTool);

/** Hosts supply authorized operations and documentation I/O. */
export interface McpOptions {
  readonly backend: McpBackend<Error>;
  /** Admit each new program once. Resumes never call this hook. */
  readonly beforeExecute?: Effect.Effect<void, ExecutionRejected>;
  readonly browser?: BrowserDelivery;
  /** Additional product identity partition. The validated HTTP MCP session ID is included when the protocol has sessions. */
  readonly caller?: Effect.Effect<string>;
  /** Sent as the server instructions when a client connects. Hosts send the Executor app's intro. */
  readonly instructions: string;
  readonly limits: McpLimits;
}
