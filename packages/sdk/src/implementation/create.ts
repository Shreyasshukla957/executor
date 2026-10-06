import { ProfileHost } from "../contracts/profiles.ts";
import { makeProfileSetup } from "./profile-setup.ts";
import { WorkflowHost } from "../contracts/workflow-runtime.ts";
import { makeWorkflowRuns } from "./workflows.ts";
/** Compose native operations once for in-process and HTTP callers. */
import { Crypto, Effect } from "effect";
import type { Executor, ExecutorOptions, RemoteExecutorOptions } from "../contracts/executor.ts";
import { NotImplemented, type AppId } from "../contracts/shared.ts";
import { makeWebhooks } from "./webhooks.ts";
import { makeAppData } from "./app-storage.ts";
import { makeAccountConnections } from "./account-connections.ts";
import { makeAccounts } from "./accounts.ts";
import { makeAccountHealth } from "./account-health.ts";
import { makeProfiles } from "./profiles.ts";
import { makeApps } from "./apps.ts";
import { makeOwners } from "./owners.ts";
import { makeSchedules } from "./schedules.ts";
import { makeTools } from "./tools.ts";
import { makeSkills } from "./skills.ts";
import { toEffectRuntime } from "./runtime.ts";
import { database } from "./database.ts";
import { makeOAuth } from "./oauth.ts";
import { makeDeclarationCache, makeDeclarations } from "./declarations.ts";
import { makeListings } from "./listings.ts";

/** Capture host cryptography; caller owns database and platform resource lifetimes. */
export const createExecutor = (
  options: ExecutorOptions,
): Effect.Effect<Executor, never, Crypto.Crypto> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const db = database(options.storage);
    const cache = options.declarations ?? makeDeclarationCache();
    const runtime = toEffectRuntime(options.runtime, options.blobs, cache);
    const oauth = makeOAuth(
      db,
      options.credentials,
      crypto,
      options.oauth,
      options.lifecycle,
      options.background,
    );
    const declarations = makeDeclarations({
      cache,
      durable: options.durableDeclarations,
      background: options.background,
      resolveAccount: oauth.resolveSelected,
      accountUsable: oauth.usable,
      crypto,
      lifecycle: options.lifecycle,
    });
    const workflows = makeWorkflowRuns(
      options.storage,
      runtime,
      oauth.resolveSelected,
      options.credentials,
      crypto,
      declarations,
      options.workflows,
      options.appStorage,
      options.lifecycle,
    );
    const webhooks = makeWebhooks(
      options.storage,
      runtime,
      oauth.resolveSelected,
      options.credentials,
      crypto,
      options.webhookOrigin,
      declarations,
      options.appStorage,
      workflows.controls,
      options.lifecycle,
    );
    const apps = {
      ...makeApps(db, runtime, crypto, options.sources, options.blobs, options.lifecycle),
      profiles: makeProfiles(db, crypto),
      workflows: { list: workflows.definitions },
      workflowRuns: workflows.runs,
    };
    const tools = makeTools(
      options.storage,
      oauth,
      runtime,
      options.credentials,
      crypto,
      makeListings({
        cache,
        background: options.background,
        declarations,
        resolveAccount: oauth.resolveSelected,
        lifecycle: options.lifecycle,
        ...(options.toolListings === undefined ? {} : { policy: options.toolListings }),
      }),
      options.appStorage,
      workflows.controls,
      options.lifecycle,
    );
    const connections = makeAccountConnections(db, options.credentials, crypto, options.lifecycle);
    const { checkCredentials, ...accountHealth } = makeAccountHealth(db, runtime, oauth, apps.list);
    const schedules = makeSchedules(options.storage, apps, tools, options.credentials, crypto);
    const setup = makeProfileSetup(db, crypto, apps.profiles, {
      webhooks: webhooks.webhooks,
      webhookDefinitions: webhooks.liveDefinitions,
      schedules: schedules.operations,
      reconcileSchedules: schedules.reconcile,
      runs: workflows.runs,
      accountNeedingReconnect: tools.accountNeedingReconnect,
    });
    // App source defines schedules. Each activation removes saved settings for schedules the new
    // deployment no longer declares. The activation has committed, so a deployment that cannot be
    // evaluated keeps them and the activation still succeeds. Profiles reconcile in setup.
    const activated = (app: AppId) =>
      schedules
        .activated(app)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              "Kept saved schedules: the activated deployment was not evaluated",
              error,
            ),
          ),
        );
    return {
      [ProfileHost]: { tick: setup.tick },
      [WorkflowHost]: workflows.host,
      scheduler: schedules.dispatcher,
      schedules: schedules.operations,
      accounts: {
        ...makeAccounts(db, options.credentials, crypto, options.lifecycle, oauth.revokeRemoved),
        ...accountHealth,
      },
      accountConnections: {
        ...connections,
        ...oauth.connections,
        findOAuth: (input) => Effect.flatMap(oauth.findOAuth(input), connections.get),
      },
      apps: {
        ...apps,
        deploy: (input) =>
          apps
            .deploy(input)
            .pipe(
              Effect.tap(({ app, deployment }) =>
                app.activeDeployment === deployment.id ? activated(app.id) : Effect.void,
              ),
            ),
        activate: (input) => apps.activate(input).pipe(Effect.tap((app) => activated(app.id))),
        profiles: setup.operations,
        checkCredentials,
      },
      owners: makeOwners(db),
      skills: makeSkills(db, runtime, crypto, declarations, options.blobs),
      webhooks: webhooks.webhooks,
      webhookSetup: webhooks.webhookSetup,
      appData: makeAppData(
        options.storage,
        oauth.resolveSelected,
        runtime,
        options.appStorage,
        workflows.controls,
        options.lifecycle,
      ),
      tools,
    };
  });

/** Remote transport is not implemented yet; it will expose the same native contract. */
export const createRemoteExecutor = (
  _options: RemoteExecutorOptions,
): Effect.Effect<Executor, NotImplemented> =>
  Effect.fail(new NotImplemented({ operation: "createRemoteExecutor" }));
