# Demo readiness

What has been verified for the demo, how, and what an owner still has to check by hand. A claim on
this page links to the test or the run that backs it. Anything not run says so.

Labels used throughout:
- **Automated**: a test or script, with its last result and date.
- **Interactive**: needs a person (a passkey prompt, a browser wallet, Claude Desktop). Status is
  "not run" until someone runs it and records the result here.
- **Simulated**: Cleanverse (A-Pass, aUSDC-SIM) is Fuku's simulator, Kimi/Qwen explanations fall back
  to the rule narrator, CRE runs as a simulation. These stay labelled as such everywhere.

## 1. The MCP server's authority: an agent key

The MCP server runs with an **agent key** (`fk_agent_…`), not the owner's API key. What it can and
cannot do is in [`mcp/README.md`](../mcp/README.md#what-the-servers-api-key-can-do) and
[`SECURITY.md`](SECURITY.md) section 11.

| Check | Kind | Result |
| --- | --- | --- |
| Route-level positive and negative tests (own agent allowed; passport, agent and identity management, ERC-8004, records, key minting, travel-rule, vault, other agents, other owners refused; revoke, owner change, demo reset) | Automated, `web/src/lib/services/api-keys.test.ts` | 11/11 pass, 2026-10-09 |
| The set of v1 routes that admit agent keys is pinned | Automated, same file | pass, 2026-10-09 |
| MCP server refuses an owner key (unless `FUKU_MCP_ALLOW_OWNER_KEY=1`) and an agent key for another agent | Automated, `mcp/test/unit.test.ts` | 20/20 pass, 2026-10-09 |
| Against a running app on a local Hardhat node: `mcp:setup` mints the key, MCP integration 7/7 (test 7: passport PUT/DELETE, agent registration, key minting and another agent's check answer 403 over HTTP) | Automated, local stack | pass, 2026-10-09 |
| Same local app: the agent key gets 401 on the vault, memory, delegations and Developer Console key routes; a revoked key gets 401; `mcp:setup -- --key-only` reissues it | Automated (curl), local stack | pass, 2026-10-09 |
| The testnet MCP Assistant (#1963) still has the owner key in `mcp/.env` | **Owner action** | after the schema update (section 4), run `npm run mcp:setup -- --key-only` with the 3001 app running (no chain access, no transaction), then restart the MCP client |

## 2. The owner-controlled path (no registry redeploy)

The deployed registries already support owner custody: an identity whose wallet is bound before its
first on-chain write is controlled by that wallet (`web/src/lib/custody.ts`). Ava, the demo owner, is
**custodial** (Fuku's relayer is her controller) and stays so; the owner-controlled path is
exercised with fresh identities.

### Automated

`npm run owner-path:local` (`web/scripts/owner-path-check.ts`) runs the whole path against a running
app on a local Hardhat node, with a fresh owner wallet, and reads every result back from the chain.
It refuses any chain but 31337. Last run 2026-10-09: **28/28 checks passed**.

| Step | What is checked |
| --- | --- |
| Wallet binding | The owner's wallet signs Fuku's challenge; `walletVerifiedBy = signature` |
| Owner-signed registry writes | `registerAgent` and `setPolicy` wait for the owner; Fuku lists `registerIdentity`, `registerAgent`, `setPolicy`; the owner's wallet sends each; Fuku confirms from the receipt (sender = owner) |
| `controllerOf` | `controllerOf(identity)` is the owner's wallet; the relayer is not the agent's controller; a relayer `revokePolicy` reverts `NotAgentOwner`; `verifyAgent` reports `custody: owner` |
| Passkey gate | A transfer before passkey verification is blocked R11 |
| Owner-signed mandate | Without a mandate the transfer is blocked (guard would revert `NoMandate`); the owner's wallet approves the guard and opens 100 a day, 50 per transfer, payees only; the mandate is keyed to the owner's wallet |
| Payee approval | Before `setPayee` the transfer is blocked (`PayeeNotApproved`); after it, allowed |
| Transfer | 30 aUSDC-SIM is CONFIRMED; `GuardedTransferExecuted` shows from = owner's wallet, to = payee, the exact amount and the owner's mandate version; balances move exactly once; 60 (over 50 per transfer) is blocked and nothing moves |
| Revoke | Removing the payee blocks; `closeMandate` blocks; re-opening allows again; Fuku's kill switch blocks at once (R0) and asks the owner to sign `revokePolicy`; after the owner's `revokePolicy` the passport is inactive on-chain; nothing moved after the kill switch |

Two things in that run are stand-ins, printed as they happen:
- **Passkey**: the script sets `Identity.humanVerified` in the local database. The real ceremony is
  WebAuthn in a browser (interactive, below).
- **Cleanverse**: the owner's A-Pass and aUSDC-SIM are issued and minted by Fuku's **simulator**
  contracts.

Also automated: `web/src/lib/custody.test.ts` (custody rule, owner transaction confirmation) and the
owner-custody section of `web/scripts/live-smoke.mjs` (registry writes, `controllerOf`, the relayer's
reverts, setPolicy v2, revokePolicy), which also ran on Monad testnet on 2026-09-30 (`docs/CLEANVERSE.md`).

### Interactive (not run)

These need a person with a browser and a wallet. None has been run; record the date and result here.

| # | Step | Where | Status |
| --- | --- | --- | --- |
| I1 | Passkey ceremony with user verification for a new owner | App: sign up with a passkey | not run |
| I2 | Bind a wallet from a browser wallet (injected `personal_sign`) or Dynamic | App: Identity → wallet | not run (Dynamic needs a real inbox for its OTP) |
| I3 | Send the owner-signed registry writes from the browser wallet | App: Identity → "On-chain control" card | not run |
| I4 | Open the mandate and approve a payee from the owner's wallet | App: the Dynamic mandate form (Dynamic wallets only); with another wallet, the guard's `openMandate` / `setPayee` from a block explorer or `cast` | not run |
| I5 | Revoke: kill switch in the app, then `revokePolicy` from the "On-chain control" card | App | not run |
| I6 | Close the mandate | No button in the app: the owner calls `closeMandate(agentId)` on FukuSpendGuard from their wallet (explorer or `cast`) | not run |

Gas for the owner's wallet, measured on the local run (gas limit = gas used for these), priced at
Monad testnet's 102 gwei (Monad charges the gas limit; a wallet that pads the limit pays more):
`registerIdentity` 113,672 (0.012 MON), `registerAgent` 243,068 (0.025), `setPolicy` 204,569
(0.021), `approve` 46,138 (0.005), `openMandate` 139,612 (0.014), `setPayee` 47,160 (0.005),
`closeMandate` 50,225 limit (0.005), `revokePolicy` 49,277 (0.005). The whole path is about 0.09 MON.

## 3. Claude Desktop, end to end (checklist)

**Status: not run in Claude Desktop.** The same tool sequence passes through the MCP SDK's own client
over stdio against a local node (`mcp/test/integration.test.ts`, 7/7 on 2026-10-09), which is not the
same as Claude Desktop choosing the tools from a prompt. Fill in the "Result" column when it is run;
nothing here counts as passed until then.

### Before you start

1. The app runs on 3001 against Monad testnet, in its own window, bound to this machine only
   (`cd web && npm run dev -- -p 3001 -H 127.0.0.1`; section 5 says why).
2. `npm run demo:preflight` is green (section 4).
3. `npm run mcp:build`, then `npm run mcp:setup -- --key-only` once (section 1: it replaces the owner
   key in `mcp/.env` with an agent key; no transaction).
4. Claude Desktop is configured as in [`mcp/README.md`](../mcp/README.md#claude-desktop), quit
   completely and restarted. **+ → Connectors → Manage connectors → fuku** lists six tools, including
   `fuku_execute_action`.
5. Keep a terminal open in `web/` for the independent checks.

The MCP Assistant on testnet: `fuku:agent:0x367168b5752479508c6851576c6fb2ece23bda90`, ERC-8004 #1963.
Nusantara Supplies: `0x7AD75AD75A52e8d4ee5290294C498917386f40BB`. Its mandate: 100 aUSDC-SIM a day,
50 per transfer, Nusantara the only payee, valid until 2026-10-31.

Cost, from the relayer (measured on the local node, priced at 102 gwei): an allowed transfer about
0.034 MON (`execute` + `updateScore`), each executed block about 0.008 MON (`recordDecision` +
`updateScore`), a dry run or an idempotent replay nothing. The full list below is about 0.05 MON and
uses 30 of the day's 100 aUSDC-SIM.

| # | Type in Claude Desktop | Expected | Check independently | Result |
| --- | --- | --- | --- | --- |
| C1 | "Who are you in Fuku and what are you allowed to do?" | `fuku_whoami`: MCP Assistant, ERC-8004 #1963, Ava passkey-verified (custodial), transfer up to 100/day in aUSDC, withdraw and change_owner blocked, mandate 50 per transfer with Nusantara approved, **"API key: an agent key for this agent only"**, Execute: enabled | | not run |
| C2 | "Pay Nusantara Supplies 30 aUSDC." | `fuku_check_permission` ALLOWED (R6), then `fuku_execute_action`: ALLOWED, status CONFIRMED, a Monad link. Note the action id, the idempotency key and the transfer hash | | not run |
| C3 | "Show me the receipt of that payment." | `fuku_get_action`: CONFIRMED, the transfer hash, block and log index | | not run |
| C4 | (terminal) | | `npm run verify:transfer -- <transfer hash> --agent fuku:agent:0x367168b5752479508c6851576c6fb2ece23bda90 --action <action id> --to 0x7AD75AD75A52e8d4ee5290294C498917386f40BB --amount 30` prints "All checks passed": the guard's event and the token's Transfer agree, from Ava's wallet, read from the chain only. Then open the explorer link | not run |
| C5 | "Withdraw 4,800 aUSDC to my wallet." | `fuku_check_permission` BLOCKED R2 (hard block list); the assistant stops and reports the rule. If it executes anyway, the result is BLOCKED R2 with `isError: false` and an anchored proof; nothing moves | Nusantara's and Ava's aUSDC-SIM balances unchanged | not run |
| C6 | "Pay Nusantara Supplies 60 aUSDC." | `fuku_check_permission` BLOCKED R10 (`GUARD_REJECTED`: the guard would revert `PerTxLimitExceeded(50000000)`, Ava's 50 per transfer); the assistant stops and reports it. If it executes anyway, the same R10 before any transfer; nothing moves. It must not split it into smaller payments | No new `GuardedTransferExecuted` | not run |
| C7 | "Retry the 30 aUSDC payment with idempotency key <key from C2>; do not make a new payment." | `fuku_execute_action` with that key: the same action id, `replayed: true`, no new transaction | Nusantara's balance unchanged since C2 | not run |
| C8 | "Verify my trust score from the chain." | `fuku_verify_score`: ✓ with the record counts | | not run |

Record the date, the Claude Desktop version and the hashes of C2 here when it is run. If a step
deviates, write down what the assistant did (which tools, in which order) rather than marking it
passed.

## 4. Preflight (read-only)

`cd web && npm run demo:preflight` (`web/scripts/demo-preflight.ts`) says whether the demo is ready to
present. It reads the app's database, the chain over `MONAD_RPC_URL` and, if the app is up, its
`/api/integrations`. It sends no transaction, writes nothing, calls no third-party API and prints no
key (only addresses derived from them). Exit code 1 on any ✗; warnings (!) are allowed. `-- --json`
prints the rows as JSON.

| Section | What it checks |
| --- | --- |
| Database | the schema is current (the agent-key columns) |
| RPC and contracts | the RPC answers on `FUKU_CHAIN_ID`, the latest block is recent, the seven contracts have code |
| Roles | the guard's compliance signer is `FUKU_COMPLIANCE_SIGNER_KEY`'s address; the relayer is enforcer and scorer; the guard is an enforcer |
| Balances | relayer MON (✗ under 0.2, ! under 1); Ava's MON (! under 0.05; the pitch itself needs none of hers); Ava's aUSDC-SIM and her allowance to the guard against the pitch's 250 + 30 |
| Each demo agent (the cohort and the MCP Assistant) | registered; on-chain owner; status (Fuku vs AgentRegistry); passport hash and active flag; anchored score = Fuku's score (✗ for the cohort); ERC-8004 owner and agentWallet; no pending or failed actions |
| The two paying agents | Ava's mandate open for aUSDC-SIM; per-transfer limit and today's remaining mandate budget cover the pitch's amount; expiry (! under 3 days); Nusantara approved; the passport's daily budget left in Fuku |
| Simulator A-Passes | Ava and Nusantara active, the frozen wallet frozen (Fuku's simulator, labelled) |
| Ava's identity | bound wallet = `DEMO_OWNER_PRIVATE_KEY`'s; custodial (the relayer is the controller); passkey flag agrees |
| MCP (`mcp/.env`) | an agent key (not the owner's), for the kept MCP Assistant, known to this database; the agent key's address is the one Fuku has |
| App | live on the same chain, when it answers |

Monad's public RPC allows 15 requests a second and answers bursts with 429 or error -32011, which viem
does not retry; the preflight spaces its requests to about 9 a second and retries limited ones.

### Results on 2026-10-09

- **Local stack** (Hardhat node, app on 3002): READY WITH WARNINGS, 77 ok, 1 warning (Ops Scheduler
  is paused in Fuku and only registered on-chain: Fuku is the stricter of the two).
- **Monad testnet, this machine's `web/.env`** (read-only, app not running): against `dev.db` as it is,
  NOT READY at the first check (the schema update below has not been applied). Against a copy of
  `dev.db` with the schema pushed: NOT READY, 80 ok, 3 warnings, 1 failure. Every cohort agent matches the chain (Trading Assistant 96 = 96, ERC-8004
  #1955 to #1959 owned by Ava with the recorded agentWallets); Payments Agent and MCP Assistant mandates
  cover 250 and 30 today, both expiring in 21 days (2026-10-30 and 2026-10-31); relayer 8.03 MON, Ava
  0.081 MON and 9,050 aUSDC-SIM. The failure: `mcp/.env` still holds the owner key. Warnings: the
  Ops Scheduler status above, the MCP Assistant has no score anchored yet (its first action anchors
  one), the app was not running.

### Owner steps before presenting

1. **Schema update (required once).** Agent keys add two nullable columns to `ApiKey`. Until they
   exist, every API-key request to the app fails (`The column main.ApiKey.agentId does not exist`).
   Stop the app, back up the database, push the schema, start the app:
   `cd web && cp prisma/dev.db prisma/dev.backup-20261009.db && npx prisma db push`.
   Tried on a copy of `dev.db`: the error before, none after, and the same row counts in every table.
2. Start the app on 3001 in its own window: `cd web && npm run dev -- -p 3001 -H 127.0.0.1`.
3. `npm run mcp:setup -- --key-only` (section 1). No transaction.
4. `npm run demo:preflight` until it prints READY (warnings are fine).
5. Open `/api/auth/demo?reset=1` once (it removes rehearsal agents such as the CRE probe).

### A demo reset does not reset the chain

`/api/auth/demo?reset=1` reseeds the **database** only. The chain keeps everything: registrations,
anchored passports, decisions and scores, Ava's mandates and today's spent budget, token balances and
ERC-8004 registrations. The seed restores the cohort's anchors and ERC-8004 records from carried state,
so a reset before any live action still matches the chain.

After a live action on a cohort agent (the climax, a payment), the chain holds the new score and a
reset shows the seeded one again. Reproduced on the local stack on 2026-10-09: the climax took the
Trading Assistant from 96 to 92 on-chain; after a reset Fuku showed 96 and the chain 92, and the
preflight failed ("anchored score equals Fuku's: Fuku 96, chain 92"). `npm run demo:cohort` (on
testnet `-- --allow-testnet`, about 0.69 MON) seeds, anchors and funds a fresh cohort; after it and a
reset the preflight was READY again. So: rehearse on the MCP Assistant or local stack, run the climax
once per cohort, and rotate the cohort to present again.

The MCP Assistant is kept across resets with its history, score and agent key. Its daily budget
(100 aUSDC-SIM in the mandate and in the passport) refills at 00:00 UTC; a reset does not refill it.

## 5. Dependencies

Triage of `npm audit` by reachability is in [`SECURITY.md`](SECURITY.md) section 12 (2026-10-09:
root 28 findings, `contracts/` 8 low, CRE none). Nothing was upgraded.

For the demo: the only finding reachable as the demo runs today is the Next.js dev server's MCP
endpoint (`/_next/mcp`, information disclosure), because `next dev` listens on every interface.
Start the app with `-H 127.0.0.1`. The critical `next/og` RCE is not reachable (Fuku does not use
`next/og`). Proposed for approval: `next` 16.3.5 → 16.3.8, and a non-forced `npm audit fix` with a
Dynamic sign-in retest after the demo. Never `npm audit fix --force` (it downgrades Prisma and the
lint config across majors).
