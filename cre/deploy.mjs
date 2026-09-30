#!/usr/bin/env node
/**
 * One-command deploy of the fuku-guard CRE workflow, run from C:\Fuku\cre once Chainlink has
 * granted deploy access (`cre whoami` shows "Deploy Access: Enabled").
 *
 *   node deploy.mjs --url https://your-public-fuku-url     use an existing public URL
 *   node deploy.mjs --tunnel                                start a Cloudflare quick tunnel to :3001
 *   node deploy.mjs --tunnel --dry-run                      everything except secrets + deploy
 *
 * Steps: check access -> resolve a public Fuku URL -> verify it answers without redirects ->
 * write it into fuku-guard/config.production.json -> store FUKU_API_KEY in the Vault DON ->
 * cre workflow deploy -> write CRE_WORKFLOW_ID into ../web/.env (backup at ../web/.env.bak).
 *
 * Quick-tunnel URLs change every time cloudflared restarts; the workflow must then be redeployed
 * with the new URL. Keep the tunnel window open for as long as the workflow should work.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return args[i].includes("=") ? args[i].split("=").slice(1).join("=") : args[i + 1];
};

const DRY = flag("dry-run");
const LOCAL = value("local") ?? "http://localhost:3001";
const TARGET = "production-settings";
const CONFIG = join(here, "fuku-guard", "config.production.json");
const WEB_ENV = join(here, "..", "web", ".env");

const CRE =
  process.env.CRE_BIN ??
  (process.platform === "win32" && existsSync(join(process.env.LOCALAPPDATA ?? "", "Programs", "cre", "cre.exe"))
    ? join(process.env.LOCALAPPDATA, "Programs", "cre", "cre.exe")
    : "cre");
const CLOUDFLARED =
  process.env.CLOUDFLARED_BIN ??
  (process.platform === "win32" && existsSync("C:\\Program Files (x86)\\cloudflared\\cloudflared.exe")
    ? "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe"
    : "cloudflared");

const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const log = (s) => console.log(s);
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exitCode = 1;
};

function cre(cmdArgs, { inherit = false } = {}) {
  const r = spawnSync(CRE, cmdArgs, { cwd: here, encoding: "utf8", stdio: inherit ? "inherit" : "pipe", shell: false });
  return { code: r.status ?? 1, out: strip(`${r.stdout ?? ""}${r.stderr ?? ""}`) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startTunnel() {
  log(`Starting a Cloudflare quick tunnel to ${LOCAL} ...`);
  // Log to a file (not a pipe) so the tunnel keeps running after this script exits.
  const logFile = join(here, ".tunnel.log");
  writeFileSync(logFile, "");
  const fd = openSync(logFile, "a");
  const child = spawn(CLOUDFLARED, ["tunnel", "--no-autoupdate", "--url", LOCAL], {
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
  });
  child.unref();
  closeSync(fd);
  for (let i = 0; i < 60; i++) {
    const m = readFileSync(logFile, "utf8").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      // A brand-new hostname needs a few seconds in DNS; querying too early gets the miss cached.
      log("  waiting for the tunnel hostname to propagate ...");
      await sleep(10_000);
      return { url: m[0], pid: child.pid, logFile };
    }
    await sleep(1000);
  }
  throw new Error(`cloudflared did not print a URL within 60 s (see ${logFile})`);
}

async function verifyReachable(url) {
  // The DON's HTTP client does not follow redirects, so the URL must answer directly.
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      const res = await fetch(`${url}/api/integrations`, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
      if (res.status === 200) return true;
      log(`  attempt ${attempt}: HTTP ${res.status}`);
      if (res.status >= 300 && res.status < 400) throw new Error(`${url} redirects (HTTP ${res.status}); CRE cannot follow redirects`);
    } catch (e) {
      if (String(e.message).includes("redirects")) throw e;
      log(`  attempt ${attempt}: ${e.cause?.code ?? e.message}`);
    }
    await sleep(5000);
  }
  return false;
}

function upsertEnv(file, key, val) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  const line = `${key}=${val}`;
  if (i >= 0) lines[i] = line;
  else {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push("", "# Chainlink CRE workflow deployed by cre/deploy.mjs", line, "");
  }
  return lines.join("\n");
}

async function main() {
  log("fuku-guard CRE deploy\n");

  // 1. Access
  const who = cre(["whoami"]);
  const access = who.out.match(/Deploy Access:\s*([A-Za-z ]+?)\s*[│|\n]/)?.[1]?.trim() ?? "unknown";
  log(`Deploy access: ${access}`);
  if (who.code !== 0) return fail(`cre whoami failed. Run "cre login" first.\n${who.out.trim()}`);
  if (access !== "Enabled") {
    if (!DRY) return fail('Deploy access is not enabled yet. Run "cre account access" to request it, then wait for Chainlink\'s email.');
    log("  (dry run: continuing without deploy access)");
  }

  // 2. Public URL
  let url = value("url");
  let tunnelPid = null;
  if (!url && flag("tunnel")) {
    const t = await startTunnel();
    url = t.url;
    tunnelPid = t.pid;
    log(`Tunnel: ${url} (cloudflared pid ${tunnelPid}, log ${t.logFile}; keep it running)`);
  }
  if (!url) return fail("Give a public Fuku URL with --url https://... or pass --tunnel.");
  url = url.replace(/\/+$/, "");
  if (!url.startsWith("https://")) return fail(`Use an https URL; got ${url}`);

  // 3. Reachability
  log(`Checking ${url}/api/integrations answers without redirects ...`);
  if (!(await verifyReachable(url))) return fail(`${url} is not reachable. Is the Fuku web app running on ${LOCAL}?`);
  log("  reachable ✓");

  // 4. Config
  const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  const before = cfg.fukuBaseUrl;
  cfg.fukuBaseUrl = url;
  if (DRY) log(`[dry run] would set fukuBaseUrl: ${before} -> ${url}`);
  else {
    writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n");
    log(`config.production.json fukuBaseUrl -> ${url}`);
  }

  const build = cre(["workflow", "build", "fuku-guard", "--target", TARGET]);
  if (build.code !== 0) return fail(`cre workflow build failed:\n${build.out.trim()}`);
  log("Workflow compiles for the production target ✓");

  if (DRY) {
    log("\n[dry run] would now run:");
    log(`  ${CRE} secrets create secrets.yaml --target ${TARGET} --secrets-auth=browser   (or secrets update)`);
    log(`  ${CRE} workflow deploy fuku-guard --target ${TARGET} --yes`);
    log(`  and write CRE_WORKFLOW_ID=<id> into ${WEB_ENV}`);
    if (tunnelPid) log(`\nThe test tunnel is still running (pid ${tunnelPid}); stop it when done.`);
    return;
  }

  // 5. Secret in the Vault DON (browser auth for the private registry)
  log("\nStoring FUKU_API_KEY in the Vault DON (a browser window may open to confirm) ...");
  let sec = cre(["secrets", "create", "secrets.yaml", "--target", TARGET, "--secrets-auth=browser"], { inherit: true });
  if (sec.code !== 0) {
    log("  create failed; trying update (the secret may already exist) ...");
    sec = cre(["secrets", "update", "secrets.yaml", "--target", TARGET, "--secrets-auth=browser"], { inherit: true });
    if (sec.code !== 0) return fail("Could not store the secret. Check FUKU_API_KEY_ALL in cre/.env and try again.");
  }

  // 6. Deploy
  log("\nDeploying fuku-guard to the private registry ...");
  const dep = cre(["workflow", "deploy", "fuku-guard", "--target", TARGET, "--yes"]);
  process.stdout.write(dep.out);
  const id = dep.out.match(/Workflow ID:\s*([0-9a-fA-Fx]+)/)?.[1];
  if (dep.code !== 0 || !id) return fail("Deploy failed or printed no Workflow ID (see output above).");

  // 7. Wire the web app
  if (existsSync(WEB_ENV)) copyFileSync(WEB_ENV, `${WEB_ENV}.bak`);
  writeFileSync(WEB_ENV, upsertEnv(WEB_ENV, "CRE_WORKFLOW_ID", id));
  log(`\n✓ Workflow ID ${id}`);
  log(`✓ CRE_WORKFLOW_ID written to ${WEB_ENV} (backup at .env.bak)`);
  log("Next: restart the web app (cd web && npx next dev -p 3001). The Chainlink CRE card turns live.");
  if (tunnelPid) log(`Keep the tunnel running (cloudflared pid ${tunnelPid}); if it restarts, run this script again.`);
}

main().catch((e) => fail(e.message));
