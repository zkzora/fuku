import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptPayload, encryptPayload, encryptedEnvelope } from "./crypto";
import {
  CleanverseBusinessError,
  CleanverseClient,
  CleanverseHttpError,
  CleanverseTimeoutError,
  type CleanverseClientConfig,
} from "./client";
import { classifyPass, classifyVerify } from "./codes";
import { canonicalJson, complianceRefOf } from "./evidence";
import { resolveCleanverse } from "./mode";
import { SimCleanverseProvider, simVerify, type CleanverseProvider, type SimBackend } from "./provider";
import { clearOwnerPassCache, gatherCompliance } from "./compliance";
import type { APassRecord, ATokenRule, ComplianceEvidence } from "./types";

const NOW = 1_800_000_000;
const KEY16 = randomBytes(16).toString("base64");

// --- crypto --------------------------------------------------------------------------------------

describe("cleanverse crypto", () => {
  it("round-trips AES-CBC for 16, 24 and 32 byte keys", () => {
    for (const bytes of [16, 24, 32]) {
      const key = randomBytes(bytes).toString("base64");
      const plain = JSON.stringify({ chain: "monad", address: "0xabc", note: "héllo ✓" });
      const cipher = encryptPayload(plain, key);
      assert.notEqual(cipher, plain);
      assert.equal(decryptPayload(cipher, key), plain);
    }
  });

  it("is deterministic with the fixed zero IV and wraps bodies as { data }", () => {
    const body = { a: 1 };
    assert.equal(encryptPayload(JSON.stringify(body), KEY16), encryptPayload(JSON.stringify(body), KEY16));
    const env = encryptedEnvelope(body, KEY16);
    assert.deepEqual(Object.keys(env), ["data"]);
    assert.equal(decryptPayload(env.data, KEY16), JSON.stringify(body));
  });

  it("rejects keys that are not 16, 24 or 32 bytes", () => {
    assert.throws(() => encryptPayload("x", randomBytes(10).toString("base64")), /16, 24 or 32 bytes/);
  });
});

// --- client --------------------------------------------------------------------------------------

const config: CleanverseClientConfig = { baseUrl: "https://example.test/api/cooperate", apiId: "app-1", apiKey: KEY16, timeoutMs: 200 };

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("cleanverse client", () => {
  it("unwraps a success envelope and sends api-id, request id and JSON", async () => {
    const f = fakeFetch(() => json({ code: "0000", message: "ok", data: { cvRecordId: "cv1" } }));
    const client = new CleanverseClient(config, f.impl);
    const r = await client.post<{ cvRecordId: string }>("query_apass", { chain: "monad", address: "0x1" });
    assert.equal(r.data?.cvRecordId, "cv1");
    assert.equal(f.calls[0].url, "https://example.test/api/cooperate/query_apass");
    const headers = f.calls[0].init.headers as Record<string, string>;
    assert.equal(headers["api-id"], "app-1");
    assert.equal(headers["content-type"], "application/json");
    assert.match(headers["X-Request-ID"], /^[0-9a-f-]{36}$/);
    assert.equal(r.requestId, headers["X-Request-ID"]);
    assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { chain: "monad", address: "0x1" });
  });

  it("encrypts write bodies and decrypts an encrypted data string", async () => {
    const secret = { status: 1, cvRecordId: "cv9" };
    const f = fakeFetch(() => json({ code: "0000", message: "ok", data: encryptPayload(JSON.stringify(secret), KEY16) }));
    const client = new CleanverseClient(config, f.impl);
    const r = await client.post<typeof secret>("generate_apass", { customerId: "c1" }, { encrypted: true });
    assert.deepEqual(r.data, secret);
    const sent = JSON.parse(String(f.calls[0].init.body)) as { data: string };
    assert.deepEqual(JSON.parse(decryptPayload(sent.data, KEY16)), { customerId: "c1" });
  });

  it("throws a business error for a non-0000 code", async () => {
    const f = fakeFetch(() => json({ code: "1001", message: "wallet not found", data: null }));
    const client = new CleanverseClient(config, f.impl);
    await assert.rejects(client.post("query_apass", {}), (e: unknown) => e instanceof CleanverseBusinessError && e.code === "1001");
  });

  it("throws an HTTP error for non-2xx responses and invalid envelopes", async () => {
    const client500 = new CleanverseClient(config, fakeFetch(() => json({ error: "boom" }, 500)).impl);
    await assert.rejects(client500.post("verify_apass", {}), (e: unknown) => e instanceof CleanverseHttpError && e.status === 500);
    const clientBad = new CleanverseClient(config, fakeFetch(() => json({ nope: true })).impl);
    await assert.rejects(clientBad.post("verify_apass", {}), CleanverseHttpError);
  });

  it("times out", async () => {
    const hang = (async (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as typeof fetch;
    const client = new CleanverseClient({ ...config, timeoutMs: 30 }, hang);
    await assert.rejects(client.post("query_apass", {}), CleanverseTimeoutError);
  });
});

// --- codes ---------------------------------------------------------------------------------------

const pass = (over: Partial<APassRecord> = {}): APassRecord => ({
  wallet: "0x0000000000000000000000000000000000000001",
  cvRecordId: "cv-test",
  status: 1,
  tier: 2,
  subTier: 0,
  group: null,
  subGroup: null,
  expiresAt: 0,
  countries: [],
  kycHash: null,
  source: "simulated",
  raw: null,
  ...over,
});

describe("cleanverse codes", () => {
  it("maps verify codes to Fuku sub-codes, using query_apass to disambiguate", () => {
    assert.equal(classifyVerify(4, undefined, NOW), "OK");
    assert.equal(classifyVerify(2, undefined, NOW), "CVI_NOT_FOUND");
    assert.equal(classifyVerify(3, pass({ status: 2 }), NOW), "CVI_FROZEN");
    assert.equal(classifyVerify(3, pass({ expiresAt: NOW - 1 }), NOW), "CVI_EXPIRED");
    assert.equal(classifyVerify(1, pass(), NOW), "CVI_RULE_REJECTED");
    assert.equal(classifyVerify(1, null, NOW), "CVI_NOT_FOUND");
  });

  it("fails closed on unknown codes and unknown statuses", () => {
    assert.equal(classifyVerify(9, undefined, NOW), "PROVIDER_ERROR");
    assert.equal(classifyPass(pass({ status: 7 }), NOW), "PROVIDER_ERROR");
    assert.equal(classifyPass(pass(), NOW), "OK");
    assert.equal(classifyPass(pass({ expiresAt: NOW + 60 }), NOW), "OK");
  });
});

// --- mode ----------------------------------------------------------------------------------------

describe("cleanverse mode", () => {
  it("resolves live, simulated and off", () => {
    const creds = { CLEANVERSE_API_ID: "id", CLEANVERSE_API_KEY: KEY16 };
    const sims = { CLEANVERSE_SIM_APASS: "0x1", CLEANVERSE_SIM_ATOKEN: "0x2" };
    assert.deepEqual(resolveCleanverse({ env: creds, chainLive: true }), { mode: "live", backend: "api" });
    assert.deepEqual(resolveCleanverse({ env: { ...creds, CLEANVERSE_MODE: "sim", ...sims }, chainLive: true }), { mode: "simulated", backend: "sim-chain" });
    assert.deepEqual(resolveCleanverse({ env: {}, chainLive: false }), { mode: "simulated", backend: "sim-fixtures" });
    assert.deepEqual(resolveCleanverse({ env: sims, chainLive: true }), { mode: "simulated", backend: "sim-chain" });
    assert.deepEqual(resolveCleanverse({ env: {}, chainLive: true }), { mode: "off", backend: null });
    assert.deepEqual(resolveCleanverse({ env: { ...creds, CLEANVERSE_MODE: "off" }, chainLive: true }), { mode: "off", backend: null });
  });
});

// --- evidence ------------------------------------------------------------------------------------

describe("cleanverse evidence", () => {
  it("canonical JSON ignores key order and complianceRef is stable", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }), canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
    const e1: ComplianceEvidence = {
      provider: "cleanverse",
      mode: "simulated",
      chain: "monad",
      atoken: { symbol: "aUSDC", address: "0xa", rule: null },
      owner: { wallet: "0xo", cvRecordId: "cv", status: 1, tier: 2, subTier: 0, expiresAt: 0, verifyCode: 4 },
      counterparty: { wallet: "0xc", verifyCode: 4, message: "ok" },
      checkedAt: "2026-09-30T00:00:00.000Z",
      requestIds: [],
    };
    const e2 = JSON.parse(JSON.stringify({ requestIds: [], checkedAt: e1.checkedAt, counterparty: e1.counterparty, owner: e1.owner, atoken: e1.atoken, chain: "monad", mode: "simulated", provider: "cleanverse" }));
    assert.equal(complianceRefOf(e1), complianceRefOf(e2));
    assert.notEqual(complianceRefOf(e1), complianceRefOf({ ...e1, chain: "other" }));
  });
});

// --- simulator + gatherCompliance -----------------------------------------------------------------

const ATOKEN = "0x00000000000000000000000000000000000a05dc";
const OWNER = "0x1111111111111111111111111111111111111111";
const NUSANTARA = "0x2222222222222222222222222222222222222222";
const FROZEN = "0x3333333333333333333333333333333333333333";
const UNVERIFIED = "0x4444444444444444444444444444444444444444";
const RULE: ATokenRule = { allowedGroup: null, allowedSubGroup: null, minTier: 1, minSubTier: 0, blacklist: null, countries: null };

function fixtureBackend(passes: Record<string, APassRecord>): SimBackend {
  return {
    kind: "sim-fixtures",
    asset: () => ({ symbol: "aUSDC-SIM", address: ATOKEN, decimals: 6, source: "simulated" }),
    getPass: async (w) => passes[w.toLowerCase()] ?? null,
    getRule: async () => RULE,
  };
}

const passes = {
  [OWNER]: pass({ wallet: OWNER, cvRecordId: "cv-ava" }),
  [NUSANTARA]: pass({ wallet: NUSANTARA, cvRecordId: "cv-nusantara" }),
  [FROZEN]: pass({ wallet: FROZEN, cvRecordId: "cv-frozen", status: 2 }),
};

const base = {
  mode: "simulated" as const,
  chain: "monad",
  action: "transfer",
  assetSymbol: "aUSDC",
  passportAssets: ["aUSDC"],
  ownerWallet: OWNER,
  nowSec: NOW,
};

describe("gatherCompliance", () => {
  beforeEach(() => clearOwnerPassCache());
  const provider = () => new SimCleanverseProvider(fixtureBackend(passes), "monad", () => NOW);

  it("passes all three legs for a verified owner paying a verified recipient", async () => {
    const r = await gatherCompliance({ ...base, provider: provider(), counterparty: NUSANTARA });
    assert.deepEqual([r.asset.ok, r.owner.ok, r.counterparty.ok], [true, true, true]);
    assert.equal(r.evidence.owner.verifyCode, 4);
    assert.equal(r.evidence.counterparty.verifyCode, 4);
    assert.equal(r.evidence.atoken.address, ATOKEN);
    assert.match(r.complianceRef, /^0x[0-9a-f]{64}$/);
  });

  it("R8: rejects an unverified recipient (CVI_NOT_FOUND) and a frozen one (CVI_FROZEN)", async () => {
    const u = await gatherCompliance({ ...base, provider: provider(), counterparty: UNVERIFIED });
    assert.equal(u.counterparty.subCode, "CVI_NOT_FOUND");
    const f = await gatherCompliance({ ...base, provider: provider(), counterparty: FROZEN });
    assert.equal(f.counterparty.subCode, "CVI_FROZEN");
    const bad = await gatherCompliance({ ...base, provider: provider(), counterparty: "not-an-address" });
    assert.equal(bad.counterparty.ok, false);
  });

  it("R7: owner without wallet, without A-Pass, frozen and expired", async () => {
    assert.equal((await gatherCompliance({ ...base, provider: provider(), ownerWallet: null, counterparty: NUSANTARA })).owner.subCode, "CVI_NO_WALLET");
    assert.equal((await gatherCompliance({ ...base, provider: provider(), ownerWallet: UNVERIFIED, counterparty: NUSANTARA })).owner.subCode, "CVI_NOT_FOUND");
    const expired = new SimCleanverseProvider(fixtureBackend({ ...passes, [OWNER]: pass({ wallet: OWNER, expiresAt: NOW - 10 }) }), "monad", () => NOW);
    assert.equal((await gatherCompliance({ ...base, provider: expired, counterparty: NUSANTARA })).owner.subCode, "CVI_EXPIRED");
    clearOwnerPassCache();
    const frozen = new SimCleanverseProvider(fixtureBackend({ ...passes, [OWNER]: pass({ wallet: OWNER, status: 2 }) }), "monad", () => NOW);
    assert.equal((await gatherCompliance({ ...base, provider: frozen, counterparty: NUSANTARA })).owner.subCode, "CVI_FROZEN");
  });

  it("R9: only transfer, only listed assets, only resolvable A-Tokens", async () => {
    assert.equal((await gatherCompliance({ ...base, provider: provider(), action: "swap", counterparty: NUSANTARA })).asset.subCode, "CVA_NOT_ALLOWED");
    assert.equal((await gatherCompliance({ ...base, provider: provider(), passportAssets: [], counterparty: NUSANTARA })).asset.subCode, "CVA_NOT_ALLOWED");
    const r = await gatherCompliance({ ...base, provider: provider(), assetSymbol: "USDT", passportAssets: ["USDT"], counterparty: NUSANTARA });
    assert.equal(r.asset.subCode, "CVA_NOT_ALLOWED");
    assert.equal(r.owner.ok, false);
    assert.equal(r.counterparty.ok, false);
  });

  it("fails closed: provider errors block every leg they touch, and mode off blocks all", async () => {
    const broken: CleanverseProvider = {
      backend: "api",
      chain: "monad",
      getAPass: async () => {
        throw new Error("timeout");
      },
      verifyAPass: async () => {
        throw new Error("timeout");
      },
      getRule: async () => ({ rule: RULE, requestId: "r1" }),
      resolveAsset: async () => ({ symbol: "aUSDC", address: ATOKEN, decimals: 6, source: "cleanverse" }),
    };
    const r = await gatherCompliance({ ...base, mode: "live", provider: broken, counterparty: NUSANTARA });
    assert.equal(r.asset.ok, true);
    assert.equal(r.owner.subCode, "PROVIDER_ERROR");
    assert.equal(r.counterparty.subCode, "PROVIDER_ERROR");
    const off = await gatherCompliance({ ...base, mode: "off", provider: null, counterparty: NUSANTARA });
    assert.deepEqual([off.asset.subCode, off.owner.subCode, off.counterparty.subCode], ["PROVIDER_OFF", "PROVIDER_OFF", "PROVIDER_OFF"]);
  });

  it("reports every A-Pass read for persistence", async () => {
    const seen: string[] = [];
    await gatherCompliance({ ...base, provider: provider(), counterparty: FROZEN, onPassRead: (w) => void seen.push(w.toLowerCase()) });
    assert.deepEqual(seen.sort(), [FROZEN, OWNER].sort());
  });
});

describe("simVerify", () => {
  it("mirrors the simulator contract codes", () => {
    assert.equal(simVerify(null, RULE, NOW), 2);
    assert.equal(simVerify(pass({ status: 2 }), RULE, NOW), 3);
    assert.equal(simVerify(pass({ expiresAt: NOW }), RULE, NOW), 3);
    assert.equal(simVerify(pass({ tier: 0 }), RULE, NOW), 1);
    assert.equal(simVerify(pass({ group: "EU" }), { ...RULE, allowedGroup: "SG" }, NOW), 1);
    assert.equal(simVerify(pass({ tier: 1, subTier: 0 }), { ...RULE, minSubTier: 1 }, NOW), 1);
    assert.equal(simVerify(pass(), RULE, NOW), 4);
  });
});
