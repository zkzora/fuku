/**
 * Envio HyperIndex handlers for Fuku Protocol.
 * Generated types come from `envio codegen` once config.yaml has real contract addresses.
 *
 * Idempotency: every per-event entity is keyed by `${txHash}-${logIndex}`, and handlers that bump
 * counters first check whether that entity already exists, so an event delivered twice is counted
 * once. Chain reorganisations are rolled back by HyperIndex itself.
 */
import {
  HumanIdentityRegistry,
  AgentRegistry,
  PermissionRegistry,
  ReputationRegistry,
  FukuSpendGuard,
  CleanverseAPassSim,
} from "generated";

const eventId = (event: { transaction: { hash: string }; logIndex: number }) => `${event.transaction.hash}-${event.logIndex}`;

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
  const id = eventId(event);
  // Delivered twice? Count it once.
  if (await context.Decision.get(id)) return;
  context.Decision.set({
    id,
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
  const id = eventId(event);
  if (await context.ScoreChange.get(id)) return;
  context.ScoreChange.set({
    id,
    agent_id: event.params.agentId,
    newScore: Number(event.params.newScore),
    delta: Number(event.params.delta),
    reason: event.params.reason,
    timestamp: BigInt(event.params.timestamp),
  });
  const agent = await context.Agent.get(event.params.agentId);
  if (agent) context.Agent.set({ ...agent, trustScore: Number(event.params.newScore) });
});

// --- FukuSpendGuard ----------------------------------------------------------------------------

FukuSpendGuard.MandateOpened.handler(async ({ event, context }) => {
  context.Mandate.set({
    id: `${event.params.agentId}-${event.params.wallet.toLowerCase()}`,
    agentId: event.params.agentId,
    wallet: event.params.wallet.toLowerCase(),
    token: event.params.token.toLowerCase(),
    dailyCap: event.params.dailyCap,
    maxPerTx: event.params.maxPerTx,
    validUntil: event.params.validUntil,
    restrictPayees: event.params.restrictPayees,
    version: event.params.version,
    active: true,
    updatedAt: BigInt(event.block.timestamp),
  });
});

FukuSpendGuard.MandateClosed.handler(async ({ event, context }) => {
  const id = `${event.params.agentId}-${event.params.wallet.toLowerCase()}`;
  const mandate = await context.Mandate.get(id);
  // Only apply a close at least as new as the mandate we hold (idempotent under redelivery).
  if (mandate && mandate.version <= event.params.version) {
    context.Mandate.set({ ...mandate, active: false, version: event.params.version, updatedAt: BigInt(event.block.timestamp) });
  }
});

FukuSpendGuard.PayeeSet.handler(async ({ event, context }) => {
  context.Payee.set({
    id: `${event.params.agentId}-${event.params.wallet.toLowerCase()}-${event.params.payee.toLowerCase()}`,
    agentId: event.params.agentId,
    wallet: event.params.wallet.toLowerCase(),
    payee: event.params.payee.toLowerCase(),
    allowed: event.params.allowed,
    updatedAt: BigInt(event.block.timestamp),
  });
});

FukuSpendGuard.GuardedTransferExecuted.handler(async ({ event, context }) => {
  // Keyed by transaction and log index: a redelivered event overwrites itself and is never counted twice.
  context.GuardedTransfer.set({
    id: eventId(event),
    agentId: event.params.agentId,
    from: event.params.from.toLowerCase(),
    to: event.params.to.toLowerCase(),
    token: event.params.token.toLowerCase(),
    amount: event.params.amount,
    actionHash: event.params.actionHash,
    proofHash: event.params.proofHash,
    complianceRef: event.params.complianceRef,
    mandateVersion: event.params.mandateVersion,
    nonce: event.params.nonce,
    txHash: event.transaction.hash,
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
  });
});

// --- Cleanverse simulator (not Cleanverse) -----------------------------------------------------

CleanverseAPassSim.APassIssued.handler(async ({ event, context }) => {
  context.SimAPass.set({
    id: event.params.wallet.toLowerCase(),
    issuer: event.params.issuer.toLowerCase(),
    status: Number(event.params.status),
    tier: Number(event.params.tier),
    subTier: Number(event.params.subTier),
    group: event.params.group,
    subGroup: event.params.subGroup,
    expiresAt: event.params.expiresAt,
    cvRecordId: event.params.cvRecordId,
    updatedAt: BigInt(event.block.timestamp),
  });
});

CleanverseAPassSim.APassStatusChanged.handler(async ({ event, context }) => {
  const pass = await context.SimAPass.get(event.params.wallet.toLowerCase());
  if (pass) context.SimAPass.set({ ...pass, status: Number(event.params.status), updatedAt: BigInt(event.block.timestamp) });
});
