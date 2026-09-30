#!/usr/bin/env tsx
/**
 * Register the seeded demo agents (the active demo cohort's five) on the canonical ERC-8004 Identity
 * Registry from Ava's custodial demo wallet (DEMO_OWNER_PRIVATE_KEY): register(agentURI) mints each
 * agent NFT to her wallet, then setAgentWallet binds the agent's own key (sealed under
 * FUKU_AGENT_KEY_SECRET). Each step is
 * confirmed from its receipt and decoded event, then re-read independently.
 *
 * Environment: web/.env, where exported variables take precedence. Needs FUKU_CHAIN_MODE=live on
 * chain 10143, DATABASE_URL (the app's database, demo seeded), DEMO_OWNER_PRIVATE_KEY and
 * FUKU_AGENT_KEY_SECRET. The agentURI is FUKU_PUBLIC_URL's registration endpoint (checked to resolve
 * first) or, when that is unset, a self-contained data: URI.
 * Sends transactions from Ava's wallet: refuses any RPC but a local node (a fork of Monad testnet)
 * unless --allow-testnet is given.
 *
 * Usage: npx tsx scripts/erc8004-register.ts [--agent <fuku agent id>] [--allow-testnet]
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, "..", ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

async function main() {
  const { chainConfig, chainMode, chainReader } = await import("../src/lib/chain");
  const { db } = await import("../src/lib/db");
  const { DEMO_IDENTITY_ID } = await import("../src/lib/demo-mode");
  const { activeDemoAgentIds } = await import("../src/lib/demo-seed");
  const { ERC8004_SOURCE, Erc8004IdentityRegistryAbi, erc8004IdentityRegistry } = await import("../src/lib/erc8004");
  const { registerFromDemoWallet } = await import("../src/lib/services/erc8004");

  const c = chainConfig();
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(c.rpc);
  if (chainMode() !== "live") throw new Error("FUKU_CHAIN_MODE must be live");
  if (!local && !process.argv.includes("--allow-testnet")) throw new Error(`${c.rpc} is not a local node; pass --allow-testnet to send from Ava's wallet there`);
  const registry = erc8004IdentityRegistry(c.id);
  if (!registry) throw new Error(`no canonical ERC-8004 Identity Registry on chain ${c.id}`);
  const reader = chainReader()!;
  const code = await reader.getCode({ address: registry });
  if (!code || code === "0x") throw new Error(`no contract at ${registry} on chain ${c.id}`);
  const version = await reader.readContract({ address: registry, abi: Erc8004IdentityRegistryAbi, functionName: "getVersion" });
  console.log(`chain ${c.id} via ${c.rpc}\nERC-8004 IdentityRegistry ${registry} (code ${(code.length - 2) / 2} bytes, getVersion ${version}; source ${ERC8004_SOURCE.repo}@${ERC8004_SOURCE.commit.slice(0, 7)})\n`);

  const i = process.argv.indexOf("--agent");
  const only = i >= 0 ? process.argv[i + 1] : null;
  // Only the seeded agents: an agent someone registered in the demo account is not Fuku's to publish.
  const ids = only ? [only] : Object.values(await activeDemoAgentIds(db));
  const agents = await db.agent.findMany({ where: { identityId: DEMO_IDENTITY_ID, id: { in: ids } }, orderBy: { createdAt: "asc" } });
  if (agents.length === 0) throw new Error("no demo agents found: reset the demo first");

  let failures = 0;
  for (const agent of agents) {
    try {
      const { sent, view } = await registerFromDemoWallet(agent.id);
      for (const s of sent) console.log(`  ${s.op.padEnd(22)} ${s.txHash}`);
      const id = view.agentId ? BigInt(view.agentId) : null;
      const [owner, agentWallet, tokenURI] = id === null
        ? [null, null, null]
        : await Promise.all([
            reader.readContract({ address: registry, abi: Erc8004IdentityRegistryAbi, functionName: "ownerOf", args: [id] }),
            reader.readContract({ address: registry, abi: Erc8004IdentityRegistryAbi, functionName: "getAgentWallet", args: [id] }),
            reader.readContract({ address: registry, abi: Erc8004IdentityRegistryAbi, functionName: "tokenURI", args: [id] }),
          ]);
      const ok = view.complete;
      if (!ok) failures++;
      console.log(`${ok ? "PASS" : "FAIL"}  ${agent.name}: agent #${view.agentId ?? "-"} ownerOf ${owner ?? "-"} (Ava ${view.ownerWallet}), getAgentWallet ${agentWallet ?? "-"} (agent key ${view.agentWallet ?? "-"})${view.reason ? `, ${view.reason}` : ""}`);
      if (tokenURI) console.log(`      tokenURI ${tokenURI}`);
    } catch (err) {
      failures++;
      console.log(`FAIL  ${agent.name}: ${(err as Error).message}`);
    }
  }
  await db.$disconnect();
  console.log(`\n${agents.length - failures}/${agents.length} registered with the agent's own key as agentWallet`);
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
