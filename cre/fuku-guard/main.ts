/**
 * fuku-guard: Chainlink CRE workflow that orchestrates an AI agent action through Fuku.
 *
 *   request  -> HTTP trigger receives { agentId, action, amountUsdc?, app? }
 *   verify   -> Fuku public API: who owns the agent, is the owner human, trust score, dry-run check
 *   execute  -> Fuku public API: evaluate the passport, execute or block, anchor the proof on Monad
 *   record   -> EVM read on Monad testnet: PermissionRegistry.stats + ReputationRegistry.getScore
 *
 * The workflow refuses to forward an action when the owner is not a verified human or the agent's
 * trust score is below `minTrustScore`, so a low-trust agent never reaches execution at all.
 */
import {
  EVMClient,
  HTTPCapability,
  HTTPClient,
  LATEST_BLOCK_NUMBER,
  Runner,
  bytesToHex,
  consensusIdenticalAggregation,
  decodeJson,
  encodeCallMsg,
  getNetwork,
  handler,
  json,
  type HTTPPayload,
  type NodeRuntime,
  type Runtime,
} from "@chainlink/cre-sdk";
import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  stringToHex,
  zeroAddress,
  type Address,
} from "viem";
import { z } from "zod";

// --- Config ---------------------------------------------------------------------------------

export const configSchema = z.object({
  /** Base URL of the Fuku app. Must be reachable from the DON when deployed (no redirects). */
  fukuBaseUrl: z.string(),
  /** Actions from agents below this trust score are rejected before execution. */
  minTrustScore: z.number().int().min(0).max(100),
  /** Reject agents whose owner is not a human-verified Fuku identity. */
  requireHumanOwner: z.boolean(),
  /** EVM address allowed to trigger the deployed workflow. Empty = open trigger (simulation only). */
  authorizedEVMAddress: z.string(),
  monad: z.object({
    chainSelectorName: z.string(),
    permissionRegistry: z.string(),
    reputationRegistry: z.string(),
  }),
});

export type Config = z.infer<typeof configSchema>;

/** Logical secret id declared in ../secrets.yaml (value comes from FUKU_API_KEY_ALL in .env). */
export const FUKU_API_KEY_SECRET = "FUKU_API_KEY";

// --- Types ----------------------------------------------------------------------------------

export const actionRequestSchema = z.object({
  agentId: z.string().min(1),
  action: z.string().min(1),
  amountUsdc: z.number().nonnegative().optional(),
  app: z.string().optional(),
});

export type ActionRequest = z.infer<typeof actionRequestSchema>;

export type Verification = {
  found: boolean;
  agentName: string;
  agentStatus: string;
  ownerName: string;
  humanVerified: boolean;
  passportActive: boolean;
  trustScore: number;
  trustLevel: string;
  checkAllowed: boolean;
  checkRuleId: string;
  checkReason: string;
};

export type Execution = {
  decision: string;
  ruleId: string;
  reason: string;
  proofHash: string;
  txHash: string;
  receiptMode: string;
  scoreBefore: number;
  scoreAfter: number;
};

export type OnChainRecord = {
  allowedCount: string;
  violationCount: string;
  score: string;
  scoreExists: boolean;
};

// --- Helpers --------------------------------------------------------------------------------

const b64 = (value: unknown) => Buffer.from(new TextEncoder().encode(JSON.stringify(value))).toString("base64");

const agentKey = (agentId: string) => keccak256(stringToHex(agentId));

const permissionAbi = parseAbi([
  "function stats(bytes32 agentId) view returns (uint64 allowedCount, uint64 violationCount)",
]);
const reputationAbi = parseAbi([
  "function getScore(bytes32 agentId) view returns (uint16 score, uint64 updatedAt, bool exists)",
]);

// --- Step 2: verify (node mode, uses the API key secret) --------------------------------------

export const verifyAgent = (nodeRuntime: NodeRuntime<Config>, req: ActionRequest, apiKey: string): Verification => {
  const http = new HTTPClient();
  const base = nodeRuntime.config.fukuBaseUrl.replace(/\/+$/, "");
  const id = encodeURIComponent(req.agentId);
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };

  const verifyResp = http.sendRequest(nodeRuntime, { url: `${base}/api/v1/agents/${id}`, method: "GET", headers }).result();
  if (verifyResp.statusCode === 404) {
    return {
      found: false,
      agentName: "",
      agentStatus: "unknown",
      ownerName: "",
      humanVerified: false,
      passportActive: false,
      trustScore: 0,
      trustLevel: "Low",
      checkAllowed: false,
      checkRuleId: "",
      checkReason: "Agent is not registered with Fuku.",
    };
  }
  if (verifyResp.statusCode !== 200) throw new Error(`Fuku verifyAgent failed with status ${verifyResp.statusCode}`);
  const v = json(verifyResp) as {
    agent: { name: string; status: string };
    owner: { displayName: string; humanVerified: boolean };
    passport: { active: boolean } | null;
    trust: { score: number; level: string };
  };

  // Dry run: nothing is recorded, so every node may call it.
  const checkResp = http
    .sendRequest(nodeRuntime, {
      url: `${base}/api/v1/agents/${id}/check`,
      method: "POST",
      headers,
      body: b64({ action: req.action, amountUsdc: req.amountUsdc ?? null, app: req.app ?? null }),
    })
    .result();
  if (checkResp.statusCode !== 200) throw new Error(`Fuku checkPermission failed with status ${checkResp.statusCode}`);
  const c = json(checkResp) as { allowed: boolean; ruleId: string; reason: string };

  return {
    found: true,
    agentName: v.agent.name,
    agentStatus: v.agent.status,
    ownerName: v.owner.displayName,
    humanVerified: v.owner.humanVerified,
    passportActive: Boolean(v.passport?.active),
    trustScore: v.trust.score,
    trustLevel: v.trust.level,
    checkAllowed: c.allowed,
    checkRuleId: c.ruleId,
    checkReason: c.reason,
  };
};

// --- Step 3: execute (node mode, single execution via the shared cache) -----------------------

export const executeAction = (nodeRuntime: NodeRuntime<Config>, req: ActionRequest, apiKey: string): Execution => {
  const http = new HTTPClient();
  const base = nodeRuntime.config.fukuBaseUrl.replace(/\/+$/, "");
  const resp = http
    .sendRequest(nodeRuntime, {
      url: `${base}/api/v1/agents/${encodeURIComponent(req.agentId)}/execute`,
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: b64({
        action: req.action,
        amountUsdc: req.amountUsdc ?? null,
        app: req.app ?? null,
        params: { orchestrator: "chainlink-cre", workflow: "fuku-guard" },
      }),
      // Executing is not idempotent: one node calls Fuku, the others reuse the cached response.
      cacheSettings: { store: true, maxAge: "120s" },
    })
    .result();
  // Fuku answers 200 for ALLOWED and 403 for BLOCKED; both carry a full decision record.
  if (resp.statusCode !== 200 && resp.statusCode !== 403) {
    throw new Error(`Fuku executeAction failed with status ${resp.statusCode}`);
  }
  const r = json(resp) as {
    decision: string;
    ruleId: string;
    reason: string;
    proofHash: string;
    receipt: { txHash: string; mode: string };
    scoreBefore: number;
    scoreAfter: number;
  };
  return {
    decision: r.decision,
    ruleId: r.ruleId,
    reason: r.reason,
    proofHash: r.proofHash,
    txHash: r.receipt.txHash,
    receiptMode: r.receipt.mode,
    scoreBefore: r.scoreBefore,
    scoreAfter: r.scoreAfter,
  };
};

// --- Step 4: record (EVM read on Monad through the DON) ---------------------------------------

export const readOnChainRecord = (runtime: Runtime<Config>, agentId: string): OnChainRecord => {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: runtime.config.monad.chainSelectorName });
  if (!network) throw new Error(`Network not found: ${runtime.config.monad.chainSelectorName}`);
  const evm = new EVMClient(network.chainSelector.selector);
  const key = agentKey(agentId);

  const statsCall = evm
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: runtime.config.monad.permissionRegistry as Address,
        data: encodeFunctionData({ abi: permissionAbi, functionName: "stats", args: [key] }),
      }),
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result();
  const [allowedCount, violationCount] = decodeFunctionResult({
    abi: permissionAbi,
    functionName: "stats",
    data: bytesToHex(statsCall.data),
  });

  const scoreCall = evm
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: runtime.config.monad.reputationRegistry as Address,
        data: encodeFunctionData({ abi: reputationAbi, functionName: "getScore", args: [key] }),
      }),
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result();
  const [score, , exists] = decodeFunctionResult({
    abi: reputationAbi,
    functionName: "getScore",
    data: bytesToHex(scoreCall.data),
  });

  return {
    allowedCount: allowedCount.toString(),
    violationCount: violationCount.toString(),
    score: score.toString(),
    scoreExists: exists,
  };
};

// --- Handler ----------------------------------------------------------------------------------

export const onAgentAction = (runtime: Runtime<Config>, payload: HTTPPayload): string => {
  const parsed = actionRequestSchema.safeParse(decodeJson(payload.input));
  if (!parsed.success) {
    throw new Error(`Invalid request: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  const req = parsed.data;
  // Secrets are resolved at the DON level and handed to the node-mode steps.
  const apiKey = runtime.getSecret({ id: FUKU_API_KEY_SECRET }).result().value;
  runtime.log(`[request] agent=${req.agentId} action=${req.action} amountUsdc=${req.amountUsdc ?? "-"} app=${req.app ?? "-"}`);

  const verification = runtime
    .runInNodeMode(verifyAgent, consensusIdenticalAggregation<Verification>())(req, apiKey)
    .result();
  runtime.log(
    `[verify] found=${verification.found} owner=${verification.ownerName} human=${verification.humanVerified} ` +
      `trust=${verification.trustScore} passport=${verification.passportActive} dryRun=${verification.checkAllowed ? "ALLOWED" : "BLOCKED"} ${verification.checkRuleId}`,
  );

  const gate =
    !verification.found
      ? "agent not registered with Fuku"
      : runtime.config.requireHumanOwner && !verification.humanVerified
        ? "owner is not a verified human"
        : verification.trustScore < runtime.config.minTrustScore
          ? `trust score ${verification.trustScore} is below the minimum ${runtime.config.minTrustScore}`
          : null;

  if (gate) {
    runtime.log(`[verify] rejected before execution: ${gate}`);
    return JSON.stringify({ workflow: "fuku-guard", request: req, stage: "verify", outcome: "REJECTED_BY_CRE", reason: gate, verification });
  }

  const execution = runtime
    .runInNodeMode(executeAction, consensusIdenticalAggregation<Execution>())(req, apiKey)
    .result();
  runtime.log(
    `[execute] ${execution.decision} rule=${execution.ruleId} trust ${execution.scoreBefore}->${execution.scoreAfter} ` +
      `receipt=${execution.receiptMode} tx=${execution.txHash}`,
  );

  const record = readOnChainRecord(runtime, req.agentId);
  runtime.log(
    `[record] Monad PermissionRegistry.stats allowed=${record.allowedCount} violations=${record.violationCount}; ` +
      `ReputationRegistry.getScore=${record.score} (exists=${record.scoreExists})`,
  );

  return JSON.stringify({ workflow: "fuku-guard", request: req, stage: "record", outcome: execution.decision, verification, execution, record });
};

// --- Wiring -----------------------------------------------------------------------------------

export const initWorkflow = (config: Config) => {
  const http = new HTTPCapability();
  const trigger = config.authorizedEVMAddress
    ? http.trigger({ authorizedKeys: [{ type: "KEY_TYPE_ECDSA_EVM", publicKey: config.authorizedEVMAddress }] })
    : http.trigger({});
  return [handler(trigger, onAgentAction)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
