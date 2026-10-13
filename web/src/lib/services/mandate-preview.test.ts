/**
 * The dry run and the owner's on-chain mandate. Regression for "check said ALLOWED, execution was
 * blocked R10": a dry run no longer answers ALLOWED for an A-Token transfer without saying what it
 * knows about the mandate. The guard's rules are one implementation (lib/chain/mandate-check.ts),
 * shared with execution; an unreadable mandate is UNKNOWN, never ALLOWED. Throwaway SQLite database,
 * mock chain, every external key blanked before any app module loads (see services.test.ts).
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { getAddress, type Address, type Hex } from "viem";

const dir = mkdtempSync(path.join(tmpdir(), "fuku-mandate-test-"));
const SAFE_ENV: Record<string, string> = {
  DATABASE_URL: `file:${path.join(dir, "test.db").replace(/\\/g, "/")}`,
  FUKU_CHAIN_MODE: "mock",
  DEPLOYER_PRIVATE_KEY: "",
  FUKU_COMPLIANCE_SIGNER_KEY: "",
  FUKU_SPEND_GUARD: "",
  NANSEN_API_KEY: "",
  ENVIO_API_TOKEN: "",
  ENVIO_HYPERRPC_TOKEN: "",
  CLEANVERSE_API_ID: "",
  CLEANVERSE_API_KEY: "",
  CLEANVERSE_MODE: "",
  DEMO_OWNER_PRIVATE_KEY: "",
  FUKU_DEMO_ENABLED: "true",
};
Object.assign(process.env, SAFE_ENV);

type MandateState = import("../chain/mandate-check").MandateState;

let db: typeof import("../db").db;
let actions: typeof import("./actions");
let mc: typeof import("../chain/mandate-check");
let seed: typeof import("../demo-seed");
let checkRoute: typeof import("../../app/api/v1/agents/[id]/check/route");

const NUSANTARA = "0x7AD75AD75A52e8d4ee5290294C498917386f40BB" as Address;
const TOKEN = "0x00000000000000000000000000000000000000a7" as Address;
const OWNER = "0x00000000000000000000000000000000000000b0" as Address;
const AGENT_KEY = `0x${"ab".repeat(32)}` as Hex;

before(async () => {
  execSync("npx prisma db push --skip-generate", { cwd: path.resolve(__dirname, "../../.."), env: { ...process.env, ...SAFE_ENV }, stdio: "ignore" });
  db = (await import("../db")).db;
  actions = await import("./actions");
  mc = await import("../chain/mandate-check");
  seed = await import("../demo-seed");
  checkRoute = await import("../../app/api/v1/agents/[id]/check/route");
  await seed.seedDemo(db, { quiet: true });
});

after(async () => {
  await db?.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  (await import("../rate-limit")).resetRateLimits();
});

const state = (over: Partial<MandateState> = {}): MandateState => ({
  active: true,
  token: TOKEN,
  dailyCap: BigInt(100_000_000),
  maxPerTx: BigInt(50_000_000),
  validUntil: BigInt(2_000_000_000),
  restrictPayees: true,
  version: BigInt(3),
  spentToday: BigInt(30_000_000),
  payeeApproved: true,
  blockTimestamp: BigInt(1_800_000_000),
  ...over,
});
const request = (amountUsdc: number, over: Record<string, unknown> = {}) => ({ agentKey: AGENT_KEY, from: OWNER, to: NUSANTARA, token: TOKEN, amount: BigInt(amountUsdc * 1e6), ...over });

describe("evaluateMandate: the guard's _checkMandateAndCap, in its order and with its error names", () => {
  it("allows within the limits and reports what is left today", () => {
    assert.deepEqual(mc.evaluateMandate(state(), request(30)), { ok: true, remaining: BigInt(40_000_000), version: BigInt(3) });
    assert.equal(mc.evaluateMandate(state({ maxPerTx: BigInt(0), restrictPayees: false, payeeApproved: false, validUntil: BigInt(0) }), request(70)).ok, true);
  });

  it("refuses each case the guard refuses", () => {
    const reason = (s: Partial<MandateState>, amount = 30, over: Record<string, unknown> = {}) => {
      const v = mc.evaluateMandate(state(s), request(amount, over));
      return v.ok ? "ok" : v.reason;
    };
    assert.equal(reason({ active: false }), `NoMandate(${AGENT_KEY}, ${getAddress(OWNER)})`);
    assert.match(reason({ token: "0x00000000000000000000000000000000000000c1" }), /^TokenNotMandated\(/);
    assert.equal(reason({ validUntil: BigInt(1_799_999_999) }), "MandateExpired(1799999999)");
    assert.equal(reason({}, 0), "ZeroAmount()");
    assert.equal(reason({}, 30, { to: "0x0000000000000000000000000000000000000000" }), "ZeroRecipient()");
    assert.equal(reason({}, 60), "PerTxLimitExceeded(50000000)");
    assert.equal(reason({ payeeApproved: false }), `PayeeNotApproved(${NUSANTARA})`);
    assert.equal(reason({ spentToday: BigInt(80_000_000) }, 30), "DailyCapExceeded(20000000)");
    assert.equal(reason({ spentToday: BigInt(120_000_000) }, 1), "DailyCapExceeded(0)");
    // Order: the per-transfer limit before the payee, the payee before the cap (as the contract).
    assert.equal(reason({ payeeApproved: false, spentToday: BigInt(100_000_000) }, 60), "PerTxLimitExceeded(50000000)");
    assert.equal(reason({ payeeApproved: false, spentToday: BigInt(100_000_000) }, 10), `PayeeNotApproved(${NUSANTARA})`);
  });
});

describe("the dry run's mandate preview", () => {
  const payments = () => seed.demoAgentIds("v2").payments;
  const assess = async (amountUsdc: number, action = "transfer") => {
    const agent = await db.agent.findUniqueOrThrow({ where: { id: payments() }, include: { policy: true, identity: true } });
    const input = { action, amountUsdc, to: NUSANTARA, asset: "aUSDC" };
    const { evaluation, compliance } = await actions.assessAction(agent, input);
    // In mock mode the simulator's evidence has no token address: give it the one the live chain has.
    const live = compliance ? { ...compliance, evidence: { ...compliance.evidence, atoken: { ...compliance.evidence.atoken, address: TOKEN } } } : null;
    return { agent, input, evaluation, compliance: live };
  };
  const live = (read: () => Promise<MandateState>, ready = true) => ({ mode: "live" as const, ready, read });

  it("a transfer the mandate refuses is BLOCKED R10 with execution's own wording, not ALLOWED", async () => {
    const a = await assess(60);
    assert.equal(a.evaluation.decision, "ALLOWED", "the passport alone allows 60 (1,000 a day)");
    const preview = await actions.previewMandate(a.agent, a.input, a.evaluation, a.compliance, live(async () => state()));
    assert.deepEqual(preview, { status: "rejected", detail: "FukuSpendGuard would refuse it: PerTxLimitExceeded(50000000).", reason: "PerTxLimitExceeded(50000000)" });
    const d = actions.previewDecision(a.evaluation, preview);
    assert.deepEqual([d.decision, d.ruleId, d.subCode], ["BLOCKED", "R10", "GUARD_REJECTED"]);
    assert.equal(d.reason, actions.guardRejection("PerTxLimitExceeded(50000000)").reason, "the same sentence execution records");
  });

  it("an RPC failure is UNKNOWN, never ALLOWED", async () => {
    const a = await assess(30);
    const preview = await actions.previewMandate(
      a.agent,
      a.input,
      a.evaluation,
      a.compliance,
      live(async () => {
        throw new Error("HTTP request failed. Status: 429");
      }),
    );
    assert.equal(preview.status, "unavailable");
    const d = actions.previewDecision(a.evaluation, preview);
    assert.deepEqual([d.decision, d.ruleId, d.subCode], ["UNKNOWN", "R10", "MANDATE_UNAVAILABLE"]);
    assert.match(d.reason, /could not be read \(HTTP request failed\. Status: 429\)/);
    assert.match(d.reason, /do not treat this as allowed/);
  });

  it("ALLOWED only with the mandate checked, and says so", async () => {
    const a = await assess(30);
    const preview = await actions.previewMandate(a.agent, a.input, a.evaluation, a.compliance, live(async () => state()));
    assert.equal(preview.status, "ok");
    const d = actions.previewDecision(a.evaluation, preview);
    assert.equal(d.decision, "ALLOWED");
    assert.match(d.reason, /The owner's on-chain mandate allows it \(v3; 40 left today after it\)\./);
  });

  it("an unapproved payee, a closed mandate and a configuration gap are refused like execution refuses them", async () => {
    const a = await assess(10);
    const run = (read: () => Promise<MandateState>, ready = true) => actions.previewMandate(a.agent, a.input, a.evaluation, a.compliance, live(read, ready));
    assert.equal(((await run(async () => state({ payeeApproved: false }))) as { reason: string }).reason, `PayeeNotApproved(${NUSANTARA})`);
    assert.match(((await run(async () => state({ active: false }))) as { reason: string }).reason, /^NoMandate\(/);
    const notReady = await run(async () => state(), false);
    assert.equal(actions.previewDecision(a.evaluation, notReady).subCode, "GUARD_NOT_CONFIGURED");
  });

  it("nothing to preview when the passport already blocks it", async () => {
    const a = await assess(4800, "withdraw");
    let read = false;
    const preview = await actions.previewMandate(
      a.agent,
      a.input,
      a.evaluation,
      a.compliance,
      live(async () => {
        read = true;
        return state();
      }),
    );
    assert.deepEqual([preview.status, read], ["not_applicable", false]);
    assert.equal(actions.previewDecision(a.evaluation, preview).decision, "BLOCKED");
  });

  it("over the API on a mocked chain: ALLOWED, with the mandate reported as not checked", async () => {
    const id = payments();
    const req = new NextRequest(`http://localhost/api/v1/agents/${id}/check`, {
      method: "POST",
      headers: { authorization: "Bearer fk_live_demo_ava_chen_2026", "content-type": "application/json" },
      body: JSON.stringify({ action: "transfer", amountUsdc: 30, to: NUSANTARA, asset: "aUSDC" }),
    });
    const res = await checkRoute.POST(req, { params: Promise.resolve({ id }) });
    const body = (await res.json()) as { decision: string; allowed: boolean; reason: string; mandate: { status: string } };
    assert.deepEqual([res.status, body.decision, body.allowed, body.mandate.status], [200, "ALLOWED", true, "not_checked"]);
    assert.match(body.reason, /on-chain mandate was not checked: the chain is mocked/);
    const swap = await checkRoute.POST(
      new NextRequest(`http://localhost/api/v1/agents/${id}/check`, {
        method: "POST",
        headers: { authorization: "Bearer fk_live_demo_ava_chen_2026", "content-type": "application/json" },
        body: JSON.stringify({ action: "withdraw", amountUsdc: 1 }),
      }),
      { params: Promise.resolve({ id }) },
    );
    assert.equal(((await swap.json()) as { mandate: { status: string } }).mandate.status, "not_applicable");
  });
});
