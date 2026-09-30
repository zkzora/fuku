import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress } from "viem";
import { deployFukuStack, AGENT_ID, id } from "./fixtures.ts";

const REASON_HASH = id("reason:completed-task");

describe("ReputationRegistry", async function () {
  const connection = await network.create();
  const { viem } = connection;

  it("setScorer is owner-only", async function () {
    const { reputationRegistry, owner, scorer, stranger } = await deployFukuStack(connection);
    await viem.assertions.revertWithCustomError(
      reputationRegistry.write.setScorer([scorer.account.address, true], { account: stranger.account }),
      reputationRegistry,
      "NotOwner",
    );
    await viem.assertions.emitWithArgs(
      reputationRegistry.write.setScorer([scorer.account.address, true], { account: owner.account }),
      reputationRegistry,
      "ScorerSet",
      [getAddress(scorer.account.address), true],
    );
    assert.equal(await reputationRegistry.read.scorers([scorer.account.address]), true);
  });

  it("updateScore is scorer-only (even the owner and the agent owner are rejected)", async function () {
    const { reputationRegistry, owner, alice, stranger } = await deployFukuStack(connection);
    for (const who of [owner, alice, stranger]) {
      await viem.assertions.revertWithCustomErrorWithArgs(
        reputationRegistry.write.updateScore([AGENT_ID, 50, 0, REASON_HASH, "no"], { account: who.account }),
        reputationRegistry,
        "NotScorer",
        [getAddress(who.account.address)],
      );
    }
    const [, , exists] = await reputationRegistry.read.getScore([AGENT_ID]);
    assert.equal(exists, false);
  });

  it("updateScore enforces the 0-100 bound and rejects unknown agents", async function () {
    const { reputationRegistry, owner, scorer } = await deployFukuStack(connection);
    await reputationRegistry.write.setScorer([scorer.account.address, true], { account: owner.account });

    await viem.assertions.revertWithCustomErrorWithArgs(
      reputationRegistry.write.updateScore([AGENT_ID, 101, 1, REASON_HASH, "too high"], { account: scorer.account }),
      reputationRegistry,
      "ScoreOutOfBounds",
      [101],
    );
    await viem.assertions.revertWithCustomError(
      reputationRegistry.write.updateScore([id("agent:missing"), 10, 10, REASON_HASH, "?"], { account: scorer.account }),
      reputationRegistry,
      "AgentNotFound",
    );

    // boundaries are inclusive
    await reputationRegistry.write.updateScore([AGENT_ID, 100, 100, REASON_HASH, "max"], { account: scorer.account });
    let [score] = await reputationRegistry.read.getScore([AGENT_ID]);
    assert.equal(score, 100);
    await reputationRegistry.write.updateScore([AGENT_ID, 0, -100, REASON_HASH, "min"], { account: scorer.account });
    [score] = await reputationRegistry.read.getScore([AGENT_ID]);
    assert.equal(score, 0);
  });

  it("updateScore stores the latest score and emits ScoreUpdated with a block timestamp", async function () {
    const { reputationRegistry, publicClient, owner, scorer } = await deployFukuStack(connection);
    await reputationRegistry.write.setScorer([scorer.account.address, true], { account: owner.account });

    const txHash = await reputationRegistry.write.updateScore(
      [AGENT_ID, 72, -3, REASON_HASH, "missed a deadline"],
      { account: scorer.account },
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });

    const [score, updatedAt, exists] = await reputationRegistry.read.getScore([AGENT_ID]);
    assert.equal(score, 72);
    assert.equal(updatedAt, block.timestamp);
    assert.equal(exists, true);

    const events = await reputationRegistry.getEvents.ScoreUpdated({ agentId: AGENT_ID });
    assert.equal(events.length, 1);
    assert.equal(events[0].args.newScore, 72);
    assert.equal(events[0].args.delta, -3);
    assert.equal(events[0].args.reasonHash, REASON_HASH);
    assert.equal(events[0].args.reason, "missed a deadline");
    assert.equal(events[0].args.timestamp, block.timestamp);

    // a second update replaces the stored value
    await reputationRegistry.write.updateScore([AGENT_ID, 80, 8, id("reason:recovered"), "recovered"], {
      account: scorer.account,
    });
    const [latest] = await reputationRegistry.read.getScore([AGENT_ID]);
    assert.equal(latest, 80);
  });
});
