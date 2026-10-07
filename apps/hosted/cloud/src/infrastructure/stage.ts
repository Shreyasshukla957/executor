/** Test stages are named `test-<slug>`. Each one derives its origin and owns generated secrets. */
import { AlchemyContext } from "alchemy/AlchemyContext";
import { Stage } from "alchemy/Stage";
import { isLoopbackHostname } from "@executor-js/utils/url-policy";
import { Config, Effect, Option, Schema } from "effect";

export const testStagePrefix = "test-";

/** The stage every push to `main` deploys. It serves real customers. */
export const productionStage = "v2";

/** Slugs map one-to-one to the stage's logical database name. */
export const TestStageSlug = Schema.String.check(
  Schema.makeFilter((value) => /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/.test(value), {
    message: "A test stage slug is 1-42 lowercase letters, digits and hyphens",
  }),
);

export interface TestStage {
  readonly name: string;
  readonly slug: string;
  readonly origin: string;
}

/**
 * Provisioning receives the stage as a service and the deployed Worker reads Alchemy's plain
 * binding. Jobs and tests outside Alchemy have neither and use explicit configuration.
 */
export const stageName = Effect.serviceOption(Stage).pipe(
  Effect.flatMap(
    Option.match({
      onSome: (stage) => Effect.succeed(Option.some(stage)),
      onNone: () => Config.String("ALCHEMY_STAGE").pipe(Config.option),
    }),
  ),
);

/** Only stages with the prefix are test stages. Every other stage keeps its explicit configuration. */
export const testStage = Effect.gen(function* () {
  const name = yield* stageName;
  if (Option.isNone(name) || !name.value.startsWith(testStagePrefix))
    return Option.none<TestStage>();
  const slug = yield* Schema.decodeUnknownEffect(TestStageSlug)(
    name.value.slice(testStagePrefix.length),
  );
  const domain = yield* Config.String("TEST_STAGE_DOMAIN").pipe(
    Config.withDefault("executor.engineering"),
  );
  return Option.some<TestStage>({ name: name.value, slug, origin: `https://${slug}.${domain}` });
});

const Origin = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
      } catch {
        return false;
      }
    },
    { message: "BETTER_AUTH_URL must be an HTTP(S) origin without a trailing slash" },
  ),
);

/** The zone that serves production. See `product-zone.ts` for its certificate rule. */
export const productZone = "executor.sh";

/**
 * A Worker's custom domain for this stage. Each new custom domain in the product zone orders a
 * certificate that Cloudflare then serves for the apex, so only production may add one.
 */
export const customDomain = (origin: URL) =>
  Effect.gen(function* () {
    const hostname = origin.hostname;
    const stage = Option.getOrUndefined(yield* stageName);
    if (
      (hostname === productZone || hostname.endsWith(`.${productZone}`)) &&
      stage !== productionStage
    )
      return yield* Effect.die(
        new Error(
          `Stage ${stage ?? "<unset>"} cannot use ${hostname}: only ${productionStage} may add a ` +
            `custom domain in ${productZone}. Use a test-stage domain instead.`,
        ),
      );
    return hostname;
  });

/** The public origin: derived from the stage name for test stages, configured everywhere else. */
export const cloudOrigin = testStage.pipe(
  Effect.flatMap(
    Option.match({
      onSome: (stage) => Effect.succeed(stage.origin),
      onNone: () =>
        Config.String("BETTER_AUTH_URL").pipe(Effect.flatMap(Schema.decodeUnknownEffect(Origin))),
    }),
  ),
);

/**
 * API Worker props: `AUTH_RATE_LIMIT_SWITCH` is true only under `alchemy dev`, from
 * `AlchemyContext.dev`, so every deployed Worker gets `false`. Read it from the Worker
 * environment, never through `Config`: Alchemy binds each `Config` read during initialization
 * from the deploy's own environment, over these props.
 */
export const authRateLimitSwitchBindings = Effect.gen(function* () {
  return { AUTH_RATE_LIMIT_SWITCH: (yield* AlchemyContext).dev };
});

/**
 * Whether Better Auth's per-address limit applies. Every request a test runner sends comes from
 * one address, so automated environments may turn it off; no deployed stage outside them can:
 *
 * - Production (`v2`) always enforces it, whatever its configuration says.
 * - A deployed `test-e2e-*` stage turns it off unless `TEST_STAGE_AUTH_RATE_LIMIT=true`.
 * - Cloud dev turns it off for `TEST_STAGE_AUTH_RATE_LIMIT=false` on a loopback origin, as the
 *   e2e harness asks. `localRuntime` is the Worker's `AUTH_RATE_LIMIT_SWITCH`, which only
 *   `alchemy dev` sets, so no deploy configuration reaches this branch, a loopback
 *   `BETTER_AUTH_URL` included.
 * - Every other stage enforces it.
 *
 * `scripts/check-auth-rate-limit.ts` checks these rules over every combination.
 */
export const cloudAuthRateLimit = (localRuntime: boolean) =>
  Effect.gen(function* () {
    // Read on every stage, so Alchemy binds it into the local Worker; only the rules use it.
    const configured = yield* Config.Boolean("TEST_STAGE_AUTH_RATE_LIMIT").pipe(Config.option);
    if (Option.getOrUndefined(yield* stageName) === productionStage) return true;
    const stage = yield* testStage;
    if (Option.isSome(stage))
      return stage.value.slug.startsWith("e2e-") ? Option.getOrElse(configured, () => false) : true;
    if (!localRuntime || !isLoopbackHostname(new URL(yield* cloudOrigin).hostname)) return true;
    return Option.getOrElse(configured, () => true);
  });
