import type { Evaluation } from "./permission";
import type { PolicyDoc } from "./policy";
import { labelFor } from "./policy";
import type { ScoreResult } from "./reputation";

/**
 * Explanations come from Fuku's deterministic rule narrator: the same input always gives the
 * same text, and nothing leaves the server.
 */
export type ProviderName = "fuku-rules";

export interface DecisionContext {
  agentName: string;
  ownerName: string;
  action: string;
  amountUsdc?: number | null;
  app?: string | null;
  evaluation: Evaluation;
  policy: PolicyDoc | null;
  scoreBefore: number;
  scoreAfter: number;
}

export async function explainDecision(ctx: DecisionContext): Promise<{ text: string; provider: ProviderName }> {
  return { text: ruleBasedDecision(ctx), provider: "fuku-rules" };
}

function ruleBasedDecision(ctx: DecisionContext): string {
  const label = labelFor(ctx.action);
  const delta = ctx.scoreAfter - ctx.scoreBefore;
  const deltaText =
    delta === 0
      ? "Trust score unchanged."
      : `Trust score moved from ${ctx.scoreBefore} to ${ctx.scoreAfter} (${delta > 0 ? "+" : ""}${delta}).`;
  if (ctx.evaluation.decision === "BLOCKED") {
    return `${ctx.agentName} tried to ${label.toLowerCase()}${
      ctx.amountUsdc ? ` worth ${ctx.amountUsdc.toLocaleString("en-US")} USDC` : ""
    }, which its permission passport does not allow (rule ${ctx.evaluation.ruleId}). ${ctx.evaluation.reason} Fuku blocked the action before execution and anchored a proof, so nothing left ${ctx.ownerName}'s control. ${deltaText}`;
  }
  return `${ctx.agentName} performed ${label.toLowerCase()}${
    ctx.amountUsdc ? ` worth ${ctx.amountUsdc.toLocaleString("en-US")} USDC` : ""
  }${ctx.app ? ` via ${ctx.app}` : ""}. ${ctx.evaluation.reason} The action stayed inside the passport ${ctx.ownerName} approved (rule ${ctx.evaluation.ruleId}). ${deltaText}`;
}

export interface ScoreContext {
  agentName: string;
  ownerName: string;
  result: ScoreResult;
  recentViolation?: string | null;
}

export async function explainScore(ctx: ScoreContext): Promise<{ text: string; provider: ProviderName }> {
  return { text: ruleBasedScore(ctx), provider: "fuku-rules" };
}

function ruleBasedScore(ctx: ScoreContext): string {
  const b = Object.fromEntries(ctx.result.breakdown.map((l) => [l.key, l]));
  const positives: string[] = [];
  const pts = (key: string) => b[key]?.points ?? 0;
  const count = (key: string) => b[key]?.detail.split(" ")[0] ?? "0";
  if (pts("passkey") > 0) positives.push("a passkey-verified owner");
  if (pts("apass") > 0) positives.push("an owner with an eligible Cleanverse A-Pass");
  if (pts("policy") > 0) positives.push("an active permission passport");
  if (pts("success") > 0) positives.push(`${count("success")} completed actions`);
  const negatives: string[] = [];
  if (pts("violations") < 0) negatives.push(`${count("violations")} blocked attempts`);
  if (pts("security") < 0) negatives.push(`${count("security")} security events`);
  const pos = positives.length ? `It earns points for ${positives.join(", ")}.` : "It has not yet earned bonus points.";
  const neg = negatives.length
    ? ` It loses points for ${negatives.join(" and ")}, which is why it is not at 100.`
    : " It has no violations or security events on record.";
  return `${ctx.agentName} scores ${ctx.result.score}/100 (${ctx.result.level.toLowerCase()} security level). ${pos}${neg}`;
}
