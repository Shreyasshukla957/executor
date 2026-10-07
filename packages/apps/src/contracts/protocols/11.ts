/**
 * Host protocol 11: protocol 10 plus app events.
 *
 * Requirements carry the events an app declares (`events`), so a host lists them without
 * evaluating the app. A successful reply carries the occurrences its invocation emitted
 * (`events`). Older bundles never send either, so their requirements declare no events and their
 * replies emit none. Every other message is protocol 10's, re-exported unchanged.
 *
 * Once released this protocol is frozen like the earlier ones: `bun run check` compares `protocol11`
 * with `packages/apps/protocols/11.json`. Define the next protocol instead of editing this file.
 * See notes/apps-publishing.md.
 */
import { Schema } from "effect";
import { DeclaredEvents, EmittedEvents } from "../events.ts";
import { JsonValue } from "../schema.ts";
import { DeclaredRequirements as PreviousRequirements, HostError, protocol10 } from "./10.ts";

export * from "./10.ts";

/** Protocol 10's requirements, plus the app's declared events. */
export const DeclaredRequirements = Schema.Struct({
  ...PreviousRequirements.fields,
  events: Schema.optionalKey(DeclaredEvents),
});
export type DeclaredRequirements = typeof DeclaredRequirements.Type;

/** Portable response envelope. A success carries the events its invocation emitted, if any. */
export const HostResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    value: JsonValue,
    toolError: Schema.optionalKey(Schema.Literal(true)),
    events: Schema.optionalKey(EmittedEvents),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: HostError }),
]);
export type HostResponse = typeof HostResponse.Type;

/** Every message of protocol 11, in the order its snapshot records them. */
export const protocol11 = {
  version: 11,
  schemas: {
    ...protocol10.schemas,
    requirements: DeclaredRequirements,
    response: HostResponse,
  },
} as const;
