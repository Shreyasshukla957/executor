import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Layer, Ref } from "effect";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { createServer } from "node:http";

/** The only token the fake service accepts. */
export const acceptedToken = "synthetic-check-token";

/** What the fake service answers for its current-user endpoint. */
export type AccountCheckAnswer =
  | { readonly kind: "user" }
  | {
      readonly kind: "status";
      readonly status: number;
      readonly headers?: Record<string, string>;
    }
  | { readonly kind: "hang" };

/**
 * A synthetic service with one safe read, `GET /me`. It returns a synthetic user for the accepted
 * token, 401 for any other token, or the configured answer.
 */
export const accountCheckUpstream = Effect.gen(function* () {
  const answer = yield* Ref.make<AccountCheckAnswer>({ kind: "user" });
  const routes = HttpRouter.add(
    "GET",
    "/me",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const current = yield* Ref.get(answer);
      if (current.kind === "hang") return yield* Effect.never;
      if (current.kind === "status")
        return yield* HttpServerResponse.json(
          { message: "synthetic failure" },
          { status: current.status, headers: current.headers },
        );
      if (request.headers.authorization !== `Bearer ${acceptedToken}`)
        return yield* HttpServerResponse.json({ message: "unauthorized" }, { status: 401 });
      return yield* HttpServerResponse.json({
        id: "user-4242",
        name: "Synthetic Person",
        login: "synthetic-person",
        avatar: "https://avatars.example.test/u/4242.png",
      });
    }),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return {
    origin: `http://127.0.0.1:${server.address.port}`,
    answer: (value: AccountCheckAnswer) => Ref.set(answer, value),
  };
});
