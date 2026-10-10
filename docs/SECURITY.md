# Fuku security model and trust assumptions

Checked against the code on 2026-09-30 (branch `feat/cleanverse-cvi-cva`). Where a property depends on a server key or on Fuku's database rather than on a contract, this document says so.

## 1. What is enforced, and by whom

| Claim | Enforced by | Evidence a third party can check |
| --- | --- | --- |
| Only the owner (or someone the owner delegated to) can register, change, run or revoke an agent | `web/src/lib/services/authz.ts`, used by every web, SDK and CRE route | 403 responses; `Delegation` rows |
| For an owner-controlled identity, only the owner's wallet can register the identity and its agents, anchor or revoke passports, and pause agents | The registries (`controllerOf` checks); Fuku only prepares calldata and confirms | `controllerOf(identity)` = the owner's wallet; relayer calls revert `NotAgentOwner` / `NotIdentityController` |
| A value action needs a passkey-verified owner, a complete request and a daily limit | Engine rules R11, R12 (`web/src/lib/engine/permission.ts`) | The decision, rule id and proof hash anchored with `recordDecision` |
| An A-Token transfer needs the asset rule, the owner's A-Pass and the recipient's A-Pass | Engine rules R9, R7, R8 plus Cleanverse evidence (`complianceRef`) | `complianceRef` in the attestation and in `GuardedTransferExecuted` |
| A transfer moves only what the owner authorised: token, daily cap, per-transfer limit, expiry, approved payees, active agent, current passport | `FukuSpendGuard.execute` on-chain | The mandate (`mandates()`), `MandateOpened` and `PayeeSet` events |
| Each action executes at most once; retries do not pay twice | `actionExecuted` in the guard, plus `Idempotency-Key` in the API | `ActionAlreadyExecuted` revert; replayed responses |
| Parallel requests cannot spend the same remainder | Off-chain: one conditional `UPDATE` on `BudgetWindow`. On-chain: the guard's per-day cap | R5 decisions; `DailyCapExceeded` |
| Revoking or pausing voids every earlier attestation for good | Fuku bumps the guard's `validAfter` on pause and revoke (as an enforcer, no owner signature needed), then `revokePolicy` / `setStatus` follow on the registries. Fuku anchors a passport hash that commits to its version, and never re-anchors a passport its database has revoked (section 7) | `AttestationSuperseded`, `PolicyNotActive`, `PolicyMismatch` and `AgentNotActive` reverts; `ValidAfterBumped` events |
| A live write is never reported as a successful mock | `send`, `sendStrict`, `executeGuardedTransfer` in `web/src/lib/chain/index.ts` | `receipt.status` and `receiptMode` on every stored action |

What is **not** enforced on-chain:

- The passport's allowed and blocked actions, app scope and off-chain limits are evaluated by Fuku's engine. On-chain, the guard only checks that the passport hash matches.
- The application name is declared by the caller, so it is a label, not proof of where an action ran.

## 2. Authorization

- **Sessions (web app):** HS256 JWT cookie, 7 days, `httpOnly`, `sameSite=lax`, `secure` in production. In production the server refuses to start sessions without a random `FUKU_SESSION_SECRET` of at least 32 characters. Logout deletes the cookie; there is no server-side session revocation yet.
- **API keys (SDK, CRE):** a request that presents a key is authorised by that key alone. An invalid, revoked or disabled key gets 401 and never falls back to the browser session.
- **Agent keys** (`fk_agent_…`): an API key bound to one agent, minted only by that agent's owner. It reads, dry-runs and executes for that agent and reads its receipts, on the routes that opt in, and gets 403 everywhere else (passport, agent and identity management, keys, other agents). Section 11 has the details; it is what the MCP server runs with.
- **Acting for an owner** (`canActFor`) is allowed in three cases:
  - the caller is the owner;
  - the caller created the identity through `POST /api/v1/identities` (`managedById`);
  - the owner granted a `Delegation` with scope `agents:register`, `agents:manage` or `agents:execute`, still inside its expiry and not revoked.
- **Delegations:** only the owner can grant or revoke them, from a signed-in session (`/api/delegations`). An API key can never grant itself rights. A revocation takes effect on the next request.
- **Evidence exposure:** `checkPermission` returns Cleanverse evidence (the owner's wallet, record ids, tiers) only to callers who may execute for the agent. Other callers see the pass/fail legs.
- **Rate limits** (`web/src/lib/rate-limit.ts`, fixed windows per process, bounded to 10,000 keys):

  | Bucket | Limit | Keyed by |
  | --- | --- | --- |
  | auth | 20 per minute | client IP |
  | create | 20 per minute | caller |
  | manage | 30 per minute | caller |
  | execute | 60 per minute | caller |
  | read | 120 per minute | caller |

  With N server instances the effective budget is N times these; a shared store is the upgrade path.
- **Demo:** the demo sign-in, `?reset=1` and the seeded demo key are on in development and off in production unless `FUKU_DEMO_ENABLED=true`. The redirect only follows same-site paths.

## 3. Identity evidence

`verificationOf()` in `web/src/lib/services/identity.ts` reports four separate statuses:

| Status | Meaning | Evidence |
| --- | --- | --- |
| passkey | A WebAuthn ceremony with user verification (PIN or biometric) succeeded. The flag is `Identity.humanVerified` | Registration and login require UV |
| wallet | Control of the owner wallet was proven | A Dynamic JWT credential verified server-side, or a signed binding message (EIP-191) |
| unique human | **Never established.** Fuku does not run KYC or proof of personhood | none |
| Cleanverse | The verified wallet's A-Pass is eligible, from the last persisted read | `CleanversePass` row, `source` = cleanverse or simulated |

- **Wallet binding.** The owner signs a one-time message naming the Fuku identity, the wallet, the chain id, a nonce and a 5-minute expiry.
  - EOAs are verified locally. Contract wallets (ERC-1271, ERC-6492) are verified through the chain when it is live; in mock mode only EOAs can bind.
  - A wallet bound to one identity cannot be bound to another.
  - A declared wallet that was never bound fails R7 (`CVI_NO_WALLET`), because its A-Pass would not be the owner's.
- **WebAuthn.**
  - User verification is required.
  - Origins are pinned by `WEBAUTHN_ORIGINS` (falling back to `NEXT_PUBLIC_APP_URL`); outside production, `http://localhost:*` is also accepted.
  - The RP ID comes from `WEBAUTHN_RP_ID` or the origin.
  - Challenges live 5 minutes and are consumed with a conditional delete, so they are single-use even under concurrency.
  - Attestation is `none`: Fuku does not vet authenticator models.

## 4. The enforced financial flow

Setup, done by the owner's own wallet:

1. `approve(FukuSpendGuard, amount)` on the A-Token.
2. `openMandate(agentId, token, dailyCap, maxPerTx, validUntil, restrictPayees)`.
3. `setPayee(agentId, payee, true)`.

Per transfer:

1. The API authorises the caller and evaluates the passport, owner and request (R0 to R4, R11, R12, R9, R7, R8, R5).
2. It reserves the day's budget atomically and creates the action row. The row id is the action id: `actionHash = keccak256(id)`.
3. The compliance signer signs an EIP-712 `GuardedTransfer` over:
   `agentId, from, to, token, amount, policyHash, actionHash, proofHash, complianceRef, mandateVersion, nonce, issuedAt, deadline`
   - `issuedAt` is the latest block's time, and strictly later than the agent's and the funding wallet's `validAfter`.
   - The attestation lives `FUKU_ATTESTATION_TTL_S` (60 s by default), never longer than the guard's `maxAttestationTtl`.
4. The guard checks, in order:
   - the attestation window:
     - the deadline has not passed;
     - `issuedAt` is at most 5 s ahead of block time;
     - `deadline − issuedAt` is at most `maxAttestationTtl` (60 s by default; the guard owner may set 10 s to 1 h);
     - `issuedAt` is later than both `validAfter` values;
   - an unused nonce, an unused action hash, and a low-s signature from the compliance signer (domain: name, version, chain id, guard address);
   - the agent exists and is not paused or revoked;
   - the policy is active and its hash equals the attested one;
   - the mandate is active, on this token, at this version, and not expired;
   - the amount is non-zero, within `maxPerTx`, and the payee is approved (when restricted);
   - the UTC-day cap.
   It then marks the nonce and action used, calls `transferFrom` (the token re-checks both A-Passes and its revert bubbles up), calls `recordDecision(R6)` and emits `GuardedTransferExecuted`. It is `nonReentrant` and holds no funds.
5. The row becomes `CONFIRMED` with the tx hash, block, block hash and log index, and one reputation success is recorded for it.

**Scope.** Fuku can only move tokens a wallet has approved to the guard, inside that wallet's mandate. It cannot control other wallets or assets.

**Denials.** A would-be revert is caught in simulation and recorded as R10 with a separate `recordDecision`, because a reverted transaction leaves no event.

## 5. Execution lifecycle

| From | To | When |
| --- | --- | --- |
| (request) | DENIED | Any rule blocks: R0 to R12, or R10 when the guard would revert. Nothing executes |
| (request) | AUTHORIZED | Allowed, and Fuku does not execute this kind of action. The decision is anchored; the agent's own integration executes it |
| AUTHORIZED | SUBMITTED | A guarded transfer is broadcast. Its hash is stored before waiting |
| SUBMITTED | CONFIRMED | The receipt succeeded |
| SUBMITTED | PENDING | No receipt within 90 s. HTTP 202; reconciliation settles it |
| SUBMITTED, PENDING | FAILED | Mined and reverted, or never executed and the attestation expired. The budget is released |
| AUTHORIZED | FAILED | Signing or RPC failed before broadcast. HTTP 502, the budget is released, nothing moved |
| AUTHORIZED | SIMULATED | Mock chain: the transfer path ran and nothing moved |
| CONFIRMED | PENDING | Reconciliation no longer finds the receipt (reorg). The success event is removed until it confirms again |

Rules that follow from the lifecycle:

- **Idempotency.** An `Idempotency-Key` is unique per agent. A repeat with the same body replays the stored result; a different body gets 422; an in-flight request gets 409.
- **Reputation.** Only CONFIRMED earns a success.
  - A DENIED caused by the agent's own request is a violation.
  - A DENIED caused by the owner or the infrastructure is neutral: R7, R11, a guard that is not configured, or no mandate.
  - AUTHORIZED, SIMULATED, PENDING and FAILED change nothing.
  - There is at most one event per action.
- **Reconciliation.** `npm run reconcile`, or throttled on activity reads. It settles SUBMITTED and PENDING rows from the stored hash.
  - It recovers a transfer whose hash was never stored (a crash) through the guard's `actionExecuted` and its event log.
  - It re-checks confirmations from the last `FUKU_REORG_DEPTH` blocks (default 64).
  - It retries failed decision anchors.
  - Every transition is a conditional update, so concurrent runs are safe.
- **Chain writes.** They come from one relayer key, serialised in process and across processes by a `ChainLock` lease row (150 s). A live failure is stored as `failed`, never as a mock receipt.
- **The owner's mandate, before signing and in the dry run.** `web/src/lib/chain/mandate-check.ts` reads the guard's mandate, today's spend and the payee flag at one block, and applies `_checkMandateAndCap` in the contract's order and with its error names. Execution runs it before the compliance signer signs (a transfer the guard would refuse is R10 and never attested); the guard's own simulation still decides. The dry run (`check`, `fuku_check_permission`) runs the same code for A-Token transfers the passport allows: refused is BLOCKED R10 with execution's wording, unreadable (an RPC failure) is `UNKNOWN` (`allowed: false`, `MANDATE_UNAVAILABLE`), and on a mocked chain ALLOWED says the mandate was not checked. Not previewed: the attestation, and the agent's registration and passport on-chain, which execution anchors first.

**Known limitation.** A decision anchor (`recordDecision`, not value-moving) whose process dies between broadcast and storing the result may be retried and recorded twice in the registry's counters. A guarded transfer cannot be: the action hash is single-use on-chain.

## 6. Remaining trust assumptions and admin powers

1. **The relayer key** (`DEPLOYER_PRIVATE_KEY`) owns the four registries.
   - It is the on-chain controller of every **custodial** identity: the seeded demo, identities without a bound wallet, and identities it registered before custody existed.
   - For **owner-controlled** identities (a wallet bound before the first on-chain write), the owner's wallet is the controller. The relayer cannot register, re-anchor, revoke or pause for them; see `docs/MIGRATION.md`.
   - For every identity it remains the enforcer and the scorer, and it sets the passkey flag. It can therefore still record decisions and scores for any agent.
   - For owner-controlled agents, Fuku's kill switch acts off-chain immediately. The on-chain revoke or pause waits for the owner's signature, and `closeMandate` from the owner's wallet stops transfers too.
   - As the controller of a custodial identity, the relayer could re-activate a revoked passport on-chain. Fuku's code never does (section 7), but that is the server's discipline, not the contract's. Owner-controlled identities remove it.
2. **The compliance signer** (`FUKU_COMPLIANCE_SIGNER_KEY`) can attest any transfer that fits a mandate the owner opened, for an active agent whose on-chain passport hash matches. It cannot exceed the owner's token, cap, per-transfer limit, expiry or payee list.
   - Each attestation names the passport hash (bound to the passport version) and the mandate version, so a revoke, a new passport version or a closed mandate voids it.
   - It lives at most 60 s, and the guard enforces the cap.
   - A `validAfter` bump voids every attestation issued before it:
     - Fuku sends one on pause and revoke, and when reconcile sees an allowance change;
     - the agent's controller can send one;
     - the funding wallet can send one for its own funds.
3. **The guard's owner** can rotate the compliance signer. The simulator contracts' owner issues simulator A-Passes and mints `aUSDC-SIM`; they are not Cleanverse.
4. **The engine and database.** The passport's allowed actions, app scope and off-chain limits, and the reputation ledger, live in Fuku's database and are enforced by Fuku's server. On-chain commitments prove the integrity of a recorded decision, not that an AUTHORIZED action was executed or executed correctly.
   - **Commit-reveal.** Every anchored decision proof is `keccak256` of a decision record: the action, amount, app, decision, rule, sub-code, R10 guard reason, passport hash and time (`web/src/lib/records.ts`).
     - Fuku keeps each record in `DecisionRecord`, across agent deletions and demo resets, and reveals them through `GET /api/v1/agents/:id/records`.
     - `npm run verify-score` and **Recompute from chain** check each record's hash against the `proofHash` anchored at `keccak256(actionId)`.
     - They recompute fuku-score/2 from checked records and on-chain state (the passkey flag, the passport, `GuardedTransferExecuted`, the simulator A-Pass), and compare it with `ReputationRegistry` and the ledger.
     - A record that does not match is reported. An on-chain decision without a revealed record counts from the on-chain data alone; a denial counts against the agent, R10 included.
     - ✓ means every record checks out, nothing on-chain is unrevealed, and the three scores agree.
   - **Still not committed on-chain:**
     - security events;
     - an A-Pass read through the Cleanverse API (only the simulator's A-Pass is a contract);
     - the passkey ceremony itself (the flag is Fuku's attestation as registry owner);
     - the seeded history's completed actions. They are committed as Fuku's own records ("legacy-success", fuku-score/1 rules), not proven by on-chain transfers.
   - **The demo's seeded history** has deterministic ids and records, and `npm run reconcile -- --anchor-seeded` anchors it once.
     - A demo reset rebuilds the same records, so they stay verifiable.
     - A reset cannot rewind the chain. After a live action and a reset, the agent's chain history is ahead of its reseeded ledger, and **Recompute from chain** says so.
     - A reset keeps what the testnet setup recorded about the seeded agents (`DemoAgentState`): the ERC-8004 registration, the sealed agent key (without it the registered `agentWallet` would be orphaned), and the registration and passport transactions. The seeded rows come back as anchored where their record was anchored on the same chain and PermissionRegistry.
     - `npm run demo:cohort` moves the demo to a fresh cohort: new agent ids and seeded action ids, anchored, mandated and registered on ERC-8004. Earlier cohorts' records and carried state stay in the database.
5. **Cleanverse** runs in simulator mode until the API invite lands (`docs/CLEANVERSE.md`). The real A-Token's transfer rules for third-party contracts are unverified.
6. **Memory vault.** Items are encrypted in the browser with a key derived from the owner's passphrase (PBKDF2-SHA256, 100,000 iterations, salted with the identity id, into AES-256-GCM).
   - Every identity except the seeded demo chooses its own passphrase (at least 10 characters). The server stores ciphertext and one encrypted check value that tells a wrong passphrase from a right one; it never receives the passphrase or the key. The key stays in the tab's memory and is not persisted.
   - There is no recovery. "Forgot it? Start over" deletes every item.
   - Items written by earlier builds, under the shared demo passphrase, are re-encrypted in the browser when the owner sets a passphrase, and the server only accepts that change when it covers every item.
   - The seeded demo identity (Ava) alone keeps the public demo passphrase, labelled on the page as not secret.
   - Item titles are stored in clear. Agents get no key access, and there are no scoped grants.
7. **Not claimed:** unique-human proof, KYC, ERC-8004 conformance (the registries are inspired by it), decentralised verification, and production readiness.

## 7. Adversarial checks, and what still depends on the server

The attacker in these checks is Fuku's own server. It holds the compliance signer key, relays every transaction, is the registries' enforcer and scorer, and runs the engine.

**Checks.**
- `contracts/test/FukuSpendGuard.adversarial.test.ts`, 13 tests of direct guard calls:
  - A leaked signer key moves nothing outside the owner's mandate: not from another wallet, for another agent or in another token, and not with a forged mandate version or passport hash. Inside the mandate it moves at most the daily cap.
  - Only the funding wallet opens, closes or re-points its mandate and payee list. The guard owner can only rotate the signer, and the new signer is bounded the same way.
  - As enforcer, scorer or registry owner, the server cannot set, revoke or pause a passport.
  - `revokePolicy` and `closeMandate` are final for earlier attestations, including a retry of one the token rejected.
  - Pause then unpause, and allowance withdrawn then restored, no longer revive an earlier attestation once `validAfter` is bumped (`AttestationSuperseded`). Without a bump, only the attestation's 60 s life bounds them; a test pins this.
  - Bumps:
    - agent-wide, only the agent's controller or an enforcer may bump;
    - per wallet, only the wallet itself or an enforcer may bump, so opening a mandate for someone else's agent freezes nothing of theirs.
  - The 60 s lifetime is enforced on-chain, and only the owner may change it.
  - An attestation dated more than 5 s ahead is refused. One issued in the same second as a bump is void.
  - A frozen, revoked or expired A-Pass blocks an agent whose on-chain score is 100.
- `web/src/lib/services/services.test.ts`, "revocation is final (server side)", 4 tests:
  - the version-bound passport hash;
  - `AUTHORIZATION_CHANGED` before signing;
  - an idempotent replay after the kill switch;
  - R7 for an agent scored 100.
- `web/scripts/adversarial-live.ts` (`npm run adversarial:live`), 12 checks on a live chain. It goes through Fuku's own code paths while holding an agent snapshot taken before the revoke.
- The live smoke checks four more things:
  - pausing then resuming in the app leaves a pre-pause attestation dead;
  - an allowance withdrawn and restored from the owner's wallet makes reconcile bump the wallet's `validAfter`, with the same effect;
  - a later decision anchor and a reconcile pass leave a revoked passport inactive;
  - a passport update for an owner-controlled agent waits for the owner's signature.

**Found and fixed on 2026-09-30.** On the previous code the live probe failed 6 of its 12 checks.
1. **A stale snapshot re-activated a revoked passport.** A decision anchor, a score update or a guarded transfer that still held the agent as loaded before the kill switch re-anchored the revoked passport on-chain (`ensurePolicyOnChain` trusted the snapshot). The guarded transfer then signed an attestation.
   - Now the relayer anchors only the passport the database holds when it has the signer lease, and never a revoked one.
   - A guarded transfer re-checks the agent and the passport version in the database right before signing. If either changed, it is refused with R10 `AUTHORIZATION_CHANGED` and nothing is signed.
2. **Re-approving revived old attestations.** The anchored passport hash covered the rules but not the version. Approving the same rules again after a revoke anchored the same hash, so attestations issued before the revoke became valid again until their deadline. The hash now commits to the version (`policyAnchorHash`), and those attestations revert `PolicyMismatch`.
3. **Owner-controlled passport updates failed.** For an agent its owner had already registered, a passport update made the relayer try `setPolicy`, which reverted `NotAgentOwner` and was recorded as `failed`. It now returns `awaiting-owner` for the owner to sign.

Passport writes also go to the database first now, as revokes already did, so the chain follows the database.

**What still depends on the server.**
1. **The passport's content.** Allowed and blocked actions, app scope and the off-chain limits are enforced by Fuku's engine. The guard sees one hash.
2. **A revoke staying final across re-approvals.** The guard compares only the passport hash; a contract test pins this.
   - Fuku binds the hash to the version and never re-anchors a revoked passport.
   - For a custodial identity, the relayer could do so as the controller, and only Fuku's code stops it.
   - For an owner-controlled identity, only the owner's wallet can anchor.
3. **The kill switch's timing.** The database write is the switch.
   - A transfer whose re-check ran before that write may still be mined. At most one is in flight, because signing is serialised.
   - Fuku's `validAfter` bump follows at once in the relayer's queue. It needs no owner signature, so it applies to owner-controlled agents too.
   - The registry revoke or pause follows the bump. For owner-controlled agents that step waits for the owner's signature.
   - `closeMandate` and `bumpWalletValidAfter` from the owner's wallet are the on-chain stops the owner controls directly.
4. **Allowance changes are seen by reconcile, not at once.** Fuku learns of an allowance change from the token's `Approval` events when reconcile runs: on activity reads (throttled to 15 s), on the mandate page, and by cron.
   - Between a restore and that pass, an attestation issued before the withdrawal could still execute. The 60 s life bounds this.
   - The owner's own `bumpWalletValidAfter` is immediate.
   - `issuedAt` is the signer's claim. The guard refuses a backdated one (at or before a bump) and one dated more than 5 s ahead, but a compromised signer can still sign fresh attestations inside the mandate. Rotating the signer or closing the mandate stops that.
5. **One execution per action.** The guard executes each action hash at most once. That the server never re-signs a settled action (a denied or failed row) is its own discipline:
   - every request creates a new row;
   - reconcile only reads receipts and `actionExecuted`; it never sends a transfer.
6. **Eligibility versus score.** The token checks both A-Passes on every transfer, and the engine checks them before signing (R7, R8). The trust score is never an input to allow or deny.

## 8. Reproduce

Local runs on 2026-09-30:

| Command | Expected |
| --- | --- |
| `cd contracts && npm test` | 72 passing (13 of them adversarial) |
| `npm test` (root: web, sdk and mcp workspaces) | 105 web tests, 11 SDK tests, 20 MCP tests, all passing (2026-10-09) |
| `cd web && npx tsc --noEmit && npm run lint` | no errors |
| `cd cre/fuku-guard && bun test` | 10 pass |
| Local node smoke (`docs/CLEANVERSE.md` "Run it locally", with `DATABASE_URL` pointing at the web instance's database and `SMOKE_OWNER_PRIVATE_KEY` set) | `67/67 checks passed` on a fresh node, and again on the same node; 66/66 on Monad testnet (2026-09-30), where the reorg check cannot run |
| `cd web && npm run adversarial:live` against the local node, with its own `DATABASE_URL` (schema pushed) | `12/12 passed` |
| `cd web && npm run reconcile -- --anchor-seeded`, then `npm run verify-score`, on the local node after a demo reset | 40 transactions, then 5/5 demo agents verified (Trading Assistant 96 = 96 = 96, 15/15 records). After the withdraw climax: 92 = 92 = 92, 16/16. After the full smoke (which resets the demo), Trading Assistant still verifies |
| `npm test -w mcp` | 20 passing: the tools over the MCP in-memory transport with a fake SDK client, the built server over real stdio (only JSON-RPC on stdout), configuration errors, the API-key policy (owner key refused, agent key for another agent refused) |
| `FUKU_MCP_INTEGRATION=1 … npm run test:integration -w mcp` after `npm run mcp:setup`, on a local node and a production build of the app | 7/7 (2026-10-09). The checks: whoami (with an agent key); three dry runs (allowed, R8, R2); a 30 aUSDC transfer seen on-chain; withdraw BLOCKED R2 with `isError: false`; a 60 transfer blocked by the guard's per-transfer limit (R10), or by R5 once the day's budget is low; an idempotent replay; the server's agent key refused (403) on passport changes, agent registration, key minting and another agent |
| `npm run owner-path:local` against a running app on a local node | 28/28 (2026-10-09): the owner-controlled path with the money (`docs/DEMO-READINESS.md` section 2) |
| `node examples/sdk-consumer/index.mjs` (after `npm run build -w sdk`) | 16 steps `ok`, exit 0 (the 3 ERC-8004 steps are skipped on a local node); 19/19 on Monad testnet (2026-09-30) |
| Mock mode (no chain env): demo reset, then withdraw 4,800 | R2, score 96 → 92, receipt `simulated` |

## 9. Production configuration

The production environment needs:

- `FUKU_SESSION_SECRET`: at least 32 random characters.
- `WEBAUTHN_ORIGINS` (or `NEXT_PUBLIC_APP_URL`) and `WEBAUTHN_RP_ID` for the public domain.
- `FUKU_DEMO_ENABLED` unset. Set it to `true` only for an isolated demo deployment.
- A dedicated `FUKU_COMPLIANCE_SIGNER_KEY`, not the deployer.
- A scheduled `npm run reconcile`.
- A shared database for several instances. SQLite is single-node.
- Upgrade the rate limits to a shared store before scaling out.

## 10. Testnet runbook (executed on 2026-09-30)

The costs below are what the run on Monad testnet on 2026-09-30 paid: gas limit × price (about 102 gwei), which is what Monad charges.
- 116 transactions, none reverted, 1.83 MON of gas. Every hash is in `docs/CLEANVERSE.md`, "On Monad testnet".
- A local fork rehearsal of the same sequence predicted less for the anchoring (0.32 MON) and the smoke (about 0.33 MON).
- A newly funded wallet's first transaction can be refused for a few minutes ("Signer had insufficient balance"), so fund wallets ahead of their first transaction.

1. `contracts/.env`: set `COMPLIANCE_SIGNER_ADDRESS` to a fresh key's address and `FUKU_COMPLIANCE_SIGNER_KEY` to that key.
2. `cd contracts && npm run deploy:cleanverse:monad`. It sends two simulators, the guard and one enforcer grant: 4 transactions, 0.40 MON. The four registries are untouched.
3. `npm run wire:env`. It writes `FUKU_SPEND_GUARD`, `CLEANVERSE_SIM_*` and the signer key into `web/.env`.
   - It first copies the file to a new timestamped backup.
   - It refuses to replace a different key already there unless given `--replace-keys`.
   - It never touches `DEMO_OWNER_PRIVATE_KEY`, `SMOKE_OWNER_PRIVATE_KEY` or `FUKU_AGENT_KEY_SECRET`.
4. Prepare `web/.env`:
   - add a fresh `DEMO_OWNER_PRIVATE_KEY` and `FUKU_AGENT_KEY_SECRET` (at least 32 random characters);
   - set `FUKU_PUBLIC_URL` only if the app is served publicly over https;
   - then run `cd web && SETUP_OWNER_MIN_MON=0.35 SETUP_OWNER_TOPUP_MON=0.4 npm run cleanverse:setup`.

   The setup cost 0.07 MON (0.04 from the relayer, 0.03 from Ava's wallet) and topped her wallet up with 0.4 MON. Her ERC-8004 registrations and her part of the smoke then cost her 0.28 MON.
5. Restart the app. Reset the demo so Ava's wallet binding uses the new key.
6. `npm run reconcile -- --anchor-seeded`.
   - It anchors the seeded history: 5 agents, 3 passports, 25 decisions and 5 scores: 38 transactions, 0.40 MON (Ava's identity is already on testnet). It prints every transaction.
   - Do not run live actions on the demo agents before the pitch: a reset cannot rewind the chain.
   - To present again after live actions, `npm run demo:cohort -- --allow-testnet` seeds and anchors a fresh cohort. It also opens its mandate, registers it on ERC-8004 and verifies it. After a recorded climax it sends 52 transactions. That cost 0.59 MON on the fork. Priced from the testnet run's own transactions, expect about 0.69 MON: 0.41 from the relayer and 0.28 from Ava's wallet.
7. `npm run erc8004:register -- --allow-testnet`. It registers the 5 demo agents from Ava's wallet on the canonical Identity Registry, with Fuku-held agent keys as `agentWallet`, and prints each transaction and agent id.
   - Cost: 0.25 MON with `data:` URIs (10 transactions). With `FUKU_PUBLIC_URL`, whose registration endpoint is checked to resolve first, the fork estimate is about 0.13 MON; that has not been measured on testnet.
8. Run the smoke against testnet: `FUKU_BASE_URL=… MONAD_RPC_URL=https://testnet-rpc.monad.xyz FUKU_DEPLOYMENT_FILE=../contracts/deployments/monadTestnet.json DATABASE_URL=… DEMO_OWNER_PRIVATE_KEY=… SMOKE_OWNER_PRIVATE_KEY=… node scripts/live-smoke.mjs`.
   - 42 transactions: 0.41 MON from the relayer, 0.03 from Ava's wallet and 0.07 from the smoke owner's.
   - The owner-custody section needs `SMOKE_OWNER_PRIVATE_KEY`: a separate key with about 0.1 MON, since the owner's wallet pays for its registry writes.
   - The Cleanverse checks run on a fresh A-Token agent whose mandate Ava's wallet opens, so the demo agents stay verifiable. The reorg check is skipped off Hardhat.
9. `cd contracts && npm run verify:monad`. It publishes every contract's source through Sourcify for MonadVision. No transaction.
10. Record every transaction hash in `docs/CLEANVERSE.md` and `docs/PITCH.md`.
11. Restart the app on 3001, then check two things:
    - Trading Assistant shows 96;
    - **Recompute from chain** shows ✓ for it (`npm run verify-score -- --demo` checks all five).

Over this sequence the relayer spent 1.76 MON: 1.26 MON of gas, plus the 0.5 MON it sent to Ava and the smoke owner. `examples/sdk-consumer` against testnet is optional: 12 transactions, 0.19 MON (0.12 from the relayer, 0.07 from the owner's wallet).

## 11. AI assistants over MCP: the agent's own key

`mcp/` lets an AI assistant (Claude Desktop, Claude Code) act as a Fuku agent from the user's machine.

**What the path is.**
- `npm run mcp:setup` generates the agent's key on that machine, writes it only to `mcp/.env` (gitignored, checked first), and registers its address with Fuku as the agent's key. On Monad testnet the address is also the agent's ERC-8004 `agentWallet`.
- Fuku stores the address and never sees the key. This is the non-custodial agent-key path. The seeded demo agents still have keys that Fuku holds, labelled as such.

**What Fuku enforces.**
- For an agent that holds its own key, every execution over the v1 API must be signed with that key: EIP-191 over the exact body, the idempotency key and the issue time, accepted for 5 minutes (`web/src/lib/agent-signature.ts`).
- An unsigned request is refused with `401 agent_signature_required`, and a request signed with another key with `agent_signature_invalid`. The check runs after authorization and before an idempotent replay.
- The result records the signer (`agentSignature`), and the workflow shows "Agent key verified".

**The server's API key is an agent key** (`web/src/lib/services/api-keys.ts`, `withApiKey` in `web/src/lib/api.ts`).
- `mcp:setup` mints a key bound to the MCP agent (`fk_agent_…`) and writes it to `mcp/.env`; the owner's key is never written there. The MCP server asks Fuku what its key is before the first call and refuses an owner key unless `FUKU_MCP_ALLOW_OWNER_KEY=1`.
- An agent key works only on routes that opt in, only with the scopes it carries, and only for its own agent: read itself, dry-run, execute (still signed with the agent's own key), read its own receipts. Passport changes, agent registration and management, identities and wallets, ERC-8004 setup, records, delegations, key minting, travel-rule records, other agents and other owners answer 403 (`agent_key_*`). A test pins the list of routes that admit agent keys.
- The key is checked against its agent on every request: if the agent changes owner the key stops working, and deleting the agent deletes its keys. The owner revokes it in the Developer Console or with `revokeAgentKey`.

**What it protects.**
- A stolen `mcp/.env` gives the agent's own authority (bounded by its passport and mandate), not the owner's: it cannot raise a limit, unblock withdraw, or touch another agent.
- A leaked owner API key alone cannot execute as this agent over the API.
- Fuku cannot act as the agent over the API either, because it never held the key.
- Every action the assistant takes is bound to the key on the user's machine.
- What the assistant can do is bounded by its passport (enforced by Fuku) and its owner's mandate (enforced on-chain by FukuSpendGuard): for the MCP Assistant, 100 aUSDC a day, at most 50 per transfer, to Nusantara Supplies only. A prompt-injected model, or a stolen agent key, can move no more than that, and only to that payee.
- Rules are evaluated by Fuku's engine on every request, never by the model. The tool descriptions ask the model to check first and not to work around a block, but that is guidance. The engine's decision is what counts, and it is anchored on Monad.

**What it does not protect.**
- The agent key and the server's API key sit on the same machine, in `mcp/.env` or the MCP client's configuration. Whoever controls that machine can act as the agent, within its passport and mandate, until the owner revokes the key or the passport.
- Owner keys (`fk_live_…`) still carry their identity's full rights. Only agent keys are scoped; an application acting for many owners uses its own owner key plus delegations (section 2).
- The owner's own session in the Fuku app is not an API call. The owner can act for the agent there without the agent key.
- The signature is checked by Fuku's API, not on-chain. FukuSpendGuard checks the compliance signer's attestation and the owner's mandate. Fuku's server still decides and anchors, with the trust assumptions in sections 6 and 7.
- A signed request that someone captures can be replayed within its 5 minutes. A replay returns the stored result of the same idempotency key and never executes twice.
- To cut an assistant off, revoke the agent's passport (the kill switch, section 6). Or give the agent a new key with `setErc8004AgentKey`; the old key is then refused.

## 12. Dependency audit triage (2026-10-09)

`npm audit` at the root (web, sdk, mcp): 28 findings, 1 critical, 15 high, 12 moderate. `contracts/`:
8 low. `cre/fuku-guard` (`bun audit`): none in 37 packages. Each is triaged by whether an attacker can
reach the vulnerable code in what Fuku runs. Nothing was upgraded: the fixes below wait for approval.

**Runtime, server: the Next.js app (`next` 16.3.5, pinned).** Every advisory is fixed in 16.3.8.

| Advisory | Reachable in Fuku? |
| --- | --- |
| RCE in `next/og` `ImageResponse` (critical, GHSA-vcvr-r3jv-pc5j) | No: nothing imports `next/og`, and the only metadata image is a static `icon.png` |
| Draft Mode content leak through `use cache` (GHSA-3w37-wq28-93x7) | No: no `"use cache"`, no `draftMode` |
| Metadata image routes, `dynamicParams` bypass (GHSA-f87g-xv8r-7p7x) | No: no dynamic metadata image routes |
| SSRF in Image Optimization (high, GHSA-cjq9-62q9-8jv4) | The `/_next/image` endpoint exists on every Next server; Fuku configures no remote patterns and uses `next/image` for one local file. Not reachable on a localhost demo; assume reachable if the app is hosted publicly |
| SSG/ISR cache poisoning (GHSA-4jqv-mc3x-m676, GHSA-mcj8-r9mp-w47p) | The app shell is `force-dynamic`; the landing and sign-in pages are static. Matters only behind a shared cache on a public host |
| Dev server MCP endpoint information disclosure (low, GHSA-39w2-rjm5-chcv) | **Yes, for the demo as run today.** The demo uses `next dev`, which listens on `0.0.0.0`; `POST /_next/mcp` answered `tools/list` (`get_logs`, `get_routes`, `get_project_metadata`, …) on the local stack. Anyone on the same network can call it. Mitigation now: `npm run dev -- -p 3001 -H 127.0.0.1` |

`sharp` 0.35.4 (high, librsvg CVE-2026-96889) is reached only through Image Optimization, which
refuses SVG input by default and only sees Fuku's local image: not reachable.

**Runtime, browser: Dynamic sign-in (sandbox).** `axios` (via `@dynamic-labs-wallet/core` and
`@coinbase/cdp-sdk`), `uuid` and the `@metamask/*` packages above it. Most axios advisories concern
the Node HTTP adapter, HTTP/2 and proxies, which do not exist in a browser; the prototype-pollution
gadgets need a separate pollution bug to be useful. `uuid` matters only when a caller passes `buf`.
`http-cache-semantics` arrives through `ably` → `got`, which is Node-only and unused in the browser
bundle. Low. The fix is Dynamic's SDK 1.34.1 → 1.39.0 (not a major), which changes the sign-in path that
has never been run end to end (`docs/DEMO-READINESS.md` section 2, step I2: the Dynamic OTP needs a real inbox).

**Build and developer tooling only:** `source-map-js` (our own CSS through PostCSS/Tailwind), `shadcn`,
`eslint-config-next` / `@next/eslint-plugin-next`, `fast-glob` / `micromatch` / `braces`, `ts-morph`,
and the Prisma CLI (`@prisma/config` → `deepmerge-ts`; `@prisma/client` is not affected). Their inputs
are the repository's own files; not shipped to users. In `contracts/`, `elliptic` under `@ethersproject`
comes with `hardhat-verify`; Fuku's keys sign with viem (noble), never with elliptic.

**Do not run `npm audit fix --force`.** For prisma, eslint-config-next and shadcn it proposes
"fixes" that are downgrades across majors (prisma 6.12.0, eslint-config-next 14.2.35, shadcn 1.0.0).

**Proposed, not applied (each needs a go-ahead):**
1. `next` 16.3.5 → 16.3.8 (a patch; every listed range ends below it), then the full tests, a build,
   the local stack's MCP integration and owner-path checks, and the preflight.
2. `npm audit fix` without `--force` (dry run: 48 package changes, among them sharp 0.35.5,
   source-map-js 1.2.2, http-cache-semantics 4.3.0 and Dynamic's SDK 1.39.0), with a Dynamic sign-in
   retest, after the demo.
3. For the demo, with no code change: run the dev server bound to `127.0.0.1`.
