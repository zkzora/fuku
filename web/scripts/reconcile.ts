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
  const { db } = await import("../src/lib/db");
  try {
    console.log(JSON.stringify(await reconcile({ limit })));
  } finally {
    await db.$disconnect();
  }
}

// Exit by draining, not process.exit(): on Windows, exiting while the database engine or an HTTP
// socket is still closing aborts Node (libuv UV_HANDLE_CLOSING assertion) with a non-zero code.
main().then(
  () => {
    process.exitCode = 0;
  },
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
