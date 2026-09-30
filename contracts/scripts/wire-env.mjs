#!/usr/bin/env node
/**
 * Wires a finished deploy into the web app's .env so it runs in live settlement mode.
 *
 * Reads contracts/deployments/<network>.json (written by scripts/deploy.ts) plus
 * DEPLOYER_PRIVATE_KEY / MONAD_RPC_URL from contracts/.env or the environment, and upserts
 * these lines into web/.env, preserving every other line and backing the file up to
 * web/.env.bak first:
 *
 *   FUKU_CHAIN_MODE=live
 *   FUKU_CHAIN_ID=<chainId>
 *   MONAD_RPC_URL=<rpc>
 *   DEPLOYER_PRIVATE_KEY=<key>
 *   FUKU_IDENTITY_REGISTRY, FUKU_AGENT_REGISTRY,
 *   FUKU_PERMISSION_REGISTRY, FUKU_REPUTATION_REGISTRY
 *
 *   npm run wire:env                                   # monadTestnet -> ../web/.env
 *   node scripts/wire-env.mjs --network monadTestnet   # same
 *   node scripts/wire-env.mjs --dry-run                # print the result to stdout, write nothing
 *   node scripts/wire-env.mjs --env /path/to/.env      # target another env file
 *
 * The private key value is masked in --dry-run output and never logged.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractsEnv = path.join(root, ".env");
if (existsSync(contractsEnv)) process.loadEnvFile(contractsEnv);

const DEFAULT_RPC = "https://testnet-rpc.monad.xyz";
const CONTRACT_KEYS = {
  HumanIdentityRegistry: "FUKU_IDENTITY_REGISTRY",
  AgentRegistry: "FUKU_AGENT_REGISTRY",
  PermissionRegistry: "FUKU_PERMISSION_REGISTRY",
  ReputationRegistry: "FUKU_REPUTATION_REGISTRY",
};
const SECRET_KEYS = new Set(["DEPLOYER_PRIVATE_KEY"]);

/** A problem the user can fix; reported without a stack trace. */
class UserError extends Error {}
function fail(lines) {
  throw new UserError(lines.join("\n"));
}

// --- args ---------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { network: "monadTestnet", env: path.join(root, "..", "web", ".env"), dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? undefined : a.slice(eq + 1);
    const next = () => (inline !== undefined ? inline : argv[++i]);
    if (name === "--network") opts.network = next();
    else if (name === "--env") opts.env = next();
    else if (name === "--dry-run") opts.dryRun = true;
    else if (name === "--help" || name === "-h") opts.help = true;
    else if (!a.startsWith("-")) opts.network = a;
    else fail([`Unknown option ${a}. Try --help.`]);
  }
  if (!opts.network || !opts.env) fail(["--network and --env need a value. Try --help."]);
  opts.env = path.resolve(opts.env);
  return opts;
}

// --- upsert ---------------------------------------------------------------------
/**
 * Replaces `KEY=...` lines in place (first occurrence wins, later duplicates are dropped),
 * turns a commented placeholder `# KEY=...` into a live line, and appends anything left
 * under a small header. Keeps the file's line endings and every unrelated line.
 */
function upsert(content, values) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content === "" ? [] : content.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const pending = new Map(Object.entries(values));
  const done = new Set();
  const changes = new Map();
  const out = [];

  for (const line of lines) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const k = m?.[1];
    if (k && pending.has(k)) {
      out.push(`${k}=${pending.get(k)}`);
      pending.delete(k);
      done.add(k);
      changes.set(k, "replaced");
      continue;
    }
    if (k && done.has(k)) {
      changes.set(k, "replaced (dropped a duplicate line)");
      continue;
    }
    out.push(line);
  }

  for (const [k, v] of [...pending]) {
    const re = new RegExp(`^\\s*#\\s*${k}\\s*=`);
    const idx = out.findIndex((l) => re.test(l));
    if (idx !== -1) {
      out[idx] = `${k}=${v}`;
      pending.delete(k);
      changes.set(k, "uncommented");
    }
  }

  if (pending.size) {
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push("# --- Monad settlement (written by contracts/scripts/wire-env.mjs) ---");
    for (const [k, v] of pending) {
      out.push(`${k}=${v}`);
      changes.set(k, "added");
    }
  }

  return { content: out.join(eol) + eol, changes };
}

const mask = (k, v) => (SECRET_KEYS.has(k) ? `${v.slice(0, 6)}...${v.slice(-4)} (masked)` : v);
const pad = (s, n) => s + " ".repeat(Math.max(1, n - s.length));

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: node scripts/wire-env.mjs [--network <name>] [--env <path>] [--dry-run]");
    return;
  }

  // --- deployment file ----------------------------------------------------------
  const deploymentsDir = path.join(root, "deployments");
  const deploymentFile = path.join(deploymentsDir, `${opts.network}.json`);
  if (!existsSync(deploymentFile)) {
    const available = existsSync(deploymentsDir)
      ? readdirSync(deploymentsDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))
      : [];
    fail([
      `No deployment found for network "${opts.network}" (${deploymentFile}).`,
      available.length ? `  Available: ${available.join(", ")}` : "  No deployments yet.",
      "  Run: npm run deploy:monad   (then re-run npm run wire:env)",
    ]);
  }

  let deployment;
  try {
    deployment = JSON.parse(readFileSync(deploymentFile, "utf8"));
  } catch (err) {
    fail([`Could not parse ${deploymentFile}: ${err.message}`]);
  }

  const isAddress = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
  const chainId = Number(deployment.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) fail([`${deploymentFile} has no valid "chainId".`]);
  const contracts = deployment.contracts ?? {};
  const missing = Object.keys(CONTRACT_KEYS).filter((name) => !isAddress(contracts[name]));
  if (missing.length) {
    fail([
      `${deploymentFile} is missing a valid address for: ${missing.join(", ")}.`,
      "  Expected the shape written by scripts/deploy.ts ({ contracts: { HumanIdentityRegistry, ... } }).",
    ]);
  }

  // --- key + rpc -------------------------------------------------------------------
  const rawKey = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  const key = rawKey ? (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) : undefined;
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    fail(["DEPLOYER_PRIVATE_KEY is malformed: expected 0x followed by 64 hex characters."]);
  }
  if (!key && !opts.dryRun) {
    fail([
      "DEPLOYER_PRIVATE_KEY is not set, so the web app would have nothing to sign with.",
      `  Put the key you deployed with in ${contractsEnv} (or export it), then re-run.`,
      "  Use --dry-run to preview without a key.",
    ]);
  }
  const rpcUrl = process.env.MONAD_RPC_URL?.trim() || DEFAULT_RPC;

  const updates = {
    FUKU_CHAIN_MODE: "live",
    FUKU_CHAIN_ID: String(chainId),
    MONAD_RPC_URL: rpcUrl,
    ...(key ? { DEPLOYER_PRIVATE_KEY: key } : {}),
    ...Object.fromEntries(Object.entries(CONTRACT_KEYS).map(([name, envKey]) => [envKey, contracts[name]])),
  };

  const envExists = existsSync(opts.env);
  const before = envExists ? readFileSync(opts.env, "utf8") : "";
  const { content: after, changes } = upsert(before, updates);

  // --- report / write ----------------------------------------------------------------
  const log = opts.dryRun ? console.error : console.log; // keep stdout clean for the dry-run body
  log(
    `Deployment: ${path.relative(root, deploymentFile)} (network ${deployment.network ?? opts.network}, chainId ${chainId}, deployer ${deployment.deployer ?? "?"}, ${deployment.deployedAt ?? "no timestamp"})`,
  );
  log(`Target:     ${opts.env}${envExists ? "" : " (does not exist yet, will be created)"}`);
  if (!key) log("Note:       DEPLOYER_PRIVATE_KEY not set; line omitted. Live mode needs it (see contracts/.env.example).");
  log("");
  for (const [k, v] of Object.entries(updates)) log(`  ${pad(`${k}=${mask(k, v)}`, 78)} ${changes.get(k) ?? "unchanged"}`);
  log("");

  if (opts.dryRun) {
    log(`--- dry run: resulting ${path.basename(opts.env)} (nothing written, secret masked) ---`);
    const shown = after.replace(/^(DEPLOYER_PRIVATE_KEY=)(\S+)$/m, (_, k, v) => `${k}${mask("DEPLOYER_PRIVATE_KEY", v)}`);
    process.stdout.write(shown);
    log("--- end dry run ---");
    return;
  }

  if (!envExists) {
    log("Warning: creating a fresh .env with only the Monad settings. Copy the other values");
    log("         (DATABASE_URL, FUKU_SESSION_SECRET, ...) from web/.env.example as well.");
  } else {
    const backup = `${opts.env}.bak`;
    copyFileSync(opts.env, backup);
    log(`Backup:     ${backup}`);
  }
  writeFileSync(opts.env, after);
  log(`Wrote:      ${opts.env}`);
  log("");
  log("Restart the web app so Next.js reloads .env (Ctrl+C, then: cd web && npm run dev -- -p 3001).");
  log('Then open the Developer Console: the Monad card should read "live settlement".');
}

try {
  main();
} catch (err) {
  if (!(err instanceof UserError)) throw err;
  console.error("");
  console.error(err.message);
  console.error("");
  process.exitCode = 1;
}
