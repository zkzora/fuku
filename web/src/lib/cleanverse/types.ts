/**
 * Cleanverse types. The provider-facing shapes mirror the (unverified) Cleanverse cooperate API
 * as inferred from public Cleanverse-hackathon code; see docs/CLEANVERSE.md for provenance.
 */

export type CleanverseMode = "live" | "simulated" | "off";

/** Where a simulated read comes from: the simulator contracts, or DB fixtures in mock-chain mode. */
export type CleanverseBackend = "api" | "sim-chain" | "sim-fixtures";

/** Normalised A-Pass (CVI) record. `status`: 1 active, 2 frozen. */
export interface APassRecord {
  wallet: string;
  cvRecordId: string;
  status: number;
  tier: number;
  subTier: number;
  group: string | null;
  subGroup: string | null;
  /** Unix seconds; 0 means no expiry. */
  expiresAt: number;
  countries: string[];
  kycHash: string | null;
  source: "cleanverse" | "simulated";
  raw: unknown;
}

/** A-Token (CVA) compliance rule. Empty / zero fields mean "any". */
export interface ATokenRule {
  allowedGroup: string | null;
  allowedSubGroup: string | null;
  minTier: number;
  minSubTier: number;
  blacklist: boolean | null;
  countries: string[] | null;
}

export interface AssetInfo {
  symbol: string;
  address: string;
  decimals: number;
  source: "cleanverse" | "simulated";
}

/** Result of `verify_apass`: 4 eligible, 2 no A-Pass, 3 frozen or expired (sim), 1 rule rejected (sim). */
export interface VerifyResult {
  wallet: string;
  atoken: string;
  code: number;
  message: string;
  requestId: string | null;
}

export type ComplianceSubCode =
  | "OK"
  | "CVI_NO_WALLET"
  | "CVI_NOT_FOUND"
  | "CVI_FROZEN"
  | "CVI_EXPIRED"
  | "CVI_RULE_REJECTED"
  | "CVA_NOT_ALLOWED"
  | "PROVIDER_ERROR"
  | "PROVIDER_OFF";

/** One Cleanverse check ("leg"): the asset rule, the owner's A-Pass, or the counterparty. */
export interface ComplianceLeg {
  ok: boolean;
  subCode: ComplianceSubCode;
  detail: string;
}

export interface ComplianceEvidence {
  provider: "cleanverse";
  mode: CleanverseMode;
  chain: string;
  atoken: { symbol: string; address: string | null; rule: ATokenRule | null };
  owner: {
    wallet: string | null;
    cvRecordId: string | null;
    status: number | null;
    tier: number | null;
    subTier: number | null;
    expiresAt: number | null;
    verifyCode: number | null;
  };
  counterparty: { wallet: string | null; verifyCode: number | null; message: string | null };
  checkedAt: string;
  requestIds: string[];
}

export interface ComplianceResult {
  mode: CleanverseMode;
  asset: ComplianceLeg;
  owner: ComplianceLeg;
  counterparty: ComplianceLeg;
  evidence: ComplianceEvidence;
  /** keccak256 of the canonical evidence JSON. */
  complianceRef: `0x${string}`;
}
