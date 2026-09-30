import { VALUE_ACTIONS, labelFor, type PolicyDoc } from "./policy";

export type Decision = "ALLOWED" | "BLOCKED";

export interface EvaluationInput {
  agentStatus: string;
  policy: PolicyDoc | null;
  policyActive: boolean;
  action: string;
  amountUsdc?: number | null;
  app?: string | null;
  /** USDC already spent today on this action under this policy. */
  spentTodayUsdc: number;
}

export interface Evaluation {
  decision: Decision;
  ruleId: string;
  reason: string;
  limitUsdcPerDay?: number;
  remainingUsdc?: number;
}

/**
 * Deterministic permission engine. Every decision is attributable to a rule id so it can be
 * explained, indexed and anchored on-chain.
 *
 * R0  agent not active           -> BLOCKED
 * R1  no active policy           -> BLOCKED
 * R2  action explicitly blocked  -> BLOCKED
 * R3  action not on allow list   -> BLOCKED
 * R4  app outside policy scope   -> BLOCKED
 * R5  daily USDC limit exceeded  -> BLOCKED
 * R6  allowed                    -> ALLOWED
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

export function fmtUsdc(n: number) {
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC`;
}
