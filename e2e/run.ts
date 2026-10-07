/** CLI adapter for the shared suite lifecycle. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { runSuite } from "./sdk/suite.ts";

/**
 * Each worker runs its own product server, PGlite database and browser, which together keep about
 * two cores busy. Sixteen workers on 12-16 vCPUs starved servers for seconds at a time.
 */
const defaultWorkers = Math.max(1, Math.min(16, Math.floor(navigator.hardwareConcurrency / 2)));
const command = Command.make(
  "e2e",
  {
    target: Flag.Literals("target", ["self-host", "local", "cloud", "all", "hosted"]).pipe(
      Flag.withDefault("self-host"),
    ),
    name: Flag.String("test-name").pipe(Flag.withDefault("")),
    workers: Flag.Int("workers").pipe(Flag.withDefault(defaultWorkers)),
    // Start managed Cloud with the per-address auth limit on and run only the scenarios proving it.
    authRateLimit: Flag.Boolean("auth-rate-limit").pipe(Flag.withDefault(false)),
  },
  runSuite,
);
NodeRuntime.runMain(
  Command.run(command, { version: "1" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  ),
);
