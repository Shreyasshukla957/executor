/**
 * Check a tool's advertised signature against a value the tool actually returned. The signature
 * is the TypeScript an agent reads from `tools.search`; the value comes from a real call.
 */
import ts from "typescript-5";

const fileName = "output-contract.ts";

/**
 * TypeScript diagnostics for assigning `value` to the signature's resolved return type, then
 * running `consumer`, which can read `value` as an agent's program would. Empty means it fits.
 */
export const outputContractProblems = (signature: string, value: unknown, consumer = "") => {
  const parameters = signature.indexOf("(");
  if (parameters < 0) return [`not a tool signature: ${signature}`];
  const source = [
    `declare function advertised${signature.slice(parameters)};`,
    `const value: Awaited<ReturnType<typeof advertised>> = ${JSON.stringify(value)};`,
    consumer,
  ].join("\n");
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, ...rest) =>
    name === fileName
      ? ts.createSourceFile(name, source, version, true)
      : getSourceFile(name, version, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => name === fileName || fileExists(name);
  const program = ts.createProgram([fileName], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
};
