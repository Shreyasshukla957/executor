/** Client-side navigation in a running dashboard, as a link click performs it. */
import { Effect } from "effect";
import { Browser } from "./browser.ts";

/**
 * A document load arrives with its data rendered on the server, so its loading states are never
 * shown in the browser. A navigation inside the running page reads through the browser, which is
 * where held requests and loading states can be observed. The page must already be a hydrated
 * dashboard document.
 */
export const openInApp = (label: string, path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use(label, (page) =>
      page.evaluate((to) => window.history.pushState(window.history.state, "", to), path),
    );
  });

/**
 * A dashboard page that reads no app, account or resource data. Hosted pages start from their
 * organization's Connect page; account pages name that organization in their `organization`
 * search parameter, because only dashboard routes are served as dashboard documents (Cloud serves
 * other paths as static assets). The local dashboard has no organizations and serves `/connect`.
 */
const neutralPage = (destination: URL) => {
  const organization =
    /^\/org\/([^/?#]+)/.exec(destination.pathname)?.[1] ??
    destination.searchParams.get("organization");
  return organization === null ? "/connect" : `/org/${organization}/connect`;
};

/**
 * Load a dashboard page that does not read the destination's data, then navigate to the
 * destination in the browser so its reads, holds and fixtures apply there.
 */
export const openThroughBrowser = (label: string, path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const destination = new URL(path, "http://dashboard.invalid");
    const local = destination.origin === "http://dashboard.invalid";
    yield* browser.use(`${label}: start from another page`, (page) =>
      page.goto(
        local ? neutralPage(destination) : new URL(neutralPage(destination), destination).href,
      ),
    );
    yield* openInApp(label, local ? path : destination.pathname + destination.search);
  });
