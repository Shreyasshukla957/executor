// ---------------------------------------------------------------------------
// The `executor.sh` front Worker (`wrangler.edge.jsonc`, Worker
// `executor-cloud-edge`).
//
// `executor-cloud` is placed near v1's database (`placement.region` in
// wrangler.jsonc), so every request it runs crosses to Virginia first. The
// requests its edge hands to v2 or to v1's marketing worker never use that
// database, yet each paid the trip: a 2 KB `/_astro/*` file took up to 2.6 s.
// This Worker has no placement and runs the same edge decision
// (./marketing.ts) where the request lands, on a zone route
// `executor.sh/*`. A zone route runs before the Worker on the hostname's
// Custom Domain, which Cloudflare treats as the origin, so a request v1 owns
// goes on with `fetch(request)` to `executor-cloud` unchanged: same URL,
// method, headers, cookies, body stream and redirect handling as before.
//
// `executor-cloud` keeps its own copy of the edge, which answers nothing this
// Worker passes on. Deleting this Worker (or its route) returns `executor.sh`
// to exactly that, which is the rollback.
// ---------------------------------------------------------------------------

import { marketingProxyRequest, v2EdgeResponse, type V2EdgeEnv } from "./marketing";
import { withPrivateReferrerPolicy } from "./referrer-policy";

/** The front Worker's bindings and settings (`wrangler.edge.jsonc`). */
export interface FrontEnv extends V2EdgeEnv {
  /** v1's marketing worker, which serves v1's legal pages. */
  readonly MARKETING?: { readonly fetch: (request: Request) => Promise<Response> };
}

/**
 * Answer an `executor.sh` request that v2 or v1's marketing worker owns,
 * exactly as `executor-cloud`'s entry does, including its `no-referrer`
 * policy. Returns `null` for every request `executor-cloud` serves itself.
 */
export const frontResponse = (request: Request, env: FrontEnv): Promise<Response> | null => {
  const v2 = v2EdgeResponse(request, env);
  if (v2) return v2.then(withPrivateReferrerPolicy);
  const marketingRequest = marketingProxyRequest(request);
  if (marketingRequest && env.MARKETING) {
    return env.MARKETING.fetch(marketingRequest).then(withPrivateReferrerPolicy);
  }
  return null;
};

export default {
  fetch: (request, env) => frontResponse(request, env) ?? fetch(request),
} satisfies ExportedHandler<FrontEnv>;
