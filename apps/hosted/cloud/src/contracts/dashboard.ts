/** The private binding between the API Worker and the Worker that renders dashboard documents. */
import type { CloudDocumentContext } from "@executor-js/hosted-cloud-web/document";
import type { RpcCallError } from "alchemy/Rpc";
import type { Effect } from "effect";

/**
 * One read of the API Worker's own routes, run through the document request's complete
 * pipeline in the API Worker. It crosses the binding as a callback, so reads keep the
 * document request's identity and trace without another public request.
 */
export type DocumentRead = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: ReadonlyArray<readonly [string, string]>;
  },
) => Promise<Response>;

/** Everything the renderer receives except the read itself, which is passed separately. */
export type DocumentRenderContext = Omit<CloudDocumentContext, "apiFetch">;

/** Rendering fails only with transport failures; a page that fails to render is a response. */
export type DashboardRenderer = {
  readonly render: (
    request: Request,
    context: DocumentRenderContext,
    read: DocumentRead,
  ) => Effect.Effect<Response, RpcCallError>;
};
