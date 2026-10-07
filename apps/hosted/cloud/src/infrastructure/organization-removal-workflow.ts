/**
 * Organization removal as one durable workflow. It is the same mechanism as
 * `AppWorkflows`: an Alchemy `Cloudflare.Workflow` class hosted by the API
 * Worker. Deployed cloud runs it on Cloudflare Workflows; `alchemy dev` runs
 * the identical class in the local workerd runtime, so there is no second
 * implementation and no Node fallback. Self-host composes no removal route at
 * all, so it needs no workflow here.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { Cause, Context, Effect, Schema } from "effect";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import {
  Authentication,
  HostedExecutor,
  OrganizationBilling,
  OrganizationIcons,
  OrganizationId,
  OrganizationRemovalFailed,
  OrganizationRemovals,
  OrganizationRemovalUnavailable,
  removeOrganizationDurably,
  type OrganizationRemovalStepRunner,
} from "@executor-js/hosted-server";
import { Billing } from "../contracts/billing.ts";
import { cloudSentry } from "../implementation/error-reporting.ts";

/**
 * One durable step. The engine owns the journal and the retries; a body that
 * still fails after them becomes a named failure, so the report and the failed
 * instance both say which step stopped and for which organization.
 */
const runner =
  (
    organization: OrganizationId,
  ): OrganizationRemovalStepRunner<Cloudflare.Workflows.WorkflowStep> =>
  <A>(
    name: Parameters<OrganizationRemovalStepRunner>[0],
    retries: Parameters<OrganizationRemovalStepRunner>[1],
    work: Effect.Effect<A, unknown>,
  ) =>
    Cloudflare.Workflows.task(
      name,
      work.pipe(
        Effect.withSpan("organization.removal.step", {
          attributes: { "executor.organization.id": organization, "executor.removal.step": name },
        }),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logError("Organization removal step failed", cause).pipe(
                Effect.andThen(
                  Effect.die(new OrganizationRemovalFailed({ organization, step: name })),
                ),
              ),
        ),
      ),
      { retries },
    );

export class OrganizationRemoval extends Cloudflare.Workflow<OrganizationRemoval>()(
  "OrganizationRemoval",
  Effect.gen(function* () {
    const reportErrors = yield* cloudSentry;
    // The Worker that yields this class supplies the services; Alchemy captures them. Only
    // these: the Worker's context also holds its own scope, and providing that to a run would
    // replace the run's scope, so per-execution resources would outlive the run.
    const services = yield* Effect.context<
      HostedExecutor | OrganizationIcons | OrganizationRemovals | Authentication | Billing
    >().pipe(
      Effect.map(
        Context.pick(
          HostedExecutor,
          OrganizationIcons,
          OrganizationRemovals,
          Authentication,
          Billing,
        ),
      ),
    );
    // Cancellation reaches the workflow as the host's billing service, not as a
    // branch on the deployment. A host without one keeps the inert default.
    const billing = Context.get(services, Billing);
    const cancellation = OrganizationBilling.of({
      cancel: (organization: OrganizationId) => billing.cancel(organization),
    });
    return (input: { organization: string }) =>
      Effect.suspend(() => {
        const organization = OrganizationId.make(input.organization);
        return removeOrganizationDurably(organization, runner(organization)).pipe(
          Effect.provide(services),
          Effect.provideService(OrganizationBilling, cancellation),
          // Report through the same Sentry boundary the API uses, carrying the
          // organization and the step in the failure itself, and then leave the
          // instance failed: nothing else watches a workflow that stops part
          // way through an irreversible erasure.
          reportErrors,
          Effect.orDie,
        );
      });
  }),
) {}

/** Start an organization's removal on the host's workflow binding. */
export class OrganizationRemovalStart extends Context.Service<
  OrganizationRemovalStart,
  (
    organization: OrganizationId,
    instance: string,
  ) => Effect.Effect<void, OrganizationRemovalUnavailable>
>()("executor/cloud/OrganizationRemovalStart") {}

/** Adopt the stable removal instance, including when a create response was lost. */
export const startOrganizationRemoval =
  (workflow: Effect.Success<typeof OrganizationRemoval>) =>
  (organization: OrganizationId, instance: string) =>
    Effect.gen(function* () {
      const status = workflow.get(instance).pipe(
        Effect.flatMap((run) => run.status()),
        Effect.map((state) => state.status),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed("unknown" as const),
        ),
      );
      if ((yield* status) !== "unknown") return;
      yield* workflow
        .create({ id: instance, params: { organization } })
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.flatMap(status, (current) =>
                  current === "unknown"
                    ? Effect.fail(new OrganizationRemovalUnavailable())
                    : Effect.void,
                ),
          ),
        );
    });

/** Tombstones are the durable start journal; recover a provider refusal or process loss. */
export const dispatchOrganizationRemovals = Effect.gen(function* () {
  const start = yield* OrganizationRemovalStart;
  const sql = yield* Effect.flatten(GroupDatabase);
  const pending = yield* sql`select organization_id, instance_id from hosted_organization_removal
    where status = 'running' order by started_at limit 50`.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            organization_id: OrganizationId,
            instance_id: Schema.NonEmptyString,
          }),
        ),
      ),
    ),
  );
  yield* Effect.forEach(
    pending,
    (record) =>
      start(record.organization_id, record.instance_id).pipe(
        Effect.catch(() =>
          Effect.logWarning("Organization removal start remains pending", {
            organization: record.organization_id,
          }),
        ),
      ),
    { concurrency: 2, discard: true },
  );
}).pipe(Effect.withSpan("job.organization-removal.dispatch"));
