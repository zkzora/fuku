import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress } from "viem";
import { deployFukuStack, AGENT_ID, id } from "./fixtures.ts";

const POLICY_HASH = id("policy:v1");
const ACTION_HASH = id("action:transfer:usdc:100");
const DECISION_PROOF = id("proof:decision:1");

describe("PermissionRegistry", async function () {
  const connection = await network.create();
  const { viem } = connection;

  it("setPolicy: only the agent owner controller can set a policy", async function () {
    const { permissionRegistry, alice, bob, owner } = await deployFukuStack(connection);

    // bob controls a different identity
    await viem.assertions.revertWithCustomError(
      permissionRegistry.write.setPolicy([AGENT_ID, POLICY_HASH, 1, "ipfs://policy-v1"], { account: bob.account }),
      permissionRegistry,
      "NotAgentOwner",
    );
    // the contract owner has no special rights over agent policies
    await viem.assertions.revertWithCustomError(
      permissionRegistry.write.setPolicy([AGENT_ID, POLICY_HASH, 1, "ipfs://policy-v1"], { account: owner.account }),
      permissionRegistry,
      "NotAgentOwner",
    );
    // unknown agent
    await viem.assertions.revertWithCustomError(
      permissionRegistry.write.setPolicy([id("agent:missing"), POLICY_HASH, 1, ""], { account: alice.account }),
      permissionRegistry,
      "AgentNotFound",
    );

    await viem.assertions.emitWithArgs(
      permissionRegistry.write.setPolicy([AGENT_ID, POLICY_HASH, 1, "ipfs://policy-v1"], { account: alice.account }),
      permissionRegistry,
      "PolicySet",
      [AGENT_ID, POLICY_HASH, 1, "ipfs://policy-v1"],
    );

    const [policyHash, version, policyURI, active, updatedAt] = await permissionRegistry.read.policies([AGENT_ID]);
    assert.equal(policyHash, POLICY_HASH);
    assert.equal(version, 1);
    assert.equal(policyURI, "ipfs://policy-v1");
    assert.equal(active, true);
    assert.ok(updatedAt > 0n);
    assert.equal(await permissionRegistry.read.hasActivePolicy([AGENT_ID]), true);
  });

  it("revokePolicy: only owner controller; sets active=false and emits PolicyRevoked", async function () {
    const { permissionRegistry, alice, bob } = await deployFukuStack(connection);
    await permissionRegistry.write.setPolicy([AGENT_ID, POLICY_HASH, 1, "ipfs://policy-v1"], { account: alice.account });

    await viem.assertions.revertWithCustomError(
      permissionRegistry.write.revokePolicy([AGENT_ID], { account: bob.account }),
      permissionRegistry,
      "NotAgentOwner",
    );

    await viem.assertions.emitWithArgs(
      permissionRegistry.write.revokePolicy([AGENT_ID], { account: alice.account }),
      permissionRegistry,
      "PolicyRevoked",
      [AGENT_ID],
    );
    const [, , , active] = await permissionRegistry.read.policies([AGENT_ID]);
    assert.equal(active, false);
    assert.equal(await permissionRegistry.read.hasActivePolicy([AGENT_ID]), false);

    await viem.assertions.revertWithCustomError(
      permissionRegistry.write.revokePolicy([AGENT_ID], { account: alice.account }),
      permissionRegistry,
      "NoActivePolicy",
    );
  });

  it("setEnforcer is owner-only", async function () {
    const { permissionRegistry, owner, enforcer, stranger } = await deployFukuStack(connection);
    await viem.assertions.revertWithCustomError(
      permissionRegistry.write.setEnforcer([enforcer.account.address, true], { account: stranger.account }),
      permissionRegistry,
      "NotOwner",
    );
    await viem.assertions.emitWithArgs(
      permissionRegistry.write.setEnforcer([enforcer.account.address, true], { account: owner.account }),
      permissionRegistry,
      "EnforcerSet",
      [getAddress(enforcer.account.address), true],
    );
    assert.equal(await permissionRegistry.read.enforcers([enforcer.account.address]), true);
  });

  it("recordDecision by an enforcer increments counters and emits ActionDecision", async function () {
    const { permissionRegistry, publicClient, owner, enforcer, stranger } = await deployFukuStack(connection);
    await permissionRegistry.write.setEnforcer([enforcer.account.address, true], { account: owner.account });

    // strangers are rejected
    await viem.assertions.revertWithCustomError(
      permissionRegistry.write.recordDecision([AGENT_ID, ACTION_HASH, true, DECISION_PROOF, "rule-1"], {
        account: stranger.account,
      }),
      permissionRegistry,
      "NotAuthorized",
    );

    const txHash = await permissionRegistry.write.recordDecision(
      [AGENT_ID, ACTION_HASH, true, DECISION_PROOF, "rule-1"],
      { account: enforcer.account },
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });

    const events = await permissionRegistry.getEvents.ActionDecision({ agentId: AGENT_ID });
    assert.equal(events.length, 1);
    assert.equal(events[0].args.agentId, AGENT_ID);
    assert.equal(events[0].args.actionHash, ACTION_HASH);
    assert.equal(events[0].args.allowed, true);
    assert.equal(events[0].args.proofHash, DECISION_PROOF);
    assert.equal(events[0].args.ruleId, "rule-1");
    assert.equal(events[0].args.timestamp, block.timestamp);

    let [allowedCount, violationCount] = await permissionRegistry.read.stats([AGENT_ID]);
    assert.equal(allowedCount, 1n);
    assert.equal(violationCount, 0n);

    // a denied decision goes to violationCount
    await viem.assertions.emit(
      permissionRegistry.write.recordDecision([AGENT_ID, id("action:2"), false, id("proof:2"), "rule-deny"], {
        account: enforcer.account,
      }),
      permissionRegistry,
      "ActionDecision",
    );
    [allowedCount, violationCount] = await permissionRegistry.read.stats([AGENT_ID]);
    assert.equal(allowedCount, 1n);
    assert.equal(violationCount, 1n);
  });

  it("recordDecision is also allowed for the agent owner controller, and rejects unknown agents", async function () {
    const { permissionRegistry, alice, enforcer, owner } = await deployFukuStack(connection);

    await permissionRegistry.write.recordDecision([AGENT_ID, ACTION_HASH, true, DECISION_PROOF, "self"], {
      account: alice.account,
    });
    const [allowedCount] = await permissionRegistry.read.stats([AGENT_ID]);
    assert.equal(allowedCount, 1n);

    await permissionRegistry.write.setEnforcer([enforcer.account.address, true], { account: owner.account });
    await viem.assertions.revertWithCustomError(
      permissionRegistry.write.recordDecision([id("agent:missing"), ACTION_HASH, true, DECISION_PROOF, "x"], {
        account: enforcer.account,
      }),
      permissionRegistry,
      "AgentNotFound",
    );
  });
});
