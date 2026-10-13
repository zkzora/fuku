/**
 * The owner's on-chain mandate, checked the way FukuSpendGuard checks it (`_checkMandateAndCap`),
 * without signing anything. One implementation serves both paths:
 *   - execution (`executeGuardedTransfer`) runs it before the compliance signer signs, so a transfer
 *     the guard would refuse is never attested; the guard's own simulation still has the last word;
 *   - the dry run (`check`) runs it so that "ALLOWED" means the passport AND the mandate allow it.
 * The reasons are the guard's custom errors, formatted as describeChainError formats a revert.
 *
 * Not covered here, on purpose: the attestation (issued only at execution), the mandate version
 * (the attestation takes the current one), and the agent's registration and passport on-chain, which
 * execution anchors lazily before attesting.
 */
import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import { FukuSpendGuardAbi } from "./abi";

export interface MandateState {
  active: boolean;
  token: Address;
  dailyCap: bigint;
  /** 0 = no per-transfer limit. */
  maxPerTx: bigint;
  /** Unix seconds, 0 = no expiry. */
  validUntil: bigint;
  restrictPayees: boolean;
  version: bigint;
  /** spentToday(agent, wallet) at `blockTimestamp`. */
  spentToday: bigint;
  /** isPayee(agent, wallet, to). */
  payeeApproved: boolean;
  /** The block the state was read at: the guard compares expiry with block.timestamp. */
  blockTimestamp: bigint;
}

export interface MandateRequest {
  agentKey: Hex;
  from: Address;
  to: Address;
  token: Address;
  amount: bigint;
}

export type MandateVerdict =
  | { ok: true; remaining: bigint; version: bigint }
  /** The guard would revert with `reason`, e.g. "PerTxLimitExceeded(50000000)". */
  | { ok: false; reason: string };

/** Pure: what `_checkMandateAndCap` would do with this state, in the guard's order. */
export function evaluateMandate(m: MandateState, r: MandateRequest): MandateVerdict {
  if (!m.active) return { ok: false, reason: `NoMandate(${r.agentKey}, ${getAddress(r.from)})` };
  if (getAddress(m.token) !== getAddress(r.token)) return { ok: false, reason: `TokenNotMandated(${getAddress(m.token)}, ${getAddress(r.token)})` };
  if (m.validUntil !== BigInt(0) && m.blockTimestamp > m.validUntil) return { ok: false, reason: `MandateExpired(${m.validUntil})` };
  if (r.amount === BigInt(0)) return { ok: false, reason: "ZeroAmount()" };
  if (BigInt(r.to) === BigInt(0)) return { ok: false, reason: "ZeroRecipient()" };
  if (m.maxPerTx !== BigInt(0) && r.amount > m.maxPerTx) return { ok: false, reason: `PerTxLimitExceeded(${m.maxPerTx})` };
  if (m.restrictPayees && !m.payeeApproved) return { ok: false, reason: `PayeeNotApproved(${getAddress(r.to)})` };
  const remaining = m.spentToday >= m.dailyCap ? BigInt(0) : m.dailyCap - m.spentToday;
  if (r.amount > remaining) return { ok: false, reason: `DailyCapExceeded(${remaining})` };
  return { ok: true, remaining: remaining - r.amount, version: m.version };
}

/** Read the mandate's state for (agent, wallet, payee) at one block. Throws on RPC failure. */
export async function readMandateState(client: PublicClient, guard: Address, r: Pick<MandateRequest, "agentKey" | "from" | "to">): Promise<MandateState> {
  const block = await client.getBlock();
  const at = { blockNumber: block.number };
  const [[token, dailyCap, maxPerTx, validUntil, restrictPayees, version, active], spentToday, payeeApproved] = await Promise.all([
    client.readContract({ address: guard, abi: FukuSpendGuardAbi, functionName: "mandates", args: [r.agentKey, r.from], ...at }),
    client.readContract({ address: guard, abi: FukuSpendGuardAbi, functionName: "spentToday", args: [r.agentKey, r.from], ...at }),
    client.readContract({ address: guard, abi: FukuSpendGuardAbi, functionName: "isPayee", args: [r.agentKey, r.from, r.to], ...at }),
  ]);
  return { active, token, dailyCap, maxPerTx, validUntil: BigInt(validUntil), restrictPayees, version: BigInt(version), spentToday, payeeApproved, blockTimestamp: block.timestamp };
}
