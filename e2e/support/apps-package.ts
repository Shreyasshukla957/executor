/**
 * What an author can import from the `apps` package staged by `bun run e2e:prepare`: each
 * subpath's exported names, read from the package's own declaration files with the TypeScript
 * compiler. Nothing from the package is executed.
 */
import ts from "typescript-5";
import { Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    exports: Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Struct({ types: Schema.String })]),
    ),
  }),
);

class AppsPackageUnreadable extends Schema.TaggedError<AppsPackageUnreadable>()(
  "AppsPackageUnreadable",
  { reason: Schema.String },
) {}

/** Exported names by module specifier, such as `apps` or `apps/mcp`. */
export const appsPackageExports = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const archive = path.resolve(".local/test-runtime/apps.tgz");
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "executor-apps-package-" });
  // A relative archive path: GNU tar on Windows reads a drive letter as a remote host.
  const code = yield* processes.exitCode(
    ChildProcess.make("tar", ["-xzf", path.basename(archive), "-C", directory], {
      cwd: path.dirname(archive),
    }),
  );
  if (code !== 0)
    return yield* new AppsPackageUnreadable({
      reason: "Run bun run e2e:prepare to stage the apps package first.",
    });
  const root = path.join(directory, "package");
  const manifest = yield* Schema.decodeUnknownEffect(Manifest)(
    yield* fs.readFileString(path.join(root, "package.json")),
  );
  const modules = Object.entries(manifest.exports).flatMap(([key, value]) =>
    typeof value === "string"
      ? []
      : [
          {
            module: key === "." ? "apps" : `apps/${key.slice(2)}`,
            file: path.join(root, value.types),
          },
        ],
  );
  const program = ts.createProgram(
    modules.map(({ file }) => file),
    {
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  );
  const checker = program.getTypeChecker();
  const exports = new Map<string, readonly string[]>();
  for (const { module, file } of modules) {
    const source = program.getSourceFile(file);
    const symbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
    if (symbol === undefined)
      return yield* new AppsPackageUnreadable({ reason: `${module} has no declaration file` });
    exports.set(
      module,
      checker.getExportsOfModule(symbol).map((exported) => exported.name),
    );
  }
  return exports;
});
