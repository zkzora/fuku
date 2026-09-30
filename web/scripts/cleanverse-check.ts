#!/usr/bin/env tsx
/**
 * First thing to run when the Cleanverse API invite lands: calls the live cooperate API with the
 * credentials in web/.env and prints what comes back. Read-only (no write endpoint is called).
 *
 *   1. query_deposit_atoken_list  → which A-Tokens exist on CLEANVERSE_CHAIN (look for aUSDC)
 *   2. query_apass                → the A-Pass of the wallet under test
 *   3. verify_apass               → that wallet against the A-Token found in step 1
 *                                   (or CLEANVERSE_ATOKEN_ADDRESS when set)
 *
 * Usage: npm run cleanverse:check [-- --wallet 0x...]
 *   The wallet defaults to the address of DEMO_OWNER_PRIVATE_KEY (Ava's funding wallet).
 * Environment: CLEANVERSE_API_ID, CLEANVERSE_API_KEY, optional CLEANVERSE_BASE_URL (UAT default),
 * CLEANVERSE_CHAIN (default "monad"), CLEANVERSE_ATOKEN_SYMBOL / CLEANVERSE_ATOKEN_ADDRESS.
 * The API key is never printed.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress } from "viem";
import { CleanverseClient, CleanverseError, cleanverseConfigFromEnv } from "../src/lib/cleanverse/client";
import { classifyVerify } from "../src/lib/cleanverse/codes";
import { demoOwnerKey, demoOwnerWallet } from "../src/lib/cleanverse/demo";
import { cleanverseChain } from "../src/lib/cleanverse/mode";
import { LiveCleanverseProvider } from "../src/lib/cleanverse/provider";

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, "..", ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function step<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  process.stdout.write(`\n▶ ${label}\n`);
  try {
    const out = await run();
    console.log(JSON.stringify(out, null, 2));
    return out;
  } catch (err) {
    const e = err as CleanverseError & { code?: string };
    console.log(`  ✖ ${e.name ?? "Error"}: ${e.message}${e.requestId ? ` (X-Request-ID ${e.requestId})` : ""}`);
    return null;
  }
}

async function main() {
  const config = cleanverseConfigFromEnv(process.env);
  if (!config) {
    console.error("CLEANVERSE_API_ID and CLEANVERSE_API_KEY are not set in web/.env. Add them (never commit them) and re-run.");
    process.exit(1);
  }
  const chain = cleanverseChain();
  const wallet = arg("wallet") ?? demoOwnerWallet();
  if (!isAddress(wallet)) {
    console.error(`Not an EVM address: ${wallet}`);
    process.exit(1);
  }
  console.log(`Cleanverse check against ${config.baseUrl} · chain "${chain}" · api-id ${config.apiId.slice(0, 4)}…`);
  const fallback = !arg("wallet") && demoOwnerKey().derived;
  console.log(`Wallet under test: ${wallet}${fallback ? " (public demo fallback: set DEMO_OWNER_PRIVATE_KEY or pass --wallet)" : ""}`);

  const client = new CleanverseClient(config);
  const provider = new LiveCleanverseProvider(client, chain, null);

  const list = await step("query_deposit_atoken_list", async () => (await client.post<unknown>("query_deposit_atoken_list", { chain })).data);
  const symbol = process.env.CLEANVERSE_ATOKEN_SYMBOL?.trim() || "aUSDC";
  const fixed = process.env.CLEANVERSE_ATOKEN_ADDRESS?.trim();
  const asset = fixed && isAddress(fixed) ? { symbol, address: fixed } : list ? await provider.resolveAsset(symbol).catch(() => null) : null;
  console.log(asset ? `\n→ ${asset.symbol} resolves to ${asset.address}` : `\n→ ${symbol} was not found in the list; set CLEANVERSE_ATOKEN_ADDRESS once you know it.`);

  const pass = await step("query_apass", async () => provider.getAPass(wallet));
  if (asset) {
    const v = await step("verify_apass", async () => provider.verifyAPass(wallet, asset.address));
    if (v) {
      const sub = classifyVerify(v.code, pass?.pass ?? undefined, Math.floor(Date.now() / 1000));
      console.log(`\n→ verify code ${v.code} maps to ${sub}${sub === "OK" ? " (eligible: R7 would pass)" : " (R7 would block)"}`);
    }
  }
  console.log("\nNext: put the A-Token address in CLEANVERSE_ATOKEN_ADDRESS, restart the app, and check the Cleanverse card in the Developer Console (it says live after the first successful call).");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
