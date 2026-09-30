import type { CleanverseClient } from "./client";
import { APASS_ACTIVE, APASS_FROZEN, VERIFY_ELIGIBLE, VERIFY_FROZEN_OR_EXPIRED, VERIFY_NO_APASS, VERIFY_RULE_REJECTED } from "./codes";
import type { APassRecord, ATokenRule, AssetInfo, CleanverseBackend, VerifyResult } from "./types";

/**
 * One interface for the real Cleanverse API and the Fuku simulator. Every method throws on any
 * provider failure; callers fail closed.
 */
export interface CleanverseProvider {
  readonly backend: CleanverseBackend;
  readonly chain: string;
  getAPass(wallet: string): Promise<{ pass: APassRecord | null; requestId: string | null }>;
  verifyAPass(wallet: string, atoken: string): Promise<VerifyResult>;
  getRule(atoken: string): Promise<{ rule: ATokenRule; requestId: string | null }>;
  resolveAsset(symbol: string): Promise<AssetInfo | null>;
  travelRule?(txHash: string): Promise<{ record: unknown; requestId: string | null }>;
}

// --- Live -----------------------------------------------------------------------------------------

interface RawAPass {
  cvRecordId?: string;
  status?: number | string;
  expirationTime?: number | string;
  tier?: string | number;
  subTier?: number | string;
  group?: string | null;
  subGroup?: string | null;
  countries?: string[];
  currentKycHash?: string | null;
}

interface RawRule {
  allowed_group?: string | null;
  allowed_sub_group?: string | null;
  min_tier?: number | string;
  min_sub_tier?: number | string;
  is_black_list?: boolean | null;
  countries?: string[] | null;
}

const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  const m = String(v ?? "").match(/-?\d+/);
  return m ? Number(m[0]) : NaN;
};

export function normaliseAPass(wallet: string, raw: RawAPass | null, source: APassRecord["source"]): APassRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const status = num(raw.status);
  const tier = num(raw.tier);
  const subTier = num(raw.subTier ?? 0);
  const expiresAt = num(raw.expirationTime ?? 0);
  if (!raw.cvRecordId || Number.isNaN(status) || Number.isNaN(tier) || Number.isNaN(expiresAt)) {
    throw new Error("Cleanverse A-Pass record is missing required fields");
  }
  return {
    wallet: wallet.toLowerCase(),
    cvRecordId: String(raw.cvRecordId),
    status,
    tier,
    subTier: Number.isNaN(subTier) ? 0 : subTier,
    group: raw.group || null,
    subGroup: raw.subGroup || null,
    expiresAt,
    countries: Array.isArray(raw.countries) ? raw.countries.map(String) : [],
    kycHash: raw.currentKycHash ?? null,
    source,
    raw,
  };
}

export function normaliseRule(raw: RawRule | null): ATokenRule {
  if (!raw || typeof raw !== "object") throw new Error("Cleanverse returned no A-Token rule");
  const minTier = num(raw.min_tier ?? 0);
  const minSubTier = num(raw.min_sub_tier ?? 0);
  if (Number.isNaN(minTier) || Number.isNaN(minSubTier)) throw new Error("Cleanverse A-Token rule has invalid tiers");
  return {
    allowedGroup: raw.allowed_group || null,
    allowedSubGroup: raw.allowed_sub_group || null,
    minTier,
    minSubTier,
    blacklist: raw.is_black_list ?? null,
    countries: raw.countries ?? null,
  };
}

export class LiveCleanverseProvider implements CleanverseProvider {
  readonly backend = "api" as const;
  private assetCache = new Map<string, AssetInfo | null>();

  constructor(
    private readonly client: CleanverseClient,
    readonly chain: string,
    /** Known A-Token from env (CLEANVERSE_ATOKEN_SYMBOL / CLEANVERSE_ATOKEN_ADDRESS), checked first. */
    private readonly knownAsset: AssetInfo | null,
  ) {}

  async getAPass(wallet: string) {
    const r = await this.client.post<RawAPass>("query_apass", { chain: this.chain, address: wallet });
    return { pass: normaliseAPass(wallet, r.data, "cleanverse"), requestId: r.requestId };
  }

  async verifyAPass(wallet: string, atoken: string): Promise<VerifyResult> {
    const r = await this.client.post<{ code?: number | string; message?: string }>("verify_apass", {
      atoken,
      chain: this.chain,
      address: wallet,
    });
    const code = num(r.data?.code);
    if (Number.isNaN(code)) throw new Error("Cleanverse verify_apass returned no code");
    return { wallet: wallet.toLowerCase(), atoken, code, message: r.data?.message ?? "", requestId: r.requestId };
  }

  async getRule(atoken: string) {
    const r = await this.client.post<RawRule>("atoken/rules", { chain: this.chain, atokenAddress: atoken });
    return { rule: normaliseRule(r.data), requestId: r.requestId };
  }

  async resolveAsset(symbol: string): Promise<AssetInfo | null> {
    const key = symbol.toLowerCase();
    if (this.knownAsset && this.knownAsset.symbol.toLowerCase() === key) return this.knownAsset;
    if (this.assetCache.has(key)) return this.assetCache.get(key) ?? null;
    const r = await this.client.post<Array<Record<string, unknown>> | { list?: Array<Record<string, unknown>> }>(
      "query_deposit_atoken_list",
      { chain: this.chain },
    );
    const list = Array.isArray(r.data) ? r.data : (r.data?.list ?? []);
    const hit = list.find((t) => String(t.symbol ?? t.token_symbol ?? "").toLowerCase() === key);
    const address = hit ? String(hit.address ?? hit.atoken ?? hit.contract ?? hit.token_address ?? "") : "";
    const asset: AssetInfo | null =
      hit && /^0x[0-9a-fA-F]{40}$/.test(address)
        ? { symbol: String(hit.symbol ?? hit.token_symbol), address, decimals: num(hit.decimals ?? 6) || 6, source: "cleanverse" }
        : null;
    this.assetCache.set(key, asset);
    return asset;
  }

  async travelRule(txHash: string) {
    const r = await this.client.post<unknown>("download_travel_rule", { txHash });
    return { record: r.data, requestId: r.requestId };
  }
}

// --- Simulator ------------------------------------------------------------------------------------

/**
 * Same semantics as CleanverseAPassSim.verify: 2 no A-Pass, 3 frozen or expired, 1 rule rejected,
 * 4 eligible. Used by the fixture backend (mock-chain mode) so both backends answer identically.
 */
export function simVerify(pass: APassRecord | null, rule: ATokenRule, nowSec: number): number {
  if (!pass || pass.status === 0) return VERIFY_NO_APASS;
  if (pass.status === APASS_FROZEN || (pass.expiresAt > 0 && pass.expiresAt <= nowSec)) return VERIFY_FROZEN_OR_EXPIRED;
  if (pass.status !== APASS_ACTIVE) return VERIFY_FROZEN_OR_EXPIRED;
  if (rule.allowedGroup && pass.group !== rule.allowedGroup) return VERIFY_RULE_REJECTED;
  if (rule.allowedSubGroup && pass.subGroup !== rule.allowedSubGroup) return VERIFY_RULE_REJECTED;
  if (pass.tier < rule.minTier || (pass.tier === rule.minTier && pass.subTier < rule.minSubTier)) return VERIFY_RULE_REJECTED;
  return VERIFY_ELIGIBLE;
}

/** Storage behind the simulator: the simulator contracts, or DB fixtures in mock-chain mode. */
export interface SimBackend {
  readonly kind: "sim-chain" | "sim-fixtures";
  asset(): AssetInfo;
  getPass(wallet: string): Promise<APassRecord | null>;
  getRule(): Promise<ATokenRule>;
  /** On-chain verify when available; the fixture backend omits it and uses `simVerify`. */
  verify?(wallet: string): Promise<number>;
}

/** Symbols the simulator answers to: the A-Token symbol the passport uses and the sim's own. */
export const SIM_ASSET_ALIASES = ["ausdc", "ausdc-sim"];

export class SimCleanverseProvider implements CleanverseProvider {
  readonly backend: CleanverseBackend;

  constructor(
    private readonly sim: SimBackend,
    readonly chain: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.backend = sim.kind;
  }

  async getAPass(wallet: string) {
    return { pass: await this.sim.getPass(wallet), requestId: null };
  }

  async verifyAPass(wallet: string, atoken: string): Promise<VerifyResult> {
    this.assertAsset(atoken);
    const code = this.sim.verify
      ? await this.sim.verify(wallet)
      : simVerify(await this.sim.getPass(wallet), await this.sim.getRule(), this.now());
    return { wallet: wallet.toLowerCase(), atoken, code, message: `simulator verify code ${code}`, requestId: null };
  }

  async getRule(atoken: string) {
    this.assertAsset(atoken);
    return { rule: await this.sim.getRule(), requestId: null };
  }

  async resolveAsset(symbol: string): Promise<AssetInfo | null> {
    return SIM_ASSET_ALIASES.includes(symbol.toLowerCase()) ? this.sim.asset() : null;
  }

  private assertAsset(atoken: string) {
    if (atoken.toLowerCase() !== this.sim.asset().address.toLowerCase()) {
      throw new Error(`Unknown simulator A-Token ${atoken}`);
    }
  }
}
