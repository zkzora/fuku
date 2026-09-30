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
  /** Cleanverse A-Token symbols this passport may move. Non-empty = an "A-Token passport". */
  assets: z.array(z.string().min(1)).default([]),
});

export type AllowedRule = z.infer<typeof allowedRuleSchema>;
export type PolicyDoc = z.infer<typeof policySchema>;

const KNOWN = new Set<string>(ACTIONS);

/**
 * What a passport may say when it is written (the engine still reads older passports leniently):
 * only actions Fuku knows, a daily limit on every allowed value action, no action both allowed and
 * blocked, and A-Tokens only alongside an allowed transfer.
 */
export const writablePolicySchema = policySchema.superRefine((doc, ctx) => {
  const allowed = new Set<string>();
  doc.allowed.forEach((r, i) => {
    if (!KNOWN.has(r.action)) ctx.addIssue({ code: "custom", path: ["allowed", i, "action"], message: `Unknown action "${r.action}"` });
    if (allowed.has(r.action)) ctx.addIssue({ code: "custom", path: ["allowed", i, "action"], message: `${r.action} is listed twice` });
    allowed.add(r.action);
    if (VALUE_ACTIONS.has(r.action) && r.limitUsdcPerDay === undefined) {
      ctx.addIssue({ code: "custom", path: ["allowed", i, "limitUsdcPerDay"], message: `${labelFor(r.action)} moves value and needs a daily limit` });
    }
  });
  doc.blocked.forEach((b, i) => {
    if (!KNOWN.has(b)) ctx.addIssue({ code: "custom", path: ["blocked", i], message: `Unknown action "${b}"` });
    if (allowed.has(b)) ctx.addIssue({ code: "custom", path: ["blocked", i], message: `${b} cannot be both allowed and blocked` });
  });
  if (doc.assets.length > 0 && !allowed.has("transfer")) {
    ctx.addIssue({ code: "custom", path: ["assets"], message: "A-Tokens only apply to an allowed transfer" });
  }
});

export function parsePolicy(
  row: { allowed: string; blocked: string; scopeApps: string; assets?: string | null } | null | undefined,
): PolicyDoc | null {
  if (!row) return null;
  return {
    allowed: JSON.parse(row.allowed),
    blocked: JSON.parse(row.blocked),
    scopeApps: JSON.parse(row.scopeApps),
    assets: row.assets ? JSON.parse(row.assets) : [],
  };
}

/** A passport with a non-empty `assets` list enters the Cleanverse perimeter. */
export function isATokenPassport(doc: PolicyDoc | null | undefined): boolean {
  return Boolean(doc && doc.assets.length > 0);
}

/**
 * The document whose hash is anchored as the passport's `policyHash`. `assets` is included only
 * when non-empty, so every passport anchored before A-Tokens existed keeps its on-chain hash.
 */
export function policyHashDoc(doc: PolicyDoc): Record<string, unknown> {
  const base = { allowed: doc.allowed, blocked: doc.blocked, scopeApps: doc.scopeApps };
  return doc.assets.length > 0 ? { ...base, assets: doc.assets } : base;
}

export function labelFor(action: string) {
  return ACTION_LABELS[action] ?? action.replace(/_/g, " ");
}
