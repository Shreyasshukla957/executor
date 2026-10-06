import {
  hostedApiDocumentRoute,
  hostedHandlers,
  type LazyHostedApiDocument,
} from "@executor-js/hosted-server";
import { Layer } from "effect";
import { layerWithBatches } from "@executor-js/dashboard-start/batch-host";
import { ExecutorSelfHostApi } from "../contracts/api.ts";

/**
 * Register this host's complete API, the batch route for its dashboard reads, and one OpenAPI
 * document, generated when first requested.
 */
export const selfHostApi = (document: LazyHostedApiDocument) =>
  Layer.mergeAll(layerWithBatches(ExecutorSelfHostApi), hostedApiDocumentRoute(document)).pipe(
    Layer.provide(hostedHandlers),
  );
