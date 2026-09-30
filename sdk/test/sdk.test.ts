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
