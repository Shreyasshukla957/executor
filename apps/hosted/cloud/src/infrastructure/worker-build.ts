/** Rolldown output rules for each Worker: upload only reachable modules, within a budget. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { WorkerProps } from "alchemy/Cloudflare";
import { Effect, FileSystem, Path } from "effect";

type WorkerName = "api" | "app-pages" | "mcp-server" | "dashboard" | "formatter" | "compiler";

/**
 * Bytes of JavaScript each Worker may upload. Cloudflare compiles every uploaded ES module when
 * an isolate starts, whether or not the Worker ever imports it, so each megabyte adds about
 * 50 ms to every cold request. Load rarely used code from another Worker rather than raising a
 * budget: the API Worker leaves rendering to `dashboard`, source formatting to `formatter` and
 * MCP sessions to `mcp-server`.
 */
const uploadBudgets: Record<WorkerName, number> = {
  api: 5_400_000,
  "app-pages": 2_500_000,
  "mcp-server": 3_400_000,
  dashboard: 3_900_000,
  formatter: 2_000_000,
  compiler: 1_700_000,
};

/** The fields of Rolldown's output bundle these rules read. */
type OutputBundle = Record<
  string,
  | {
      readonly type: "chunk";
      readonly code: string;
      readonly isEntry: boolean;
      readonly imports: ReadonlyArray<string>;
      readonly dynamicImports: ReadonlyArray<string>;
    }
  | { readonly type: "asset"; readonly source: string | Uint8Array }
>;

/**
 * Rolldown emits a chunk for every dynamic import it finds, even when tree-shaking removes the
 * only code that loads it, such as deploy-time Vite support inside Alchemy. No uploaded module
 * can load such a chunk, so it is dropped with its source map. The budget is then checked
 * against exactly what Cloudflare receives.
 */
const uploadedModules = (worker: WorkerName) => ({
  name: "executor-uploaded-modules",
  generateBundle(_options: unknown, bundle: OutputBundle) {
    const reachable = new Set<string>();
    const visit = (name: string) => {
      const output = bundle[name];
      if (reachable.has(name) || output?.type !== "chunk") return;
      reachable.add(name);
      for (const imported of [...output.imports, ...output.dynamicImports]) visit(imported);
    };
    for (const [name, output] of Object.entries(bundle))
      if (output.type === "chunk" && output.isEntry) visit(name);
    const uploaded: Array<readonly [string, number]> = [];
    for (const [name, output] of Object.entries(bundle)) {
      if (output.type !== "chunk") continue;
      if (reachable.has(name)) {
        uploaded.push([name, Buffer.byteLength(output.code)]);
        continue;
      }
      delete bundle[name];
      delete bundle[`${name}.map`];
    }
    const bytes = uploaded.reduce((total, [, size]) => total + size, 0);
    if (bytes > uploadBudgets[worker])
      throw new Error(
        `The ${worker} Worker uploads ${bytes} bytes of JavaScript; its budget is ${uploadBudgets[worker]}. ` +
          "Every uploaded module is compiled on each cold start. Move rarely used code to another Worker. " +
          `Largest modules: ${uploaded
            .toSorted((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([name, size]) => `${name} (${size})`)
            .join(", ")}.`,
      );
  },
});

/** Collect exactly this Worker's output for Sentry; Alchemy's bundle folder retains older builds. */
const sentryArtifacts = (worker: WorkerName) => ({
  name: "executor-sentry-artifacts",
  writeBundle: (_options: unknown, bundle: OutputBundle) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* path.fromFileUrl(
          new URL(`../../.generated/sentry-worker/${worker}`, import.meta.url),
        );
        yield* fs.remove(directory, { recursive: true, force: true });
        yield* fs.makeDirectory(directory, { recursive: true });
        for (const [name, output] of Object.entries(bundle)) {
          if (!name.endsWith(".js") && !name.endsWith(".map")) continue;
          const target = path.join(directory, name);
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          const contents = output.type === "chunk" ? output.code : output.source;
          if (typeof contents === "string") yield* fs.writeFileString(target, contents);
          else yield* fs.writeFile(target, contents);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
});

/** Build options for one Worker. The compiler keeps Alchemy's default output. */
export const workerBuild = (worker: WorkerName): NonNullable<WorkerProps["build"]> =>
  worker === "compiler"
    ? { output: { plugins: [uploadedModules(worker)] } }
    : {
        output: {
          entryFileNames: `${worker}-[name].js`,
          chunkFileNames: `${worker}-[name]-[hash].js`,
          // Normal ESM ordering avoids an initializer wrapper around every module.
          // This graph is covered by the workerd MCP and app-UI tests; keep source maps for diagnostics.
          strictExecutionOrder: false,
          // Re-chunking the prebuilt dashboard graph by entry reach can evaluate a chunk that reads a
          // binding before the chunk that initializes it. One chunk keeps that graph's own module order.
          codeSplitting: {
            groups: [{ name: "dashboard", test: "/web/dist/server/" }],
          },
          keepNames: false,
          sourcemap: "hidden",
          plugins: [
            uploadedModules(worker),
            ...(worker === "api" || worker === "app-pages" || worker === "mcp-server"
              ? [sentryArtifacts(worker)]
              : []),
          ],
        },
      };
