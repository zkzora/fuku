/**
 * Envio HyperIndex handlers for Fuku Protocol.
 * Generated types come from `envio codegen` once config.yaml has real contract addresses.
 */
import {
  HumanIdentityRegistry,
  AgentRegistry,
  PermissionRegistry,
  ReputationRegistry,
} from "generated";

HumanIdentityRegistry.IdentityRegistered.handler(async ({ event, context }) => {
  context.Identity.set({
    id: event.params.identityId,
    controller: event.params.controller,
    proofHash: event.params.proofHash,
    humanVerified: false,
    registeredAt: BigInt(event.block.timestamp),
  });
});

HumanIdentityRegistry.HumanVerified.handler(async ({ event, context }) => {
  const identity = await context.Identity.get(event.params.identityId);
  if (identity) context.Identity.set({ ...identity, humanVerified: event.params.verified });
});

AgentRegistry.AgentRegistered.handler(async ({ event, context }) => {
  context.Agent.set({
    id: event.params.agentId,
    owner_id: event.params.ownerIdentityId,
    name: event.params.name,
    capabilitiesHash: event.params.capabilitiesHash,
    status: 0,
    policyHash: undefined,
    policyVersion: undefined,
    policyActive: false,
    allowedCount: 0,
    violationCount: 0,
    trustScore: undefined,
    registeredAt: BigInt(event.block.timestamp),
  });
});

AgentRegistry.AgentStatusChanged.handler(async ({ event, context }) => {
  const agent = await context.Agent.get(event.params.agentId);
  if (agent) context.Agent.set({ ...agent, status: Number(event.params.status) });
});

PermissionRegistry.PolicySet.handler(async ({ event, context }) => {
  const agent = await context.Agent.get(event.params.agentId);
  if (agent) {
    context.Agent.set({
      ...agent,
      policyHash: event.params.policyHash,
      policyVersion: Number(event.params.version),
      policyActive: true,
    });
  }
});

PermissionRegistry.PolicyRevoked.handler(async ({ event, context }) => {
  const agent = await context.Agent.get(event.params.agentId);
  if (agent) context.Agent.set({ ...agent, policyActive: false });
});

PermissionRegistry.ActionDecision.handler(async ({ event, context }) => {
  context.Decision.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    agent_id: event.params.agentId,
    actionHash: event.params.actionHash,
    allowed: event.params.allowed,
    proofHash: event.params.proofHash,
    ruleId: event.params.ruleId,
    timestamp: BigInt(event.params.timestamp),
  });
  const agent = await context.Agent.get(event.params.agentId);
  if (agent) {
    context.Agent.set({
      ...agent,
      allowedCount: agent.allowedCount + (event.params.allowed ? 1 : 0),
      violationCount: agent.violationCount + (event.params.allowed ? 0 : 1),
    });
  }
});

ReputationRegistry.ScoreUpdated.handler(async ({ event, context }) => {
  context.ScoreChange.set({
    id: `${event.transaction.hash}-${event.logIndex}`,
    agent_id: event.params.agentId,
    newScore: Number(event.params.newScore),
    delta: Number(event.params.delta),
    reason: event.params.reason,
    timestamp: BigInt(event.params.timestamp),
  });
  const agent = await context.Agent.get(event.params.agentId);
  if (agent) context.Agent.set({ ...agent, trustScore: Number(event.params.newScore) });
});
