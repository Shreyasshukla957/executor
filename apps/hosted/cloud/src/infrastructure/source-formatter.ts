/** Source display formatting runs in the Formatter Worker, so the API Worker never uploads Prettier. */
import { SourceFormatter } from "@executor-js/app-management/contracts/source-display";
import { traceHeaders } from "@executor-js/telemetry";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Layer } from "effect";
import { Formatter } from "./formatter-worker.ts";

/**
 * Formatting only changes how source is shown. If the formatter cannot answer, the files are
 * shown as stored, the same as a file the formatter cannot parse, and the failure is logged.
 * The binding resolves from the request's Worker environment, so this is provided per request.
 */
export const cloudSourceFormatter = Effect.gen(function* () {
  const formatter = yield* Cloudflare.Workers.bindWorker(Formatter);
  return Layer.effect(
    SourceFormatter,
    Effect.gen(function* () {
      const environment = yield* Cloudflare.WorkerEnvironment;
      return SourceFormatter.of({
        format: (files) =>
          traceHeaders.pipe(
            Effect.flatMap((headers) =>
              // Only plain objects cross the binding.
              formatter.format(
                files.map(({ path, content }) => ({ path, content })),
                Object.fromEntries(Object.entries(headers)),
              ),
            ),
            Effect.provideService(Cloudflare.WorkerEnvironment, environment),
            Effect.catchTag("RpcCallError", (error) =>
              Effect.logWarning(`Source formatting unavailable: ${error.message}`).pipe(
                Effect.as(files),
              ),
            ),
            Effect.withSpan("source.display.format"),
          ),
      });
    }),
  );
});
