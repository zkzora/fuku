#!/usr/bin/env tsx
/**
 * npm run verify:transfer -- <txHash> [--agent <fuku:agent:…>] [--action <action id>] [--to <0x…>] [--amount <30>]
 *
 * Independent check of a guarded transfer: reads only the chain (MONAD_RPC_URL) with the deployed
 * contracts' ABI, never Fuku's API or database. Read-only: no key, no transaction.
 *   - the transaction succeeded;
 *   - it carries exactly one GuardedTransferExecuted, emitted by FukuSpendGuard (FUKU_SPEND_GUARD
 *     when set);
 *   - the token's own Transfer event moved the same amount from the same wallet to the same payee;
 *   - optionally: the event's agentId is keccak256(--agent), its actionHash is keccak256(--action)
 *     (the id Fuku returned), and the recipient and amount are the ones expected.
 * Exit code 0 when everything matches.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatUnits, getAddress, http, isHash, keccak256, parseEventLogs, parseUnits, stringToHex, type Hex } from "viem";
import { CleanverseATokenSimAbi, FukuSpendGuardAbi } from "../src/lib/chain/abi";

const here = path.dirname(fileURLToPath(import.meta.url));
const webEnv = path.join(here, "..", ".env");
if (existsSync(webEnv)) process.loadEnvFile(webEnv);

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
};

async function main() {
  const hash = process.argv.slice(2).find((a) => isHash(a)) as Hex | undefined;
  if (!hash) throw new Error("usage: npm run verify:transfer -- <txHash> [--agent <id>] [--action <id>] [--to <0x…>] [--amount <n>]");
  const rpc = arg("rpc") ?? process.env.MONAD_RPC_URL?.trim() ?? "https://testnet-rpc.monad.xyz";
  const guard = process.env.FUKU_SPEND_GUARD?.trim() || null;
  const client = createPublicClient({ transport: http(rpc) });
  const chainId = await client.getChainId();
  console.log(`Transfer ${hash} on chain ${chainId} (${rpc}), read from the chain only`);

  const rc = await client.getTransactionReceipt({ hash });
  check("the transaction succeeded", rc.status === "success", `block ${rc.blockNumber}`);
  const events = parseEventLogs({ abi: FukuSpendGuardAbi, eventName: "GuardedTransferExecuted", logs: rc.logs });
  check("exactly one GuardedTransferExecuted", events.length === 1, `${events.length} found`);
  const ev = events[0];
  if (!ev) return;
  if (guard) check("emitted by the configured FukuSpendGuard", getAddress(ev.address) === getAddress(guard), ev.address);
  else console.log(`  · emitted by ${ev.address} (FUKU_SPEND_GUARD not set: compare it with the README Deployments table)`);

  const decimals = await client.readContract({ address: ev.args.token, abi: CleanverseATokenSimAbi, functionName: "decimals" });
  const transfers = parseEventLogs({ abi: CleanverseATokenSimAbi, eventName: "Transfer", logs: rc.logs }).filter((t) => getAddress(t.address) === getAddress(ev.args.token));
  const moved = transfers.find((t) => getAddress(t.args.from) === getAddress(ev.args.from) && getAddress(t.args.to) === getAddress(ev.args.to));
  check("the token's own Transfer event matches (same from, to and amount)", Boolean(moved) && moved!.args.value === ev.args.amount, moved ? `${formatUnits(moved.args.value, decimals)}` : "none");

  console.log(`  · from ${ev.args.from} (the owner's wallet, under its mandate v${ev.args.mandateVersion})`);
  console.log(`  · to   ${ev.args.to}`);
  console.log(`  · ${formatUnits(ev.args.amount, decimals)} of token ${ev.args.token}`);
  console.log(`  · agentId ${ev.args.agentId}, actionHash ${ev.args.actionHash}, complianceRef ${ev.args.complianceRef}`);

  const agent = arg("agent");
  if (agent) check("agentId = keccak256(--agent)", ev.args.agentId === keccak256(stringToHex(agent)), agent);
  const action = arg("action");
  if (action) check("actionHash = keccak256(--action), the action id Fuku returned", ev.args.actionHash === keccak256(stringToHex(action)), action);
  const to = arg("to");
  if (to) check("recipient is --to", getAddress(ev.args.to) === getAddress(to));
  const amount = arg("amount");
  if (amount) check("amount is --amount", ev.args.amount === parseUnits(amount, decimals), `${amount}`);
  const explorer = (process.env.FUKU_EXPLORER_URL?.trim() || "https://testnet.monadexplorer.com").replace(/\/+$/, "");
  if (chainId === 10143) console.log(`  · ${explorer}/tx/${hash}`);
}

main()
  .catch((err) => {
    failed++;
    console.error(`  ✗ ${err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message) : String(err)}`);
  })
  .finally(() => {
    console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
    process.exitCode = failed ? 1 : 0;
  });
