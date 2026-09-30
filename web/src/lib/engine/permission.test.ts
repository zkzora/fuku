import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate, toMicros, utcDayStart, type EvaluationInput } from "./permission";
import { policyHashDoc, type PolicyDoc } from "./policy";
import { fail, pass } from "../cleanverse/codes";
import type { ComplianceLeg, ComplianceResult } from "../cleanverse/types";

const trading: PolicyDoc = {
  allowed: [{ action: "swap", limitUsdcPerDay: 5000 }, { action: "read_balances" }, { action: "price_feeds" }],
  blocked: ["withdraw", "change_owner", "transfer"],
  scopeApps: ["Monad DEX"],
  assets: [],
};

const NUSANTARA = "0x7ad75ad75a52e8d4ee5290294c498917386f40bb";

const payments: PolicyDoc = {
  allowed: [{ action: "transfer", limitUsdcPerDay: 1000 }, { action: "read_balances" }],
  blocked: ["withdraw", "change_owner"],
  scopeApps: [],
  assets: ["aUSDC"],
};

const base = (over: Partial<EvaluationInput> = {}): EvaluationInput => ({
  agentStatus: "active",
  policy: trading,
  policyActive: true,
  action: "swap",
  amountUsdc: 100,
  app: "Monad DEX",
  ownerVerified: true,
  spentTodayUsdc: 0,
  ...over,
});

const compliance = (legs: Partial<Record<"asset" | "owner" | "counterparty", ComplianceLeg>> = {}): ComplianceResult => ({
  mode: "simulated",
  asset: legs.asset ?? pass("aUSDC-SIM"),
  owner: legs.owner ?? pass("A-Pass ok"),
  counterparty: legs.counterparty ?? pass("recipient ok"),
  evidence: {
    provider: "cleanverse",
    mode: "simulated",
    chain: "monad",
    atoken: { symbol: "aUSDC", address: null, rule: null },
    owner: { wallet: null, cvRecordId: null, status: null, tier: null, subTier: null, expiresAt: null, verifyCode: null },
    counterparty: { wallet: null, verifyCode: null, message: null },
    checkedAt: "2026-09-30T00:00:00.000Z",
    requestIds: [],
  },
  complianceRef: "0x0000000000000000000000000000000000000000000000000000000000000001",
});

describe("permission engine: R0-R6 unchanged for passports without A-Tokens", () => {
  it("keeps every existing rule id and meaning", () => {
    assert.equal(evaluate(base({ agentStatus: "paused" })).ruleId, "R0");
    assert.equal(evaluate(base({ policyActive: false })).ruleId, "R1");
    assert.equal(evaluate(base({ policy: null })).ruleId, "R1");
    const climax = evaluate(base({ action: "withdraw", amountUsdc: 4800 }));
    assert.deepEqual([climax.decision, climax.ruleId], ["BLOCKED", "R2"]);
    assert.equal(evaluate(base({ action: "transfer", amountUsdc: 10 })).ruleId, "R2");
    assert.equal(evaluate(base({ action: "stake" })).ruleId, "R3");
    assert.equal(evaluate(base({ app: "Uniswap", action: "read_balances" })).ruleId, "R4");
    assert.equal(evaluate(base({ amountUsdc: 3000, spentTodayUsdc: 2400 })).ruleId, "R5");
    const ok = evaluate(base({ amountUsdc: 1200 }));
    assert.deepEqual([ok.decision, ok.ruleId, ok.subCode], ["ALLOWED", "R6", undefined]);
  });

  it("does not require Cleanverse evidence when the passport lists no assets", () => {
    const r = evaluate(base({ amountUsdc: 100, compliance: null }));
    assert.equal(r.ruleId, "R6");
  });
});

describe("permission engine: A-Token passports", () => {
  const pay = (over: Partial<EvaluationInput> = {}) =>
    base({ policy: payments, action: "transfer", amountUsdc: 250, app: null, to: NUSANTARA, compliance: compliance(), ...over });

  it("non-value actions on an A-Token passport behave as today (no evidence needed)", () => {
    const r = evaluate(pay({ action: "read_balances", amountUsdc: null, compliance: null }));
    assert.deepEqual([r.decision, r.ruleId], ["ALLOWED", "R6"]);
  });

  it("allows a transfer when all three Cleanverse legs pass and the cap has room", () => {
    const r = evaluate(pay());
    assert.deepEqual([r.decision, r.ruleId], ["ALLOWED", "R6"]);
    assert.equal(r.remainingUsdc, 750);
  });

  it("R9 asset, then R7 owner, then R8 counterparty, each with its sub-code", () => {
    const r9 = evaluate(pay({ compliance: compliance({ asset: fail("CVA_NOT_ALLOWED"), owner: fail("CVI_FROZEN"), counterparty: fail("CVI_NOT_FOUND") }) }));
    assert.deepEqual([r9.ruleId, r9.subCode], ["R9", "CVA_NOT_ALLOWED"]);
    const r7 = evaluate(pay({ compliance: compliance({ owner: fail("CVI_EXPIRED"), counterparty: fail("CVI_NOT_FOUND") }) }));
    assert.deepEqual([r7.ruleId, r7.subCode], ["R7", "CVI_EXPIRED"]);
    const r8 = evaluate(pay({ compliance: compliance({ counterparty: fail("CVI_FROZEN") }) }));
    assert.deepEqual([r8.ruleId, r8.subCode], ["R8", "CVI_FROZEN"]);
    assert.match(r8.reason, /CVI_FROZEN/);
  });

  it("orders R2/R3/R4 before the Cleanverse rules and R5 after them", () => {
    assert.equal(evaluate(pay({ action: "withdraw", compliance: compliance({ asset: fail("CVA_NOT_ALLOWED") }) })).ruleId, "R2");
    assert.equal(evaluate(pay({ action: "swap", compliance: compliance({ asset: fail("CVA_NOT_ALLOWED") }) })).ruleId, "R3");
    assert.equal(evaluate(pay({ amountUsdc: 5000, compliance: compliance({ counterparty: fail("CVI_NOT_FOUND") }) })).ruleId, "R8");
    assert.equal(evaluate(pay({ amountUsdc: 800, spentTodayUsdc: 300 })).ruleId, "R5");
  });

  it("fails closed without evidence, and blocks with PROVIDER_OFF when Cleanverse is off", () => {
    const missing = evaluate(pay({ compliance: null }));
    assert.deepEqual([missing.decision, missing.ruleId, missing.subCode], ["BLOCKED", "R7", "PROVIDER_ERROR"]);
    const off = fail("PROVIDER_OFF");
    const r = evaluate(pay({ compliance: compliance({ asset: off, owner: off, counterparty: off }) }));
    assert.deepEqual([r.ruleId, r.subCode], ["R7", "PROVIDER_OFF"]);
  });
});

describe("daily window", () => {
  it("uses UTC days", () => {
    assert.equal(utcDayStart(new Date("2026-09-30T23:30:00-07:00")).toISOString(), "2026-10-01T00:00:00.000Z");
    assert.equal(utcDayStart(new Date("2026-10-01T06:59:00+07:00")).toISOString(), "2026-09-30T00:00:00.000Z");
  });
});

describe("policy hash document", () => {
  it("omits empty assets so passports anchored before A-Tokens keep their hash", () => {
    assert.deepEqual(Object.keys(policyHashDoc(trading)), ["allowed", "blocked", "scopeApps"]);
    assert.deepEqual(Object.keys(policyHashDoc(payments)), ["allowed", "blocked", "scopeApps", "assets"]);
  });
});

describe("request completeness and owner verification (R4, R11, R12)", () => {
  it("R4 blocks a scoped passport when the app is omitted, instead of skipping the check", () => {
    const r = evaluate(base({ app: null }));
    assert.deepEqual([r.decision, r.ruleId, r.subCode], ["BLOCKED", "R4", "APP_REQUIRED"]);
    const unscoped = evaluate(base({ policy: { ...trading, scopeApps: [] }, app: null }));
    assert.equal(unscoped.ruleId, "R6");
  });

  it("R11 blocks value actions for an owner without passkey verification; reads are unaffected", () => {
    const r = evaluate(base({ ownerVerified: false }));
    assert.deepEqual([r.ruleId, r.subCode], ["R11", "OWNER_UNVERIFIED"]);
    assert.equal(evaluate(base({ ownerVerified: false, action: "read_balances", amountUsdc: null })).ruleId, "R6");
    // R2 still wins for a hard-blocked value action, so the demo climax is unchanged.
    assert.equal(evaluate(base({ ownerVerified: false, action: "withdraw", amountUsdc: 4800 })).ruleId, "R2");
  });

  it("R12 requires a positive amount with at most 6 decimals", () => {
    for (const amountUsdc of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = evaluate(base({ amountUsdc }));
      assert.deepEqual([r.ruleId, r.subCode], ["R12", "AMOUNT_REQUIRED"], `amount ${amountUsdc}`);
    }
    assert.deepEqual([evaluate(base({ amountUsdc: 1.0000001 })).ruleId, evaluate(base({ amountUsdc: 1.0000001 })).subCode], ["R12", "AMOUNT_PRECISION"]);
    assert.equal(evaluate(base({ amountUsdc: 1.000001 })).ruleId, "R6");
  });

  it("R12 requires a valid recipient for transfer and a daily limit on allowed value actions", () => {
    const pay = (over: Partial<EvaluationInput>) =>
      evaluate(base({ policy: { ...payments, assets: [] }, action: "transfer", amountUsdc: 10, app: null, ...over }));
    assert.equal(pay({ to: null }).subCode, "RECIPIENT_REQUIRED");
    assert.equal(pay({ to: "0x1234" }).subCode, "RECIPIENT_INVALID");
    assert.equal(pay({ to: NUSANTARA }).ruleId, "R6");
    const limitless: PolicyDoc = { ...trading, allowed: [{ action: "swap" }] };
    assert.deepEqual([evaluate(base({ policy: limitless })).ruleId, evaluate(base({ policy: limitless })).subCode], ["R12", "LIMIT_REQUIRED"]);
  });

  it("denies unknown actions even if a legacy passport lists them", () => {
    const legacy: PolicyDoc = { ...trading, allowed: [...trading.allowed, { action: "launch_rocket" }] };
    const r = evaluate(base({ policy: legacy, action: "launch_rocket", amountUsdc: null }));
    assert.equal(r.ruleId, "R3");
    assert.match(r.reason, /not an action Fuku knows/);
  });
});

describe("R5 in base units", () => {
  it("is exact at the boundary and prefers the authoritative window", () => {
    const at = (amountUsdc: number, spentTodayMicros: bigint) => evaluate(base({ amountUsdc, spentTodayMicros })).ruleId;
    assert.equal(at(0.000001, BigInt(4_999_999_999)), "R6");
    assert.equal(at(0.000002, BigInt(4_999_999_999)), "R5");
    assert.equal(at(5000, BigInt(0)), "R6");
    // 0.1 + 0.2 style float drift does not leak into the decision.
    assert.equal(evaluate(base({ amountUsdc: 0.3, spentTodayUsdc: 4999.7 })).ruleId, "R6");
  });

  it("toMicros rejects values that are not USDC amounts", () => {
    assert.equal(toMicros(1.5), BigInt(1_500_000));
    assert.equal(toMicros(-1), null);
    assert.equal(toMicros(0.0000001), null);
  });
});
