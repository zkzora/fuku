import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, zeroAddress, zeroHash } from "viem";
import { deployCleanverseStack, activePass, ATOKEN_RULE, GROUP_RETAIL, id } from "./fixtures.ts";

const ANY = ATOKEN_RULE; // tier >= 1, any group

describe("CleanverseAPassSim", async function () {
  const connection = await network.create();
  const { viem } = connection;

  it("only issuers can issue or change status; the owner is an issuer by default and manages issuers", async function () {
    const { apass, owner, enforcer, stranger, bob } = await deployCleanverseStack(connection);
    const issuer = enforcer; // any wallet can be made an issuer

    assert.equal(await apass.read.issuers([owner.account.address]), true);
    assert.equal(await apass.read.issuers([issuer.account.address]), false);

    await viem.assertions.revertWithCustomError(
      apass.write.issue([stranger.account.address, activePass()], { account: stranger.account }),
      apass,
      "NotIssuer",
    );
    await viem.assertions.revertWithCustomError(
      apass.write.setStatus([bob.account.address, 2], { account: stranger.account }),
      apass,
      "NotIssuer",
    );
    await viem.assertions.revertWithCustomError(
      apass.write.setIssuer([issuer.account.address, true], { account: stranger.account }),
      apass,
      "NotOwner",
    );
    await viem.assertions.revertWithCustomError(apass.write.setIssuer([zeroAddress, true]), apass, "ZeroAddress");

    await viem.assertions.emitWithArgs(
      apass.write.setIssuer([issuer.account.address, true]),
      apass,
      "IssuerSet",
      [getAddress(issuer.account.address), true],
    );

    const pass = activePass({ tier: 3, subTier: 1, expiresAt: 0n, cvRecordId: id("cv:stranger") });
    await viem.assertions.emitWithArgs(
      apass.write.issue([stranger.account.address, pass], { account: issuer.account }),
      apass,
      "APassIssued",
      [
        getAddress(stranger.account.address),
        getAddress(issuer.account.address),
        1,
        3,
        1,
        GROUP_RETAIL,
        zeroHash,
        0n,
        id("cv:stranger"),
      ],
    );
    assert.deepEqual(await apass.read.passOf([stranger.account.address]), pass);

    await viem.assertions.emitWithArgs(
      apass.write.setStatus([stranger.account.address, 2], { account: issuer.account }),
      apass,
      "APassStatusChanged",
      [getAddress(stranger.account.address), getAddress(issuer.account.address), 1, 2],
    );

    await apass.write.setIssuer([issuer.account.address, false]);
    await viem.assertions.revertWithCustomError(
      apass.write.setStatus([stranger.account.address, 1], { account: issuer.account }),
      apass,
      "NotIssuer",
    );
  });

  it("validates status values, recipients and that setStatus targets an existing pass", async function () {
    const { apass, stranger, alice } = await deployCleanverseStack(connection);

    await viem.assertions.revertWithCustomError(
      apass.write.issue([stranger.account.address, activePass({ status: 0 })]),
      apass,
      "InvalidStatus",
    );
    await viem.assertions.revertWithCustomError(
      apass.write.issue([stranger.account.address, activePass({ status: 3 })]),
      apass,
      "InvalidStatus",
    );
    await viem.assertions.revertWithCustomError(apass.write.issue([zeroAddress, activePass()]), apass, "ZeroAddress");
    await viem.assertions.revertWithCustomError(apass.write.setStatus([alice.account.address, 3]), apass, "InvalidStatus");
    await viem.assertions.revertWithCustomErrorWithArgs(
      apass.write.setStatus([stranger.account.address, 1]),
      apass,
      "NoAPass",
      [getAddress(stranger.account.address)],
    );
  });

  it("verify returns 4 for an eligible pass and 2 when there is no A-Pass", async function () {
    const { apass, alice, stranger } = await deployCleanverseStack(connection);

    assert.equal(await apass.read.verify([alice.account.address, ANY]), 4);
    assert.equal(await apass.read.verify([stranger.account.address, ANY]), 2); // never issued
    assert.equal(await apass.read.verify([zeroAddress, ANY]), 2);

    // status 0 (revoked) also reads as "no A-Pass"
    await apass.write.setStatus([alice.account.address, 0]);
    assert.equal(await apass.read.verify([alice.account.address, ANY]), 2);
  });

  it("verify returns 3 for a frozen pass", async function () {
    const { apass, alice } = await deployCleanverseStack(connection);

    await apass.write.setStatus([alice.account.address, 2]);
    assert.equal(await apass.read.verify([alice.account.address, ANY]), 3);

    await apass.write.setStatus([alice.account.address, 1]);
    assert.equal(await apass.read.verify([alice.account.address, ANY]), 4);
  });

  it("verify returns 3 for an expired pass", async function () {
    const { apass, carol, publicClient } = await deployCleanverseStack(connection);
    const now = (await publicClient.getBlock()).timestamp;

    await apass.write.issue([carol.account.address, activePass({ expiresAt: now + 100n })]);
    assert.equal(await apass.read.verify([carol.account.address, ANY]), 4);

    await connection.networkHelpers.time.increase(200);
    assert.equal(await apass.read.verify([carol.account.address, ANY]), 3);
  });

  it("verify returns 1 when the tier (or sub-tier at the minimum tier) is too low", async function () {
    const { apass, alice } = await deployCleanverseStack(connection);
    const wallet = alice.account.address; // tier 2, sub-tier 0

    const rule = (minTier: number, minSubTier: number) => ({ ...ANY, minTier, minSubTier });
    assert.equal(await apass.read.verify([wallet, rule(3, 0)]), 1); // tier below minTier
    assert.equal(await apass.read.verify([wallet, rule(2, 1)]), 1); // minimum tier, sub-tier too low
    assert.equal(await apass.read.verify([wallet, rule(2, 0)]), 4);
    assert.equal(await apass.read.verify([wallet, rule(1, 5)]), 4); // above minTier: sub-tier ignored
    assert.equal(await apass.read.verify([wallet, rule(0, 0)]), 4); // zero = any
  });

  it("verify returns 1 when a non-zero group or sub-group does not match", async function () {
    const { apass, alice } = await deployCleanverseStack(connection);
    const wallet = alice.account.address; // group = GROUP_RETAIL, subGroup = 0

    assert.equal(await apass.read.verify([wallet, { ...ANY, group: id("cleanverse:group:institutional") }]), 1);
    assert.equal(await apass.read.verify([wallet, { ...ANY, group: GROUP_RETAIL }]), 4);
    assert.equal(await apass.read.verify([wallet, { ...ANY, subGroup: id("cleanverse:subgroup:eu") }]), 1);
  });

  it("verify evaluates none -> frozen / expired -> rule, in that order", async function () {
    const { apass, alice, stranger } = await deployCleanverseStack(connection);
    const strict = { group: id("cleanverse:group:other"), subGroup: zeroHash, minTier: 9, minSubTier: 0 };

    assert.equal(await apass.read.verify([stranger.account.address, strict]), 2);
    await apass.write.setStatus([alice.account.address, 2]);
    assert.equal(await apass.read.verify([alice.account.address, strict]), 3);
    await apass.write.setStatus([alice.account.address, 1]);
    assert.equal(await apass.read.verify([alice.account.address, strict]), 1);
  });
});
