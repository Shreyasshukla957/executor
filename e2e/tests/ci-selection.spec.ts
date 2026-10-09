/**
 * The select job turns a pull request's `e2e` block into each E2E job's `--test-name` pattern.
 * These cases run `node e2e/ci-selection.ts` as a process with the environment the job gives it,
 * and read the outputs file and step summary it writes, as GitHub Actions does. A stub `gh` first
 * on its PATH answers the job's reads of the pull request.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { scenarios } from "../test-plan.ts";

const jobs = [
  "local",
  "self-host",
  "self-host-inventory",
  "self-host-catalog",
  "cloud",
  "cloud-product",
  "cloud-domains",
  "cloud-workers",
  "cloud-locks",
  "cloud-isolate",
  "cloud-rate-limit",
  "cloud-rollback",
  "cloud-oauth-proxy-preview",
];

const block = (...lines: ReadonlyArray<string>) =>
  ["Description.", "", "```e2e", ...lines, "```", ""].join("\n");

/**
 * A `gh` that answers the select job's reads from files beside it: the description (`body.<n>`),
 * the open pull requests based on the branch (`above.<n>`), the changed files and main's contents
 * (`main/<path with / as _>`).
 * The nth read of a kind returns its nth answer, and the last answer once they run out, so a case
 * can edit the description while the job waits.
 */
const stubGh = `#!/bin/sh
dir=$(dirname "$0")
case "$*" in
  "pr list "*) kind=above ;;
  *"/files "*) cat "$dir/files"; exit ;;
  *"/contents/"*) exec cat "$dir/main/$(echo "$*" | sed 's|.*/contents/||; s|[?].*||' | tr / _)" ;;
  *) kind=body ;;
esac
read=$(cat "$dir/$kind.reads" 2>/dev/null || echo 0)
echo $((read + 1)) > "$dir/$kind.reads"
while [ ! -f "$dir/$kind.$read" ]; do read=$((read - 1)); done
cat "$dir/$kind.$read"
`;

/**
 * One select run: a pull request run when `body` is given, otherwise a push to main. A list of
 * bodies, or of `stackedAbove` answers, is what successive reads return. The job waits `wait`
 * seconds, none by default, for an incomplete description. It runs the checkout's selector unless
 * `root` names a fixture tree. `main` answers the reads of main's contents by repository path;
 * without it the job has no default branch and compares nothing with main.
 */
const select = (input: {
  readonly body?: string | ReadonlyArray<string>;
  readonly changed?: ReadonlyArray<string>;
  readonly main?: Readonly<Record<string, string>>;
  readonly stackedAbove?: string | ReadonlyArray<string>;
  readonly wait?: number;
  readonly root?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-ci-selection-" });
    const output = path.join(directory, "output");
    const summary = path.join(directory, "summary");
    yield* fs.writeFileString(output, "");
    yield* fs.writeFileString(summary, "");
    const bin = path.join(directory, "bin");
    yield* fs.makeDirectory(bin);
    yield* fs.writeFileString(path.join(bin, "gh"), stubGh);
    yield* fs.chmod(path.join(bin, "gh"), 0o755);
    const answers = (kind: string, values: string | ReadonlyArray<string>) =>
      Effect.forEach(
        typeof values === "string" ? [values] : values,
        (value, index) => fs.writeFileString(path.join(bin, `${kind}.${index}`), value),
        { discard: true },
      );
    yield* answers("body", input.body ?? "");
    yield* answers("above", input.stackedAbove ?? "");
    yield* fs.writeFileString(path.join(bin, "files"), (input.changed ?? []).join("\n"));
    yield* fs.makeDirectory(path.join(bin, "main"));
    for (const [file, text] of Object.entries(input.main ?? {}))
      yield* fs.writeFileString(path.join(bin, "main", file.replaceAll("/", "_")), text);
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["e2e/ci-selection.ts"], {
        cwd: input.root,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          E2E_PULL_REQUEST: input.body === undefined ? "" : "1",
          E2E_HEAD_REF: "layer",
          E2E_DEFAULT_BRANCH: input.main === undefined ? "" : "main",
          E2E_DESCRIPTION_WAIT_SECONDS: String(input.wait ?? 0),
          E2E_DESCRIPTION_POLL_SECONDS: "0.05",
          GITHUB_REPOSITORY: "owner/repository",
          GITHUB_RUN_ID: "123456",
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
        },
        extendEnv: true,
      }),
    );
    // The runtime logs a failure to stdout, so the cases read both streams together.
    const [log, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    const outputs = Object.fromEntries(
      (yield* fs.readFileString(output))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return {
      exitCode,
      log,
      outputs,
      summary: yield* fs.readFileString(summary),
    };
  }).pipe(Effect.scoped);

/**
 * A temporary copy of what the selector reads, for a case that changes it: the top-level e2e/*.ts
 * files, an empty e2e/tests/, package.json and the workflows, with the checkout's node_modules
 * linked in. The selector resolves its imports and files from its own location, so it reads only
 * the copy, and the case writes `files` there. The checkout is never written, so a killed or
 * concurrent run leaves it unchanged. The tree is removed when the case's scope closes.
 */
const fixture = (files: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-ci-selection-root-" });
    yield* fs.makeDirectory(path.join(root, "e2e", "tests"), { recursive: true });
    for (const name of yield* fs.readDirectory("e2e"))
      if (name.endsWith(".ts"))
        yield* fs.copyFile(path.join("e2e", name), path.join(root, "e2e", name));
    yield* fs.copyFile("package.json", path.join(root, "package.json"));
    yield* fs.copy(path.join(".github", "workflows"), path.join(root, ".github", "workflows"));
    yield* fs.symlink(path.resolve("node_modules"), path.join(root, "node_modules"));
    for (const [file, text] of Object.entries(files))
      yield* fs.writeFileString(path.join(root, file), text);
    return root;
  });

/** A saved run's report: each listed scenario on a target, with how it ended. */
interface SavedRun {
  readonly target: "local" | "self-host" | "cloud";
  readonly status?: (title: string) => string;
}

/**
 * `node e2e/ci-selection.ts verify <suite>` over runs saved as the E2E jobs save them, each with
 * every scenario the plan schedules on its target. `status` says how one ended; passed by default.
 */
const verify = (suite: string, saved: ReadonlyArray<SavedRun>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-ci-coverage-" });
    for (const [index, run] of saved.entries()) {
      const files = new Map<string, Array<{ title: string; status: string }>>();
      for (const scenario of Object.values(scenarios))
        if (scenario.targets[run.target].status === "scheduled")
          files.set(scenario.file, [
            ...(files.get(scenario.file) ?? []),
            { title: scenario.title, status: run.status?.(scenario.title) ?? "passed" },
          ]);
      const report = path.join(
        directory,
        `artifact-${index}`,
        `run-${index}`,
        run.target,
        "report",
        "diagnostics",
      );
      yield* fs.makeDirectory(report, { recursive: true });
      yield* fs.writeFileString(
        path.join(report, "results.json"),
        JSON.stringify({
          testResults: [...files].map(([file, assertionResults]) => ({
            name: `/runner/work/e2e/tests/${file}`,
            assertionResults,
          })),
        }),
      );
    }
    const child = yield* processes.spawn(
      ChildProcess.make("node", ["e2e/ci-selection.ts", "verify", suite, directory], {
        env: { GITHUB_STEP_SUMMARY: "" },
        extendEnv: true,
      }),
    );
    const [log, exitCode] = yield* Effect.all(
      [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    return { exitCode, log };
  }).pipe(Effect.scoped);

/** This suite's own config, rewritten only in a fixture tree. */
const ownConfig = "e2e/ci-selection.config.ts";

layer(NodeServices.layer)("CI E2E selection", (it) => {
  it.effect("a push to main runs every job's full pattern", () =>
    Effect.gen(function* () {
      const run = yield* select({});
      expect(run.exitCode).toBe(0);
      expect(Object.keys(run.outputs).sort()).toEqual([...jobs].sort());
      for (const job of jobs) expect(run.outputs[job], job).not.toBe("");
      expect(run.summary).toContain("Full suite: this run is not for a pull request.");
    }),
  );

  it.effect("a named spec file selects its scenarios, with or without the e2e/tests/ prefix", () =>
    Effect.gen(function* () {
      const [bare, prefixed] = yield* Effect.all(
        [
          select({ body: block("groups.spec.ts") }),
          select({ body: block("e2e/tests/groups.spec.ts") }),
        ],
        { concurrency: "unbounded" },
      );
      expect(bare.exitCode).toBe(0);
      expect(bare.outputs["self-host"]).toMatch(/^\^\(\?:/);
      expect(bare.outputs.cloud).toBe("");
      expect(prefixed.outputs).toEqual(bare.outputs);
    }),
  );

  it.effect("a name that is not a spec file in e2e/tests/ fails before any job is chosen", () =>
    Effect.gen(function* () {
      const names = [
        "./groups.spec.ts",
        "e2e/tests/./groups.spec.ts",
        "../tests/groups.spec.ts",
        "../../package.json",
        "../test-plan.ts",
        ".",
        "groups-renamed.spec.ts",
      ];
      const runs = yield* Effect.forEach(names, (name) => select({ body: block(name) }), {
        concurrency: 4,
      });
      for (const [index, run] of runs.entries()) {
        expect(run.exitCode, names[index]).toBe(1);
        expect(run.log, names[index]).toContain(`not spec files in e2e/tests/: "${names[index]}"`);
        expect(run.outputs, names[index]).toEqual({});
      }
    }),
  );

  it.effect("a spec file another config runs fails and names what runs it", () =>
    Effect.gen(function* () {
      const cases = [
        ["billing.spec.ts", "e2e/billing.config.ts: bun run e2e:billing. No workflow runs it."],
        [
          "docker-release.spec.ts",
          "e2e/docker-release.config.ts in Executor releases (.github/workflows/release-artifacts.yml)",
        ],
        // Planned, but its scenarios run only against the release archive.
        [
          "local-bootstrap.spec.ts",
          "e2e/local-bootstrap.config.ts in Executor releases (.github/workflows/release-artifacts.yml)",
        ],
        [
          "ci-selection.spec.ts",
          "e2e/ci-selection.config.ts in Checks (.github/workflows/checks.yml). Locally: bun run e2e:ci-selection.",
        ],
        ["claude-mcp.spec.ts", "these jobs exclude all of its scenarios"],
      ] as const;
      const runs = yield* Effect.forEach(
        cases,
        ([file]) => select({ body: block("groups.spec.ts", file) }),
        { concurrency: 4 },
      );
      for (const [index, run] of runs.entries()) {
        const [file, where] = cases[index]!;
        expect(run.exitCode, file).toBe(1);
        expect(run.log, file).toContain(`- ${file}`);
        expect(run.log, file).toContain(where);
        expect(run.log, file).toContain("Remove them from the e2e block.");
        expect(run.outputs, file).toEqual({});
      }
    }),
  );

  it.effect("changed spec files run when these jobs run them and are reported otherwise", () =>
    Effect.gen(function* () {
      // A rename lists the new name; the deleted name no longer exists and is ignored.
      const run = yield* select({
        body: block("none"),
        changed: [
          "e2e/tests/groups.spec.ts",
          "e2e/tests/billing.spec.ts",
          "e2e/tests/groups-before-rename.spec.ts",
          "README.md",
        ],
      });
      expect(run.exitCode).toBe(0);
      expect(run.outputs["self-host"]).toMatch(/^\^\(\?:/);
      expect(run.summary).toContain("Spec files: groups.spec.ts\n");
      expect(run.summary).toContain(
        "- billing.spec.ts runs only by hand, with e2e/billing.config.ts",
      );
    }),
  );

  it.effect("a changed scenario only deployed Cloud runs runs in cloud-product when it can", () =>
    Effect.gen(function* () {
      const [links, compiler, all] = yield* Effect.all(
        [
          select({ body: block("none"), changed: ["e2e/tests/deployment-links.spec.ts"] }),
          select({ body: block("none"), changed: ["e2e/tests/cloud-compiler.spec.ts"] }),
          select({
            body: block("all: changes the lockfile"),
            changed: ["e2e/tests/deployment-links.spec.ts"],
          }),
        ],
        { concurrency: "unbounded" },
      );
      expect(links.exitCode, links.log).toBe(0);
      expect(links.outputs["cloud-product"]).toBe(
        "^(?:Cloud product links follow the deployment origin)$",
      );
      expect(links.outputs.cloud).toBe("");
      expect(links.summary).toContain("Spec files: deployment-links.spec.ts\n");
      expect(links.summary).toContain(
        "- deployment-links.spec.ts: Cloud product links follow the deployment origin",
      );
      expect(links.summary).not.toContain("Changed spec files these jobs do not run");
      expect(links.log).not.toContain("::warning");

      // Two of its scenarios need a deployed stage, and one runs on no CI path at all.
      expect(compiler.exitCode, compiler.log).toBe(0);
      expect(compiler.outputs["cloud-product"]).toContain(
        "Cloud compiler installs imported packages",
      );
      // This one is in the cloud job's own pattern.
      expect(compiler.outputs.cloud).toContain("Cloud deploys fail promptly");
      for (const job of ["cloud", "cloud-product"]) {
        expect(compiler.outputs[job]).not.toContain("Concurrent Cloud deploys");
        expect(compiler.outputs[job]).not.toContain("memory failures");
      }
      for (const title of [
        "Concurrent Cloud deploys that install npm packages all compile",
        "Cloud builds keep large UI files out of the server bundle",
      ]) {
        expect(compiler.log).toContain(
          `::warning title=Runs only on deployed Cloud after merge::cloud-compiler.spec.ts: "${title}" changed`,
        );
        expect(compiler.summary).toContain(`- cloud-compiler.spec.ts: ${title}`);
      }
      expect(compiler.summary).toContain(
        "bun run e2e:deployed --test-name '^(?:Concurrent Cloud deploys that install npm packages all compile|Cloud builds keep large UI files out of the server bundle)$'",
      );
      expect(compiler.log).not.toContain('"Cloud compiler memory failures');

      // The full suite keeps the job's own pattern and adds the changed scenario.
      expect(all.exitCode, all.log).toBe(0);
      expect(all.outputs["cloud-product"]).toMatch(
        /^Cloud SSO SAML accepts\|.*\|\^\(\?:Cloud product links follow the deployment origin\)\$$/,
      );
      expect(all.outputs.cloud).not.toContain("Cloud product links");
    }),
  );

  it.effect("naming a spec file only deployed Cloud runs says where it runs", () =>
    Effect.gen(function* () {
      const run = yield* select({ body: block("deployment-links.spec.ts") });
      expect(run.exitCode).toBe(1);
      expect(run.log).toContain(
        "- deployment-links.spec.ts: only Cloud tests on main runs its scenarios, on a deployed stage after merge.",
      );
    }),
  );

  it.effect("naming a changed spec file only deployed Cloud runs selects its scenarios", () =>
    Effect.gen(function* () {
      const [changed, other] = yield* Effect.all(
        [
          select({
            body: block("deployment-links.spec.ts"),
            changed: ["e2e/tests/deployment-links.spec.ts"],
          }),
          // Another changed deployed-only file does not let an unchanged one be named.
          select({
            body: block("deployment-links.spec.ts"),
            changed: ["e2e/tests/cloud-compiler.spec.ts"],
          }),
        ],
        { concurrency: "unbounded" },
      );
      expect(changed.exitCode, changed.log).toBe(0);
      expect(changed.outputs["cloud-product"]).toBe(
        "^(?:Cloud product links follow the deployment origin)$",
      );
      expect(changed.summary).toContain("Spec files: deployment-links.spec.ts\n");
      expect(other.exitCode).toBe(1);
      expect(other.log).toContain(
        "- deployment-links.spec.ts: only Cloud tests on main runs its scenarios, on a deployed stage after merge.",
      );
      expect(other.outputs).toEqual({});
    }),
  );

  it.effect("a scheduled scenario no CI job runs fails every run except a skipped layer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const deadline = "Cloud deploys fail promptly when the compiler does not answer";
      const renamed = "Cloud deploys stop when the compiler is silent";
      const root = yield* fixture({
        "e2e/test-plan.ts": (yield* fs.readFileString("e2e/test-plan.ts")).replace(
          `"${deadline}"`,
          `"${renamed}"`,
        ),
      });
      const [main, named, skip] = yield* Effect.all(
        [
          select({ root }),
          select({ body: block("groups.spec.ts"), root }),
          select({ body: block("skip"), stackedAbove: "123", root }),
        ],
        { concurrency: "unbounded" },
      );
      for (const run of [main, named]) {
        expect(run.exitCode, run.log).toBe(1);
        expect(run.log).toContain(
          `- scenarios.cloudCompilerDeadline (cloud-compiler.spec.ts) on cloud: "${renamed}" is scheduled, but no CI job runs it.`,
        );
        expect(run.log).toContain("add it to notRunInCi in e2e/ci-selection.ts with why");
        expect(run.outputs).toEqual({});
      }
      expect(skip.exitCode, skip.log).toBe(0);
      expect(skip.outputs).toEqual({ skip: "true" });
    }).pipe(Effect.scoped),
  );

  it.effect("an exception no longer needed fails until it is removed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // The self-host job stops excluding the flaky profile picker scenario.
      const selection = (yield* fs.readFileString("e2e/ci-selection.ts")).replace(
        "|${flakyProfilePicker}",
        "",
      );
      const root = yield* fixture({ "e2e/ci-selection.ts": selection });
      const run = yield* select({ root });
      expect(run.exitCode, run.log).toBe(1);
      expect(run.log).toContain(
        "- scenarios.profilePicker (profile-picker.spec.ts) on self-host is in notRunInCi, but the self-host job runs it.",
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "an effect version or patch that differs from main runs the session object timing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const protocols = "packages/sdk/src/implementation/app-protocols.ts";
        const names = yield* fs.readDirectory("patches");
        const [current = "", ...blobs] = (yield* processes.string(
          ChildProcess.make("git", [
            "hash-object",
            protocols,
            ...names.map((name) => `patches/${name}`),
          ]),
        ))
          .trim()
          .split("\n");
        // Main as this checkout, except for the blob ID it lists for effect's patch.
        const patches = names
          .map(
            (name, index) =>
              `${name.startsWith("effect@") ? "0".repeat(40) : blobs[index]} ${name}`,
          )
          .join("\n");
        const run = yield* select({
          body: block("none"),
          main: {
            "package.json": yield* fs.readFileString("package.json"),
            patches,
            "packages/sdk/src/implementation": `${current} ${protocols}\n`,
          },
        });
        expect(run.exitCode, run.log).toBe(0);
        expect(run.summary).not.toContain("A guarded file differs");
        expect(run.summary).toContain(
          "A dependency patch differs from main, so its guards run: mcp-telemetry-privacy.spec.ts, mcp-protocol-versions.spec.ts, cloud-mcp-session-timing.spec.ts",
        );
        expect(run.outputs["cloud-isolate"]).toContain("Cloud MCP session objects report");
      }),
  );

  it.effect(
    "a guarded file that differs from main runs its scenarios, whatever the block says",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
        const protocols = "packages/sdk/src/implementation/app-protocols.ts";
        const names = yield* fs.readDirectory("patches");
        // Git's own blob IDs for the working tree, as the contents API lists main's.
        const [current = "", ...patchBlobs] = (yield* processes.string(
          ChildProcess.make("git", [
            "hash-object",
            protocols,
            ...names.map((name) => `patches/${name}`),
          ]),
        ))
          .trim()
          .split("\n");
        const patches = names.map((name, index) => `${patchBlobs[index]} ${name}`);
        const manifest = yield* fs.readFileString("package.json");
        // Main as this checkout, except for the blob ID it lists for the host's protocols.
        const main = (protocolsBlob: string) => ({
          "package.json": manifest,
          patches: patches.join("\n"),
          "packages/sdk/src/implementation": `${protocolsBlob} ${protocols}\n`,
        });
        const [same, changed] = yield* Effect.all(
          [
            select({ body: block("none"), main: main(current) }),
            select({ body: block("none"), main: main("0".repeat(40)) }),
          ],
          { concurrency: "unbounded" },
        );
        expect(same.exitCode, same.log).toBe(0);
        expect(same.summary).toContain("No E2E scenarios");
        expect(same.summary).not.toContain("guards run");
        expect(changed.exitCode, changed.log).toBe(0);
        expect(changed.summary).toContain(
          "Spec files: app-older-protocols.spec.ts, app-package.spec.ts\n",
        );
        expect(changed.summary).toContain(
          "A guarded file differs from main, so its guards run: app-package.spec.ts, app-older-protocols.spec.ts",
        );
        expect(changed.outputs["self-host"]).toContain(
          "App builds retain their selected npm framework across rebuilds",
        );
      }),
  );

  it.effect("a changed spec file that no plan or config includes fails", () =>
    Effect.gen(function* () {
      const name = "ci-selection-unregistered.spec.ts";
      const file = `e2e/tests/${name}`;
      const root = yield* fixture({ [file]: "" });
      const run = yield* select({ body: block("none"), changed: [file], root });
      expect(run.exitCode).toBe(1);
      expect(run.log).toContain(
        `neither e2e/test-plan.ts nor an e2e/*.config.ts includes them: ${name}`,
      );
      expect(run.outputs).toEqual({});
    }).pipe(Effect.scoped),
  );

  it.effect("a config's own test.include counts, however it is written, and nothing else", () =>
    Effect.gen(function* () {
      const included = "ci-selection-included.spec.ts";
      const covered = "ci-selection-covered.spec.ts";
      // A list in a variable, a quoted key, and coverage's unrelated include of a spec file.
      const root = yield* fixture({
        [`e2e/tests/${included}`]: "",
        [`e2e/tests/${covered}`]: "",
        [ownConfig]: [
          'import { defineConfig } from "vitest/config";',
          `const specs = ["e2e/tests/ci-selection.spec.ts", "e2e/tests/${included}"];`,
          "export default defineConfig({",
          "  test: {",
          '    "include": specs,',
          `    coverage: { include: ["packages/**/*.ts", "e2e/tests/${covered}"] },`,
          "  },",
          "});",
          "",
        ].join("\n"),
      });
      const [main, named, changed] = yield* Effect.all(
        [
          select({ root }),
          select({ body: block(included), root }),
          select({ body: block("none"), changed: [`e2e/tests/${covered}`], root }),
        ],
        { concurrency: "unbounded" },
      );
      expect(main.exitCode, main.log).toBe(0);
      expect(named.exitCode).toBe(1);
      expect(named.log).toContain(
        `- ${included} runs with ${ownConfig} in Checks (.github/workflows/checks.yml).`,
      );
      expect(changed.exitCode).toBe(1);
      expect(changed.log).toContain(
        `neither e2e/test-plan.ts nor an e2e/*.config.ts includes them: ${covered}`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("a config the selection cannot read fails every run except a skipped layer", () =>
    Effect.forEach(
      [
        [
          ownConfig,
          [
            'import { defineConfig } from "vitest/config";',
            'export default defineConfig({ test: { include: ["e2e/tests/*.spec.ts"] } });',
          ].join("\n"),
          `${ownConfig} must export a config object whose test.include lists e2e/tests/*.spec.ts paths`,
        ],
        [
          ownConfig,
          'throw new Error("Start a target first.");',
          `${ownConfig} failed to load: Error: Start a target first.`,
        ],
        [
          "e2e/ci-selection-unlisted.config.ts",
          "export default {};",
          "Add e2e/ci-selection-unlisted.config.ts.",
        ],
      ] as const,
      ([config, text, failure]) =>
        Effect.gen(function* () {
          const root = yield* fixture({ [config]: `${text}\n` });
          const [main, named, skip] = yield* Effect.all(
            [
              select({ root }),
              select({ body: block("groups.spec.ts"), root }),
              select({ body: block("skip"), stackedAbove: "123", root }),
            ],
            { concurrency: "unbounded" },
          );
          for (const run of [main, named]) {
            expect(run.exitCode, failure).toBe(1);
            expect(run.log, failure).toContain(failure);
            expect(run.outputs, failure).toEqual({});
          }
          expect(skip.exitCode, skip.log).toBe(0);
          expect(skip.outputs, failure).toEqual({ skip: "true" });
        }).pipe(Effect.scoped),
      { discard: true },
    ),
  );

  it.effect("none, all and skip keep their meaning", () =>
    Effect.gen(function* () {
      const [none, all, bareAll, skip, loneSkip, missing, twice] = yield* Effect.all(
        [
          select({ body: block("none") }),
          select({ body: block("all: changes the lockfile") }),
          select({ body: block("all") }),
          select({ body: block("skip"), stackedAbove: "123" }),
          select({ body: block("skip") }),
          select({ body: "No block." }),
          select({ body: `${block("none")}\n${block("none")}` }),
        ],
        { concurrency: 4 },
      );
      expect(none.exitCode).toBe(0);
      for (const job of jobs) expect(none.outputs[job], job).toBe("");
      expect(all.exitCode).toBe(0);
      for (const job of jobs) expect(all.outputs[job], job).not.toBe("");
      expect(all.summary).toContain("Full suite: changes the lockfile");
      expect(bareAll.exitCode).toBe(1);
      expect(skip.exitCode).toBe(0);
      expect(skip.outputs).toEqual({ skip: "true" });
      expect(loneSkip.exitCode).toBe(1);
      expect(missing.exitCode).toBe(1);
      expect(twice.exitCode).toBe(1);
    }),
  );

  it.effect("the job waits for an e2e block written after the pull request opened", () =>
    Effect.gen(function* () {
      const footer = "Stack created with GitHub Stacks CLI";
      const run = yield* select({ body: [footer, footer, block("none")], wait: 30 });
      expect(run.exitCode, run.log).toBe(0);
      expect(run.log).toContain("Waiting up to 30 seconds for an e2e block in the description.");
      expect(run.log).toMatch(/Waited \d+ s for an e2e block in the description\./);
      for (const job of jobs) expect(run.outputs[job], job).toBe("");
    }),
  );

  it.effect("a skipped layer waits for the pull request above it, even after its block", () =>
    Effect.gen(function* () {
      const run = yield* select({
        body: ["", block("skip")],
        stackedAbove: ["", "", "124"],
        wait: 30,
      });
      expect(run.exitCode, run.log).toBe(0);
      expect(run.outputs).toEqual({ skip: "true" });
      expect(run.log).toMatch(
        /Waited \d+ s for an e2e block in the description, then an open pull request based on this branch\./,
      );
      expect(run.summary).toContain("a lower stack layer under #124");
    }),
  );

  it.effect("the wait reads skip as the selection does, however the block writes it", () =>
    Effect.gen(function* () {
      // The block splits on whitespace and commas, so each of these is skip and waits for the
      // layer above. Names are compared as written, so SKIP is a file name and waits for nothing.
      const skips = ["skip,", " skip ", ",skip,\n"];
      const [waited, upper, named] = yield* Effect.all(
        [
          Effect.forEach(
            skips,
            (text) => select({ body: block(text), stackedAbove: ["", "124"], wait: 30 }),
            { concurrency: "unbounded" },
          ),
          select({ body: block("SKIP"), stackedAbove: ["", "124"], wait: 30 }),
          select({ body: block("groups.spec.ts"), stackedAbove: ["", "124"], wait: 30 }),
        ],
        { concurrency: "unbounded" },
      );
      for (const [index, run] of waited.entries()) {
        expect(run.exitCode, `${skips[index]}: ${run.log}`).toBe(0);
        expect(run.outputs, skips[index]).toEqual({ skip: "true" });
        expect(run.log, skips[index]).toMatch(
          /Waited \d+ s for an open pull request based on this branch\./,
        );
      }
      expect(upper.exitCode).toBe(1);
      expect(upper.log).toContain('not spec files in e2e/tests/: "SKIP"');
      expect(upper.log).not.toContain("Waiting");
      expect(named.exitCode, named.log).toBe(0);
      expect(named.outputs["self-host"]).toMatch(/^\^\(\?:/);
      expect(named.log).not.toContain("Waiting");
    }),
  );

  it.effect("a description still incomplete after the wait fails with how to rerun", () =>
    Effect.gen(function* () {
      const [missing, loneSkip] = yield* Effect.all(
        [select({ body: "No block.", wait: 1 }), select({ body: block("skip"), wait: 1 })],
        { concurrency: "unbounded" },
      );
      expect(missing.exitCode).toBe(1);
      expect(missing.log).toMatch(
        /Waited \d+ s for an e2e block in the description; there is still no e2e block in the description\./,
      );
      expect(missing.log).toContain("The pull request description has no e2e block.");
      expect(missing.log).toContain(
        "CI waited 1 second for the description. Once it is fixed, rerun the whole workflow: gh run rerun 123456.",
      );
      expect(loneSkip.exitCode).toBe(1);
      expect(loneSkip.log).toContain("no open pull request builds on this branch");
      expect(loneSkip.log).toContain("gh run rerun 123456.");
    }),
  );
  it.effect("a full run passes when every scheduled scenario ran, passed or failed", () =>
    Effect.gen(function* () {
      const failed = "Cloud onboarding";
      const [ci, deployed] = yield* Effect.all(
        [
          verify("ci", [
            { target: "local" },
            { target: "self-host" },
            {
              target: "cloud",
              status: (title) => (title.startsWith(failed) ? "failed" : "passed"),
            },
          ]),
          verify("deployed", [{ target: "cloud" }]),
        ],
        { concurrency: "unbounded" },
      );
      expect(ci.exitCode, ci.log).toBe(0);
      expect(ci.log).toMatch(
        /Every one of the \d+ scenario runs the jobs here schedule executed\./,
      );
      expect(deployed.exitCode, deployed.log).toBe(0);
      expect(deployed.log).toMatch(/Every one of the \d+ scenario runs Cloud tests on main/);
    }),
  );

  it.effect("a job, step or deployed run that saved no result fails the full run", () =>
    Effect.gen(function* () {
      const rateLimit =
        /^Cloud (?:limits sign-in|counts two first requests|reports a Better Auth query the database failed|records a rate-limited OAuth token request)/;
      const [noCloud, skippedStep, noDeployed, deployedOnLocal] = yield* Effect.all(
        [
          // The e2e-cloud job was skipped or disabled: it saved nothing.
          verify("ci", [{ target: "local" }, { target: "self-host" }]),
          // The rate-limit step's guard never held: its scenarios are only filtered out.
          verify("ci", [
            { target: "local" },
            { target: "self-host" },
            { target: "cloud", status: (title) => (rateLimit.test(title) ? "skipped" : "passed") },
          ]),
          verify("deployed", []),
          verify("deployed", [{ target: "self-host" }]),
        ],
        { concurrency: "unbounded" },
      );
      for (const run of [noCloud, skippedStep, noDeployed, deployedOnLocal]) {
        expect(run.exitCode, run.log).toBe(1);
        expect(run.log).toContain("A full run must execute every scheduled scenario");
      }
      for (const job of [
        "cloud",
        "cloud-product",
        "cloud-domains",
        "cloud-workers",
        "cloud-locks",
        "cloud-isolate",
        "cloud-rate-limit",
        "cloud-rollback",
        "cloud-oauth-proxy-preview",
      ])
        expect(noCloud.log).toMatch(
          new RegExp(`- the ${job} job on cloud: (\\d+) of \\1 scenarios did not run`),
        );
      expect(noCloud.log).not.toContain("- the local job");
      expect(noCloud.log).not.toContain("- the self-host job");
      expect(skippedStep.log).toContain(
        "- the cloud-rate-limit job on cloud: 4 of 4 scenarios did not run",
      );
      expect(skippedStep.log).not.toContain("- the cloud job");
      for (const run of [noDeployed, deployedOnLocal])
        expect(run.log).toMatch(
          /- Cloud tests on main on cloud: (\d+) of \1 scenarios did not run/,
        );
    }),
  );

  it.effect("a report outside a directory named for its target fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-ci-coverage-" });
      yield* fs.makeDirectory(path.join(directory, "run", "report", "diagnostics"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(directory, "run", "report", "diagnostics", "results.json"),
        JSON.stringify({ testResults: [] }),
      );
      const child = yield* processes.spawn(
        ChildProcess.make("node", ["e2e/ci-selection.ts", "verify", "ci", directory]),
      );
      const [log, exitCode] = yield* Effect.all(
        [child.all.pipe(Stream.decodeText(), Stream.mkString), child.exitCode],
        { concurrency: "unbounded" },
      );
      expect(exitCode).toBe(1);
      expect(log).toContain("is not in a run directory named for its target");
    }).pipe(Effect.scoped),
  );
});
