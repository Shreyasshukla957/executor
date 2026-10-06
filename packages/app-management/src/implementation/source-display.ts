import { Array as Arr, Effect } from "effect";
import { SourceError, type SourceFile, type SourceFiles } from "@executor-js/sdk/core";
import {
  SourceFormatter,
  sourceDisplayInlineLimits,
  sourceDisplayLimits,
  type SourceDisplayEntries,
  type SourceDisplayEntry,
  type SourceDisplayFile,
} from "../contracts/source-display.ts";

const byteSize = (content: string) => new TextEncoder().encode(content).byteLength;

/** Format the given files and return each formatted text by path. */
const formatted = (files: ReadonlyArray<SourceFile>) =>
  (files.length === 0
    ? Effect.succeed(files)
    : Effect.flatMap(SourceFormatter, (formatter) => formatter.format(files))
  ).pipe(Effect.map((files) => new Map(files.map((file) => [file.path, file.content]))));

/** A formatter returns every file it was given; anything else is a host defect. */
const formattedContent = (contents: ReadonlyMap<string, string>, file: SourceFile) => {
  const content = contents.get(file.path);
  return content === undefined
    ? Effect.die(new Error(`Source formatter omitted ${file.path}`))
    : Effect.succeed(content);
};

/**
 * List an authorized source response for read-only display. Never write it back.
 * Every file keeps its path and stored size. Only files within the inline budget carry
 * contents, and only those are formatted. The inline budget bounds parser work;
 * sequential files bound parser memory.
 */
export const sourceDisplay = <A extends { readonly files: SourceFiles }>(
  source: A,
): Effect.Effect<
  Omit<A, "files"> & { readonly files: typeof SourceDisplayEntries.Type },
  never,
  SourceFormatter
> =>
  Effect.gen(function* () {
    let remaining = sourceDisplayInlineLimits.requestBytes;
    const listed = Arr.map(source.files, (file) => {
      const size = byteSize(file.content);
      const inline = size <= sourceDisplayInlineLimits.fileBytes && size <= remaining;
      if (inline) remaining -= size;
      return { file, size, inline };
    });
    const contents = yield* formatted(
      listed.filter(({ inline }) => inline).map(({ file }) => file),
    );
    const entry = ({ file, size, inline }: (typeof listed)[number]) =>
      inline
        ? formattedContent(contents, file).pipe(
            Effect.map((content): SourceDisplayEntry => ({ path: file.path, size, content })),
          )
        : Effect.succeed<SourceDisplayEntry>({ path: file.path, size });
    const [first, ...rest] = listed;
    return {
      ...source,
      files: [yield* entry(first), ...(yield* Effect.forEach(rest, entry))],
    };
  });

/**
 * Display one file from an immutable source. Invalid, unsupported, and over-budget files
 * retain their exact original contents.
 */
export const sourceDisplayFile = (
  files: SourceFiles,
  path: string,
): Effect.Effect<SourceDisplayFile, SourceError, SourceFormatter> =>
  Effect.gen(function* () {
    const file = files.find((file) => file.path === path);
    if (file === undefined) return yield* new SourceError({ reason: "not-found" });
    const size = byteSize(file.content);
    const content =
      size <= sourceDisplayLimits.fileBytes
        ? yield* formattedContent(yield* formatted([file]), file)
        : file.content;
    return { path: file.path, size, content };
  });
