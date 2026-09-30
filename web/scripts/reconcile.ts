#!/usr/bin/env tsx
/**
 * Settle in-flight guarded transfers, re-check recent confirmations for reorgs, and retry failed
 * decision anchors. Idempotent; safe to run on a schedule (cron) next to the web app.
 * Usage: npm run reconcile [-- --limit 100]
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envFile = path.resolve(here, "..", ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const i = process.argv.indexOf("--limit");
  const limit = i >= 0 ? Number(process.argv[i + 1]) : 100;
  // Imported after the env file is loaded, so the database and chain settings come from it.
  const { reconcile } = await import("../src/lib/services/reconcile");
  console.log(JSON.stringify(await reconcile({ limit })));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
