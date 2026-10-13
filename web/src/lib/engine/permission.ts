import { isAddress } from "viem";
import { ACTIONS, VALUE_ACTIONS, isATokenPassport, labelFor, type PolicyDoc } from "./policy";
import type { ComplianceLeg, ComplianceResult, ComplianceSubCode } from "../cleanverse/types";

export type Decision = "ALLOWED" | "BLOCKED";

export type EngineSubCode =
  | ComplianceSubCode
  | "GUARD_REJECTED"
  | "GUARD_NOT_CONFIGURED"
  /** Dry run only: the owner's on-chain mandate could not be read, so the answer is UNKNOWN. */
  | "MANDATE_UNAVAILABLE"
  | "AUTHORIZATION_CHANGED"
  | "APP_REQUIRED"
  | "OWNER_UNVERIFIED"
  | "AMOUNT_REQUIRED"
  | "AMOUNT_PRECISION"
  | "RECIPIENT_REQUIRED"
  | "RECIPIENT_INVALID"
  | "LIMIT_REQUIRED";

export interface EvaluationInput {
  agentStatus: string;
  policy: PolicyDoc | null;
  policyActive: boolean;
  action: string;
  amountUsdc?: number | null;
  app?: string | null;
  /** Recipient wallet; required for `transfer`. */
  to?: string | null;
  /**
   * The owner completed a passkey ceremony with user verification (Identity.humanVerified). Value
   * actions require it (R11); non-value actions do not, by design.
   */
  ownerVerified: boolean;
  /** USDC already spent today (UTC day) on this action under this policy. */
  spentTodayUsdc: number;
  /** The same in 6-decimal base units; authoritative when given (from the budget window). */
  spentTodayMicros?: bigint;
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
  /** Machine-readable cause for R4, R7-R12 (e.g. CVI_FROZEN, APP_REQUIRED). */
  subCode?: EngineSubCode;
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
 * R3  action unknown or not on the allow list        -> BLOCKED
 * R4  app outside policy scope, or missing when the passport is scoped -> BLOCKED
 * R11 value action, owner not passkey-verified       -> BLOCKED
 * R12 value action with an incomplete request or a limitless allow rule -> BLOCKED
 * R9  A-Token passport: asset rule (Cleanverse CVA)  -> BLOCKED   } value actions on
 * R7  A-Token passport: owner A-Pass (CVI)           -> BLOCKED   } A-Token passports
 * R8  A-Token passport: counterparty A-Pass (CVI)    -> BLOCKED   } only
 * R5  daily USDC limit exceeded (UTC day, base units) -> BLOCKED
 * R6  allowed                                        -> ALLOWED
 * R10 on-chain FukuSpendGuard rejected the transfer  -> BLOCKED   (set at execution, see actions.ts)
 *
 * R0 to R6 keep their original ids and meanings; R7 to R12 were added after them.
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
  const known = (ACTIONS as readonly string[]).includes(action);
  const rule = known ? policy.allowed.find((r) => r.action === action) : undefined;
  if (!rule) {
    return {
      decision: "BLOCKED",
      ruleId: "R3",
      reason: known ? `${label} is not an allowed capability for this agent.` : `"${action}" is not an action Fuku knows, so it is denied.`,
    };
  }
  if (policy.scopeApps.length > 0) {
    if (!input.app) {
      return block("R4", "APP_REQUIRED", `This passport is scoped to ${policy.scopeApps.join(", ")}, so the request must name the application.`);
    }
    if (!policy.scopeApps.includes(input.app)) {
      return {
        decision: "BLOCKED",
        ruleId: "R4",
        reason: `${input.app} is outside the application scope (${policy.scopeApps.join(", ")}).`,
      };
    }
  }

  if (VALUE_ACTIONS.has(action)) {
    if (!input.ownerVerified) {
      return block("R11", "OWNER_UNVERIFIED", `${label} moves value, and the owner has not completed a passkey ceremony with user verification.`);
    }
    const invalid = invalidValueRequest(input, rule.limitUsdcPerDay);
    if (invalid) return invalid;

    if (isATokenPassport(policy)) {
      const blocked = cleanverseRules(input.compliance ?? null);
      if (blocked) return blocked;
    }

    const limit = rule.limitUsdcPerDay!;
    const amount = toMicros(input.amountUsdc!)!;
    const limitMicros = toMicros(limit) ?? ZERO;
    const spent = input.spentTodayMicros ?? toMicros(input.spentTodayUsdc) ?? ZERO;
    const remaining = limitMicros > spent ? limitMicros - spent : ZERO;
    if (amount > remaining) {
      return {
        decision: "BLOCKED",
        ruleId: "R5",
        reason: `${label} of ${fmtUsdc(input.amountUsdc!)} exceeds the remaining daily limit of ${fmtUsdc(fromMicros(remaining))} (limit ${fmtUsdc(limit)}/day, UTC).`,
        limitUsdcPerDay: limit,
        remainingUsdc: fromMicros(remaining),
      };
    }
    return {
      decision: "ALLOWED",
      ruleId: "R6",
      reason: `${label} of ${fmtUsdc(input.amountUsdc!)} is within the daily limit (${fmtUsdc(fromMicros(remaining - amount))} remaining today).`,
      limitUsdcPerDay: limit,
      remainingUsdc: fromMicros(remaining - amount),
    };
  }
  return {
    decision: "ALLOWED",
    ruleId: "R6",
    reason: `${label} is an allowed capability${input.app ? ` for ${input.app}` : ""}.`,
  };
}

/** R12: a value action needs a positive amount with at most 6 decimals, a recipient for transfer, and a daily limit. */
function invalidValueRequest(input: EvaluationInput, limit: number | undefined): Evaluation | null {
  const label = labelFor(input.action);
  const amount = input.amountUsdc;
  if (amount === null || amount === undefined || !Number.isFinite(amount) || amount <= 0) {
    return block("R12", "AMOUNT_REQUIRED", `${label} moves value, so the request needs a positive amount.`);
  }
  if (toMicros(amount) === null) {
    return block("R12", "AMOUNT_PRECISION", `${label} amounts are limited to 6 decimal places (USDC base units).`);
  }
  if (input.action === "transfer") {
    if (!input.to) return block("R12", "RECIPIENT_REQUIRED", "A transfer needs a recipient wallet (`to`).");
    if (!isAddress(input.to)) return block("R12", "RECIPIENT_INVALID", `${input.to} is not a valid EVM address.`);
  }
  if (limit === undefined) {
    return block("R12", "LIMIT_REQUIRED", `The passport allows ${label} without a daily limit; Fuku requires one for every value action.`);
  }
  return null;
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

function block(ruleId: string, subCode: EngineSubCode, reason: string): Evaluation {
  return { decision: "BLOCKED", ruleId, reason, subCode };
}

const ZERO = BigInt(0);

/** Rules decided without any provider call; Cleanverse is consulted only when none of them blocks. */
export const PRE_COMPLIANCE_RULES = new Set(["R0", "R1", "R2", "R3", "R4", "R11", "R12"]);

/** USDC amount -> 6-decimal base units; null when not a finite, non-negative amount with at most 6 decimals. */
export function toMicros(n: number): bigint | null {
  if (!Number.isFinite(n) || n < 0) return null;
  const micros = Math.round(n * 1e6);
  if (!Number.isSafeInteger(micros) || Math.abs(micros / 1e6 - n) > 1e-9) return null;
  return BigInt(micros);
}

export function fromMicros(m: bigint): number {
  return Number(m) / 1e6;
}

export function fmtUsdc(n: number) {
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 6 })} USDC`;
}

/** Start of the current UTC day: daily limits use UTC days to match FukuSpendGuard. */
export function utcDayStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** YYYY-MM-DD of the UTC day containing `now`. */
export function utcDayKey(now: Date = new Date()): string {
  return utcDayStart(now).toISOString().slice(0, 10);
}
