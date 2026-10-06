/**
 * Choose the E2E scenarios each CI job runs.
 *
 * Pushes to `main` and manual runs get the full suite. A pull request runs the spec files its
 * description names in one fenced `e2e` block, plus every spec file the pull request changes:
 *
 * ```e2e
 * groups.spec.ts
 * app-cache.spec.ts
 * ```
 *
 * The block may instead say `all` or `none`. A pull request without the block runs the full suite.
 * Each job receives a `--test-name` pattern, or an empty output when none of its scenarios is
 * selected; the job is then skipped.
 *
 * The block may also say `skip` on the lower layer of a stack: another open pull request must
 * build on its branch. Every check then skips, and the layer above tests the combined change.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Option, Schema } from "effect";
import type { Target } from "./report-model.ts";
import { scenariosForSuite } from "./test-plan.ts";

class SelectionFailed extends Schema.TaggedError<SelectionFailed>()("SelectionFailed", {
  message: Schema.String,
}) {}

/** The Claude Code scenario needs a model API key, which CI does not hold. */
const claude = "Claude Code connects";
const inventoryLoad = "concurrent owners and admins save every account";
const catalogScale =
  "MCP execute over 7,000 tools|MCP execute pays for a slow app|MCP execute remembers a stalled";

/** Each output feeds one `--test-name` in checks.yml. Full runs use these patterns unchanged. */
const jobs = {
  local: { target: "local", pattern: `^(?!.*${claude})` },
  "self-host": {
    target: "self-host",
    pattern: `^(?!.*(?:${claude}|${inventoryLoad}|${catalogScale}))`,
  },
  "self-host-inventory": { target: "self-host", pattern: inventoryLoad },
  "self-host-catalog": { target: "self-host", pattern: catalogScale },
  // Other Cloud scenarios run against deployed stages after merge.
  cloud: {
    target: "cloud",
    pattern:
      "Cloud onboarding|Cloud OAuth callbacks|Cloud product events|Cloud feedback|Cloud tracks an unusable OAuth|app query traces|observability retains|browser decode and startup|optimistic replay failures|private app crash reports|Platform admin impersonation|Cloud reports the framework pin|Cloud deploys fail promptly when the compiler does not answer|refuses every stored state Better Auth refuses|Billing reconciles only while visible|A dashboard read refreshed while in flight|Cloud finishes a slow app's tool listing|Cloud remembers a stalled tool listing",
  },
  "cloud-workers": {
    target: "cloud",
    pattern:
      "app Workers stay loaded across credential rotation|workflow runs reuse the app Worker|warm app calls load no build|Cold app Workers reuse a build",
  },
} as const satisfies Record<string, { target: typeof Target.Type; pattern: string }>;

const plan = scenariosForSuite("all", "managed");
const specFiles: ReadonlySet<string> = new Set(plan.map((scenario) => scenario.file));
const escape = (title: string) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `all`, `skip`, or the spec files named in the description's single `e2e` block. */
const requested = (body: string) =>
  Effect.gen(function* () {
    const blocks = [...body.matchAll(/^```e2e[ \t]*\r?\n([\s\S]*?)^```/gm)];
    if (blocks.length === 0) return "all" as const;
    if (blocks.length > 1)
      return yield* new SelectionFailed({
        message: "The pull request description has more than one e2e block. Keep one.",
      });
    const tokens = blocks[0]![1]!.split(/[\s,]+/).filter((token) => token.length > 0);
    if (tokens.length === 1 && tokens[0] === "all") return "all" as const;
    if (tokens.length === 1 && tokens[0] === "none") return [];
    if (tokens.length === 1 && tokens[0] === "skip") return "skip" as const;
    const files = tokens.map((token) => token.replace(/^e2e\/tests\//, ""));
    const unknown = files.filter((file) => !specFiles.has(file));
    if (unknown.length > 0)
      return yield* new SelectionFailed({
        message: `The e2e block names spec files with no scenarios in e2e/test-plan.ts: ${unknown.join(", ")}. List files from e2e/tests/, or write all or none.`,
      });
    return files;
  });

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pullRequest = yield* Config.String("E2E_PULL_REQUEST").pipe(Config.withDefault(""));
    const body = yield* Config.String("E2E_SELECTION_BODY").pipe(Config.withDefault(""));
    const changed = yield* Config.String("E2E_CHANGED_FILES").pipe(Config.withDefault(""));
    const stackedAbove = yield* Config.String("E2E_STACKED_ABOVE").pipe(Config.withDefault(""));
    const output = yield* Config.String("GITHUB_OUTPUT").pipe(Config.option);
    const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);

    const named = pullRequest === "" ? ("all" as const) : yield* requested(body);
    if (named === "skip") {
      const above = stackedAbove.split(/\s+/).filter((number) => number.length > 0);
      if (above.length === 0)
        return yield* new SelectionFailed({
          message:
            "The e2e block says skip, but no open pull request builds on this branch. Only the lower layers of a stack may skip; select scenarios instead.",
        });
      const report = [
        "## E2E selection",
        "",
        `Skipped: a lower stack layer under ${above.map((number) => `#${number}`).join(", ")}. The layer above checks the combined change.`,
        "",
      ].join("\n");
      yield* Console.log(report);
      if (Option.isSome(output))
        yield* fs.writeFileString(output.value, "skip=true\n", { flag: "a" });
      if (Option.isSome(summary))
        yield* fs.writeFileString(summary.value, `${report}\n`, { flag: "a" });
      return;
    }
    const files =
      named === "all"
        ? undefined
        : new Set([
            ...named,
            ...changed
              .split("\n")
              .map((file) => file.trim())
              .filter((file) => file.startsWith("e2e/tests/"))
              .map((file) => file.slice("e2e/tests/".length))
              .filter((file) => specFiles.has(file)),
          ]);

    const selections = Object.entries(jobs).map(([job, { target, pattern }]) => {
      const base = new RegExp(pattern);
      const titles = plan
        .filter(
          (scenario) =>
            scenario.targets[target].status === "scheduled" &&
            base.test(scenario.title) &&
            (files === undefined || files.has(scenario.file)),
        )
        .map((scenario) => scenario.title);
      const selected =
        titles.length === 0
          ? ""
          : files === undefined
            ? pattern
            : `^(?:${titles.map(escape).join("|")})$`;
      return { job, count: titles.length, selected };
    });

    const lines = selections.map(({ job, selected }) => `${job}=${selected}`).join("\n");
    const report = [
      "## E2E selection",
      "",
      pullRequest === ""
        ? "Full suite: this run is not for a pull request."
        : files === undefined
          ? "Full suite: the pull request description asks for all, or has no e2e block."
          : files.size === 0
            ? "No E2E scenarios: the pull request selects none and changes no spec file."
            : `Spec files: ${[...files].sort().join(", ")}`,
      "",
      "| Job | Scenarios |",
      "| --- | --- |",
      ...selections.map(({ job, count }) => `| ${job} | ${count === 0 ? "skipped" : count} |`),
      "",
    ].join("\n");
    yield* Console.log(report);
    if (Option.isSome(output)) yield* fs.writeFileString(output.value, `${lines}\n`, { flag: "a" });
    if (Option.isSome(summary))
      yield* fs.writeFileString(summary.value, `${report}\n`, { flag: "a" });
  }).pipe(Effect.provide(NodeServices.layer)),
);
