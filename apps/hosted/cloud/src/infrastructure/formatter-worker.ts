/** Lightweight service contract. Importing this binding never imports Prettier. */
import * as Cloudflare from "alchemy/Cloudflare";
import type { SourceFormat } from "../contracts/formatter.ts";

/** The formatter has no public URL; the API Worker calls it through a private service binding. */
export class Formatter extends Cloudflare.Worker<Formatter, SourceFormat>()("Formatter") {}
