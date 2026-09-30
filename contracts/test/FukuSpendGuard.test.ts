import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import {
  getAddress,
  hashDomain,
  hashTypedData,
  keccak256,
  parseEventLogs,
  recoverTypedDataAddress,
  stringToHex,
  zeroAddress,
  type Hex,
} from "viem";
import {
  deployCleanverseStack,
  activePass,
  AGENT_ID,
  ATOKEN_RULE,
  DAILY_CAP,
  GUARDED_TRANSFER_TYPES,
  MINT_AMOUNT,
  ONE_TOKEN,
  POLICY_HASH,
  id,
  type GuardedTransfer,
} from "./fixtures.ts";

const TYPEHASH_STRING =
  "GuardedTransfer(bytes32 agentId,address from,address to,address token,uint256 amount,bytes32 policyHash,bytes32 actionHash,bytes32 proofHash,bytes32 complianceRef,uint64 mandateVersion,uint256 nonce,uint64 issuedAt,uint64 deadline)";
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const DAY = 86_400n;

type CleanverseStack = Awaited<ReturnType<typeof deployCleanverseStack>>;

/** aToken balances of alice, bob, carol and stranger, in that order. */
async function balancesOf({ atoken, alice, bob, carol, stranger }: CleanverseStack): Promise<bigint[]> {
  return Promise.all([alice, bob, carol, stranger].map((w) => atoken.read.balanceOf([w.account.address])));
}

/** Split a 65-byte signature into r (hex, no 0x), s (bigint) and v. */
function splitSig(sig: Hex) {
  assert.equal(sig.length, 2 + 130, "expected a 65-byte signature");
  return { r: sig.slice(2, 66), s: BigInt(`0x${sig.slice(66, 130)}`), v: parseInt(sig.slice(130, 132), 16) };
}
function joinSig(r: string, s: bigint, v: number): Hex {
  return `0x${r}${s.toString(16).padStart(64, "0")}${v.toString(16).padStart(2, "0")}`;
}

describe("FukuSpendGuard", async function () {
  const connection = await network.create();
  const { viem } = connection;
  const { time } = connection.networkHelpers;

  /** Mine a block 10 s into the next UTC day (so a test stays inside one day); returns that day's 00:00:00. */
  async function freshUtcDay(): Promise<bigint> {
    const dayStart = (BigInt(await time.latest()) / DAY + 1n) * DAY;
    await time.increaseTo(dayStart + 10n);
    return dayStart;
  }

  it("happy path: moves tokens and emits GuardedTransferExecuted and ActionDecision in the same tx", async function () {
    const { guard, atoken, permissionRegistry, publicClient, signed, alice, bob, stranger } =
      await deployCleanverseStack(connection);
    const { t, sig } = await signed({ amount: 120n * ONE_TOKEN });
    assert.equal(t.mandateVersion, 1n);

    // any relayer may submit; authority comes from the attestation, mandate and allowance
    const hash = await guard.write.execute([t, sig], { account: stranger.account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");

    const executed = parseEventLogs({ abi: guard.abi, logs: receipt.logs, eventName: "GuardedTransferExecuted" });
    assert.equal(executed.length, 1);
    assert.equal(getAddress(executed[0].address), getAddress(guard.address));
    assert.deepEqual(executed[0].args, {
      agentId: AGENT_ID,
      from: getAddress(alice.account.address),
      to: getAddress(bob.account.address),
      token: getAddress(atoken.address),
      amount: 120n * ONE_TOKEN,
      actionHash: t.actionHash,
      proofHash: t.proofHash,
      complianceRef: t.complianceRef,
      mandateVersion: 1n,
      nonce: t.nonce,
    });

    const decisions = parseEventLogs({ abi: permissionRegistry.abi, logs: receipt.logs, eventName: "ActionDecision" });
    assert.equal(decisions.length, 1);
    assert.equal(getAddress(decisions[0].address), getAddress(permissionRegistry.address));
    assert.equal(decisions[0].args.agentId, AGENT_ID);
    assert.equal(decisions[0].args.actionHash, t.actionHash);
    assert.equal(decisions[0].args.allowed, true);
    assert.equal(decisions[0].args.proofHash, t.proofHash);
    assert.equal(decisions[0].args.ruleId, "R6");

    const transfers = parseEventLogs({ abi: atoken.abi, logs: receipt.logs, eventName: "Transfer" });
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].args.value, 120n * ONE_TOKEN);

    assert.equal(await atoken.read.balanceOf([alice.account.address]), MINT_AMOUNT - 120n * ONE_TOKEN);
    assert.equal(await atoken.read.balanceOf([bob.account.address]), 120n * ONE_TOKEN);
    assert.equal(await guard.read.nonceUsed([t.nonce]), true);
    assert.equal(await guard.read.actionExecuted([t.actionHash]), true);
    assert.equal(await guard.read.spentToday([AGENT_ID, alice.account.address]), 120n * ONE_TOKEN);
    const [allowedCount, violationCount] = await permissionRegistry.read.stats([AGENT_ID]);
    assert.equal(allowedCount, 1n);
    assert.equal(violationCount, 0n);
  });

  it("hashTransfer equals viem hashTypedData for the same struct (EIP-712 parity)", async function () {
    const { guard, complianceSigner, chainId, domain, buildTransfer, sign } = await deployCleanverseStack(connection);

    assert.deepEqual(domain, { name: "FukuSpendGuard", version: "1", chainId, verifyingContract: guard.address });
    assert.equal(await guard.read.GUARDED_TRANSFER_TYPEHASH(), keccak256(stringToHex(TYPEHASH_STRING)));
    assert.equal(
      await guard.read.domainSeparator(),
      hashDomain({
        domain: { ...domain, chainId: BigInt(domain.chainId) },
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
        },
      }),
    );

    // non-trivial values in every field, including a large amount / version / nonce / deadline
    const t = await buildTransfer({
      amount: 123_456_789_012_345_678_901n,
      mandateVersion: 2n ** 64n - 1n,
      nonce: 2n ** 200n + 7n,
      deadline: 2n ** 63n + 11n,
    });
    const digest = hashTypedData({ domain, types: GUARDED_TRANSFER_TYPES, primaryType: "GuardedTransfer", message: t });
    assert.equal(await guard.read.hashTransfer([t]), digest);

    const sig = await sign(t);
    const recovered = await recoverTypedDataAddress({
      domain,
      types: GUARDED_TRANSFER_TYPES,
      primaryType: "GuardedTransfer",
      message: t,
      signature: sig,
    });
    assert.equal(recovered, getAddress(complianceSigner.account.address));
  });

  it("mandates: opened and closed by the funding wallet with events and input checks", async function () {
    const { guard, atoken, alice, bob } = await deployCleanverseStack(connection);
    const unknownAgent = id("agent:not-registered-yet");

    assert.deepEqual(await guard.read.mandates([AGENT_ID, alice.account.address]), [
      getAddress(atoken.address),
      DAILY_CAP,
      0n,
      0n,
      false,
      1n,
      true,
    ]);

    // opening does not require the agent to exist
    await viem.assertions.emitWithArgs(
      guard.write.openMandate([unknownAgent, atoken.address, 5n * ONE_TOKEN, 0n, 0n, false], { account: bob.account }),
      guard,
      "MandateOpened",
      [unknownAgent, getAddress(bob.account.address), getAddress(atoken.address), 5n * ONE_TOKEN, 0n, 0n, false, 1n],
    );
    await viem.assertions.revertWithCustomError(
      guard.write.openMandate([AGENT_ID, zeroAddress, 1n, 0n, 0n, false], { account: bob.account }),
      guard,
      "ZeroAddress",
    );
    await viem.assertions.revertWithCustomError(
      guard.write.openMandate([AGENT_ID, atoken.address, 0n, 0n, 0n, false], { account: bob.account }),
      guard,
      "ZeroDailyCap",
    );

    await viem.assertions.emitWithArgs(
      guard.write.closeMandate([AGENT_ID], { account: alice.account }),
      guard,
      "MandateClosed",
      [AGENT_ID, getAddress(alice.account.address), 2n],
    );
    // terms cleared, the bumped version stays visible
    assert.deepEqual(await guard.read.mandates([AGENT_ID, alice.account.address]), [
      zeroAddress,
      0n,
      0n,
      0n,
      false,
      2n,
      false,
    ]);
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.closeMandate([AGENT_ID], { account: alice.account }),
      guard,
      "NoMandate",
      [AGENT_ID, getAddress(alice.account.address)],
    );
  });

  it("rejects an attestation signed by anyone but the compliance signer", async function () {
    const { guard, buildTransfer, sign, alice, owner } = await deployCleanverseStack(connection);
    const t = await buildTransfer();

    for (const wrong of [alice, owner]) {
      await viem.assertions.revertWithCustomError(guard.write.execute([t, await sign(t, wrong)]), guard, "BadAttestation");
    }
    await guard.write.execute([t, await sign(t)]);
  });

  it("rejects the signature when any one of the 13 fields is tampered with", async function () {
    const { guard, signed, carol, stranger } = await deployCleanverseStack(connection);
    const { t, sig } = await signed();

    const tampered: Record<keyof GuardedTransfer, GuardedTransfer> = {
      agentId: { ...t, agentId: id("agent:other") },
      from: { ...t, from: carol.account.address },
      to: { ...t, to: carol.account.address },
      token: { ...t, token: stranger.account.address },
      amount: { ...t, amount: t.amount + 1n },
      policyHash: { ...t, policyHash: id("policy:other") },
      actionHash: { ...t, actionHash: id("action:other") },
      proofHash: { ...t, proofHash: id("proof:other") },
      complianceRef: { ...t, complianceRef: id("cleanverse:ref:other") },
      mandateVersion: { ...t, mandateVersion: t.mandateVersion + 1n },
      nonce: { ...t, nonce: t.nonce + 1000n },
      // (moved inside the valid window, so only the signature can catch them)
      issuedAt: { ...t, issuedAt: t.issuedAt + 1n },
      deadline: { ...t, deadline: t.deadline - 1n },
    };
    assert.equal(Object.keys(tampered).length, 13);
    assert.deepEqual(Object.keys(tampered), GUARDED_TRANSFER_TYPES.GuardedTransfer.map((f) => f.name));

    for (const [field, forged] of Object.entries(tampered)) {
      await viem.assertions.revertWithCustomError(guard.write.execute([forged, sig]), guard, "BadAttestation").catch(
        (err: Error) => {
          throw new Error(`tampered field "${field}": ${err.message}`);
        },
      );
    }

    // the untampered original still goes through
    await guard.write.execute([t, sig]);
  });

  it("rejects an attestation signed for another chain id or another guard contract (EIP-712 domain)", async function () {
    const stack = await deployCleanverseStack(connection);
    const { viem: v, guard, agentRegistry, permissionRegistry, complianceSigner, chainId, buildTransfer, sign } = stack;
    const otherGuard = await v.deployContract("FukuSpendGuard", [
      agentRegistry.address,
      permissionRegistry.address,
      complianceSigner.account.address,
    ]);
    const t = await buildTransfer();
    const before = await balancesOf(stack);

    // same signer, same struct: only the domain differs
    for (const wrongChainId of [1, chainId + 1]) {
      const otherChain = await sign(t, complianceSigner, { chainId: wrongChainId });
      await viem.assertions.revertWithCustomError(guard.write.execute([t, otherChain]), guard, "BadAttestation");
    }
    const forOtherGuard = await sign(t, complianceSigner, { verifyingContract: otherGuard.address });
    await viem.assertions.revertWithCustomError(guard.write.execute([t, forOtherGuard]), guard, "BadAttestation");
    // and an attestation for this guard does not verify on another guard trusting the same signer
    const forThisGuard = await sign(t);
    await viem.assertions.revertWithCustomError(otherGuard.write.execute([t, forThisGuard]), otherGuard, "BadAttestation");

    assert.deepEqual(await balancesOf(stack), before);
    assert.equal(await guard.read.nonceUsed([t.nonce]), false);
    assert.equal(await guard.read.actionExecuted([t.actionHash]), false);

    // the same struct signed for this chain and this guard goes through
    await guard.write.execute([t, forThisGuard]);
    const after = await balancesOf(stack);
    assert.equal(after[0], before[0] - t.amount);
    assert.equal(after[1], before[1] + t.amount);
  });

  it("rejects a high-s (malleable) signature, a bad v and a 64-byte signature", async function () {
    const { guard, signed, complianceSigner, domain } = await deployCleanverseStack(connection);
    const { t, sig } = await signed();
    const { r, s, v } = splitSig(sig);
    assert.ok(s <= SECP256K1_N / 2n, "signer should produce low-s signatures");
    assert.ok(v === 27 || v === 28);

    // the malleable twin (n - s, flipped v) recovers the same signer off-chain...
    const highS = joinSig(r, SECP256K1_N - s, v === 27 ? 28 : 27);
    const recovered = await recoverTypedDataAddress({
      domain,
      types: GUARDED_TRANSFER_TYPES,
      primaryType: "GuardedTransfer",
      message: t,
      signature: highS,
    });
    assert.equal(recovered, getAddress(complianceSigner.account.address));
    // ...but the guard refuses it
    await viem.assertions.revertWithCustomError(guard.write.execute([t, highS]), guard, "BadAttestation");

    await viem.assertions.revertWithCustomError(guard.write.execute([t, joinSig(r, s, v - 27)]), guard, "BadAttestation");
    await viem.assertions.revertWithCustomError(
      guard.write.execute([t, sig.slice(0, 2 + 128) as Hex]),
      guard,
      "BadAttestation",
    );
    await viem.assertions.revertWithCustomError(guard.write.execute([t, "0x"]), guard, "BadAttestation");

    await guard.write.execute([t, sig]);
  });

  it("rejects an expired attestation", async function () {
    const { guard, signed, publicClient } = await deployCleanverseStack(connection);
    const now = (await publicClient.getBlock()).timestamp;
    const { t, sig } = await signed({ deadline: now + 60n });

    await time.increase(120);
    await viem.assertions.revertWithCustomError(guard.write.execute([t, sig]), guard, "AttestationExpired");
  });

  it("rejects a nonce that was already used", async function () {
    const { guard, signed } = await deployCleanverseStack(connection);
    const { t, sig } = await signed({ amount: ONE_TOKEN });
    await guard.write.execute([t, sig]);

    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([t, sig]), guard, "NonceUsed", [t.nonce]);
    // a different, correctly signed transfer re-using the nonce is rejected too
    const again = await signed({ nonce: t.nonce, amount: 2n * ONE_TOKEN });
    await viem.assertions.revertWithCustomError(guard.write.execute([again.t, again.sig]), guard, "NonceUsed");
  });

  it("executes each action at most once: the same actionHash with a fresh nonce reverts ActionAlreadyExecuted", async function () {
    const stack = await deployCleanverseStack(connection);
    const { guard, signed, alice } = stack;
    const first = await signed({ amount: 10n * ONE_TOKEN });
    await guard.write.execute([first.t, first.sig]);
    assert.equal(await guard.read.actionExecuted([first.t.actionHash]), true);
    const before = await balancesOf(stack);

    // a fresh, correctly signed attestation (new nonce) for the same Fuku action
    const again = await signed({ actionHash: first.t.actionHash, amount: 10n * ONE_TOKEN });
    assert.notEqual(again.t.nonce, first.t.nonce);
    assert.equal(await guard.read.nonceUsed([again.t.nonce]), false);
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.execute([again.t, again.sig]),
      guard,
      "ActionAlreadyExecuted",
      [first.t.actionHash],
    );
    assert.deepEqual(await balancesOf(stack), before);
    assert.equal(await guard.read.nonceUsed([again.t.nonce]), false);
    assert.equal(await guard.read.spentToday([AGENT_ID, alice.account.address]), 10n * ONE_TOKEN);

    // another action is unaffected
    const other = await signed({ amount: 10n * ONE_TOKEN });
    await guard.write.execute([other.t, other.sig]);
  });

  it("rejects a policy hash that no longer matches the on-chain policy (PolicyMismatch)", async function () {
    const { guard, permissionRegistry, signed, alice } = await deployCleanverseStack(connection);
    const { t, sig } = await signed();
    const v2 = id("policy:v2");

    await permissionRegistry.write.setPolicy([AGENT_ID, v2, 2, "ipfs://policy-v2"], { account: alice.account });
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([t, sig]), guard, "PolicyMismatch", [
      v2,
      POLICY_HASH,
    ]);

    const fresh = await signed({ policyHash: v2 });
    await guard.write.execute([fresh.t, fresh.sig]);
  });

  it("rejects a revoked policy (PolicyNotActive)", async function () {
    const { guard, permissionRegistry, signed, alice } = await deployCleanverseStack(connection);
    const { t, sig } = await signed();

    await permissionRegistry.write.revokePolicy([AGENT_ID], { account: alice.account });
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([t, sig]), guard, "PolicyNotActive", [
      AGENT_ID,
    ]);
  });

  it("rejects Paused and Revoked agents (AgentNotActive); Registered and Active pass", async function () {
    const { guard, agentRegistry, signed, alice } = await deployCleanverseStack(connection);

    await agentRegistry.write.setStatus([AGENT_ID, 2], { account: alice.account }); // Paused
    const paused = await signed();
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.execute([paused.t, paused.sig]),
      guard,
      "AgentNotActive",
      [AGENT_ID, 2],
    );

    await agentRegistry.write.setStatus([AGENT_ID, 3], { account: alice.account }); // Revoked
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.execute([paused.t, paused.sig]),
      guard,
      "AgentNotActive",
      [AGENT_ID, 3],
    );

    await agentRegistry.write.setStatus([AGENT_ID, 1], { account: alice.account }); // Active
    await guard.write.execute([paused.t, paused.sig]);

    await agentRegistry.write.setStatus([AGENT_ID, 0], { account: alice.account }); // Registered
    const registered = await signed();
    await guard.write.execute([registered.t, registered.sig]);
  });

  it("rejects an unknown agent (AgentNotFound)", async function () {
    const { guard, signed } = await deployCleanverseStack(connection);
    const missing = id("agent:missing");
    const { t, sig } = await signed({ agentId: missing });
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([t, sig]), guard, "AgentNotFound", [missing]);
  });

  it("requires an open mandate for (agent, from) on the attested token (NoMandate / TokenNotMandated)", async function () {
    const { viem: v, guard, apass, atoken, signed, alice, bob } = await deployCleanverseStack(connection);

    // bob never opened a mandate
    const fromBob = await signed({ from: bob.account.address, to: alice.account.address });
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([fromBob.t, fromBob.sig]), guard, "NoMandate", [
      AGENT_ID,
      getAddress(bob.account.address),
    ]);

    // a different token than the one alice mandated
    const otherToken = await v.deployContract("CleanverseATokenSim", [apass.address, ATOKEN_RULE]);
    const wrongToken = await signed({ token: otherToken.address });
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.execute([wrongToken.t, wrongToken.sig]),
      guard,
      "TokenNotMandated",
      [getAddress(atoken.address), getAddress(otherToken.address)],
    );

    // closing the mandate stops further transfers
    await guard.write.closeMandate([AGENT_ID], { account: alice.account });
    const afterClose = await signed();
    await viem.assertions.revertWithCustomError(guard.write.execute([afterClose.t, afterClose.sig]), guard, "NoMandate");
  });

  it("ties each attestation to the mandate version: NoMandate after close, StaleMandate after close + reopen", async function () {
    const stack = await deployCleanverseStack(connection);
    const { guard, atoken, signed, alice, mandateVersionOf } = stack;
    const preSigned = await signed(); // issued under version 1
    assert.equal(preSigned.t.mandateVersion, 1n);
    const before = await balancesOf(stack);

    await guard.write.closeMandate([AGENT_ID], { account: alice.account }); // version 2
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.execute([preSigned.t, preSigned.sig]),
      guard,
      "NoMandate",
      [AGENT_ID, getAddress(alice.account.address)],
    );

    // re-opening with exactly the same terms does not revive the old attestation
    await guard.write.openMandate([AGENT_ID, atoken.address, DAILY_CAP, 0n, 0n, false], { account: alice.account });
    assert.equal(await mandateVersionOf(AGENT_ID, alice.account.address), 3n);
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.execute([preSigned.t, preSigned.sig]),
      guard,
      "StaleMandate",
      [3n, 1n],
    );

    // replacing an open mandate (no close in between) voids earlier attestations as well
    const underV3 = await signed();
    await guard.write.openMandate([AGENT_ID, atoken.address, DAILY_CAP, 0n, 0n, false], { account: alice.account });
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.execute([underV3.t, underV3.sig]),
      guard,
      "StaleMandate",
      [4n, 3n],
    );

    assert.deepEqual(await balancesOf(stack), before);
    assert.equal(await guard.read.nonceUsed([preSigned.t.nonce]), false);
    assert.equal(await guard.read.actionExecuted([preSigned.t.actionHash]), false);

    // re-attested under the current version, the same action goes through
    const fresh = await signed({ actionHash: preSigned.t.actionHash });
    assert.equal(fresh.t.mandateVersion, 4n);
    await guard.write.execute([fresh.t, fresh.sig]);
  });

  it("mandate expiry: usable through validUntil, MandateExpired after; openMandate rejects a stale expiry or maxPerTx > dailyCap", async function () {
    const stack = await deployCleanverseStack(connection);
    const { guard, atoken, signed, alice } = stack;
    const validUntil = BigInt(await time.latest()) + 3600n;
    await viem.assertions.emitWithArgs(
      guard.write.openMandate([AGENT_ID, atoken.address, DAILY_CAP, 0n, validUntil, false], { account: alice.account }),
      guard,
      "MandateOpened",
      [AGENT_ID, getAddress(alice.account.address), getAddress(atoken.address), DAILY_CAP, 0n, validUntil, false, 2n],
    );

    // issued 30 s before the expiry, the attestations outlive the mandate, so only the expiry can stop them
    await time.increaseTo(validUntil - 30n);
    const lastSecond = await signed({ amount: ONE_TOKEN });
    const tooLate = await signed({ amount: ONE_TOKEN });
    assert.ok(tooLate.t.deadline > validUntil + 1n);

    await time.setNextBlockTimestamp(validUntil); // block.timestamp == validUntil is still valid
    await guard.write.execute([lastSecond.t, lastSecond.sig]);

    await time.setNextBlockTimestamp(validUntil + 1n);
    const before = await balancesOf(stack);
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.execute([tooLate.t, tooLate.sig]),
      guard,
      "MandateExpired",
      [validUntil],
    );
    assert.deepEqual(await balancesOf(stack), before);
    assert.equal(await guard.read.nonceUsed([tooLate.t.nonce]), false);

    // openMandate: validUntil must be 0 or later than the block timestamp, maxPerTx <= dailyCap
    const next = validUntil + 10n;
    await time.setNextBlockTimestamp(next);
    for (const staleUntil of [1n, validUntil, next]) {
      await viem.assertions.revertWithCustomError(
        guard.write.openMandate([AGENT_ID, atoken.address, DAILY_CAP, 0n, staleUntil, false], { account: alice.account }),
        guard,
        "InvalidMandate",
      );
    }
    await viem.assertions.revertWithCustomError(
      guard.write.openMandate([AGENT_ID, atoken.address, DAILY_CAP, DAILY_CAP + 1n, 0n, false], { account: alice.account }),
      guard,
      "InvalidMandate",
    );
    // the failed opens left the expired mandate (version 2) untouched
    assert.deepEqual(await guard.read.mandates([AGENT_ID, alice.account.address]), [
      getAddress(atoken.address),
      DAILY_CAP,
      0n,
      validUntil,
      false,
      2n,
      true,
    ]);

    // the tightest valid terms open fine (mined at `next`): expiry next + 1, maxPerTx == dailyCap
    await guard.write.openMandate([AGENT_ID, atoken.address, DAILY_CAP, DAILY_CAP, next + 1n, false], {
      account: alice.account,
    });
    const renewed = await signed({ amount: ONE_TOKEN });
    await time.setNextBlockTimestamp(next + 1n);
    await guard.write.execute([renewed.t, renewed.sig]);
  });

  it("per-transaction limit: exactly maxPerTx succeeds, maxPerTx + 1 base unit reverts PerTxLimitExceeded", async function () {
    const stack = await deployCleanverseStack(connection);
    const { guard, atoken, signed, alice } = stack;
    const maxPerTx = 100n * ONE_TOKEN;
    await guard.write.openMandate([AGENT_ID, atoken.address, DAILY_CAP, maxPerTx, 0n, false], { account: alice.account });

    const over = await signed({ amount: maxPerTx + 1n });
    const before = await balancesOf(stack);
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.execute([over.t, over.sig]),
      guard,
      "PerTxLimitExceeded",
      [maxPerTx],
    );
    assert.deepEqual(await balancesOf(stack), before);
    assert.equal(await guard.read.spentToday([AGENT_ID, alice.account.address]), 0n);

    const exact = await signed({ amount: maxPerTx });
    await guard.write.execute([exact.t, exact.sig]);
    const after = await balancesOf(stack);
    assert.equal(after[0], before[0] - maxPerTx);
    assert.equal(after[1], before[1] + maxPerTx);
    assert.equal(await guard.read.spentToday([AGENT_ID, alice.account.address]), maxPerTx);
  });

  it("restrictPayees: only approved payees; removing one voids pre-signed attestations; PayeeSet events", async function () {
    const stack = await deployCleanverseStack(connection);
    const { guard, apass, atoken, signed, alice, bob, carol } = stack;
    await apass.write.issue([carol.account.address, activePass({ cvRecordId: id("cv:carol") })]);
    await guard.write.openMandate([AGENT_ID, atoken.address, DAILY_CAP, 0n, 0n, true], { account: alice.account });

    await viem.assertions.revertWithCustomError(
      guard.write.setPayee([AGENT_ID, zeroAddress, true], { account: alice.account }),
      guard,
      "ZeroRecipient",
    );
    await viem.assertions.emitWithArgs(
      guard.write.setPayee([AGENT_ID, carol.account.address, true], { account: alice.account }),
      guard,
      "PayeeSet",
      [AGENT_ID, getAddress(alice.account.address), getAddress(carol.account.address), true],
    );
    assert.equal(await guard.read.isPayee([AGENT_ID, alice.account.address, carol.account.address]), true);
    assert.equal(await guard.read.isPayee([AGENT_ID, alice.account.address, bob.account.address]), false);
    // the list is per (agent, wallet)
    assert.equal(await guard.read.isPayee([id("agent:other"), alice.account.address, carol.account.address]), false);
    assert.equal(await guard.read.isPayee([AGENT_ID, bob.account.address, carol.account.address]), false);

    // bob holds an eligible A-Pass but is not on alice's list
    const before = await balancesOf(stack);
    const toBob = await signed({ to: bob.account.address });
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.execute([toBob.t, toBob.sig]),
      guard,
      "PayeeNotApproved",
      [getAddress(bob.account.address)],
    );
    assert.deepEqual(await balancesOf(stack), before);

    const toCarol = await signed({ to: carol.account.address, amount: 20n * ONE_TOKEN });
    await guard.write.execute([toCarol.t, toCarol.sig]);
    assert.equal(await atoken.read.balanceOf([carol.account.address]), 20n * ONE_TOKEN);

    // removing carol takes effect at once, even for an attestation that was already signed
    const preSigned = await signed({ to: carol.account.address, amount: 20n * ONE_TOKEN });
    await viem.assertions.emitWithArgs(
      guard.write.setPayee([AGENT_ID, carol.account.address, false], { account: alice.account }),
      guard,
      "PayeeSet",
      [AGENT_ID, getAddress(alice.account.address), getAddress(carol.account.address), false],
    );
    assert.equal(await guard.read.isPayee([AGENT_ID, alice.account.address, carol.account.address]), false);
    const afterRemoval = await balancesOf(stack);
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.execute([preSigned.t, preSigned.sig]),
      guard,
      "PayeeNotApproved",
      [getAddress(carol.account.address)],
    );
    assert.deepEqual(await balancesOf(stack), afterRemoval);

    // payees survive close / re-open; without restrictPayees the list is not consulted
    await guard.write.setPayee([AGENT_ID, carol.account.address, true], { account: alice.account });
    await guard.write.closeMandate([AGENT_ID], { account: alice.account });
    assert.equal(await guard.read.isPayee([AGENT_ID, alice.account.address, carol.account.address]), true);
    await guard.write.openMandate([AGENT_ID, atoken.address, DAILY_CAP, 0n, 0n, false], { account: alice.account });
    const unrestricted = await signed({ to: bob.account.address, amount: ONE_TOKEN });
    await guard.write.execute([unrestricted.t, unrestricted.sig]);
    assert.equal(await atoken.read.balanceOf([bob.account.address]), before[1] + ONE_TOKEN);
  });

  it("rejects a zero amount and the zero recipient", async function () {
    const { guard, signed } = await deployCleanverseStack(connection);
    const zeroAmount = await signed({ amount: 0n });
    await viem.assertions.revertWithCustomError(guard.write.execute([zeroAmount.t, zeroAmount.sig]), guard, "ZeroAmount");
    const zeroTo = await signed({ to: zeroAddress });
    await viem.assertions.revertWithCustomError(guard.write.execute([zeroTo.t, zeroTo.sig]), guard, "ZeroRecipient");
  });

  it("enforces the daily cap per (agent, wallet) and resets it the next UTC day", async function () {
    const { guard, publicClient, signed, alice } = await deployCleanverseStack(connection);

    // start a few seconds into a fresh UTC day so the whole test stays inside one day
    const now = (await publicClient.getBlock()).timestamp;
    await time.increaseTo((now / DAY + 1n) * DAY + 10n);

    const first = await signed({ amount: 300n * ONE_TOKEN });
    await guard.write.execute([first.t, first.sig]);
    assert.equal(await guard.read.spentToday([AGENT_ID, alice.account.address]), 300n * ONE_TOKEN);

    const over = await signed({ amount: 250n * ONE_TOKEN });
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([over.t, over.sig]), guard, "DailyCapExceeded", [
      DAILY_CAP - 300n * ONE_TOKEN,
    ]);

    const exact = await signed({ amount: DAILY_CAP - 300n * ONE_TOKEN });
    await guard.write.execute([exact.t, exact.sig]);
    assert.equal(await guard.read.spentToday([AGENT_ID, alice.account.address]), DAILY_CAP);

    const one = await signed({ amount: 1n });
    await viem.assertions.revertWithCustomErrorWithArgs(guard.write.execute([one.t, one.sig]), guard, "DailyCapExceeded", [
      0n,
    ]);

    await time.increase(Number(DAY));
    assert.equal(await guard.read.spentToday([AGENT_ID, alice.account.address]), 0n);
    const nextDay = await signed({ amount: 250n * ONE_TOKEN });
    await guard.write.execute([nextDay.t, nextDay.sig]);
    assert.equal(await guard.read.spentToday([AGENT_ID, alice.account.address]), 250n * ONE_TOKEN);
  });

  it("two pre-signed attestations each within the remaining cap but together over it: the second reverts DailyCapExceeded", async function () {
    const stack = await deployCleanverseStack(connection);
    const { guard, signed, alice } = stack;
    await freshUtcDay();

    // both issued before either runs, each within the remaining cap on its own
    const first = await signed({ amount: 300n * ONE_TOKEN + 1n });
    const second = await signed({ amount: 250n * ONE_TOKEN });
    assert.ok(first.t.amount <= DAILY_CAP && second.t.amount <= DAILY_CAP);
    assert.ok(first.t.amount + second.t.amount > DAILY_CAP);
    const start = await balancesOf(stack);

    await guard.write.execute([first.t, first.sig]);
    assert.equal(await guard.read.spentToday([AGENT_ID, alice.account.address]), 300_000_001n);

    const remaining = DAILY_CAP - first.t.amount;
    assert.equal(remaining, 199_999_999n);
    const afterFirst = await balancesOf(stack);
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.execute([second.t, second.sig]),
      guard,
      "DailyCapExceeded",
      [remaining],
    );
    assert.deepEqual(await balancesOf(stack), afterFirst);
    assert.equal(await guard.read.spentToday([AGENT_ID, alice.account.address]), 300_000_001n);

    // exactly the remaining amount still fits, down to the last base unit
    const exact = await signed({ amount: remaining });
    await guard.write.execute([exact.t, exact.sig]);
    assert.equal(await guard.read.spentToday([AGENT_ID, alice.account.address]), DAILY_CAP);

    const oneUnit = await signed({ amount: 1n });
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.execute([oneUnit.t, oneUnit.sig]),
      guard,
      "DailyCapExceeded",
      [0n],
    );

    const end = await balancesOf(stack);
    assert.equal(start[0] - end[0], DAILY_CAP);
    assert.equal(end[1] - start[1], DAILY_CAP);
  });

  it("UTC day boundary: the cap used up at 23:59:59 is fully available again at 00:00:00", async function () {
    const { guard, publicClient, signed, alice } = await deployCleanverseStack(connection);
    const dayStart = await freshUtcDay();
    const nextDay = dayStart + DAY;

    async function executeAt(timestamp: bigint, amount: bigint) {
      const { t, sig } = await signed({ amount });
      await time.setNextBlockTimestamp(timestamp);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: await guard.write.execute([t, sig]) });
      assert.equal((await publicClient.getBlock({ blockNumber: receipt.blockNumber })).timestamp, timestamp);
    }

    // early in the day, then the rest of the cap in the day's last second
    await executeAt(dayStart + 20n, 100n * ONE_TOKEN);
    await time.increaseTo(nextDay - 10n);
    const rest = DAILY_CAP - 100n * ONE_TOKEN;
    const overByOne = await signed({ amount: rest + 1n });
    await time.setNextBlockTimestamp(nextDay - 1n); // 23:59:59 UTC
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.execute([overByOne.t, overByOne.sig]),
      guard,
      "DailyCapExceeded",
      [rest],
    );
    await executeAt(nextDay - 1n, rest);
    assert.equal((nextDay - 1n) % DAY, DAY - 1n);
    assert.equal(await guard.read.spentToday([AGENT_ID, alice.account.address]), DAILY_CAP);

    // 00:00:00 UTC: a new window with the whole cap
    await executeAt(nextDay, DAILY_CAP);
    assert.equal(nextDay % DAY, 0n);
    assert.equal(await guard.read.spentToday([AGENT_ID, alice.account.address]), DAILY_CAP);
    const oneMore = await signed({ amount: 1n });
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.execute([oneMore.t, oneMore.sig]),
      guard,
      "DailyCapExceeded",
      [0n],
    );
  });

  it("bubbles the token's ComplianceRejected when a party has no eligible A-Pass", async function () {
    const { guard, atoken, apass, signed, alice, stranger } = await deployCleanverseStack(connection);

    const toStranger = await signed({ to: stranger.account.address });
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.execute([toStranger.t, toStranger.sig]),
      atoken,
      "ComplianceRejected",
      [getAddress(stranger.account.address), 2],
    );
    // the whole tx reverted: nonce and daily spend untouched
    assert.equal(await guard.read.nonceUsed([toStranger.t.nonce]), false);
    assert.equal(await guard.read.spentToday([AGENT_ID, alice.account.address]), 0n);

    await apass.write.setStatus([alice.account.address, 2]);
    const frozenFrom = await signed();
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.execute([frozenFrom.t, frozenFrom.sig]),
      atoken,
      "ComplianceRejected",
      [getAddress(alice.account.address), 3],
    );
  });

  it("a transfer the token rejects consumes no budget, nonce or action; the corrected attestation then succeeds", async function () {
    const stack = await deployCleanverseStack(connection);
    const { guard, atoken, signed, sign, alice, bob, stranger } = stack;
    const amount = 40n * ONE_TOKEN;
    const before = await balancesOf(stack);

    // stranger holds no A-Pass: every guard check passes, then the token rejects the transfer
    const rejected = await signed({ to: stranger.account.address, amount });
    await viem.assertions.revertWithCustomErrorWithArgs(
      guard.write.execute([rejected.t, rejected.sig]),
      atoken,
      "ComplianceRejected",
      [getAddress(stranger.account.address), 2],
    );
    assert.deepEqual(await balancesOf(stack), before);
    assert.equal(await guard.read.spentToday([AGENT_ID, alice.account.address]), 0n);
    assert.equal(await guard.read.nonceUsed([rejected.t.nonce]), false);
    assert.equal(await guard.read.actionExecuted([rejected.t.actionHash]), false);

    // re-attested for the same action (same actionHash and nonce) to an eligible recipient
    const corrected: GuardedTransfer = { ...rejected.t, to: bob.account.address };
    await guard.write.execute([corrected, await sign(corrected)]);
    assert.equal(await guard.read.spentToday([AGENT_ID, alice.account.address]), amount);
    assert.equal(await guard.read.nonceUsed([corrected.nonce]), true);
    assert.equal(await guard.read.actionExecuted([corrected.actionHash]), true);
    const after = await balancesOf(stack);
    assert.equal(after[0], before[0] - amount);
    assert.equal(after[1], before[1] + amount);
    assert.equal(after[3], before[3]);
  });

  it("mandates() returns the 7 fields in order and the version goes 1, 2, 3 across open, close, open", async function () {
    const { guard, atoken, bob } = await deployCleanverseStack(connection);
    const getter = guard.abi.find((item) => item.type === "function" && item.name === "mandates");
    assert.ok(getter && getter.type === "function");
    assert.deepEqual(
      getter.outputs.map((o) => `${o.type} ${o.name}`),
      [
        "address token",
        "uint256 dailyCap",
        "uint256 maxPerTx",
        "uint64 validUntil",
        "bool restrictPayees",
        "uint64 version",
        "bool active",
      ],
    );

    const wallet = getAddress(bob.account.address);
    const token = getAddress(atoken.address);
    const cap = 50n * ONE_TOKEN;
    const perTx = 5n * ONE_TOKEN;
    const validUntil = BigInt(await time.latest()) + 30n * DAY;
    assert.deepEqual(await guard.read.mandates([AGENT_ID, wallet]), [zeroAddress, 0n, 0n, 0n, false, 0n, false]);

    await viem.assertions.emitWithArgs(
      guard.write.openMandate([AGENT_ID, token, cap, perTx, validUntil, true], { account: bob.account }),
      guard,
      "MandateOpened",
      [AGENT_ID, wallet, token, cap, perTx, validUntil, true, 1n],
    );
    assert.deepEqual(await guard.read.mandates([AGENT_ID, wallet]), [token, cap, perTx, validUntil, true, 1n, true]);

    await viem.assertions.emitWithArgs(
      guard.write.closeMandate([AGENT_ID], { account: bob.account }),
      guard,
      "MandateClosed",
      [AGENT_ID, wallet, 2n],
    );
    assert.deepEqual(await guard.read.mandates([AGENT_ID, wallet]), [zeroAddress, 0n, 0n, 0n, false, 2n, false]);

    await viem.assertions.emitWithArgs(
      guard.write.openMandate([AGENT_ID, token, cap, perTx, validUntil, true], { account: bob.account }),
      guard,
      "MandateOpened",
      [AGENT_ID, wallet, token, cap, perTx, validUntil, true, 3n],
    );
    assert.deepEqual(await guard.read.mandates([AGENT_ID, wallet]), [token, cap, perTx, validUntil, true, 3n, true]);
  });

  it("setComplianceSigner is owner-only and rotates which signer is accepted", async function () {
    const { guard, buildTransfer, sign, complianceSigner, carol, stranger, owner } =
      await deployCleanverseStack(connection);

    assert.equal(await guard.read.complianceSigner(), getAddress(complianceSigner.account.address));
    await viem.assertions.revertWithCustomError(
      guard.write.setComplianceSigner([carol.account.address], { account: stranger.account }),
      guard,
      "NotOwner",
    );
    await viem.assertions.revertWithCustomError(guard.write.setComplianceSigner([zeroAddress]), guard, "ZeroAddress");

    await viem.assertions.emitWithArgs(
      guard.write.setComplianceSigner([carol.account.address], { account: owner.account }),
      guard,
      "ComplianceSignerSet",
      [getAddress(complianceSigner.account.address), getAddress(carol.account.address)],
    );

    const t = await buildTransfer();
    await viem.assertions.revertWithCustomError(guard.write.execute([t, await sign(t)]), guard, "BadAttestation");
    await guard.write.execute([t, await sign(t, carol)]);
  });
});
