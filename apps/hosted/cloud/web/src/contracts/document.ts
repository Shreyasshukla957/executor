/** Request data the Worker hands to the document renderer. */
import type { HostedDocument } from "@executor-js/hosted-web/document";
import type { CloudEntryPage } from "../../../src/contracts/entry.ts";

export interface CloudDocumentContext extends HostedDocument {
  /** Sign-in or team setup data the Worker resolved for this page, if it is an entry page. */
  readonly entry: CloudEntryPage | null;
}
