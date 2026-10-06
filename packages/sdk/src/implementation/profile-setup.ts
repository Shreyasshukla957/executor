import { AppProviderFailed } from "../contracts/tools.ts";
/** Durable per-profile reconciliation. Leases cover network work without holding SQL transactions. */
import { Clock, Effect, Exit, Result, Schema, type Crypto } from "effect";
import { Profile, ProfileNotFound } from "../contracts/profiles.ts";
import { AccountRequired, AccountSelectionInvalid } from "../contracts/apps.ts";
import { AccountNotFound } from "../contracts/account.ts";
import { OAuthReconnectRequired } from "../contracts/oauth.ts";
import { WorkflowRunId } from "../contracts/workflows.ts";
import { WebhookFailed } from "../contracts/webhooks.ts";
import { StorageError, type AppId, type ProfileId, type Json } from "../contracts/shared.ts";
import type { Executor } from "../contracts/executor.ts";
import { query, transaction, type Query } from "./database.ts";
import { lockApp } from "./apps.ts";
import { storedProfile } from "./profiles.ts";
import type { makeProfiles } from "./profiles.ts";
import type { makeSchedules } from "./schedules.ts";
import type { makeTools } from "./tools.ts";

const canonical = (value: Json): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`)
          .join(",")}}`
      : JSON.stringify(value);

/** All derived resources refer to the real app and profile; retries preserve their identities. */
export const makeProfileSetup = (
  db: Query,
  crypto: Crypto.Crypto,
  profiles: ReturnType<typeof makeProfiles>,
  resources: Pick<Executor, "webhooks" | "schedules"> & {
    readonly runs: Executor["apps"]["workflowRuns"];
    /** Evaluated now, never reused: reconciliation changes upstream registrations. */
    readonly webhookDefinitions: Executor["webhooks"]["definitions"];
    /** Stored-state check for a selected account whose sign-in must reconnect. */
    readonly accountNeedingReconnect: ReturnType<typeof makeTools>["accountNeedingReconnect"];
    /** Evaluates the active deployment for this profile and removes undeclared schedules. */
    readonly reconcileSchedules: ReturnType<typeof makeSchedules>["reconcile"];
  },
) => {
  const now = Clock.currentTimeMillis;
  const keyFor = (value: Json) =>
    crypto.digest("SHA-256", new TextEncoder().encode(canonical(value))).pipe(
      Effect.map(
        (bytes) =>
          `setup-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
      ),
      Effect.mapError(() => new StorageError()),
    );
  const reconcile = (input: { app: AppId; profile: ProfileId }, automatic = false) =>
    Effect.gen(function* () {
      const token = yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => new StorageError()));
      return yield* Effect.acquireUseRelease(
        transaction(db, (tx) =>
          Effect.gen(function* () {
            const app = yield* lockApp(tx, input);
            const current = yield* storedProfile(tx, input);
            const row = yield* query(() =>
              tx.findFirst("profiles", { where: (b) => b("id", "=", current.id) }),
            );
            if (!row) return yield* new ProfileNotFound(input);
            const time = yield* now;
            if (
              current.status === "removed" ||
              (row.lease !== null && row.leaseUntil.getTime() > time) ||
              (automatic && current.status !== "pending" && row.leaseUntil.getTime() > time)
            )
              return { app, current, claimed: false };
            if (
              (current.status === "ready" || current.status === "disabled") &&
              current.reconciledDeployment === app.activeDeployment &&
              current.reconciledRevision === current.revision
            )
              return { app, current, claimed: false };
            yield* query(() =>
              tx.updateMany("profiles", {
                where: (b) => b("id", "=", current.id),
                set: { lease: token, leaseUntil: new Date(time + 120_000) },
              }),
            );
            return { app, current, claimed: true };
          }),
        ),
        (claim) =>
          Effect.gen(function* () {
            if (!claim.claimed) return claim.current;
            const { app, current } = claim;
            let failure: Profile["failure"] = null;
            const stopping = current.status === "removing" || !current.enabled;
            let status: Profile["status"] =
              current.status === "removing" ? "removing" : current.enabled ? "ready" : "disabled";
            const attempt = yield* Effect.gen(function* () {
              const hooks = yield* resources.webhooks.list(input);
              const schedules = yield* resources.schedules.list(input);
              if (stopping) {
                // A disabled profile gates execution without discarding schedule preferences.
                for (const schedule of schedules)
                  if (current.status === "removing" && schedule.enabled)
                    yield* resources.schedules.configure({
                      ...input,
                      name: schedule.name,
                      actor: current.subject,
                      enabled: false,
                    });
                let cursor: import("../contracts/workflows.ts").WorkflowRunId | undefined;
                do {
                  const page = yield* resources.runs.list({ ...input, cursor });
                  for (const run of page.items)
                    if (
                      run.status !== "complete" &&
                      run.status !== "errored" &&
                      run.status !== "terminated"
                    )
                      yield* resources.runs.terminate({ app: app.id, run: run.id });
                  cursor = page.next === undefined ? undefined : WorkflowRunId.make(page.next);
                } while (cursor !== undefined);
                for (const schedule of schedules) {
                  if (schedule.activeRun !== null) {
                    const approval = yield* resources.schedules
                      .approval({ run: schedule.activeRun })
                      .pipe(Effect.result);
                    if (
                      Result.isSuccess(approval) &&
                      approval.success.run.status === "awaiting-approval"
                    )
                      yield* resources.schedules.answer({
                        run: schedule.activeRun,
                        action: "decline",
                      });
                    failure = "cleanup";
                  }
                }
                for (const hook of hooks)
                  if (hook.status !== "stopped") {
                    const stopped = yield* resources.webhooks.remove({
                      app: app.id,
                      subscription: hook.id,
                    });
                    if (stopped.status !== "stopped") {
                      failure = "cleanup";
                      status = current.status === "removing" ? "removing" : "failed";
                    }
                  }
                if (failure === null)
                  status = current.status === "removing" ? "removed" : "disabled";
                else if (current.status !== "removing") status = "failed";
                return;
              }
              if (app.activeDeployment === null) {
                status = "needs-setup";
                failure = "deployment";
                return;
              }
              const definitions = yield* resources.webhookDefinitions(input);
              const desired = new Set<string>();
              for (const hook of definitions) {
                const selected = current.accounts[hook.account];
                if (selected === undefined) {
                  status = "needs-setup";
                  failure = "accounts";
                  continue;
                }
                const suppliedConfig = current.webhookConfig[hook.name];
                const config = suppliedConfig === undefined ? {} : suppliedConfig;
                for (const account of typeof selected === "string" ? [selected] : selected) {
                  const key = yield* keyFor({
                    name: hook.name,
                    account,
                    config,
                    accounts: current.accounts,
                    deployment: app.activeDeployment,
                    revision: current.revision,
                  });
                  desired.add(key);
                  const created = yield* resources.webhooks.create({
                    ...input,
                    name: hook.name,
                    expectedProfileRevision: current.revision,
                    sourceAccount: account,
                    key,
                    config,
                  });
                  const subscription =
                    created.status === "pending"
                      ? yield* resources.webhooks.reconcile({
                          app: app.id,
                          subscription: created.id,
                        })
                      : created;
                  if (subscription.status === "setup-required") {
                    status = "needs-setup";
                    failure = "configuration";
                  } else if (subscription.status !== "active") {
                    status = "failed";
                    failure = "registration";
                  }
                }
              }
              // Old registrations retain the code/state required for their own cleanup.
              for (const hook of hooks)
                if (
                  hook.key.startsWith("setup-") &&
                  !desired.has(hook.key) &&
                  hook.status !== "stopped"
                ) {
                  const stopped = yield* resources.webhooks.remove({
                    app: app.id,
                    subscription: hook.id,
                  });
                  if (stopped.status !== "stopped") {
                    status = "failed";
                    failure = "cleanup";
                  }
                }
              // Settings of schedules the active deployment no longer declares are deleted.
              const declaredSchedules = yield* resources.reconcileSchedules(input);
              for (const schedule of declaredSchedules) {
                const previous = schedules.find((item) => item.name === schedule.name);
                yield* resources.schedules.configure({
                  ...input,
                  name: schedule.name,
                  actor: current.subject,
                  expectedProfileRevision: current.revision,
                  enabled: previous?.enabled ?? false,
                  approvalMode: previous?.approvalMode ?? "automatic",
                });
              }
            }).pipe(Effect.timeout("90 seconds"), Effect.result);
            if (Result.isFailure(attempt)) {
              status = current.status === "removing" ? "removing" : "failed";
              failure = stopping ? "cleanup" : "registration";
              const error = attempt.failure;
              if (
                !stopping &&
                (Schema.is(AccountRequired)(error) ||
                  Schema.is(AccountNotFound)(error) ||
                  Schema.is(AccountSelectionInvalid)(error) ||
                  Schema.is(OAuthReconnectRequired)(error) ||
                  (Schema.is(AppProviderFailed)(error) &&
                    (error.reason === "unauthorized" || error.reason === "forbidden")))
              ) {
                status = "needs-setup";
                failure = "accounts";
              }
              if (!stopping && Schema.is(WebhookFailed)(error) && error.reason === "input") {
                status = "needs-setup";
                failure = "configuration";
              }
            }
            return yield* transaction(db, (tx) =>
              Effect.gen(function* () {
                const liveApp = yield* lockApp(tx, input);
                const live = yield* storedProfile(tx, input);
                const row = yield* query(() =>
                  tx.findFirst("profiles", { where: (b) => b("id", "=", current.id) }),
                );
                if (row?.lease !== token) return live;
                const changed =
                  live.revision !== current.revision ||
                  liveApp.activeDeployment !== app.activeDeployment ||
                  (live.status === "removing" && current.status !== "removing");
                const next = changed
                  ? live.status === "removing"
                    ? "removing"
                    : "pending"
                  : status;
                const completedAt = yield* now;
                yield* query(() =>
                  tx.updateMany("profiles", {
                    where: (b) => b("id", "=", live.id),
                    set: {
                      status: next,
                      failure: changed ? null : failure,
                      lease: null,
                      leaseUntil: new Date(
                        completedAt +
                          (changed || next === "ready" || next === "disabled" || next === "removed"
                            ? 0
                            : 30_000),
                      ),
                      ...(next === "ready" || next === "disabled"
                        ? {
                            reconciledDeployment: app.activeDeployment,
                            reconciledRevision: current.revision,
                          }
                        : {}),
                      ...(next === "removed" ? { accounts: {}, webhookConfig: {} } : {}),
                    },
                  }),
                );
                return yield* storedProfile(tx, input);
              }),
            );
          }),
        (claim, exit) =>
          !claim.claimed || Exit.isSuccess(exit)
            ? Effect.void
            : transaction(db, (tx) =>
                Effect.gen(function* () {
                  // Acquire/release owns the claim across interruption and defects too.
                  // A completed or superseded claim must never release another worker's lease.
                  yield* lockApp(tx, input);
                  yield* query(() =>
                    tx.updateMany("profiles", {
                      where: (b) => b.and(b("id", "=", input.profile), b("lease", "=", token)),
                      set: { lease: null, leaseUntil: new Date(0) },
                    }),
                  );
                }),
              ).pipe(Effect.orDie),
      );
    }).pipe(
      Effect.withSpan("sdk.profiles.reconcile", {
        attributes: {
          "executor.app.id": input.app,
          "executor.profile.id": input.profile,
          "executor.profile.automatic": automatic,
        },
      }),
    );
  return {
    operations: {
      ...profiles,
      reconcile: (input: { app: AppId; profile: ProfileId }) => reconcile(input),
      remove: (input: { app: AppId; profile: ProfileId }) =>
        profiles.remove(input).pipe(Effect.andThen(reconcile(input))),
    },
    tick: (limit: number) =>
      Effect.gen(function* () {
        const time = new Date(yield* now);
        // New saved intent must run immediately, ahead of retries: a backlog of failed or
        // waiting setup never delays a profile someone just changed.
        const intent = yield* query(() =>
          db.findMany("profiles", {
            where: (b) => b.and(b("status", "=", "pending"), b("lease", "is", null)),
            orderBy: ["leaseUntil", "asc"],
            limit,
          }),
        );
        // An active worker keeps its lease; failed unchanged intent keeps its retry delay.
        const retries =
          intent.length >= limit
            ? []
            : yield* query(() =>
                db.findMany("profiles", {
                  where: (b) =>
                    b.and(
                      b("status", "!=", "removed"),
                      b("status", "!=", "ready"),
                      b("status", "!=", "disabled"),
                      b("leaseUntil", "<=", time),
                      b.or(b("status", "!=", "pending"), b("lease", "is not", null)),
                    ),
                  orderBy: ["leaseUntil", "asc"],
                  limit: limit - intent.length,
                }),
              );
        // Setup that failed on its accounts cannot succeed while one of them must reconnect or a
        // required account is unselected: every attempt would evaluate the app, or fail before it,
        // only to record the same failure. Wait instead, checking stored state once per retry
        // delay; selecting an account saves new intent, which runs at once. Any other problem is
        // left to reconciliation, which records it.
        const ready = yield* Effect.filter(retries, (row) =>
          row.failure !== "accounts" || row.lease !== null
            ? Effect.succeed(true)
            : resources.accountNeedingReconnect({ app: row.app, profile: row.id }).pipe(
                Effect.map((account) => account !== undefined),
                Effect.catchIf(Schema.is(AccountRequired), () => Effect.succeed(true)),
                Effect.catch(() => Effect.succeed(false)),
                Effect.flatMap((waiting) =>
                  !waiting
                    ? Effect.succeed(true)
                    : query(() =>
                        db.updateMany("profiles", {
                          where: (b) =>
                            b.and(
                              b("id", "=", row.id),
                              b("lease", "is", null),
                              b("leaseUntil", "=", row.leaseUntil),
                            ),
                          set: { leaseUntil: new Date(time.getTime() + 30_000) },
                        }),
                      ).pipe(Effect.as(false)),
                ),
              ),
        );
        const reconciled = yield* Effect.forEach(
          [...intent, ...ready],
          (row) =>
            reconcile({ app: row.app, profile: row.id }, true).pipe(
              Effect.as(true),
              Effect.catch(() =>
                Effect.logError("Profile reconciliation failed").pipe(Effect.as(false)),
              ),
            ),
          { concurrency: 4 },
        );
        // A full batch of saved intent may have left more behind. Continue while it makes
        // progress; a batch whose intent all failed waits for the host's next wake, so intent
        // that keeps failing never keeps the host busy.
        return intent.length >= limit && reconciled.slice(0, intent.length).some(Boolean);
      }),
  };
};
