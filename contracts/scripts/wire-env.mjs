#!/usr/bin/env node
/**
 * Wires a finished deploy into the web app's .env so it runs in live settlement mode.
 *
 * Reads contracts/deployments/<network>.json (written by scripts/deploy.ts) plus
 * DEPLOYER_PRIVATE_KEY / MONAD_RPC_URL from contracts/.env or the environment, and upserts
 * these lines into web/.env, preserving every other line and first copying the file to a new
 * timestamped backup (web/.env.bak-<UTC time>; earlier backups are never overwritten, and no
 * backup is ever read back):
 *
 *   FUKU_CHAIN_MODE=live
 *   FUKU_CHAIN_ID=<chainId>
 *   MONAD_RPC_URL=<rpc>
 *   DEPLOYER_PRIVATE_KEY=<key>
 *   FUKU_IDENTITY_REGISTRY, FUKU_AGENT_REGISTRY,
 *   FUKU_PERMISSION_REGISTRY, FUKU_REPUTATION_REGISTRY
 *
 * and, when present:
 *
 *   FUKU_SPEND_GUARD, CLEANVERSE_SIM_APASS, CLEANVERSE_SIM_ATOKEN   (from the deployments file)
 *   FUKU_COMPLIANCE_SIGNER_KEY=<key>   (from contracts/.env or the environment: the key whose
 *                                       address FukuSpendGuard trusts, see "complianceSigner")
 *
 *   npm run wire:env                                  # monadTestnet -> ../web/.env
 *   node scripts/wire-env.mjs --network monadTestnet   # same
 *   node scripts/wire-env.mjs --dry-run                # print the result to stdout, write nothing
 *   node scripts/wire-env.mjs --env /path/to/.env      # target another env file
 *   node scripts/wire-env.mjs --replace-keys           # allow replacing a different key (see below)
 *
 * Keys already in the target are protected: when it holds a DEPLOYER_PRIVATE_KEY or
 * FUKU_COMPLIANCE_SIGNER_KEY that differs from the one this run would write (a stale contracts/.env,
 * say), nothing is written unless --replace-keys is given; both addresses are printed so the right
 * one can be chosen. Every other line (DEMO_OWNER_PRIVATE_KEY, SMOKE_OWNER_PRIVATE_KEY,
 * FUKU_AGENT_KEY_SECRET, FUKU_SESSION_SECRET, ...) is left exactly as it is, and the run checks that
 * before writing.
 *
 * Private key values are masked in --dry-run output and never logged.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

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
/** Written only when the deployments file has them (added by the Cleanverse deploy step). */
const OPTIONAL_CONTRACT_KEYS = {
  FukuSpendGuard: "FUKU_SPEND_GUARD",
  CleanverseAPassSim: "CLEANVERSE_SIM_APASS",
  CleanverseATokenSim: "CLEANVERSE_SIM_ATOKEN",
};
const SECRET_KEYS = new Set(["DEPLOYER_PRIVATE_KEY", "FUKU_COMPLIANCE_SIGNER_KEY"]);
/** Secrets this script never writes; listed in the report so their preservation is visible. */
const PRESERVED_SECRETS = ["DEMO_OWNER_PRIVATE_KEY", "SMOKE_OWNER_PRIVATE_KEY", "FUKU_AGENT_KEY_SECRET", "FUKU_SESSION_SECRET"];

/** A problem the user can fix; reported without a stack trace. */
class UserError extends Error {}
function fail(lines) {
  throw new UserError(lines.join("\n"));
}

// --- args ---------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { network: "monadTestnet", env: path.join(root, "..", "web", ".env"), dryRun: false, replaceKeys: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? undefined : a.slice(eq + 1);
    const next = () => (inline !== undefined ? inline : argv[++i]);
    if (name === "--network") opts.network = next();
    else if (name === "--env") opts.env = next();
    else if (name === "--dry-run") opts.dryRun = true;
    else if (name === "--replace-keys") opts.replaceKeys = true;
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

/** KEY=value pairs of an env file (first occurrence wins, as in upsert). */
function envValues(content) {
  const values = new Map();
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m && !values.has(m[1])) values.set(m[1], m[2].trim().replace(/^(['"])(.*)\1$/, "$2"));
  }
  return values;
}

const addressOf = (k) => {
  try {
    return privateKeyToAccount(k.startsWith("0x") ? k : `0x${k}`).address;
  } catch {
    return "an unparsable key";
  }
};

/** UTC timestamp for backup names: 20260930-161500. */
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

// No fragment of a key is ever printed; its address identifies it.
const mask = (k, v) => (SECRET_KEYS.has(k) ? `<key of ${addressOf(v)}>` : v);
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

  // --- keys + rpc ------------------------------------------------------------------
  const readKey = (name) => {
    const raw = process.env[name]?.trim();
    const value = raw ? (raw.startsWith("0x") ? raw : `0x${raw}`) : undefined;
    if (value && !/^0x[0-9a-fA-F]{64}$/.test(value)) {
      fail([`${name} is malformed: expected 0x followed by 64 hex characters.`]);
    }
    return value;
  };
  const key = readKey("DEPLOYER_PRIVATE_KEY");
  const complianceKey = readKey("FUKU_COMPLIANCE_SIGNER_KEY");
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
    ...Object.fromEntries(
      Object.entries(OPTIONAL_CONTRACT_KEYS)
        .filter(([name]) => isAddress(contracts[name]))
        .map(([name, envKey]) => [envKey, contracts[name]]),
    ),
    ...(complianceKey ? { FUKU_COMPLIANCE_SIGNER_KEY: complianceKey } : {}),
  };

  // FukuSpendGuard only accepts attestations from deployment.complianceSigner; any other key
  // would make every guarded transfer revert with BadAttestation.
  const notes = [];
  if (complianceKey && isAddress(deployment.complianceSigner)) {
    const signerAddress = privateKeyToAccount(complianceKey).address;
    if (signerAddress.toLowerCase() !== deployment.complianceSigner.toLowerCase()) {
      notes.push(
        `Warning:    FUKU_COMPLIANCE_SIGNER_KEY belongs to ${signerAddress}, but FukuSpendGuard trusts ${deployment.complianceSigner}.`,
        "            Guarded transfers would revert with BadAttestation. Use the matching key, or call",
        "            FukuSpendGuard.setComplianceSigner(<your key's address>) from the owner account.",
      );
    }
  } else if (isAddress(contracts.FukuSpendGuard) && !complianceKey) {
    notes.push(
      "Note:       FUKU_COMPLIANCE_SIGNER_KEY not set; line omitted. The web app needs it to sign",
      `            GuardedTransfer attestations (FukuSpendGuard trusts ${deployment.complianceSigner ?? "?"}).`,
    );
  }

  const envExists = existsSync(opts.env);
  const before = envExists ? readFileSync(opts.env, "utf8") : "";
  const existing = envValues(before);

  // A key already in the target is never replaced silently (a stale contracts/.env must not win).
  const conflicts = [...SECRET_KEYS].filter((k) => updates[k] && existing.get(k) && existing.get(k).toLowerCase() !== updates[k].toLowerCase());
  if (conflicts.length && !opts.replaceKeys) {
    fail([
      `${opts.env} already holds a different key; nothing was written:`,
      ...conflicts.map((k) => `  ${k}: the file has ${addressOf(existing.get(k))}, this run would write ${addressOf(updates[k])}`),
      "  Keep the file's key: fix contracts/.env (or the exported variable) to match it, then re-run.",
      "  Replace it on purpose: re-run with --replace-keys (a timestamped backup is written first).",
    ]);
  }

  const { content: after, changes } = upsert(before, updates);

  // Every line this script does not own must come out unchanged.
  const result = envValues(after);
  const touched = [...existing.keys()].filter((k) => !(k in updates) && result.get(k) !== existing.get(k));
  if (touched.length) fail([`Refusing to write: ${touched.join(", ")} would change, and this script does not own them.`]);

  // --- report / write ----------------------------------------------------------------
  const log = opts.dryRun ? console.error : console.log; // keep stdout clean for the dry-run body
  log(
    `Deployment: ${path.relative(root, deploymentFile)} (network ${deployment.network ?? opts.network}, chainId ${chainId}, deployer ${deployment.deployer ?? "?"}, ${deployment.deployedAt ?? "no timestamp"})`,
  );
  log(`Target:     ${opts.env}${envExists ? "" : " (does not exist yet, will be created)"}`);
  if (!key) log("Note:       DEPLOYER_PRIVATE_KEY not set; line omitted. Live mode needs it (see contracts/.env.example).");
  for (const line of notes) log(line);
  log("");
  for (const [k, v] of Object.entries(updates)) {
    const same = existing.get(k) !== undefined && existing.get(k).toLowerCase() === v.toLowerCase();
    log(`  ${pad(`${k}=${mask(k, v)}`, 78)} ${same ? "unchanged" : changes.get(k) ?? "unchanged"}`);
  }
  const preserved = PRESERVED_SECRETS.filter((k) => existing.has(k));
  if (preserved.length) log(`  Not touched: ${preserved.join(", ")}`);
  log("");

  if (opts.dryRun) {
    log(`--- dry run: resulting ${path.basename(opts.env)} (nothing written, secrets masked) ---`);
    // Every value whose name suggests a secret is masked, not only the keys this script writes.
    // No `$` anchor: with CRLF line endings the \r would sit between the value and `$`.
    const shown = after.replace(/^(\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=)([^\r\n]+)/gm, (line, prefix, k, v) =>
      SECRET_KEYS.has(k) ? `${prefix}${mask(k, v.trim())}` : /KEY|SECRET|TOKEN|PASSWORD|PRIVATE/i.test(k) ? `${prefix}<set, masked>` : line,
    );
    process.stdout.write(shown);
    log("--- end dry run ---");
    return;
  }

  if (!envExists) {
    log("Warning: creating a fresh .env with only the Monad settings. Copy the other values");
    log("         (DATABASE_URL, FUKU_SESSION_SECRET, ...) from web/.env.example as well.");
  } else if (after === before) {
    log("Nothing changed; no backup written.");
    return;
  } else {
    let backup = `${opts.env}.bak-${stamp()}`;
    for (let n = 1; existsSync(backup); n++) backup = `${opts.env}.bak-${stamp()}-${n}`;
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
