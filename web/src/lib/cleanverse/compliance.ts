import { isAddress } from "viem";
import { classifyPass, classifyVerify, fail, pass as passLeg, SUB_CODE_TEXT, VERIFY_ELIGIBLE, VERIFY_NO_APASS } from "./codes";
import { complianceRefOf } from "./evidence";
import type { CleanverseProvider } from "./provider";
import type { APassRecord, ATokenRule, AssetInfo, CleanverseMode, ComplianceEvidence, ComplianceLeg, ComplianceResult } from "./types";

/**
 * Gathers the Cleanverse evidence for one value action on an A-Token passport, as three legs:
 *   asset (R9)         the action is `transfer`, the asset is on the passport and resolves to an A-Token
 *   owner (R7)         the owner's wallet holds an active, unexpired A-Pass and verify_apass == 4
 *   counterparty (R8)  `to` is a valid address and verify_apass(to) == 4
 * Everything fails closed: any provider error, timeout or unexplained code blocks the action.
 * The engine stays pure; it only reads the legs this returns.
 */
export interface GatherInput {
  mode: CleanverseMode;
  provider: CleanverseProvider | null;
  chain: string;
  action: string;
  assetSymbol: string | null | undefined;
  passportAssets: string[];
  ownerWallet: string | null | undefined;
  counterparty: string | null | undefined;
  nowSec?: number;
  /** Called with every A-Pass read (for persistence to CleanversePass). */
  onPassRead?: (wallet: string, pass: APassRecord | null) => void | Promise<void>;
}

const OWNER_CACHE_MS = 60_000;
const ownerCache = new Map<string, { at: number; pass: APassRecord | null; requestId: string | null }>();

export function clearOwnerPassCache() {
  ownerCache.clear();
}

export async function gatherCompliance(input: GatherInput): Promise<ComplianceResult> {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const requestIds: string[] = [];
  const evidence: ComplianceEvidence = {
    provider: "cleanverse",
    mode: input.mode,
    chain: input.chain,
    atoken: { symbol: input.assetSymbol ?? "", address: null, rule: null },
    owner: {
      wallet: input.ownerWallet?.toLowerCase() ?? null,
      cvRecordId: null,
      status: null,
      tier: null,
      subTier: null,
      expiresAt: null,
      verifyCode: null,
    },
    counterparty: { wallet: input.counterparty?.toLowerCase() ?? null, verifyCode: null, message: null },
    checkedAt: new Date(nowSec * 1000).toISOString(),
    requestIds,
  };
  const done = (asset: ComplianceLeg, owner: ComplianceLeg, counterparty: ComplianceLeg): ComplianceResult => ({
    mode: input.mode,
    asset,
    owner,
    counterparty,
    evidence,
    complianceRef: complianceRefOf(evidence),
  });

  if (input.mode === "off" || !input.provider) {
    const off = fail("PROVIDER_OFF");
    return done(off, off, off);
  }
  const provider = input.provider;
  const notEvaluated = (why: string) => fail("PROVIDER_ERROR", `not evaluated: ${why}`);

  // --- R9: asset ---
  let asset: AssetInfo | null = null;
  let rule: ATokenRule | null = null;
  let assetLeg: ComplianceLeg;
  try {
    const symbol = input.assetSymbol?.trim() ?? "";
    if (input.action !== "transfer") {
      assetLeg = fail("CVA_NOT_ALLOWED", `only transfer moves A-Tokens (got ${input.action})`);
    } else if (!symbol) {
      assetLeg = fail("CVA_NOT_ALLOWED", "no asset given");
    } else if (!input.passportAssets.some((a) => a.toLowerCase() === symbol.toLowerCase())) {
      assetLeg = fail("CVA_NOT_ALLOWED", `${symbol} is not on this passport's A-Token list`);
    } else {
      asset = await provider.resolveAsset(symbol);
      if (!asset) {
        assetLeg = fail("CVA_NOT_ALLOWED", `${symbol} does not resolve to a Cleanverse A-Token`);
      } else {
        const r = await provider.getRule(asset.address);
        rule = r.rule;
        if (r.requestId) requestIds.push(r.requestId);
        evidence.atoken = { symbol: asset.symbol, address: asset.address, rule };
        assetLeg = passLeg(`${asset.symbol} (${asset.source === "simulated" ? "Cleanverse simulator" : "Cleanverse"}) at ${asset.address}`);
      }
    }
  } catch (err) {
    assetLeg = fail("PROVIDER_ERROR", `asset check failed: ${(err as Error).message}`);
  }
  if (!assetLeg.ok || !asset) {
    return done(assetLeg, notEvaluated("asset rejected"), notEvaluated("asset rejected"));
  }

  // --- R7: owner A-Pass ---
  let ownerLeg: ComplianceLeg;
  try {
    const wallet = input.ownerWallet;
    if (!wallet || !isAddress(wallet)) {
      ownerLeg = fail("CVI_NO_WALLET");
    } else {
      const cacheKey = `${provider.backend}:${input.chain}:${wallet.toLowerCase()}`;
      const cached = ownerCache.get(cacheKey);
      let pass: APassRecord | null;
      if (cached && Date.now() - cached.at < OWNER_CACHE_MS) {
        pass = cached.pass;
      } else {
        const r = await provider.getAPass(wallet);
        pass = r.pass;
        if (r.requestId) requestIds.push(r.requestId);
        ownerCache.set(cacheKey, { at: Date.now(), pass, requestId: r.requestId });
        await input.onPassRead?.(wallet, pass);
      }
      if (pass) {
        Object.assign(evidence.owner, {
          cvRecordId: pass.cvRecordId,
          status: pass.status,
          tier: pass.tier,
          subTier: pass.subTier,
          expiresAt: pass.expiresAt,
        });
      }
      const state = classifyPass(pass, nowSec);
      if (state !== "OK") {
        ownerLeg = fail(state);
      } else {
        const v = await provider.verifyAPass(wallet, asset.address);
        if (v.requestId) requestIds.push(v.requestId);
        evidence.owner.verifyCode = v.code;
        const sub = classifyVerify(v.code, pass, nowSec);
        ownerLeg = sub === "OK" ? passLeg(`A-Pass ${pass!.cvRecordId}, tier ${pass!.tier}.${pass!.subTier}, verify ${v.code}`) : fail(sub);
      }
    }
  } catch (err) {
    ownerLeg = fail("PROVIDER_ERROR", `owner check failed: ${(err as Error).message}`);
  }

  // --- R8: counterparty ---
  let cpLeg: ComplianceLeg;
  try {
    const to = input.counterparty;
    if (!to || !isAddress(to)) {
      cpLeg = fail("CVI_NOT_FOUND", "the recipient is not a valid EVM address");
    } else {
      const v = await provider.verifyAPass(to, asset.address);
      if (v.requestId) requestIds.push(v.requestId);
      evidence.counterparty = { wallet: to.toLowerCase(), verifyCode: v.code, message: v.message };
      if (v.code === VERIFY_ELIGIBLE) {
        cpLeg = passLeg(`recipient verified (verify ${v.code})`);
      } else if (v.code === VERIFY_NO_APASS) {
        cpLeg = fail("CVI_NOT_FOUND");
      } else {
        // Neither eligible nor "no A-Pass": ask query_apass why (frozen, expired or rule).
        const r = await provider.getAPass(to);
        if (r.requestId) requestIds.push(r.requestId);
        await input.onPassRead?.(to, r.pass);
        cpLeg = fail(classifyVerify(v.code, r.pass, nowSec) as Exclude<ReturnType<typeof classifyVerify>, "OK">);
      }
    }
  } catch (err) {
    cpLeg = fail("PROVIDER_ERROR", `recipient check failed: ${(err as Error).message}`);
  }

  return done(assetLeg, ownerLeg, cpLeg);
}

export function legText(leg: ComplianceLeg) {
  return leg.ok ? leg.detail : `${leg.subCode}: ${leg.detail || SUB_CODE_TEXT[leg.subCode]}`;
}
