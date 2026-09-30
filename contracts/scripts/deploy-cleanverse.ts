/**
 * Adds the Cleanverse simulators (CleanverseAPassSim, CleanverseATokenSim) and
 * FukuSpendGuard to an EXISTING Fuku deployment. The four registries are never redeployed.
 *
 * Reads deployments/<network>.json (written by scripts/deploy.ts), checks that its
 * AgentRegistry / PermissionRegistry are live on this chain and that the signer owns
 * PermissionRegistry, deploys the three contracts against them (scripts/lib/cleanverse.ts),
 * makes the guard an enforcer, and writes the new addresses plus `complianceSigner` back
 * into the same file (every other field is kept). If the file already listed a
 * FukuSpendGuard, that old guard's enforcer role is revoked.
 *
 *   npm run deploy:cleanverse:local   # hardhat run scripts/deploy-cleanverse.ts --network localhost
 *   npm run deploy:cleanverse:monad   # hardhat run scripts/deploy-cleanverse.ts --network monadTestnet
 *
 * Env:
 *   COMPLIANCE_SIGNER_ADDRESS  address the guard trusts for attestations (falls back to the
 *                              deployer with a warning)
 *   FUKU_DEPLOYMENT_FILE       optional: update this deployments JSON instead of
 *                              deployments/<network>.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { network } from "hardhat";
import { getAddress, isAddress, type Address } from "viem";
import { deployCleanverse } from "./lib/cleanverse.ts";

const connection = await network.create();
const { viem, networkName } = connection;
const publicClient = await viem.getPublicClient();
const walletClients = await viem.getWalletClients();

if (walletClients.length === 0) {
  throw new Error(
    `No signer available on network "${networkName}". Set DEPLOYER_PRIVATE_KEY in .env (see .env.example).`,
  );
}

const [deployer] = walletClients;
const chainId = await publicClient.getChainId();

const deploymentFile = process.env.FUKU_DEPLOYMENT_FILE?.trim()
  ? path.resolve(process.env.FUKU_DEPLOYMENT_FILE.trim())
  : path.resolve(process.cwd(), "deployments", `${networkName}.json`);

if (!existsSync(deploymentFile)) {
  throw new Error(
    `No deployment file at ${deploymentFile}. Deploy the registries first (scripts/deploy.ts), ` +
      "which already includes the Cleanverse contracts for a fresh stack.",
  );
}

type DeploymentFile = {
  network?: string;
  chainId?: number;
  deployer?: string;
  deployedAt?: string;
  complianceSigner?: string;
  contracts?: Record<string, string>;
  [key: string]: unknown;
};

const deployment = JSON.parse(readFileSync(deploymentFile, "utf8")) as DeploymentFile;
const contracts = deployment.contracts ?? {};

if (Number(deployment.chainId) !== chainId) {
  throw new Error(
    `${deploymentFile} is for chainId ${deployment.chainId}, but network "${networkName}" is chainId ${chainId}.`,
  );
}

const registries = {} as { AgentRegistry: Address; PermissionRegistry: Address };
for (const name of ["AgentRegistry", "PermissionRegistry"] as const) {
  const address = contracts[name];
  if (!address || !isAddress(address, { strict: false })) {
    throw new Error(`${deploymentFile} has no valid contracts.${name} address.`);
  }
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") {
    throw new Error(
      `No contract code at ${name} ${address} on "${networkName}". The chain may have been reset; ` +
        "redeploy the full stack with scripts/deploy.ts.",
    );
  }
  registries[name] = address as Address;
}

console.log(`Network:    ${networkName} (chainId ${chainId})`);
console.log(`Deployer:   ${deployer.account.address}`);
console.log(`Deployment: ${deploymentFile}`);
console.log(`Existing contracts (the four registries are kept, never redeployed):`);
for (const [name, address] of Object.entries(contracts)) console.log(`  ${name}: ${address}`);

const previousGuard = contracts.FukuSpendGuard;
if (previousGuard) {
  console.warn(`\nNote: ${deploymentFile} already lists FukuSpendGuard ${previousGuard}; it will be replaced.`);
}

console.log("");
const cleanverse = await deployCleanverse(connection, registries);

if (previousGuard && isAddress(previousGuard, { strict: false }) && getAddress(previousGuard) !== getAddress(cleanverse.FukuSpendGuard)) {
  const permissionRegistry = await viem.getContractAt("PermissionRegistry", registries.PermissionRegistry);
  if (await permissionRegistry.read.enforcers([previousGuard as Address])) {
    console.log("Revoking the previous FukuSpendGuard's enforcer role...");
    const hash = await permissionRegistry.write.setEnforcer([previousGuard as Address, false]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`setEnforcer(previous guard, false) failed in tx ${hash}`);
    console.log(`  PermissionRegistry.setEnforcer(previous FukuSpendGuard, false): ${hash}`);
  }
}

const { contracts: _contracts, complianceSigner: _previousSigner, ...rest } = deployment;
const updated = {
  ...rest,
  complianceSigner: cleanverse.complianceSigner,
  contracts: {
    ...contracts,
    CleanverseAPassSim: cleanverse.CleanverseAPassSim,
    CleanverseATokenSim: cleanverse.CleanverseATokenSim,
    FukuSpendGuard: cleanverse.FukuSpendGuard,
  },
};
writeFileSync(deploymentFile, JSON.stringify(updated, null, 2) + "\n");

console.log(`\nUpdated ${deploymentFile}`);
console.log(JSON.stringify(updated.contracts, null, 2));
