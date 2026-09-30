#!/usr/bin/env node
/**
 * Live settlement smoke test for the Fuku web app.
 *
 * Drives a running web instance in FUKU_CHAIN_MODE=live through the demo flow (sign in,
 * register an agent, attach a passport, one allowed and one blocked action), asserts that
 * every receipt is a real transaction (mode === "live"), then verifies the outcome
 * INDEPENDENTLY by reading the chain with viem: transaction receipts, AgentRegistry.exists,
 * PermissionRegistry.stats, ReputationRegistry.getScore and HumanIdentityRegistry.isHuman.
 *
 * Environment:
 *   FUKU_BASE_URL              web instance to drive (default http://localhost:3002)
 *   MONAD_RPC_URL              JSON-RPC endpoint (default http://127.0.0.1:8545)
 *   FUKU_IDENTITY_REGISTRY, FUKU_AGENT_REGISTRY,
 *   FUKU_PERMISSION_REGISTRY, FUKU_REPUTATION_REGISTRY
 *                              registry addresses; when unset they are read from
 *                              FUKU_DEPLOYMENT_FILE (default ../contracts/deployments/localhost.json)
 *
 * Usage (against a local Hardhat node standing in for Monad testnet):
 *   node scripts/live-smoke.mjs
 *
 * Cleanverse section (runs when FUKU_SPEND_GUARD / CLEANVERSE_SIM_ATOKEN are set or the
 * deployments file lists FukuSpendGuard and CleanverseATokenSim; run `npm run cleanverse:setup`
 * first). It resets the demo, then:
 *   - 250 aUSDC-SIM from Ava to Nusantara Supplies is ALLOWED and moves the balances on-chain;
 *   - the frozen and the unverified wallets are blocked with R8 (CVI_FROZEN / CVI_NOT_FOUND) and
 *     their transactions carry no Transfer event;
 *   - a repeated Idempotency-Key replays instead of paying twice;
 *   - direct attestations revert with PerTxLimitExceeded, PayeeNotApproved and DailyCapExceeded;
 *   - two concurrent requests cannot spend the same remainder, and balances move exactly once;
 *   - reconcile (run as a separate process) recovers a transfer whose hash was never stored,
 *     without double credit, and returns a reorged-out confirmation to PENDING (evm_snapshot /
 *     evm_revert on the local node); needs DATABASE_URL pointing at the web instance's database;
 *   - revoking in the app emits PolicyRevoked, after which a pre-signed attestation reverts with
 *     PolicyNotActive. The demo is reset again at the end.
 *   FUKU_COMPLIANCE_SIGNER_KEY  signs the direct attestations (Hardhat account #1 locally)
 *
 * Exit code 0 when every check passes, 1 otherwise.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  decodeEventLog,
  formatUnits,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseUnits,
  stringToHex,
  toHex,
} from "viem";
import { privateKeyToAccount, privateKeyToAddress } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = (process.env.FUKU_BASE_URL ?? "http://localhost:3002").replace(/\/+$/, "");
const RPC_URL = process.env.MONAD_RPC_URL ?? "http://127.0.0.1:8545";

function loadAddresses() {
  const fromEnv = {
    identity: process.env.FUKU_IDENTITY_REGISTRY,
    agents: process.env.FUKU_AGENT_REGISTRY,
    permissions: process.env.FUKU_PERMISSION_REGISTRY,
    reputation: process.env.FUKU_REPUTATION_REGISTRY,
  };
  if (Object.values(fromEnv).every(Boolean)) return { source: "env", ...fromEnv };

  const file =
    process.env.FUKU_DEPLOYMENT_FILE ?? path.resolve(here, "..", "..", "contracts", "deployments", "localhost.json");
  if (!existsSync(file)) {
    throw new Error(`Registry addresses missing: set FUKU_*_REGISTRY or provide ${file}`);
  }
  const d = JSON.parse(readFileSync(file, "utf8"));
  return {
    source: file,
    identity: d.contracts.HumanIdentityRegistry,
    agents: d.contracts.AgentRegistry,
    permissions: d.contracts.PermissionRegistry,
    reputation: d.contracts.ReputationRegistry,
  };
}

/** Cleanverse simulator + guard addresses (env first, then the deployments file), or null. */
function loadCleanverse() {
  let atoken = process.env.CLEANVERSE_SIM_ATOKEN;
  let guard = process.env.FUKU_SPEND_GUARD;
  if (!atoken || !guard) {
    const file =
      process.env.FUKU_DEPLOYMENT_FILE ?? path.resolve(here, "..", "..", "contracts", "deployments", "localhost.json");
    if (existsSync(file)) {
      const c = JSON.parse(readFileSync(file, "utf8")).contracts ?? {};
      atoken ??= c.CleanverseATokenSim;
      guard ??= c.FukuSpendGuard;
    }
  }
  return atoken && guard ? { atoken, guard } : null;
}

const loadAbi = (name) => JSON.parse(readFileSync(path.resolve(here, "..", "..", "contracts", "abi", `${name}.json`), "utf8"));

/** Same derivation as web/src/lib/cleanverse/demo.ts. */
const demoAddress = (label) => privateKeyToAddress(keccak256(stringToHex(`fuku:demo:${label}`)));

const idToBytes32 = (id) => keccak256(stringToHex(id));

const readAbi = parseAbi([
  "function exists(bytes32 agentId) view returns (bool)",
  "function ownerOf(bytes32 agentId) view returns (bytes32)",
  "function stats(bytes32 agentId) view returns (uint64 allowedCount, uint64 violationCount)",
  "function hasActivePolicy(bytes32 agentId) view returns (bool)",
  "function getScore(bytes32 agentId) view returns (uint16 score, uint64 updatedAt, bool exists)",
  "function isHuman(bytes32 identityId) view returns (bool)",
  "function controllerOf(bytes32 identityId) view returns (address)",
]);

// --- tiny test harness ------------------------------------------------------------------

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
  return Boolean(ok);
}

function printTable() {
  const width = Math.max(...results.map((r) => r.name.length));
  console.log("\n" + "=".repeat(width + 60));
  console.log(`${"CHECK".padEnd(width)}  RESULT  DETAIL`);
  console.log("-".repeat(width + 60));
  for (const r of results) {
    console.log(`${r.name.padEnd(width)}  ${r.ok ? "PASS  " : "FAIL  "}  ${r.detail}`);
  }
  console.log("-".repeat(width + 60));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} checks passed${failed ? ` (${failed} FAILED)` : ""}`);
  console.log("=".repeat(width + 60));
  return failed === 0;
}

// --- web API client ---------------------------------------------------------------------

let cookie = "";

async function api(method, route, body, headers = {}) {
  const res = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: { "content-type": "application/json", cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

async function signIn(reset = false) {
  const res = await fetch(`${BASE_URL}/api/auth/demo?next=/dashboard${reset ? "&reset=1" : ""}`, { redirect: "manual" });
  const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") ?? ""];
  const session = setCookies.map((c) => c.split(";")[0]).find((c) => c.startsWith("fuku_session="));
  if (!session) throw new Error(`demo sign-in did not set fuku_session (status ${res.status})`);
  cookie = session;
  return res.status;
}

const short = (h) => (typeof h === "string" && h.length > 14 ? `${h.slice(0, 10)}…${h.slice(-4)}` : String(h));
const fmtReceipt = (r) => (r ? `${r.mode} tx ${short(r.txHash)} block ${r.block}${r.note ? ` (${r.note})` : ""}` : "no receipt");

// --- main -------------------------------------------------------------------------------

async function main() {
  const addresses = loadAddresses();
  console.log(`Web:      ${BASE_URL}`);
  console.log(`RPC:      ${RPC_URL}`);
  console.log(`Contracts (${addresses.source}):`);
  for (const k of ["identity", "agents", "permissions", "reputation"]) console.log(`  ${k.padEnd(12)} ${addresses[k]}`);
  console.log("");

  const publicClient = createPublicClient({ transport: http(RPC_URL) });
  const chainId = await publicClient.getChainId();
  console.log(`Chain id: ${chainId}\n`);

  // 1. sign in
  const status = await signIn();
  check("demo sign-in sets session cookie", true, `status ${status}`);

  const me = await api("GET", "/api/auth/me");
  const identityId = me.json?.identity?.id ?? me.json?.id ?? null;

  // 2. register agent
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const reg = await api("POST", "/api/agents", {
    name: `Smoke Agent ${stamp}`,
    capabilities: ["swap", "read_balances"],
    description: "live-smoke.mjs",
  });
  const agent = reg.json?.agent;
  const regReceipt = reg.json?.receipt;
  check("POST /api/agents registers agent", reg.status === 201 && agent?.id, `status ${reg.status} agent ${agent?.id ?? "?"}`);
  check("register receipt is live", regReceipt?.mode === "live", fmtReceipt(regReceipt));
  if (!agent?.id) throw new Error(`cannot continue without an agent: ${JSON.stringify(reg.json).slice(0, 300)}`);
  const ownerIdentityId = agent.identityId ?? identityId;

  // 3. policy
  const pol = await api("PUT", `/api/agents/${encodeURIComponent(agent.id)}/policy`, {
    allowed: [{ action: "swap", limitUsdcPerDay: 500 }, { action: "read_balances" }],
    blocked: ["withdraw", "change_owner"],
    scopeApps: [],
  });
  const polReceipt = pol.json?.receipt;
  check("PUT /api/agents/:id/policy sets policy", pol.status === 200 && pol.json?.agent?.policy?.active === true, `status ${pol.status} version ${pol.json?.agent?.policy?.version ?? "?"}`);
  check("policy receipt is live", polReceipt?.mode === "live", fmtReceipt(polReceipt));

  // 4. allowed action
  const okAct = await api("POST", `/api/agents/${encodeURIComponent(agent.id)}/actions`, {
    action: "swap",
    amountUsdc: 120,
    app: "Monad DEX",
  });
  const okReceipt = okAct.json?.receipt;
  check(
    "allowed action (swap 120 USDC) is ALLOWED",
    okAct.status === 200 && okAct.json?.decision === "ALLOWED",
    `status ${okAct.status} decision ${okAct.json?.decision} rule ${okAct.json?.ruleId} score ${okAct.json?.scoreBefore}→${okAct.json?.scoreAfter}`,
  );
  check("allowed-action receipt is live", okReceipt?.mode === "live", fmtReceipt(okReceipt));

  // 5. blocked action
  const badAct = await api("POST", `/api/agents/${encodeURIComponent(agent.id)}/actions`, {
    action: "withdraw",
    amountUsdc: 50,
    app: "Monad DEX",
  });
  const badReceipt = badAct.json?.receipt;
  check(
    "blocked action (withdraw 50 USDC) is BLOCKED",
    badAct.status === 403 && badAct.json?.decision === "BLOCKED",
    `status ${badAct.status} decision ${badAct.json?.decision} rule ${badAct.json?.ruleId} score ${badAct.json?.scoreBefore}→${badAct.json?.scoreAfter}`,
  );
  check("blocked-action receipt is live", badReceipt?.mode === "live", fmtReceipt(badReceipt));

  // --- independent on-chain verification --------------------------------------------------
  console.log("\nOn-chain verification via viem:");
  const receipts = [
    ["registerAgent", regReceipt],
    ["setPolicy", polReceipt],
    ["recordDecision (allowed)", okReceipt],
    ["recordDecision (blocked)", badReceipt],
  ];
  for (const [label, r] of receipts) {
    if (!r?.txHash) {
      check(`eth_getTransactionReceipt ${label}`, false, "no txHash");
      continue;
    }
    try {
      const rc = await publicClient.getTransactionReceipt({ hash: r.txHash });
      check(
        `eth_getTransactionReceipt ${label}`,
        rc.status === "success" && Number(rc.blockNumber) === Number(r.block),
        `tx ${r.txHash} status ${rc.status} block ${rc.blockNumber} to ${rc.to}`,
      );
    } catch (err) {
      check(`eth_getTransactionReceipt ${label}`, false, `${err.shortMessage ?? err.message}`);
    }
  }

  const agentKey = idToBytes32(agent.id);
  const identityKey = idToBytes32(ownerIdentityId);
  const read = (address, functionName, args) => publicClient.readContract({ address, abi: readAbi, functionName, args });

  const exists = await read(addresses.agents, "exists", [agentKey]);
  check("AgentRegistry.exists(agentId) === true", exists === true, `agentId ${agent.id} -> bytes32 ${agentKey}`);

  const owner = await read(addresses.agents, "ownerOf", [agentKey]);
  check("AgentRegistry.ownerOf(agentId) === identity", owner === identityKey, `${short(owner)} (identity ${ownerIdentityId})`);

  const controller = await read(addresses.identity, "controllerOf", [identityKey]);
  const human = await read(addresses.identity, "isHuman", [identityKey]);
  check("HumanIdentityRegistry.isHuman(identityId) === true", human === true, `controller ${controller}`);

  const [allowedCount, violationCount] = await read(addresses.permissions, "stats", [agentKey]);
  check(
    "PermissionRegistry.stats(agentId) == (1 allowed, 1 violation)",
    allowedCount === 1n && violationCount === 1n,
    `allowedCount ${allowedCount} violationCount ${violationCount}`,
  );
  const activePolicy = await read(addresses.permissions, "hasActivePolicy", [agentKey]);
  check("PermissionRegistry.hasActivePolicy(agentId) === true", activePolicy === true);

  const [score, updatedAt, scoreExists] = await read(addresses.reputation, "getScore", [agentKey]);
  check(
    "ReputationRegistry.getScore(agentId).exists === true",
    scoreExists === true && Number(score) === Number(badAct.json?.scoreAfter),
    `score ${score} updatedAt ${updatedAt} (web says ${badAct.json?.scoreAfter})`,
  );
}

// --- Cleanverse: A-Pass checks + guarded transfers ---------------------------------------

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
};

function revertName(err) {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? "revert";
  }
  return `not a revert: ${err?.shortMessage ?? err?.message ?? err}`;
}

/** Decode the logs of `receipt` emitted by `address` with `abi`; logs outside the ABI are skipped. */
function eventsFrom(receipt, address, abi) {
  const out = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== address.toLowerCase()) continue;
    try {
      out.push(decodeEventLog({ abi, data: log.data, topics: log.topics }));
    } catch {
      // not an event of this ABI
    }
  }
  return out;
}

async function cleanverseSmoke(publicClient, addresses, cv) {
  console.log(`\nCleanverse (simulator) + FukuSpendGuard v2:\n  aToken ${cv.atoken}\n  guard  ${cv.guard}`);
  const guardAbi = loadAbi("FukuSpendGuard");
  const tokenAbi = loadAbi("CleanverseATokenSim");
  const permAbi = loadAbi("PermissionRegistry");
  const chainId = await publicClient.getChainId();

  await signIn(true);
  const list = await api("GET", "/api/agents");
  const pay = list.json?.agents?.find((a) => a.name === "Payments Agent");
  if (!check("demo reset seeds the Payments Agent (A-Token passport)", pay?.policy?.assets?.includes("aUSDC"), pay?.id ?? "missing")) return;
  const ident = await api("GET", "/api/identity");
  const owner = ident.json?.identity?.walletAddress;
  if (!check("Ava's wallet is set and bound (DEMO_OWNER_PRIVATE_KEY)", owner && isAddress(owner) && ident.json?.identity?.walletVerifiedBy === "signature", `${owner ?? "none"} via ${ident.json?.identity?.walletVerifiedBy}`)) return;

  const agentKey = idToBytes32(pay.id);
  const read = (address, abi, functionName, args = []) => publicClient.readContract({ address, abi, functionName, args });
  const [mToken, cap, maxPerTx, , restrictPayees, , mActive] = await read(cv.guard, guardAbi, "mandates", [agentKey, owner]);
  const mandateOk = check(
    "owner opened a v2 mandate (cap, per-tx limit, approved payees)",
    mActive && mToken.toLowerCase() === cv.atoken.toLowerCase() && maxPerTx > 0n && restrictPayees,
    mActive ? `cap ${formatUnits(cap, 6)}/day, ${formatUnits(maxPerTx, 6)} per transfer, payees restricted ${restrictPayees}` : "run `npm run cleanverse:setup` first",
  );
  if (!mandateOk) return;

  const nus = demoAddress("nusantara");
  const frozen = demoAddress("frozen");
  const bal = (w) => read(cv.atoken, tokenAbi, "balanceOf", [w]);
  const [ownerStart, nusStart] = await Promise.all([bal(owner), bal(nus)]);
  const pay$ = (body, headers = {}) => api("POST", `/api/agents/${encodeURIComponent(pay.id)}/actions`, body, headers);
  let moved = 0n;

  // 1. allowed: 250 aUSDC-SIM to Nusantara
  const ok = await pay$({ action: "transfer", amountUsdc: 250, to: nus, asset: "aUSDC" });
  const legs = ok.json?.compliance;
  check(
    "transfer 250 aUSDC to Nusantara is ALLOWED and CONFIRMED",
    ok.status === 200 && ok.json?.decision === "ALLOWED" && ok.json?.ruleId === "R6" && ok.json?.status === "CONFIRMED",
    `status ${ok.status} ${ok.json?.ruleId ?? ""} ${ok.json?.status ?? ""} ${ok.json?.reason ?? ok.json?.error ?? ""}`.trim(),
  );
  check("all three Cleanverse legs pass (simulator)", legs?.asset?.ok && legs?.owner?.ok && legs?.counterparty?.ok && legs?.mode === "simulated", `mode ${legs?.mode}`);
  if (ok.json?.transfer?.txHash) {
    moved += parseUnits("250", 6);
    const rc = await publicClient.getTransactionReceipt({ hash: ok.json.transfer.txHash });
    const executed = eventsFrom(rc, cv.guard, guardAbi).filter((e) => e.eventName === "GuardedTransferExecuted");
    const tokenTransfers = eventsFrom(rc, cv.atoken, tokenAbi).filter((e) => e.eventName === "Transfer");
    const decisions = eventsFrom(rc, addresses.permissions, permAbi).filter((e) => e.eventName === "ActionDecision");
    const bound = executed[0]?.args?.actionHash === keccak256(stringToHex(ok.json.id));
    check(
      "same tx: GuardedTransferExecuted (bound to the action id) + Transfer + ActionDecision",
      rc.status === "success" && executed.length === 1 && bound && tokenTransfers.length === 1 && decisions.length === 1,
      `actionHash bound ${bound}, transfers ${tokenTransfers.length}, decisions ${decisions.length}, log #${ok.json.transfer.logIndex}`,
    );
    const receipt = await api("GET", `/api/v1/actions/${encodeURIComponent(ok.json.id)}`);
    check(
      "GET /api/v1/actions/:id returns the lifecycle and the evidence locator",
      receipt.status === 200 && receipt.json?.status === "CONFIRMED" && receipt.json?.receipt?.transferTxHash === ok.json.transfer.txHash && receipt.json?.receipt?.logIndex === ok.json.transfer.logIndex && receipt.json?.receipt?.mode === "live",
      `status ${receipt.json?.status} tx ${short(receipt.json?.receipt?.transferTxHash)} log #${receipt.json?.receipt?.logIndex} chain ${receipt.json?.receipt?.chainId}`,
    );
  }

  // 2. blocked: frozen and unverified recipients, and no Transfer event
  for (const [label, to, sub] of [
    ["Frozen wallet", frozen, "CVI_FROZEN"],
    ["Unverified wallet", demoAddress("unverified"), "CVI_NOT_FOUND"],
  ]) {
    const r = await pay$({ action: "transfer", amountUsdc: 10, to, asset: "aUSDC" });
    check(`${label} is BLOCKED with R8 ${sub}`, r.status === 403 && r.json?.ruleId === "R8" && r.json?.subCode === sub, `status ${r.status} ${r.json?.ruleId} ${r.json?.subCode}`);
    let transfers = -1;
    if (r.json?.receipt?.txHash && r.json.receipt.mode === "live") {
      const rc = await publicClient.getTransactionReceipt({ hash: r.json.receipt.txHash });
      transfers = eventsFrom(rc, cv.atoken, tokenAbi).filter((e) => e.eventName === "Transfer").length;
    }
    check(`${label}: decision anchored, no Transfer event`, transfers === 0 && !r.json?.transfer, fmtReceipt(r.json?.receipt));
  }

  // 3. idempotency: the same key twice executes once
  const idem = { action: "transfer", amountUsdc: 10, to: nus, asset: "aUSDC" };
  const key = `smoke-${Date.now()}`;
  const i1 = await pay$(idem, { "idempotency-key": key });
  const i2 = await pay$(idem, { "idempotency-key": key });
  if (i1.json?.status === "CONFIRMED") moved += parseUnits("10", 6);
  check(
    "a repeated Idempotency-Key replays the result instead of paying twice",
    i1.json?.status === "CONFIRMED" && i2.json?.id === i1.json?.id && i2.json?.replayed === true,
    `first ${i1.json?.status} ${short(i1.json?.transfer?.txHash)}, second replayed=${i2.json?.replayed} same id=${i2.json?.id === i1.json?.id}`,
  );

  // 4. direct attestations against the owner's on-chain bounds
  const signerKey = process.env.FUKU_COMPLIANCE_SIGNER_KEY?.trim();
  if (!check("FUKU_COMPLIANCE_SIGNER_KEY available for direct attestations", Boolean(signerKey), signerKey ? "" : "set it to the guard's compliance signer")) return;
  const signer = privateKeyToAccount(signerKey.startsWith("0x") ? signerKey : `0x${signerKey}`);
  const attest = async (amount, to = nus) => {
    const [[policyHash], mandate] = await Promise.all([
      read(addresses.permissions, permAbi, "policies", [agentKey]),
      read(cv.guard, guardAbi, "mandates", [agentKey, owner]),
    ]);
    const t = {
      agentId: agentKey,
      from: owner,
      to,
      token: cv.atoken,
      amount,
      policyHash,
      actionHash: keccak256(stringToHex(`smoke:${Date.now()}:${amount}:${Math.random()}`)),
      proofHash: keccak256(stringToHex("smoke-proof")),
      complianceRef: keccak256(stringToHex("smoke-compliance")),
      mandateVersion: mandate[5],
      nonce: BigInt(toHex(randomBytes(32))),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
    };
    const sig = await signer.signTypedData({
      domain: { name: "FukuSpendGuard", version: "1", chainId, verifyingContract: cv.guard },
      types: GUARDED_TRANSFER_TYPES,
      primaryType: "GuardedTransfer",
      message: t,
    });
    return { t, sig };
  };
  const simulate = async ({ t, sig }) => {
    try {
      await publicClient.simulateContract({ address: cv.guard, abi: guardAbi, functionName: "execute", args: [t, sig], account: signer.address });
      return "ok";
    } catch (err) {
      return revertName(err);
    }
  };
  const perTx = await simulate(await attest(maxPerTx + 1n));
  check("an attestation over the per-transfer limit reverts with PerTxLimitExceeded", perTx === "PerTxLimitExceeded", `${formatUnits(maxPerTx + 1n, 6)} → ${perTx}`);
  const wrongPayee = await simulate(await attest(parseUnits("1", 6), frozen));
  check("an attestation to a payee the owner did not approve reverts with PayeeNotApproved", wrongPayee === "PayeeNotApproved", wrongPayee);

  // spend down so the daily cap binds before the per-transfer limit
  const big = await pay$({ action: "transfer", amountUsdc: 440, to: nus, asset: "aUSDC" });
  if (big.json?.status === "CONFIRMED") moved += parseUnits("440", 6);
  check("a second transfer (440) inside the limits is CONFIRMED", big.json?.status === "CONFIRMED", `${big.json?.status} ${big.json?.reason ?? big.json?.error ?? ""}`);
  const spent = await read(cv.guard, guardAbi, "spentToday", [agentKey, owner]);
  const remaining = cap > spent ? cap - spent : 0n;
  const overCap = await simulate(await attest(remaining + 1n));
  check("an over-cap attestation reverts with DailyCapExceeded", overCap === "DailyCapExceeded", `remaining ${formatUnits(remaining, 6)} → ${overCap}`);

  // 5. two concurrent requests that together exceed the remaining budget: exactly one executes
  const [p1, p2] = await Promise.all([
    pay$({ action: "transfer", amountUsdc: 200, to: nus, asset: "aUSDC" }),
    pay$({ action: "transfer", amountUsdc: 200, to: nus, asset: "aUSDC" }),
  ]);
  const winners = [p1, p2].filter((r) => r.json?.status === "CONFIRMED");
  const loser = [p1, p2].find((r) => r.json?.decision === "BLOCKED");
  moved += BigInt(winners.length) * parseUnits("200", 6);
  check("concurrent requests cannot spend the same remainder (one CONFIRMED, one R5)", winners.length === 1 && loser?.json?.ruleId === "R5", `${p1.json?.status}/${p1.json?.ruleId} and ${p2.json?.status}/${p2.json?.ruleId}`);

  const [ownerEnd, nusEnd] = await Promise.all([bal(owner), bal(nus)]);
  check(
    "balances moved exactly once per confirmed transfer",
    ownerStart - ownerEnd === moved && nusEnd - nusStart === moved,
    `expected ${formatUnits(moved, 6)}; owner −${formatUnits(ownerStart - ownerEnd, 6)}, Nusantara +${formatUnits(nusEnd - nusStart, 6)}`,
  );

  // 6. crash recovery: the process "died" after broadcasting the 440 transfer, before storing its hash
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl && big.json?.id) {
    const { PrismaClient } = await import("@prisma/client");
    const db = new PrismaClient();
    try {
      await db.agentAction.update({ where: { id: big.json.id }, data: { status: "SUBMITTED", transferTxHash: null, txHash: null, blockHash: null, logIndex: null } });
      const out = runReconcile();
      const row = await db.agentAction.findUnique({ where: { id: big.json.id } });
      const events = await db.reputationEvent.count({ where: { actionId: big.json.id, kind: "success" } });
      check(
        "reconcile recovers a transfer whose hash was never stored (guard actionExecuted + event log), no double credit",
        row?.status === "CONFIRMED" && row?.transferTxHash === big.json.transfer.txHash && events === 1,
        `${row?.status} tx ${short(row?.transferTxHash)} success events ${events} · ${out}`,
      );
    } finally {
      await db.$disconnect();
    }
  } else {
    check("reconcile crash-recovery check", false, "DATABASE_URL not set for the smoke (point it at the web instance's database)");
  }

  // 7. a pre-signed attestation, then revoke in the app
  const pre = await attest(parseUnits("1", 6));
  const before = await simulate(pre);
  check("pre-signed 1 aUSDC attestation is valid before the revoke", before === "ok", before);
  const rev = await api("DELETE", `/api/agents/${encodeURIComponent(pay.id)}/policy`);
  const revTx = rev.json?.chainSync?.receipts?.find((r) => r.op === "revokePolicy");
  let revoked = false;
  if (revTx?.txHash && revTx.mode === "live") {
    const rc = await publicClient.getTransactionReceipt({ hash: revTx.txHash });
    revoked = eventsFrom(rc, addresses.permissions, permAbi).some((e) => e.eventName === "PolicyRevoked" && e.args.agentId === agentKey);
  }
  check("revoking in the app emits PolicyRevoked on-chain", rev.status === 200 && rev.json?.chainSync?.ok && revoked, JSON.stringify(rev.json?.chainSync ?? rev.json).slice(0, 160));
  const afterRevoke = await simulate(pre);
  check("the pre-signed attestation now reverts with PolicyNotActive", afterRevoke === "PolicyNotActive", afterRevoke);
  const blocked = await pay$({ action: "transfer", amountUsdc: 1, to: nus, asset: "aUSDC" });
  check("after the revoke the app blocks the agent (R0/R1) and nothing moves", blocked.status === 403 && ["R0", "R1"].includes(blocked.json?.ruleId), `${blocked.json?.ruleId}`);

  // 8. reorg: a confirmed transfer that disappears from the chain goes back to PENDING and loses its credit
  await signIn(true);
  if (dbUrl) {
    const snapshot = await publicClient.request({ method: "evm_snapshot", params: [] });
    const r = await pay$({ action: "transfer", amountUsdc: 5, to: nus, asset: "aUSDC" });
    await publicClient.request({ method: "evm_revert", params: [snapshot] });
    const out = runReconcile();
    const { PrismaClient } = await import("@prisma/client");
    const db = new PrismaClient();
    try {
      const row = r.json?.id ? await db.agentAction.findUnique({ where: { id: r.json.id } }) : null;
      const events = r.json?.id ? await db.reputationEvent.count({ where: { actionId: r.json.id, kind: "success" } }) : -1;
      check(
        "a reorged-out confirmation returns to PENDING and its success no longer counts",
        r.json?.status === "CONFIRMED" && row?.status === "PENDING" && events === 0,
        `before ${r.json?.status}, after ${row?.status}, success events ${events} · ${out}`,
      );
    } finally {
      await db.$disconnect();
    }
  }

  // leave the demo usable for the next run
  await signIn(true);
}

/** Run the reconciler in its own process (same database and chain env), as a cron would. */
function runReconcile() {
  const out = execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "scripts/reconcile.ts", "--limit", "50"], {
    cwd: path.resolve(here, ".."),
    env: process.env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return out.trim().split("\n").pop();
}

main()
  .then(async () => {
    const cv = loadCleanverse();
    if (!cv) {
      console.log("\nCleanverse section skipped: no FUKU_SPEND_GUARD / CLEANVERSE_SIM_ATOKEN.");
      return;
    }
    const publicClient = createPublicClient({ transport: http(RPC_URL) });
    await cleanverseSmoke(publicClient, loadAddresses(), cv).catch((err) => check("Cleanverse section completed", false, err.stack ?? String(err)));
  })
  .then(() => process.exit(printTable() ? 0 : 1))
  .catch((err) => {
    console.error(`\nSMOKE TEST ABORTED: ${err.stack ?? err}`);
    printTable();
    process.exit(1);
  });
