#!/usr/bin/env tsx
/**
 * Recompute trust scores from on-chain evidence (read-only; sends nothing). For each agent it prints
 * every score input as the chain shows it and as Fuku's ledger holds it, the score recomputed from
 * the chain, the score Fuku anchored in ReputationRegistry, and what the chain cannot show.
 * Events come from Envio HyperSync when ENVIO_API_TOKEN is set (and the chain is not a local node),
 * otherwise from eth_getLogs.
 *
 * Environment: web/.env (exported variables take precedence): FUKU_CHAIN_MODE=live, the registry
 * addresses, DATABASE_URL, optionally FUKU_SPEND_GUARD, CLEANVERSE_SIM_APASS, ENVIO_API_TOKEN.
 *
 * Usage: npx tsx scripts/verify-score.ts [--agent <fuku agent id>]   (default: every agent)
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, "..", ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function main() {
  const { db } = await import("../src/lib/db");
  const { verifyScoreFromChain } = await import("../src/lib/services/verify-score");
  const i = process.argv.indexOf("--agent");
  const only = i >= 0 ? process.argv[i + 1] : null;
  const agents = await db.agent.findMany({ where: only ? { id: only } : {}, orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
  let mismatches = 0;
  for (const a of agents) {
    try {
      const r = await verifyScoreFromChain(a.id);
      const ok = r.matches.anchored || !r.anchored;
      if (!ok) mismatches++;
      console.log(`\n${a.name} (${a.id})`);
      console.log(
        `  from chain ${r.chainScore} · chain alone ${r.chainOnlyScore} · anchored ${r.anchored?.score ?? "none"} · ledger ${r.ledgerScore}   [${ok ? "anchored score reproduced" : "anchored score NOT reproduced"}]`,
      );
      for (const input of r.inputs) console.log(`  ${input.label.padEnd(24)} chain ${String(input.chain ?? "not on-chain").padEnd(12)} ledger ${input.ledger}`);
      console.log(`  events via ${r.events.source}: ${r.events.decisions} decisions, ${r.events.executions} transfers, blocks ${r.events.fromBlock}-${r.events.toBlock}${r.events.complete ? "" : " (incomplete)"}`);
      for (const n of r.notes) console.log(`  - ${n}`);
    } catch (err) {
      mismatches++;
      console.log(`\n${a.name} (${a.id})\n  error: ${(err as Error).message}`);
    }
  }
  await db.$disconnect();
  console.log(`\n${agents.length - mismatches}/${agents.length} agents: the anchored score is reproduced from the chain (or none is anchored)`);
  if (mismatches) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
