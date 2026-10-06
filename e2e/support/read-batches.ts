/**
 * The dashboard sends reads that start together as one `POST /api/dashboard/batch`, naming each
 * read's API group and endpoint, and the host streams each answer as it finishes. Scenarios hold,
 * fail and count reads by routing their own URLs. So that such a route still sees its read, the
 * page's `fetch` sends any batched read an active test route matches as the page's own request,
 * through that route, and merges its answer into the batch's stream as soon as it arrives. A read
 * the route aborts gets no answer, so the dashboard sees it fail. Reads no route matches stay in
 * the batch, and a held read holds back no other.
 */
import type { BrowserContext, Page } from "playwright";

export const batchPath = "/api/dashboard/batch";

/** One read in a batch request's body. */
export interface BatchedRead {
  readonly id: number;
  readonly group: string;
  readonly endpoint: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string | ReadonlyArray<string>>>;
  readonly traceparent?: string;
}

/** The reads a batch request carries. */
export const batchedReads = (body: string | null): ReadonlyArray<BatchedRead> => {
  const parsed: { readonly reads?: ReadonlyArray<BatchedRead> } = JSON.parse(body ?? "{}");
  return parsed.reads ?? [];
};

type Matcher = string | RegExp | ((url: URL) => boolean);
interface Routable {
  route: (url: Matcher, ...rest: Array<never>) => Promise<void>;
  unroute: (url: Matcher, ...rest: Array<never>) => Promise<void>;
}

/** Playwright's glob: a double star and slash span zero or more path segments, a double star
 * anything, and a single star one segment. */
const special = new Set("\\^$.|?+()[]{}");
const globPattern = (glob: string) => {
  let pattern = "";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      index++;
      if (glob[index + 1] === "/") {
        index++;
        pattern += "(?:.+/)?";
      } else pattern += ".*";
    } else if (char === "*") pattern += "[^/]*";
    else pattern += special.has(char ?? "") ? `\\${char}` : (char ?? "");
  }
  return new RegExp(`^${pattern}$`);
};

const matches = (matcher: Matcher, url: URL, base: string) => {
  if (typeof matcher === "function") return matcher(url);
  if (matcher instanceof RegExp) return new RegExp(matcher.source, matcher.flags).test(url.href);
  // Like Playwright, a glob that does not start with `*` is resolved against the base URL.
  return globPattern(matcher.startsWith("*") ? matcher : new URL(matcher, base).href).test(
    url.href,
  );
};

interface OpenApiDocument {
  readonly paths: Readonly<Record<string, Readonly<Record<string, { operationId?: string }>>>>;
}

/** The host's public API document names each operation `group.endpoint` and gives its path. */
const operationPaths = (document: OpenApiDocument) => {
  const paths = new Map<string, string>();
  for (const [path, item] of Object.entries(document.paths))
    for (const operation of Object.values(item))
      if (operation.operationId !== undefined) paths.set(operation.operationId, path);
  return paths;
};

/** The URL a batched read would have had as the page's own request. */
const readUrl = (paths: ReadonlyMap<string, string>, read: BatchedRead, base: string) => {
  const template = paths.get(`${read.group}.${read.endpoint}`);
  if (template === undefined) throw new Error(`No API path for ${read.group}.${read.endpoint}`);
  const url = new URL(
    template.replace(/\{(\w+)\}/g, (_, name: string) =>
      encodeURIComponent(read.params[name] ?? ""),
    ),
    base,
  );
  for (const [name, value] of Object.entries(read.query))
    for (const entry of typeof value === "string" ? [value] : value)
      url.searchParams.append(name, entry);
  return url;
};

/** The page-side half: split each batch the dashboard sends by asking which reads are routed. */
const splitInPage = ({ batchPath, binding }: { batchPath: string; binding: string }) => {
  const native = window.fetch;
  const original = native.bind(window);
  const textOf = (body: unknown) =>
    typeof body === "string"
      ? body
      : body instanceof Uint8Array || body instanceof ArrayBuffer
        ? new TextDecoder().decode(body)
        : undefined;
  const split: typeof window.fetch = (input, init) => {
    // Frames such as `about:blank` cannot resolve a relative URL; their requests pass through.
    const url = URL.parse(input instanceof Request ? input.url : String(input), location.href);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const text = textOf(init?.body);
    const routedReads: unknown = Reflect.get(window, binding);
    if (
      url === null ||
      url.origin !== location.origin ||
      url.pathname !== batchPath ||
      method !== "POST" ||
      text === undefined ||
      typeof routedReads !== "function"
    )
      return original(input, init);
    return Promise.resolve(routedReads(text)).then((routed: Array<string | null>) => {
      if (routed.every((href) => href === null)) return original(input, init);
      const reads: Array<{ readonly id: number; readonly traceparent?: string }> =
        JSON.parse(text).reads;
      const encoder = new TextEncoder();
      let sink: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          sink = controller;
        },
      });
      const send = (line: string) => sink?.enqueue(encoder.encode(`${line}\n`));
      const own = reads.flatMap((read, index) => {
        const href = routed[index];
        if (href === null || href === undefined) return [];
        return [
          original(href, {
            headers: read.traceparent === undefined ? {} : { traceparent: read.traceparent },
            signal: init?.signal ?? null,
          }).then(
            (response) =>
              response.arrayBuffer().then((buffer) => {
                const contentType = response.headers.get("content-type");
                const bytes = new Uint8Array(buffer);
                const textual =
                  contentType === null ||
                  /^(application\/([\w.+-]*\+)?json|text\/)/i.test(contentType);
                send(
                  JSON.stringify({
                    id: read.id,
                    status: response.status,
                    ...(contentType === null ? {} : { contentType }),
                    ...(bytes.length === 0
                      ? {}
                      : textual
                        ? { text: new TextDecoder().decode(bytes) }
                        : { bytes: btoa(String.fromCharCode(...bytes)) }),
                  }),
                );
              }),
            // A read the route aborts has no answer; the dashboard sees it fail.
            () => undefined,
          ),
        ];
      });
      const kept = reads.filter((_, index) => routed[index] === null);
      const batched =
        kept.length === 0
          ? Promise.resolve()
          : original(input, { ...init, body: JSON.stringify({ reads: kept }) }).then(
              (response) => {
                const reader = response.ok ? response.body?.getReader() : undefined;
                const decoder = new TextDecoder();
                let buffered = "";
                // Forward whole lines only, so answers merged from both sides never interleave.
                const pump = (): Promise<void> =>
                  reader === undefined
                    ? Promise.resolve()
                    : reader.read().then((chunk) => {
                        if (chunk.done) return;
                        buffered += decoder.decode(chunk.value, { stream: true });
                        const lines = buffered.split("\n");
                        buffered = lines.pop() ?? "";
                        lines.filter((line) => line !== "").forEach(send);
                        return pump();
                      });
                return pump();
              },
              () => undefined,
            );
      void Promise.all([...own, batched]).then(() => sink?.close());
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    });
  };
  // Libraries such as Sentry fetch through a sandboxed frame when `fetch` is not native, where a
  // relative URL cannot resolve. They keep using the page's `fetch`, as they do without this test.
  Object.defineProperty(split, "toString", {
    value: () => Function.prototype.toString.call(native),
  });
  window.fetch = split;
};

const binding = "__executorRoutedReads";

/** Split every batch pages of `context` send so that reads test routes match leave it. */
export const splitRoutedReads = (context: BrowserContext, base: string) => {
  const active = new Map<Matcher, number>();
  let document: Promise<ReadonlyMap<string, string>> | undefined;
  const track = (target: Routable) => {
    const route = target.route.bind(target);
    const unroute = target.unroute.bind(target);
    target.route = (url, ...rest) =>
      route(url, ...rest).then(() => {
        active.set(url, (active.get(url) ?? 0) + 1);
      });
    target.unroute = (url, ...rest) =>
      unroute(url, ...rest).then(() => {
        const count = (active.get(url) ?? 1) - 1;
        if (count > 0) active.set(url, count);
        else active.delete(url);
      });
  };
  /** For each read of a batch, its URL if an active test route matches it. */
  const routed = (body: string): Promise<ReadonlyArray<string | null>> => {
    const reads = batchedReads(body);
    if (active.size === 0) return Promise.resolve(reads.map(() => null));
    document ??= context.request
      .get(new URL("/openapi.json", base).href)
      .then((response) => response.json())
      .then(operationPaths);
    return document.then((paths) =>
      reads.map((read) => {
        const url = readUrl(paths, read, base);
        return [...active.keys()].some((matcher) => matches(matcher, url, base)) ? url.href : null;
      }),
    );
  };
  const trackPage = (page: Page) => track(page as unknown as Routable);
  return context
    .exposeBinding(binding, (_source, body: string) => routed(body))
    .then(() => context.addInitScript(splitInPage, { batchPath, binding }))
    .then(() => {
      track(context as unknown as Routable);
      context.pages().forEach(trackPage);
      context.on("page", trackPage);
    });
};
