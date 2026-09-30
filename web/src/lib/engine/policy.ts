import { z } from "zod";

export const ACTIONS = [
  "swap",
  "read_balances",
  "price_feeds",
  "read_vault",
  "web_search",
  "summarize",
  "calendar",
  "email_draft",
  "withdraw",
  "transfer",
  "change_owner",
  "stake",
  "sign_message",
] as const;

export type ActionName = (typeof ACTIONS)[number];

export const ACTION_LABELS: Record<string, string> = {
  swap: "Swap assets",
  read_balances: "Read balances",
  price_feeds: "Price feeds",
  read_vault: "Read vault",
  web_search: "Web search",
  summarize: "Summarize",
  calendar: "Calendar",
  email_draft: "Email draft",
  withdraw: "Withdraw funds",
  transfer: "Transfer funds",
  change_owner: "Change owner",
  stake: "Stake assets",
  sign_message: "Sign message",
};

/** Past-tense phrasing for the activity timeline ("Trading Assistant swapped assets"). */
export const ACTION_PAST: Record<string, string> = {
  swap: "swapped assets",
  read_balances: "read balances",
  price_feeds: "fetched price feeds",
  read_vault: "read the vault",
  web_search: "ran a web search",
  summarize: "summarized content",
  calendar: "updated the calendar",
  email_draft: "drafted an email",
  withdraw: "withdrew funds",
  transfer: "transferred funds",
  change_owner: "changed the owner",
  stake: "staked assets",
  sign_message: "signed a message",
};

export function pastTense(action: string) {
  return ACTION_PAST[action] ?? `performed ${labelFor(action).toLowerCase()}`;
}

/** Actions that move value and therefore count against USDC limits. */
export const VALUE_ACTIONS = new Set(["swap", "withdraw", "transfer", "stake"]);

/** Actions that are dangerous enough to be blocked by default on new passports. */
export const DEFAULT_BLOCKED = ["withdraw", "change_owner"];

export const allowedRuleSchema = z.object({
  action: z.string().min(1),
  limitUsdcPerDay: z.number().nonnegative().optional(),
});

export const policySchema = z.object({
  allowed: z.array(allowedRuleSchema).default([]),
  blocked: z.array(z.string()).default([]),
  scopeApps: z.array(z.string()).default([]),
});

export type AllowedRule = z.infer<typeof allowedRuleSchema>;
export type PolicyDoc = z.infer<typeof policySchema>;

export function parsePolicy(
  row: { allowed: string; blocked: string; scopeApps: string } | null | undefined,
): PolicyDoc | null {
  if (!row) return null;
  return {
    allowed: JSON.parse(row.allowed),
    blocked: JSON.parse(row.blocked),
    scopeApps: JSON.parse(row.scopeApps),
  };
}

export function labelFor(action: string) {
  return ACTION_LABELS[action] ?? action.replace(/_/g, " ");
}
