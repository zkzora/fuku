import type { Address } from "viem";
import { db } from "../db";
import { chainMode, chainReader } from "../chain";
import { CleanverseClient, cleanverseConfigFromEnv } from "../cleanverse/client";
import { gatherCompliance } from "../cleanverse/compliance";
import { SIM_FIXTURE_ATOKEN } from "../cleanverse/demo";
import { cleanverseChain, resolveCleanverse, type Env } from "../cleanverse/mode";
import { LiveCleanverseProvider, SimCleanverseProvider, type CleanverseProvider, type SimBackend } from "../cleanverse/provider";
import { SimChainBackend } from "../cleanverse/sim-chain";
import type { APassRecord, ATokenRule, AssetInfo, CleanverseBackend, CleanverseMode, ComplianceResult } from "../cleanverse/types";

/**
 * Server-side wiring for Cleanverse: picks the provider for the current mode, persists every
 * A-Pass read to CleanversePass (so pages and the trust score never call the API synchronously),
 * and remembers whether the last live call succeeded (the integration card only says "live" then).
 */

export interface CleanverseRuntime {
  mode: CleanverseMode;
  backend: CleanverseBackend | null;
  chain: string;
  provider: CleanverseProvider | null;
}

export function cleanverseRuntime(env: Env = process.env): CleanverseRuntime {
  const { mode, backend } = resolveCleanverse({ env, chainLive: chainMode() === "live" });
  const chain = cleanverseChain(env);
  let provider: CleanverseProvider | null = null;
  if (backend === "api") {
    const config = cleanverseConfigFromEnv(env);
    if (config) provider = tracked(new LiveCleanverseProvider(new CleanverseClient(config), chain, knownAsset(env)));
  } else if (backend === "sim-chain") {
    const reader = chainReader();
    if (reader) {
      const sim = new SimChainBackend(reader, {
        apass: env.CLEANVERSE_SIM_APASS!.trim() as Address,
        atoken: env.CLEANVERSE_SIM_ATOKEN!.trim() as Address,
      });
      provider = new SimCleanverseProvider(sim, chain);
    }
  } else if (backend === "sim-fixtures") {
    provider = new SimCleanverseProvider(new FixtureBackend(chain), chain);
  }
  return { mode: provider ? mode : "off", backend: provider ? backend : null, chain, provider };
}

function knownAsset(env: Env): AssetInfo | null {
  const symbol = env.CLEANVERSE_ATOKEN_SYMBOL?.trim();
  const address = env.CLEANVERSE_ATOKEN_ADDRESS?.trim();
  if (!symbol || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return { symbol, address: address.toLowerCase(), decimals: 6, source: "cleanverse" };
}

// --- Evidence for one action -----------------------------------------------------------------------

export async function complianceFor(input: {
  action: string;
  assetSymbol: string | null | undefined;
  passportAssets: string[];
  ownerWallet: string | null | undefined;
  counterparty: string | null | undefined;
}): Promise<ComplianceResult> {
  const rt = cleanverseRuntime();
  return gatherCompliance({
    ...input,
    mode: rt.mode,
    provider: rt.provider,
    chain: rt.chain,
    onPassRead: (wallet, pass) => recordPassRead(rt, wallet, pass),
  });
}

// --- Persistence -----------------------------------------------------------------------------------

function sourceOf(rt: Pick<CleanverseRuntime, "backend">): "cleanverse" | "simulated" {
  return rt.backend === "api" ? "cleanverse" : "simulated";
}

export async function recordPassRead(rt: Pick<CleanverseRuntime, "backend" | "chain">, wallet: string, pass: APassRecord | null) {
  const key = { chain: rt.chain, wallet: wallet.toLowerCase(), source: pass?.source ?? sourceOf(rt) };
  const data = pass
    ? {
        found: true,
        cvRecordId: pass.cvRecordId,
        status: pass.status,
        tier: pass.tier,
        subTier: pass.subTier,
        group: pass.group,
        subGroup: pass.subGroup,
        expiresAt: pass.expiresAt,
        countries: JSON.stringify(pass.countries),
        raw: JSON.stringify(pass.raw, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
        checkedAt: new Date(),
      }
    : { found: false, cvRecordId: null, status: null, tier: null, subTier: null, group: null, subGroup: null, expiresAt: null, countries: "[]", raw: null, checkedAt: new Date() };
  try {
    await db.cleanversePass.upsert({ where: { chain_wallet_source: key }, create: { ...key, ...data }, update: data });
  } catch (err) {
    console.warn(`[cleanverse] could not persist A-Pass read for ${key.wallet}: ${(err as Error).message}`);
  }
}

export interface APassView {
  mode: CleanverseMode;
  source: "cleanverse" | "simulated";
  wallet: string | null;
  found: boolean;
  pass: {
    cvRecordId: string | null;
    status: number | null;
    tier: number | null;
    subTier: number | null;
    group: string | null;
    subGroup: string | null;
    expiresAt: number | null;
  } | null;
  checkedAt: string | null;
}

/** The persisted A-Pass for a wallet in the current mode (no provider call). */
export async function storedAPass(wallet: string | null | undefined): Promise<APassView> {
  const rt = cleanverseRuntime();
  const source = sourceOf(rt);
  const base = { mode: rt.mode, source, wallet: wallet?.toLowerCase() ?? null };
  if (!wallet || rt.mode === "off") return { ...base, found: false, pass: null, checkedAt: null };
  const row = await db.cleanversePass.findUnique({
    where: { chain_wallet_source: { chain: rt.chain, wallet: wallet.toLowerCase(), source } },
  });
  if (!row) return { ...base, found: false, pass: null, checkedAt: null };
  return {
    ...base,
    found: row.found,
    pass: row.found
      ? { cvRecordId: row.cvRecordId, status: row.status, tier: row.tier, subTier: row.subTier, group: row.group, subGroup: row.subGroup, expiresAt: row.expiresAt }
      : null,
    checkedAt: row.checkedAt.toISOString(),
  };
}

/** Re-read the wallet's A-Pass from the provider, persist it, and return the stored view. */
export async function refreshAPass(wallet: string): Promise<APassView> {
  const rt = cleanverseRuntime();
  if (rt.provider) {
    const { pass } = await rt.provider.getAPass(wallet);
    await recordPassRead(rt, wallet, pass);
  }
  return storedAPass(wallet);
}

// --- Fixture backend (mock-chain mode) -------------------------------------------------------------

/** Simulator fixtures seeded into CleanversePass (source "simulated"); same semantics as the sim contracts. */
class FixtureBackend implements SimBackend {
  readonly kind = "sim-fixtures" as const;
  constructor(private readonly chain: string) {}

  asset(): AssetInfo {
    return { symbol: "aUSDC-SIM", address: SIM_FIXTURE_ATOKEN.toLowerCase(), decimals: 6, source: "simulated" };
  }

  async getPass(wallet: string): Promise<APassRecord | null> {
    const row = await db.cleanversePass.findUnique({
      where: { chain_wallet_source: { chain: this.chain, wallet: wallet.toLowerCase(), source: "simulated" } },
    });
    if (!row || !row.found || !row.status) return null;
    return {
      wallet: row.wallet,
      cvRecordId: row.cvRecordId ?? "",
      status: row.status,
      tier: row.tier ?? 0,
      subTier: row.subTier ?? 0,
      group: row.group,
      subGroup: row.subGroup,
      expiresAt: row.expiresAt ?? 0,
      countries: safeList(row.countries),
      kycHash: null,
      source: "simulated",
      raw: { fixture: true },
    };
  }

  async getRule(): Promise<ATokenRule> {
    // Same rule the setup script gives CleanverseATokenSim: any group, tier >= 1.
    return { allowedGroup: null, allowedSubGroup: null, minTier: 1, minSubTier: 0, blacklist: null, countries: null };
  }
}

function safeList(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

// --- Live call health ------------------------------------------------------------------------------

export interface LiveHealth {
  ok: boolean;
  at: string;
  error?: string;
}

const g = globalThis as unknown as { __fukuCleanverseHealth?: LiveHealth | null };

/** Outcome of the most recent live Cleanverse API call in this process, or null if none yet. */
export function lastLiveCall(): LiveHealth | null {
  return g.__fukuCleanverseHealth ?? null;
}

function note(ok: boolean, error?: string) {
  g.__fukuCleanverseHealth = { ok, at: new Date().toISOString(), ...(error ? { error } : {}) };
}

/** Wrap the live provider so every call records whether Cleanverse answered. */
function tracked(p: LiveCleanverseProvider): CleanverseProvider {
  const wrap =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        const r = await fn(...args);
        note(true);
        return r;
      } catch (err) {
        note(false, (err as Error).message);
        throw err;
      }
    };
  return {
    backend: p.backend,
    chain: p.chain,
    getAPass: wrap(p.getAPass.bind(p)),
    verifyAPass: wrap(p.verifyAPass.bind(p)),
    getRule: wrap(p.getRule.bind(p)),
    resolveAsset: wrap(p.resolveAsset.bind(p)),
    travelRule: wrap(p.travelRule.bind(p)),
  };
}
