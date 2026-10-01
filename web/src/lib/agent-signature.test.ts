import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { agentRequestMessage as sdkMessage } from "../../../sdk/src/index";
import { AGENT_SIGNATURE_WINDOW_S, agentRequestMessage, executePath, verifyAgentRequest } from "./agent-signature";
import { RequestError } from "./errors";

const key = privateKeyToAccount(generatePrivateKey());
const agent = { id: "fuku:agent:0x00000000000000000000000000000000000000c1", name: "MCP Assistant", agentWallet: key.address, agentKey: null };
const body = JSON.stringify({ action: "transfer", amountUsdc: 30, to: "0x7ad75ad75a52e8d4ee5290294c498917386f40bb", asset: "aUSDC" });
const now = 1_790_000_000;

async function sign(over: Partial<{ body: string; idempotencyKey: string; issuedAt: number; signer: typeof key }> = {}) {
  const issuedAt = over.issuedAt ?? now;
  const message = agentRequestMessage({
    agentId: agent.id,
    method: "POST",
    path: executePath(agent.id),
    idempotencyKey: over.idempotencyKey ?? "key-12345678",
    issuedAt,
    body: over.body ?? body,
  });
  return { signature: await (over.signer ?? key).signMessage({ message }), issuedAt: String(issuedAt) };
}

const rejectsWith = (code: string) => (err: unknown) => err instanceof RequestError && err.code === code;

describe("agent-signed requests", () => {
  it("builds the same message as @fuku/sdk", () => {
    const r = { agentId: agent.id, method: "POST", path: executePath(agent.id), idempotencyKey: "k-12345678", issuedAt: now, body };
    assert.equal(agentRequestMessage(r), sdkMessage(r));
  });

  it("accepts a request signed by the agent's own key, and returns the signer", async () => {
    const s = await sign();
    const out = await verifyAgentRequest(agent, { body, ...s }, "key-12345678", now);
    assert.equal(out?.signer, key.address);
  });

  it("requires a signature when the agent holds its own key; not for a Fuku-held or keyless agent", async () => {
    await assert.rejects(() => verifyAgentRequest(agent, { body, signature: null, issuedAt: null }, "key-12345678", now), rejectsWith("agent_signature_required"));
    assert.equal(await verifyAgentRequest({ ...agent, agentKey: "sealed" }, { body, signature: null, issuedAt: null }, null, now), null);
    assert.equal(await verifyAgentRequest({ ...agent, agentWallet: null }, { body, signature: null, issuedAt: null }, null, now), null);
  });

  it("refuses another key, a changed body or key, an old signature and a missing idempotency key", async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    await assert.rejects(async () => verifyAgentRequest(agent, { body, ...(await sign({ signer: other })) }, "key-12345678", now), rejectsWith("agent_signature_invalid"));
    const s = await sign();
    const raised = body.replace("30", "3000");
    await assert.rejects(() => verifyAgentRequest(agent, { body: raised, ...s }, "key-12345678", now), rejectsWith("agent_signature_invalid"));
    await assert.rejects(() => verifyAgentRequest(agent, { body, ...s }, "key-other-123", now), rejectsWith("agent_signature_invalid"));
    await assert.rejects(() => verifyAgentRequest(agent, { body, ...s }, "key-12345678", now + AGENT_SIGNATURE_WINDOW_S + 1), rejectsWith("agent_signature_expired"));
    await assert.rejects(() => verifyAgentRequest(agent, { body, ...s }, null, now), rejectsWith("invalid_request"));
    await assert.rejects(() => verifyAgentRequest({ ...agent, agentWallet: null }, { body, ...s }, "key-12345678", now), rejectsWith("agent_signature_unexpected"));
  });
});
