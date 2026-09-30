import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress } from "viem";
import { deployFukuStack, AGENT_ID, ALICE_ID, BOB_ID, CAPABILITIES_HASH, id } from "./fixtures.ts";

describe("AgentRegistry", async function () {
  const connection = await network.create();
  const { viem } = connection;

  it("registers an agent for the caller's own identity and emits AgentRegistered", async function () {
    const { agentRegistry, alice } = await deployFukuStack(connection);
    const newAgent = id("agent:alice-second");

    await viem.assertions.emitWithArgs(
      agentRegistry.write.registerAgent(
        [newAgent, ALICE_ID, "Second", "0.1.0", CAPABILITIES_HASH, "ipfs://second"],
        { account: alice.account },
      ),
      agentRegistry,
      "AgentRegistered",
      [newAgent, ALICE_ID, "Second", CAPABILITIES_HASH],
    );

    const [ownerIdentityId, name, version, capabilitiesHash, metadataURI, status, registeredAt] =
      await agentRegistry.read.agents([newAgent]);
    assert.equal(ownerIdentityId, ALICE_ID);
    assert.equal(name, "Second");
    assert.equal(version, "0.1.0");
    assert.equal(capabilitiesHash, CAPABILITIES_HASH);
    assert.equal(metadataURI, "ipfs://second");
    assert.equal(status, 0); // Registered
    assert.ok(registeredAt > 0n);

    assert.equal(await agentRegistry.read.ownerOf([newAgent]), ALICE_ID);
    assert.equal(await agentRegistry.read.exists([newAgent]), true);
    assert.equal(await agentRegistry.read.isOwnerController([newAgent, alice.account.address]), true);
  });

  it("rejects registration when the caller is not the identity controller", async function () {
    const { agentRegistry, bob, stranger } = await deployFukuStack(connection);

    // bob controls BOB_ID, not ALICE_ID
    await viem.assertions.revertWithCustomErrorWithArgs(
      agentRegistry.write.registerAgent(
        [id("agent:x"), ALICE_ID, "X", "1", CAPABILITIES_HASH, ""],
        { account: bob.account },
      ),
      agentRegistry,
      "NotIdentityController",
      [ALICE_ID, getAddress(bob.account.address)],
    );

    // an identity that was never registered has no controller at all
    await viem.assertions.revertWithCustomError(
      agentRegistry.write.registerAgent(
        [id("agent:y"), id("identity:ghost"), "Y", "1", CAPABILITIES_HASH, ""],
        { account: stranger.account },
      ),
      agentRegistry,
      "NotIdentityController",
    );
  });

  it("rejects a duplicate agentId", async function () {
    const { agentRegistry, alice, bob } = await deployFukuStack(connection);
    await viem.assertions.revertWithCustomError(
      agentRegistry.write.registerAgent(
        [AGENT_ID, ALICE_ID, "dup", "1", CAPABILITIES_HASH, ""],
        { account: alice.account },
      ),
      agentRegistry,
      "AgentAlreadyExists",
    );
    await viem.assertions.revertWithCustomError(
      agentRegistry.write.registerAgent(
        [AGENT_ID, BOB_ID, "dup", "1", CAPABILITIES_HASH, ""],
        { account: bob.account },
      ),
      agentRegistry,
      "AgentAlreadyExists",
    );
  });

  it("only the owner identity controller can change status, and status must be valid", async function () {
    const { agentRegistry, alice, bob } = await deployFukuStack(connection);

    await viem.assertions.revertWithCustomError(
      agentRegistry.write.setStatus([AGENT_ID, 1], { account: bob.account }),
      agentRegistry,
      "NotIdentityController",
    );
    await viem.assertions.revertWithCustomError(
      agentRegistry.write.setStatus([AGENT_ID, 4], { account: alice.account }),
      agentRegistry,
      "InvalidStatus",
    );
    await viem.assertions.revertWithCustomError(
      agentRegistry.write.setStatus([id("agent:missing"), 1], { account: alice.account }),
      agentRegistry,
      "AgentNotFound",
    );

    await viem.assertions.emitWithArgs(
      agentRegistry.write.setStatus([AGENT_ID, 1], { account: alice.account }),
      agentRegistry,
      "AgentStatusChanged",
      [AGENT_ID, 1],
    );
    const [, , , , , status] = await agentRegistry.read.agents([AGENT_ID]);
    assert.equal(status, 1); // Active

    await agentRegistry.write.setStatus([AGENT_ID, 3], { account: alice.account });
    const [, , , , , revoked] = await agentRegistry.read.agents([AGENT_ID]);
    assert.equal(revoked, 3);
  });

  it("isOwnerController is false for unknown agents and non-controllers", async function () {
    const { agentRegistry, bob } = await deployFukuStack(connection);
    assert.equal(await agentRegistry.read.isOwnerController([AGENT_ID, bob.account.address]), false);
    assert.equal(await agentRegistry.read.isOwnerController([id("agent:missing"), bob.account.address]), false);
    assert.equal(await agentRegistry.read.exists([id("agent:missing")]), false);
  });
});
