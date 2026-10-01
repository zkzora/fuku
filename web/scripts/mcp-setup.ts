#!/usr/bin/env tsx
/**
 * npm run mcp:setup: a dedicated Fuku agent for the MCP server, "MCP Assistant" under Ava (the
 * custodial demo identity). It is separate from the demo cohort, so rehearsing on it never touches
 * the pitch agents. Idempotent: only the missing steps run. It follows the path examples/sdk-consumer
 * takes, through @fuku/sdk:
 *   1. an agent key generated here, saved only to mcp/.env (checked to be gitignored first);
 *   2. the agent registered under Ava, with that key as its agent key and, on a chain with the
 *      canonical ERC-8004 Identity Registry, registered there from Ava's wallet with the key as its
 *      agentWallet;
 *   3. its passport: transfer up to 100 aUSDC a day (assets: aUSDC), read_balances; withdraw and
 *      change_owner blocked;
 *   4. Ava's mandate: 100 aUSDC a day, 50 per transfer, Nusantara Supplies the only payee;
 *   5. a demo reset keeps it, with its history and score (Setting demo.keepAgents).
 * It prints the ids, every transaction, the MON spent and the MCP client configuration (the private
 * key only as a placeholder).
 *
 * Environment: web/.env, where exported variables take precedence. It needs DATABASE_URL (the app's
 * database), MONAD_RPC_URL, DEMO_OWNER_PRIVATE_KEY (Ava's wallet), and DEPLOYER_PRIVATE_KEY (only to
 * read the relayer's balance). FUKU_BASE_URL defaults to http://localhost:3001 and FUKU_API_KEY to the
 * demo key.
 * Ava's wallet sends the mandate and ERC-8004 transactions, and the app's relayer anchors the agent
 * and its passport. It refuses any RPC but a local node unless --allow-testnet is given.
 *
 * Usage: npm run mcp:setup -- [--fresh] [--allow-testnet] [--mcp-env <path, default mcp/.env>]
 *        --fresh registers a brand-new MCP agent (the old mcp/.env is kept as a timestamped backup).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, encodeFunctionData, formatEther, http, isAddressEqual, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const repoRoot = path.resolve(webDir, "..");
const webEnv = path.join(webDir, ".env");
if (existsSync(webEnv)) process.loadEnvFile(webEnv);

const DEMO_API_KEY = "fk_live_demo_ava_chen_2026";
const NAME = "MCP Assistant";
const DESCRIPTION = "An AI assistant (Claude, through the Fuku MCP server) acting under Ava's passport: pays approved suppliers in aUSDC, never withdraws.";
const PASSPORT = {
  allowed: [{ action: "transfer", limitUsdcPerDay: 100 }, { action: "read_balances" }],
  blocked: ["withdraw", "change_owner"],
  scopeApps: [] as string[],
  assets: ["aUSDC"],
};
const DAILY_CAP = BigInt(100_000_000); // 100 aUSDC-SIM (6 decimals)
const MAX_PER_TX = BigInt(50_000_000);
const MANDATE_DAYS = 30;

class SetupError extends Error {}
const fail = (msg: string): never => {
  throw new SetupError(msg);
};
const out = (line = "") => process.stdout.write(`${line}\n`);

function key(name: string): Hex | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const k = raw.startsWith("0x") ? raw : `0x${raw}`;
  return /^0x[0-9a-fA-F]{64}$/.test(k) ? (k as Hex) : null;
}

function readEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

function writeEnvFile(file: string, values: Record<string, string>, comment: string[]) {
  const body = [
    "# Fuku MCP server configuration, written by `npm run mcp:setup`. Holds a private key: never commit it.",
    ...comment.map((c) => `# ${c}`),
    ...Object.entries(values).map(([k, v]) => `${k}=${v}`),
    "",
  ].join("\n");
  writeFileSync(file, body, { mode: 0o600 });
}

/** Refuse to write a private key anywhere git would pick it up. */
function assertIgnored(file: string) {
  const rel = path.relative(repoRoot, file);
  if (rel.startsWith("..")) return; // outside the repository
  const r = spawnSync("git", ["check-ignore", "-q", rel], { cwd: repoRoot });
  if (r.status !== 0) fail(`${rel} is not gitignored; refusing to write a private key there.`);
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

async function main() {
  const args = process.argv.slice(2);
  const fresh = args.includes("--fresh");
  const i = args.indexOf("--mcp-env");
  const envFile = path.resolve(repoRoot, i >= 0 ? args[i + 1] : path.join("mcp", ".env"));
  const baseUrl = (process.env.FUKU_BASE_URL?.trim() || "http://localhost:3001").replace(/\/+$/, "");
  const apiKey = process.env.FUKU_API_KEY?.trim() || DEMO_API_KEY;
  const rpc = process.env.MONAD_RPC_URL?.trim() || "https://testnet-rpc.monad.xyz";
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(rpc);
  if (!local && !args.includes("--allow-testnet")) fail(`${rpc} is not a local node; pass --allow-testnet to send transactions there.`);
  const avaKey = key("DEMO_OWNER_PRIVATE_KEY") ?? fail("DEMO_OWNER_PRIVATE_KEY is not set: Ava's wallet opens the mandate and owns the ERC-8004 agent.");
  const ava = privateKeyToAccount(avaKey);
  const relayerKey = key("DEPLOYER_PRIVATE_KEY");
  const relayer = relayerKey ? privateKeyToAccount(relayerKey).address : null;
  assertIgnored(envFile);

  const { Fuku } = await import("../../sdk/src/index");
  const { db } = await import("../src/lib/db");
  const { DEMO_IDENTITY_ID, keepAgentAcrossDemoResets } = await import("../src/lib/demo-seed");
  const { CleanverseATokenSimAbi, FukuSpendGuardAbi } = await import("../src/lib/chain/abi");
  const { DEMO_RECIPIENTS } = await import("../src/lib/cleanverse/demo");

  const pub = createPublicClient({ transport: http(rpc) });
  const chainId = await pub.getChainId();
  const chain = { id: chainId, name: "fuku", nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as const;
  const avaWallet = createWalletClient({ account: ava, chain, transport: http(rpc) });
  const fuku = new Fuku({ apiKey, baseUrl });
  const nusantara = DEMO_RECIPIENTS.find((r) => r.label === "nusantara")!;

  const balances = async () => ({
    ava: await pub.getBalance({ address: ava.address }),
    relayer: relayer ? await pub.getBalance({ address: relayer }) : BigInt(0),
  });
  const start = await balances();
  const txs: { by: "Ava" | "relayer"; label: string; hash: Hex }[] = [];
  const noteReceipt = (label: string, r: { txHash: string | null; mode: string }) => {
    if (r.txHash && r.mode === "live") txs.push({ by: "relayer", label, hash: r.txHash as Hex });
  };
  const send = async (label: string, tx: { to: string; data: string }) => {
    const hash = await avaWallet.sendTransaction({ to: tx.to as Address, data: tx.data as Hex });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") fail(`${label} reverted (tx ${hash})`);
    txs.push({ by: "Ava", label, hash });
    out(`  tx ${label.padEnd(26)} ${hash}`);
    return hash;
  };

  out(`MCP agent setup on chain ${chainId} (${rpc}), Fuku at ${baseUrl}`);
  out(`  Ava's wallet ${ava.address}${relayer ? `, relayer ${relayer}` : ""}`);

  // 1. The agent and its key
  out("\n1. Agent and agent key");
  let saved = existsSync(envFile) ? readEnvFile(envFile) : {};
  if (fresh && existsSync(envFile)) {
    const backup = `${envFile}.bak-${stamp()}`;
    copyFileSync(envFile, backup);
    out(`  --fresh: the previous ${path.relative(repoRoot, envFile)} is kept as ${path.relative(repoRoot, backup)}`);
    saved = {};
  }
  let agentId = saved.FUKU_AGENT_ID;
  let agentPk: Hex | null = saved.FUKU_AGENT_PRIVATE_KEY && /^0x[0-9a-fA-F]{64}$/.test(saved.FUKU_AGENT_PRIVATE_KEY) ? (saved.FUKU_AGENT_PRIVATE_KEY as Hex) : null;
  if (agentId && !agentPk) fail(`${path.relative(repoRoot, envFile)} names ${agentId} but holds no valid FUKU_AGENT_PRIVATE_KEY. Run with --fresh.`);
  if (agentId) {
    const v = await fuku.verifyAgent(agentId);
    if (!v.agent) fail(`${path.relative(repoRoot, envFile)} names ${agentId}, which the Fuku app at ${baseUrl} does not have (another deployment?). Run with --fresh to register a new MCP agent.`);
    out(`  = ${NAME} ${agentId} (from ${path.relative(repoRoot, envFile)})`);
  } else {
    agentPk = generatePrivateKey();
    const { agent, receipt } = await fuku.registerAgent({ name: NAME, capabilities: ["transfer", "read_balances"], description: DESCRIPTION });
    agentId = agent.id;
    noteReceipt("registerAgent", receipt);
    // Saved before anything else happens, so the key is never lost.
    writeEnvFile(envFile, { FUKU_BASE_URL: baseUrl, FUKU_API_KEY: apiKey, FUKU_AGENT_ID: agentId, FUKU_AGENT_PRIVATE_KEY: agentPk }, [`Agent: ${NAME}, chain ${chainId}`]);
    out(`  + registered ${NAME} ${agentId}; its key is in ${path.relative(repoRoot, envFile)} only`);
  }
  const agentKey = privateKeyToAccount(agentPk!);
  const row = await db.agent.findUnique({ where: { id: agentId } });
  if (!row) fail(`DATABASE_URL is not the database of the Fuku app at ${baseUrl}: ${agentId} is not in it.`);
  if (row!.identityId !== DEMO_IDENTITY_ID) fail(`${agentId} does not belong to Ava (the demo identity).`);
  await keepAgentAcrossDemoResets(db, agentId);
  out("  = a demo reset keeps this agent (Setting demo.keepAgents)");

  // 2. Passport
  out("\n2. Passport");
  const v = await fuku.verifyAgent(agentId);
  const p = v.passport;
  const samePassport =
    p?.active &&
    JSON.stringify(p.allowed) === JSON.stringify(PASSPORT.allowed) &&
    JSON.stringify([...p.blocked].sort()) === JSON.stringify([...PASSPORT.blocked].sort()) &&
    JSON.stringify(p.assets ?? []) === JSON.stringify(PASSPORT.assets) &&
    (p.scopeApps ?? []).length === 0;
  if (samePassport) out(`  = passport v${p!.version} active: transfer 100/day (aUSDC), read_balances; withdraw and change_owner blocked`);
  else {
    const r = await fuku.requestPermission(agentId, PASSPORT);
    noteReceipt("setPolicy", r.receipt);
    out(`  + passport v${r.agent.policy?.version} approved (anchor ${r.receipt.status}${r.receipt.txHash ? ` ${r.receipt.txHash}` : ""})`);
  }

  // 3. Agent key and ERC-8004
  out("\n3. Agent key and ERC-8004");
  let erc = await fuku.getErc8004(agentId);
  if (!erc.agentWallet || !isAddressEqual(erc.agentWallet as Address, agentKey.address) || erc.agentKeySource !== "external") {
    erc = await fuku.setErc8004AgentKey(agentId, agentKey.address);
    out(`  + agent key set: ${agentKey.address} (Fuku has only its address)`);
  } else out(`  = agent key ${agentKey.address}`);
  if (erc.reason === "unsupported-chain" || erc.reason === "mock-chain") {
    out(`  - ERC-8004 skipped: ${erc.reason} (no canonical Identity Registry on chain ${erc.chainId})`);
  } else {
    for (let step = 0; step < 3 && !erc.complete; step++) {
      if (!erc.agentId) {
        const action = erc.actions.find((a) => a.op === "erc8004Register") ?? fail(`ERC-8004 registration is not available: ${erc.reason ?? "unknown reason"}`);
        const hash = await send("ERC-8004 register", action.tx);
        await fuku.confirmErc8004(agentId, { op: "erc8004Register", txHash: hash });
      } else {
        const td = erc.agentWalletTypedData ?? fail(`ERC-8004 agent #${erc.agentId} has no AgentWalletSet to sign: ${erc.reason ?? "unknown reason"}`);
        const signature = await agentKey.signTypedData({
          domain: { ...td.domain, verifyingContract: td.domain.verifyingContract as Address },
          types: td.types,
          primaryType: td.primaryType,
          message: { agentId: BigInt(td.message.agentId), newWallet: td.message.newWallet as Address, owner: td.message.owner as Address, deadline: BigInt(td.message.deadline) },
        });
        const { action } = await fuku.prepareErc8004AgentWallet(agentId, { signature, deadline: td.message.deadline });
        const hash = await send("ERC-8004 setAgentWallet", action.tx);
        await fuku.confirmErc8004(agentId, { op: "erc8004SetAgentWallet", txHash: hash });
      }
      erc = await fuku.getErc8004(agentId);
    }
    out(erc.complete ? `  = ERC-8004 agent #${erc.agentId}, agentWallet ${erc.agentWallet} (the agent key)` : `  ! ERC-8004 incomplete: ${erc.reason ?? "see the app"}`);
  }

  // 4. Ava's mandate
  out("\n4. Ava's mandate (FukuSpendGuard)");
  const target = await fuku.getMandate(agentId);
  if (!target.guard || !target.token) {
    out(`  - no mandate possible: ${target.reason ?? "no guard or A-Token on this deployment"}`);
  } else {
    if (!target.wallet || !isAddressEqual(target.wallet as Address, ava.address)) {
      fail(`Ava's bound wallet is ${target.wallet ?? "none"}, not DEMO_OWNER_PRIVATE_KEY's ${ava.address}: reset the demo first (/api/auth/demo?reset=1).`);
    }
    const guard = target.guard as Address;
    const token = target.token as Address;
    const agentBytes = target.agentKey as Hex;
    const [balance, allowance] = await Promise.all([
      pub.readContract({ address: token, abi: CleanverseATokenSimAbi, functionName: "balanceOf", args: [ava.address] }),
      pub.readContract({ address: token, abi: CleanverseATokenSimAbi, functionName: "allowance", args: [ava.address, guard] }),
    ]);
    if (balance < DAILY_CAP || allowance < DAILY_CAP) {
      fail(`Ava holds ${Number(balance) / 1e6} aUSDC-SIM and allows the guard ${Number(allowance) / 1e6}; both need at least 100. Run \`cd web && npm run cleanverse:setup\` first.`);
    }
    const [mToken, cap, maxPerTx, validUntil, restrictPayees, , active] = await pub.readContract({ address: guard, abi: FukuSpendGuardAbi, functionName: "mandates", args: [agentBytes, ava.address] });
    const now = BigInt(Math.floor(Date.now() / 1000));
    const lasting = validUntil === BigInt(0) || validUntil > now + BigInt(24 * 3600);
    if (active && isAddressEqual(mToken, token) && cap === DAILY_CAP && maxPerTx === MAX_PER_TX && restrictPayees && lasting) {
      out("  = mandate open: 100 aUSDC a day, 50 per transfer, approved payees only");
    } else {
      const until = now + BigInt(MANDATE_DAYS * 24 * 3600);
      await send("openMandate", { to: guard, data: encodeFunctionData({ abi: FukuSpendGuardAbi, functionName: "openMandate", args: [agentBytes, token, DAILY_CAP, MAX_PER_TX, until, true] }) });
    }
    const approved = await pub.readContract({ address: guard, abi: FukuSpendGuardAbi, functionName: "isPayee", args: [agentBytes, ava.address, nusantara.address] });
    if (approved) out(`  = ${nusantara.name} is the approved payee`);
    else {
      await send(`setPayee ${nusantara.name}`, { to: guard, data: encodeFunctionData({ abi: FukuSpendGuardAbi, functionName: "setPayee", args: [agentBytes, nusantara.address, true] }) });
    }
  }

  // 5. Summary
  const end = await balances();
  const spentAva = start.ava - end.ava;
  const spentRelayer = relayer ? start.relayer - end.relayer : null;
  let gasLimit = BigInt(0);
  for (const t of txs) gasLimit += (await pub.getTransaction({ hash: t.hash })).gas;
  const final = await fuku.verifyAgent(agentId);
  const ercId = final.agent?.erc8004?.agentId ?? null;
  writeEnvFile(
    envFile,
    { FUKU_BASE_URL: baseUrl, FUKU_API_KEY: apiKey, FUKU_AGENT_ID: agentId!, FUKU_AGENT_PRIVATE_KEY: agentPk! },
    [`Agent: ${NAME}, chain ${chainId}${ercId ? `, ERC-8004 #${ercId}` : ""}; agent key ${agentKey.address}`],
  );

  out("\nDone.");
  out(`  agent       ${agentId}`);
  out(`  ERC-8004    ${ercId ? `#${ercId} on ${final.agent?.erc8004?.registry}` : "not registered (no canonical registry on this chain)"}`);
  out(`  agent key   ${agentKey.address} (private key in ${path.relative(repoRoot, envFile)} only)`);
  out(`  trust score ${final.trust?.score ?? "?"}`);
  out(`  transactions this run: ${txs.length ? "" : "none"}`);
  for (const t of txs) out(`    ${t.by.padEnd(7)} ${t.label.padEnd(26)} ${t.hash}`);
  out(
    `  MON spent: Ava ${formatEther(spentAva)}${spentRelayer !== null ? `, relayer ${formatEther(spentRelayer)}` : ""} (balance changes; gas limits ${gasLimit}, i.e. ${formatEther(gasLimit * BigInt(102e9))} MON at 102 gwei)`,
  );

  const entry = path.join(repoRoot, "mcp", "dist", "index.js");
  const shownKey = apiKey === DEMO_API_KEY ? apiKey : "<from mcp/.env>";
  out("\nClaude Desktop (Settings > Developer > Edit Config), inside \"mcpServers\":");
  out(
    JSON.stringify(
      {
        fuku: {
          command: "node",
          args: [entry],
          env: { FUKU_BASE_URL: baseUrl, FUKU_API_KEY: shownKey, FUKU_AGENT_ID: agentId, FUKU_AGENT_PRIVATE_KEY: "<from mcp/.env>" },
        },
      },
      null,
      2,
    ),
  );
  out(
    envFile === path.join(repoRoot, "mcp", ".env")
      ? "The server also reads mcp/.env itself, so the FUKU_AGENT_PRIVATE_KEY line can be left out."
      : `This configuration is in ${path.relative(repoRoot, envFile)}: point the server at it with FUKU_MCP_ENV_FILE=${envFile}, or copy the values.`,
  );
  out("\nClaude Code:");
  out(`  claude mcp add fuku --env FUKU_BASE_URL=${baseUrl} --env FUKU_AGENT_ID=${agentId} -- node "${entry}"`);
  out("Build the server first: npm run mcp:build (from the repository root).");
  await db.$disconnect();
}

main().catch((err) => {
  process.stderr.write(`\n${err instanceof SetupError ? "✖ " : ""}${err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
