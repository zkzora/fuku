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
 * Exit code 0 when every check passes, 1 otherwise.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, keccak256, parseAbi, stringToHex } from "viem";

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

async function api(method, route, body) {
  const res = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: { "content-type": "application/json", cookie },
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

async function signIn() {
  const res = await fetch(`${BASE_URL}/api/auth/demo?next=/dashboard`, { redirect: "manual" });
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

main()
  .then(() => process.exit(printTable() ? 0 : 1))
  .catch((err) => {
    console.error(`\nSMOKE TEST ABORTED: ${err.stack ?? err}`);
    printTable();
    process.exit(1);
  });
