import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, maxUint256, zeroAddress, zeroHash } from "viem";
import { deployCleanverseStack, ATOKEN_RULE, MINT_AMOUNT, ONE_TOKEN } from "./fixtures.ts";

describe("CleanverseATokenSim", async function () {
  const connection = await network.create();
  const { viem } = connection;

  it("exposes ERC-20 metadata, the A-Pass registry and the rule; setRule is owner-only", async function () {
    const { atoken, apass, alice, stranger } = await deployCleanverseStack(connection);

    assert.equal(await atoken.read.name(), "Cleanverse aUSDC (Fuku simulator)");
    assert.equal(await atoken.read.symbol(), "aUSDC-SIM");
    assert.equal(await atoken.read.decimals(), 6);
    assert.equal(await atoken.read.apass(), getAddress(apass.address));
    assert.deepEqual(await atoken.read.rule(), [zeroHash, zeroHash, 1, 0]);
    assert.equal(await atoken.read.totalSupply(), MINT_AMOUNT);

    const stricter = { ...ATOKEN_RULE, minTier: 3 };
    await viem.assertions.revertWithCustomError(
      atoken.write.setRule([stricter], { account: stranger.account }),
      atoken,
      "NotOwner",
    );
    await viem.assertions.emitWithArgs(atoken.write.setRule([stricter]), atoken, "RuleSet", [zeroHash, zeroHash, 3, 0]);

    // alice holds a tier-2 pass, so the stricter rule rejects her with code 1
    await viem.assertions.revertWithCustomErrorWithArgs(
      atoken.write.transfer([alice.account.address, 1n], { account: alice.account }),
      atoken,
      "ComplianceRejected",
      [getAddress(alice.account.address), 1],
    );
  });

  it("mint is owner-only and only to wallets with an eligible A-Pass", async function () {
    const { atoken, apass, bob, stranger } = await deployCleanverseStack(connection);

    await viem.assertions.revertWithCustomError(
      atoken.write.mint([bob.account.address, ONE_TOKEN], { account: bob.account }),
      atoken,
      "NotOwner",
    );
    await viem.assertions.revertWithCustomErrorWithArgs(
      atoken.write.mint([stranger.account.address, ONE_TOKEN]),
      atoken,
      "ComplianceRejected",
      [getAddress(stranger.account.address), 2],
    );
    await apass.write.setStatus([bob.account.address, 2]);
    await viem.assertions.revertWithCustomErrorWithArgs(
      atoken.write.mint([bob.account.address, ONE_TOKEN]),
      atoken,
      "ComplianceRejected",
      [getAddress(bob.account.address), 3],
    );
    await apass.write.setStatus([bob.account.address, 1]);

    await viem.assertions.emitWithArgs(
      atoken.write.mint([bob.account.address, ONE_TOKEN]),
      atoken,
      "Transfer",
      [zeroAddress, getAddress(bob.account.address), ONE_TOKEN],
    );
    assert.equal(await atoken.read.balanceOf([bob.account.address]), ONE_TOKEN);
    assert.equal(await atoken.read.totalSupply(), MINT_AMOUNT + ONE_TOKEN);
  });

  it("transfer reverts ComplianceRejected when the sender or the recipient is ineligible (sender checked first)", async function () {
    const { atoken, apass, alice, bob, stranger } = await deployCleanverseStack(connection);

    // recipient has no A-Pass
    await viem.assertions.revertWithCustomErrorWithArgs(
      atoken.write.transfer([stranger.account.address, ONE_TOKEN], { account: alice.account }),
      atoken,
      "ComplianceRejected",
      [getAddress(stranger.account.address), 2],
    );

    // sender frozen: reported even though the recipient is also ineligible
    await apass.write.setStatus([alice.account.address, 2]);
    await viem.assertions.revertWithCustomErrorWithArgs(
      atoken.write.transfer([stranger.account.address, ONE_TOKEN], { account: alice.account }),
      atoken,
      "ComplianceRejected",
      [getAddress(alice.account.address), 3],
    );
    await viem.assertions.revertWithCustomErrorWithArgs(
      atoken.write.transfer([bob.account.address, ONE_TOKEN], { account: alice.account }),
      atoken,
      "ComplianceRejected",
      [getAddress(alice.account.address), 3],
    );

    await apass.write.setStatus([alice.account.address, 1]);
    await atoken.write.transfer([bob.account.address, ONE_TOKEN], { account: alice.account });
    assert.equal(await atoken.read.balanceOf([bob.account.address]), ONE_TOKEN);
  });

  it("transferFrom checks from and to but not the spender", async function () {
    const { atoken, apass, alice, bob, stranger } = await deployCleanverseStack(connection);
    const spender = stranger; // holds no A-Pass at all

    await atoken.write.approve([spender.account.address, 10n * ONE_TOKEN], { account: alice.account });

    await viem.assertions.revertWithCustomErrorWithArgs(
      atoken.write.transferFrom([alice.account.address, spender.account.address, ONE_TOKEN], {
        account: spender.account,
      }),
      atoken,
      "ComplianceRejected",
      [getAddress(spender.account.address), 2],
    );

    await apass.write.setStatus([alice.account.address, 2]);
    await viem.assertions.revertWithCustomErrorWithArgs(
      atoken.write.transferFrom([alice.account.address, bob.account.address, ONE_TOKEN], { account: spender.account }),
      atoken,
      "ComplianceRejected",
      [getAddress(alice.account.address), 3],
    );
    await apass.write.setStatus([alice.account.address, 1]);

    // an ineligible spender can move funds between two eligible wallets
    await viem.assertions.emitWithArgs(
      atoken.write.transferFrom([alice.account.address, bob.account.address, ONE_TOKEN], { account: spender.account }),
      atoken,
      "Transfer",
      [getAddress(alice.account.address), getAddress(bob.account.address), ONE_TOKEN],
    );
    assert.equal(await atoken.read.balanceOf([bob.account.address]), ONE_TOKEN);
    assert.equal(await atoken.read.allowance([alice.account.address, spender.account.address]), 9n * ONE_TOKEN);
  });

  it("setPaused is owner-only and pausing blocks transfer, transferFrom and mint", async function () {
    const { atoken, alice, bob } = await deployCleanverseStack(connection);
    await atoken.write.approve([bob.account.address, ONE_TOKEN], { account: alice.account });

    await viem.assertions.revertWithCustomError(
      atoken.write.setPaused([true], { account: alice.account }),
      atoken,
      "NotOwner",
    );
    await viem.assertions.emitWithArgs(atoken.write.setPaused([true]), atoken, "PausedSet", [true]);
    assert.equal(await atoken.read.paused(), true);

    await viem.assertions.revertWithCustomError(
      atoken.write.transfer([bob.account.address, 1n], { account: alice.account }),
      atoken,
      "TokenPaused",
    );
    await viem.assertions.revertWithCustomError(
      atoken.write.transferFrom([alice.account.address, bob.account.address, 1n], { account: bob.account }),
      atoken,
      "TokenPaused",
    );
    await viem.assertions.revertWithCustomError(atoken.write.mint([bob.account.address, 1n]), atoken, "TokenPaused");

    await viem.assertions.emitWithArgs(atoken.write.setPaused([false]), atoken, "PausedSet", [false]);
    await atoken.write.transfer([bob.account.address, 1n], { account: alice.account });
    assert.equal(await atoken.read.balanceOf([bob.account.address]), 1n);
  });

  it("keeps ERC-20 accounting and emits Transfer / Approval correctly", async function () {
    const { atoken, alice, bob } = await deployCleanverseStack(connection);
    const a = getAddress(alice.account.address);
    const b = getAddress(bob.account.address);

    await viem.assertions.emitWithArgs(
      atoken.write.transfer([b, 250n * ONE_TOKEN], { account: alice.account }),
      atoken,
      "Transfer",
      [a, b, 250n * ONE_TOKEN],
    );
    assert.equal(await atoken.read.balanceOf([a]), MINT_AMOUNT - 250n * ONE_TOKEN);
    assert.equal(await atoken.read.balanceOf([b]), 250n * ONE_TOKEN);
    assert.equal(await atoken.read.totalSupply(), MINT_AMOUNT);

    await viem.assertions.revertWithCustomErrorWithArgs(
      atoken.write.transfer([a, 251n * ONE_TOKEN], { account: bob.account }),
      atoken,
      "InsufficientBalance",
      [b, 250n * ONE_TOKEN, 251n * ONE_TOKEN],
    );

    await viem.assertions.emitWithArgs(
      atoken.write.approve([b, 100n * ONE_TOKEN], { account: alice.account }),
      atoken,
      "Approval",
      [a, b, 100n * ONE_TOKEN],
    );
    assert.equal(await atoken.read.allowance([a, b]), 100n * ONE_TOKEN);

    await viem.assertions.revertWithCustomErrorWithArgs(
      atoken.write.transferFrom([a, b, 101n * ONE_TOKEN], { account: bob.account }),
      atoken,
      "InsufficientAllowance",
      [b, 100n * ONE_TOKEN, 101n * ONE_TOKEN],
    );
    await atoken.write.transferFrom([a, b, 40n * ONE_TOKEN], { account: bob.account });
    assert.equal(await atoken.read.allowance([a, b]), 60n * ONE_TOKEN);
    assert.equal(await atoken.read.balanceOf([b]), 290n * ONE_TOKEN);

    // an infinite allowance is never decremented
    await atoken.write.approve([b, maxUint256], { account: alice.account });
    await atoken.write.transferFrom([a, b, 10n * ONE_TOKEN], { account: bob.account });
    assert.equal(await atoken.read.allowance([a, b]), maxUint256);
    assert.equal(await atoken.read.balanceOf([a]), MINT_AMOUNT - 300n * ONE_TOKEN);
    assert.equal(await atoken.read.totalSupply(), MINT_AMOUNT);
  });
});
