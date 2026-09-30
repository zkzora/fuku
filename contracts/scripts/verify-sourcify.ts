/**
 * Publish the source of every deployed Fuku contract through Sourcify, which MonadVision reads
 * (the instance is `verify.sourcify.apiUrl` in hardhat.config.ts, BlockVision's by default). Reads
 * deployments/<network>.json and rebuilds each constructor's arguments as the deploy scripts passed
 * them. Sends no transaction.
 *
 *   npx hardhat run scripts/verify-sourcify.ts --network monadTestnet
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import hre, { network } from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import { ATOKEN_RULE } from "./lib/cleanverse.ts";

const { networkName } = await network.create();
const file = path.resolve(process.cwd(), "deployments", `${networkName}.json`);
const deployment = JSON.parse(readFileSync(file, "utf8")) as { complianceSigner?: string; contracts: Record<string, string> };
const c = deployment.contracts;

const targets: { name: string; address?: string; constructorArgs: unknown[] }[] = [
  { name: "HumanIdentityRegistry", address: c.HumanIdentityRegistry, constructorArgs: [] },
  { name: "AgentRegistry", address: c.AgentRegistry, constructorArgs: [c.HumanIdentityRegistry] },
  { name: "PermissionRegistry", address: c.PermissionRegistry, constructorArgs: [c.AgentRegistry] },
  { name: "ReputationRegistry", address: c.ReputationRegistry, constructorArgs: [c.AgentRegistry] },
  { name: "CleanverseAPassSim", address: c.CleanverseAPassSim, constructorArgs: [] },
  { name: "CleanverseATokenSim", address: c.CleanverseATokenSim, constructorArgs: [c.CleanverseAPassSim, ATOKEN_RULE] },
  { name: "FukuSpendGuard", address: c.FukuSpendGuard, constructorArgs: [c.AgentRegistry, c.PermissionRegistry, deployment.complianceSigner] },
];

let failed = 0;
for (const t of targets) {
  if (!t.address) {
    console.log(`skip ${t.name}: not in ${path.basename(file)}`);
    continue;
  }
  try {
    await verifyContract({ address: t.address, constructorArgs: t.constructorArgs, provider: "sourcify" }, hre);
    console.log(`verified ${t.name} ${t.address}`);
  } catch (err) {
    failed++;
    console.log(`FAILED ${t.name} ${t.address}: ${(err as Error).message.split("\n")[0]}`);
  }
}
if (failed) process.exitCode = 1;
