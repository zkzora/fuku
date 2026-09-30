import type { Hex } from "viem";
import { db } from "../db";
import { DEMO_IDENTITY_ID } from "../demo-mode";
import { activeDemoAgentIds } from "../demo-seed";
import {
  anchorStateOf,
  chainConfig,
  chainMode,
  chainReader,
  onChainWrite,
  recordDecisionOnChain,
  registryAddresses,
  syncAgentOnChain,
  toAgentRef,
  updateScoreOnChain,
  type ChainWrite,
} from "../chain";
import { ReputationRegistryAbi } from "../chain/abi";
import { hashString, idToBytes32 } from "../ids";
import { scoreAgent } from "./agents";
import { agentChainEvidence } from "./verify-score";

/**
 * Anchor the demo's seeded history (part of the testnet setup, `npm run reconcile -- --anchor-seeded`):
 * register each seeded agent of the active demo cohort and its passport, record each seeded decision
 * on-chain with the proofHash of its record unless that exact proof is already there, and write each
 * agent's ledger score to ReputationRegistry. Where each proof, registration and passport landed is
 * kept (DecisionRecord.anchor*, and the agent and passport rows, which a demo reset carries over), so
 * a reset rebuilds the seeded rows as anchored. Idempotent.
 */
export interface SeedAnchorReport {
  agentId: string;
  name: string;
  anchored: number;
  alreadyOnChain: number;
  /** Seeded actions for which a different proof is on-chain (never overwritten). */
  conflicts: string[];
  failed: number;
  score: number;
  scoreAnchored: boolean;
  /** Sent by this run: the agent's registration and its passport anchor. */
  registeredTx: string | null;
  passportTx: string | null;
}

export async function anchorSeededHistory(): Promise<SeedAnchorReport[]> {
  if (chainMode() !== "live") throw new Error("The chain is mocked: nothing to anchor.");
  const client = chainReader()!;
  const registries = registryAddresses()!;
  const chainId = chainConfig().id;
  const cohortIds = Object.values(await activeDemoAgentIds(db));
  const agents = await db.agent.findMany({
    where: { identityId: DEMO_IDENTITY_ID, id: { in: cohortIds } },
    include: { policy: true, identity: true, actions: { where: { anchorStatus: "seeded" }, orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "asc" },
  });
  const reports: SeedAnchorReport[] = [];
  for (const agent of agents) {
    const ref = toAgentRef(agent, agent.identity);
    const writes: ChainWrite[] = [];
    const stop = onChainWrite((w) => writes.push(w));
    try {
      await syncAgentOnChain(ref);
    } finally {
      stop();
    }
    const registered = writes.find((w) => w.label === "registerAgent");
    const passport = writes.find((w) => w.label === "setPolicy");
    if (registered) await db.agent.update({ where: { id: agent.id }, data: { registeredTx: registered.hash, registeredMode: "anchored" } });
    if (passport) await db.policy.update({ where: { agentId: agent.id }, data: { txHash: passport.hash, anchorMode: "anchored" } });
    const keepAnchor = (actionId: string, proofHash: string, txHash: string | null, block: number | null) =>
      txHash
        ? db.decisionRecord.updateMany({ where: { actionId, proofHash }, data: { anchorChainId: chainId, anchorRegistry: registries.permissions, anchorTx: txHash, anchorBlock: block } })
        : null;
    const onChain = new Map((await agentChainEvidence(agent.id)).decisions.map((d) => [d.actionHash, d]));
    const report: SeedAnchorReport = {
      agentId: agent.id,
      name: agent.name,
      anchored: 0,
      alreadyOnChain: 0,
      conflicts: [],
      failed: 0,
      score: 0,
      scoreAnchored: false,
      registeredTx: registered?.hash ?? null,
      passportTx: passport?.hash ?? null,
    };
    for (const row of agent.actions) {
      const hit = onChain.get(hashString(row.id).toLowerCase() as Hex);
      if (hit) {
        if (hit.proofHash.toLowerCase() !== row.proofHash.toLowerCase()) {
          report.conflicts.push(row.id);
          continue;
        }
        await db.agentAction.update({ where: { id: row.id }, data: { anchorStatus: "anchored", receiptMode: "live", txHash: hit.txHash, chainId } });
        await keepAnchor(row.id, row.proofHash, hit.txHash, null);
        report.alreadyOnChain++;
        continue;
      }
      const receipt = await recordDecisionOnChain({
        agent: ref,
        actionId: row.id,
        allowed: row.decision === "ALLOWED",
        proofHash: row.proofHash as Hex,
        ruleId: row.ruleId ?? (row.decision === "ALLOWED" ? "R6" : "R1"),
      });
      await db.agentAction.update({
        where: { id: row.id },
        data: { anchorStatus: anchorStateOf(receipt), receiptMode: receipt.mode, txHash: receipt.txHash, chainId: receipt.chainId, blockNumber: receipt.block },
      });
      if (receipt.status === "confirmed") {
        await keepAnchor(row.id, row.proofHash, receipt.txHash, receipt.block);
        report.anchored++;
      } else report.failed++;
    }
    const ledger = await scoreAgent(agent.id);
    const [onChainScore, , exists] = await client.readContract({ address: registries.reputation, abi: ReputationRegistryAbi, functionName: "getScore", args: [idToBytes32(agent.id)] });
    report.score = ledger.score;
    if (exists && Number(onChainScore) === ledger.score) report.scoreAnchored = true;
    else {
      const receipt = await updateScoreOnChain(ref, ledger.score, exists ? ledger.score - Number(onChainScore) : 0, "seeded history anchored");
      report.scoreAnchored = receipt.status === "confirmed";
    }
    reports.push(report);
  }
  return reports;
}
