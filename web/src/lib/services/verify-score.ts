import type { Address, Hex } from "viem";
import { getAbiItem } from "viem";
import { db } from "../db";
import { chainConfig, chainMode, chainReader, logChunkSize, registryAddresses, spendGuardAddress } from "../chain";
import { CleanverseAPassSimAbi, FukuSpendGuardAbi, HumanIdentityRegistryAbi, PermissionRegistryAbi, ReputationRegistryAbi } from "../chain/abi";
import { computeScore, isViolation, SCORING_VERSION } from "../engine/reputation";
import { idToBytes32 } from "../ids";
import { fetchRegistryEvents, startBlock } from "../integrations/envio";
import { countEvents, SCORED_EVENTS } from "./agents";
import { apassEligibleFor, cleanverseRuntime } from "./cleanverse";

/**
 * Recompute an agent's trust score (fuku-score/2) from what the chain shows, and name the inputs it
 * cannot show. On-chain: the passkey flag (HumanIdentityRegistry), the passport's state
 * (PermissionRegistry.policies), confirmed guarded transfers (GuardedTransferExecuted), anchored
 * denials with their rule id (ActionDecision), the simulator A-Pass (sim-chain mode), and the score
 * Fuku anchored (ReputationRegistry). Not on-chain: a Cleanverse A-Pass read through the API, the
 * reason behind an R10 denial (so R10 counts as neutral here), security events, and ledger events
 * that were never anchored (mock mode, a failed anchor, the seeded demo history).
 */

export type ScoreInputKey = "passkey" | "apass" | "policy" | "successes" | "violations" | "security";

export interface ScoreInput {
  key: ScoreInputKey;
  label: string;
  /** What the chain shows; null when the chain cannot show it. */
  chain: number | boolean | null;
  /** What Fuku's ledger (database) uses. */
  ledger: number | boolean;
  source: "chain" | "not-on-chain";
}

export interface ScoreVerification {
  agentId: string;
  scoringVersion: string;
  chainId: number;
  events: { source: "rpc" | "envio-hypersync"; fromBlock: number; toBlock: number; complete: boolean; decisions: number; executions: number; r10Denials: number };
  inputs: ScoreInput[];
  /** computeScore over the chain's inputs, taking the ones it cannot show from the ledger. */
  chainScore: number;
  /** The same with those inputs at their neutral value: the score from the chain alone. */
  chainOnlyScore: number;
  anchored: { score: number; updatedAt: string } | null;
  ledgerScore: number;
  matches: { anchored: boolean; ledger: boolean };
  notes: string[];
}

type Decision = { allowed: boolean; ruleId: string; at: number | null };

const MAX_RPC_CHUNKS = 400;

/** ActionDecision and GuardedTransferExecuted logs for one agent over RPC (a local node, or a short range). */
async function rpcEvidence(agentKey: Hex, permissions: Address, guard: Address | null) {
  const client = chainReader()!;
  const toBlock = await client.getBlockNumber();
  // A local node is scanned from genesis; elsewhere from the registries' first block (ENVIO_START_BLOCK).
  const fromBlock = chainConfig().id === 31337 ? BigInt(0) : BigInt(startBlock());
  if (fromBlock > toBlock) throw new Error(`ENVIO_START_BLOCK ${fromBlock} is beyond the chain head ${toBlock}`);
  const chunk = logChunkSize();
  if ((toBlock - fromBlock) / chunk > BigInt(MAX_RPC_CHUNKS)) {
    throw new Error(`blocks ${fromBlock}-${toBlock} are too many to scan over RPC; set ENVIO_API_TOKEN to use HyperSync (or ENVIO_START_BLOCK)`);
  }
  const decisionEvent = getAbiItem({ abi: PermissionRegistryAbi, name: "ActionDecision" });
  const executedEvent = getAbiItem({ abi: FukuSpendGuardAbi, name: "GuardedTransferExecuted" });
  const decisions: Decision[] = [];
  let executions = 0;
  for (let from = fromBlock; from <= toBlock; from += chunk) {
    const to = from + chunk - BigInt(1) > toBlock ? toBlock : from + chunk - BigInt(1);
    const [d, e] = await Promise.all([
      client.getLogs({ address: permissions, event: decisionEvent, args: { agentId: agentKey }, fromBlock: from, toBlock: to }),
      guard ? client.getLogs({ address: guard, event: executedEvent, args: { agentId: agentKey }, fromBlock: from, toBlock: to }) : Promise.resolve([]),
    ]);
    for (const log of d) decisions.push({ allowed: Boolean(log.args.allowed), ruleId: String(log.args.ruleId), at: log.args.timestamp ? Number(log.args.timestamp) : null });
    executions += e.length;
  }
  return { source: "rpc" as const, fromBlock: Number(fromBlock), toBlock: Number(toBlock), complete: true, decisions, executions };
}

/** The same through Envio HyperSync (a long testnet history). */
async function hypersyncEvidence(agentId: string) {
  const feed = await fetchRegistryEvents({ subjects: [agentId], limit: 100_000 });
  const decisions: Decision[] = feed.events
    .filter((e) => e.kind === "ActionDecision")
    .map((e) => ({ allowed: e.args.allowed === true || e.args.allowed === "true", ruleId: String(e.args.ruleId), at: e.timestamp ? Math.floor(Date.parse(e.timestamp) / 1000) : null }));
  const executions = feed.events.filter((e) => e.kind === "GuardedTransferExecuted").length;
  return { source: "envio-hypersync" as const, fromBlock: feed.fromBlock, toBlock: feed.scannedTo, complete: feed.scannedTo >= feed.height, decisions, executions };
}

export async function verifyScoreFromChain(agentId: string): Promise<ScoreVerification> {
  if (chainMode() !== "live") throw new Error("The chain is mocked: there is nothing on-chain to recompute from.");
  const client = chainReader()!;
  const registries = registryAddresses();
  if (!registries) throw new Error("Fuku registry addresses are not configured");
  const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId }, include: { policy: true, identity: true, reputationEvents: SCORED_EVENTS } });
  const identity = agent.identity;
  const agentKey = idToBytes32(agent.id);
  const guard = spendGuardAddress();
  const c = chainConfig();

  const useHyperSync = c.id !== 31337 && Boolean(process.env.ENVIO_API_TOKEN?.trim());
  const [evidence, identityRow, policy, anchoredRaw, latest] = await Promise.all([
    useHyperSync ? hypersyncEvidence(agent.id) : rpcEvidence(agentKey, registries.permissions, guard),
    client.readContract({ address: registries.identity, abi: HumanIdentityRegistryAbi, functionName: "identities", args: [idToBytes32(identity.id)] }),
    client.readContract({ address: registries.permissions, abi: PermissionRegistryAbi, functionName: "policies", args: [agentKey] }),
    client.readContract({ address: registries.reputation, abi: ReputationRegistryAbi, functionName: "getScore", args: [agentKey] }),
    client.getBlock(),
  ]);

  // A-Pass: on-chain only for the simulator contract; the Cleanverse API is off-chain.
  let apassOnChain: boolean | null = null;
  const apassSim = process.env.CLEANVERSE_SIM_APASS?.trim() as Address | undefined;
  if (cleanverseRuntime().backend === "sim-chain" && apassSim) {
    const wallet = identity.walletVerifiedBy ? (identity.walletAddress as Address | null) : null;
    if (!wallet) apassOnChain = false;
    else {
      const pass = await client.readContract({ address: apassSim, abi: CleanverseAPassSimAbi, functionName: "passOf", args: [wallet] });
      apassOnChain = pass.status === 1 && (pass.expiresAt === BigInt(0) || pass.expiresAt > latest.timestamp);
    }
  }

  const ledger = countEvents(agent.reputationEvents);
  const ledgerInputs = {
    passkeyVerified: identity.humanVerified,
    apassEligible: await apassEligibleFor(identity),
    hasActivePolicy: Boolean(agent.policy?.active),
    ...ledger,
  };
  const denials = evidence.decisions.filter((d) => !d.allowed);
  const r10Denials = denials.filter((d) => d.ruleId === "R10").length;
  const chainViolations = denials.filter((d) => isViolation(d.ruleId)).length;
  const firstAt = [...evidence.decisions.map((d) => d.at)].filter((t): t is number => t !== null).sort((a, b) => a - b)[0];
  const chainInputs = {
    passkeyVerified: Boolean(identityRow[4]),
    apassEligible: apassOnChain ?? ledgerInputs.apassEligible,
    hasActivePolicy: Boolean(policy[3]),
    successes: evidence.executions,
    violations: chainViolations,
    securityEvents: ledger.securityEvents,
    firstEvidenceAt: firstAt ? new Date(firstAt * 1000) : null,
  };

  const inputs: ScoreInput[] = [
    { key: "passkey", label: "Passkey-verified owner", chain: chainInputs.passkeyVerified, ledger: ledgerInputs.passkeyVerified, source: "chain" },
    { key: "apass", label: "Cleanverse A-Pass", chain: apassOnChain, ledger: ledgerInputs.apassEligible, source: apassOnChain === null ? "not-on-chain" : "chain" },
    { key: "policy", label: "Active passport", chain: chainInputs.hasActivePolicy, ledger: ledgerInputs.hasActivePolicy, source: "chain" },
    { key: "successes", label: "Confirmed transfers", chain: evidence.executions, ledger: ledger.successes, source: "chain" },
    { key: "violations", label: "Violations", chain: chainViolations, ledger: ledger.violations, source: "chain" },
    { key: "security", label: "Security events", chain: null, ledger: ledger.securityEvents, source: "not-on-chain" },
  ];

  const chainScore = computeScore(chainInputs).score;
  const chainOnlyScore = computeScore({ ...chainInputs, apassEligible: apassOnChain ?? false, securityEvents: 0 }).score;
  const ledgerScore = computeScore(ledgerInputs).score;
  const anchored = anchoredRaw[2] ? { score: Number(anchoredRaw[0]), updatedAt: new Date(Number(anchoredRaw[1]) * 1000).toISOString() } : null;

  const notes: string[] = [];
  if (!evidence.complete) notes.push(`The event scan stopped at block ${evidence.toBlock}; later events are not counted.`);
  if (apassOnChain === null) notes.push("The A-Pass comes from the Cleanverse API (or DB fixtures), not from a contract: taken from Fuku's last persisted read.");
  if (r10Denials > 0) notes.push(`${r10Denials} R10 denial(s) count as neutral: whether one was the agent's fault depends on the guard's revert reason, which is off-chain.`);
  if (ledger.securityEvents > 0) notes.push(`${ledger.securityEvents} security event(s) exist only in Fuku's ledger.`);
  if (ledger.successes > evidence.executions) notes.push(`${ledger.successes - evidence.executions} success(es) in the ledger have no GuardedTransferExecuted on-chain (recorded before anchoring, in mock mode, or seeded).`);
  if (ledger.violations > chainViolations) notes.push(`${ledger.violations - chainViolations} violation(s) in the ledger have no on-chain ActionDecision here (not anchored yet, an R10 reason, or seeded).`);
  if (evidence.executions > ledger.successes) notes.push(`${evidence.executions - ledger.successes} transfer(s) executed on-chain that the ledger does not credit: not reconciled yet (run reconcile), or the ledger was reset.`);
  if (chainViolations > ledger.violations) notes.push(`${chainViolations - ledger.violations} violation(s) anchored on-chain that the ledger does not hold: the ledger was reset or rows were removed.`);
  if (!anchored) notes.push("No score was anchored in ReputationRegistry for this agent yet.");

  return {
    agentId: agent.id,
    scoringVersion: SCORING_VERSION,
    chainId: c.id,
    events: { source: evidence.source, fromBlock: evidence.fromBlock, toBlock: evidence.toBlock, complete: evidence.complete, decisions: evidence.decisions.length, executions: evidence.executions, r10Denials },
    inputs,
    chainScore,
    chainOnlyScore,
    anchored,
    ledgerScore,
    matches: { anchored: anchored?.score === chainScore, ledger: ledgerScore === chainScore },
    notes,
  };
}
