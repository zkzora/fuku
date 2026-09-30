import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type Log } from "viem";
import { custodyFor } from "./custody";
import { DEMO_IDENTITY_ID } from "./demo-mode";
import { verifyOwnerEvent } from "./services/owner-actions";
import { AgentRegistryAbi, HumanIdentityRegistryAbi, PermissionRegistryAbi } from "./chain/abi";

describe("custody", () => {
  it("keeps the seeded demo custodial and gives wallet-bound identities to their owner", () => {
    assert.equal(custodyFor({ id: DEMO_IDENTITY_ID, walletVerifiedBy: "signature", walletAddress: "0x1" }), "relayer");
    assert.equal(custodyFor({ id: "fuku:id:1", walletVerifiedBy: "signature", walletAddress: "0x1" }), "owner");
    assert.equal(custodyFor({ id: "fuku:id:1", walletVerifiedBy: "dynamic", walletAddress: "0x1" }), "owner");
    assert.equal(custodyFor({ id: "fuku:id:1", walletVerifiedBy: null, walletAddress: "0x1" }), "relayer", "a declared wallet is not enough");
    assert.equal(custodyFor({ id: "fuku:id:1" }), "relayer");
  });

  it("never changes a recorded custody", () => {
    assert.equal(custodyFor({ id: "fuku:id:1", walletVerifiedBy: "signature", walletAddress: "0x1", chainCustody: "relayer" }), "relayer");
    assert.equal(custodyFor({ id: "fuku:id:1", chainCustody: "owner" }), "owner");
  });
});

const REG = {
  identity: "0x1111111111111111111111111111111111111111" as Address,
  agents: "0x2222222222222222222222222222222222222222" as Address,
  permissions: "0x3333333333333333333333333333333333333333" as Address,
};
const OWNER = "0x7ad75ad75a52e8d4ee5290294c498917386f40bb" as Address;
const RELAYER = "0x248a9aca0146b0112f102455fbc11b45338fd3de" as Address;
const ID = ("0x" + "aa".repeat(32)) as Hex;
const AGENT = ("0x" + "bb".repeat(32)) as Hex;
const HASH = ("0x" + "cc".repeat(32)) as Hex;

const log = (address: Address, topics: Hex[], data: Hex, logIndex = 3) => ({ address, topics, data, logIndex }) as unknown as Log;
const identityRegistered = (controller: Address) =>
  log(REG.identity, encodeEventTopics({ abi: HumanIdentityRegistryAbi, eventName: "IdentityRegistered", args: { identityId: ID, controller } }) as Hex[], encodeAbiParameters([{ type: "bytes32" }], [HASH]));

describe("owner transaction confirmation", () => {
  const expected = { op: "registerIdentity" as const, identityKey: ID, wallet: OWNER };

  it("accepts the owner's registerIdentity with the owner as controller", () => {
    const r = verifyOwnerEvent({ from: OWNER, to: REG.identity, status: "success", logs: [identityRegistered(OWNER)] }, expected, REG);
    assert.deepEqual(r, { ok: true, logIndex: 3 });
  });

  it("rejects a transaction sent by anyone else, to another contract, reverted, or with another controller", () => {
    assert.equal(verifyOwnerEvent({ from: RELAYER, to: REG.identity, status: "success", logs: [identityRegistered(RELAYER)] }, expected, REG).ok, false);
    assert.equal(verifyOwnerEvent({ from: OWNER, to: REG.agents, status: "success", logs: [identityRegistered(OWNER)] }, expected, REG).ok, false);
    assert.equal(verifyOwnerEvent({ from: OWNER, to: REG.identity, status: "reverted", logs: [] }, expected, REG).ok, false);
    assert.equal(verifyOwnerEvent({ from: OWNER, to: REG.identity, status: "success", logs: [identityRegistered(RELAYER)] }, expected, REG).ok, false);
  });

  it("checks the passport hash and version of setPolicy, and the agent of registerAgent", () => {
    const policySet = log(
      REG.permissions,
      encodeEventTopics({ abi: PermissionRegistryAbi, eventName: "PolicySet", args: { agentId: AGENT } }) as Hex[],
      encodeAbiParameters([{ type: "bytes32" }, { type: "uint32" }, { type: "string" }], [HASH, 2, "fuku://x"]),
    );
    const base = { op: "setPolicy" as const, identityKey: ID, agentKey: AGENT, wallet: OWNER };
    assert.equal(verifyOwnerEvent({ from: OWNER, to: REG.permissions, status: "success", logs: [policySet] }, { ...base, policyHash: HASH, policyVersion: 2 }, REG).ok, true);
    assert.equal(verifyOwnerEvent({ from: OWNER, to: REG.permissions, status: "success", logs: [policySet] }, { ...base, policyHash: HASH, policyVersion: 3 }, REG).ok, false);
    const registered = log(
      REG.agents,
      encodeEventTopics({ abi: AgentRegistryAbi, eventName: "AgentRegistered", args: { agentId: AGENT, ownerIdentityId: ID } }) as Hex[],
      encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], ["Agent", HASH]),
    );
    assert.equal(verifyOwnerEvent({ from: OWNER, to: REG.agents, status: "success", logs: [registered] }, { op: "registerAgent", identityKey: ID, agentKey: AGENT, wallet: OWNER }, REG).ok, true);
    assert.equal(
      verifyOwnerEvent({ from: OWNER, to: REG.agents, status: "success", logs: [registered] }, { op: "registerAgent", identityKey: ("0x" + "dd".repeat(32)) as Hex, agentKey: AGENT, wallet: OWNER }, REG).ok,
      false,
    );
  });
});
