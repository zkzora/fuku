#!/usr/bin/env tsx
/**
 * npm run demo:preflight: is the demo ready to present? READ-ONLY: it reads the app's database, the
 * chain over MONAD_RPC_URL and, when the app is up, its /api/integrations. It sends no transaction,
 * writes nothing, calls no third-party API, and never prints a key (only addresses derived from them).
 *
 *   RPC        reachable, the configured chain, a fresh latest block, code at every contract
 *   Roles      the guard's compliance signer is FUKU_COMPLIANCE_SIGNER_KEY's address; the relayer is
 *              enforcer and scorer; the guard is an enforcer
 *   Balances   relayer and Ava (MON); Ava's aUSDC-SIM and her allowance to the guard
 *   Mandates   for each A-Token agent the demo pays from (Payments Agent, MCP Assistant): active, the
 *              token, per-transfer limit and remaining daily budget against the demo's amounts, expiry,
 *              Nusantara approved; the passport's own daily budget left in Fuku
 *   A-Passes   the simulator passes the beats rely on (Ava, Nusantara ok, the frozen wallet frozen)
 *   DB/chain   per demo agent: registered, status, passport hash and active flag, anchored score vs
 *              Fuku's, ERC-8004 owner and agentWallet; Ava's identity controller and passkey flag;
 *              actions still pending or failed
 *   MCP        mcp/.env holds an agent key (not the owner's), for the MCP Assistant, whose agent key
 *              matches the address Fuku has
 *   App        when FUKU_BASE_URL answers: live mode on the same chain
 *
 * Exit code 0 with no ✗ (warnings ! are allowed), 1 otherwise. Usage: npm run demo:preflight [-- --json]
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatEther, formatUnits, getAddress, http, isAddressEqual, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const webEnv = path.join(here, "..", ".env");
if (existsSync(webEnv)) process.loadEnvFile(webEnv);

/** What the pitch moves: the Payments Agent pays 250, the MCP Assistant 30 (docs/PITCH.md). */
const DEMO_PAYMENTS = { payments: 250, mcp: 30 };
const MON_RELAYER_FAIL = parseEther("0.2");
const MON_RELAYER_WARN = parseEther("1");
const MON_AVA_WARN = parseEther("0.05");
const MANDATE_EXPIRY_WARN_S = 3 * 24 * 3600;
const BLOCK_AGE_WARN_S = 120;

type Level = "ok" | "warn" | "fail" | "info";
const rows: { section: string; level: Level; name: string; detail: string }[] = [];
let section = "";
const mark: Record<Level, string> = {
  ok: "✓",
  warn: "!",
  fail: "✗",
  info: "·",
};
function report(level: Level, name: string, detail = "") {
  rows.push({ section, level, name, detail });
  if (!process.argv.includes("--json")) console.log(`  ${mark[level]} ${name}${detail ? `  (${detail})` : ""}`);
}
const ok = (cond: boolean, name: string, detail = "", failLevel: Level = "fail") => {
  report(cond ? "ok" : failLevel, name, detail);
  return cond;
};
function heading(title: string) {
  section = title;
  if (!process.argv.includes("--json")) console.log(`\n${title}`);
}

function addressOf(envName: string): Address | null {
  const raw = process.env[envName]?.trim();
  if (!raw) return null;
  const k = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  return /^0x[0-9a-fA-F]{64}$/.test(k) ? privateKeyToAccount(k).address : null;
}

function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

const usd = (micros: bigint) => Number(micros) / 1e6;
const message = (err: unknown) => (err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message) : String(err)).slice(0, 160);

/**
 * Monad's public RPC allows 15 requests a second and answers more with 429 or JSON-RPC error -32011
 * ("requests limited to 15/sec"), which viem does not retry. Requests are spaced to about 9 a second,
 * and a limited one is retried after a pause.
 */
let nextSlot = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function throttledFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const slot = Math.max(Date.now(), nextSlot);
    nextSlot = slot + 110;
    await sleep(slot - Date.now());
    const res = await fetch(input, init);
    if (attempt >= 6) return res;
    const limited = res.status === 429 || (res.ok && (await res.clone().text()).includes("requests limited"));
    if (!limited) return res;
    await sleep(1000 * (attempt + 1));
  }
}

/** One section: an RPC or database error fails that section only, and the rest still runs. */
async function step(name: string, run: () => Promise<void>) {
  try {
    await run();
  } catch (err) {
    report("fail", `${name}: could not be read`, message(err));
  }
}
const ago = (s: number) => (s < 120 ? `${s} s ago` : `${Math.round(s / 60)} min ago`);

async function main() {
  const { db } = await import("../src/lib/db");
  const { idToBytes32 } = await import("../src/lib/ids");
  const abi = await import("../src/lib/chain/abi");
  const { Erc8004IdentityRegistryAbi } = await import("../src/lib/erc8004/abi");
  const { erc8004IdentityRegistry } = await import("../src/lib/erc8004");
  const { DEMO_RECIPIENTS } = await import("../src/lib/cleanverse/demo");
  const { DEMO_IDENTITY_ID, demoCohort, demoAgentIds, keptDemoAgents } = await import("../src/lib/demo-seed");
  const { utcDayKey, utcDayStart } = await import("../src/lib/engine/permission");

  const rpc = process.env.MONAD_RPC_URL?.trim() || "https://testnet-rpc.monad.xyz";
  const wantChain = Number(process.env.FUKU_CHAIN_ID ?? 10143);
  const client = createPublicClient({ transport: http(rpc, { timeout: 15_000, fetchFn: throttledFetch }) });
  const now = Math.floor(Date.now() / 1000);
  console.log(`Demo preflight, read-only. Database ${process.env.DATABASE_URL ?? "(default)"}; RPC ${rpc}`);

  // --- Database --------------------------------------------------------------------------------
  heading("Database");
  const schema = await db.apiKey
    .findFirst({ select: { id: true, agentId: true, scopes: true } })
    .then(() => null)
    .catch((err: Error) => err.message.split("\n").filter(Boolean).pop() ?? err.message);
  ok(schema === null, "the schema is current (agent keys: ApiKey.agentId, ApiKey.scopes)", schema ? `${schema.slice(0, 100)}: back up prisma/dev.db, then cd web && npx prisma db push` : "");
  if (schema) return;

  // --- RPC and contracts ---------------------------------------------------------------------
  heading("RPC and contracts");
  if (process.env.FUKU_CHAIN_MODE !== "live") report("warn", "FUKU_CHAIN_MODE is not live", String(process.env.FUKU_CHAIN_MODE ?? "unset"));
  const t0 = Date.now();
  const chainId = await client.getChainId().catch((err: Error) => {
    report("fail", "the RPC answers", err.message.slice(0, 120));
    return null;
  });
  if (chainId === null) return;
  const block = await client.getBlock();
  report("ok", "the RPC answers", `${Date.now() - t0} ms`);
  ok(chainId === wantChain, "the RPC's chain is FUKU_CHAIN_ID", `${chainId}`);
  const age = now - Number(block.timestamp);
  ok(age < BLOCK_AGE_WARN_S, "the latest block is recent", `#${block.number}, ${ago(Math.max(0, age))}`, "warn");
  const c = {
    identity: process.env.FUKU_IDENTITY_REGISTRY as Address | undefined,
    agents: process.env.FUKU_AGENT_REGISTRY as Address | undefined,
    permissions: process.env.FUKU_PERMISSION_REGISTRY as Address | undefined,
    reputation: process.env.FUKU_REPUTATION_REGISTRY as Address | undefined,
    guard: process.env.FUKU_SPEND_GUARD as Address | undefined,
    apass: process.env.CLEANVERSE_SIM_APASS as Address | undefined,
    token: process.env.CLEANVERSE_SIM_ATOKEN as Address | undefined,
  };
  for (const [name, addr] of Object.entries(c)) {
    if (!addr) {
      report("fail", `${name} address configured`, "unset in web/.env");
      continue;
    }
    const code = await client.getCode({ address: addr });
    ok(Boolean(code && code !== "0x"), `${name} has code`, addr);
  }
  if (!c.identity || !c.agents || !c.permissions || !c.reputation || !c.guard || !c.apass || !c.token) return;
  const C = c as { [K in keyof typeof c]: Address };

  // --- Roles ---------------------------------------------------------------------------------
  heading("Roles");
  const relayer = addressOf("DEPLOYER_PRIVATE_KEY");
  const ava = addressOf("DEMO_OWNER_PRIVATE_KEY");
  const signer = addressOf("FUKU_COMPLIANCE_SIGNER_KEY");
  const onChainSigner = await client.readContract({
    address: C.guard,
    abi: abi.FukuSpendGuardAbi,
    functionName: "complianceSigner",
  });
  ok(Boolean(signer) && isAddressEqual(onChainSigner, signer!), "the guard's compliance signer is FUKU_COMPLIANCE_SIGNER_KEY", `${onChainSigner}`);
  if (relayer) {
    const [enf, scorer, guardEnf] = await Promise.all([
      client.readContract({
        address: C.permissions,
        abi: abi.PermissionRegistryAbi,
        functionName: "enforcers",
        args: [relayer],
      }),
      client.readContract({
        address: C.reputation,
        abi: abi.ReputationRegistryAbi,
        functionName: "scorers",
        args: [relayer],
      }),
      client.readContract({
        address: C.permissions,
        abi: abi.PermissionRegistryAbi,
        functionName: "enforcers",
        args: [C.guard],
      }),
    ]);
    ok(enf && scorer, "the relayer is enforcer and scorer", relayer);
    ok(guardEnf, "the guard is an enforcer on PermissionRegistry");
  } else report("fail", "DEPLOYER_PRIVATE_KEY is set (the relayer)");

  // --- Balances ------------------------------------------------------------------------------
  heading("Balances");
  if (relayer) {
    const bal = await client.getBalance({ address: relayer });
    report(
      bal < MON_RELAYER_FAIL ? "fail" : bal < MON_RELAYER_WARN ? "warn" : "ok",
      "relayer MON",
      `${formatEther(bal)} (pays every anchor, transfer and score; a fresh cohort needs about 0.41)`,
    );
  }
  if (!ava) {
    report("fail", "DEMO_OWNER_PRIVATE_KEY is set (Ava's wallet)");
    return;
  }
  const avaMon = await client.getBalance({ address: ava });
  report(avaMon < MON_AVA_WARN ? "warn" : "ok", "Ava's wallet MON", `${formatEther(avaMon)} (only for her own transactions: mandates, payees, ERC-8004; the pitch needs none)`);
  const decimals = await client.readContract({
    address: C.token,
    abi: abi.CleanverseATokenSimAbi,
    functionName: "decimals",
  });
  const [avaToken, allowance] = await Promise.all([
    client.readContract({
      address: C.token,
      abi: abi.CleanverseATokenSimAbi,
      functionName: "balanceOf",
      args: [ava],
    }),
    client.readContract({
      address: C.token,
      abi: abi.CleanverseATokenSimAbi,
      functionName: "allowance",
      args: [ava, C.guard],
    }),
  ]);
  const need = BigInt((DEMO_PAYMENTS.payments + DEMO_PAYMENTS.mcp) * 10 ** decimals);
  ok(avaToken >= need, "Ava's aUSDC-SIM covers the demo payments (250 + 30)", `${formatUnits(avaToken, decimals)} (SIMULATED token)`);
  ok(allowance >= need, "Ava's allowance to the guard covers them", formatUnits(allowance, decimals));

  // --- Demo agents: mandates and DB/chain consistency -----------------------------------------
  const cohort = await demoCohort(db);
  const ids = demoAgentIds(cohort);
  const kept = await keptDemoAgents(db);
  const agents = await db.agent.findMany({
    where: { id: { in: [...Object.values(ids), ...kept] } },
    include: { policy: true, identity: { select: { id: true } } },
    orderBy: { createdAt: "asc" },
  });
  const missing = Object.entries(ids).filter(([, id]) => !agents.some((a) => a.id === id));
  heading(`Demo agents (cohort ${cohort}, ${agents.length} in the database)`);
  ok(
    missing.length === 0,
    "every cohort agent is in the database",
    missing.length ? `missing: ${missing.map(([k]) => k).join(", ")}: open /api/auth/demo?reset=1` : Object.keys(ids).join(", "),
  );

  const nusantara = DEMO_RECIPIENTS.find((r) => r.label === "nusantara")!.address as Address;
  /** Fuku's spend today, as lib/services/budget.ts counts it, without creating its window row. */
  const passportSpentToday = async (agentId: string): Promise<bigint> => {
    const window = await db.budgetWindow.findUnique({
      where: { id: `${agentId}:transfer:${utcDayKey()}` },
    });
    if (window) return window.spentMicros;
    const done = await db.agentAction.findMany({
      where: {
        agentId,
        action: "transfer",
        decision: "ALLOWED",
        createdAt: { gte: utcDayStart() },
        OR: [{ status: null }, { status: { notIn: ["FAILED", "DENIED"] } }],
      },
      select: { amountMicros: true, amountUsdc: true },
    });
    return done.reduce((sum, r) => sum + (r.amountMicros ?? (r.amountUsdc ? BigInt(Math.round(r.amountUsdc * 1e6)) : BigInt(0))), BigInt(0));
  };
  const pitchAmount = (id: string) => (id === ids.payments ? DEMO_PAYMENTS.payments : kept.includes(id) ? DEMO_PAYMENTS.mcp : null);

  for (const agent of agents) {
    await step(agent.name, async () => {
      heading(`${agent.name}  ${agent.id}`);
      const key = idToBytes32(agent.id);
      const exists = await client.readContract({
        address: C.agents,
        abi: abi.AgentRegistryAbi,
        functionName: "exists",
        args: [key],
      });
      if (!ok(exists, "registered in AgentRegistry", exists ? "" : "seeded history not anchored: npm run reconcile -- --anchor-seeded (sends transactions)")) return;
      const [record, policy, score, owner] = await Promise.all([
        client.readContract({
          address: C.agents,
          abi: abi.AgentRegistryAbi,
          functionName: "agents",
          args: [key],
        }) as Promise<readonly unknown[]>,
        client.readContract({
          address: C.permissions,
          abi: abi.PermissionRegistryAbi,
          functionName: "policies",
          args: [key],
        }),
        client.readContract({
          address: C.reputation,
          abi: abi.ReputationRegistryAbi,
          functionName: "getScore",
          args: [key],
        }),
        client.readContract({
          address: C.agents,
          abi: abi.AgentRegistryAbi,
          functionName: "ownerOf",
          args: [key],
        }),
      ]);
      ok(owner === idToBytes32(agent.identityId), "on-chain owner is its Fuku identity", agent.identityId);
      const status = Number(record[5]);
      const statusDetail = `Fuku ${agent.status}, chain ${["registered", "active", "paused", "revoked"][status] ?? status}`;
      const fukuExecutable = agent.status === "active" || agent.status === "registered";
      if (fukuExecutable === status < 2) report("ok", "status agrees (Fuku vs AgentRegistry)", statusDetail);
      else if (!fukuExecutable) report("warn", "status: Fuku is stricter than the chain (Fuku blocks it; the registry still lists it executable)", statusDetail);
      else report("fail", "status: the chain pauses or revokes an agent Fuku runs", statusDetail);
      if (agent.policy?.policyHash) {
        ok(
          policy[0].toLowerCase() === agent.policy.policyHash.toLowerCase() && policy[3] === agent.policy.active,
          "passport hash and active flag agree",
          `v${agent.policy.version} Fuku / v${policy[1]} chain, active ${agent.policy.active} / ${policy[3]}`,
        );
      } else ok(!policy[3], "no passport in Fuku, none active on-chain", `chain v${policy[1]}, active ${policy[3]}`);
      const [chainScore, updatedAt, scored] = score;
      const inCohort = Object.values(ids).includes(agent.id);
      ok(
        scored && Number(chainScore) === agent.trustScore,
        "anchored score equals Fuku's",
        scored
          ? `Fuku ${agent.trustScore}, chain ${chainScore} (anchored ${new Date(Number(updatedAt) * 1000).toISOString().slice(0, 16)}Z)${inCohort && Number(chainScore) !== agent.trustScore ? ": live actions ran on this cohort before a reset, which does not rewind the chain; Recompute from chain will not match. npm run demo:cohort -- --allow-testnet" : ""}`
          : "no score anchored",
        inCohort ? "fail" : "warn",
      );
      if (agent.erc8004Id) {
        const registry = erc8004IdentityRegistry(chainId);
        if (registry) {
          const [nftOwner, agentWallet] = await Promise.all([
            client.readContract({
              address: registry,
              abi: Erc8004IdentityRegistryAbi,
              functionName: "ownerOf",
              args: [BigInt(agent.erc8004Id)],
            }),
            client.readContract({
              address: registry,
              abi: Erc8004IdentityRegistryAbi,
              functionName: "getAgentWallet",
              args: [BigInt(agent.erc8004Id)],
            }),
          ]);
          ok(
            isAddressEqual(nftOwner, ava) && Boolean(agent.agentWallet) && isAddressEqual(agentWallet, agent.agentWallet as Address),
            `ERC-8004 #${agent.erc8004Id}: owned by Ava, agentWallet = Fuku's record`,
            `${agentWallet}`,
          );
        }
      }
      const open = await db.agentAction.count({
        where: {
          agentId: agent.id,
          OR: [{ status: { in: ["PENDING", "SUBMITTED"] } }, { anchorStatus: { in: ["pending", "failed"] } }],
        },
      });
      ok(open === 0, "no actions pending or failed", open ? `${open}: run npm run reconcile` : "", "warn");

      const amount = pitchAmount(agent.id);
      if (amount === null) return;
      const [m, spent, payee] = await Promise.all([
        client.readContract({
          address: C.guard,
          abi: abi.FukuSpendGuardAbi,
          functionName: "mandates",
          args: [key, ava],
        }),
        client.readContract({
          address: C.guard,
          abi: abi.FukuSpendGuardAbi,
          functionName: "spentToday",
          args: [key, ava],
        }),
        client.readContract({
          address: C.guard,
          abi: abi.FukuSpendGuardAbi,
          functionName: "isPayee",
          args: [key, ava, nusantara],
        }),
      ]);
      const [token, dailyCap, maxPerTx, validUntil, restrictPayees, version, active] = m;
      const want = BigInt(amount * 10 ** decimals);
      if (!ok(active && isAddressEqual(token, C.token), "Ava's mandate is open for aUSDC-SIM", `v${version}`)) return;
      ok(maxPerTx === BigInt(0) || maxPerTx >= want, `per-transfer limit allows the pitch's ${amount}`, maxPerTx ? formatUnits(maxPerTx, decimals) : "none");
      ok(dailyCap - spent >= want, `today's mandate budget left covers ${amount}`, `${formatUnits(dailyCap - spent, decimals)} of ${formatUnits(dailyCap, decimals)} (UTC day)`);
      const left = Number(validUntil) - now;
      report(
        validUntil === BigInt(0) ? "ok" : left <= 0 ? "fail" : left < MANDATE_EXPIRY_WARN_S ? "warn" : "ok",
        "mandate expiry",
        validUntil === BigInt(0) ? "none" : `${new Date(Number(validUntil) * 1000).toISOString().slice(0, 10)} (${Math.floor(left / 86400)} days)`,
      );
      ok(!restrictPayees || payee, "Nusantara Supplies is an approved payee", restrictPayees ? "payees restricted" : "no payee restriction");
      const limit = agent.policy
        ? (
            JSON.parse(agent.policy.allowed) as {
              action: string;
              limitUsdcPerDay?: number;
            }[]
          ).find((r) => r.action === "transfer")?.limitUsdcPerDay
        : undefined;
      if (limit !== undefined) {
        const spentFuku = usd(await passportSpentToday(agent.id));
        ok(limit - spentFuku >= amount, `the passport's daily transfer budget covers ${amount}`, `${limit - spentFuku} of ${limit} left today in Fuku`);
      }
    });
  }

  // --- Simulator A-Passes ------------------------------------------------------------------------
  heading("Cleanverse SIMULATOR A-Passes (Fuku's contracts, not Cleanverse)");
  await step("A-Passes", async () => {
    for (const [label, wallet, wantStatus] of [["Ava", ava, 1], ...DEMO_RECIPIENTS.filter((r) => r.apass).map((r) => [r.name, r.address, r.apass!.status])] as [
      string,
      Address,
      number,
    ][]) {
      const p = await client.readContract({
        address: C.apass,
        abi: abi.CleanverseAPassSimAbi,
        functionName: "passOf",
        args: [wallet],
      });
      const expired = Number(p.expiresAt) > 0 && Number(p.expiresAt) < now;
      ok(
        p.status === wantStatus && !expired,
        `${label}: status ${wantStatus === 1 ? "active" : "frozen"}`,
        `${getAddress(wallet)} status ${p.status}${expired ? ", EXPIRED" : ""}`,
      );
    }
  });

  // --- Ava's identity ----------------------------------------------------------------------------
  heading("Ava's identity");
  await step("Ava's identity", async () => {
    const avaRow = await db.identity.findUnique({
      where: { id: DEMO_IDENTITY_ID },
    });
    if (ok(Boolean(avaRow), "Ava is in the database")) {
      ok(Boolean(avaRow!.walletAddress) && isAddressEqual(avaRow!.walletAddress as Address, ava), "her bound wallet is DEMO_OWNER_PRIVATE_KEY's", avaRow!.walletAddress ?? "none");
      const ik = idToBytes32(DEMO_IDENTITY_ID);
      const [controller, human] = await Promise.all([
        client.readContract({
          address: C.identity,
          abi: abi.HumanIdentityRegistryAbi,
          functionName: "controllerOf",
          args: [ik],
        }),
        client.readContract({
          address: C.identity,
          abi: abi.HumanIdentityRegistryAbi,
          functionName: "isHuman",
          args: [ik],
        }),
      ]);
      ok(Boolean(relayer) && isAddressEqual(controller, relayer!), "custodial: the relayer controls her identity on-chain (labelled in the app)", controller);
      ok(human === avaRow!.humanVerified, "passkey flag agrees (Fuku vs HumanIdentityRegistry)", `${avaRow!.humanVerified} / ${human}`);
    }
  });

  // --- MCP -------------------------------------------------------------------------------------
  heading("MCP server configuration (mcp/.env)");
  await step("MCP configuration", async () => {
    const mcpEnv = process.env.FUKU_MCP_ENV_FILE?.trim() || path.join(repoRoot, "mcp", ".env");
    if (!existsSync(mcpEnv)) report("info", "no mcp/.env: the MCP beat is not set up on this machine");
    else {
      const m = readEnvFile(mcpEnv);
      const apiKey = m.FUKU_API_KEY ?? "";
      ok(
        apiKey.startsWith("fk_agent_"),
        "FUKU_API_KEY is an agent key, not the owner's",
        apiKey.startsWith("fk_live_") ? "owner key: run npm run mcp:setup -- --key-only" : apiKey ? `${apiKey.slice(0, 9)}…` : "unset",
      );
      const mcpAgent = m.FUKU_AGENT_ID ? agents.find((a) => a.id === m.FUKU_AGENT_ID) : null;
      ok(Boolean(mcpAgent) && kept.includes(m.FUKU_AGENT_ID), "FUKU_AGENT_ID is the kept MCP Assistant", m.FUKU_AGENT_ID ?? "unset");
      const pk = m.FUKU_AGENT_PRIVATE_KEY;
      if (mcpAgent && pk && /^0x[0-9a-fA-F]{64}$/.test(pk)) {
        const addr = privateKeyToAccount(pk as Hex).address;
        ok(
          Boolean(mcpAgent.agentWallet) && isAddressEqual(addr, mcpAgent.agentWallet as Address) && !mcpAgent.agentKey,
          "its agent key is the one Fuku has (held on this machine only)",
          addr,
        );
      } else report("warn", "FUKU_AGENT_PRIVATE_KEY is set", "without it the server is read-only");
      if (apiKey.startsWith("fk_agent_")) {
        const { hashApiKey } = await import("../src/lib/services/identity");
        const row = await db.apiKey.findFirst({
          where: { keyHash: hashApiKey(apiKey) },
          select: { agentId: true },
        });
        ok(
          Boolean(row) && row!.agentId === m.FUKU_AGENT_ID,
          "the agent key is known to this database and bound to that agent",
          row ? "" : "unknown here: another database, or revoked",
        );
      }
    }
  });

  // --- App -------------------------------------------------------------------------------------
  heading("App");
  const base = (process.env.FUKU_BASE_URL?.trim() || "http://localhost:3001").replace(/\/+$/, "");
  const integrations = await fetch(`${base}/api/integrations`, {
    signal: AbortSignal.timeout(10_000),
  })
    .then((r) => (r.ok ? (r.json() as Promise<{ chain?: { mode?: string; chainId?: number } }>) : null))
    .catch(() => null);
  if (!integrations) report("warn", `the app answers at ${base}`, "not running (start it in its own window)");
  else
    ok(
      integrations.chain?.mode === "live" && integrations.chain?.chainId === chainId,
      `the app at ${base} is live on chain ${chainId}`,
      `${integrations.chain?.mode} ${integrations.chain?.chainId}`,
    );
}

main()
  .catch((err) => report("fail", "the preflight completed", err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message) : String(err)))
  .finally(async () => {
    const fails = rows.filter((r) => r.level === "fail");
    const warns = rows.filter((r) => r.level === "warn");
    if (process.argv.includes("--json")) console.log(JSON.stringify({ ok: fails.length === 0, rows }, null, 2));
    else {
      console.log(
        `\n${fails.length ? "✗ NOT READY" : warns.length ? "! READY WITH WARNINGS" : "✓ READY"}: ${rows.filter((r) => r.level === "ok").length} ok, ${warns.length} warning(s), ${fails.length} failure(s)`,
      );
      console.log(
        [
          "",
          "A demo reset (/api/auth/demo?reset=1) reseeds the DATABASE only. It does not touch the chain: registrations,",
          "anchored passports, decisions and scores, mandates and today's spent budget, token balances and ERC-8004",
          "registrations stay as they are. After live actions on the demo agents (the climax, a payment), a reset shows",
          'the seeded scores while the chain keeps the new ones: "anchored score equals Fuku\'s" fails for that cohort and',
          "Recompute from chain no longer matches. Present again with `npm run demo:cohort -- --allow-testnet` (a fresh",
          "cohort; about 0.69 MON), not with a reset. The MCP Assistant's daily budget refills at 00:00 UTC.",
        ].join("\n"),
      );
    }
    const { db } = await import("../src/lib/db");
    await db.$disconnect();
    process.exitCode = fails.length ? 1 : 0;
  });
