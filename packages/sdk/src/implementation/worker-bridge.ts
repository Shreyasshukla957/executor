import { retireMethod } from "@executor-js/app-data/worker-bundle";
import type { SourceFile } from "../contracts/deployment.ts";

/**
 * The text files a server entry retains as `ctx.files`. `ui/` is the browser app: the host serves
 * it as compiled assets, and embedding it would make every build parse it as one string literal.
 */
const serverFiles = (files: readonly SourceFile[]) =>
  JSON.stringify(files.filter((file) => !file.path.startsWith("ui/")));
/**
 * The retained server entry for every protocol so far. It imports the framework's host module as a
 * namespace and uses only what protocol 1 guarantees, so it links against every protocol-1 framework. Optional
 * later additions are feature-detected: `isolatedCacheSession` first shipped after apps
 * 0.0.1-beta.0, and the invocation bridges skip caching when a build has no `cacheSession`.
 */
export const appBridge = (files: readonly SourceFile[]) => `
import app from "./index.ts";
import * as host from "apps/host";
const handler = host.createIsolatedAppHandler(app);
const files = ${serverFiles(files)};
export default {
  cacheSession: host.isolatedCacheSession,
  async fetch(request, env) {
    // This entry point has no public route or host bindings. Only the trusted loader calls it.
    const { command, accounts, approval, replay, deadline, workflowRun } = await request.json();
    const lifetime = new AbortController();
    const delivery = env?.ELICITATION;
    const elicitation = delivery == null ? undefined : host.isolatedElicitation((prompt) => delivery(prompt), lifetime);
    try {
      return await handler(new Request("https://app.internal/dispatch", {
        method: "POST", headers: { "content-type": "application/json", traceparent: request.headers.get("traceparent") ?? "" }, body: JSON.stringify(command), signal: AbortSignal.any([request.signal, lifetime.signal])
      }), { ...host.hostContext(accounts, approval), files, ...(env?.CACHE === undefined ? {} : { cache: env.CACHE }), ...(replay === undefined ? {} : { replay }), ...(deadline === undefined ? {} : { deadline }), ...(env?.WORKFLOW && workflowRun ? { workflow: host.isolatedWorkflowExecution(workflowRun, env.WORKFLOW, lifetime.signal) } : {}), ...(env?.WORKFLOW_CONTROLS ? { workflowControls: host.isolatedWorkflowControls(env.WORKFLOW_CONTROLS) } : {}), ...(elicitation === undefined ? {} : { elicitation }), ...(env?.STORAGE === undefined ? {} : { storage: env.STORAGE }) });
    } finally { lifetime.abort(); }
  }
};`;

/**
 * Entry for the SDK's in-process Node runtime. Every protocol so far uses the same host
 * functions; the entry records which one its framework speaks.
 */
export const nodeAppEntry = (protocol: number) => (files: readonly SourceFile[]) =>
  [
    'import app from "./source/index.ts";',
    'import * as host from "apps/host";',
    `export const protocol = ${protocol};`,
    "const handler = host.createAppHandler(app);",
    `const files = ${serverFiles(files)};`,
    // Redacted owns a private store per Effect instance. Decode on
    // the host side and re-wrap with the selected app framework.
    "export default (request, context, accounts) => handler(request, { ...context, ...host.hostContext(accounts, context.approval), files });",
  ].join("\n");

/** Runtime-owned RPC entrypoint. Retained fetch bridges continue to work and only new bridges use the callback. */
export const appRpcBridge = (module: string) => `
import bridge from ${JSON.stringify(`./${module}`)};
import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
import * as workers from "cloudflare:workers";
class Invocation extends RpcTarget {
  #controller = new AbortController();
  #result;
  #cache;
  #cacheCallback;
  constructor(body, headers, elicitation, workflow, controls, cache) {
    super();
    this.#cacheCallback = cache == null ? null : cache.dup();
    this.#cache = this.#cacheCallback == null ? undefined : bridge.cacheSession?.(this.#cacheCallback);
    const delivery = elicitation == null ? null : elicitation.dup();
    const execution = workflow == null ? null : workflow.dup();
    const management = controls == null ? null : controls.dup();
    this.#result = bridge.fetch(new Request("https://app.internal/dispatch", {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body, signal: this.#controller.signal
    }), { ELICITATION: delivery, WORKFLOW: execution, WORKFLOW_CONTROLS: management, CACHE: this.#cache?.cache }).then(response => response.json()).then(value => ({ ok: true, value }), error => ({ ok: false, error })).finally(() => { delivery?.[Symbol.dispose](); execution?.[Symbol.dispose](); management?.[Symbol.dispose](); });
  }
  async result() { const result = await this.#result; if (!result.ok) throw result.error; return result.value; }
  async drain() { await this.#result; await this.#cache?.drain(); this.#cacheCallback?.[Symbol.dispose](); this.#cacheCallback = null; }
  async cancel() { this.#controller.abort(); await this.#cache?.cancel(); await this.drain(); }
  [Symbol.dispose]() { this.#controller.abort(); }
}
export default class extends WorkerEntrypoint {
  start(body, headers, elicitation, workflow = null, controls = null, cache = null) { return new Invocation(body, headers, elicitation, workflow, controls, cache); }
  ${retireMethod}
}`;

/** A dynamic class receives only its own SQLite storage, with no platform bindings. */
export const appFacetBridge = (module: string) => `
import bridge from ${JSON.stringify(`./${module}`)};
import { DurableObject } from "cloudflare:workers";
import * as workers from "cloudflare:workers";
import { facetStorage } from "apps/storage/facet";
/** Only the data supervisor reaches this entrypoint, to unload a facet it replaced. */
export default class extends workers.WorkerEntrypoint {
  ${retireMethod}
}
export class ExecutorAppData extends DurableObject {
  #storage = facetStorage(this.ctx.storage);
  #calls = new Map();
  #caches = new Map();
  fetch(request) { return bridge.fetch(request, { STORAGE: this.#storage }); }
  async invoke(id, body, headers, elicitation, workflows, cache) {
    const session = cache == null ? undefined : bridge.cacheSession?.(cache);
    if (session) this.#caches.set(id, session);
    const controller = new AbortController();
    this.#calls.set(id, controller);
    try {
      const response = await bridge.fetch(new Request("https://app.internal/dispatch", {
        method: "POST", headers: { ...headers, "content-type": "application/json" }, body, signal: controller.signal
      }), { STORAGE: this.#storage, ELICITATION: elicitation, WORKFLOW_CONTROLS: workflows, CACHE: session?.cache });
      return await response.json();
    } finally { this.#calls.delete(id); }
  }
  async finish(id) { try { await this.#caches.get(id)?.drain(); } finally { this.#caches.delete(id); } }
  async cancel(id) { this.#calls.get(id)?.abort(); await this.#caches.get(id)?.cancel(); this.#caches.delete(id); }
}`;
