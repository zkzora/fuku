import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Fuku, FukuError } from "../src/index";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(status: number, payload: unknown, calls: Call[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("@fuku/sdk (against a fake HTTP server)", () => {
  it("sends to/asset on executeAction and returns blocked results (403) instead of throwing", async () => {
    const calls: Call[] = [];
    const fuku = new Fuku({ apiKey: "fk_test", baseUrl: "http://fuku.test/", fetch: fakeFetch(403, { decision: "BLOCKED", ruleId: "R8", subCode: "CVI_FROZEN" }, calls) });
    const r = await fuku.executeAction("fuku:agent:1", { action: "transfer", amountUsdc: 250, to: "0xabc", asset: "aUSDC" });
    assert.equal(r.ruleId, "R8");
    assert.equal(r.subCode, "CVI_FROZEN");
    assert.equal(calls[0].url, "http://fuku.test/api/v1/agents/fuku%3Aagent%3A1/execute");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].headers.authorization, "Bearer fk_test");
    assert.deepEqual(calls[0].body, { action: "transfer", amountUsdc: 250, to: "0xabc", asset: "aUSDC" });
  });

  it("raises FukuError with the body for other failures (e.g. 502 chain write failed)", async () => {
    const fuku = new Fuku({ apiKey: "fk_test", fetch: fakeFetch(502, { error: "guardedTransfer failed on-chain: timeout", chain: { op: "guardedTransfer" } }, []) });
    await assert.rejects(
      () => fuku.executeAction("a", { action: "transfer", amountUsdc: 1, to: "0x1", asset: "aUSDC" }),
      (err: unknown) => err instanceof FukuError && err.status === 502 && /guardedTransfer/.test(err.message),
    );
  });

  it("passes to/asset to checkPermission and tolerates 404 on verifyAgent", async () => {
    const calls: Call[] = [];
    const fuku = new Fuku({ apiKey: "fk_test", fetch: fakeFetch(404, { verified: false, error: "Agent not found" }, calls) });
    const v = await fuku.verifyAgent("missing");
    assert.equal(v.verified, false);
    const check = new Fuku({ apiKey: "fk_test", fetch: fakeFetch(200, { allowed: true, compliance: null }, calls) });
    await check.checkPermission("a", { action: "transfer", amountUsdc: 5, to: "0x2", asset: "aUSDC" });
    assert.deepEqual(calls[1].body, { action: "transfer", amountUsdc: 5, to: "0x2", asset: "aUSDC" });
  });

  it("requires an API key", () => {
    assert.throws(() => new Fuku({ apiKey: "" }), /apiKey is required/);
  });
});

describe("@fuku/sdk 0.3.0 surfaces", () => {
  it("sends the Idempotency-Key header and reads replayed results", async () => {
    const calls: Call[] = [];
    const fuku = new Fuku({ apiKey: "fk_test", fetch: fakeFetch(200, { id: "a1", status: "CONFIRMED", replayed: true }, calls) });
    const r = await fuku.executeAction("agent", { action: "transfer", amountUsdc: 1, to: "0x1", asset: "aUSDC" }, { idempotencyKey: "key-12345678" });
    assert.equal(calls[0].headers["idempotency-key"], "key-12345678");
    assert.equal(r.replayed, true);
    assert.equal(r.status, "CONFIRMED");
  });

  it("exposes structured error codes", async () => {
    const fuku = new Fuku({ apiKey: "fk_test", fetch: fakeFetch(403, { error: "Not authorized", code: "forbidden" }, []) });
    await assert.rejects(() => fuku.registerAgent({ name: "x", capabilities: ["swap"], ownerIdentityId: "someone-else" }), (e: unknown) => e instanceof FukuError && e.code === "forbidden" && e.status === 403);
    const idem = new Fuku({ apiKey: "fk_test", fetch: fakeFetch(422, { error: "different request", code: "idempotency_mismatch" }, []) });
    await assert.rejects(() => idem.executeAction("a", { action: "swap", amountUsdc: 1 }, { idempotencyKey: "k-12345678" }), (e: unknown) => e instanceof FukuError && e.code === "idempotency_mismatch");
  });

  it("reads action receipts and mandates", async () => {
    const calls: Call[] = [];
    const fuku = new Fuku({ apiKey: "fk_test", baseUrl: "http://fuku.test", fetch: fakeFetch(200, { id: "act_1", status: "CONFIRMED", receipt: { logIndex: 2 } }, calls) });
    const a = await fuku.getAction("act_1");
    assert.equal(a.receipt.logIndex, 2);
    await fuku.getMandate("fuku:agent:1");
    assert.equal(calls[0].url, "http://fuku.test/api/v1/actions/act_1");
    assert.equal(calls[1].url, "http://fuku.test/api/v1/agents/fuku%3Aagent%3A1/mandate");
  });

  it("makes idempotency keys", () => {
    const a = Fuku.newIdempotencyKey();
    assert.ok(a.length >= 16);
    assert.notEqual(a, Fuku.newIdempotencyKey());
  });
});
