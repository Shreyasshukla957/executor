/** Lightweight service contract. Importing this binding never imports React or the dashboard. */
import * as Cloudflare from "alchemy/Cloudflare";
import type { DashboardRenderer } from "../contracts/dashboard.ts";

/** The renderer has no public URL; the API Worker calls it through a private service binding. */
export class Dashboard extends Cloudflare.Worker<Dashboard, DashboardRenderer>()("Dashboard") {}
