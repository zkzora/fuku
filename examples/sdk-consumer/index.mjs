#!/usr/bin/env node
/**
 * A tiny external consumer of @fuku/sdk: it only talks to Fuku through the SDK (the same public API
 * and enforcement path as everyone else), keeps its agent's key to itself, and checks the chain itself
 * instead of trusting Fuku.
 *
 *   1. register an agent through its owner, with an agent key generated here   registerAgent
 *   2. the owner's approval: passport in Fuku, mandate from the owner's wallet  requestPermission, getMandate
 *   3. ERC-8004: the owner's wallet registers the agent, the agent key proves   setErc8004AgentKey, getErc8004,
 *      itself, and the chain says who holds what                                prepareErc8004AgentWallet, confirmErc8004
 *   4. preview an A-Token payment                                                checkPermission
 *   5. submit it signed by the agent key (with an idempotency key), retry once   executeAction({ signer })
 *   6. read the receipt and verify it on-chain                                   getAction + viem
 *   7. revoke access, and prove the next attempt fails                          revokePermission, executeAction
 *
 * Run against a Fuku instance whose chain is live, after `npm run build -w sdk`. A local Hardhat node
 * works (docs/CLEANVERSE.md "Run it locally"); ERC-8004 needs the canonical registry, so step 3 runs on
 * Monad testnet or a local fork of it and is skipped elsewhere.
 *
 *   FUKU_BASE_URL=http://localhost:3002 FUKU_API_KEY=fk_live_demo_ava_chen_2026 \
 *   OWNER_PRIVATE_KEY=<the owner's wallet: Hardhat #2 for the demo owner locally> \
 *   MONAD_RPC_URL=http://127.0.0.1:8545 node examples/sdk-consumer/index.mjs
 *
 * The demo key belongs to the seeded owner (Ava); the agent this creates is a new one, and the seeded
 * demo agents are not touched. A third-party app would use its own key and a delegation from the owner.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeFunctionData, http, isAddressEqual, keccak256, parseAbi, parseEventLogs, stringToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { Fuku, FukuError } from "../../sdk/dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const baseUrl = process.env.FUKU_BASE_URL ?? "http://localhost:3002";
const apiKey = process.env.FUKU_API_KEY ?? "fk_live_demo_ava_chen_2026";
const rpc = process.env.MONAD_RPC_URL ?? "http://127.0.0.1:8545";
const ownerKey = process.env.OWNER_PRIVATE_KEY?.trim();
if (!ownerKey) throw new Error("set OWNER_PRIVATE_KEY: the owner's wallet sends the mandate and the ERC-8004 transactions");
// Same deterministic demo recipient as the app (Nusantara Supplies, an A-Pass holder).
const supplier = privateKeyToAddress(keccak256(stringToHex("fuku:demo:nusantara")));
const guardAbi = JSON.parse(readFileSync(path.resolve(here, "../../contracts/abi/FukuSpendGuard.json"), "utf8"));
const identityRegistryAbi = parseAbi(["function ownerOf(uint256) view returns (address)", "function getAgentWallet(uint256) view returns (address)"]);

const fuku = new Fuku({ apiKey, baseUrl });
const client = createPublicClient({ transport: http(rpc) });
const chainId = await client.getChainId();
const owner = privateKeyToAccount(ownerKey.startsWith("0x") ? ownerKey : `0x${ownerKey}`);
const ownerWallet = createWalletClient({
  account: owner,
  transport: http(rpc),
  chain: { id: chainId, name: "fuku", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } },
});
/** The owner's wallet signs and pays; Fuku never does. */
const send = async ({ to, data }) => {
  const hash = await ownerWallet.sendTransaction({ to, data });
  const rc = await client.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(`owner transaction ${hash} reverted`);
  return hash;
};

const step = (n, text) => console.log(`\n${n}. ${text}`);
let failures = 0;
const expect = (ok, what, detail = "") => {
  console.log(`   ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};

step(1, "Register an agent through its owner, with an agent key generated here (it never leaves this process)");
const agentKey = privateKeyToAccount(generatePrivateKey());
const { agent } = await fuku.registerAgent({ name: `SDK consumer ${Date.now()}`, capabilities: ["transfer", "read_balances"], description: "Pays one supplier in aUSDC." });
const agentId = agent.id;
expect(Boolean(agentId), `agent ${agentId}`, `agent key ${agentKey.address}`);

step(2, "Owner approval: the passport (Fuku) and the mandate (the owner's own wallet, on-chain)");
const passport = {
  allowed: [{ action: "transfer", limitUsdcPerDay: 1000 }, { action: "read_balances" }],
  blocked: ["withdraw", "change_owner"],
  scopeApps: [],
  assets: ["aUSDC"],
};
const approved = await fuku.requestPermission(agentId, passport);
expect(approved.agent.policy?.active === true, `passport v${approved.agent.policy?.version} approved`, `anchor ${approved.receipt.status} ${approved.receipt.txHash ?? ""}`);
const target = await fuku.getMandate(agentId);
expect(Boolean(target.guard && target.token) && isAddressEqual(target.wallet, owner.address), "Fuku names the guard, the A-Token and the owner's wallet", `${target.guard} / ${target.token}`);
const opened = await send({ to: target.guard, data: encodeFunctionData({ abi: guardAbi, functionName: "openMandate", args: [target.agentKey, target.token, 1_000_000_000n, 500_000_000n, 0n, true] }) });
const payee = await send({ to: target.guard, data: encodeFunctionData({ abi: guardAbi, functionName: "setPayee", args: [target.agentKey, supplier, true] }) });
const { mandate } = await fuku.getMandate(agentId);
expect(Boolean(mandate?.active), "the owner's wallet opened the mandate and approved the supplier", `openMandate ${opened}, setPayee ${payee}; ${mandate?.dailyCapUsdc}/day, max ${mandate?.maxPerTxUsdc}`);

step(3, "ERC-8004: the owner's wallet registers the agent, the agent key proves itself");
let erc = await fuku.setErc8004AgentKey(agentId, agentKey.address);
if (erc.reason === "unsupported-chain" || erc.reason === "mock-chain") {
  console.log(`   skipped: ${erc.reason} (no canonical ERC-8004 Identity Registry on chain ${erc.chainId})`);
} else {
  expect(erc.agentKeySource === "external" && erc.actions[0]?.op === "erc8004Register", "the agent key is ours; Fuku prepares register(agentURI) for the owner", `${erc.agentURIKind} agentURI${erc.reason ? `, ${erc.reason}` : ""}`);
  const registered = await send(erc.actions[0].tx);
  const conf = await fuku.confirmErc8004(agentId, { op: "erc8004Register", txHash: registered });
  erc = await fuku.getErc8004(agentId);
  const td = erc.agentWalletTypedData;
  expect(Boolean(td), `ERC-8004 agent #${conf.agentId}; Fuku hands out the AgentWalletSet for our key to sign`, `register ${registered}`);
  const signature = await agentKey.signTypedData({
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: { agentId: BigInt(td.message.agentId), newWallet: td.message.newWallet, owner: td.message.owner, deadline: BigInt(td.message.deadline) },
  });
  const { action } = await fuku.prepareErc8004AgentWallet(agentId, { signature, deadline: td.message.deadline });
  const bound = await send(action.tx);
  await fuku.confirmErc8004(agentId, { op: "erc8004SetAgentWallet", txHash: bound });
  const id = BigInt(conf.agentId);
  const [nftOwner, agentWallet] = await Promise.all([
    client.readContract({ address: erc.registry, abi: identityRegistryAbi, functionName: "ownerOf", args: [id] }),
    client.readContract({ address: erc.registry, abi: identityRegistryAbi, functionName: "getAgentWallet", args: [id] }),
  ]);
  expect(isAddressEqual(nftOwner, owner.address) && isAddressEqual(agentWallet, agentKey.address), "on-chain: the owner's wallet holds the agent, and its agentWallet is our key", `setAgentWallet ${bound}`);
}

step(4, "Preview a 25 aUSDC payment to the supplier (nothing recorded, reserved or signed)");
const preview = await fuku.checkPermission(agentId, { action: "transfer", amountUsdc: 25, to: supplier, asset: "aUSDC" });
expect(preview.preview === true && preview.allowed, `preview ${preview.decision} ${preview.ruleId}`, preview.reason);

step(5, "Submit it signed with the agent key and an idempotency key, then retry with the same key");
const key = Fuku.newIdempotencyKey();
// The agent holds its own key, so Fuku accepts its executions only signed with it.
const first = await fuku.executeAction(agentId, { action: "transfer", amountUsdc: 25, to: supplier, asset: "aUSDC" }, { idempotencyKey: key, signer: agentKey });
expect(first.status === "CONFIRMED" && first.agentSignature?.signer === agentKey.address, `executed: ${first.status}, signed by the agent key`, `tx ${first.transfer?.txHash}`);
const retry = await fuku.executeAction(agentId, { action: "transfer", amountUsdc: 25, to: supplier, asset: "aUSDC" }, { idempotencyKey: key, signer: agentKey });
expect(retry.replayed === true && retry.id === first.id, "the retry replays the same result instead of paying again");

step(6, "Read the receipt, then verify it on-chain without trusting Fuku");
const receipt = await fuku.getAction(first.id);
expect(receipt.status === "CONFIRMED", `receipt ${receipt.status}`, `chain ${receipt.receipt.chainId}, block ${receipt.receipt.blockNumber}, log #${receipt.receipt.logIndex}`);
const tx = await client.getTransactionReceipt({ hash: receipt.receipt.transferTxHash });
const [executed] = parseEventLogs({ abi: guardAbi, eventName: "GuardedTransferExecuted", logs: tx.logs });
expect(tx.status === "success", "the transaction succeeded on-chain");
expect(executed?.args.actionHash === receipt.actionHash, "GuardedTransferExecuted is bound to this action's hash");
expect(executed?.args.to.toLowerCase() === supplier.toLowerCase() && executed?.args.amount === BigInt(receipt.amountBaseUnits), "it moved exactly the attested amount to the supplier", `${executed?.args.amount} base units`);
expect(executed?.args.complianceRef === first.compliance?.complianceRef, "and carries the Cleanverse complianceRef", first.compliance?.mode);

step(7, "Revoke access; the next attempt fails");
const revoked = await fuku.revokePermission(agentId);
expect(revoked.chainSync.ok, "passport revoked in Fuku and on-chain", revoked.chainSync.receipts.map((r) => `${r.op} ${r.status}`).join(", "));
const after = await fuku.executeAction(agentId, { action: "transfer", amountUsdc: 25, to: supplier, asset: "aUSDC" }, { signer: agentKey });
expect(after.decision === "BLOCKED" && after.status === "DENIED", `executeAction: ${after.decision} ${after.ruleId}`, after.reason);
const previewAfter = await fuku.checkPermission(agentId, { action: "transfer", amountUsdc: 25, to: supplier, asset: "aUSDC" });
expect(!previewAfter.allowed, `checkPermission: ${previewAfter.decision} ${previewAfter.ruleId}`);
try {
  await fuku.registerAgent({ name: "Someone else's", capabilities: ["swap"], ownerIdentityId: "fuku:id:0x0000000000000000000000000000000000000001" });
  expect(false, "registering under an owner without a delegation is refused");
} catch (err) {
  expect(err instanceof FukuError && (err.code === "forbidden" || err.code === "not_found"), "registering under an owner without a delegation is refused", err instanceof FukuError ? `${err.status} ${err.code}` : String(err));
}

console.log(failures ? `\n${failures} step(s) failed` : "\nAll steps behaved as expected.");
process.exitCode = failures ? 1 : 0;
