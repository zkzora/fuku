import { aiProviderStatus } from "../engine/explain";
import { chainConfig, chainMode, lastChainWrite } from "../chain";
import { lastDynamicVerification } from "../dynamic-auth";
import { envioStatus, startBlock } from "./envio";
import { DEFAULT_BASE_URL } from "../cleanverse/client";
import { cleanverseRuntime, lastLiveCall } from "../services/cleanverse";

/**
 * Sponsor integration registry, rendered on the Developer Console. A card says "live" only when
 * the working code path has actually succeeded against the sponsor (a mined write, a verified
 * token, an answered call), never because an env var is set. "configured": keys are present but
 * nothing has succeeded yet (or it cannot be checked from here). "simulated": a local stand-in
 * runs instead. "off": not integrated.
 */
export interface IntegrationStatus {
  key: string;
  name: string;
  category: "Identity" | "Wallet" | "Data" | "AI" | "Automation" | "Credentials" | "Settlement";
  role: string;
  envVars: string[];
  /** "configured": credentials set but no successful live call yet, so it is not called live. */
  mode: "live" | "configured" | "simulated" | "off";
  detail: string;
  /** Short status note shown next to the mode (e.g. "API invite pending"). */
  badge?: string;
  /** Provider endpoints the code calls. */
  endpoints?: string[];
}

/** Cooperate API endpoints the Cleanverse client calls (see lib/cleanverse/provider.ts). */
const CLEANVERSE_ENDPOINTS = ["query_apass", "verify_apass", "atoken/rules", "query_deposit_atoken_list", "download_travel_rule"];

function cleanverseStatus(): IntegrationStatus {
  const cv = cleanverseRuntime();
  const health = lastLiveCall();
  const base = {
    key: "cleanverse",
    name: "Cleanverse",
    category: "Credentials" as const,
    role: "A-Pass (CVI) and A-Token (CVA) checks before an agent moves value",
    envVars: ["CLEANVERSE_API_ID", "CLEANVERSE_API_KEY", "CLEANVERSE_CHAIN", "CLEANVERSE_SIM_APASS", "CLEANVERSE_SIM_ATOKEN", "FUKU_SPEND_GUARD"],
    endpoints: CLEANVERSE_ENDPOINTS,
  };
  if (cv.mode === "live") {
    const url = process.env.CLEANVERSE_BASE_URL?.trim() || DEFAULT_BASE_URL;
    return health?.ok
      ? { ...base, mode: "live", detail: `Live against ${url} (chain "${cv.chain}"). Last call succeeded at ${health.at}.` }
      : {
          ...base,
          mode: "configured",
          detail: `Credentials are set for ${url}, but no live call has succeeded yet${health?.error ? ` (last error: ${health.error.slice(0, 140)})` : ""}. The card says live only after Cleanverse answers.`,
        };
  }
  if (cv.mode === "simulated") {
    return {
      ...base,
      mode: "simulated",
      badge: "API invite pending",
      detail:
        cv.backend === "sim-chain"
          ? `Cleanverse API access is invite-only, so transfers run against Fuku's simulator contracts (CleanverseAPassSim, CleanverseATokenSim aUSDC-SIM) with the same verify_apass codes. Nothing shown is issued by Cleanverse. The live client is wired to the endpoints below.`
          : "Cleanverse API access is invite-only and the chain is mocked, so the simulator answers from fixtures in the local database (same codes as the simulator contracts). Nothing shown is issued by Cleanverse.",
    };
  }
  return {
    ...base,
    mode: "off",
    detail: "Cleanverse is off (CLEANVERSE_MODE=off, or a live chain without simulator addresses). Value actions on A-Token passports are blocked with R7 PROVIDER_OFF.",
  };
}

export async function integrationStatus(): Promise<IntegrationStatus[]> {
  const ai = aiProviderStatus();
  const chain = chainMode();
  const has = (k: string) => Boolean(process.env[k]);
  const [nansen, envio] = await Promise.all([nansenAccount(), envioStatus()]);
  return [
    (() => {
      const c = chainConfig();
      const w = lastChainWrite();
      if (chain !== "live") {
        return {
          key: "monad",
          name: "Monad",
          category: "Settlement" as const,
          role: "Identity, agent, permission and reputation registries; FukuSpendGuard",
          envVars: ["FUKU_CHAIN_MODE", "DEPLOYER_PRIVATE_KEY", "FUKU_*_REGISTRY"],
          mode: "simulated" as const,
          detail: "Proof hashes are computed locally; receipts are labelled mock and have no transaction behind them.",
        };
      }
      return {
        key: "monad",
        name: "Monad",
        category: "Settlement" as const,
        role: "Identity, agent, permission and reputation registries; FukuSpendGuard",
        envVars: ["FUKU_CHAIN_MODE", "DEPLOYER_PRIVATE_KEY", "FUKU_*_REGISTRY"],
        mode: w?.ok ? ("live" as const) : ("configured" as const),
        detail: w?.ok
          ? `Transactions are signed and mined on ${c.name} (chain ${c.id}); last ${w.op} succeeded at ${w.at}.`
          : w
            ? `Live settlement is configured for ${c.name} (chain ${c.id}), but the last write (${w.op}) failed: ${w.error ?? "unknown error"}. Failed writes are recorded as failed, never as mock.`
            : `Live settlement is configured for ${c.name} (chain ${c.id}); no write has been mined by this server process yet.`,
      };
    })(),
    (() => {
      const configured = has("NEXT_PUBLIC_DYNAMIC_ENV_ID");
      const v = lastDynamicVerification();
      return {
        key: "dynamic",
        name: "Dynamic",
        category: "Identity" as const,
        role: "Email sign-in with an embedded EVM wallet",
        envVars: ["NEXT_PUBLIC_DYNAMIC_ENV_ID"],
        mode: !configured ? ("off" as const) : v?.ok ? ("live" as const) : ("configured" as const),
        detail: !configured
          ? "Not configured. Passkey sign-in is the active method."
          : `Email sign-in and wallet linking through the Dynamic JavaScript SDK; the server verifies Dynamic's JWT (RS256, JWKS, issuer, scope) and records the wallet as Dynamic-verified. ${
              v?.ok ? `Last verification succeeded at ${v.at}.` : v ? `The last verification failed: ${v.error}.` : "No token has been verified by this server process yet."
            } Email sign-in alone is not a passkey verification.`,
      };
    })(),
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
      mode: !ai.kimi ? "simulated" : ai.kimiHealth?.ok ? "live" : "configured",
      detail: !ai.kimi
        ? "Explanations use Fuku's deterministic rule narrator."
        : ai.kimiHealth?.ok
          ? `Explanations are generated by Kimi (last call ${ai.kimiHealth.at}). The AI explains decisions; it never makes them.`
          : `KIMI_API_KEY is set; ${ai.kimiHealth ? `the last call failed (${ai.kimiHealth.error}), so the rule narrator answered` : "no call has succeeded yet"}.`,
    },
    {
      key: "qwen",
      name: "Qwen",
      category: "AI",
      role: "Explanations (tried after Kimi)",
      envVars: ["QWEN_API_KEY"],
      mode: !ai.qwen ? "simulated" : ai.qwenHealth?.ok ? "live" : "configured",
      detail: !ai.qwen
        ? "Explanations use the rule narrator."
        : ai.qwenHealth?.ok
          ? `Explanations are generated by Qwen (last call ${ai.qwenHealth.at}).`
          : `QWEN_API_KEY is set; ${ai.qwenHealth ? `the last call failed (${ai.qwenHealth.error})` : "no call has succeeded yet"}.`,
    },
    {
      key: "chainlink-cre",
      name: "Chainlink CRE",
      category: "Automation",
      role: "Workflow: request → verify → execute → record",
      envVars: ["CRE_WORKFLOW_ID"],
      mode: has("CRE_WORKFLOW_ID") ? "configured" : "simulated",
      detail: has("CRE_WORKFLOW_ID")
        ? `CRE_WORKFLOW_ID is set (${process.env.CRE_WORKFLOW_ID!.slice(0, 10)}…). Fuku cannot see the DON from here, so the card stays "configured". The workflow calls the same public API, so every Fuku rule applies to it.`
        : "Workflow cre/fuku-guard (HTTP trigger → verify via the Fuku API → execute → EVM read of the Monad registries) runs end to end with `cre workflow simulate`, the path Chainlink recommends for hackathons. It calls the same public API as any client, so it cannot bypass Fuku's rules. Deploying to the DON requires a commercial agreement with Chainlink.",
    },
    cleanverseStatus(),
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
