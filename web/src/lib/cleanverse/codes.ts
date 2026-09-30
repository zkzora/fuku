import type { APassRecord, ComplianceLeg, ComplianceSubCode } from "./types";

/**
 * Cleanverse code literals live here only. `verify_apass` codes: 4 eligible and 2 no A-Pass are
 * evidenced in public Cleanverse-hackathon code; 3 and 1 follow the Fuku simulator's semantics
 * (frozen/expired, rule rejected) and are confirmed against `query_apass` before being trusted.
 */
export const VERIFY_ELIGIBLE = 4;
export const VERIFY_NO_APASS = 2;
export const VERIFY_FROZEN_OR_EXPIRED = 3;
export const VERIFY_RULE_REJECTED = 1;

export const APASS_ACTIVE = 1;
export const APASS_FROZEN = 2;

/** The envelope code that means success. */
export const ENVELOPE_OK = "0000";

export const SUB_CODE_TEXT: Record<ComplianceSubCode, string> = {
  OK: "passed",
  CVI_NO_WALLET: "no wallet is linked to this identity",
  CVI_NOT_FOUND: "no Cleanverse A-Pass for this wallet",
  CVI_FROZEN: "the A-Pass is frozen",
  CVI_EXPIRED: "the A-Pass has expired",
  CVI_RULE_REJECTED: "the A-Pass does not satisfy the A-Token's rule",
  CVA_NOT_ALLOWED: "the asset is not an allowed Cleanverse A-Token",
  PROVIDER_ERROR: "Cleanverse could not be checked (fail closed)",
  PROVIDER_OFF: "Cleanverse is not configured",
};

export const pass = (detail: string): ComplianceLeg => ({ ok: true, subCode: "OK", detail });
export const fail = (subCode: Exclude<ComplianceSubCode, "OK">, detail?: string): ComplianceLeg => ({
  ok: false,
  subCode,
  detail: detail ?? SUB_CODE_TEXT[subCode],
});

/** True when the pass exists, is active and has not expired at `nowSec`. */
export function classifyPass(pass: APassRecord | null, nowSec: number): ComplianceSubCode {
  if (!pass) return "CVI_NOT_FOUND";
  if (pass.status === APASS_FROZEN) return "CVI_FROZEN";
  if (pass.status !== APASS_ACTIVE) return "PROVIDER_ERROR";
  if (pass.expiresAt > 0 && pass.expiresAt <= nowSec) return "CVI_EXPIRED";
  return "OK";
}

/**
 * Map a `verify_apass` code to a Fuku sub-code. When the code is neither eligible nor "no A-Pass",
 * the caller passes the wallet's `query_apass` record so frozen, expired and rule-rejected can be
 * told apart. Anything unexplained fails closed as PROVIDER_ERROR.
 */
export function classifyVerify(code: number, pass: APassRecord | null | undefined, nowSec: number): ComplianceSubCode {
  if (code === VERIFY_ELIGIBLE) return "OK";
  if (code === VERIFY_NO_APASS) return "CVI_NOT_FOUND";
  if (pass === undefined) return "PROVIDER_ERROR";
  const state = classifyPass(pass, nowSec);
  if (state === "CVI_FROZEN" || state === "CVI_EXPIRED" || state === "CVI_NOT_FOUND") return state;
  if (state === "OK") return "CVI_RULE_REJECTED";
  return "PROVIDER_ERROR";
}
