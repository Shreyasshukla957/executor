import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import type { Page } from "playwright";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Workspace } from "../support/app-authoring.ts";
import { appsManifest } from "../support/apps-release.ts";
import { scenarios } from "../test-plan.ts";

// Deliberately not in the editor's own style: `*` bullets and a padded table must survive
// untouched when the person edits a different block.
const skill = `---
name: search-messages
description: Search team messages.
license: MIT
---
# Search messages

Use the \`search\` tool to find messages, then summarize them.

## Steps

1. Call \`search\` with the user's topic.
2. Group results by channel:
   \`\`\`ts
   const byChannel = Object.groupBy(results, (m) => m.channel);
   \`\`\`

* Prefer recent messages.
* Never quote private channels.

| Tool   | Purpose          |
|:-------|:-----------------|
| search | Full-text search |
`;
const edited = skill
  .replace("description: Search team messages.", "description: Search and cite team messages.")
  .replace("then summarize them.\n", "then summarize them.\n\nAlways cite the channel.\n");
const files = [
  {
    path: "index.ts",
    content:
      'import { defineApp } from "apps"; export default defineApp({ accounts: {} }, async () => ({}));',
  },
  { path: "skills/search-messages/SKILL.md", content: skill },
  appsManifest,
];
const skillPath = "skills/search-messages/SKILL.md";
const Running = Schema.Struct({ sourceCommit: Schema.String, files: Workspace.fields.files });

layer(HostedLive, { excludeTestServices: true })("Skill editor", (it) => {
  it.effect(scenarios.skillEditor.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Skill editor ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(
            Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
            Effect.orDie,
          ),
        );
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        expect(
          (yield* api.request(actors.owner, "PATCH", `${path}/access`, {
            revision: access.revision,
            audience: { kind: "everyone" },
          })).status,
        ).toBe(200);
        const workspace = () =>
          Effect.flatMap(api.request(actors.owner, "GET", `${path}/workspace`), (response) =>
            body(Workspace, response),
          );
        const skillFile = (snapshot: { readonly files: typeof Workspace.Type.files }) =>
          snapshot.files.find((file) => file.path === skillPath)?.content;

        const page = (label: string, action: (page: Page) => Promise<unknown>) =>
          browser.use(label, action);
        const instructions = (page: Page) =>
          page.getByRole("textbox", { name: "Skill instructions", exact: true });
        // Place the caret like a click at the text's end, then wait for the selectionchange that
        // ProseMirror reads: it handles Enter with the selection it last read, not the DOM caret.
        const caretAtEnd = (page: Page, text: string) =>
          instructions(page)
            .getByText(text)
            .evaluate(
              (element) =>
                new Promise<void>((resolve) => {
                  document.addEventListener(
                    "selectionchange",
                    () => requestAnimationFrame(() => resolve()),
                    { once: true },
                  );
                  const range = document.createRange();
                  range.selectNodeContents(element);
                  range.collapse(false);
                  getSelection()?.removeAllRanges();
                  getSelection()?.addRange(range);
                }),
            );
        const skillUrl = `/org/${actors.organization.slug}/apps/${app.id}?view=skills`;

        yield* browser.login(actors.owner);
        yield* page("Open the skill", (page) => page.goto(skillUrl));
        // Editors never enter a separate mode: the page itself becomes editable.
        yield* page("Wait for the editor", (page) => instructions(page).waitFor());
        yield* browser.checkpoint("Visual skill editor");
        yield* page("Focus the editor", (page) => instructions(page).click());
        yield* page("Place the cursor after the first paragraph", (page) =>
          caretAtEnd(page, "then summarize them."),
        );
        yield* page("Start a paragraph", (page) => page.keyboard.press("Enter"));
        yield* page("Type the paragraph", (page) => page.keyboard.type("Always cite the channel."));
        // The visual editor reports Markdown after a short pause; the draft exists once it does.
        yield* page("The paragraph is an unsaved change", (page) =>
          page.getByRole("button", { name: "Discard", exact: true }).waitFor(),
        );
        yield* page("Edit the description", (page) =>
          page
            .getByRole("textbox", { name: "Description", exact: true })
            .fill("Search and cite team messages."),
        );
        yield* browser.checkpoint("Edited skill");
        yield* page("Save the skill", (page) =>
          page.getByRole("button", { name: "Save", exact: true }).click(),
        );
        yield* page("Saving clears the draft", (page) =>
          page.getByRole("button", { name: "Discard", exact: true }).waitFor({ state: "hidden" }),
        );

        // Only the edited description and the new paragraph change; other bytes stay as written.
        const committed = yield* workspace();
        expect(skillFile(committed)).toBe(edited);
        const history = yield* body(
          Schema.Array(Schema.Struct({ commit: Schema.String, message: Schema.String })),
          yield* api.request(actors.owner, "GET", `${path}/history`),
        );
        expect(history[0]).toEqual({
          commit: committed.revision.commit,
          message: "Update search-messages skill",
        });
        // Saving also deploys the new commit.
        const running = yield* api.request(actors.owner, "GET", `${path}/source`).pipe(
          Effect.flatMap((response) => body(Running, response)),
          Effect.filterOrFail(
            (source) => source.sourceCommit === committed.revision.commit,
            () => new Error("The saved commit is not deployed yet"),
          ),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 80 }),
        );
        expect(skillFile(running)).toBe(edited);
        yield* page("The deployment status clears", (page) =>
          page.getByRole("status").filter({ hasText: "Saved" }).waitFor({ state: "hidden" }),
        );
        yield* browser.checkpoint("Saved and deployed");

        // Someone else changes the same file while a draft is open; the draft must survive.
        yield* page("Focus the editor again", (page) => instructions(page).click());
        yield* page("Place the cursor after the new paragraph", (page) =>
          caretAtEnd(page, "Always cite the channel."),
        );
        yield* page("Extend the paragraph", (page) => page.keyboard.type(" Link each message."));
        yield* page("The extension is an unsaved change", (page) =>
          page.getByRole("button", { name: "Discard", exact: true }).waitFor(),
        );
        const concurrent = yield* api.request(actors.owner, "POST", `${path}/commits`, {
          expected: committed.revision.commit,
          files: committed.files.map((file) =>
            file.path === skillPath ? { ...file, content: `${edited}\nConcurrent edit.\n` } : file,
          ),
          message: "Concurrent edit",
        });
        expect(concurrent.status).toBe(200);
        yield* page("Save against the changed file", (page) =>
          page.getByRole("button", { name: "Save", exact: true }).click(),
        );
        yield* page("Wait for the conflict", (page) =>
          page.getByRole("alert").filter({ hasText: "Someone else changed this file" }).waitFor(),
        );
        yield* page("The draft is still in the editor", (page) =>
          instructions(page).getByText("Always cite the channel. Link each message.").waitFor(),
        );
        yield* browser.checkpoint("Conflicting edit keeps the draft");
        expect(skillFile(yield* workspace())).toBe(`${edited}\nConcurrent edit.\n`);
        yield* page("Discard the draft", (page) => {
          page.once("dialog", (dialog) => void dialog.accept());
          return page.getByRole("button", { name: "Discard", exact: true }).click();
        });
        yield* page("Discarding loads the latest version", (page) =>
          instructions(page).getByText("Concurrent edit.").waitFor(),
        );
        expect(skillFile(yield* workspace())).toBe(`${edited}\nConcurrent edit.\n`);

        yield* browser.login(actors.member);
        yield* page("Open the skill as a member", (page) => page.goto(skillUrl));
        yield* page("Wait for the member's skill", (page) =>
          page
            .getByRole("region", { name: "App skills", exact: true })
            .getByText("Always cite the channel.")
            .waitFor(),
        );
        expect(
          yield* page("Members read skills without editing", (page) => instructions(page).count()),
        ).toBe(0);
      }),
    ),
  );
});
