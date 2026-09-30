#!/usr/bin/env tsx
/**
 * Revocation finality through Fuku's own code paths, on a live chain (a local Hardhat node by
 * default). Imports the app modules directly (no HTTP), so it can hold an agent snapshot taken
 * before a revoke, the way a concurrent request, a queued anchor or a reconcile pass does. Every
 * verdict comes from an independent read of the registries or a FukuSpendGuard simulation:
 *
 *   1. a custodial agent with passport v1 anchored; attestation A is signed under it
 *   2. the kill switch revokes the passport: inactive on-chain, A reverts PolicyNotActive
 *   3. stale snapshot: a decision anchor, a score update and a guarded transfer that still carry the
 *      pre-revoke snapshot, then reconcile: the passport stays inactive and nothing is signed
 *   4. the same rules approved again anchor v2 under a new hash: A reverts PolicyMismatch
 *
 * Environment (exported by the caller; web/.env is not read): FUKU_CHAIN_MODE=live, DATABASE_URL
 * (schema pushed), MONAD_RPC_URL, FUKU_CHAIN_ID, the four registry addresses, DEPLOYER_PRIVATE_KEY
 * (relayer), FUKU_SPEND_GUARD, FUKU_COMPLIANCE_SIGNER_KEY and CLEANVERSE_SIM_ATOKEN.
 * Sends transactions: refuses any chain but 31337 unless --allow-testnet is given.
 *
 * Usage: npx tsx scripts/adversarial-live.ts [--allow-testnet]
 */
import { randomBytes, randomUUID } from "node:crypto";
import { toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const GUARDED_TRANSFER_TYPES = {
  GuardedTransfer: [
    { name: "agentId", type: "bytes32" },
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "policyHash", type: "bytes32" },
    { name: "actionHash", type: "bytes32" },
    { name: "proofHash", type: "bytes32" },
    { name: "complianceRef", type: "bytes32" },
    { name: "mandateVersion", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function main() {
  const { chainConfig, chainMode, chainReader, describeChainError, executeGuardedTransfer, recordDecisionOnChain, registryAddresses, relayerAddress, revokePolicyOnChain, spendGuardAddress, toAgentRef, updateScoreOnChain } =
    await import("../src/lib/chain");
  const { FukuSpendGuardAbi, PermissionRegistryAbi } = await import("../src/lib/chain/abi");
  const { db } = await import("../src/lib/db");
  const { hashString, idToBytes32 } = await import("../src/lib/ids");
  const { createIdentity } = await import("../src/lib/services/identity");
  const { registerAgent, revokeAgentPolicy, setAgentPolicy } = await import("../src/lib/services/agents");
  const { reconcile } = await import("../src/lib/services/reconcile");

  const c = chainConfig();
  if (chainMode() !== "live") throw new Error("FUKU_CHAIN_MODE must be live with the registry addresses and DEPLOYER_PRIVATE_KEY set");
  if (c.id !== 31337 && !process.argv.includes("--allow-testnet")) throw new Error(`chain ${c.id} is not a local node; pass --allow-testnet to send transactions there`);
  const reader = chainReader()!;
  const registries = registryAddresses()!;
  const guard = spendGuardAddress();
  const signerKey = process.env.FUKU_COMPLIANCE_SIGNER_KEY?.trim();
  const token = process.env.CLEANVERSE_SIM_ATOKEN?.trim() as Address | undefined;
  if (!guard || !signerKey || !token) throw new Error("FUKU_SPEND_GUARD, FUKU_COMPLIANCE_SIGNER_KEY and CLEANVERSE_SIM_ATOKEN are required");
  const signer = privateKeyToAccount((signerKey.startsWith("0x") ? signerKey : `0x${signerKey}`) as Hex);
  const relayer = relayerAddress()!;
  console.log(`chain ${c.id} (${c.name}); relayer ${relayer}; guard ${guard}\n`);

  const policyOf = async (key: Hex) => {
    const [hash, version, , active] = await reader.readContract({ address: registries.permissions, abi: PermissionRegistryAbi, functionName: "policies", args: [key] });
    return { hash, version: Number(version), active };
  };
  const simulate = async (t: Record<string, unknown>, sig: Hex) => {
    try {
      await reader.simulateContract({ address: guard, abi: FukuSpendGuardAbi, functionName: "execute", args: [t as never, sig], account: relayer });
      return "ok";
    } catch (err) {
      return describeChainError(err);
    }
  };

  // 1. custodial identity, agent and passport v1
  const { identity } = await createIdentity({ displayName: `Revocation probe ${Date.now()}`, authMethod: "passkey", humanVerified: true });
  const { agent, receipt: reg } = await registerAgent(identity, { name: "Revocation probe", capabilities: ["read_balances"] });
  const doc = { allowed: [{ action: "read_balances" }], blocked: ["withdraw"], scopeApps: [] };
  const v1 = await setAgentPolicy(agent.id, doc);
  const key = idToBytes32(agent.id);
  const onV1 = await policyOf(key);
  check("agent registered and passport v1 anchored by the relayer", reg.status === "confirmed" && v1.receipt.status === "confirmed" && onV1.active && onV1.version === 1, `policyHash ${onV1.hash.slice(0, 10)}…`);

  const row = await db.agent.findUniqueOrThrow({ where: { id: agent.id }, include: { policy: true, identity: true } });
  const stale = toAgentRef(row, row.identity); // taken before the revoke, as a concurrent request would hold it

  const latest = await reader.getBlock();
  const A = {
    agentId: key,
    from: relayer,
    to: signer.address,
    token,
    amount: BigInt(1),
    policyHash: onV1.hash,
    actionHash: hashString(`probe:${randomUUID()}`),
    proofHash: hashString("probe:proof"),
    complianceRef: hashString("probe:compliance"),
    mandateVersion: BigInt(0),
    nonce: BigInt(toHex(randomBytes(32))),
    deadline: latest.timestamp + BigInt(900),
  };
  const sigA = await signer.signTypedData({
    domain: { name: "FukuSpendGuard", version: "1", chainId: c.id, verifyingContract: guard },
    types: GUARDED_TRANSFER_TYPES,
    primaryType: "GuardedTransfer",
    message: A,
  });
  // No mandate exists for this agent, so a passing policy check surfaces as NoMandate.
  const baseline = await simulate(A, sigA);
  check("attestation A passes the passport check before the revoke (stops at NoMandate)", baseline.startsWith("NoMandate"), baseline);

  // 2. kill switch
  const revoked = await revokeAgentPolicy(agent.id);
  const onRevoked = await policyOf(key);
  check("kill switch: revokePolicy confirmed, passport inactive on-chain", revoked.chainSync.ok && revoked.chainSync.receipts[0]?.status === "confirmed" && !onRevoked.active, revoked.chainSync.receipts[0]?.txHash ?? revoked.chainSync.error ?? "");
  const afterRevoke = await simulate(A, sigA);
  check("A reverts PolicyNotActive after the revoke", afterRevoke.startsWith("PolicyNotActive"), afterRevoke);

  // 3. stale snapshot paths: none may re-activate the passport or sign anything
  const stillRevoked = async (label: string, detail: string) => {
    const p = await policyOf(key);
    check(`${label}: the passport stays inactive on-chain`, !p.active, `${detail}; on-chain v${p.version} active=${p.active}`);
    if (p.active) {
      // re-revoke so the next path is tested on its own
      const fresh = await db.agent.findUniqueOrThrow({ where: { id: agent.id }, include: { policy: true, identity: true } });
      await revokePolicyOnChain(toAgentRef(fresh, fresh.identity));
    }
  };
  const anchor = await recordDecisionOnChain({ agent: stale, actionId: `probe-${randomUUID()}`, allowed: false, proofHash: hashString("probe:decision"), ruleId: "R1" });
  await stillRevoked("decision anchor with a pre-revoke snapshot", `recordDecision ${anchor.status} ${anchor.note ?? ""}`.trim());
  const score = await updateScoreOnChain(stale, 40, -1, "revocation probe");
  await stillRevoked("score update with a pre-revoke snapshot", `updateScore ${score.status} ${score.note ?? ""}`.trim());
  let outcome: string;
  try {
    const out = await executeGuardedTransfer({
      agent: stale,
      policyVersion: 1,
      actionId: `probe-${randomUUID()}`,
      from: relayer,
      to: signer.address,
      token,
      amount: BigInt(1),
      proofHash: hashString("probe:transfer"),
      complianceRef: hashString("probe:compliance"),
    });
    outcome = out.status === "rejected" ? `rejected ${out.reason}` : out.status;
  } catch (err) {
    outcome = `threw ${(err as Error).message}`;
  }
  check("guarded transfer with a pre-revoke snapshot is refused before signing", /AUTHORIZATION_CHANGED/.test(outcome), outcome);
  await stillRevoked("guarded transfer with a pre-revoke snapshot", outcome);

  // reconcile with a failed decision anchor and an expired in-flight transfer for the agent
  const old = new Date(Date.now() - 60 * 60 * 1000);
  const failedAnchor = await db.agentAction.create({
    data: { agentId: agent.id, identityId: identity.id, action: "read_balances", decision: "ALLOWED", status: "AUTHORIZED", reason: "probe", ruleId: "R6", proofHash: hashString("probe:a"), anchorStatus: "failed", policyVersion: 1, createdAt: old },
  });
  const inFlight = await db.agentAction.create({
    data: { agentId: agent.id, identityId: identity.id, action: "transfer", decision: "ALLOWED", status: "AUTHORIZED", reason: "probe", ruleId: "R6", proofHash: hashString("probe:b"), complianceRef: hashString("probe:c"), amountMicros: BigInt(1), policyVersion: 1, createdAt: old },
  });
  const report = await reconcile({ agentId: agent.id });
  const [anchoredRow, inFlightRow] = await Promise.all([db.agentAction.findUniqueOrThrow({ where: { id: failedAnchor.id } }), db.agentAction.findUniqueOrThrow({ where: { id: inFlight.id } })]);
  const executed = await reader.readContract({ address: guard, abi: FukuSpendGuardAbi, functionName: "actionExecuted", args: [hashString(inFlight.id)] });
  check(
    "reconcile re-anchors the decision log, settles the stale transfer as FAILED and executes nothing",
    anchoredRow.anchorStatus === "anchored" && inFlightRow.status === "FAILED" && executed === false,
    `anchor ${anchoredRow.anchorStatus}, transfer ${inFlightRow.status} (${inFlightRow.errorClass}), actionExecuted ${executed}, report ${JSON.stringify(report)}`,
  );
  await stillRevoked("reconcile after the revoke", "reconcile");

  // 4. the same rules approved again: a new passport version under a new hash
  const v2 = await setAgentPolicy(agent.id, doc);
  const onV2 = await policyOf(key);
  check("re-approval anchors v2 under a new, version-bound hash", v2.receipt.status === "confirmed" && onV2.active && onV2.version === 2 && onV2.hash !== onV1.hash, `v1 ${onV1.hash.slice(0, 10)}…, v2 ${onV2.hash.slice(0, 10)}…`);
  const afterReapprove = await simulate(A, sigA);
  check("A stays dead after the re-approval (PolicyMismatch)", afterReapprove.startsWith("PolicyMismatch"), afterReapprove);

  console.log(`\nagent ${agent.id} (${key})`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  await db.$disconnect();
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
