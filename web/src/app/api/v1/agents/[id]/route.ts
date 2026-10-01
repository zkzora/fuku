import { db } from "@/lib/db";
import { json, withApiKey } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { SCORED_EVENTS, scoreFor, toAgentView } from "@/lib/services/agents";
import { chainMode, readAgentOnChain } from "@/lib/chain";
import { idToBytes32 } from "@/lib/ids";
import { apassEligibleFor, storedAPass } from "@/lib/services/cleanverse";
import { verificationOf } from "@/lib/services/identity";

type P = { id: string };

const ON_CHAIN_STATUS = ["registered", "active", "paused", "revoked"];

/**
 * SDK: fuku.verifyAgent()
 * Public verification: who is behind an agent, what evidence backs each claim, and whether the
 * agent can act right now. `verified` is true only when the owner completed a passkey ceremony, the
 * passport is active, and (live) the registries hold the agent with that exact passport hash and
 * an executable status. In mock mode nothing is anchored, so `verified` is false and `checks`
 * explains why. A Fuku database record alone never makes an agent verified.
 */
export const GET = withApiKey<P>(async (_req, caller, { id }) => {
  rateLimit("read", caller.id);
  const agent = await db.agent.findUnique({
    where: { id },
    include: { policy: true, identity: true, reputationEvents: SCORED_EVENTS },
  });
  if (!agent) return json({ verified: false, error: "Agent not found", code: "not_found" }, { status: 404 });
  const [apassEligible, apass, verification] = await Promise.all([
    apassEligibleFor(agent.identity),
    storedAPass(agent.identity.walletVerifiedBy ? agent.identity.walletAddress : null),
    verificationOf(agent.identity),
  ]);
  const score = scoreFor(agent, agent.identity, agent.reputationEvents, { apassEligible });
  const view = toAgentView({ ...agent, trustScore: score.score });

  const live = chainMode() === "live";
  let onChain = null;
  let chainError: string | null = null;
  if (live) {
    try {
      onChain = await readAgentOnChain(agent.id);
    } catch (err) {
      chainError = (err as Error).message.slice(0, 160);
    }
  }
  const policyActive = Boolean(agent.policy?.active);
  const hashMatches = Boolean(onChain?.exists && agent.policy?.policyHash && onChain.policyHash?.toLowerCase() === agent.policy.policyHash.toLowerCase());
  const anchoring = !live
    ? { status: "mock" as const, detail: "Settlement is mocked: nothing about this agent is anchored on a chain." }
    : chainError
      ? { status: "unreachable" as const, detail: `Could not read the registries: ${chainError}` }
      : !onChain?.exists
        ? { status: "not_anchored" as const, detail: "The agent is not in AgentRegistry yet (it is anchored lazily on its first live write)." }
        : !onChain.policyActive || !hashMatches
          ? { status: "stale" as const, detail: "The registry's passport is revoked or differs from the one Fuku enforces." }
          : { status: "anchored" as const, detail: `AgentRegistry status ${ON_CHAIN_STATUS[onChain.status ?? 0]}; passport v${onChain.policyVersion} hash matches.` };
  const onChainExecutable = !live || (onChain?.exists ? (onChain.status ?? 3) < 2 : true);
  const executable = agent.status === "active" && policyActive && onChainExecutable;
  const aToken = (view.policy?.assets?.length ?? 0) > 0;
  const verified = verification.passkey.status === "verified" && policyActive && anchoring.status === "anchored" && executable;

  return json({
    verified,
    checks: {
      record: { ok: true, detail: "The agent exists in Fuku's database." },
      owner: { passkey: verification.passkey, wallet: verification.wallet, uniqueHuman: verification.uniqueHuman },
      credential: verification.cleanverse,
      policy: {
        ok: policyActive,
        version: agent.policy?.version ?? null,
        policyHash: agent.policy?.policyHash ?? null,
        detail: policyActive ? "An active passport constrains the agent." : "No active passport: every action is denied (R1).",
      },
      anchoring,
      executable: {
        ok: executable,
        valueActions: executable && verification.passkey.status === "verified" && (!aToken || verification.cleanverse.status === "eligible"),
        detail: executable
          ? "The agent can act within its passport."
          : agent.status !== "active"
            ? `The agent is ${agent.status} in Fuku.`
            : !policyActive
              ? "No active passport."
              : "The registry marks the agent paused or revoked.",
      },
    },
    agent: {
      id: view.id,
      onChainId: idToBytes32(view.id),
      name: view.name,
      version: view.version,
      status: view.status,
      capabilities: view.capabilities,
      registeredTx: view.registeredTx,
      createdAt: view.createdAt,
      // The agent's own key (its ERC-8004 agentWallet): held by Fuku ("fuku") or by the developer ("external").
      agentKey: agent.agentWallet ? { address: agent.agentWallet, source: agent.agentKey ? "fuku" : "external" } : null,
      erc8004: agent.erc8004Id ? { agentId: agent.erc8004Id, registry: agent.erc8004Registry, chainId: agent.erc8004ChainId } : null,
    },
    owner: {
      id: agent.identity.id,
      onChainId: idToBytes32(agent.identity.id),
      displayName: agent.identity.displayName,
      /** Passkey ceremony with user verification. Not a proof of unique personhood. */
      humanVerified: agent.identity.humanVerified,
      authMethod: agent.identity.authMethod,
      /** Who controls the identity on-chain: "relayer" (custodial, Fuku's key) or "owner" (the bound wallet). */
      custody: agent.identity.chainCustody ?? null,
      // Last persisted A-Pass read for the owner's verified wallet; `source` says whether Cleanverse or the simulator answered.
      cleanverse: {
        mode: apass.mode,
        source: apass.source,
        found: apass.found,
        status: apass.pass?.status ?? null,
        tier: apass.pass?.tier ?? null,
        subTier: apass.pass?.subTier ?? null,
        expiresAt: apass.pass?.expiresAt ?? null,
        checkedAt: apass.checkedAt,
      },
    },
    passport: view.policy
      ? {
          active: view.policy.active,
          version: view.policy.version,
          allowed: view.policy.allowed,
          blocked: view.policy.blocked,
          scopeApps: view.policy.scopeApps,
          assets: view.policy.assets ?? [],
        }
      : null,
    trust: { score: score.score, level: score.level, scoringVersion: score.scoringVersion, uncertainty: score.uncertainty },
    chain: live ? "live" : "mock",
  });
});
