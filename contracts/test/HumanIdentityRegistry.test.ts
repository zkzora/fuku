import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, zeroAddress } from "viem";
import { ALICE_ID, PASSKEY_HASH, PROOF_HASH, id } from "./fixtures.ts";

describe("HumanIdentityRegistry", async function () {
  const connection = await network.create();
  const { viem } = connection;

  async function deploy() {
    const [owner, alice, bob] = await viem.getWalletClients();
    const registry = await viem.deployContract("HumanIdentityRegistry");
    return { registry, owner, alice, bob };
  }

  it("registers an identity with msg.sender as controller and emits IdentityRegistered", async function () {
    const { registry, alice } = await deploy();

    await viem.assertions.emitWithArgs(
      registry.write.registerIdentity([ALICE_ID, PASSKEY_HASH, PROOF_HASH], { account: alice.account }),
      registry,
      "IdentityRegistered",
      [ALICE_ID, getAddress(alice.account.address), PROOF_HASH],
    );

    const [controller, passkeyPubKeyHash, proofHash, registeredAt, humanVerified] =
      await registry.read.identities([ALICE_ID]);

    assert.equal(getAddress(controller), getAddress(alice.account.address));
    assert.equal(passkeyPubKeyHash, PASSKEY_HASH);
    assert.equal(proofHash, PROOF_HASH);
    assert.ok(registeredAt > 0n, "registeredAt should be set");
    assert.equal(humanVerified, false);
    assert.equal(await registry.read.isHuman([ALICE_ID]), false);
    assert.equal(getAddress(await registry.read.controllerOf([ALICE_ID])), getAddress(alice.account.address));
  });

  it("reverts when the same identityId is registered twice (by anyone)", async function () {
    const { registry, alice, bob } = await deploy();
    await registry.write.registerIdentity([ALICE_ID, PASSKEY_HASH, PROOF_HASH], { account: alice.account });

    await viem.assertions.revertWithCustomErrorWithArgs(
      registry.write.registerIdentity([ALICE_ID, PASSKEY_HASH, PROOF_HASH], { account: alice.account }),
      registry,
      "AlreadyRegistered",
      [ALICE_ID],
    );
    await viem.assertions.revertWithCustomError(
      registry.write.registerIdentity([ALICE_ID, id("other-passkey"), id("other-proof")], { account: bob.account }),
      registry,
      "AlreadyRegistered",
    );
  });

  it("lets only the owner (verifier) set humanVerified", async function () {
    const { registry, owner, alice, bob } = await deploy();
    await registry.write.registerIdentity([ALICE_ID, PASSKEY_HASH, PROOF_HASH], { account: alice.account });

    // the identity's own controller cannot self-verify
    await viem.assertions.revertWithCustomError(
      registry.write.setHumanVerified([ALICE_ID, true], { account: alice.account }),
      registry,
      "NotOwner",
    );
    // nor can a random account
    await viem.assertions.revertWithCustomError(
      registry.write.setHumanVerified([ALICE_ID, true], { account: bob.account }),
      registry,
      "NotOwner",
    );

    assert.equal(getAddress(await registry.read.owner()), getAddress(owner.account.address));

    await viem.assertions.emitWithArgs(
      registry.write.setHumanVerified([ALICE_ID, true], { account: owner.account }),
      registry,
      "HumanVerified",
      [ALICE_ID, true],
    );
    assert.equal(await registry.read.isHuman([ALICE_ID]), true);

    // and can be revoked again
    await registry.write.setHumanVerified([ALICE_ID, false], { account: owner.account });
    assert.equal(await registry.read.isHuman([ALICE_ID]), false);
  });

  it("refuses to verify an unregistered identity", async function () {
    const { registry, owner } = await deploy();
    await viem.assertions.revertWithCustomError(
      registry.write.setHumanVerified([id("nobody"), true], { account: owner.account }),
      registry,
      "NotRegistered",
    );
    const [controller] = await registry.read.identities([id("nobody")]);
    assert.equal(controller, zeroAddress);
  });
});
