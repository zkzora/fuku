import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, maxUint256 } from "viem";
import {
  deployCleanverseStack,
  activePass,
  AGENT_ID,
  ATOKEN_RULE,
  BOB_ID,
  CAPABILITIES_HASH,
  DAILY_CAP,
  MINT_AMOUNT,
  ONE_TOKEN,
  POLICY_HASH,
  id,
  type GuardedTransfer,
} from "./fixtures.ts";

/**
 * Direct FukuSpendGuard calls with the Fuku server as the attacker. The server holds the compliance
 * signer key (it can sign any GuardedTransfer), relays transactions, and is a PermissionRegistry
 * enforcer and ReputationRegistry scorer. The claims under test:
 *  - it moves nothing outside what the owner's own wallet authorised on-chain (mandate and allowance)
 *    for a live agent whose active on-chain passport matches the attestation;
 *  - its registry roles never reach the owner's switches (passport, agent status, mandate, payees);
 *  - revokePolicy and closeMandate are final for attestations issued before them, while a pause and a
 *    withdrawn allowance are temporary stops;
 *  - token eligibility (the A-Pass) is independent of the trust score.
 * The one property that rests on the server is pinned explicitly: the guard compares only the policy
 * hash, so Fuku's anchored hash commits to the passport version (web: policyAnchorHash).
 */

type CleanverseStack = Awaited<ReturnType<typeof deployCleanverseStack>>;

/** aToken balances of alice, bob, carol and stranger, in that order. */
async function balancesOf({ atoken, alice, bob, carol, stranger }: CleanverseStack): Promise<bigint[]> {
  return Promise.all([alice, bob, carol, stranger].map((w) => atoken.read.balanceOf([w.account.address])));
}

describe("FukuSpendGuard: adversarial (the server as attacker)", async function () {
  const connection = await network.create();
  const { viem } = connection;
  const { time } = connection.networkHelpers;

  it("a leaked compliance key moves nothing outside the owner's mandate, and at most the daily cap inside it", async function () {
    const stack = await deployCleanverseStack(connection);
    const { viem: v, guard, apass, atoken, agentRegistry, permissionRegistry, signed, alice, bob } = stack;

    // bob holds tokens, has an A-Pass and approved the guard without limit, but mandated nothing
    await atoken.write.mint([bob.account.address, MINT_AMOUNT]);
    await atoken.write.approve([guard.address, maxUint256], { account: bob.account });
    // alice holds and approved a second A-Token that she never mandated
    const other = await v.deployContract("CleanverseATokenSim", [apass.address, ATOKEN_RULE]);
    await other.write.mint([alice.account.address, MINT_AMOUNT]);
    await other.write.approve([guard.address, maxUint256], { account: alice.account });
    // an agent of bob's own (live, active passport) that alice never mandated
    const bobAgent = id("agent:bob-assistant");
    await agentRegistry.write.registerAgent([bobAgent, BOB_ID, "Bob Assistant", "1.0.0", CAPABILITIES_HASH, "ipfs://bob"], { account: bob.account });
    await permissionRegistry.write.setPolicy([bobAgent, POLICY_HASH, 1, "ipfs://bob-policy"], { account: bob.account });
    const before = await balancesOf(stack);

    const madeUp = id("policy:made-up");
    const attempts = [
      { overrides: { from: bob.account.address, to: alice.account.address }, error: "NoMandate", args: [AGENT_ID, getAddress(bob.account.address)] },
      { overrides: { agentId: bobAgent }, error: "NoMandate", args: [bobAgent, getAddress(alice.account.address)] },
      { overrides: { token: other.address }, error: "TokenNotMandated", args: [getAddress(atoken.address), getAddress(other.address)] },
      { overrides: { amount: DAILY_CAP + 1n }, error: "DailyCapExceeded", args: [DAILY_CAP] },
      { overrides: { mandateVersion: 99n }, error: "StaleMandate", args: [1n, 99n] },
      { overrides: { policyHash: madeUp }, error: "PolicyMismatch", args: [POLICY_HASH, madeUp] },
    ] as const;
    for (const a of attempts) {
      const { t, sig } = await signed(a.overrides);
      await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([t, sig]), guard, a.error, [...a.args]);
    }

    // inside the mandate: the cap holds across any number of individually valid attestations
    for (let i = 0; i < 5; i++) {
      const { t, sig } = await signed({ amount: 100n * ONE_TOKEN });
      await guard.write.execute([t, sig]);
    }
    const oneMore = await signed({ amount: 1n });
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([oneMore.t, oneMore.sig]), guard, "DailyCapExceeded", [0n]);

    const after = await balancesOf(stack);
    assert.equal(after[0], before[0] - DAILY_CAP);
    assert.equal(after[1], before[1] + DAILY_CAP, "bob only received; his own funds never moved");
    assert.equal(await other.read.balanceOf([alice.account.address]), MINT_AMOUNT);
  });

  it("only the funding wallet opens, widens, closes or re-points its mandate and payee list; the guard owner cannot either", async function () {
    const stack = await deployCleanverseStack(connection);
    const { guard, atoken, signed, buildTransfer, sign, owner, alice, bob, carol, stranger } = stack;
    const aliceMandate = await guard.read.mandates([AGENT_ID, alice.account.address]);

    // a stranger's mandate for the same agent is the stranger's own
    await guard.write.openMandate([AGENT_ID, atoken.address, MINT_AMOUNT * 10n, 0n, 0n, false], { account: stranger.account });
    assert.deepEqual(await guard.read.mandates([AGENT_ID, alice.account.address]), aliceMandate);
    const overCap = await signed({ amount: DAILY_CAP + 1n });
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([overCap.t, overCap.sig]), guard, "DailyCapExceeded", [DAILY_CAP]);

    // nobody else can close it
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.closeMandate([AGENT_ID], { account: bob.account }), guard, "NoMandate", [
      AGENT_ID,
      getAddress(bob.account.address),
    ]);
    assert.deepEqual(await guard.read.mandates([AGENT_ID, alice.account.address]), aliceMandate);

    // payee lists belong to the funding wallet: a stranger approving carol changes nothing for alice
    await guard.write.openMandate([AGENT_ID, atoken.address, DAILY_CAP, 0n, 0n, true], { account: alice.account });
    await guard.write.setPayee([AGENT_ID, carol.account.address, true], { account: stranger.account });
    assert.equal(await guard.read.isPayee([AGENT_ID, alice.account.address, carol.account.address]), false);
    const toCarol = await signed({ to: carol.account.address });
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([toCarol.t, toCarol.sig]), guard, "PayeeNotApproved", [
      getAddress(carol.account.address),
    ]);

    // the guard owner can only rotate the signer, and the new signer is bounded the same way
    await guard.write.setPayee([AGENT_ID, bob.account.address, true], { account: alice.account });
    await guard.write.setComplianceSigner([stranger.account.address], { account: owner.account });
    const t = await buildTransfer({ amount: DAILY_CAP + 1n });
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([t, await sign(t, stranger)]), guard, "DailyCapExceeded", [DAILY_CAP]);
  });

  it("the server's registry roles never reach the owner's switches: as enforcer, scorer or registry owner it cannot set, revoke or pause", async function () {
    const { agentRegistry, permissionRegistry, reputationRegistry, owner, enforcer, alice } = await deployCleanverseStack(connection);
    await permissionRegistry.write.setEnforcer([enforcer.account.address, true], { account: owner.account });
    await reputationRegistry.write.setScorer([enforcer.account.address, true], { account: owner.account });
    const policyBefore = await permissionRegistry.read.policies([AGENT_ID]);

    for (const who of [enforcer, owner]) {
      await viem.assertions.revertWithCustomErrorWithArgs(
        permissionRegistry.write.setPolicy([AGENT_ID, id("policy:server"), 9, "ipfs://server"], { account: who.account }),
        permissionRegistry,
        "NotAgentOwner",
        [AGENT_ID, getAddress(who.account.address)],
      );
      await viem.assertions.revertWithCustomErrorWithArgs(permissionRegistry.write.revokePolicy([AGENT_ID], { account: who.account }), permissionRegistry, "NotAgentOwner", [
        AGENT_ID,
        getAddress(who.account.address),
      ]);
      await viem.assertions.revertWithCustomError(agentRegistry.write.setStatus([AGENT_ID, 1], { account: who.account }), agentRegistry, "NotIdentityController");
    }

    // what the enforcer can write is a log line and a score; neither changes the passport
    await permissionRegistry.write.recordDecision([AGENT_ID, id("action:x"), true, id("proof:x"), "R6"], { account: enforcer.account });
    await reputationRegistry.write.updateScore([AGENT_ID, 100, 4, id("reason:x"), "server says so"], { account: enforcer.account });
    assert.deepEqual(await permissionRegistry.read.policies([AGENT_ID]), policyBefore);
    // and the owner's own switch still works
    await permissionRegistry.write.revokePolicy([AGENT_ID], { account: alice.account });
  });

  it("revokePolicy is final for earlier attestations: re-approving the passport under a new (version-bound) hash does not revive them", async function () {
    const stack = await deployCleanverseStack(connection);
    const { guard, permissionRegistry, signed, alice } = stack;
    const a = await signed({ amount: 10n * ONE_TOKEN });
    const b = await signed({ amount: 20n * ONE_TOKEN });
    const before = await balancesOf(stack);

    await permissionRegistry.write.revokePolicy([AGENT_ID], { account: alice.account });
    for (const x of [a, b]) {
      await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([x.t, x.sig]), guard, "PolicyNotActive", [AGENT_ID]);
    }

    // the owner approves the same rules again: Fuku anchors passport v2, whose hash commits to the version
    const v2 = id("policy:v2");
    await permissionRegistry.write.setPolicy([AGENT_ID, v2, 2, "ipfs://policy-v2"], { account: alice.account });
    for (const x of [a, b]) {
      await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([x.t, x.sig]), guard, "PolicyMismatch", [v2, POLICY_HASH]);
      assert.equal(await guard.read.actionExecuted([x.t.actionHash]), false);
    }
    assert.deepEqual(await balancesOf(stack), before);

    // only an attestation issued under v2 moves anything
    const fresh = await signed({ policyHash: v2, amount: 5n * ONE_TOKEN });
    await guard.write.execute([fresh.t, fresh.sig]);
    assert.equal((await balancesOf(stack))[0], before[0] - 5n * ONE_TOKEN);
  });

  it("server-dependent: the guard compares only the policy hash, so re-anchoring an identical hash would revive an unexpired attestation", async function () {
    // This is why Fuku's anchored hash commits to the passport version (web: policyAnchorHash) and
    // why the relayer never re-anchors a passport the database has revoked.
    const { guard, permissionRegistry, signed, alice } = await deployCleanverseStack(connection);
    const a = await signed({ amount: 10n * ONE_TOKEN });
    await permissionRegistry.write.revokePolicy([AGENT_ID], { account: alice.account });
    await viem.assertions.revertWithCustomError(guard.write.execute([a.t, a.sig]), guard, "PolicyNotActive");

    await permissionRegistry.write.setPolicy([AGENT_ID, POLICY_HASH, 2, "ipfs://same-hash-again"], { account: alice.account });
    await guard.write.execute([a.t, a.sig]);
    assert.equal(await guard.read.actionExecuted([a.t.actionHash]), true);
  });

  it("closeMandate is final, also for a retry of an attestation the token rejected earlier (unconsumed)", async function () {
    const stack = await deployCleanverseStack(connection);
    const { guard, atoken, signed, sign, alice, bob, stranger } = stack;
    const amount = 30n * ONE_TOKEN;
    const before = await balancesOf(stack);

    const rejected = await signed({ to: stranger.account.address, amount });
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([rejected.t, rejected.sig]), atoken, "ComplianceRejected", [
      getAddress(stranger.account.address),
      2,
    ]);
    assert.equal(await guard.read.nonceUsed([rejected.t.nonce]), false);
    assert.equal(await guard.read.actionExecuted([rejected.t.actionHash]), false);

    // the owner closes the mandate; the server's retry (same action and nonce, eligible payee) is dead
    await guard.write.closeMandate([AGENT_ID], { account: alice.account });
    const retry = { ...rejected.t, to: bob.account.address };
    const retrySig = await sign(retry);
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([retry, retrySig]), guard, "NoMandate", [AGENT_ID, getAddress(alice.account.address)]);

    // and stays dead after the owner re-opens the same terms
    await guard.write.openMandate([AGENT_ID, atoken.address, DAILY_CAP, 0n, 0n, false], { account: alice.account });
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([retry, retrySig]), guard, "StaleMandate", [3n, 1n]);
    assert.deepEqual(await balancesOf(stack), before);
  });

  it("a pause and a withdrawn allowance are temporary stops: earlier attestations work again after resume or re-approval, until their deadline", async function () {
    const stack = await deployCleanverseStack(connection);
    const { guard, atoken, agentRegistry, signed, alice, publicClient } = stack;
    const amount = 10n * ONE_TOKEN;

    const a = await signed({ amount });
    await agentRegistry.write.setStatus([AGENT_ID, 2], { account: alice.account }); // Paused
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([a.t, a.sig]), guard, "AgentNotActive", [AGENT_ID, 2]);
    await agentRegistry.write.setStatus([AGENT_ID, 1], { account: alice.account }); // resumed
    await guard.write.execute([a.t, a.sig]);

    const b = await signed({ amount });
    await atoken.write.approve([guard.address, 0n], { account: alice.account });
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([b.t, b.sig]), atoken, "InsufficientAllowance", [
      getAddress(guard.address),
      0n,
      amount,
    ]);
    await atoken.write.approve([guard.address, maxUint256], { account: alice.account });
    await guard.write.execute([b.t, b.sig]);

    // the deadline still bounds them
    const now = (await publicClient.getBlock()).timestamp;
    const c = await signed({ amount, deadline: now + 60n });
    await agentRegistry.write.setStatus([AGENT_ID, 2], { account: alice.account });
    await time.increase(120);
    await agentRegistry.write.setStatus([AGENT_ID, 1], { account: alice.account });
    await viem.assertions.revertWithCustomError(guard.write.execute([c.t, c.sig]), guard, "AttestationExpired");
  });

  it("eligibility is independent of the trust score: a frozen, revoked or expired A-Pass blocks an agent scored 100", async function () {
    const stack = await deployCleanverseStack(connection);
    const { guard, apass, atoken, reputationRegistry, owner, scorer, signed, alice, bob } = stack;
    await reputationRegistry.write.setScorer([scorer.account.address, true], { account: owner.account });
    await reputationRegistry.write.updateScore([AGENT_ID, 100, 4, id("reason:top"), "top score"], { account: scorer.account });
    const before = await balancesOf(stack);
    const attempts: GuardedTransfer[] = [];

    await apass.write.setStatus([alice.account.address, 2]); // owner frozen
    const frozen = await signed();
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([frozen.t, frozen.sig]), atoken, "ComplianceRejected", [
      getAddress(alice.account.address),
      3,
    ]);
    attempts.push(frozen.t);
    await apass.write.setStatus([alice.account.address, 1]);

    await apass.write.setStatus([bob.account.address, 0]); // recipient revoked
    const revoked = await signed();
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([revoked.t, revoked.sig]), atoken, "ComplianceRejected", [
      getAddress(bob.account.address),
      2,
    ]);
    attempts.push(revoked.t);
    await apass.write.issue([bob.account.address, activePass({ cvRecordId: id("cv:bob") })]);

    const now = BigInt(await time.latest());
    await apass.write.issue([alice.account.address, activePass({ cvRecordId: id("cv:alice"), expiresAt: now + 60n })]);
    await time.increase(120); // owner expired
    const expired = await signed();
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([expired.t, expired.sig]), atoken, "ComplianceRejected", [
      getAddress(alice.account.address),
      3,
    ]);
    attempts.push(expired.t);

    assert.deepEqual(await balancesOf(stack), before);
    for (const t of attempts) {
      assert.equal(await guard.read.nonceUsed([t.nonce]), false);
      assert.equal(await guard.read.actionExecuted([t.actionHash]), false);
    }
    assert.equal((await reputationRegistry.read.getScore([AGENT_ID]))[0], 100, "the guard never reads the score");
  });
});
