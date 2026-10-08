/**
 * Cloud's public site is served for requests at the edge (standing in for `executor.sh`, which
 * v1 forwards to v2). Its canonical URLs name the edge, its sign-in links open the browser origin,
 * and the deployment and browser origins send their site pages there.
 */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { rawRequest, targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

const html = { headers: { accept: "text/html" } };

layer(TestLive, { excludeTestServices: true })("Cloud site on the edge", (it) => {
  it.effect(scenarios.cloudSiteEdge.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const hosts = targetHosts(yield* Target);
        const { edge, browser: app, deployment } = hosts;

        // The edge serves the homepage itself, never a redirect, with its canonical URL there.
        const home = yield* rawRequest(`${edge}/`, html);
        expect(home.status).toBe(200);
        expect(home.cacheControl).toContain("no-store");
        expect(home.text).toContain(`<link rel="canonical" href="${edge}/"`);
        // Sign-in and sign-up open the browser origin.
        expect(home.text).toContain(`href="${app}/login?mode=signup"`);
        expect(home.text).not.toContain('href="/login');

        // Pages, docs and their Markdown come from the site's files with their own headers.
        for (const path of ["/pricing", "/docs", "/docs/mcp", "/blog", "/setup-prompt.md"]) {
          const page = yield* rawRequest(`${edge}${path}`, html);
          expect(page.status, path).toBe(200);
        }
        const pricing = yield* rawRequest(`${edge}/pricing`, html);
        expect(pricing.text).toContain(`<link rel="canonical" href="${edge}/pricing`);
        expect(pricing.text).toContain(`href="${app}/login?mode=signup"`);
        const markdown = yield* rawRequest(`${edge}/docs/mcp.md`);
        expect(markdown.status).toBe(200);
        expect(markdown.contentType).toContain("text/markdown");
        const skills = yield* rawRequest(`${edge}/.well-known/agent-skills/index.json`);
        expect(skills.status).toBe(200);
        // Demos live under `/experiments`, which v1 forwards; `/demo` is a v1 organization.
        expect((yield* rawRequest(`${edge}/experiments/demo/posthog`, html)).status).toBe(200);
        // Pages v1 keeps are not served for the edge: its sign-in and its Google OAuth
        // verification pages. (Static files reach a local Cloud's assets on any host, so
        // `/demo` and the favicons are held to v1 by the contract v1 tests, not here.)
        for (const path of ["/login", "/privacy", "/terms", "/google-oauth"])
          expect((yield* rawRequest(`${edge}${path}`, html)).status, path).toBe(404);
        // An old demo link on the deployment origin finds the demo's new path.
        const demo = yield* rawRequest(`${deployment}/demo/posthog`, html);
        expect(demo.status).toBe(301);
        expect(new URL(demo.location ?? "", deployment).pathname).toBe("/experiments/demo/posthog");

        // The deployment origin sends its site to the edge, path and query intact, and its
        // homepage there for a browser without a session.
        for (const path of [
          "/",
          "/pricing?ref=nav",
          "/docs/mcp",
          "/blog",
          "/.well-known/agent-skills/index.json",
        ]) {
          const moved = yield* rawRequest(`${deployment}${path}`, html);
          expect(moved.status, path).toBe(308);
          expect(moved.location, path).toBe(`${edge}${path}`);
        }
        // So does the browser origin, whose homepage is sign-in for a visitor without a session.
        const appPricing = yield* rawRequest(`${app}/pricing`, html);
        expect(appPricing.status).toBe(308);
        expect(appPricing.location).toBe(`${edge}/pricing`);
        const appHome = yield* rawRequest(`${app}/`, html);
        expect(appHome.status).toBe(307);
        expect(appHome.location).toBe(`${app}/login`);
        // The site's static files load from any host.
        const style = home.text.match(/href="(\/_astro\/[^"]+\.css)"/)?.[1];
        expect(style).toBeDefined();
        for (const at of [edge, deployment])
          expect((yield* rawRequest(`${at}${style}`)).status, at).toBe(200);
      }),
    ),
  );
});
