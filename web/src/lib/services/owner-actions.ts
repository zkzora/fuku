import type { Identity } from "@prisma/client";
import { decodeEventLog, encodeFunctionData, isAddressEqual, zeroAddress, type Address, type Hex, type Log } from "viem";
import { db } from "../db";
import { chainConfig, chainMode, chainReader, readAgentOnChain, recordDecisionOnChain, relayerAddress, registryAddresses, setHumanVerifiedOnChain } from "../chain";
import { AgentRegistryAbi, HumanIdentityRegistryAbi, PermissionRegistryAbi } from "../chain/abi";
import { custodyFor } from "../custody";
import { RequestError } from "../errors";
import { hashJson, idToBytes32 } from "../ids";

/**
 * Owner-signed registry writes for owner-controlled identities (lib/custody.ts).
 *
 * Fuku never signs these. It lists what the owner's wallet still has to send (by comparing the
 * database with the registries), prepares the exact calldata, and after the owner broadcasts it,
 * confirms by reading the receipt and the decoded event. Only then does the database record the
 * transaction. The registries themselves enforce that only the controller can send them.
 */
export type OwnerOp = "registerIdentity" | "registerAgent" | "setPolicy" | "revokePolicy" | "setStatus";

export interface OwnerAction {
  op: OwnerOp;
  agentId: string | null;
  description: string;
  tx: { chainId: number; from: Address; to: Address; data: Hex; value: "0x0" };
}

export interface OwnerActionsView {
  custody: "relayer" | "owner";
  wallet: string | null;
  controller: string | null;
  reason: "mock-chain" | "custodial" | "no-wallet" | null;
  actions: OwnerAction[];
}

const STATUS_CODE: Record<string, number> = { registered: 0, active: 1, paused: 2 };

/** What the owner's wallet still has to sign for `identity` and its agents, in order. */
export async function pendingOwnerActions(identity: Identity): Promise<OwnerActionsView> {
  const custody = custodyFor(identity);
  const wallet = identity.walletVerifiedBy ? identity.walletAddress : null;
  const base = { custody, wallet, controller: null as string | null, actions: [] as OwnerAction[] };
  if (chainMode() !== "live") return { ...base, reason: "mock-chain" };
  const client = chainReader();
  const a = registryAddresses();
  if (!client || !a) return { ...base, reason: "mock-chain" };

  const key = idToBytes32(identity.id);
  const [controller] = await client.readContract({ address: a.identity, abi: HumanIdentityRegistryAbi, functionName: "identities", args: [key] });
  const view = { ...base, controller: controller === zeroAddress ? null : controller.toLowerCase() };
  if (custody !== "owner") return { ...view, reason: "custodial" };
  if (!wallet) return { ...view, reason: "no-wallet" };
  const from = wallet as Address;
  const chainId = chainConfig().id;
  const tx = (to: Address, data: Hex) => ({ chainId, from, to, data, value: "0x0" as const });
  const actions: OwnerAction[] = [];

  if (controller === zeroAddress) {
    actions.push({
      op: "registerIdentity",
      agentId: null,
      description: "Register your Fuku identity with your wallet as its on-chain controller",
      tx: tx(
        a.identity,
        encodeFunctionData({
          abi: HumanIdentityRegistryAbi,
          functionName: "registerIdentity",
          args: [key, (identity.proofHash as Hex) ?? key, (identity.proofHash as Hex) ?? key],
        }),
      ),
    });
  } else if (!isAddressEqual(controller, from)) {
    // Registered by someone else (e.g. the relayer before custody existed): nothing the owner can sign.
    return { ...view, reason: "custodial" };
  }

  const agents = await db.agent.findMany({ where: { identityId: identity.id }, include: { policy: true }, orderBy: { createdAt: "asc" } });
  for (const agent of agents) {
    const agentKey = idToBytes32(agent.id);
    const onChain = controller === zeroAddress ? null : await readAgentOnChain(agent.id);
    if (!onChain?.exists) {
      actions.push({
        op: "registerAgent",
        agentId: agent.id,
        description: `Register agent "${agent.name}" under your identity`,
        tx: tx(
          a.agents,
          encodeFunctionData({
            abi: AgentRegistryAbi,
            functionName: "registerAgent",
            args: [agentKey, key, agent.name, agent.version, hashJson(JSON.parse(agent.capabilities)), `fuku://agents/${agent.id}`],
          }),
        ),
      });
    }
    const p = agent.policy;
    const hashMatches = Boolean(onChain?.policyActive && p?.policyHash && onChain.policyHash?.toLowerCase() === p.policyHash.toLowerCase());
    if (p?.active && p.policyHash && !hashMatches) {
      actions.push({
        op: "setPolicy",
        agentId: agent.id,
        description: `Anchor passport v${p.version} of "${agent.name}"`,
        tx: tx(
          a.permissions,
          encodeFunctionData({
            abi: PermissionRegistryAbi,
            functionName: "setPolicy",
            args: [agentKey, p.policyHash as Hex, p.version, `fuku://agents/${agent.id}/policy`],
          }),
        ),
      });
    }
    if (p && !p.active && onChain?.policyActive) {
      actions.push({
        op: "revokePolicy",
        agentId: agent.id,
        description: `Revoke the passport of "${agent.name}" on-chain`,
        tx: tx(a.permissions, encodeFunctionData({ abi: PermissionRegistryAbi, functionName: "revokePolicy", args: [agentKey] })),
      });
    }
    const want = STATUS_CODE[agent.status];
    const have = onChain?.exists ? onChain.status : null;
    // Only pause/resume are mirrored: a registered agent stays Registered until it is paused.
    const mismatch = have !== null && want !== undefined && ((want === 2 && have !== 2) || (want !== 2 && have === 2));
    if (mismatch) {
      const code = want === 2 ? 2 : 1;
      actions.push({
        op: "setStatus",
        agentId: agent.id,
        description: `${code === 2 ? "Pause" : "Resume"} "${agent.name}" on-chain`,
        tx: tx(a.agents, encodeFunctionData({ abi: AgentRegistryAbi, functionName: "setStatus", args: [agentKey, code] })),
      });
    }
  }
  return { ...view, reason: null, actions };
}

// --- Confirmation ----------------------------------------------------------------------------------

export interface ExpectedEvent {
  op: OwnerOp;
  identityKey: Hex;
  agentKey?: Hex;
  wallet: Address;
  policyHash?: Hex;
  policyVersion?: number;
  status?: number;
}

/**
 * Pure check of a mined owner transaction: sent by the owner's wallet to the right registry, and
 * carrying the decoded event with the expected arguments. Returns the matching log index.
 */
export function verifyOwnerEvent(
  input: { from: Address; to: Address | null; status: "success" | "reverted"; logs: Log[] },
  expected: ExpectedEvent,
  registries: { identity: Address; agents: Address; permissions: Address },
): { ok: true; logIndex: number } | { ok: false; reason: string } {
  if (input.status !== "success") return { ok: false, reason: "the transaction reverted" };
  if (!isAddressEqual(input.from, expected.wallet)) return { ok: false, reason: `sent by ${input.from}, not the bound owner wallet ${expected.wallet}` };
  const target = expected.op === "registerIdentity" ? registries.identity : expected.op === "registerAgent" || expected.op === "setStatus" ? registries.agents : registries.permissions;
  if (!input.to || !isAddressEqual(input.to, target)) return { ok: false, reason: `sent to ${input.to}, not the ${expected.op} registry ${target}` };
  const abi = expected.op === "registerIdentity" ? HumanIdentityRegistryAbi : expected.op === "registerAgent" || expected.op === "setStatus" ? AgentRegistryAbi : PermissionRegistryAbi;
  for (const log of input.logs) {
    if (!isAddressEqual(log.address, target)) continue;
    let ev: { eventName: string; args: Record<string, unknown> };
    try {
      ev = decodeEventLog({ abi, data: log.data, topics: log.topics }) as unknown as typeof ev;
    } catch {
      continue;
    }
    const eq = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
    const idx = log.logIndex ?? -1;
    switch (expected.op) {
      case "registerIdentity":
        if (ev.eventName === "IdentityRegistered" && eq(ev.args.identityId, expected.identityKey) && eq(ev.args.controller, expected.wallet)) return { ok: true, logIndex: idx };
        break;
      case "registerAgent":
        if (ev.eventName === "AgentRegistered" && eq(ev.args.agentId, expected.agentKey) && eq(ev.args.ownerIdentityId, expected.identityKey)) return { ok: true, logIndex: idx };
        break;
      case "setPolicy":
        if (ev.eventName === "PolicySet" && eq(ev.args.agentId, expected.agentKey) && eq(ev.args.policyHash, expected.policyHash) && Number(ev.args.version) === expected.policyVersion) {
          return { ok: true, logIndex: idx };
        }
        break;
      case "revokePolicy":
        if (ev.eventName === "PolicyRevoked" && eq(ev.args.agentId, expected.agentKey)) return { ok: true, logIndex: idx };
        break;
      case "setStatus":
        if (ev.eventName === "AgentStatusChanged" && eq(ev.args.agentId, expected.agentKey) && Number(ev.args.status) === expected.status) return { ok: true, logIndex: idx };
        break;
    }
  }
  return { ok: false, reason: `no matching ${expected.op} event in the transaction` };
}

/**
 * Record an owner-signed transaction after checking it on-chain. The database changes only when
 * the receipt, the sender, the target and the decoded event all match what Fuku expected.
 */
export async function confirmOwnerAction(identity: Identity, input: { op: OwnerOp; txHash: Hex; agentId?: string | null }) {
  if (custodyFor(identity) !== "owner") throw new RequestError("This identity is custodial: Fuku's relayer signs its writes.", 409, "custodial");
  const wallet = identity.walletVerifiedBy ? (identity.walletAddress as Address | null) : null;
  if (!wallet) throw new RequestError("Bind a wallet first.", 400, "no_wallet");
  const client = chainReader();
  const a = registryAddresses();
  if (!client || !a) throw new RequestError("The chain is mocked: there is nothing to confirm.", 409, "mock_chain");

  let agent = null;
  if (input.op !== "registerIdentity") {
    if (!input.agentId) throw new RequestError("agentId is required for this operation.", 400, "invalid_request");
    agent = await db.agent.findFirst({ where: { id: input.agentId, identityId: identity.id }, include: { policy: true } });
    if (!agent) throw new Error("Agent not found");
  }
  const [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash: input.txHash }), client.getTransaction({ hash: input.txHash })]);
  const expected: ExpectedEvent = {
    op: input.op,
    identityKey: idToBytes32(identity.id),
    agentKey: agent ? idToBytes32(agent.id) : undefined,
    wallet,
    policyHash: (agent?.policy?.policyHash as Hex | undefined) ?? undefined,
    policyVersion: agent?.policy?.version,
    status: agent ? (agent.status === "paused" ? 2 : 1) : undefined,
  };
  const check = verifyOwnerEvent({ from: tx.from, to: tx.to, status: receipt.status, logs: receipt.logs }, expected, a);
  if (!check.ok) throw new RequestError(`Not confirmed: ${check.reason}.`, 422, "owner_tx_mismatch");

  const block = Number(receipt.blockNumber);
  switch (input.op) {
    case "registerIdentity": {
      // Independent read: the registry now names the owner's wallet as the controller.
      const [controller] = await client.readContract({ address: a.identity, abi: HumanIdentityRegistryAbi, functionName: "identities", args: [expected.identityKey] });
      if (!isAddressEqual(controller, wallet)) throw new RequestError(`The registry's controller is ${controller}, not your wallet.`, 422, "owner_tx_mismatch");
      await db.identity.update({ where: { id: identity.id }, data: { chainCustody: "owner", proofTxHash: input.txHash, proofBlock: block, proofMode: "owner-signed" } });
      // The relayer still attests the passkey flag (it is the registry owner); best effort.
      if (identity.humanVerified) await setHumanVerifiedOnChain(identity.id).catch(() => undefined);
      break;
    }
    case "registerAgent":
      await db.agent.update({ where: { id: agent!.id }, data: { registeredTx: input.txHash, registeredMode: "owner-signed" } });
      break;
    case "setPolicy":
    case "revokePolicy":
      await db.policy.update({ where: { agentId: agent!.id }, data: { txHash: input.txHash, anchorMode: "owner-signed" } });
      break;
    case "setStatus":
      break;
  }
  // Decisions that waited for the owner (the agent was not registered yet) can be anchored now.
  if (agent && (input.op === "registerAgent" || input.op === "setPolicy")) {
    const waiting = await db.agentAction.findMany({ where: { agentId: agent.id, anchorStatus: "awaiting-owner" }, take: 10 });
    for (const row of waiting) {
      const r = await recordDecisionOnChain({
        agent: { id: agent.id, name: agent.name, version: agent.version, capabilities: [], identity: { id: identity.id, humanVerified: identity.humanVerified, custody: "owner", wallet } },
        actionId: row.id,
        allowed: row.decision === "ALLOWED",
        proofHash: row.proofHash as Hex,
        ruleId: row.ruleId ?? "R1",
      });
      await db.agentAction.update({ where: { id: row.id }, data: { anchorStatus: r.status === "confirmed" ? "anchored" : r.status, txHash: r.txHash, receiptMode: r.mode } });
    }
  }
  return { ok: true as const, op: input.op, txHash: input.txHash, block, logIndex: check.logIndex, relayer: relayerAddress() };
}
