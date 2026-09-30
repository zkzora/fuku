/**
 * Fuku Trust Score, scoring version fuku-score/2. Deterministic, explainable, bounded 0..100.
 *
 *   baseline                                   40
 *   identity: owner passkey-verified          +10   (WebAuthn with user verification)
 *   identity: owner Cleanverse A-Pass         +10   (verified wallet, eligible A-Pass on record)
 *   policy: active permission passport         +5
 *   policy: violations                         -4 each, capped at -40
 *   execution: completed actions             +2.5 each, capped at +35
 *   risk: security events                     -10 each
 *
 * Version 1 gave a flat +20 for a "verified human owner"; version 2 splits it into the two
 * identity signals above, so an owner with both scores exactly as before.
 *
 * What counts as a completed action changed with version 2: only an execution Fuku can verify
 * (a guarded transfer confirmed on-chain) earns +2.5. An allowed decision for an action Fuku does
 * not execute, a dry run, a mock settlement or a read earns nothing, so volume cannot be farmed with
 * cheap calls. Success events recorded before that change stay in the ledger as legacy evidence.
 * The score is an explainable summary, not a probability; `uncertainty` says how much evidence
 * backs it.
 */
export const SCORING_VERSION = "fuku-score/2";

export interface ReputationInputs {
  /** Owner completed a passkey ceremony with user verification. */
  passkeyVerified: boolean;
  /** Owner's verified wallet holds an eligible Cleanverse A-Pass (persisted read). */
  apassEligible: boolean;
  hasActivePolicy: boolean;
  successes: number;
  violations: number;
  securityEvents: number;
  /** Timestamps of the evidence events, for the observation period. */
  firstEvidenceAt?: Date | null;
  now?: Date;
}

export interface ScoreBreakdownLine {
  key: string;
  label: string;
  points: number;
  detail: string;
  dimension: "baseline" | "identity" | "policy" | "execution" | "risk";
}

export type SecurityLevel = "High" | "Medium" | "Low";

export interface ScoreResult {
  score: number;
  level: SecurityLevel;
  breakdown: ScoreBreakdownLine[];
  scoringVersion: string;
  /** Points per dimension (baseline excluded). */
  dimensions: { identity: number; policy: number; execution: number; risk: number };
  evidence: { count: number; firstAt: string | null; observationDays: number };
  /** high: under 5 evidence events or under 3 days observed; medium: under 20 events; low otherwise. */
  uncertainty: "high" | "medium" | "low";
}

export function computeScore(i: ReputationInputs): ScoreResult {
  const successPts = Math.min(35, Math.round(i.successes * 2.5 * 10) / 10);
  const violationPts = -Math.min(40, i.violations * 4);
  const securityPts = -i.securityEvents * 10;
  const breakdown: ScoreBreakdownLine[] = [
    { key: "base", label: "Baseline", points: 40, detail: "Every registered agent starts here.", dimension: "baseline" },
    {
      key: "passkey",
      label: "Passkey-verified owner",
      points: i.passkeyVerified ? 10 : 0,
      detail: i.passkeyVerified
        ? "Owner completed a passkey (WebAuthn) ceremony with user verification. Not a proof of unique personhood."
        : "Owner has not completed a passkey ceremony.",
      dimension: "identity",
    },
    {
      key: "apass",
      label: "Cleanverse A-Pass",
      points: i.apassEligible ? 10 : 0,
      detail: i.apassEligible
        ? "Owner's verified wallet holds an eligible A-Pass (last persisted read)."
        : "No eligible A-Pass on record for a verified owner wallet.",
      dimension: "identity",
    },
    {
      key: "policy",
      label: "Permission passport",
      points: i.hasActivePolicy ? 5 : 0,
      detail: i.hasActivePolicy ? "An active passport constrains what the agent can do." : "No active passport attached.",
      dimension: "policy",
    },
    {
      key: "success",
      label: "Completed actions",
      points: successPts,
      detail: `${i.successes} completed actions with execution evidence (+2.5 each, max +35).`,
      dimension: "execution",
    },
    {
      key: "violations",
      label: "Permission violations",
      points: violationPts,
      detail: `${i.violations} blocked attempts (−4 each, max −40).`,
      dimension: "policy",
    },
    {
      key: "security",
      label: "Security events",
      points: securityPts,
      detail: `${i.securityEvents} security events (−10 each).`,
      dimension: "risk",
    },
  ];
  const raw = breakdown.reduce((s, l) => s + l.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const sum = (d: ScoreBreakdownLine["dimension"]) => breakdown.filter((l) => l.dimension === d).reduce((s, l) => s + l.points, 0);
  const count = i.successes + i.violations + i.securityEvents;
  const now = i.now ?? new Date();
  const observationDays = i.firstEvidenceAt ? Math.max(0, Math.floor((now.getTime() - i.firstEvidenceAt.getTime()) / 86_400_000)) : 0;
  return {
    score,
    level: levelFor(score),
    breakdown,
    scoringVersion: SCORING_VERSION,
    dimensions: { identity: sum("identity"), policy: sum("policy"), execution: sum("execution"), risk: sum("risk") },
    evidence: { count, firstAt: i.firstEvidenceAt?.toISOString() ?? null, observationDays },
    uncertainty: count < 5 || observationDays < 3 ? "high" : count < 20 ? "medium" : "low",
  };
}

export function levelFor(score: number): SecurityLevel {
  return score >= 85 ? "High" : score >= 60 ? "Medium" : "Low";
}

/**
 * Which blocked decisions count against the agent. A block caused by the agent's own request
 * (hard-blocked or unlisted action, out-of-scope app, over-limit, bad parameters, ineligible
 * recipient or asset, an on-chain limit or payee breach) is a violation. A block caused by the
 * owner's or the infrastructure's state (owner not verified, owner's A-Pass, provider down, guard
 * not configured, no mandate) is recorded as neutral and does not move the score.
 */
export function isViolation(ruleId: string, subCode?: string | null, reason?: string | null): boolean {
  if (["R0", "R1", "R2", "R3", "R4", "R5", "R8", "R9", "R12"].includes(ruleId)) return true;
  if (ruleId === "R10") return /DailyCapExceeded|PerTxLimitExceeded|PayeeNotApproved|TokenNotMandated|ZeroAmount|ZeroRecipient/.test(reason ?? "");
  return false; // R7, R11, R10 infrastructure, anything unknown
}
