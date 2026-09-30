#!/usr/bin/env node
/**
 * Pre-flight check for a Monad testnet deploy.
 *
 * Reads DEPLOYER_PRIVATE_KEY and MONAD_RPC_URL from contracts/.env (if present) or the
 * process environment, derives the deployer address, then asks the RPC for the chain id
 * and the MON balance. Exits non-zero, with a plain-language hint, when the key is missing
 * or malformed, the RPC cannot be reached, the chain id is not Monad testnet, or the
 * balance is zero.
 *
 *   npm run check:deployer
 *   node scripts/check-deployer.mjs [--rpc <url>] [--chain-id <id>]
 *
 * The private key is never printed.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const DEFAULT_RPC = "https://testnet-rpc.monad.xyz";
const DEFAULT_CHAIN_ID = 10143; // Monad testnet
const FAUCET_URL = "https://faucet.monad.xyz";
const LOW_BALANCE_MON = 0.1; // soft warning only

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: node scripts/check-deployer.mjs [--rpc <url>] [--chain-id <id>]");
  process.exit(0);
}

/** A problem the user can fix; reported without a stack trace. */
class UserError extends Error {}
function fail(lines) {
  throw new UserError(lines.join("\n"));
}

function shortError(err) {
  const msg = err?.shortMessage ?? err?.message ?? String(err);
  return msg.split("\n")[0].slice(0, 200);
}

async function main() {
  const rpcUrl = flag("--rpc", process.env.MONAD_RPC_URL?.trim() || DEFAULT_RPC);
  const expectedChainId = Number(flag("--chain-id", DEFAULT_CHAIN_ID));

  // 1. Key ------------------------------------------------------------------
  const rawKey = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!rawKey) {
    fail([
      "DEPLOYER_PRIVATE_KEY is not set.",
      "",
      `  Put it in ${envFile} (copy .env.example to .env), e.g.`,
      "    DEPLOYER_PRIVATE_KEY=0x<64 hex characters>",
      "  or export it in your shell before running this command.",
      "",
      "  Need a key? Generate one (never reuse a mainnet key):",
      '    node -e "import(\'viem/accounts\').then(a=>{const k=a.generatePrivateKey();console.log(k, a.privateKeyToAccount(k).address)})"',
    ]);
  }
  const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    fail([
      "DEPLOYER_PRIVATE_KEY is malformed: expected 0x followed by 64 hex characters (a 32-byte key).",
      "  Check for quotes, spaces or a missing/extra character in contracts/.env.",
    ]);
  }

  let account;
  try {
    account = privateKeyToAccount(key);
  } catch {
    fail(["DEPLOYER_PRIVATE_KEY is not a valid secp256k1 private key."]);
  }

  // 2. RPC ------------------------------------------------------------------
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }) });

  let chainId;
  let balance;
  try {
    chainId = await client.getChainId();
    balance = await client.getBalance({ address: account.address });
  } catch (err) {
    fail([
      `Could not query the RPC at ${rpcUrl}`,
      `  ${shortError(err)}`,
      "",
      "  Check MONAD_RPC_URL in contracts/.env, your network connection, or try again in a",
      "  moment if the public endpoint is rate limiting you.",
    ]);
  }

  const balanceMon = formatEther(balance);
  const isExpectedChain = chainId === expectedChainId;

  console.log(`Deployer address: ${account.address}`);
  console.log(`RPC:              ${rpcUrl}`);
  console.log(`Chain id:         ${chainId}${isExpectedChain && chainId === DEFAULT_CHAIN_ID ? " (Monad testnet)" : ""}`);
  console.log(`Balance:          ${balanceMon} MON`);

  // 3. Verdict --------------------------------------------------------------
  if (!isExpectedChain) {
    fail([
      `Wrong chain: the RPC reports chain id ${chainId}, expected ${expectedChainId}.`,
      "  hardhat.config.ts pins monadTestnet to chain id 10143, so a deploy would be rejected.",
      "  Point MONAD_RPC_URL at a Monad testnet endpoint (default https://testnet-rpc.monad.xyz),",
      "  or pass --chain-id <id> if you really mean another network.",
    ]);
  }

  if (balance === 0n) {
    fail([
      `Balance is 0 MON for ${account.address}.`,
      "",
      `  Fund it from the Monad testnet faucet: ${FAUCET_URL}`,
      "  (paste the address above, then re-run npm run check:deployer).",
    ]);
  }

  if (Number(balanceMon) < LOW_BALANCE_MON) {
    console.warn("");
    console.warn(`Warning: balance is below ${LOW_BALANCE_MON} MON. A full deploy sends 10 transactions; if it`);
    console.warn(`fails with "insufficient funds", top up at ${FAUCET_URL} and re-run.`);
  }

  console.log("");
  console.log("OK: deployer is funded on Monad testnet. Next: npm run deploy:monad");
}

// No process.exit() after network I/O: on Node 24 / Windows it can trip a libuv assertion
// while the RPC socket is still closing. Setting exitCode lets the loop drain cleanly.
try {
  await main();
} catch (err) {
  if (!(err instanceof UserError)) throw err;
  console.error("");
  console.error(err.message);
  console.error("");
  process.exitCode = 1;
}
