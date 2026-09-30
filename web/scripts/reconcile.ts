#!/usr/bin/env tsx
/**
 * Settle in-flight guarded transfers, re-check recent confirmations for reorgs, retry failed decision
 * anchors and watch allowance changes. Idempotent; safe to run on a schedule (cron) next to the web app.
 *
 * With --anchor-seeded (part of the testnet setup, after a demo reset): anchor the demo's seeded
 * history instead, printing every transaction it sends. Idempotent as well.
 *
 * Usage: npm run reconcile [-- --limit 100]
 *        npm run reconcile -- --anchor-seeded
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
  const { db } = await import("../src/lib/db");
  try {
    if (process.argv.includes("--anchor-seeded")) {
      const { onChainWrite } = await import("../src/lib/chain");
      const { anchorSeededHistory } = await import("../src/lib/services/seed-anchor");
      const stop = onChainWrite((w) => console.log(`tx ${w.label.padEnd(16)} ${w.hash} block ${w.block}`));
      try {
        console.log(JSON.stringify(await anchorSeededHistory(), null, 2));
      } finally {
        stop();
      }
      return;
    }
    const { reconcile } = await import("../src/lib/services/reconcile");
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
