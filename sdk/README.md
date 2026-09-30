# @fuku/sdk

The developer surface of Fuku Protocol: human-backed AI agent identity, permission passports and portable reputation on Monad.

```ts
import { Fuku } from "@fuku/sdk";

const fuku = new Fuku({ apiKey: process.env.FUKU_API_KEY!, baseUrl: "http://localhost:3001" });

// Who is behind this agent, and is it safe to work with?
const v = await fuku.verifyAgent("fuku:agent:0x7a3f…9c21");
// v.owner.humanVerified === true, v.trust.score === 96

// Dry run (nothing recorded)
const check = await fuku.checkPermission(agentId, { action: "withdraw", amountUsdc: 4800 });
// check.allowed === false, check.ruleId === "R2"

// Full workflow: evaluate → execute/block → anchor on Monad → score → explain
const result = await fuku.executeAction(agentId, { action: "swap", amountUsdc: 1200, app: "Monad DEX" });

// Register your own agent and attach a passport
const { agent } = await fuku.registerAgent({ name: "Support Agent", capabilities: ["read_vault", "summarize"] });
await fuku.requestPermission(agent.id, { allowed: [{ action: "read_vault" }], blocked: ["withdraw"] });
const trust = await fuku.getTrustScore(agent.id);
```

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

Build: `npm run build` (emits `dist/`).
