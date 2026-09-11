import { env } from "cloudflare:workers";
import type { Database } from "./accounts";

export function database(): Database | null {
  const binding = (env as { DB?: Database }).DB;
  return binding && typeof binding.prepare === "function" ? binding : null;
}
