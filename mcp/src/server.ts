import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Fuku, FukuError, type AgentSigner, type Verification } from "@fuku/sdk";
import type { Config } from "./config.js";
import { actionText, checkText, executeText, mandateLines, passportLines, scoreText, verifyText } from "./format.js";

export const SERVER_NAME = "fuku";
export const SERVER_VERSION = "0.1.0";

/** The @fuku/sdk calls this server makes (a real Fuku client, or a fake in tests). */
export type FukuClient = Pick<Fuku, "verifyAgent" | "getMandate" | "checkPermission" | "executeAction" | "getAction" | "verifyScore">;

export interface ServerDeps {
  config: Config;
  client: FukuClient;
  /** The agent's own key; null runs the server read-only (no execute tool). */
  signer: (AgentSigner & { address: string }) | null;
}

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

export const INSTRUCTIONS = `You act as a Fuku agent. Every action you take goes through Fuku, which checks it against the permission passport your human owner approved, records the decision on Monad, and updates your trust score.
- Call fuku_whoami first in a session: it says who you are, what you may do, your limits and your trust score.
- Before anything that moves value (transfer, swap, withdraw, stake), call fuku_check_permission, and execute only what it allows.
- A BLOCKED decision is final for that request. Tell the user the rule id and the reason. Never retry with tweaked parameters (a smaller amount, another recipient, a split payment, another asset or app) to get around a rule; ask the user what to do instead.
- Report each result plainly: the decision, the rule, the reason, and the Monad link when there is one.`;

const ok = (text: string, data: Record<string, unknown>): ToolResult => ({
  content: [
    { type: "text", text },
    { type: "text", text: JSON.stringify(data, null, 2) },
  ],
  structuredContent: data,
  isError: false,
});

/** Real failures only (network, auth, input): a BLOCKED decision is a result, not an error. */
export function errorResult(err: unknown, config: Config): ToolResult {
  return { content: [{ type: "text", text: describeError(err, config) }], isError: true };
}

export function describeError(err: unknown, config: Config): string {
  if (err instanceof FukuError) {
    const hint =
      err.code === "unauthorized"
        ? "FUKU_API_KEY was refused: create a key in the Fuku Developer Console and put it in the MCP config."
        : String(err.code).startsWith("agent_signature")
          ? "FUKU_AGENT_PRIVATE_KEY is not the key Fuku has for this agent, or this machine's clock is off by more than 5 minutes."
          : err.code === "forbidden"
            ? "This API key may not act for the agent: use the owner's key, or have the owner grant an agents:execute delegation."
            : err.code === "not_found"
              ? `Not found: check FUKU_AGENT_ID (${config.agentId}).`
              : err.code === "rate_limited"
                ? `Rate limited: try again in ${err.retryAfter ?? "a few"} seconds.`
                : err.code === "chain_write_failed"
                  ? "The on-chain write failed and nothing moved. It is safe to retry with the same idempotency key."
                  : err.code === "mock_chain"
                    ? "The Fuku app runs a mocked chain: there is nothing on-chain to check."
                    : null;
    return `Fuku API error ${err.status} (${err.code}): ${err.message}${hint ? `\n${hint}` : ""}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(`${message} ${cause}`)) {
    return `Fuku is not reachable at ${config.baseUrl}. Is the Fuku app running (cd web && npm run dev -- -p 3001)? (${cause || message})`;
  }
  return `Unexpected error: ${message}`;
}

async function guarded(config: Config, run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    return errorResult(err, config);
  }
}

const sameAddress = (a?: string | null, b?: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/** Who this agent is, and whether the configured key can execute for it. */
function executeStatus(v: Verification, signer: ServerDeps["signer"]) {
  const registered = v.agent?.agentKey ?? null;
  if (!signer) {
    return { enabled: false, reason: "Read-only: FUKU_AGENT_PRIVATE_KEY is not set, so fuku_execute_action is not available. Ask the owner to configure the agent key.", agentKey: null };
  }
  if (registered && registered.source === "external" && sameAddress(registered.address, signer.address)) {
    return { enabled: true, reason: "The configured agent key is this agent's registered key; Fuku checks its signature on every execution.", agentKey: signer.address };
  }
  return {
    enabled: true,
    reason: `The configured key ${signer.address} is not this agent's registered key (${registered ? `${registered.address}, held by ${registered.source === "fuku" ? "Fuku" : "its developer"}` : "none"}): Fuku will refuse executions. Run npm run mcp:setup, or fix FUKU_AGENT_PRIVATE_KEY.`,
    agentKey: signer.address,
  };
}

const actionInput = {
  action: z
    .string()
    .min(1)
    .max(40)
    .describe('The capability to use, e.g. "transfer", "read_balances", "swap", "withdraw". It must be on the passport.'),
  amount: z.number().positive().max(1_000_000_000).optional().describe("Amount in USDC (for an A-Token transfer, in that token, e.g. 30 for 30 aUSDC). Required for value actions."),
  to: z.string().max(100).optional().describe("Recipient wallet address (0x…), required for transfer."),
  asset: z.string().max(32).optional().describe('A-Token symbol for a transfer on an A-Token passport, e.g. "aUSDC".'),
  app: z.string().max(60).optional().describe("The application the action is for, required when the passport is scoped to apps."),
};

const toRequest = (a: { action: string; amount?: number; to?: string; asset?: string; app?: string }) => ({
  action: a.action,
  ...(a.amount !== undefined ? { amountUsdc: a.amount } : {}),
  ...(a.to ? { to: a.to } : {}),
  ...(a.asset ? { asset: a.asset } : {}),
  ...(a.app ? { app: a.app } : {}),
});

export function createFukuMcpServer({ config, client, signer }: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const agentId = config.agentId;

  const whoamiData = async () => {
    const v = await client.verifyAgent(agentId);
    if (!v.agent) throw new FukuError(404, v.error ?? "Agent not found", v, "not_found");
    const m = await client.getMandate(agentId).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
    return { v, m };
  };

  server.registerTool(
    "fuku_whoami",
    {
      title: "Who am I in Fuku",
      description:
        "Call this first in every session. Returns who you are as a Fuku agent: your name and ids (Fuku and ERC-8004), your human owner, your permission passport (allowed actions, daily limits, blocked actions, app scope), the owner's on-chain mandate (daily cap, per-transfer limit, approved payees, spent today), your trust score, and whether you can execute actions. Use it to answer 'what am I allowed to do?'.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      guarded(config, async () => {
        const { v, m } = await whoamiData();
        const execute = executeStatus(v, signer);
        const lines = [
          `You are ${v.agent!.name} (${v.agent!.id})${v.agent!.erc8004 ? `, ERC-8004 agent #${v.agent!.erc8004.agentId} (chain ${v.agent!.erc8004.chainId ?? "?"})` : ", not registered on ERC-8004"}. Status: ${v.agent!.status}.`,
          `Owner: ${v.owner?.displayName ?? "?"}, ${v.owner?.humanVerified ? "passkey-verified" : "not passkey-verified"}${v.owner?.custody ? `, ${v.owner.custody === "owner" ? "owner-controlled on-chain" : "custodial (Fuku's relayer controls the identity on-chain)"}` : ""}.`,
          ...(v.passport ? passportLines(v.passport) : ["Passport: none. Every action is blocked (R1) until the owner approves one."]),
          ...("error" in m ? [`Mandate: could not be read (${m.error}).`] : mandateLines(m)),
          `Trust score: ${v.trust?.score ?? "?"} (${v.trust?.level ?? "?"}).`,
          `Execute: ${execute.enabled ? "enabled" : "disabled"}. ${execute.reason}`,
          "Before moving value, call fuku_check_permission. A BLOCKED decision is final: report the rule and the reason.",
        ];
        return ok(lines.join("\n"), {
          agent: v.agent,
          owner: v.owner ? { id: v.owner.id, displayName: v.owner.displayName, humanVerified: v.owner.humanVerified, custody: v.owner.custody ?? null } : null,
          passport: v.passport ?? null,
          mandate: "error" in m ? { error: m.error } : { ...m.mandate, payees: m.payees ?? null, payeesSource: m.payeesSource ?? null, reason: m.reason },
          trust: v.trust ?? null,
          verified: v.verified,
          execute,
          chain: v.chain ?? null,
        });
      }),
  );

  server.registerTool(
    "fuku_check_permission",
    {
      title: "Check permission (dry run)",
      description:
        "Dry run: would this action be allowed right now? Returns ALLOWED or BLOCKED with the rule id and the reason, the daily limit left, and the Cleanverse checks for A-Token transfers. Nothing is recorded, reserved or signed. Always call this before fuku_execute_action for anything that moves value (transfer, swap, withdraw, stake). If it says BLOCKED, do not execute: tell the user the rule and the reason.",
      inputSchema: actionInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      guarded(config, async () => {
        const c = await client.checkPermission(agentId, toRequest(input));
        return ok(checkText(c), { ...c });
      }),
  );

  if (signer) {
    server.registerTool(
      "fuku_execute_action",
      {
        title: "Execute an action through Fuku",
        description:
          "Ask Fuku to execute an action as this agent, signed with your agent key. Fuku evaluates it against your owner's passport, then either blocks it with a rule id or executes it (an A-Token transfer moves through FukuSpendGuard on Monad), anchors a proof, updates your trust score and explains the outcome. For anything that moves value, call fuku_check_permission first. A BLOCKED decision is a normal result and final for this request: report the rule id and the reason to the user, and never retry with tweaked parameters (smaller amount, other recipient, split payments, other asset) to get around it. Each call gets an idempotency key (returned); if a call fails with a network error, retry with the same idempotencyKey so nothing executes twice.",
        inputSchema: {
          ...actionInput,
          idempotencyKey: z
            .string()
            .min(8)
            .max(128)
            .optional()
            .describe("Only to retry a call that failed with a network error: the key from the earlier attempt. Omit it for a new action."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      (input) =>
        guarded(config, async () => {
          const idempotencyKey = input.idempotencyKey ?? Fuku.newIdempotencyKey();
          const r = await client.executeAction(agentId, toRequest(input), { idempotencyKey, signer });
          return ok(executeText(r), {
            id: r.id,
            decision: r.decision,
            status: r.status,
            ruleId: r.ruleId,
            subCode: r.subCode ?? null,
            reason: r.reason,
            proofHash: r.proofHash,
            receipt: r.receipt,
            transfer: r.transfer ?? null,
            compliance: r.compliance
              ? {
                  mode: r.compliance.mode,
                  asset: r.compliance.asset,
                  owner: r.compliance.owner,
                  counterparty: r.compliance.counterparty,
                  complianceRef: r.compliance.complianceRef,
                }
              : null,
            scoreBefore: r.scoreBefore,
            scoreAfter: r.scoreAfter,
            trustDelta: r.trustDelta,
            explanation: r.explanation,
            idempotencyKey: r.idempotencyKey ?? idempotencyKey,
            replayed: r.replayed ?? false,
            agentSignature: r.agentSignature ?? null,
          });
        }),
    );
  }

  server.registerTool(
    "fuku_get_action",
    {
      title: "Get an action",
      description: "The lifecycle and evidence of an earlier action, by its id (from fuku_execute_action): status, decision, rule, proof hash, and the Monad transactions. Use it to follow a transfer that was still pending.",
      inputSchema: { actionId: z.string().min(1).max(100).describe("The action id returned by fuku_execute_action.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ actionId }) =>
      guarded(config, async () => {
        const a = await client.getAction(actionId);
        return ok(actionText(a), { ...a });
      }),
  );

  server.registerTool(
    "fuku_verify_agent",
    {
      title: "Verify an agent",
      description:
        "Verify any Fuku agent, the way a counterparty would before trusting it: is its owner passkey-verified, is its passport active and anchored on Monad, can it act now, its trust score, its ERC-8004 registration and its agent key. Leave agentId empty to verify yourself.",
      inputSchema: { agentId: z.string().max(100).optional().describe("A Fuku agent id (fuku:agent:0x…). Defaults to this agent.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ agentId: other }) =>
      guarded(config, async () => {
        const v = await client.verifyAgent(other || agentId);
        if (!v.agent) throw new FukuError(404, v.error ?? "Agent not found", v, "not_found");
        return ok(verifyText(v), { ...v });
      }),
  );

  server.registerTool(
    "fuku_verify_score",
    {
      title: "Verify my trust score from the chain",
      description:
        "Recompute this agent's trust score from Monad (commit-reveal): every decision record Fuku keeps is checked against the proof anchored for it, and the score is compared with the one anchored on-chain and with Fuku's ledger. Returns ✓ or ✗ with the record counts and what the chain does not commit to.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      guarded(config, async () => {
        const s = await client.verifyScore(agentId);
        return ok(scoreText(s), { ...s });
      }),
  );

  server.registerResource(
    "passport",
    "fuku://agent/passport",
    { title: "This agent's permission passport", description: "The passport the owner approved for this agent, as JSON.", mimeType: "application/json" },
    async (uri) => {
      const v = await client.verifyAgent(agentId);
      const body = { agentId, name: v.agent?.name ?? null, owner: v.owner?.displayName ?? null, passport: v.passport ?? null };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 2) }] };
    },
  );

  server.registerPrompt(
    "fuku_safe_payment",
    {
      title: "Pay safely through Fuku",
      description: "Walks the model through a payment: who am I, check, execute only if allowed, report.",
      argsSchema: {
        to: z.string().describe("Recipient wallet address (0x…)"),
        amount: z.string().describe("Amount, e.g. 30"),
        asset: z.string().optional().describe('A-Token symbol, default "aUSDC"'),
      },
    },
    ({ to, amount, asset }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Pay ${amount} ${asset || "aUSDC"} to ${to} through Fuku, safely:`,
              "1. Call fuku_whoami and check that a transfer of this size fits my passport and mandate.",
              `2. Call fuku_check_permission with action "transfer", amount ${amount}, to ${to}, asset "${asset || "aUSDC"}".`,
              "3. If it is BLOCKED, stop. Tell me the rule id and the reason. Do not change the amount, the recipient or the asset to get around it.",
              "4. If it is ALLOWED, call fuku_execute_action with exactly the same parameters.",
              "5. Report the decision, the rule, the Monad transaction link and my trust score before and after.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  return server;
}

