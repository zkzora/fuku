#!/usr/bin/env tsx
/**
 * npm run owner-path:local: the owner-controlled path end to end, with the money, on a LOCAL node.
 * The registries are the deployed ones (no redeploy): an identity whose wallet is bound before its
 * first on-chain write is owner-controlled (lib/custody.ts), and this checks that everything that
 * matters for it is the owner's wallet's doing, read back from the chain:
 *
 *   1. wallet binding by signature; the identity and agent are registered and the passport anchored by
 *      transactions the OWNER's wallet sends (Fuku prepares calldata and confirms receipts);
 *      controllerOf(identity) is the owner's wallet and the relayer cannot revoke or pause;
 *   2. a value action is refused (R11) until the owner is passkey-verified;
 *   3. no transfer moves without the owner's mandate; the owner's wallet opens it (FukuSpendGuard),
 *      and only payees the owner's wallet approved can be paid;
 *   4. an allowed transfer moves exactly its amount from the owner's wallet, checked from the event
 *      and the balances; over the per-transfer limit nothing moves;
 *   5. revoke: removing the payee, closing the mandate, and the kill switch (Fuku blocks at once; the
 *      owner's wallet signs revokePolicy) each stop transfers.
 *
 * What is NOT real here, and why (each is printed as it happens):
 *   - the passkey ceremony is interactive (WebAuthn): the script sets Identity.humanVerified directly
 *     in the local database as a stand-in. docs/DEMO-READINESS.md lists the interactive check.
 *   - A-Pass and aUSDC-SIM come from Fuku's Cleanverse SIMULATOR contracts (the deployer issues and
 *     mints), not from Cleanverse.
 *
 * It refuses any chain but a local Hardhat node (31337): it mints simulator tokens, funds a fresh
 * owner wallet and writes to the database directly. Environment: the local stack's (FUKU_BASE_URL,
 * MONAD_RPC_URL, DATABASE_URL of that app, DEPLOYER_PRIVATE_KEY, the contract addresses). The app key
 * is the demo key (FUKU_OWNER_API_KEY to override); it manages the identity it creates.
 * Exit code 0 when every check passes.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  http,
  parseEventLogs,
  parseEther,
  stringToHex,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const DEMO_API_KEY = "fk_live_demo_ava_chen_2026";
const AMOUNT = 30;
const results: { name: string; ok: boolean; detail: string }[] = [];
const txs: { by: string; label: string; hash: Hex }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  return ok;
};
const note = (line: string) => console.log(`  · ${line}`);

function env(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set (run with the local stack's environment)`);
  return v;
}

function revertName(err: unknown): string {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? "reverted";
  }
  return err instanceof Error ? err.message.slice(0, 80) : String(err);
}

async function main() {
  const rpc = env("MONAD_RPC_URL");
  const baseUrl = (process.env.FUKU_BASE_URL?.trim() || "http://localhost:3002").replace(/\/+$/, "");
  const pub = createPublicClient({ transport: http(rpc) });
  const chainId = await pub.getChainId();
  if (chainId !== 31337) throw new Error(`chain ${chainId} is not a local Hardhat node (31337): this check mints simulator tokens and writes the database directly`);
  const chain = { id: chainId, name: "local", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as const;

  const { Fuku } = await import("../../sdk/src/index");
  const { db } = await import("../src/lib/db");
  const { idToBytes32 } = await import("../src/lib/ids");
  const abi = await import("../src/lib/chain/abi");
  const { DEMO_RECIPIENTS } = await import("../src/lib/cleanverse/demo");

  const fuku = new Fuku({ apiKey: process.env.FUKU_OWNER_API_KEY?.trim() || DEMO_API_KEY, baseUrl });
  const deployer = privateKeyToAccount(env("DEPLOYER_PRIVATE_KEY") as Hex);
  const asDeployer = createWalletClient({ account: deployer, chain, transport: http(rpc) });
  const owner = privateKeyToAccount(generatePrivateKey());
  const asOwner = createWalletClient({ account: owner, chain, transport: http(rpc) });
  const a = {
    identity: env("FUKU_IDENTITY_REGISTRY") as Address,
    agents: env("FUKU_AGENT_REGISTRY") as Address,
    permissions: env("FUKU_PERMISSION_REGISTRY") as Address,
    guard: env("FUKU_SPEND_GUARD") as Address,
    apass: env("CLEANVERSE_SIM_APASS") as Address,
    token: env("CLEANVERSE_SIM_ATOKEN") as Address,
  };
  const nusantara = DEMO_RECIPIENTS.find((r) => r.label === "nusantara")!.address as Address;
  const mined = async (by: string, label: string, hash: Hex) => {
    const rc = await pub.waitForTransactionReceipt({ hash });
    txs.push({ by, label, hash });
    if (rc.status !== "success") throw new Error(`${label} reverted (${hash})`);
    return rc;
  };
  const ownerSends = (label: string, tx: { to: Address; data: Hex }) => asOwner.sendTransaction(tx).then((h) => mined("owner", label, h));
  const balance = (who: Address) => pub.readContract({ address: a.token, abi: abi.CleanverseATokenSimAbi, functionName: "balanceOf", args: [who] });
  const freshBlock = () => pub.request({ method: "evm_mine" as never, params: [] as never });

  console.log(`Owner-controlled path on chain ${chainId} (${rpc}), Fuku at ${baseUrl}`);
  console.log(`  owner wallet ${owner.address} (fresh for this run), relayer/deployer ${deployer.address}`);
  await mined("deployer", "fund the owner wallet with 1 ETH (local gas)", await asDeployer.sendTransaction({ to: owner.address, value: parseEther("1") }));

  // 1. Identity, wallet binding, owner-signed registry writes
  console.log("\n1. Owner custody: wallet binding and owner-signed registry writes");
  const { identity } = await fuku.createIdentity({ displayName: `Owner path ${new Date().toISOString().slice(0, 19)}` });
  const ch = await fuku.walletChallenge(identity.id, owner.address);
  const bound = await fuku.bindWallet(identity.id, { challengeId: ch.challengeId, signature: await owner.signMessage({ message: ch.message }) });
  check("the owner wallet is bound by a signature over Fuku's challenge", bound.identity.walletVerifiedBy === "signature" && bound.identity.walletAddress.toLowerCase() === owner.address.toLowerCase());
  const { agent, receipt } = await fuku.registerAgent({ name: "Owner-path payer", capabilities: ["transfer", "read_balances"], ownerIdentityId: identity.id });
  check("registering the agent waits for the owner (the relayer sends nothing)", receipt.status === "awaiting-owner", String(receipt.status));
  const passport = { allowed: [{ action: "transfer", limitUsdcPerDay: 100 }, { action: "read_balances" }], blocked: ["withdraw"], scopeApps: [], assets: ["aUSDC"] };
  const pol = await fuku.requestPermission(agent.id, passport);
  check("approving its A-Token passport waits for the owner", pol.receipt.status === "awaiting-owner", String(pol.receipt.status));
  const pending = await fuku.getOwnerActions(identity.id);
  check("Fuku lists the writes for the owner's wallet", pending.actions.map((x) => x.op).join(",") === "registerIdentity,registerAgent,setPolicy", pending.actions.map((x) => x.op).join(", "));
  for (const action of pending.actions) {
    const rc = await ownerSends(action.op, { to: action.tx.to as Address, data: action.tx.data as Hex });
    const conf = await fuku.confirmOwnerAction(identity.id, { op: action.op, txHash: rc.transactionHash, agentId: action.agentId });
    check(`owner-signed ${action.op} mined, then confirmed by Fuku from the receipt`, conf.ok === true && rc.from.toLowerCase() === owner.address.toLowerCase(), `from ${rc.from}`);
  }
  const identityKey = idToBytes32(identity.id);
  const agentKey = idToBytes32(agent.id);
  const controller = await pub.readContract({ address: a.identity, abi: abi.HumanIdentityRegistryAbi, functionName: "controllerOf", args: [identityKey] });
  check("controllerOf(identity) is the owner's wallet", controller.toLowerCase() === owner.address.toLowerCase(), controller);
  const relayerCtl = await pub.readContract({ address: a.agents, abi: abi.AgentRegistryAbi, functionName: "isOwnerController", args: [agentKey, deployer.address] });
  check("the relayer does not control the agent", relayerCtl === false);
  const relayerRevoke = await pub
    .simulateContract({ address: a.permissions, abi: abi.PermissionRegistryAbi, functionName: "revokePolicy", args: [agentKey], account: deployer.address })
    .then(() => "ok")
    .catch(revertName);
  check("the relayer cannot revoke the passport on-chain", relayerRevoke === "NotAgentOwner", relayerRevoke);
  const v = await fuku.verifyAgent(agent.id);
  check("verifyAgent reports owner custody", v.owner?.custody === "owner", String(v.owner?.custody));

  // 2. R11 until the owner is passkey-verified
  console.log("\n2. Owner verification (R11)");
  const r11 = await fuku.executeAction(agent.id, { action: "transfer", amountUsdc: AMOUNT, to: nusantara, asset: "aUSDC" });
  check("a transfer before passkey verification is BLOCKED R11", r11.decision === "BLOCKED" && r11.ruleId === "R11", `${r11.ruleId} ${r11.subCode ?? ""}`);
  await db.identity.update({ where: { id: identity.id }, data: { humanVerified: true } });
  note("LOCAL STAND-IN: Identity.humanVerified set in the database; on a real deployment the owner completes the passkey ceremony in the app");

  // 3. Simulator funding, then the owner's mandate and payees
  console.log("\n3. The owner's mandate and payees (FukuSpendGuard)");
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 3600);
  await mined("deployer", "SIMULATOR A-Pass for the owner wallet", await asDeployer.writeContract({ address: a.apass, abi: abi.CleanverseAPassSimAbi, functionName: "issue", args: [owner.address, { status: 1, tier: 2, subTier: 0, group: zeroHash, subGroup: zeroHash, expiresAt, cvRecordId: stringToHex("owner-path", { size: 32 }) }] }));
  await mined("deployer", "SIMULATOR mint 200 aUSDC-SIM to the owner", await asDeployer.writeContract({ address: a.token, abi: abi.CleanverseATokenSimAbi, functionName: "mint", args: [owner.address, BigInt(200_000_000)] }));
  note("SIMULATED: the A-Pass and aUSDC-SIM come from Fuku's Cleanverse simulator contracts");

  await freshBlock();
  const noMandate = await fuku.executeAction(agent.id, { action: "transfer", amountUsdc: AMOUNT, to: nusantara, asset: "aUSDC" });
  check("without the owner's mandate the transfer is BLOCKED and nothing moves", noMandate.decision === "BLOCKED" && (await balance(owner.address)) === BigInt(200_000_000), `${noMandate.ruleId} ${noMandate.subCode ?? ""}: ${noMandate.reason}`);

  const target = await fuku.getMandate(agent.id);
  check("Fuku names the owner's bound wallet, the guard and the token for the mandate", target.wallet?.toLowerCase() === owner.address.toLowerCase() && target.guard?.toLowerCase() === a.guard.toLowerCase() && target.token?.toLowerCase() === a.token.toLowerCase());
  await ownerSends("approve guard 200 aUSDC-SIM", { to: a.token, data: encode(abi.CleanverseATokenSimAbi, "approve", [a.guard, BigInt(200_000_000)]) });
  const until = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
  await ownerSends("openMandate 100/day, 50/transfer, payees only", { to: a.guard, data: encode(abi.FukuSpendGuardAbi, "openMandate", [agentKey, a.token, BigInt(100_000_000), BigInt(50_000_000), until, true]) });
  const m = await pub.readContract({ address: a.guard, abi: abi.FukuSpendGuardAbi, functionName: "mandates", args: [agentKey, owner.address] });
  check("the mandate is keyed to the owner's wallet: 100 a day, 50 per transfer, payees only, active", m[1] === BigInt(100_000_000) && m[2] === BigInt(50_000_000) && m[4] === true && m[6] === true);

  await freshBlock();
  const unapproved = await fuku.executeAction(agent.id, { action: "transfer", amountUsdc: AMOUNT, to: nusantara, asset: "aUSDC" });
  check("before the owner approves the payee the transfer is BLOCKED", unapproved.decision === "BLOCKED", `${unapproved.ruleId} ${unapproved.subCode ?? ""}: ${unapproved.reason}`);
  await ownerSends("setPayee Nusantara", { to: a.guard, data: encode(abi.FukuSpendGuardAbi, "setPayee", [agentKey, nusantara, true]) });

  // 4. Transfer, checked from the chain
  console.log("\n4. Transfer from the owner's wallet");
  await freshBlock();
  const [ownerBefore, payeeBefore] = [await balance(owner.address), await balance(nusantara)];
  const paid = await fuku.executeAction(agent.id, { action: "transfer", amountUsdc: AMOUNT, to: nusantara, asset: "aUSDC" }, { idempotencyKey: `owner-path-${Date.now()}` });
  check(`a ${AMOUNT} aUSDC transfer to the approved payee is CONFIRMED`, paid.status === "CONFIRMED", `${paid.status} ${paid.reason}`);
  const tx = paid.transfer?.txHash as Hex | undefined;
  if (tx) {
    const rc = await pub.getTransactionReceipt({ hash: tx });
    const [ev] = parseEventLogs({ abi: abi.FukuSpendGuardAbi, eventName: "GuardedTransferExecuted", logs: rc.logs });
    check(
      "GuardedTransferExecuted: from the owner's wallet, to the payee, exactly the amount, under the owner's mandate",
      Boolean(ev) && ev.args.from.toLowerCase() === owner.address.toLowerCase() && ev.args.to.toLowerCase() === nusantara.toLowerCase() && ev.args.amount === BigInt(AMOUNT * 1e6) && ev.args.mandateVersion === m[5],
      tx,
    );
    txs.push({ by: "relayer", label: "guarded transfer", hash: tx });
  }
  check("balances moved exactly once", ownerBefore - (await balance(owner.address)) === BigInt(AMOUNT * 1e6) && (await balance(nusantara)) - payeeBefore === BigInt(AMOUNT * 1e6));
  await freshBlock();
  const over = await fuku.executeAction(agent.id, { action: "transfer", amountUsdc: 60, to: nusantara, asset: "aUSDC" });
  check("60 aUSDC (over the owner's 50 per transfer) is BLOCKED and nothing moves", over.decision === "BLOCKED" && (await balance(nusantara)) - payeeBefore === BigInt(AMOUNT * 1e6), `${over.ruleId} ${over.subCode ?? ""}`);

  // 5. Revoke: payee, mandate, passport
  console.log("\n5. Revocation by the owner");
  const small = { action: "transfer", amountUsdc: 5, to: nusantara, asset: "aUSDC" } as const;
  await ownerSends("setPayee Nusantara false", { to: a.guard, data: encode(abi.FukuSpendGuardAbi, "setPayee", [agentKey, nusantara, false]) });
  await freshBlock();
  const noPayee = await fuku.executeAction(agent.id, small);
  check("after the owner removes the payee, a transfer is BLOCKED", noPayee.decision === "BLOCKED", `${noPayee.ruleId} ${noPayee.subCode ?? ""}`);
  await ownerSends("setPayee Nusantara true", { to: a.guard, data: encode(abi.FukuSpendGuardAbi, "setPayee", [agentKey, nusantara, true]) });
  await ownerSends("closeMandate", { to: a.guard, data: encode(abi.FukuSpendGuardAbi, "closeMandate", [agentKey]) });
  await freshBlock();
  const closed = await fuku.executeAction(agent.id, small);
  check("after the owner closes the mandate, a transfer is BLOCKED", closed.decision === "BLOCKED", `${closed.ruleId} ${closed.subCode ?? ""}`);
  await ownerSends("openMandate again", { to: a.guard, data: encode(abi.FukuSpendGuardAbi, "openMandate", [agentKey, a.token, BigInt(100_000_000), BigInt(50_000_000), until, true]) });
  await freshBlock();
  const reopened = await fuku.executeAction(agent.id, small);
  check("re-opened by the owner, a 5 aUSDC transfer is CONFIRMED again", reopened.status === "CONFIRMED", `${reopened.status} ${reopened.reason}`);

  const balanceBeforeRevoke = await balance(nusantara);
  const rev = await fuku.revokePermission(agent.id);
  const revReceipt = rev.chainSync.receipts.find((r) => r.op === "revokePolicy");
  check("the kill switch in Fuku asks the owner's wallet to sign revokePolicy", revReceipt?.status === "awaiting-owner", String(revReceipt?.status));
  await freshBlock();
  const killed = await fuku.executeAction(agent.id, small);
  check("Fuku blocks the agent at once, before the owner signs (R0/R1)", killed.decision === "BLOCKED" && ["R0", "R1"].includes(killed.ruleId ?? ""), `${killed.ruleId}`);
  const revokeAction = (await fuku.getOwnerActions(identity.id)).actions.find((x) => x.op === "revokePolicy");
  if (check("Fuku prepared revokePolicy for the owner", Boolean(revokeAction))) {
    const rc = await ownerSends("revokePolicy", { to: revokeAction!.tx.to as Address, data: revokeAction!.tx.data as Hex });
    const conf = await fuku.confirmOwnerAction(identity.id, { op: "revokePolicy", txHash: rc.transactionHash, agentId: agent.id });
    const active = await pub.readContract({ address: a.permissions, abi: abi.PermissionRegistryAbi, functionName: "hasActivePolicy", args: [agentKey] });
    check("the owner's revokePolicy is confirmed; the passport is inactive on-chain (the guard refuses PolicyNotActive)", conf.ok === true && active === false);
  }
  check("nothing moved after the kill switch", (await balance(nusantara)) === balanceBeforeRevoke);

  console.log(`\n  identity ${identity.id}\n  agent    ${agent.id}`);
  console.log("  transactions:");
  for (const t of txs) console.log(`    ${t.by.padEnd(8)} ${t.label.padEnd(48)} ${t.hash}`);
  console.log(`  owner wallet ETH left: ${formatEther(await pub.getBalance({ address: owner.address }))}`);
  await db.$disconnect();
}

function encode(abiItems: readonly unknown[], functionName: string, args: readonly unknown[]): Hex {
  // viem's encodeFunctionData, typed loosely: the ABIs are app constants.
  const encodeLoose = encodeFunctionData as unknown as (p: { abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) => Hex;
  return encodeLoose({ abi: abiItems, functionName, args });
}

main()
  .catch((err) => check("the run completed", false, err instanceof Error ? err.message : String(err)))
  .finally(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed: ${failed.map((f) => f.name).join("; ")}` : ""}`);
    process.exitCode = failed.length ? 1 : 0;
  });
