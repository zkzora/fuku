import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate, utcDayStart, type EvaluationInput } from "./permission";
import { policyHashDoc, type PolicyDoc } from "./policy";
import { fail, pass } from "../cleanverse/codes";
import type { ComplianceLeg, ComplianceResult } from "../cleanverse/types";

const trading: PolicyDoc = {
  allowed: [{ action: "swap", limitUsdcPerDay: 5000 }, { action: "read_balances" }, { action: "price_feeds" }],
  blocked: ["withdraw", "change_owner", "transfer"],
  scopeApps: ["Monad DEX"],
  assets: [],
};

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
    base({ policy: payments, action: "transfer", amountUsdc: 250, app: null, compliance: compliance(), ...over });

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
