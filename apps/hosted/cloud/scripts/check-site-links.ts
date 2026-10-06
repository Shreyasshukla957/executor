/**
 * Fails when a page of the built public site links to a path that would 404.
 *
 * Run after `bun run hosted:cloud:site:build`. It resolves every same-origin
 * href and src in the composed site the way the deployed Worker does: a
 * Worker-first route, then a `_redirects` rule, then an exact static asset.
 * That covers the marketing pages, every docs page, the docs sidebar and the
 * links between them, so a removed or renamed page fails here instead of in
 * production.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect, FileSystem, Path, Schema } from "effect";
import { siteOrigin } from "@executor-js/marketing/site-origin";
import { workerFirstRoutes } from "../src/contracts/worker-first-routes.ts";

export class BrokenSiteLinks extends Schema.TaggedError<BrokenSiteLinks>()("BrokenSiteLinks", {
  links: Schema.Array(Schema.Struct({ target: Schema.String, pages: Schema.Array(Schema.String) })),
}) {}

type Rule = Readonly<{ pattern: RegExp; target: string; status: number }>;

/** Cloudflare route syntax: `:name` matches one segment, a trailing `*` matches the rest. */
const routePattern = (source: string) =>
  new RegExp(
    "^" +
      source
        .split("/")
        .map((segment) =>
          segment === "*"
            ? ".*"
            : segment.startsWith(":")
              ? "[^/]+"
              : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("/") +
      "$",
  );

const checkSiteLinks = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const root = yield* path.fromFileUrl(new URL("../../../..", import.meta.url));
  const site = path.join(root, "apps/hosted/cloud/.generated/site");

  const files = new Set<string>();
  for (const entry of yield* fs.readDirectory(site, { recursive: true })) {
    if ((yield* fs.stat(path.join(site, entry))).type === "File")
      files.add(`/${entry.split(path.sep).join("/")}`);
  }

  const workerRoutes = workerFirstRoutes.map(routePattern);
  const rules: Array<Rule> = (yield* fs.readFileString(path.join(site, "_redirects")))
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(([source]) => source !== undefined && source !== "" && !source.startsWith("#"))
    .map(([source = "", target = "", status = "302"]) => ({
      pattern: routePattern(source),
      target,
      status: Number(status),
    }));

  // Redirect rules can chain; a few hops is far more than the site uses.
  const resolves = (pathname: string, hops = 0): boolean => {
    if (hops > 5) return false;
    if (workerRoutes.some((route) => route.test(pathname))) return true;
    const rule = rules.find((candidate) => candidate.pattern.test(pathname));
    if (rule !== undefined) {
      if (rule.status === 200) return files.has(rule.target);
      return resolves(new URL(rule.target, siteOrigin).pathname, hops + 1);
    }
    return files.has(pathname);
  };

  // The route a page is served at, so relative links resolve as the browser would.
  const pageRoute = (file: string) =>
    file === "/index.html"
      ? "/"
      : file.endsWith("/index.html")
        ? file.slice(0, -"/index.html".length)
        : file.slice(0, -".html".length);

  const broken = new Map<string, Set<string>>();
  for (const file of files) {
    if (!file.endsWith(".html")) continue;
    const page = pageRoute(file);
    const html = yield* fs.readFileString(path.join(site, file));
    for (const [, raw = ""] of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      const reference = raw.replaceAll("&amp;", "&");
      if (reference === "" || reference.startsWith("#")) continue;
      const url = yield* Effect.try(() => new URL(reference, new URL(page, siteOrigin))).pipe(
        Effect.option,
      );
      if (url._tag === "None" || url.value.origin !== siteOrigin) continue;
      const pathname = decodeURIComponent(url.value.pathname);
      if (resolves(pathname)) continue;
      const pages = broken.get(pathname) ?? new Set();
      pages.add(page);
      broken.set(pathname, pages);
    }
  }

  if (broken.size > 0) {
    for (const [target, pages] of broken)
      yield* Effect.logError(`${target} is linked from ${[...pages].join(", ")}`);
    return yield* new BrokenSiteLinks({
      links: [...broken].map(([target, pages]) => ({ target, pages: [...pages] })),
    });
  }
  yield* Effect.log(`Every same-origin link in ${files.size} site files resolves.`);
}).pipe(Effect.provide(NodeServices.layer));

NodeRuntime.runMain(checkSiteLinks);
