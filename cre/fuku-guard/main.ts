/**
 * fuku-guard: Chainlink CRE workflow that orchestrates an AI agent action through Fuku.
 *
 *   request  -> HTTP trigger receives { agentId, action, amountUsdc?, app?, to?, asset?, requestId? }
 *   verify   -> Fuku public API: what backs the agent, trust score, preview (dry run) of the action
 *   execute  -> Fuku public API with an Idempotency-Key: evaluate, execute or block, anchor on Monad
 *   record   -> EVM read on Monad testnet: PermissionRegistry.stats, ReputationRegistry.getScore and,
 *               for an A-Token transfer, FukuSpendGuard.spentToday
 *
 * The workflow is one more client of the public API: every Fuku rule (owner verification R11,
 * Cleanverse R7-R9, limits R5, the on-chain guard R10) applies to it exactly as to any other caller,
 * so going through CRE never loosens enforcement. On top of that it can refuse early: when the
 * owner has no passkey verification or the trust score is below `minTrustScore`, the action never
 * reaches execution. The Idempotency-Key makes a DON-level retry replay instead of executing twice.
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
    /** FukuSpendGuard, for the spentToday read after an A-Token transfer. Empty string = skip. */
    spendGuard: z.string(),
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
  /** Recipient wallet for `transfer`. */
  to: z.string().optional(),
  /** A-Token symbol for `transfer` on an A-Token passport, e.g. "aUSDC". */
  asset: z.string().optional(),
  /**
   * The caller's id for this request; it becomes the Fuku Idempotency-Key. Without it the key is
   * derived from the payload, so identical payloads count as one request (a retry).
   */
  requestId: z.string().min(8).max(100).optional(),
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
  status: string;
  ruleId: string;
  reason: string;
  proofHash: string;
  txHash: string;
  receiptMode: string;
  receiptStatus: string;
  transferTxHash: string;
  ownerWallet: string;
  replayed: boolean;
  scoreBefore: number;
  scoreAfter: number;
};

export type OnChainRecord = {
  allowedCount: string;
  violationCount: string;
  score: string;
  scoreExists: boolean;
  /** FukuSpendGuard.spentToday(agent, owner wallet) in base units, when read. */
  guardSpentToday: string;
};

// --- Helpers --------------------------------------------------------------------------------

const b64 = (value: unknown) => Buffer.from(new TextEncoder().encode(JSON.stringify(value))).toString("base64");

const agentKey = (agentId: string) => keccak256(stringToHex(agentId));

/** Deterministic across DON nodes: the trigger's requestId, or a hash of the payload. */
export const idempotencyKeyFor = (req: ActionRequest) =>
  req.requestId ? `cre:${req.requestId}` : `cre:${keccak256(stringToHex(JSON.stringify([req.agentId, req.action, req.amountUsdc ?? null, req.app ?? null, req.to ?? null, req.asset ?? null])))}`;

const permissionAbi = parseAbi([
  "function stats(bytes32 agentId) view returns (uint64 allowedCount, uint64 violationCount)",
]);
const reputationAbi = parseAbi([
  "function getScore(bytes32 agentId) view returns (uint16 score, uint64 updatedAt, bool exists)",
]);
const guardAbi = parseAbi(["function spentToday(bytes32 agentId, address wallet) view returns (uint256)"]);

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
  const preview = { action: req.action, amountUsdc: req.amountUsdc ?? null, app: req.app ?? null, to: req.to ?? null, asset: req.asset ?? null };

  // Dry run: nothing is recorded, so every node may call it.
  const checkResp = http
    .sendRequest(nodeRuntime, {
      url: `${base}/api/v1/agents/${id}/check`,
      method: "POST",
      headers,
      body: b64(preview),
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
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        // Fuku replays the stored result for a repeated key, so a retried trigger never pays twice.
        "idempotency-key": idempotencyKeyFor(req),
      },
      body: b64({
        action: req.action,
        amountUsdc: req.amountUsdc ?? null,
        app: req.app ?? null,
        to: req.to ?? null,
        asset: req.asset ?? null,
        // A label for the activity timeline; Fuku shows it as declared by the caller.
        params: { orchestrator: "chainlink-cre", workflow: "fuku-guard" },
      }),
      // One node calls Fuku, the others reuse the cached response; the idempotency key covers retries.
      cacheSettings: { store: true, maxAge: "120s" },
    })
    .result();
  // 200 allowed, 202 broadcast but pending, 403 blocked; each carries a full decision record.
  if (resp.statusCode !== 200 && resp.statusCode !== 202 && resp.statusCode !== 403) {
    throw new Error(`Fuku executeAction failed with status ${resp.statusCode}`);
  }
  const r = json(resp) as {
    decision: string;
    status?: string;
    ruleId: string;
    reason: string;
    proofHash: string;
    receipt: { txHash: string | null; mode: string; status?: string };
    transfer?: { txHash: string | null } | null;
    compliance?: { evidence?: { owner?: { wallet?: string | null } } | null } | null;
    replayed?: boolean;
    scoreBefore: number;
    scoreAfter: number;
  };
  return {
    decision: r.decision,
    status: r.status ?? "",
    ruleId: r.ruleId,
    reason: r.reason,
    proofHash: r.proofHash,
    txHash: r.receipt.txHash ?? "",
    receiptMode: r.receipt.mode,
    receiptStatus: r.receipt.status ?? "",
    transferTxHash: r.transfer?.txHash ?? "",
    ownerWallet: r.compliance?.evidence?.owner?.wallet ?? "",
    replayed: Boolean(r.replayed),
    scoreBefore: r.scoreBefore,
    scoreAfter: r.scoreAfter,
  };
};

// --- Step 4: record (EVM read on Monad through the DON) ---------------------------------------

export const readOnChainRecord = (runtime: Runtime<Config>, agentId: string, ownerWallet = ""): OnChainRecord => {
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

  let guardSpentToday = "";
  const guard = runtime.config.monad.spendGuard;
  if (guard && /^0x[0-9a-fA-F]{40}$/.test(ownerWallet)) {
    const spentCall = evm
      .callContract(runtime, {
        call: encodeCallMsg({
          from: zeroAddress,
          to: guard as Address,
          data: encodeFunctionData({ abi: guardAbi, functionName: "spentToday", args: [key, ownerWallet as Address] }),
        }),
        blockNumber: LATEST_BLOCK_NUMBER,
      })
      .result();
    guardSpentToday = decodeFunctionResult({ abi: guardAbi, functionName: "spentToday", data: bytesToHex(spentCall.data) }).toString();
  }

  return {
    allowedCount: allowedCount.toString(),
    violationCount: violationCount.toString(),
    score: score.toString(),
    scoreExists: exists,
    guardSpentToday,
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
  runtime.log(
    `[request] agent=${req.agentId} action=${req.action} amountUsdc=${req.amountUsdc ?? "-"} app=${req.app ?? "-"} to=${req.to ?? "-"} asset=${req.asset ?? "-"}`,
  );

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
        ? "owner has not completed a passkey ceremony"
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
    `[execute] ${execution.decision} ${execution.status} rule=${execution.ruleId} trust ${execution.scoreBefore}->${execution.scoreAfter} ` +
      `receipt=${execution.receiptMode}/${execution.receiptStatus} tx=${execution.txHash}${execution.transferTxHash ? ` transfer=${execution.transferTxHash}` : ""}${execution.replayed ? " (replayed)" : ""}`,
  );

  const record = readOnChainRecord(runtime, req.agentId, execution.ownerWallet);
  runtime.log(
    `[record] Monad PermissionRegistry.stats allowed=${record.allowedCount} violations=${record.violationCount}; ` +
      `ReputationRegistry.getScore=${record.score} (exists=${record.scoreExists})` +
      (record.guardSpentToday ? `; FukuSpendGuard.spentToday=${record.guardSpentToday}` : ""),
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
