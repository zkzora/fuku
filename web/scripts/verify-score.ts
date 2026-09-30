#!/usr/bin/env tsx
/**
 * Recompute trust scores from the chain, commit-reveal (read-only; sends nothing). For each agent:
 * the decision records Fuku reveals are checked against the proofHash anchored for each action, the
 * score is recomputed from checked records and on-chain state, and compared with the score anchored in
 * ReputationRegistry and with Fuku's ledger. The v2 inputs the chain does not commit to are listed.
 * Events come from Envio HyperSync when ENVIO_API_TOKEN is set (and the chain is not a local node),
 * otherwise from eth_getLogs.
 *
 * Environment: web/.env (exported variables take precedence): FUKU_CHAIN_MODE=live, the registry
 * addresses, DATABASE_URL, optionally FUKU_SPEND_GUARD, CLEANVERSE_SIM_APASS, ENVIO_API_TOKEN.
 *
 * Usage: npx tsx scripts/verify-score.ts [--agent <fuku agent id> | --demo]   (default: every agent;
 *        --demo: the seeded agents of the active demo cohort)
 * Exit code 0 when every agent checked verifies.
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
  const { activeDemoAgentIds } = await import("../src/lib/demo-seed");
  const i = process.argv.indexOf("--agent");
  const only = i >= 0 ? [process.argv[i + 1]] : process.argv.includes("--demo") ? Object.values(await activeDemoAgentIds(db)) : null;
  const agents = await db.agent.findMany({ where: only ? { id: { in: only } } : {}, orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
  let failures = 0;
  for (const a of agents) {
    try {
      const r = await verifyScoreFromChain(a.id);
      if (!r.verified) failures++;
      console.log(`\n${r.verified ? "✓" : "✗"} ${a.name} (${a.id})`);
      console.log(`  from chain ${r.chainScore} · anchored ${r.anchored?.score ?? "none"} · ledger ${r.ledgerScore}`);
      console.log(
        `  records: ${r.records.verified}/${r.records.revealed} match their on-chain proofs, ${r.records.mismatched.length} mismatched, ${r.records.unanchored.length} not anchored; ${r.records.unrevealed.length} on-chain decisions without a record`,
      );
      for (const input of r.inputs) console.log(`  ${input.label.padEnd(24)} chain ${String(input.chain ?? "not on-chain").padEnd(12)} ledger ${String(input.ledger).padEnd(6)}${input.committed ? "" : " (not committed)"}`);
      console.log(`  events via ${r.events.source}: ${r.events.decisions} decisions, ${r.events.executions} transfers, blocks ${r.events.fromBlock}-${r.events.toBlock}${r.events.complete ? "" : " (incomplete)"}`);
      for (const n of r.notCommitted) console.log(`  not committed: ${n}`);
      for (const n of r.notes) console.log(`  - ${n}`);
    } catch (err) {
      failures++;
      console.log(`\n✗ ${a.name} (${a.id})\n  error: ${(err as Error).message}`);
    }
  }
  await db.$disconnect();
  console.log(`\n${agents.length - failures}/${agents.length} agents verified from the chain`);
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
