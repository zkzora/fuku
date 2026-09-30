#!/usr/bin/env tsx
/**
 * Move the demo to a fresh cohort of seeded agents. A live action on the demo agents (the pitch's
 * blocked withdraw, the supplier payment) stays on the chain after a demo reset, so those agents no
 * longer verify from the chain at their seeded scores. A new cohort has new agent ids and seeded
 * action ids, and this script brings it to the state the testnet setup left the previous one in:
 *   1. seeds the demo with the new cohort (Ava's identity, wallet and vault are unchanged);
 *   2. anchors its seeded history, as `npm run reconcile -- --anchor-seeded` does;
 *   3. runs `npm run cleanverse:setup`, which opens Ava's mandate for the new Payments Agent and
 *      tops up what earlier runs spent;
 *   4. registers the five agents on the canonical ERC-8004 Identity Registry from Ava's wallet;
 *   5. recomputes each agent's score from the chain (commit-reveal).
 * It prints every transaction and what the run cost the relayer and Ava's wallet in MON. The previous
 * cohort's agents leave the app; their decision records, carried state and on-chain history stay.
 *
 * Environment: web/.env (exported variables take precedence), as for the scripts it replaces:
 * FUKU_CHAIN_MODE=live with the signer key and registry addresses, DATABASE_URL (the app's database),
 * DEMO_OWNER_PRIVATE_KEY, FUKU_AGENT_KEY_SECRET, and FUKU_SPEND_GUARD / CLEANVERSE_SIM_* when deployed.
 * Sends transactions: refuses any RPC but a local node unless --allow-testnet is given.
 *
 * Usage: npm run demo:cohort -- [--label <slug>] [--allow-testnet]
 *        (default label: c<UTC date>-<time>, e.g. c20261001-0930)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const envFile = path.join(webDir, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const defaultLabel = () => `c${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Tx {
  step: string;
  label: string;
  hash: string;
  from: "relayer" | "ava";
}

async function main() {
  const { chainConfig, chainMode, chainReader, onChainWrite, registryAddresses, relayerAddress } = await import("../src/lib/chain");
  const { AgentRegistryAbi } = await import("../src/lib/chain/abi");
  const { db } = await import("../src/lib/db");
  const seed = await import("../src/lib/demo-seed");
  const { anchorSeededHistory } = await import("../src/lib/services/seed-anchor");
  const { registerFromDemoWallet } = await import("../src/lib/services/erc8004");
  const { erc8004IdentityRegistry } = await import("../src/lib/erc8004");
  const { verifyScoreFromChain } = await import("../src/lib/services/verify-score");
  const { idToBytes32 } = await import("../src/lib/ids");

  try {
    const c = chainConfig();
    if (chainMode() !== "live") throw new Error("FUKU_CHAIN_MODE must be live, with DEPLOYER_PRIVATE_KEY and the registry addresses");
    const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(c.rpc);
    if (!local && !process.argv.includes("--allow-testnet")) throw new Error(`${c.rpc} is not a local node; pass --allow-testnet to send transactions there`);
    const avaKey = process.env.DEMO_OWNER_PRIVATE_KEY?.trim();
    if (!avaKey) throw new Error("DEMO_OWNER_PRIVATE_KEY is not set: Ava's wallet opens the mandate and owns the ERC-8004 agents");
    const ava = privateKeyToAccount((avaKey.startsWith("0x") ? avaKey : `0x${avaKey}`) as Hex);
    const relayer = relayerAddress()!;
    const reader = chainReader()!;
    const registries = registryAddresses()!;
    const erc8004 = erc8004IdentityRegistry(c.id);
    if (erc8004 && !process.env.FUKU_AGENT_KEY_SECRET?.trim()) throw new Error("FUKU_AGENT_KEY_SECRET is not set: each agent's ERC-8004 key is sealed under it");

    const previous = await seed.demoCohort(db);
    const label = arg("--label") ?? defaultLabel();
    if (!seed.DEMO_COHORT_PATTERN.test(label)) throw new Error(`--label ${JSON.stringify(label)} must match ${seed.DEMO_COHORT_PATTERN}`);
    if (label === previous) throw new Error(`cohort ${label} is already the active one`);
    const ids = seed.demoAgentIds(label);
    const onChain = await reader.readContract({ address: registries.agents, abi: AgentRegistryAbi, functionName: "exists", args: [idToBytes32(ids.trading)] });
    const records = await db.decisionRecord.count({ where: { actionId: { startsWith: `seed-${label}-` } } });
    if (onChain || records) throw new Error(`cohort ${label} was used before (agent on-chain: ${onChain}, records: ${records}); pick another --label`);

    console.log(`Demo cohort ${previous} -> ${label} on ${c.name} (chain ${c.id}, ${c.rpc})`);
    console.log(`  relayer ${relayer}\n  Ava     ${ava.address}`);
    const balances = async () => ({ relayer: await reader.getBalance({ address: relayer }), ava: await reader.getBalance({ address: ava.address }) });
    const start = await balances();
    console.log(`  balances: relayer ${formatEther(start.relayer)} MON, Ava ${formatEther(start.ava)} MON`);

    const txs: Tx[] = [];
    let step = "seed";
    const stop = onChainWrite((w) => {
      txs.push({ step, label: w.label, hash: w.hash, from: "relayer" });
      console.log(`  tx ${w.label.padEnd(18)} ${w.hash}`);
    });
    const failures: string[] = [];
    const erc8004Ids: Record<string, string | null> = {};
    const verified: Record<string, { ok: boolean; chain: number; anchored: number | null; ledger: number }> = {};
    try {
      console.log(`\n1. Seed cohort ${label}`);
      await seed.setDemoCohort(db, label);
      const { ids: seeded } = await seed.seedDemo(db, { quiet: true });
      for (const [k, id] of Object.entries(seeded)) console.log(`  ${k.padEnd(10)} ${id}`);

      step = "anchor";
      console.log("\n2. Anchor the seeded history");
      const reports = await anchorSeededHistory();
      for (const r of reports) {
        console.log(`  ${r.name}: ${r.anchored} decisions anchored, ${r.alreadyOnChain} already on-chain, ${r.failed} failed, ${r.conflicts.length} conflicts; score ${r.score}${r.scoreAnchored ? " anchored" : " NOT anchored"}`);
        if (r.failed || r.conflicts.length || !r.scoreAnchored) failures.push(`anchor ${r.name}`);
      }
      if (failures.length) throw new Error(`anchoring incomplete (${failures.join(", ")}): re-run \`npm run reconcile -- --anchor-seeded\`, then \`npm run erc8004:register\``);

      step = "mandate";
      if (process.env.FUKU_SPEND_GUARD?.trim()) {
        console.log("\n3. Ava's mandate for the new Payments Agent (npm run cleanverse:setup)");
        // Ava pays her five ERC-8004 registrations next (about 0.24 MON at 102 gwei): top her up first.
        const env = { ...process.env, SETUP_OWNER_MIN_MON: process.env.SETUP_OWNER_MIN_MON ?? "0.35", SETUP_OWNER_TOPUP_MON: process.env.SETUP_OWNER_TOPUP_MON ?? "0.4" };
        const run = spawnSync("npx tsx scripts/setup-cleanverse-demo.ts", { cwd: webDir, env, encoding: "utf8", shell: true });
        process.stdout.write((run.stdout ?? "").replace(/^/gm, "  "));
        if (run.status !== 0) throw new Error(`cleanverse:setup failed: ${(run.stderr || run.stdout || "").trim().split("\n").slice(-3).join(" ")}`);
        for (const line of (run.stdout ?? "").split(/\r?\n/)) {
          const m = line.match(/✓ (.+?)\s+tx (0x[0-9a-fA-F]{64})/);
          if (m) txs.push({ step, label: m[1], hash: m[2], from: m[1].startsWith("Ava ") ? "ava" : "relayer" });
        }
      } else console.log("\n3. No FukuSpendGuard configured: no mandate to open");

      step = "erc8004";
      if (erc8004) {
        console.log(`\n4. ERC-8004 registration from Ava's wallet (Identity Registry ${erc8004})`);
        for (const id of Object.values(ids)) {
          const agent = await db.agent.findUniqueOrThrow({ where: { id } });
          try {
            const { sent, view } = await registerFromDemoWallet(id);
            for (const s of sent) {
              txs.push({ step, label: `${s.op} (${agent.name})`, hash: s.txHash, from: "ava" });
              console.log(`  tx ${s.op.padEnd(18)} ${s.txHash}`);
            }
            erc8004Ids[agent.name] = view.agentId ?? null;
            console.log(`  ${view.complete ? "✓" : "✗"} ${agent.name}: agent #${view.agentId ?? "-"}${view.reason ? ` (${view.reason})` : ""}`);
            if (!view.complete) failures.push(`erc8004 ${agent.name}`);
          } catch (err) {
            failures.push(`erc8004 ${agent.name}`);
            console.log(`  ✗ ${agent.name}: ${(err as Error).message}`);
          }
        }
      } else console.log(`\n4. No canonical ERC-8004 Identity Registry on chain ${c.id}: skipped`);

      step = "verify";
      console.log("\n5. Recompute from chain (commit-reveal)");
      for (const id of Object.values(ids)) {
        const agent = await db.agent.findUniqueOrThrow({ where: { id } });
        let r = await verifyScoreFromChain(id);
        // An indexer (HyperSync) can trail the chain by a few blocks right after the anchoring.
        for (let attempt = 1; !r.verified && attempt <= 3; attempt++) {
          await sleep(10_000);
          r = await verifyScoreFromChain(id);
        }
        verified[agent.name] = { ok: r.verified, chain: r.chainScore, anchored: r.anchored?.score ?? null, ledger: r.ledgerScore };
        console.log(`  ${r.verified ? "✓" : "✗"} ${agent.name}: chain ${r.chainScore} · anchored ${r.anchored?.score ?? "none"} · ledger ${r.ledgerScore} (${r.records.verified}/${r.records.revealed} records)`);
        if (!r.verified) failures.push(`verify ${agent.name}`);
      }
    } finally {
      stop();
    }

    const end = await balances();
    const spent = { relayer: start.relayer - end.relayer, ava: start.ava - end.ava };
    // Monad charges the gas limit, not the gas used: the limits say what a run elsewhere costs.
    let gasLimit = BigInt(0);
    for (const t of txs) gasLimit += (await reader.getTransaction({ hash: t.hash as Hex })).gas;
    console.log(`\nCost: relayer ${formatEther(spent.relayer)} MON, Ava ${formatEther(spent.ava)} MON, together ${formatEther(spent.relayer + spent.ava)} MON`);
    console.log(`  (balance changes, so a top-up from the relayer to Ava cancels out; ${txs.length} transactions)`);
    console.log(`  gas limits ${gasLimit}, i.e. ${formatEther(gasLimit * BigInt(102e9))} MON at 102 gwei`);
    console.log(
      "\nSummary\n" +
        JSON.stringify(
          {
            cohort: label,
            previous,
            chainId: c.id,
            agents: ids,
            erc8004: erc8004Ids,
            verified,
            costMon: { relayer: formatEther(spent.relayer), ava: formatEther(spent.ava), total: formatEther(spent.relayer + spent.ava) },
            gasLimit: gasLimit.toString(),
            transactions: txs,
          },
          null,
          2,
        ),
    );
    if (failures.length) {
      console.log(`\nNot complete: ${failures.join(", ")}`);
      process.exitCode = 1;
    } else console.log(`\nCohort ${label} is ready. Open /api/auth/demo?reset=1&next=/sign-in once before presenting.`);
  } finally {
    await db.$disconnect();
  }
}

// Exit by draining, not process.exit() (see scripts/reconcile.ts).
main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
