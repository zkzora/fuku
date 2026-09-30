import { keccak256, stringToHex, type Hex } from "viem";

/**
 * Decision records, the preimages of anchored proofs (commit-reveal). Every decision Fuku anchors
 * with recordDecision (or FukuSpendGuard records for a transfer) carries
 *   proofHash = keccak256(record JSON)   at   actionHash = keccak256(record.actionId)
 * and Fuku keeps the JSON (DecisionRecord), so anyone it is revealed to can check each record
 * against the chain and recompute the score from checked records only.
 *
 * `seeded` and `outcome` exist for the demo's seeded history: it has no real decision time (the
 * seed runs at every demo reset), so it commits to a day offset instead, and its allowed decisions
 * count as completed actions under the rules they were written with (fuku-score/1), which the
 * record says in `outcome`, instead of being proven by an on-chain transfer.
 */
export interface DecisionRecord {
  v: 2;
  actionId: string;
  agentId: string;
  action: string;
  amountUsdc: number | null;
  app: string | null;
  decision: "ALLOWED" | "BLOCKED";
  ruleId: string;
  subCode: string | null;
  /** R10 only: the guard's decoded revert, which decides whether the block was the agent's fault. */
  guardReason: string | null;
  policyHash: string | null;
  complianceRef: string | null;
  /** ISO decision time; null for seeded history. */
  at: string | null;
  seeded: { day: number; time: string } | null;
  outcome: "legacy-success" | null;
}

/** The canonical JSON (fixed key order) whose keccak256 is the proof hash. */
export function recordJson(r: Omit<DecisionRecord, "v">): string {
  return JSON.stringify({
    v: 2,
    actionId: r.actionId,
    agentId: r.agentId,
    action: r.action,
    amountUsdc: r.amountUsdc,
    app: r.app,
    decision: r.decision,
    ruleId: r.ruleId,
    subCode: r.subCode,
    guardReason: r.guardReason,
    policyHash: r.policyHash,
    complianceRef: r.complianceRef,
    at: r.at,
    seeded: r.seeded,
    outcome: r.outcome,
  });
}

export function recordHash(json: string): Hex {
  return keccak256(stringToHex(json));
}

/** A revealed record, if it is a v2 record at all (anything else is not accepted as evidence). */
export function parseRecord(json: string): DecisionRecord | null {
  try {
    const r = JSON.parse(json) as DecisionRecord;
    if (r?.v !== 2 || typeof r.actionId !== "string" || typeof r.agentId !== "string") return null;
    if (r.decision !== "ALLOWED" && r.decision !== "BLOCKED") return null;
    return r;
  } catch {
    return null;
  }
}

/** A fresh action id; the record needs it before the action row exists. */
export function newActionId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `act_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
