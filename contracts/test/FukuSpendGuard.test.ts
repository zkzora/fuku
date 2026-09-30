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
  "GuardedTransfer(bytes32 agentId,address from,address to,address token,uint256 amount,bytes32 policyHash,bytes32 actionHash,bytes32 proofHash,bytes32 complianceRef,uint256 nonce,uint64 deadline)";
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const DAY = 86_400n;

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

  it("happy path: moves tokens and emits GuardedTransferExecuted and ActionDecision in the same tx", async function () {
    const { guard, atoken, permissionRegistry, publicClient, signed, alice, bob, stranger } =
      await deployCleanverseStack(connection);
    const { t, sig } = await signed({ amount: 120n * ONE_TOKEN });

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
      proofHash: t.proofHash,
      complianceRef: t.complianceRef,
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

    // non-trivial values in every field, including a large amount / nonce / deadline
    const t = await buildTransfer({
      amount: 123_456_789_012_345_678_901n,
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
      true,
    ]);

    // opening does not require the agent to exist
    await viem.assertions.emitWithArgs(
      guard.write.openMandate([unknownAgent, atoken.address, 5n * ONE_TOKEN], { account: bob.account }),
      guard,
      "MandateOpened",
      [unknownAgent, getAddress(bob.account.address), getAddress(atoken.address), 5n * ONE_TOKEN],
    );
    await viem.assertions.revertWithCustomError(
      guard.write.openMandate([AGENT_ID, zeroAddress, 1n], { account: bob.account }),
      guard,
      "ZeroAddress",
    );
    await viem.assertions.revertWithCustomError(
      guard.write.openMandate([AGENT_ID, atoken.address, 0n], { account: bob.account }),
      guard,
      "ZeroDailyCap",
    );

    await viem.assertions.emitWithArgs(
      guard.write.closeMandate([AGENT_ID], { account: alice.account }),
      guard,
      "MandateClosed",
      [AGENT_ID, getAddress(alice.account.address)],
    );
    assert.deepEqual(await guard.read.mandates([AGENT_ID, alice.account.address]), [zeroAddress, 0n, false]);
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

  it("rejects the signature when any one of the 11 fields is tampered with", async function () {
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
      nonce: { ...t, nonce: t.nonce + 1000n },
      deadline: { ...t, deadline: t.deadline + 1n },
    };
    assert.equal(Object.keys(tampered).length, 11);
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
