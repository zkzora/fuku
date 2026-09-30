import { getAbiItem, type Address, type Hex } from "viem";
import { db } from "../db";
import { chainConfig, chainMode, chainReader, logChunkSize, registryAddresses, spendGuardAddress } from "../chain";
import { CleanverseAPassSimAbi, FukuSpendGuardAbi, HumanIdentityRegistryAbi, PermissionRegistryAbi, ReputationRegistryAbi } from "../chain/abi";
import { computeScore, isViolation, SCORING_VERSION } from "../engine/reputation";
import { hashString, idToBytes32 } from "../ids";
import { fetchRegistryEvents, startBlock } from "../integrations/envio";
import { parseRecord, recordHash } from "../records";
import { countEvents, SCORED_EVENTS } from "./agents";
import { apassEligibleFor, cleanverseRuntime } from "./cleanverse";

/**
 * "Recompute from chain", commit-reveal: take the decision records Fuku reveals for an agent, check
 * each one's hash against the proofHash anchored on-chain for its action, and recompute fuku-score/2
 * from checked records and on-chain state only. On-chain decisions without a revealed record count
 * against the agent where they could (a denial), and a record whose hash does not match is reported.
 * Inputs the chain does not commit to are named in `notCommitted`.
 */

export interface ChainDecision {
  actionHash: Hex;
  proofHash: Hex;
  allowed: boolean;
  ruleId: string;
  txHash: Hex;
  timestamp: number | null;
}
export interface ChainExecution {
  actionHash: Hex;
  proofHash: Hex;
  txHash: Hex;
}
export interface AgentEvidence {
  source: "rpc" | "envio-hypersync";
  fromBlock: number;
  toBlock: number;
  complete: boolean;
  decisions: ChainDecision[];
  executions: ChainExecution[];
}

const MAX_RPC_CHUNKS = 400;
const lower = (h: string) => h.toLowerCase() as Hex;

async function rpcEvidence(agentKey: Hex, permissions: Address, guard: Address | null): Promise<AgentEvidence> {
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
  const decisions: ChainDecision[] = [];
  const executions: ChainExecution[] = [];
  for (let from = fromBlock; from <= toBlock; from += chunk) {
    const to = from + chunk - BigInt(1) > toBlock ? toBlock : from + chunk - BigInt(1);
    const [d, e] = await Promise.all([
      client.getLogs({ address: permissions, event: decisionEvent, args: { agentId: agentKey }, fromBlock: from, toBlock: to }),
      guard ? client.getLogs({ address: guard, event: executedEvent, args: { agentId: agentKey }, fromBlock: from, toBlock: to }) : Promise.resolve([]),
    ]);
    for (const log of d) {
      decisions.push({
        actionHash: lower(log.args.actionHash!),
        proofHash: lower(log.args.proofHash!),
        allowed: Boolean(log.args.allowed),
        ruleId: String(log.args.ruleId),
        txHash: log.transactionHash,
        timestamp: log.args.timestamp ? Number(log.args.timestamp) : null,
      });
    }
    for (const log of e) executions.push({ actionHash: lower(log.args.actionHash!), proofHash: lower(log.args.proofHash!), txHash: log.transactionHash });
  }
  return { source: "rpc", fromBlock: Number(fromBlock), toBlock: Number(toBlock), complete: true, decisions, executions };
}

async function hypersyncEvidence(agentId: string): Promise<AgentEvidence> {
  const feed = await fetchRegistryEvents({ subjects: [agentId], limit: 100_000 });
  const decisions = feed.events
    .filter((e) => e.kind === "ActionDecision")
    .map((e) => ({
      actionHash: lower(String(e.args.actionHash)),
      proofHash: lower(String(e.args.proofHash)),
      allowed: e.args.allowed === true || e.args.allowed === "true",
      ruleId: String(e.args.ruleId),
      txHash: e.txHash as Hex,
      timestamp: e.timestamp ? Math.floor(Date.parse(e.timestamp) / 1000) : null,
    }));
  const executions = feed.events
    .filter((e) => e.kind === "GuardedTransferExecuted")
    .map((e) => ({ actionHash: lower(String(e.args.actionHash)), proofHash: lower(String(e.args.proofHash)), txHash: e.txHash as Hex }));
  return { source: "envio-hypersync", fromBlock: feed.fromBlock, toBlock: feed.scannedTo, complete: feed.scannedTo >= feed.height, decisions, executions };
}

/** Every ActionDecision and GuardedTransferExecuted for the agent (HyperSync off a local node when configured). */
export async function agentChainEvidence(agentId: string): Promise<AgentEvidence> {
  const registries = registryAddresses();
  if (chainMode() !== "live" || !registries) throw new Error("The chain is mocked: there is nothing on-chain to read.");
  const useHyperSync = chainConfig().id !== 31337 && Boolean(process.env.ENVIO_API_TOKEN?.trim());
  return useHyperSync ? hypersyncEvidence(agentId) : rpcEvidence(idToBytes32(agentId), registries.permissions, spendGuardAddress());
}

export interface RevealedRecord {
  actionId: string;
  record: string;
}

export interface EvidenceAssessment {
  revealed: number;
  verified: number;
  /** Records whose hash is not what the chain holds for their action (or that are not v2 records). */
  mismatched: { actionId: string; reason: string }[];
  /** Records with nothing anchored for their action. Not counted. */
  unanchored: string[];
  /** On-chain decisions no revealed record accounts for. Counted from the on-chain data alone. */
  unrevealed: { actionHash: Hex; allowed: boolean; ruleId: string; txHash: Hex }[];
  successes: { transfers: number; legacy: number };
  violations: number;
  firstEvidenceAt: number | null;
}

/**
 * Check revealed records against on-chain decisions and executions, and count what they prove.
 *  - verified record: success when an on-chain transfer executed for the action, or when it is seeded
 *    history marked "legacy-success"; violation when it is a denial the agent caused (isViolation,
 *    with the committed sub-code and guard reason);
 *  - on-chain decision without a (matching) record: a transfer still counts as a success (it is its
 *    own proof); a denial counts as a violation whenever its rule could be the agent's fault, R10
 *    included, because the reason that would clear it is not revealed.
 */
export function assessEvidence(input: { agentId: string; records: RevealedRecord[]; decisions: ChainDecision[]; executions: ChainExecution[] }): EvidenceAssessment {
  const byAction = new Map<string, ChainDecision[]>();
  for (const d of input.decisions) byAction.set(d.actionHash, [...(byAction.get(d.actionHash) ?? []), d]);
  const executed = new Map<string, ChainExecution>();
  for (const e of input.executions) executed.set(e.actionHash, e);

  const out: EvidenceAssessment = { revealed: input.records.length, verified: 0, mismatched: [], unanchored: [], unrevealed: [], successes: { transfers: 0, legacy: 0 }, violations: 0, firstEvidenceAt: null };
  const covered = new Set<string>();
  for (const r of input.records) {
    const actionHash = lower(hashString(r.actionId));
    const record = parseRecord(r.record);
    const onChain = byAction.get(actionHash) ?? [];
    const execution = executed.get(actionHash);
    if (onChain.length === 0 && !execution) {
      out.unanchored.push(r.actionId);
      continue;
    }
    const hash = lower(recordHash(r.record));
    const anchoredHashes = new Set([...onChain.map((d) => d.proofHash), ...(execution ? [execution.proofHash] : [])]);
    let problem: string | null = null;
    if (!record) problem = "not a v2 decision record";
    else if (record.actionId !== r.actionId || record.agentId !== input.agentId) problem = "the record names another action or agent";
    else if (!anchoredHashes.has(hash)) problem = "its hash differs from the proofHash anchored for the action";
    else if (anchoredHashes.size > 1) problem = "different proofs are anchored for the same action";
    else if (onChain.some((d) => d.allowed !== (record.decision === "ALLOWED") || (!execution && d.ruleId !== record.ruleId))) problem = "the on-chain decision or rule differs from the record";
    if (problem || !record) {
      out.mismatched.push({ actionId: r.actionId, reason: problem ?? "invalid" });
      continue; // counted below from the on-chain data, as if unrevealed
    }
    covered.add(actionHash);
    out.verified++;
    if (execution) out.successes.transfers++;
    else if (record.decision === "ALLOWED" && record.outcome === "legacy-success") out.successes.legacy++;
    else if (record.decision === "BLOCKED" && isViolation(record.ruleId, record.subCode, record.guardReason)) out.violations++;
  }

  for (const [actionHash, decisions] of byAction) {
    if (covered.has(actionHash)) continue;
    const d = decisions[0];
    out.unrevealed.push({ actionHash: d.actionHash, allowed: d.allowed, ruleId: d.ruleId, txHash: d.txHash });
    if (executed.has(actionHash)) out.successes.transfers++;
    else if (!d.allowed && (isViolation(d.ruleId) || d.ruleId === "R10")) out.violations++;
  }
  const times = input.decisions.map((d) => d.timestamp).filter((t): t is number => t !== null);
  out.firstEvidenceAt = times.length ? Math.min(...times) : null;
  return out;
}

export interface ScoreInput {
  key: "passkey" | "apass" | "policy" | "successes" | "violations" | "security";
  label: string;
  chain: number | boolean | null;
  ledger: number | boolean;
  committed: boolean;
}

export interface ScoreVerification {
  agentId: string;
  scoringVersion: string;
  chainId: number;
  events: { source: AgentEvidence["source"]; fromBlock: number; toBlock: number; complete: boolean; decisions: number; executions: number };
  records: EvidenceAssessment;
  inputs: ScoreInput[];
  /** fuku-score/2 from verified records and on-chain state; inputs the chain lacks come from the ledger. */
  chainScore: number;
  anchored: { score: number; updatedAt: string } | null;
  ledgerScore: number;
  /** ✓: every record checks out, nothing on-chain is unrevealed, and chain, anchored and ledger scores agree. */
  verified: boolean;
  /** v2 inputs (or parts of them) that are not committed on-chain. */
  notCommitted: string[];
  notes: string[];
}

/** The records Fuku reveals for an agent (all it ever anchored or prepared, across demo resets). */
export async function revealRecords(agentId: string): Promise<{ actionId: string; actionHash: Hex; proofHash: string; record: string }[]> {
  const rows = await db.decisionRecord.findMany({ where: { agentId }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({ actionId: r.actionId, actionHash: hashString(r.actionId), proofHash: r.proofHash, record: r.record }));
}

export async function verifyScoreFromChain(agentId: string): Promise<ScoreVerification> {
  if (chainMode() !== "live") throw new Error("The chain is mocked: there is nothing on-chain to recompute from.");
  const client = chainReader()!;
  const registries = registryAddresses()!;
  const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId }, include: { policy: true, identity: true, reputationEvents: SCORED_EVENTS } });
  const identity = agent.identity;
  const agentKey = idToBytes32(agent.id);
  const c = chainConfig();

  const [evidence, records, identityRow, policy, anchoredRaw, latest] = await Promise.all([
    agentChainEvidence(agent.id),
    revealRecords(agent.id),
    client.readContract({ address: registries.identity, abi: HumanIdentityRegistryAbi, functionName: "identities", args: [idToBytes32(identity.id)] }),
    client.readContract({ address: registries.permissions, abi: PermissionRegistryAbi, functionName: "policies", args: [agentKey] }),
    client.readContract({ address: registries.reputation, abi: ReputationRegistryAbi, functionName: "getScore", args: [agentKey] }),
    client.getBlock(),
  ]);
  const assessment = assessEvidence({ agentId: agent.id, records, decisions: evidence.decisions, executions: evidence.executions });

  // The A-Pass is on-chain only as the simulator contract; a Cleanverse API read is off-chain.
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
  const ledgerInputs = { passkeyVerified: identity.humanVerified, apassEligible: await apassEligibleFor(identity), hasActivePolicy: Boolean(agent.policy?.active), ...ledger };
  const chainSuccesses = assessment.successes.transfers + assessment.successes.legacy;
  const chainInputs = {
    passkeyVerified: Boolean(identityRow[4]),
    apassEligible: apassOnChain ?? ledgerInputs.apassEligible,
    hasActivePolicy: Boolean(policy[3]),
    successes: chainSuccesses,
    violations: assessment.violations,
    securityEvents: ledger.securityEvents,
    firstEvidenceAt: assessment.firstEvidenceAt ? new Date(assessment.firstEvidenceAt * 1000) : null,
  };
  const inputs: ScoreInput[] = [
    { key: "passkey", label: "Passkey-verified owner", chain: chainInputs.passkeyVerified, ledger: ledgerInputs.passkeyVerified, committed: true },
    { key: "apass", label: "Cleanverse A-Pass", chain: apassOnChain, ledger: ledgerInputs.apassEligible, committed: apassOnChain !== null },
    { key: "policy", label: "Active passport", chain: chainInputs.hasActivePolicy, ledger: ledgerInputs.hasActivePolicy, committed: true },
    { key: "successes", label: "Completed actions", chain: chainSuccesses, ledger: ledger.successes, committed: true },
    { key: "violations", label: "Violations", chain: assessment.violations, ledger: ledger.violations, committed: true },
    { key: "security", label: "Security events", chain: null, ledger: ledger.securityEvents, committed: false },
  ];

  const chainScore = computeScore(chainInputs).score;
  const ledgerScore = computeScore(ledgerInputs).score;
  const anchored = anchoredRaw[2] ? { score: Number(anchoredRaw[0]), updatedAt: new Date(Number(anchoredRaw[1]) * 1000).toISOString() } : null;

  const notCommitted = [
    "Security events: in Fuku's ledger only.",
    apassOnChain === null
      ? "Cleanverse A-Pass: a Cleanverse API read (or DB fixtures), not a contract; taken from Fuku's last persisted read."
      : "Cleanverse A-Pass: read from the simulator contract, not from Cleanverse.",
    "Passkey flag: set on-chain by Fuku's relayer as registry owner; it attests the ceremony, it does not prove it.",
    ...(assessment.successes.legacy > 0
      ? [`${assessment.successes.legacy} completed action(s) are seeded history: committed by Fuku's own records ("legacy-success"), not proven by an on-chain transfer.`]
      : []),
  ];
  const notes: string[] = [];
  if (!evidence.complete) notes.push(`The event scan stopped at block ${evidence.toBlock}; later events are not counted.`);
  if (assessment.mismatched.length) notes.push(`${assessment.mismatched.length} revealed record(s) do not match the chain: ${assessment.mismatched.map((m) => `${m.actionId} (${m.reason})`).join("; ")}.`);
  if (assessment.unrevealed.length) notes.push(`${assessment.unrevealed.length} on-chain decision(s) have no revealed record; they count from the on-chain data alone.`);
  if (assessment.unanchored.length) notes.push(`${assessment.unanchored.length} record(s) are not anchored on-chain (not counted).`);
  if (ledgerScore !== chainScore) notes.push(`The ledger says ${ledgerScore}; the chain supports ${chainScore}.`);
  if (!anchored) notes.push("No score is anchored in ReputationRegistry for this agent.");
  else if (anchored.score !== chainScore) notes.push(`ReputationRegistry holds ${anchored.score}; the chain supports ${chainScore}.`);

  const verified = assessment.mismatched.length === 0 && assessment.unrevealed.length === 0 && evidence.complete && ledgerScore === chainScore && anchored?.score === chainScore;
  return {
    agentId: agent.id,
    scoringVersion: SCORING_VERSION,
    chainId: c.id,
    events: { source: evidence.source, fromBlock: evidence.fromBlock, toBlock: evidence.toBlock, complete: evidence.complete, decisions: evidence.decisions.length, executions: evidence.executions.length },
    records: assessment,
    inputs,
    chainScore,
    anchored,
    ledgerScore,
    verified,
    notCommitted,
    notes,
  };
}
