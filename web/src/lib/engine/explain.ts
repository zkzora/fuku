import type { Evaluation } from "./permission";
import type { PolicyDoc } from "./policy";
import { labelFor } from "./policy";
import type { ScoreResult } from "./reputation";

/**
 * AI reasoning layer. Kimi (Moonshot) and Qwen (DashScope) both expose OpenAI-compatible
 * chat endpoints. When no key is configured, Fuku falls back to a deterministic rule-based
 * explanation so the demo never depends on network access.
 */
export type ProviderName = "kimi" | "qwen" | "fuku-rules";

interface Provider {
  name: Exclude<ProviderName, "fuku-rules">;
  baseUrl: string;
  apiKey: string;
  model: string;
}

function providers(): Provider[] {
  const list: Provider[] = [];
  if (process.env.KIMI_API_KEY) {
    list.push({
      name: "kimi",
      baseUrl: process.env.KIMI_BASE_URL ?? "https://api.moonshot.ai/v1",
      apiKey: process.env.KIMI_API_KEY,
      model: process.env.KIMI_MODEL ?? "kimi-k2-0905-preview",
    });
  }
  if (process.env.QWEN_API_KEY) {
    list.push({
      name: "qwen",
      baseUrl: process.env.QWEN_BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      apiKey: process.env.QWEN_API_KEY,
      model: process.env.QWEN_MODEL ?? "qwen-plus",
    });
  }
  return list;
}

export function aiProviderStatus() {
  return {
    kimi: Boolean(process.env.KIMI_API_KEY),
    qwen: Boolean(process.env.QWEN_API_KEY),
  };
}

async function chat(p: Provider, system: string, user: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const res = await fetch(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({
        model: p.model,
        temperature: 0.3,
        max_tokens: 220,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${p.name} ${res.status}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error(`${p.name} returned empty content`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function withProviders(
  system: string,
  user: string,
  fallback: () => string,
): Promise<{ text: string; provider: ProviderName }> {
  for (const p of providers()) {
    try {
      const text = await chat(p, system, user);
      return { text, provider: p.name };
    } catch (err) {
      console.warn(`[fuku-ai] ${p.name} failed:`, (err as Error).message);
    }
  }
  return { text: fallback(), provider: "fuku-rules" };
}

const SYSTEM =
  "You are Fuku, a trust layer for AI agents. Explain decisions to a non-technical human owner in at most three short sentences. Be concrete, calm and factual. Never invent facts beyond the input.";

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

export function explainDecision(ctx: DecisionContext) {
  const user = JSON.stringify({
    agent: ctx.agentName,
    owner: ctx.ownerName,
    attempted: { action: ctx.action, amountUsdc: ctx.amountUsdc ?? undefined, app: ctx.app ?? undefined },
    decision: ctx.evaluation.decision,
    rule: ctx.evaluation.ruleId,
    reason: ctx.evaluation.reason,
    passport: ctx.policy,
    trustScore: { before: ctx.scoreBefore, after: ctx.scoreAfter },
  });
  return withProviders(SYSTEM, `Explain this permission decision to the owner:\n${user}`, () =>
    ruleBasedDecision(ctx),
  );
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

export function explainScore(ctx: ScoreContext) {
  const user = JSON.stringify({
    agent: ctx.agentName,
    owner: ctx.ownerName,
    score: ctx.result.score,
    level: ctx.result.level,
    breakdown: ctx.result.breakdown.map((b) => ({ factor: b.label, points: b.points, detail: b.detail })),
    recentViolation: ctx.recentViolation ?? undefined,
  });
  return withProviders(SYSTEM, `Explain why this agent has this trust score:\n${user}`, () =>
    ruleBasedScore(ctx),
  );
}

function ruleBasedScore(ctx: ScoreContext): string {
  const b = Object.fromEntries(ctx.result.breakdown.map((l) => [l.key, l]));
  const positives: string[] = [];
  if (b.human.points > 0) positives.push("a verified human owner");
  if (b.policy.points > 0) positives.push("an active permission passport");
  if (b.success.points > 0) positives.push(`${b.success.detail.split(" ")[0]} successful actions`);
  const negatives: string[] = [];
  if (b.violations.points < 0) negatives.push(`${b.violations.detail.split(" ")[0]} blocked attempts`);
  if (b.security.points < 0) negatives.push(`${b.security.detail.split(" ")[0]} security events`);
  const pos = positives.length ? `It earns points for ${positives.join(", ")}.` : "It has not yet earned bonus points.";
  const neg = negatives.length
    ? ` It loses points for ${negatives.join(" and ")}, which is why it is not at 100.`
    : " It has no violations or security events on record.";
  return `${ctx.agentName} scores ${ctx.result.score}/100 (${ctx.result.level.toLowerCase()} security level). ${pos}${neg}`;
}
