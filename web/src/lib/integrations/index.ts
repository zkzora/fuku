import { aiProviderStatus } from "../engine/explain";
import { chainMode } from "../chain";
import { envioStatus, startBlock } from "./envio";

/**
 * Sponsor integration registry. Each integration reports whether it is running live
 * (credentials configured and reachable) or simulated (deterministic local behaviour). The
 * Developer Console renders this so the demo is honest about what is wired up.
 */
export interface IntegrationStatus {
  key: string;
  name: string;
  category: "Identity" | "Wallet" | "Data" | "AI" | "Automation" | "Credentials" | "Settlement";
  role: string;
  envVars: string[];
  mode: "live" | "simulated";
  detail: string;
}

export async function integrationStatus(): Promise<IntegrationStatus[]> {
  const ai = aiProviderStatus();
  const chain = chainMode();
  const has = (k: string) => Boolean(process.env[k]);
  const [nansen, envio] = await Promise.all([nansenAccount(), envioStatus()]);
  return [
    {
      key: "monad",
      name: "Monad",
      category: "Settlement",
      role: "Identity, agent, permission and reputation registries",
      envVars: ["FUKU_CHAIN_MODE", "DEPLOYER_PRIVATE_KEY", "FUKU_*_REGISTRY"],
      mode: chain === "live" ? "live" : "simulated",
      detail:
        chain === "live"
          ? "Transactions are signed and anchored on Monad testnet (chain 10143)."
          : "Proof hashes are computed locally; receipts are mocked until contracts are deployed.",
    },
    {
      key: "mera",
      name: "Mera",
      category: "Identity",
      role: "Passkey onboarding and approval layer (WebAuthn / P-256)",
      envVars: [],
      mode: "live",
      detail: "Passkeys are created and verified with WebAuthn in this browser. Face ID / Windows Hello / security keys all work.",
    },
    {
      key: "privy",
      name: "Privy",
      category: "Wallet",
      role: "Embedded wallet for agents and owners",
      envVars: ["NEXT_PUBLIC_PRIVY_APP_ID", "PRIVY_APP_SECRET"],
      mode: has("NEXT_PUBLIC_PRIVY_APP_ID") ? "live" : "simulated",
      detail: has("NEXT_PUBLIC_PRIVY_APP_ID")
        ? "Embedded wallets are provisioned through Privy."
        : "Wallet addresses are derived locally. Add a Privy app id to provision embedded wallets.",
    },
    {
      key: "dynamic",
      name: "Dynamic",
      category: "Identity",
      role: "Email sign-in with an embedded EVM wallet",
      envVars: ["NEXT_PUBLIC_DYNAMIC_ENV_ID"],
      mode: has("NEXT_PUBLIC_DYNAMIC_ENV_ID") ? "live" : "simulated",
      detail: has("NEXT_PUBLIC_DYNAMIC_ENV_ID")
        ? "Sign in with email through the Dynamic JavaScript SDK, or link a wallet on the Identity page. Dynamic creates an embedded EVM wallet; Fuku verifies Dynamic's JWT (RS256, JWKS) on the server and records the wallet as the identity's owner wallet. Email sign-in alone is not human verification."
        : "Passkey sign-in is the active method. Add a Dynamic environment id to enable email and wallet sign-in.",
    },
    {
      key: "nansen",
      name: "Nansen",
      category: "Data",
      role: "Behavioural intelligence and risk signals for agent wallets",
      envVars: ["NANSEN_API_KEY", "NANSEN_CHAIN"],
      mode: nansen.ok ? "live" : "simulated",
      detail: nansen.ok
        ? `Connected (${nansen.plan} plan, ${nansen.creditsRemaining} credits). Address labels cost ${LABELS_COST} credits per lookup on chain "${nansenChain()}"${
            nansen.creditsRemaining < LABELS_COST ? "; below that, signals come from Fuku's own ledger until credits are topped up" : ""
          }.`
        : has("NANSEN_API_KEY")
          ? `Key configured but Nansen is unreachable (${nansen.error}). Risk signals are derived from Fuku's own activity ledger.`
          : "Risk signals are derived from Fuku's own activity ledger. Add NANSEN_API_KEY to profile agent wallets.",
    },
    {
      key: "envio",
      name: "Envio",
      category: "Data",
      role: "HyperSync index of the Fuku registries; HyperRPC proof verification",
      envVars: ["ENVIO_API_TOKEN", "ENVIO_HYPERRPC_TOKEN"],
      mode: envio.hypersync.ok && envio.registriesConfigured ? "live" : "simulated",
      detail:
        envio.hypersync.ok && envio.registriesConfigured
          ? `HyperSync indexes identity, agent, passport, decision and score events from block ${startBlock().toLocaleString("en-US")} (chain head ${envio.hypersync.height?.toLocaleString("en-US")}); see Activity → On-chain. ${
              envio.hyperrpc.ok ? "HyperRPC verifies each decision's proof hash on-chain." : `HyperRPC unavailable (${envio.hyperrpc.error}).`
            }`
          : envio.hypersync.ok
            ? "HyperSync is reachable, but the Fuku registry addresses are not configured (deploy to Monad first)."
            : `Activity is served from the local ledger (${envio.hypersync.error ?? "HyperSync unavailable"}). HyperIndex config lives in /indexer.`,
    },
    {
      key: "kimi",
      name: "Kimi",
      category: "AI",
      role: "Trust explanations and behaviour analysis",
      envVars: ["KIMI_API_KEY"],
      mode: ai.kimi ? "live" : "simulated",
      detail: ai.kimi ? "Explanations are generated by Kimi." : "Explanations use Fuku's deterministic rule narrator.",
    },
    {
      key: "qwen",
      name: "Qwen",
      category: "AI",
      role: "Agent planning and policy interpretation",
      envVars: ["QWEN_API_KEY"],
      mode: ai.qwen ? "live" : "simulated",
      detail: ai.qwen ? "Policy interpretation is generated by Qwen." : "Policy interpretation uses the rule narrator.",
    },
    {
      key: "chainlink-cre",
      name: "Chainlink CRE",
      category: "Automation",
      role: "Workflow: request → verify → execute → record",
      envVars: ["CRE_WORKFLOW_ID"],
      mode: has("CRE_WORKFLOW_ID") ? "live" : "simulated",
      detail: has("CRE_WORKFLOW_ID")
        ? `Deployed workflow fuku-guard (${process.env.CRE_WORKFLOW_ID!.slice(0, 10)}…) orchestrates agent actions on the Chainlink DON: verify via the Fuku API, execute, then read the Monad registries.`
        : "Workflow cre/fuku-guard (HTTP trigger → verify via the Fuku API → execute → EVM read of the Monad registries) runs end to end with `cre workflow simulate`, the path Chainlink recommends for hackathons. Deploying to the DON requires a commercial agreement with Chainlink; CRE_WORKFLOW_ID would come from `cre workflow deploy` after that.",
    },
    {
      key: "cleanverse",
      name: "Cleanverse",
      category: "Credentials",
      role: "Verified identity credentials",
      envVars: ["CLEANVERSE_API_KEY"],
      mode: has("CLEANVERSE_API_KEY") ? "live" : "simulated",
      detail: has("CLEANVERSE_API_KEY")
        ? "Credentials are issued and checked via Cleanverse."
        : "A demo credential is attached to verified identities.",
    },
  ];
}

// --- Nansen ----------------------------------------------------------------------------------
// Docs: https://docs.nansen.ai (base https://api.nansen.ai/api/v1, header `apikey`).
// GET /account is free and reports the plan and remaining credits; POST /profiler/address/labels
// costs 100 credits per call, so lookups are cached per address and skipped when credits are short.

const NANSEN_BASE = "https://api.nansen.ai/api/v1";
const LABELS_COST = 100;
const ACCOUNT_TTL_MS = 5 * 60_000;
const LABELS_TTL_MS = 24 * 60 * 60_000;

export function nansenChain() {
  return process.env.NANSEN_CHAIN?.trim() || "monad";
}

type NansenAccount =
  | { ok: true; plan: string; creditsRemaining: number; checkedAt: number }
  | { ok: false; error: string; checkedAt: number };

let accountCache: NansenAccount | null = null;

async function nansenFetch(path: string, init: RequestInit = {}) {
  const key = process.env.NANSEN_API_KEY;
  if (!key) throw new Error("NANSEN_API_KEY not set");
  return fetch(`${NANSEN_BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", apikey: key, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(8000),
  });
}

/** Free endpoint: plan and remaining credits. Cached for five minutes. */
export async function nansenAccount(): Promise<NansenAccount> {
  if (!process.env.NANSEN_API_KEY) return { ok: false, error: "no key", checkedAt: Date.now() };
  if (accountCache && Date.now() - accountCache.checkedAt < ACCOUNT_TTL_MS) return accountCache;
  try {
    const res = await nansenFetch("/account");
    const json = (await res.json()) as { plan?: string; credits_remaining?: number; code?: string; message?: string };
    accountCache = res.ok
      ? { ok: true, plan: json.plan ?? "unknown", creditsRemaining: Number(json.credits_remaining ?? 0), checkedAt: Date.now() }
      : { ok: false, error: json.code ?? json.message ?? `HTTP ${res.status}`, checkedAt: Date.now() };
  } catch (err) {
    accountCache = { ok: false, error: (err as Error).message, checkedAt: Date.now() };
  }
  return accountCache;
}

export interface NansenLabel {
  label: string;
  category: string;
  kind: string[];
}

type LabelsResult = { ok: true; labels: NansenLabel[]; fetchedAt: number } | { ok: false; error: string; fetchedAt: number };

const labelsCache = new Map<string, LabelsResult>();

/** Address labels (100 credits per call). Cached per address+chain for a day. */
export async function nansenLabels(address: string, chain = nansenChain()): Promise<LabelsResult> {
  const cacheKey = `${chain}:${address.toLowerCase()}`;
  const cached = labelsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < LABELS_TTL_MS) return cached;
  const account = await nansenAccount();
  if (!account.ok) return { ok: false, error: account.error, fetchedAt: Date.now() };
  if (account.creditsRemaining < LABELS_COST) {
    return { ok: false, error: `insufficient_credits (${account.creditsRemaining} left, lookup costs ${LABELS_COST})`, fetchedAt: Date.now() };
  }
  let result: LabelsResult;
  try {
    const res = await nansenFetch("/profiler/address/labels", {
      method: "POST",
      body: JSON.stringify({ address, chain, pagination: { page: 1, per_page: 25 } }),
    });
    const json = (await res.json()) as { data?: NansenLabel[]; code?: string; message?: string };
    result = res.ok
      ? { ok: true, labels: json.data ?? [], fetchedAt: Date.now() }
      : { ok: false, error: json.code ?? json.message ?? `HTTP ${res.status}`, fetchedAt: Date.now() };
    if (res.ok) accountCache = null; // credits changed; re-read on next status call
  } catch (err) {
    result = { ok: false, error: (err as Error).message, fetchedAt: Date.now() };
  }
  labelsCache.set(cacheKey, result);
  return result;
}

/** Behavioural signal: Nansen labels when available, always combined with Fuku's own ledger. */
export interface Intelligence {
  provider: "nansen" | "fuku-ledger";
  riskLevel: "Low" | "Medium" | "High";
  signals: { label: string; value: string; tone: "good" | "warn" | "bad" | "neutral" }[];
  /** Why the provider is what it is (e.g. credits short, no labels for this address). */
  note?: string;
}

export async function agentIntelligence(input: {
  walletAddress: string | null;
  successes: number;
  violations: number;
  securityEvents: number;
  ageDays: number;
}): Promise<Intelligence> {
  const ratio = input.violations / Math.max(1, input.successes + input.violations);
  let riskLevel: Intelligence["riskLevel"] = input.securityEvents > 0 || ratio > 0.4 ? "High" : ratio > 0.15 ? "Medium" : "Low";
  const ledgerSignals: Intelligence["signals"] = [
    { label: "Violation ratio", value: `${Math.round(ratio * 100)}%`, tone: ratio > 0.15 ? "warn" : "good" },
    { label: "Security events", value: String(input.securityEvents), tone: input.securityEvents ? "bad" : "good" },
    { label: "Agent age", value: `${input.ageDays} days`, tone: input.ageDays > 3 ? "good" : "neutral" },
    { label: "Execution volume", value: `${input.successes + input.violations} actions`, tone: "neutral" },
  ];

  if (!process.env.NANSEN_API_KEY) return { provider: "fuku-ledger", riskLevel, signals: ledgerSignals };
  if (!input.walletAddress) {
    return { provider: "fuku-ledger", riskLevel, signals: ledgerSignals, note: "No wallet address on this identity to profile with Nansen." };
  }

  const labels = await nansenLabels(input.walletAddress);
  if (!labels.ok) {
    return {
      provider: "fuku-ledger",
      riskLevel,
      signals: ledgerSignals,
      note: `Nansen lookup skipped: ${labels.error}. Showing ledger-derived signals.`,
    };
  }
  const names = labels.labels.map((l) => l.label);
  if (names.some((l) => /scam|exploit|phish|hack|drainer|sanction/i.test(l))) riskLevel = "High";
  const nansenSignals: Intelligence["signals"] = names.length
    ? labels.labels.slice(0, 3).map((l) => ({
        label: `Nansen · ${l.category || "label"}`,
        value: l.label,
        tone: /scam|exploit|phish|hack|drainer|sanction/i.test(l.label) ? "bad" : "neutral",
      }))
    : [{ label: "Nansen labels", value: `none on ${nansenChain()}`, tone: "neutral" }];
  return {
    provider: "nansen",
    riskLevel,
    signals: [...nansenSignals, ...ledgerSignals].slice(0, 6),
    note: names.length ? `${names.length} Nansen label${names.length === 1 ? "" : "s"} for ${input.walletAddress.slice(0, 8)}… on ${nansenChain()}.` : `Nansen has no labels for this wallet on ${nansenChain()}; risk is ledger-derived.`,
  };
}
