import { VALUE_ACTIONS, isATokenPassport, labelFor, type PolicyDoc } from "./policy";
import type { ComplianceLeg, ComplianceResult, ComplianceSubCode } from "../cleanverse/types";

export type Decision = "ALLOWED" | "BLOCKED";

export interface EvaluationInput {
  agentStatus: string;
  policy: PolicyDoc | null;
  policyActive: boolean;
  action: string;
  amountUsdc?: number | null;
  app?: string | null;
  /** USDC already spent today (UTC day) on this action under this policy. */
  spentTodayUsdc: number;
  /**
   * Cleanverse legs for a value action on an A-Token passport, gathered by the caller
   * (`gatherCompliance`). The engine stays pure and synchronous.
   */
  compliance?: ComplianceResult | null;
}

export interface Evaluation {
  decision: Decision;
  ruleId: string;
  reason: string;
  /** Cleanverse sub-code for R7-R10 (e.g. CVI_FROZEN). */
  subCode?: ComplianceSubCode | "GUARD_REJECTED" | "GUARD_NOT_CONFIGURED";
  limitUsdcPerDay?: number;
  remainingUsdc?: number;
}

/**
 * Deterministic permission engine. Every decision is attributable to a rule id so it can be
 * explained, indexed and anchored on-chain. Rules are evaluated in this order:
 *
 * R0  agent not active                               -> BLOCKED
 * R1  no active policy                               -> BLOCKED
 * R2  action explicitly blocked                      -> BLOCKED
 * R3  action not on allow list                       -> BLOCKED
 * R4  app outside policy scope                       -> BLOCKED
 * R9  A-Token passport: asset rule (Cleanverse CVA)  -> BLOCKED   } value actions on
 * R7  A-Token passport: owner A-Pass (CVI)           -> BLOCKED   } A-Token passports
 * R8  A-Token passport: counterparty A-Pass (CVI)    -> BLOCKED   } only
 * R5  daily USDC limit exceeded                      -> BLOCKED
 * R6  allowed                                        -> ALLOWED
 * R10 on-chain FukuSpendGuard rejected the transfer  -> BLOCKED   (set at execution, see actions.ts)
 */
export function evaluate(input: EvaluationInput): Evaluation {
  const { policy, action } = input;
  const label = labelFor(action);

  if (input.agentStatus !== "active") {
    return {
      decision: "BLOCKED",
      ruleId: "R0",
      reason: `Agent is ${input.agentStatus}. Only active agents may execute actions.`,
    };
  }
  if (!policy || !input.policyActive) {
    return {
      decision: "BLOCKED",
      ruleId: "R1",
      reason: "No active permission passport attached. Fuku denies by default.",
    };
  }
  if (policy.blocked.includes(action)) {
    return {
      decision: "BLOCKED",
      ruleId: "R2",
      reason: `${label} is on the hard block list of this agent's passport.`,
    };
  }
  const rule = policy.allowed.find((r) => r.action === action);
  if (!rule) {
    return {
      decision: "BLOCKED",
      ruleId: "R3",
      reason: `${label} is not an allowed capability for this agent.`,
    };
  }
  if (policy.scopeApps.length > 0 && input.app && !policy.scopeApps.includes(input.app)) {
    return {
      decision: "BLOCKED",
      ruleId: "R4",
      reason: `${input.app} is outside the application scope (${policy.scopeApps.join(", ")}).`,
    };
  }

  if (VALUE_ACTIONS.has(action) && isATokenPassport(policy)) {
    const blocked = cleanverseRules(input.compliance ?? null);
    if (blocked) return blocked;
  }

  if (VALUE_ACTIONS.has(action) && rule.limitUsdcPerDay !== undefined) {
    const amount = input.amountUsdc ?? 0;
    const remaining = Math.max(0, rule.limitUsdcPerDay - input.spentTodayUsdc);
    if (amount > remaining) {
      return {
        decision: "BLOCKED",
        ruleId: "R5",
        reason: `${label} of ${fmtUsdc(amount)} exceeds the remaining daily limit of ${fmtUsdc(remaining)} (limit ${fmtUsdc(rule.limitUsdcPerDay)}/day).`,
        limitUsdcPerDay: rule.limitUsdcPerDay,
        remainingUsdc: remaining,
      };
    }
    return {
      decision: "ALLOWED",
      ruleId: "R6",
      reason: `${label} of ${fmtUsdc(amount)} is within the daily limit (${fmtUsdc(remaining - amount)} remaining today).`,
      limitUsdcPerDay: rule.limitUsdcPerDay,
      remainingUsdc: remaining - amount,
    };
  }
  return {
    decision: "ALLOWED",
    ruleId: "R6",
    reason: `${label} is an allowed capability${input.app ? ` for ${input.app}` : ""}.`,
  };
}

/** R9, R7, R8 in that order. Missing evidence fails closed. */
function cleanverseRules(c: ComplianceResult | null): Evaluation | null {
  if (!c) {
    return block("R7", "PROVIDER_ERROR", "Cleanverse evidence was not gathered for this A-Token passport, so Fuku fails closed.");
  }
  if (c.asset.subCode === "PROVIDER_OFF") {
    return block("R7", "PROVIDER_OFF", "Cleanverse is not configured, so value actions on an A-Token passport are blocked.");
  }
  if (!c.asset.ok) return block("R9", c.asset.subCode, `Cleanverse CVA asset rule failed: ${legReason(c.asset)}.`);
  if (!c.owner.ok) return block("R7", c.owner.subCode, `The owner's Cleanverse A-Pass check failed: ${legReason(c.owner)}.`);
  if (!c.counterparty.ok) {
    return block("R8", c.counterparty.subCode, `The recipient failed the Cleanverse A-Pass check: ${legReason(c.counterparty)}.`);
  }
  return null;
}

function legReason(leg: ComplianceLeg) {
  return `${leg.subCode} (${leg.detail})`;
}

function block(ruleId: string, subCode: Evaluation["subCode"], reason: string): Evaluation {
  return { decision: "BLOCKED", ruleId, reason, subCode };
}

export function fmtUsdc(n: number) {
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC`;
}

/** Start of the current UTC day: daily limits use UTC days to match FukuSpendGuard. */
export function utcDayStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
