import { hostedServerValues } from "@executor-js/hosted-web/document";
import { entryOrganizationsAtom } from "@executor-js/hosted-web/contracts/organization";
import { getGlobalStartContext } from "@tanstack/react-start";
import { Option, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { OnboardingReady } from "../../../src/contracts/onboarding.ts";
import type { CloudDocumentContext } from "../contracts/document.ts";
import { entryTeamAtom } from "../contracts/onboarding.ts";

/** Server only: the context the Worker passed with this document request. */
export const serverDocument = (): CloudDocumentContext => {
  const document = getGlobalStartContext();
  if (document === undefined)
    throw new Error("The document context is only available on the server");
  return document;
};

/** Sign-in and setup pages start from the membership and team data the Worker resolved. */
export const cloudServerValues = (document: CloudDocumentContext) => {
  const entry = document.entry;
  const shared = hostedServerValues(document);
  if (entry === null || entry.session === null || entry.onboarding === null) return shared;
  return [
    ...shared,
    Atom.initialValue(
      entryOrganizationsAtom,
      Option.some(
        Schema.is(OnboardingReady)(entry.onboarding) ? entry.onboarding.organizations : [],
      ),
    ),
    Atom.initialValue(entryTeamAtom(entry.session.user.id), Option.some(entry.onboarding)),
  ];
};

declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: CloudDocumentContext };
  }
}
