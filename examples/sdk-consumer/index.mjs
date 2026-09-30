#!/usr/bin/env node
/**
 * A tiny external consumer of @fuku/sdk: it only talks to Fuku through the SDK (the same public API
 * and enforcement path as everyone else), and it checks the chain itself instead of trusting Fuku.
 *
 *   1. load an agent and verify it                      verifyAgent
 *   2. the owner's approval: passport + on-chain mandate requestPermission, getMandate
 *   3. preview an A-Token payment                       checkPermission
 *   4. submit it (with an idempotency key), retry once  executeAction
 *   5. read the receipt and verify it on-chain          getAction + viem
 *   6. revoke access                                    revokePermission
 *   7. prove the next attempt fails                     executeAction, checkPermission
 *
 * Run against a Fuku instance whose chain is live (a local Hardhat node works, see
 * docs/CLEANVERSE.md "Run it locally"), after `npm run build -w sdk`:
 *
 *   FUKU_BASE_URL=http://localhost:3002 FUKU_API_KEY=fk_live_demo_ava_chen_2026 \
 *   MONAD_RPC_URL=http://127.0.0.1:8545 node examples/sdk-consumer/index.mjs
 *
 * The demo key belongs to the seeded owner (Ava). A third-party app would use its own key and an
 * agents:execute delegation from the owner. Reset the demo afterwards (/api/auth/demo?reset=1).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, keccak256, parseEventLogs, stringToHex } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { Fuku, FukuError } from "../../sdk/dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const baseUrl = process.env.FUKU_BASE_URL ?? "http://localhost:3002";
const apiKey = process.env.FUKU_API_KEY ?? "fk_live_demo_ava_chen_2026";
const agentId = process.env.FUKU_AGENT_ID ?? "fuku:agent:0x9a7e3c1d5b8f2a4c6e0d1b3f5a7c9e1d3b5f7a92"; // seeded Payments Agent
const rpc = process.env.MONAD_RPC_URL ?? "http://127.0.0.1:8545";
// Same deterministic demo recipient as the app (Nusantara Supplies, an approved payee).
const supplier = privateKeyToAddress(keccak256(stringToHex("fuku:demo:nusantara")));
const guardAbi = JSON.parse(readFileSync(path.resolve(here, "../../contracts/abi/FukuSpendGuard.json"), "utf8"));

const fuku = new Fuku({ apiKey, baseUrl });
const step = (n, text) => console.log(`\n${n}. ${text}`);
let failures = 0;
const expect = (ok, what, detail = "") => {
  console.log(`   ${ok ? "ok  " : "FAIL"} ${what}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
};

step(1, "Load the agent and ask Fuku what backs it");
const v = await fuku.verifyAgent(agentId);
expect(Boolean(v.agent), `agent ${v.agent?.name}`, `owner ${v.owner?.displayName}`);
console.log(`   verified=${v.verified} · anchoring ${v.checks?.anchoring.status} · owner passkey ${v.checks?.owner.passkey.status} · wallet ${v.checks?.owner.wallet.status} · unique human ${v.checks?.owner.uniqueHuman.status}`);

step(2, "Owner approval: the passport (Fuku) and the mandate (the owner's own wallet, on-chain)");
const passport = {
  allowed: [{ action: "transfer", limitUsdcPerDay: 1000 }, { action: "read_balances" }],
  blocked: ["withdraw", "change_owner"],
  scopeApps: [],
  assets: ["aUSDC"],
};
const approved = await fuku.requestPermission(agentId, passport);
expect(approved.agent.policy?.active === true, `passport v${approved.agent.policy?.version} approved`, `anchor ${approved.receipt.status} ${approved.receipt.txHash ?? ""}`);
const { mandate, reason } = await fuku.getMandate(agentId);
expect(Boolean(mandate?.active), "owner's on-chain mandate is open", mandate ? `${mandate.dailyCapUsdc}/day, max ${mandate.maxPerTxUsdc} per transfer, payees restricted ${mandate.restrictPayees}, v${mandate.version}` : reason);

step(3, "Preview a 25 aUSDC payment to the supplier (nothing recorded, reserved or signed)");
const preview = await fuku.checkPermission(agentId, { action: "transfer", amountUsdc: 25, to: supplier, asset: "aUSDC" });
expect(preview.preview === true && preview.allowed, `preview ${preview.decision} ${preview.ruleId}`, preview.reason);

step(4, "Submit it with an idempotency key, then retry with the same key");
const key = Fuku.newIdempotencyKey();
const first = await fuku.executeAction(agentId, { action: "transfer", amountUsdc: 25, to: supplier, asset: "aUSDC" }, { idempotencyKey: key });
expect(first.status === "CONFIRMED", `executed: ${first.status}`, `tx ${first.transfer?.txHash}`);
const retry = await fuku.executeAction(agentId, { action: "transfer", amountUsdc: 25, to: supplier, asset: "aUSDC" }, { idempotencyKey: key });
expect(retry.replayed === true && retry.id === first.id, "the retry replays the same result instead of paying again");

step(5, "Read the receipt, then verify it on-chain without trusting Fuku");
const receipt = await fuku.getAction(first.id);
expect(receipt.status === "CONFIRMED", `receipt ${receipt.status}`, `chain ${receipt.receipt.chainId}, block ${receipt.receipt.blockNumber}, log #${receipt.receipt.logIndex}`);
const client = createPublicClient({ transport: http(rpc) });
const tx = await client.getTransactionReceipt({ hash: receipt.receipt.transferTxHash });
const [executed] = parseEventLogs({ abi: guardAbi, eventName: "GuardedTransferExecuted", logs: tx.logs });
expect(tx.status === "success", "the transaction succeeded on-chain");
expect(executed?.args.actionHash === receipt.actionHash, "GuardedTransferExecuted is bound to this action's hash");
expect(executed?.args.to.toLowerCase() === supplier.toLowerCase() && executed?.args.amount === BigInt(receipt.amountBaseUnits), "it moved exactly the attested amount to the supplier", `${executed?.args.amount} base units`);
expect(executed?.args.complianceRef === first.compliance?.complianceRef, "and carries the Cleanverse complianceRef", first.compliance?.mode);

step(6, "Revoke access");
const revoked = await fuku.revokePermission(agentId);
expect(revoked.chainSync.ok, "passport revoked in Fuku and on-chain", revoked.chainSync.receipts.map((r) => `${r.op} ${r.status}`).join(", "));

step(7, "The next attempt fails");
const after = await fuku.executeAction(agentId, { action: "transfer", amountUsdc: 25, to: supplier, asset: "aUSDC" }, { idempotencyKey: Fuku.newIdempotencyKey() });
expect(after.decision === "BLOCKED" && after.status === "DENIED", `executeAction: ${after.decision} ${after.ruleId}`, after.reason);
const previewAfter = await fuku.checkPermission(agentId, { action: "transfer", amountUsdc: 25, to: supplier, asset: "aUSDC" });
expect(!previewAfter.allowed, `checkPermission: ${previewAfter.decision} ${previewAfter.ruleId}`);
try {
  await fuku.registerAgent({ name: "Someone else's", capabilities: ["swap"], ownerIdentityId: "fuku:id:0x0000000000000000000000000000000000000001" });
  expect(false, "registering under an owner without a delegation is refused");
} catch (err) {
  expect(err instanceof FukuError && (err.code === "forbidden" || err.code === "not_found"), "registering under an owner without a delegation is refused", err instanceof FukuError ? `${err.status} ${err.code}` : String(err));
}

console.log(failures ? `\n${failures} step(s) failed` : "\nAll steps behaved as expected. Reset the demo with /api/auth/demo?reset=1.");
process.exit(failures ? 1 : 0);
