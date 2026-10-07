/** The hosted product's cloud services: policy, defaults and plumbing over one executor. */
import { hostedAppCapabilities } from "@executor-js/hosted-server/app-management";
import { AppManagementHost } from "@executor-js/app-management";
import {
  HostedExecutor,
  ScheduledAuthority,
  makeScheduledAuthority,
  OrganizationIcons,
  makeOrganizationIcons,
  OrganizationDefaults,
  makeOrganizationRemovals,
  OrganizationRemovals,
  OrganizationRemovalUnavailable,
  OrganizationTombstones,
  withExecutorAnalytics,
} from "@executor-js/hosted-server";
import { GroupDatabase, GroupsUnavailable } from "@executor-js/hosted-server/groups";
import type { HostedApiDocument } from "@executor-js/hosted-server/contracts";
import { HostedAppRuntime } from "@executor-js/hosted-server/app-ui";
import {
  AppRepositoryRecovery,
  RepositoryHost,
  StorageError,
  BlobStore,
} from "@executor-js/sdk/core";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { RuntimeContext } from "alchemy";
import type * as Cloudflare from "alchemy/Cloudflare";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { cloudBuildAsset } from "../implementation/build-storage.ts";
import { cachedBuildAssets } from "../implementation/asset-cache.ts";
import { AppDomainDatabase } from "../implementation/app-domain-records.ts";
import { UiFailed } from "apps/ui/contracts";
import type { ArtifactsTokens } from "@executor-js/app-source/cloudflare";
import { cloudBlobs } from "./blobs.ts";
import { cloudExecutor } from "./executor.ts";
import { cloudOrigin } from "./stage.ts";
import type { AppDataSupervisor } from "./app-data.ts";

/**
 * Every hosted service the cloud Workers provide, composed over {@link cloudExecutor}. The
 * executor is the only door to SDK data; these services add the product's access policy,
 * organization defaults and the per-event SQL client for the product's own tables.
 */
export const cloudProduct = Effect.fn(function* (
  databases: Cloudflare.DurableObject<AppDataSupervisor>,
  tokens: ArtifactsTokens,
) {
  const origin = yield* cloudOrigin.pipe(Effect.orDie);
  const blobs = yield* cloudBlobs;
  const { executor, database } = yield* cloudExecutor(databases, tokens);
  const assets = yield* makeExecutionMemo(
    cachedBuildAssets(origin, (build, path) =>
      cloudBuildAsset(build, path).pipe(Effect.provideService(BlobStore, blobs)),
    ),
  );
  // Alchemy's runtime requirement marks event-only operations; it is not a
  // service supplied to request fibers. Keep the live caller scope and tracer.
  const sdk = executor.pipe(Effect.provide(RuntimeContext.phantom));
  const sql = database.pipe(
    Effect.map((services) => Context.get(services, SqlClient.SqlClient)),
    Effect.provide(RuntimeContext.phantom),
  );
  // Product checks run on the event's connection, beside the executor's own reads.
  const withDatabase = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    database.pipe(
      Effect.flatMap((services) => work.pipe(Effect.provideContext(services))),
      Effect.provide(RuntimeContext.phantom),
    );
  const access = yield* makeExecutionMemo(
    withDatabase(hostedAppCapabilities).pipe(Effect.mapError(() => new StorageError())),
  );
  const scheduleAuthority = yield* makeExecutionMemo(
    sdk.pipe(
      Effect.flatMap((executor) => withDatabase(makeScheduledAuthority(executor))),
      Effect.mapError(() => new StorageError()),
    ),
  );
  // Serving an app does not install the default management app. Keep its API
  // document, templates and authoring files off the app-serving startup path.
  // The document depends only on the origin, so the isolate keeps the first one
  // generated for later provisioning runs instead of regenerating it per execution.
  let document: HostedApiDocument | undefined;
  const defaults = yield* makeExecutionMemo(
    Effect.gen(function* () {
      const { defaultApp, executorCloudApiDocument } = yield* Effect.promise(
        () => import("../implementation/default-app.ts"),
      );
      return yield* withDatabase(
        defaultApp(
          yield* sdk,
          origin,
          Effect.sync(() => (document ??= executorCloudApiDocument(origin))),
        ),
      );
    }).pipe(
      Effect.mapError(() => new StorageError()),
      Effect.withSpan("runtime.cloud.defaults.initialize"),
    ),
  );
  // Removal tombstones share the same client. The request check that hides a
  // removed organization and the workflow's writes read the same rows.
  const removals = makeOrganizationRemovals(
    sql.pipe(Effect.mapError(() => new OrganizationRemovalUnavailable())),
  );
  return Layer.mergeAll(
    Layer.succeed(HostedExecutor, sdk.pipe(Effect.map(withExecutorAnalytics))),
    Layer.succeed(
      AppManagementHost,
      Effect.all({ executor: sdk.pipe(Effect.map(withExecutorAnalytics)), access }).pipe(
        Effect.provide(RuntimeContext.phantom),
      ),
    ),
    Layer.succeed(ScheduledAuthority, (target) =>
      scheduleAuthority.pipe(
        Effect.flatMap((authority) => authority(target)),
        Effect.provide(RuntimeContext.phantom),
      ),
    ),
    Layer.succeed(
      AppRepositoryRecovery,
      sdk.pipe(Effect.flatMap((executor) => executor[RepositoryHost].recover)),
    ),
    Layer.succeed(OrganizationRemovals, removals.removals),
    Layer.succeed(OrganizationTombstones, removals.tombstones),
    Layer.succeed(GroupDatabase, sql.pipe(Effect.mapError(() => new GroupsUnavailable()))),
    Layer.succeed(
      AppDomainDatabase,
      sql.pipe(Effect.mapError(() => new UiFailed({ reason: "unavailable" }))),
    ),
    Layer.succeed(OrganizationIcons, makeOrganizationIcons(blobs)),
    Layer.succeed(HostedAppRuntime, {
      asset: ({ build, path }) =>
        assets.pipe(
          Effect.flatMap((read) => read(build, path)),
          Effect.provide(RuntimeContext.phantom),
        ),
    }),
    Layer.succeed(
      OrganizationDefaults,
      OrganizationDefaults.of((organization, user) =>
        defaults.pipe(
          Effect.flatMap((initialize) => initialize(organization, user)),
          Effect.provide(RuntimeContext.phantom),
        ),
      ),
    ),
  );
});
