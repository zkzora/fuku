#!/usr/bin/env tsx
/**
 * Cleanverse demo setup (simulator contracts). Idempotent; safe to run again.
 *
 * Against a local Hardhat node or Monad testnet, with the deployer as simulator owner / issuer:
 *   1. issues simulator A-Passes to Ava (the demo owner), Nusantara Supplies and the frozen wallet;
 *   2. mints 10,000 aUSDC-SIM to Ava;
 *   3. tops up Ava's MON for gas from the deployer when it is low;
 *   4. has Ava approve FukuSpendGuard for 10,000 aUSDC-SIM and open a 1,000 aUSDC-SIM/day
 *      mandate for the Payments Agent.
 * Nothing here is issued by Cleanverse: these are Fuku's simulator contracts.
 *
 * Environment (read from web/.env, which `npm run wire:env` in contracts/ fills):
 *   DEPLOYER_PRIVATE_KEY     simulator owner (issues passes, mints, pays gas top-ups)
 *   DEMO_OWNER_PRIVATE_KEY   Ava's funding wallet (required)
 *   CLEANVERSE_SIM_APASS, CLEANVERSE_SIM_ATOKEN, FUKU_SPEND_GUARD
 *   MONAD_RPC_URL, FUKU_CHAIN_ID, FUKU_CHAIN_NAME   (default Monad testnet)
 *   SETUP_OWNER_MIN_MON      top up below this balance (default 0.05)
 *   SETUP_OWNER_TOPUP_MON    amount sent when topping up (default 0.1)
 *
 * Usage: npx tsx scripts/setup-cleanverse-demo.ts
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  formatUnits,
  http,
  isAddress,
  isHex,
  parseEther,
  parseUnits,
  stringToHex,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CleanverseAPassSimAbi, CleanverseATokenSimAbi, FukuSpendGuardAbi } from "../src/lib/chain/abi";
import { DEMO_RECIPIENTS } from "../src/lib/cleanverse/demo";
import { idToBytes32 } from "../src/lib/ids";
import { PAYMENTS_AGENT_ID } from "../src/lib/demo-seed";

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, "..", ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const MINT = parseUnits("10000", 6);
const ALLOWANCE = parseUnits("10000", 6);
const DAILY_CAP = parseUnits("1000", 6);
const ONE_YEAR_S = 365 * 24 * 3600;

function fail(msg: string): never {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

function key(name: string): Hex | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const k = raw.startsWith("0x") ? raw : `0x${raw}`;
  return isHex(k) && k.length === 66 ? (k as Hex) : null;
}

function address(name: string): Address {
  const v = process.env[name]?.trim();
  if (!v || !isAddress(v)) fail(`${name} is not set. Deploy the simulator (contracts: npm run deploy:cleanverse:<network>) and run npm run wire:env.`);
  return v as Address;
}

const ownerKey = key("DEMO_OWNER_PRIVATE_KEY");
if (!ownerKey) {
  fail(
    "DEMO_OWNER_PRIVATE_KEY is not set (Ava's funding wallet, testnet only). Create one and add it to web/.env:\n" +
      `  node -e "console.log('DEMO_OWNER_PRIVATE_KEY=0x'+require('crypto').randomBytes(32).toString('hex'))" >> .env`,
  );
}
const deployerKey = key("DEPLOYER_PRIVATE_KEY") ?? fail("DEPLOYER_PRIVATE_KEY is not set (the simulator owner).");

const apassAddr = address("CLEANVERSE_SIM_APASS");
const atokenAddr = address("CLEANVERSE_SIM_ATOKEN");
const guardAddr = address("FUKU_SPEND_GUARD");

const chain = defineChain({
  id: Number(process.env.FUKU_CHAIN_ID ?? 10143),
  name: process.env.FUKU_CHAIN_NAME?.trim() || "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [process.env.MONAD_RPC_URL?.trim() || "https://testnet-rpc.monad.xyz"] } },
});
const transport = http(chain.rpcUrls.default.http[0]);
const pub = createPublicClient({ chain, transport, pollingInterval: 1_000 });
const deployer = privateKeyToAccount(deployerKey);
const owner = privateKeyToAccount(ownerKey);
const asDeployer = createWalletClient({ chain, transport, account: deployer });
const asOwner = createWalletClient({ chain, transport, account: owner });

async function mined(label: string, hash: Hex) {
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (r.status !== "success") fail(`${label} reverted (tx ${hash})`);
  console.log(`  ✓ ${label}  tx ${hash}`);
}

const label32 = (s: string) => stringToHex(s, { size: 32 });

async function ensurePass(name: string, wallet: Address, status: 1 | 2, tier: number, cvRecordId: string) {
  const p = await pub.readContract({ address: apassAddr, abi: CleanverseAPassSimAbi, functionName: "passOf", args: [wallet] });
  if (p.status === status && p.tier === tier && p.cvRecordId === label32(cvRecordId)) {
    console.log(`  = ${name}: A-Pass already status ${status}, tier ${tier}`);
    return;
  }
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + ONE_YEAR_S);
  const hash = await asDeployer.writeContract({
    address: apassAddr,
    abi: CleanverseAPassSimAbi,
    functionName: "issue",
    args: [wallet, { status, tier, subTier: 0, group: zeroHash, subGroup: zeroHash, expiresAt, cvRecordId: label32(cvRecordId) }],
  });
  await mined(`${name}: issue simulator A-Pass (status ${status}, tier ${tier})`, hash);
}

async function main() {
  console.log(`Cleanverse simulator setup on ${chain.name} (chain ${chain.id})`);
  console.log(`  deployer ${deployer.address}\n  owner    ${owner.address} (Ava)\n  A-Pass   ${apassAddr}\n  aToken   ${atokenAddr}\n  guard    ${guardAddr}\n`);

  const onChainId = await pub.getChainId();
  if (onChainId !== chain.id) fail(`RPC reports chain ${onChainId}, expected FUKU_CHAIN_ID=${chain.id}`);
  const isIssuer = await pub.readContract({ address: apassAddr, abi: CleanverseAPassSimAbi, functionName: "issuers", args: [deployer.address] });
  if (!isIssuer) fail(`deployer ${deployer.address} is not an issuer on CleanverseAPassSim`);

  // 1. A-Passes
  console.log("A-Passes");
  await ensurePass("Ava Chen", owner.address, 1, 2, "cv-sim-ava-chen");
  for (const r of DEMO_RECIPIENTS) {
    if (r.apass) await ensurePass(r.name, r.address, r.apass.status, r.apass.tier, `cv-sim-${r.label}`);
    else console.log(`  - ${r.name}: no A-Pass (by design)`);
  }

  // 2. aUSDC-SIM
  console.log("aUSDC-SIM");
  const balance = await pub.readContract({ address: atokenAddr, abi: CleanverseATokenSimAbi, functionName: "balanceOf", args: [owner.address] });
  if (balance < MINT) {
    const hash = await asDeployer.writeContract({ address: atokenAddr, abi: CleanverseATokenSimAbi, functionName: "mint", args: [owner.address, MINT - balance] });
    await mined(`mint ${formatUnits(MINT - balance, 6)} aUSDC-SIM to Ava`, hash);
  } else {
    console.log(`  = Ava holds ${formatUnits(balance, 6)} aUSDC-SIM`);
  }

  // 3. Gas
  console.log("Gas");
  const minMon = parseEther(process.env.SETUP_OWNER_MIN_MON ?? "0.05");
  const topUp = parseEther(process.env.SETUP_OWNER_TOPUP_MON ?? "0.1");
  const mon = await pub.getBalance({ address: owner.address });
  if (mon < minMon) {
    const hash = await asDeployer.sendTransaction({ to: owner.address, value: topUp });
    await mined(`top up Ava with ${formatEther(topUp)} MON`, hash);
  } else {
    console.log(`  = Ava holds ${formatEther(mon)} MON`);
  }

  // 4. Allowance + mandate (signed by Ava: msg.sender is the funding wallet)
  console.log("Mandate");
  const allowance = await pub.readContract({ address: atokenAddr, abi: CleanverseATokenSimAbi, functionName: "allowance", args: [owner.address, guardAddr] });
  if (allowance < ALLOWANCE) {
    const hash = await asOwner.writeContract({ address: atokenAddr, abi: CleanverseATokenSimAbi, functionName: "approve", args: [guardAddr, ALLOWANCE] });
    await mined("Ava approves FukuSpendGuard for 10,000 aUSDC-SIM", hash);
  } else {
    console.log(`  = allowance ${formatUnits(allowance, 6)} aUSDC-SIM`);
  }
  const agentKey = idToBytes32(PAYMENTS_AGENT_ID);
  const [token, cap, active] = await pub.readContract({ address: guardAddr, abi: FukuSpendGuardAbi, functionName: "mandates", args: [agentKey, owner.address] });
  if (!active || token.toLowerCase() !== atokenAddr.toLowerCase() || cap !== DAILY_CAP) {
    const hash = await asOwner.writeContract({ address: guardAddr, abi: FukuSpendGuardAbi, functionName: "openMandate", args: [agentKey, atokenAddr, DAILY_CAP] });
    await mined("Ava opens a 1,000 aUSDC-SIM/day mandate for the Payments Agent", hash);
  } else {
    console.log(`  = mandate open: ${formatUnits(cap, 6)} aUSDC-SIM/day`);
  }

  console.log("\nDone. Recipients:");
  for (const r of DEMO_RECIPIENTS) console.log(`  ${r.name.padEnd(20)} ${r.address}  expect ${r.expect}`);
  console.log(`\nAva's wallet is ${owner.address}. If the app was seeded before DEMO_OWNER_PRIVATE_KEY was set, reset the demo so Ava's identity uses it.`);
}

main().catch((err) => fail(err instanceof Error ? (err as { shortMessage?: string }).shortMessage ?? err.message : String(err)));
