# @fuku/sdk

The developer surface of Fuku Protocol: human-backed AI agent identity, permission passports and portable reputation on Monad.

```ts
import { Fuku } from "@fuku/sdk";

const fuku = new Fuku({ apiKey: process.env.FUKU_API_KEY!, baseUrl: "http://localhost:3001" });

// Who is behind this agent, and is it safe to work with?
const v = await fuku.verifyAgent("fuku:agent:0x7a3f…9c21");
// v.owner.humanVerified === true, v.trust.score === 96
// v.owner.cleanverse: last A-Pass read for the owner's wallet ({ source: "simulated" } until the Cleanverse API is live)

// Dry run (nothing recorded, nothing signed)
const check = await fuku.checkPermission(agentId, { action: "withdraw", amountUsdc: 4800 });
// check.allowed === false, check.ruleId === "R2"

// Full workflow: evaluate → execute/block → anchor on Monad → score → explain
const result = await fuku.executeAction(agentId, { action: "swap", amountUsdc: 1200, app: "Monad DEX" });

// Register your own agent and attach a passport
const { agent } = await fuku.registerAgent({ name: "Support Agent", capabilities: ["read_vault", "summarize"] });
await fuku.requestPermission(agent.id, { allowed: [{ action: "read_vault" }], blocked: ["withdraw"] });
const trust = await fuku.getTrustScore(agent.id);
```

## Cleanverse A-Token payments (0.2.0)

A passport that lists A-Tokens (`assets: ["aUSDC"]`) is an **A-Token passport**. A `transfer` on it is checked
against Cleanverse before anything moves: the asset rule (R9), the owner's A-Pass (R7) and the recipient's
A-Pass (R8). If all pass, Fuku's compliance signer attests to that exact transfer (EIP-712) and
`FukuSpendGuard` moves the token from the owner's wallet under the owner's on-chain mandate.

```ts
await fuku.requestPermission(paymentsAgentId, {
  allowed: [{ action: "transfer", limitUsdcPerDay: 1000 }, { action: "read_balances" }],
  blocked: ["withdraw", "change_owner"],
  assets: ["aUSDC"],
});

const pay = await fuku.executeAction(paymentsAgentId, { action: "transfer", amountUsdc: 250, asset: "aUSDC", to: supplierWallet });
pay.decision;     // "ALLOWED" | "BLOCKED"
pay.ruleId;       // "R6", or "R7" / "R8" / "R9" / "R10" with pay.subCode (e.g. "CVI_FROZEN")
pay.compliance;   // { mode, asset, owner, counterparty, complianceRef, evidence }
pay.transfer;     // { txHash, explorerUrl, mode } when the token moved
```

`compliance.mode === "simulated"` means Fuku's Cleanverse simulator answered, not Cleanverse. Blocked actions
resolve with the result (HTTP 403); other failures throw `FukuError` with `status` and `body`, for example a
`502` when a guarded transfer could not be sent on-chain.

| Method | Endpoint |
| --- | --- |
| `createIdentity()` | `POST /api/v1/identities` |
| `registerAgent()` | `POST /api/v1/agents` |
| `verifyAgent()` | `GET /api/v1/agents/:id` |
| `requestPermission()` / `revokePermission()` | `PUT` / `DELETE /api/v1/agents/:id/permissions` |
| `getTrustScore()` | `GET /api/v1/agents/:id/trust` |
| `checkPermission()` | `POST /api/v1/agents/:id/check` |
| `executeAction()` | `POST /api/v1/agents/:id/execute` |

Get an API key from the Developer Console in the Fuku app. The seeded demo key is `fk_live_demo_ava_chen_2026`.

Build: `npm run build` (emits `dist/`). Test: `npm test` (contract tests against a fake HTTP server).

### Changes in 0.2.0

- `ActionRequest` gains `to` and `asset`; `Policy` gains `assets`.
- `ActionResult` and `PermissionCheck` gain `subCode` and `compliance`; `ActionResult` gains `transfer`.
- `Verification.owner.cleanverse` and `passport.assets`.
- `revokePermission()` also returns `chainSync` (whether the on-chain registries followed the kill switch).

All additions are optional fields; 0.1.0 callers keep working.
