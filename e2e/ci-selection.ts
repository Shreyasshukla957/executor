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
 * The block may instead say `none`, or `all` followed by the reason the change needs every
 * scenario. A pull request without the block fails selection, so every run is a deliberate choice.
 * So does a name these jobs would not run: one that is not a spec file in e2e/tests/, or one that
 * another `e2e/*.config.ts` runs, which the failure names with the workflow that runs it.
 * Each job receives a `--test-name` pattern, or an empty output when none of its scenarios is
 * selected; the job is then skipped.
 *
 * The block may also say `skip` on the lower layer of a stack: another open pull request must
 * build on its branch. Every check then skips, and the layer above tests the combined change.
 *
 * The description is read when the job runs. `gh stack submit` opens each pull request before
 * its author writes the description, and opens a stack's layers one at a time, so the job waits
 * a few minutes for an e2e block, and for a pull request above a `skip` layer, before it fails.
 *
 * A scenario that guards a dependency patch also runs whenever the pull request's tree pins that
 * dependency or its patch differently from main, whatever the block says. So does a scenario that
 * guards a file stating a whole contract, such as the host's app protocols, when that file differs.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Clock,
  Config,
  Console,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createHash } from "node:crypto";
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
/**
 * Flaky on the self-host job: the saved array choice is lost after superseded profile reads.
 * Skipped until https://github.com/UsefulSoftwareCo/executor-next/issues/1743 is fixed.
 */
const flakyProfilePicker = "profile picker keeps scalar and array choices isolated across tabs";

/** Each output feeds one `--test-name` in checks.yml. Full runs use these patterns unchanged. */
const jobs = {
  local: { target: "local", pattern: `^(?!.*${claude})` },
  "self-host": {
    target: "self-host",
    pattern: `^(?!.*(?:${claude}|${inventoryLoad}|${catalogScale}|${flakyProfilePicker}))`,
  },
  "self-host-inventory": { target: "self-host", pattern: inventoryLoad },
  "self-host-catalog": { target: "self-host", pattern: catalogScale },
  // Other Cloud scenarios run against deployed stages after merge.
  cloud: {
    target: "cloud",
    pattern:
      "Cloud onboarding|Cloud OAuth callbacks|Cloud product events|Cloud feedback|Cloud tracks an unusable OAuth|app query traces|observability retains|browser decode and startup|Browser connection failures explain|optimistic replay failures|private app crash reports|Platform admin impersonation|Cloud reports the framework pin|Cloud deploys fail promptly when the compiler does not answer|refuses every stored state Better Auth refuses|Billing reconciles only while visible|A dashboard read refreshed while in flight|Cloud finishes a slow app's tool listing|Cloud remembers a stalled tool listing|Cloud keeps each JSON Schema definition a tool listing repeats once|definitions share a name and length but not their JSON|definition names are long and of one length|Cloud MCP session objects (?:hold|make)|Cloud MCP request spans say whether|database failure while verifying an API key|Cloud cron wakes the schedule coordinator|Cloud runs a due schedule and requested profile setup while|app evaluation failures explain the likely cause|client request rejections are recorded on their request span|failure text reaches its caller|an app request Executor's network failed to send|MCP tool calls deliver their tool name and outcome|Executor time|Cloud serves a tool listing its isolate cannot keep|Cloud writes the background refresh of a stale tool listing|Owners delete an organization with every app|Hosted MCP negotiates older protocol versions|Hosted MCP ends a cancelled call|Cloud copies each build's browser files",
  },
  "cloud-workers": {
    target: "cloud",
    pattern:
      "app Workers stay loaded across credential rotation|workflow runs reuse the app Worker|warm app calls load no build|Cold app Workers reuse a build",
  },
  // These hold row locks in the shared Cloud database, which would stall other scenarios' SQL.
  // Removal recovery also needs the alarm and the removal job to itself while it holds one.
  "cloud-locks": {
    target: "cloud",
    pattern: "A Better Auth query|Cloud starts organization removals whose Workflow start stalled",
  },
  // This counts every request in local Cloud's single session object isolate, so another
  // scenario's MCP request in flight would change its count.
  "cloud-isolate": { target: "cloud", pattern: "Cloud MCP session objects report" },
} as const satisfies Record<string, { target: typeof Target.Type; pattern: string }>;

const plan = scenariosForSuite("all", "managed");
const specFiles: ReadonlySet<string> = new Set(plan.map((scenario) => scenario.file));
const escape = (title: string) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Spec files with a scenario that one of these jobs runs on a full run. */
const jobFiles: ReadonlySet<string> = new Set(
  plan
    .filter((scenario) =>
      Object.values(jobs).some(
        ({ target, pattern }) =>
          scenario.targets[target].status === "scheduled" &&
          new RegExp(pattern).test(scenario.title),
      ),
    )
    .map((scenario) => scenario.file),
);

/**
 * Bun applies a patch only while its selector names the installed version, and applies hunks that
 * still fit after an upgrade; it reports neither. Only these scenarios show that a patch still does
 * its job, so they run whenever a dependency's version or patch differs from main's. The tree is
 * compared with main, not the pull request's base, so the top of a stack counts every layer.
 */
const patchGuards: Readonly<Record<string, ReadonlyArray<string>>> = {
  "@opencode-ai/codemode": ["mcp-catalog.spec.ts"],
  effect: ["mcp-telemetry-privacy.spec.ts", "mcp-protocol-versions.spec.ts"],
};

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);

/** A dependency's pinned version, override and patch selectors with their file's Git blob ID. */
const pinned = (
  manifest: typeof Manifest.Type,
  dependency: string,
  blob: (path: string) => string | undefined,
) =>
  JSON.stringify([
    manifest.dependencies?.[dependency],
    manifest.overrides?.[dependency],
    Object.entries(manifest.patchedDependencies ?? {})
      .filter(([selector]) => selector.startsWith(`${dependency}@`))
      .map(([selector, path]) => [selector, blob(path)]),
  ]);

/** A file's Git blob ID, as the contents API reports it. */
const blobId = (bytes: Uint8Array) =>
  createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");

/** Guard spec files for every dependency this tree pins differently from main. */
const guardedPatches = (mainManifest: string, mainPatches: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const main = yield* Schema.decodeUnknownEffect(Manifest)(mainManifest);
    const head = yield* Schema.decodeUnknownEffect(Manifest)(
      yield* fs.readFileString("package.json"),
    );
    // Main's patch directory as `<blob ID> <file name>` lines, from the contents API.
    const mainBlobs = new Map(
      mainPatches
        .split("\n")
        .map((line) => line.trim().split(" "))
        .filter((parts) => parts.length === 2)
        .map(([id, name]) => [`patches/${name}`, id]),
    );
    const headBlobs = new Map<string, string>();
    for (const path of Object.values(head.patchedDependencies ?? {}))
      if (yield* fs.exists(path)) headBlobs.set(path, blobId(yield* fs.readFile(path)));
    return Object.entries(patchGuards).flatMap(([dependency, specs]) =>
      pinned(main, dependency, (path) => mainBlobs.get(path)) ===
      pinned(head, dependency, (path) => headBlobs.get(path))
        ? []
        : specs,
    );
  });

/**
 * Scenarios that assert a contract one file states in full. app-package.spec.ts reads back every
 * protocol the host supports when it rejects an unsupported framework, so a new protocol changes
 * its expected message. These run whenever the file differs from main's, so the top of a stack
 * runs them when a lower layer changes it.
 */
const fileGuards: Readonly<Record<string, ReadonlyArray<string>>> = {
  "packages/sdk/src/implementation/app-protocols.ts": [
    "app-package.spec.ts",
    "app-older-protocols.spec.ts",
  ],
};

/**
 * Guard spec files for every guarded file whose contents differ from main's. `mainListing` reads
 * one of main's directories as `<blob ID> <path>` lines; a file missing from it counts as changed.
 */
const guardedFiles = <E, R>(mainListing: (directory: string) => Effect.Effect<string, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mainBlobs = new Map<string, string>();
    for (const directory of new Set(Object.keys(fileGuards).map((file) => path.dirname(file))))
      for (const line of (yield* mainListing(directory)).split("\n")) {
        const [id, file] = line.trim().split(" ");
        if (id !== undefined && file !== undefined) mainBlobs.set(file, id);
      }
    const guards: Array<string> = [];
    for (const [file, specs] of Object.entries(fileGuards)) {
      const head = (yield* fs.exists(file)) ? blobId(yield* fs.readFile(file)) : undefined;
      if (head !== mainBlobs.get(file)) guards.push(...specs);
    }
    return guards;
  });

const example = "```e2e\ngroups.spec.ts\ninvitation-roles.spec.ts\n```";

/** The config that runs a spec file outside these jobs, and the commands and workflows that run it. */
interface Suite {
  readonly config: string;
  readonly commands: ReadonlyArray<string>;
  readonly workflows: ReadonlyArray<string>;
}

const PackageScripts = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) });
/**
 * The other `e2e/*.config.ts` files, imported only when a selection needs them. Each specifier is a
 * literal so e2e/check-boundary.ts can check it; a config missing here fails the selection.
 */
const suiteConfigs: Record<string, () => Promise<unknown>> = {
  "apps-published.config.ts": () => import("./apps-published.config.ts"),
  "billing.config.ts": () => import("./billing.config.ts"),
  "ci-selection.config.ts": () => import("./ci-selection.config.ts"),
  "dashboard-file-names.config.ts": () => import("./dashboard-file-names.config.ts"),
  "desktop-recovery.config.ts": () => import("./desktop-recovery.config.ts"),
  "desktop-release.config.ts": () => import("./desktop-release.config.ts"),
  "docker-release.config.ts": () => import("./docker-release.config.ts"),
  "local-bootstrap.config.ts": () => import("./local-bootstrap.config.ts"),
  "pglite.config.ts": () => import("./pglite.config.ts"),
  "typecheck-runner.config.ts": () => import("./typecheck-runner.config.ts"),
  "welcome-email.config.ts": () => import("./welcome-email.config.ts"),
};
/** The part of a config module's default export that says which files Vitest runs. */
const SuiteConfig = Schema.Struct({
  default: Schema.Struct({ test: Schema.Struct({ include: Schema.Array(Schema.String) }) }),
});

/**
 * Spec files the other `e2e/*.config.ts` files run, with the package scripts and workflows that
 * pass each config to Vitest. Each config is imported, as Vitest does, and its exported
 * `test.include` is read, so the list may be built with variables and other `include` options do
 * not count.
 */
const separateSuites = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const e2e = yield* path.fromFileUrl(new URL(".", import.meta.url));
  const root = path.dirname(e2e);
  const { scripts } = yield* fs
    .readFileString(path.join(root, "package.json"))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PackageScripts))));
  const workflowDirectory = path.join(root, ".github", "workflows");
  const workflows = yield* Effect.forEach(
    (yield* fs.readDirectory(workflowDirectory)).filter((name) => name.endsWith(".yml")).sort(),
    (name) =>
      fs.readFileString(path.join(workflowDirectory, name)).pipe(
        Effect.map((text) => ({
          label: `${/^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? name} (.github/workflows/${name})`,
          text,
        })),
      ),
  );
  const suites = new Map<string, Suite>();
  const configs = (yield* fs.readDirectory(e2e))
    .filter((name) => name.endsWith(".config.ts") && name !== "vitest.config.ts")
    .sort();
  const unlisted = configs.filter((name) => !(name in suiteConfigs));
  const missing = Object.keys(suiteConfigs).filter((name) => !configs.includes(name));
  if (unlisted.length > 0 || missing.length > 0)
    return yield* new SelectionFailed({
      message: `suiteConfigs in e2e/ci-selection.ts must list every e2e/*.config.ts except vitest.config.ts, so the selection can tell which suite runs each spec file. ${[
        ...unlisted.map((name) => `Add e2e/${name}.`),
        ...missing.map((name) => `Remove ${name}, which no longer exists.`),
      ].join(" ")}`,
    });
  for (const name of configs) {
    const config = `e2e/${name}`;
    const unsupported = `${config} must export a config object whose test.include lists e2e/tests/*.spec.ts paths, so the selection can tell which suite runs them.`;
    const module = yield* Effect.tryPromise({
      try: suiteConfigs[name]!,
      catch: (cause) =>
        new SelectionFailed({ message: `${config} failed to load: ${String(cause)}` }),
    });
    const { include } = (yield* Schema.decodeUnknownEffect(SuiteConfig)(module).pipe(
      Effect.mapError(() => new SelectionFailed({ message: unsupported })),
    )).default.test;
    const files = include.flatMap(
      (file) => /^e2e\/tests\/([\w.-]+\.spec\.ts)$/.exec(file)?.[1] ?? [],
    );
    if (files.length === 0 || files.length !== include.length)
      return yield* new SelectionFailed({ message: unsupported });
    const passesConfig = new RegExp(`--config[= ]${escape(config)}(?![\\w.-])`);
    const commands = Object.entries(scripts)
      .filter(([, command]) => passesConfig.test(command))
      .map(([script]) => `bun run ${script}`);
    const runs = (text: string) =>
      passesConfig.test(text) ||
      commands.some((command) => new RegExp(`${escape(command)}(?![\\w:-])`).test(text));
    for (const file of files)
      suites.set(file, {
        config,
        commands,
        workflows: workflows.filter(({ text }) => runs(text)).map(({ label }) => label),
      });
  }
  return suites;
});

/** Where a spec file these jobs never run does run, for the failure message. */
const runsElsewhere = (file: string, suite: Suite | undefined) => {
  if (suite === undefined)
    return `- ${file}: these jobs exclude all of its scenarios (see the job patterns in e2e/ci-selection.ts).`;
  const command = suite.commands[0] ?? `bunx vitest run --config ${suite.config}`;
  return suite.workflows.length === 0
    ? `- ${file} runs only by hand, with ${suite.config}: ${command}. No workflow runs it.`
    : `- ${file} runs with ${suite.config} in ${suite.workflows.join(" and ")}. Locally: ${command}.`;
};

/** The trimmed text of each `e2e` block in a description. */
const blocksIn = (body: string) =>
  [...body.matchAll(/^```e2e[ \t]*\r?\n([\s\S]*?)^```/gm)].map((match) => match[1]!.trim());

/** A wait as written in a sentence, such as "3 minutes". */
const spoken = (duration: Duration.Duration) => {
  const seconds = Duration.toSeconds(duration);
  return seconds % 60 === 0 && seconds > 0
    ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}`
    : `${seconds} second${seconds === 1 ? "" : "s"}`;
};

/** Runs `gh` with the job's token and returns what it prints. */
const gh = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* processes.spawn(ChildProcess.make("gh", args));
    const [output, error, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0)
      return yield* new SelectionFailed({
        message: `gh ${args.join(" ")} failed: ${error.trim()}`,
      });
    return output;
  }).pipe(Effect.scoped);

/**
 * The pull request's description and the open pull requests based on its branch, read again
 * every `poll` while the description lacks an e2e block, or says `skip` with nothing above it,
 * until `wait` has passed. Edits are not reread once the description is complete: a later
 * change to the block takes a push or a rerun.
 */
const readPullRequest = (input: {
  readonly repository: string;
  readonly number: string;
  readonly headRef: string;
  readonly wait: Duration.Duration;
  readonly poll: Duration.Duration;
}) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;
    const waitedFor: Array<string> = [];
    for (;;) {
      const body = yield* gh([
        "api",
        `repos/${input.repository}/pulls/${input.number}`,
        "--jq",
        '.body // ""',
      ]);
      const parsed = parseRequested(body);
      const skip = parsed._tag === "Skip";
      const above = skip
        ? (yield* gh([
            "pr",
            "list",
            "--repo",
            input.repository,
            "--base",
            input.headRef,
            "--state",
            "open",
            "--json",
            "number",
            "--jq",
            ".[].number",
          ]))
            .split(/\s+/)
            .filter((number) => number.length > 0)
        : [];
      const missing =
        parsed._tag === "Missing"
          ? "an e2e block in the description"
          : skip && above.length === 0
            ? "an open pull request based on this branch"
            : undefined;
      const elapsed = Duration.millis((yield* Clock.currentTimeMillis) - start);
      if (missing === undefined || Duration.isGreaterThanOrEqualTo(elapsed, input.wait)) {
        if (waitedFor.length > 0)
          yield* Console.log(
            `Waited ${Math.round(Duration.toSeconds(elapsed))} s for ${waitedFor.join(", then ")}${missing === undefined ? "." : `; there is still no ${missing.replace(/^an? /, "")}.`}`,
          );
        return { parsed, above };
      }
      if (waitedFor.at(-1) !== missing) {
        waitedFor.push(missing);
        yield* Console.log(`Waiting up to ${spoken(input.wait)} for ${missing}.`);
      }
      yield* Effect.sleep(input.poll);
    }
  });

/** What the description's e2e block asks for, parsed once for both the wait and the selection. */
type Requested =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Several" }
  | { readonly _tag: "AllWithoutReason" }
  | { readonly _tag: "All"; readonly reason: string }
  | { readonly _tag: "Skip" }
  | { readonly _tag: "Named"; readonly tokens: ReadonlyArray<string> };

/** The full suite with its reason, `skip`, or the names written in the single `e2e` block. */
const parseRequested = (body: string): Requested => {
  const blocks = blocksIn(body);
  if (blocks.length === 0) return { _tag: "Missing" };
  if (blocks.length > 1) return { _tag: "Several" };
  const text = blocks[0]!;
  const all = /^all\b:?\s*([\s\S]*)$/.exec(text);
  if (all !== null) {
    const reason = all[1]!.replace(/\s+/g, " ").trim();
    return reason === "" ? { _tag: "AllWithoutReason" } : { _tag: "All", reason };
  }
  const tokens = text.split(/[\s,]+/).filter((token) => token.length > 0);
  if (tokens.length === 1 && tokens[0] === "none") return { _tag: "Named", tokens: [] };
  if (tokens.length === 1 && tokens[0] === "skip") return { _tag: "Skip" };
  return { _tag: "Named", tokens };
};

/**
 * The selection a parsed block makes, or why it makes none. `retry` says how long the job waited
 * for the description and how to run it again.
 */
const requested = (parsed: Requested, retry: string) =>
  Effect.gen(function* () {
    switch (parsed._tag) {
      case "Missing":
        return yield* new SelectionFailed({
          message: `The pull request description has no e2e block. Name the spec files that exercise the change, for example:\n${example}\nWrite none when no scenario can observe it, or all with a reason for a cross-cutting change. ${retry} See AGENTS.md, "Choosing a PR's E2E scenarios".`,
        });
      case "Several":
        return yield* new SelectionFailed({
          message: "The pull request description has more than one e2e block. Keep one.",
        });
      case "AllWithoutReason":
        return yield* new SelectionFailed({
          message: `The e2e block says all without a reason. The full suite takes about three times as long as a selection. Name the spec files that exercise the change, for example:\n${example}\nor keep all and say why every scenario is needed, for example "all: changes the lockfile".`,
        });
      case "All":
        return { all: parsed.reason };
      case "Skip":
        return "skip" as const;
      case "Named":
        return parsed.tokens;
    }
  });

/**
 * The spec files the e2e block names, each written as its name in e2e/tests/ with an optional
 * `e2e/tests/` prefix. A name is compared as written, so `./groups.spec.ts` or a path that leaves
 * e2e/tests/ is not a spec file. A spec file a separate config runs fails too, with where it does
 * run: naming it would test nothing here.
 */
const checkNamed = (tokens: ReadonlyArray<string>, suites: ReadonlyMap<string, Suite>) =>
  Effect.gen(function* () {
    const named = tokens.map((token) => token.replace(/^e2e\/tests\//, ""));
    const unknown = tokens.filter(
      (_, index) => !specFiles.has(named[index]!) && !suites.has(named[index]!),
    );
    if (unknown.length > 0)
      return yield* new SelectionFailed({
        message: `The e2e block names files that are not spec files in e2e/tests/: ${unknown.map((token) => `"${token}"`).join(", ")}. Write each name as it appears in e2e/tests/, such as groups.spec.ts. A new spec file needs its scenarios in e2e/test-plan.ts.`,
      });
    const elsewhere = named.filter((file) => !jobFiles.has(file));
    if (elsewhere.length > 0)
      return yield* new SelectionFailed({
        message: [
          "The e2e block names spec files that CI's E2E jobs do not run, so naming them here tests nothing:",
          ...elsewhere.map((file) => runsElsewhere(file, suites.get(file))),
          "Remove them from the e2e block. Name the spec files these jobs run that exercise the change, or write none.",
        ].join("\n"),
      });
    return named;
  });

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pullRequest = yield* Config.String("E2E_PULL_REQUEST").pipe(Config.withDefault(""));
    const headRef = yield* Config.String("E2E_HEAD_REF").pipe(Config.withDefault(""));
    const repository = yield* Config.String("GITHUB_REPOSITORY").pipe(Config.withDefault(""));
    const defaultBranch = yield* Config.String("E2E_DEFAULT_BRANCH").pipe(Config.withDefault(""));
    const runId = yield* Config.String("GITHUB_RUN_ID").pipe(Config.withDefault("<run-id>"));
    // In a week, 118 pull requests gained their block, or the layer above their skip, within an
    // hour of select first reading the description. 117 of them took under 3 minutes.
    const wait = Duration.seconds(
      yield* Config.Number("E2E_DESCRIPTION_WAIT_SECONDS").pipe(Config.withDefault(180)),
    );
    const poll = Duration.seconds(
      yield* Config.Number("E2E_DESCRIPTION_POLL_SECONDS").pipe(Config.withDefault(15)),
    );
    const output = yield* Config.String("GITHUB_OUTPUT").pipe(Config.option);
    const summary = yield* Config.String("GITHUB_STEP_SUMMARY").pipe(Config.option);

    const retry = `CI waited ${spoken(wait)} for the description. Once it is fixed, rerun the whole workflow: gh run rerun ${runId}`;
    const read =
      pullRequest === ""
        ? undefined
        : yield* readPullRequest({ repository, number: pullRequest, headRef, wait, poll });
    const block = read === undefined ? undefined : yield* requested(read.parsed, `${retry}.`);
    const above = read === undefined ? [] : read.above;
    // A skipped layer runs nothing, so it decides before the suites are read: the layer above
    // reads them for the combined change.
    if (block === "skip") {
      if (above.length === 0)
        return yield* new SelectionFailed({
          message: `The e2e block says skip, but no open pull request builds on this branch. Only the lower layers of a stack may skip: open the layer above, or select scenarios instead. ${retry}.`,
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
    const changed =
      read === undefined
        ? ""
        : yield* gh([
            "api",
            "--paginate",
            `repos/${repository}/pulls/${pullRequest}/files`,
            "--jq",
            ".[].filename",
          ]);
    const suites = yield* separateSuites;
    const named = Array.isArray(block) ? yield* checkNamed(block, suites) : block;
    // The pull request files list holds the new name of a renamed file and the old name of a
    // deleted one, so a changed name that no plan or config knows is a file nothing would run.
    const changedSpecs = changed
      .split("\n")
      .map((file) => /^e2e\/tests\/([\w.-]+\.spec\.ts)$/.exec(file.trim())?.[1])
      .filter((file) => file !== undefined);
    const tests = yield* path.fromFileUrl(new URL("tests/", import.meta.url));
    const unregistered = yield* Effect.filter(
      changedSpecs.filter((file) => !specFiles.has(file) && !suites.has(file)),
      (file) => fs.exists(path.join(tests, file)),
    );
    if (unregistered.length > 0)
      return yield* new SelectionFailed({
        message: `No CI job runs these spec files, because neither e2e/test-plan.ts nor an e2e/*.config.ts includes them: ${unregistered.join(", ")}. Add their scenarios to e2e/test-plan.ts.`,
      });
    const changedElsewhere = changedSpecs.filter(
      (file) => (specFiles.has(file) || suites.has(file)) && !jobFiles.has(file),
    );
    // Main's pinned dependencies and patches: patch guard scenarios run when they differ. The
    // workflow names the default branch; without it there is no main to compare with.
    const guarded =
      read === undefined || defaultBranch === ""
        ? []
        : yield* guardedPatches(
            yield* gh([
              "api",
              `repos/${repository}/contents/package.json?ref=${defaultBranch}`,
              "-H",
              "Accept: application/vnd.github.raw+json",
            ]),
            yield* gh([
              "api",
              `repos/${repository}/contents/patches?ref=${defaultBranch}`,
              "--jq",
              '.[] | "\\(.sha) \\(.name)"',
            ]),
          );
    const guardedByFile =
      read === undefined || defaultBranch === ""
        ? []
        : yield* guardedFiles((directory) =>
            gh([
              "api",
              `repos/${repository}/contents/${directory}?ref=${defaultBranch}`,
              "--jq",
              '.[] | "\\(.sha) \\(.path)"',
            ]),
          );
    const files =
      named === undefined || "all" in named
        ? undefined
        : new Set([
            ...named,
            ...guarded,
            ...guardedByFile,
            ...changedSpecs.filter((file) => jobFiles.has(file)),
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
      files === undefined
        ? named !== undefined && "all" in named
          ? `Full suite: ${named.all}`
          : "Full suite: this run is not for a pull request."
        : files.size === 0
          ? "No E2E scenarios: the pull request selects none and changes no spec file these jobs run."
          : `Spec files: ${[...files].sort().join(", ")}`,
      ...(changedElsewhere.length === 0
        ? []
        : [
            "",
            "Changed spec files these jobs do not run:",
            ...changedElsewhere.sort().map((file) => runsElsewhere(file, suites.get(file))),
          ]),
      ...(guarded.length === 0
        ? []
        : ["", `A dependency patch differs from main, so its guards run: ${guarded.join(", ")}`]),
      ...(guardedByFile.length === 0
        ? []
        : ["", `A guarded file differs from main, so its guards run: ${guardedByFile.join(", ")}`]),
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
