/** Generate searchable author contracts from the same TypeScript graph as declarations. */
import ts from "typescript-5";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
/** Author modules and the skill document for each. Every export of these modules is described. */
const modules = {
  ".": "tools.md",
  "./client": "ui.md",
  "./react": "ui.md",
  "./operations/approval": "tools.md",
  "./mcp": "integrations.md",
  "./mcp/stdio": "integrations.md",
  "./graphql": "integrations.md",
  "./openapi": "integrations.md",
  "./skills": "tools.md",
};
/** Subpaths for hosts and Effect libraries. Apps do not import them, so the reference omits them. */
const hostModules = new Set([
  "./contracts",
  "./host",
  "./effect",
  "./mcp/effect",
  "./ui/contracts",
  "./ui/auth",
  "./ui/serving",
  "./ui/auth/contracts",
  "./storage/facet",
  "./skills/effect",
]);
const methods = [
  ["AppCache", "src/contracts/cache.ts", "AppCache", "tools.md"],
  ["OptimisticLocalStore", "src/contracts/optimistic.ts", "OptimisticLocalStore", "ui.md"],
  ["AppMutation", "src/contracts/optimistic.ts", "AppMutation", "ui.md"],
  ["Schema", "src/implementation/schema.ts", "Schema", "tools.md"],
  ["Table", "src/contracts/storage.ts", "Table", "storage.md"],
  ["DatabaseTable", "../app-data/src/implementation/promise.ts", "WriteTable", "storage.md"],
  ["IndexQuery", "../app-data/src/implementation/promise.ts", "Query", "storage.md"],
  ["IndexRange", "../app-data/src/implementation/promise.ts", "IndexRange", "storage.md"],
  ["Provider", "src/contracts/provider.ts", "Provider", "accounts.md"],
  ["WorkflowStep", "src/contracts/workflows.ts", "WorkflowStep", "workflows.md"],
  ["WorkflowControls", "src/contracts/workflows.ts", "WorkflowControls", "workflows.md"],
  ["AppContext", "src/contracts/app.ts", "BoundContext", "tools.md"],
];
const flags =
  ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

/** Produce a deterministic catalog. No app code is imported or executed. */
export async function generateFrameworkReference() {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  // A new subpath must be documented for authors or named as a host surface.
  const subpaths = Object.keys(manifest.exports).filter((key) => !key.endsWith(".json"));
  const unclassified = [
    ...subpaths.filter((key) => !Object.hasOwn(modules, key) && !hostModules.has(key)),
    ...[...Object.keys(modules), ...hostModules].filter((key) => !subpaths.includes(key)),
  ];
  if (unclassified.length)
    throw new Error(`Classify apps package subpaths for the reference: ${unclassified.join(", ")}`);
  const authorModules = Object.entries(modules).map(([key, docs]) => ({
    module: key === "." ? "apps" : `apps/${key.slice(2)}`,
    file: manifest.exports[key],
    docs,
  }));
  const exampleDirectory = resolve(root, "../../playground/demo-apps/live-inbox");
  const examplePaths = [
    "index.ts",
    "schema.ts",
    "ui/main.tsx",
    "ui/index.html",
    "ui/style.css",
    "package.json",
  ];
  // The example deploys as written, so its manifest declares this release like every app.
  const deployable = (content) => {
    const { name, type, dependencies } = JSON.parse(content);
    return `${JSON.stringify(
      { name, private: true, type, dependencies: { apps: manifest.version, ...dependencies } },
      null,
      2,
    )}\n`;
  };
  const exampleFiles = await Promise.all(
    examplePaths.map(async (path) => {
      const content = await readFile(resolve(exampleDirectory, path), "utf8");
      return { path, content: path === "package.json" ? deployable(content) : content };
    }),
  );
  const program = ts.createProgram(
    [
      ...authorModules.map(({ file }) => resolve(root, file)),
      ...methods.map(([, file]) => resolve(root, file)),
      ...examplePaths
        .filter((file) => /\.tsx?$/.test(file))
        .map((file) => resolve(exampleDirectory, file)),
    ],
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.ReactJSX,
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      noEmit: true,
    },
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    throw new Error(
      ts.formatDiagnostics(diagnostics, {
        getCurrentDirectory: () => root,
        getCanonicalFileName: (file) => file,
        getNewLine: () => "\n",
      }),
    );
  const checker = program.getTypeChecker();
  const records = new Map();
  const text = (parts) => ts.displayPartsToString(parts);
  const sourceModule = (file) => {
    const source = program.getSourceFile(resolve(root, file));
    const symbol = source && checker.getSymbolAtLocation(source);
    if (!symbol) throw new Error(`Missing reference module: ${file}`);
    return { source, exports: checker.getExportsOfModule(symbol) };
  };
  const resolveAlias = (symbol) =>
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  // Declarations read like a declaration file: class members keep their types, not their bodies.
  const declarationText = (declaration) => {
    const start = declaration.getStart();
    const bodies = (ts.isClassDeclaration(declaration) ? declaration.members : [])
      .flatMap((member) => (member.body === undefined ? [] : [member.body]))
      .sort((a, b) => b.getStart() - a.getStart());
    let source = declaration.getText();
    for (const body of bodies)
      source =
        source.slice(0, body.getStart() - start).trimEnd() +
        ";" +
        source.slice(body.getEnd() - start);
    return source;
  };
  const add = (id, symbol, kind, docs, type) => {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) throw new Error(`Missing declaration: ${id}`);
    const signatures =
      kind === "function" || kind === "method"
        ? checker
            .getSignaturesOfType(type, ts.SignatureKind.Call)
            .map((signature) => checker.signatureToString(signature, declaration, flags))
        : [];
    const definition =
      kind === "type" || kind === "class"
        ? declarationText(declaration)
        : kind === "value"
          ? `const ${symbol.name}: ${checker.typeToString(type, declaration, flags)}`
          : undefined;
    records.set(id, {
      symbol: id,
      kind,
      summary: text(symbol.getDocumentationComment(checker)),
      signatures,
      ...(definition === undefined ? {} : { definition }),
      tags: symbol.getJsDocTags(checker).map((tag) => ({ name: tag.name, text: text(tag.text) })),
      docs,
      source: relative(resolve(root, ".."), declaration.getSourceFile().fileName)
        .split("\\")
        .join("/"),
      related: [],
      examples: ["tools.md", "ui.md", "storage.md"].includes(docs) ? ["live-inbox"] : [],
    });
  };
  const addMethods = (name, type, docs) => {
    for (const property of checker.getPropertiesOfType(type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) continue;
      const member = checker.getTypeOfSymbolAtLocation(property, declaration);
      if (checker.getSignaturesOfType(member, ts.SignatureKind.Call).length)
        add(`${name}.${property.name}`, property, "method", docs, member);
    }
  };
  // Every export an author can import is described; one the reference cannot classify fails the build.
  for (const { module, file, docs } of authorModules) {
    for (const exported of sourceModule(file).exports) {
      const id = `${module}.${exported.name}`;
      const symbol = resolveAlias(exported);
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (!declaration) throw new Error(`Missing declaration: ${id}`);
      const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
      if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length) {
        add(id, symbol, "function", docs, type);
        if (exported.name === "createAppClient") {
          const [signature] = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
          addMethods("AppClient", checker.getReturnTypeOfSignature(signature), docs);
        }
      } else if (symbol.flags & ts.SymbolFlags.Class) {
        add(id, symbol, "class", docs, type);
      } else if (symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias)) {
        add(id, symbol, "type", docs, checker.getDeclaredTypeOfSymbol(symbol));
      } else if (symbol.flags & ts.SymbolFlags.Variable) {
        add(id, symbol, "value", docs, type);
      } else {
        throw new Error(`Unclassified framework export: ${id}`);
      }
      if (records.get(id).summary === "") throw new Error(`Document framework export: ${id}`);
    }
  }
  for (const [name, file, exported, docs] of methods) {
    const symbol = sourceModule(file).exports.find((symbol) => symbol.name === exported);
    if (!symbol) throw new Error(`Missing method contract: ${name}`);
    addMethods(name, checker.getDeclaredTypeOfSymbol(symbol), docs);
    add(name, symbol, "type", docs, checker.getDeclaredTypeOfSymbol(symbol));
  }
  const entries = [...records.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  for (const entry of entries) {
    // Type names only: a qualified name such as Schema.Struct names Effect's namespace, not apps.Schema.
    const tokens = new Set(
      (entry.signatures.join(" ") + " " + (entry.definition ?? "")).match(
        /(?<![\w$])[A-Za-z_$][\w$]*(?![\w$]|\.[A-Za-z_$])/g,
      ),
    );
    entry.related = entries
      .filter(
        (candidate) =>
          (candidate.kind === "type" || candidate.kind === "class") &&
          candidate.symbol !== entry.symbol &&
          (tokens.has(candidate.symbol.split(".").at(-1)) ||
            candidate.symbol === entry.symbol.split(".").slice(0, -1).join(".")),
      )
      .map((entry) => entry.symbol);
  }
  const sourceHash = createHash("sha256");
  for (const source of program
    .getSourceFiles()
    .filter(
      (source) =>
        !source.isDeclarationFile &&
        source.fileName.startsWith(resolve(root, "..") + "/") &&
        !source.fileName.includes("node_modules"),
    )
    .sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    sourceHash
      .update(relative(resolve(root, ".."), source.fileName))
      .update("\0")
      .update(source.text)
      .update("\0");
  }
  sourceHash.update(JSON.stringify(exampleFiles));
  return {
    version: manifest.version,
    digest: sourceHash.digest("hex"),
    entries,
    examples: [{ id: "live-inbox", title: "React UI with live app storage", files: exampleFiles }],
  };
}
