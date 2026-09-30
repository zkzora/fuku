# Fuku on Chainlink CRE

`fuku-guard` is a Chainlink Runtime Environment (CRE) workflow that orchestrates an AI agent action through Fuku:

```
request  HTTP trigger receives { agentId, action, amountUsdc?, app?, to?, asset?, requestId? }
verify   Fuku API: GET /api/v1/agents/:id (checks per claim, trust score) + POST /check (preview)
         -> rejected here if the owner has no passkey verification or trust < minTrustScore
execute  Fuku API: POST /api/v1/agents/:id/execute with an Idempotency-Key
         (cre:<requestId>, or a hash of the payload), so a retried trigger replays instead of
         executing twice; single execution across the DON via cacheSettings
record   EVM read on monad-testnet through the DON:
         PermissionRegistry.stats(agent), ReputationRegistry.getScore(agent) and, after an
         A-Token transfer, FukuSpendGuard.spentToday(agent, owner wallet) when spendGuard is set
```

CRE is one more client of the public API. Every Fuku rule (owner verification R11, Cleanverse
R7 to R9, limits R5, the on-chain guard R10) applies to it exactly as to any direct caller, so
calling Fuku directly is never a way around the workflow's checks, and the workflow's own early
rejection only adds to them. Actions submitted this way carry an orchestrator label that the
activity timeline shows as declared by the caller.

## Prerequisites

- CRE CLI (`irm https://app.chain.link/cre/install.ps1 | iex` on Windows), then `cre login`.
- Bun 1.2.21 or later (`npm i -g bun`), then `bun install --cwd ./fuku-guard`.
- The Fuku web app running (http://localhost:3001 for the staging target).

`.env` in this folder (git-ignored) holds `FUKU_API_KEY_ALL` (the Fuku API key the workflow uses, declared in `secrets.yaml`) and a dummy `CRE_ETH_PRIVATE_KEY` (the workflow never writes on-chain itself).

## Simulate (no deploy access needed)

From this folder:

```bash
cre workflow simulate fuku-guard --target staging-settings --non-interactive --trigger-index 0 \
  --http-payload '{"agentId":"fuku:agent:0xb6b1bec4676f0fa730a4a7f9316e33ce604729ac","action":"withdraw","amountUsdc":4800,"app":"Monad DEX"}'
```

Expected log lines: `[verify] ... dryRun=BLOCKED R2`, `[execute] BLOCKED rule=R2 ... receipt=live tx=0x...`, `[record] Monad PermissionRegistry.stats ...`. The execute step is real: with Fuku in live mode it spends Monad testnet gas from the Fuku deployer.

Tests: `cd fuku-guard && bun test`.

## Getting a CRE_WORKFLOW_ID (deploy)

> **Status (2026-09-24).** Fuku requested deploy access; Chainlink replied that hackathon projects should simulate locally and that deploying to testnet or mainnet requires a call about commercial conditions plus an MNDA. Everything below is ready for when that agreement exists.

**Shortcut.** Once deploy access is enabled, with the web app running on port 3001:

```bash
node deploy.mjs --tunnel      # quick Cloudflare tunnel, stores the secret, deploys, writes CRE_WORKFLOW_ID
node deploy.mjs --url https://your-host   # if Fuku is already hosted publicly
node deploy.mjs --tunnel --dry-run        # checks everything except secrets and deploy
```

Quick-tunnel URLs change whenever cloudflared restarts, and the workflow must then be redeployed. The manual steps below are what the script does.

1. **Deploy access.** `cre whoami` must show `Deploy Access: Enabled`. Request it with `cre account access` (it asks for a short use-case description) and wait for Chainlink's email.
2. **Public Fuku URL.** DON nodes cannot reach `localhost`. Host the web app or expose it with a tunnel that does not redirect (for example `cloudflared tunnel --url http://localhost:3001`), and put that URL in `fuku-guard/config.production.json` (`fukuBaseUrl`).
3. **Secret in the Vault DON.** With `FUKU_API_KEY_ALL` set in `.env`: `cre secrets create secrets.yaml --target production-settings --secrets-auth=browser`.
4. **Deploy** to the private registry (no gas): `cre workflow deploy fuku-guard --target production-settings`. The output ends with `Workflow ID: <id>`.
5. Put it in `web/.env` as `CRE_WORKFLOW_ID=<id>` and restart the web app. The Chainlink CRE card on the Developer Console turns live.

The production target only accepts triggers signed by `authorizedEVMAddress` (the Fuku deployer, `0x248a…D3DE`). See the CRE docs on triggering deployed workflows for the JWT format.
