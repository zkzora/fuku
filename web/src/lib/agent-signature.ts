/**
 * Agent-signed API requests. An agent that holds its own key (one Fuku never had: the developer's,
 * registered as the agent's ERC-8004 agentWallet) signs each execute request with it. Fuku then
 * accepts an API execution for that agent only from the holder of its key, not from anyone who holds
 * the owner's API key.
 *
 * The signature is EIP-191 (personal_sign) over a readable message that carries the exact request
 * body. `@fuku/sdk` builds the same string (agentRequestMessage); a test keeps the two in step.
 */
import { getAddress, isAddressEqual, isHex, recoverMessageAddress, type Hex } from "viem";
import type { Agent } from "@prisma/client";
import { RequestError } from "./errors";

export const AGENT_SIGNATURE_HEADER = "x-fuku-agent-signature";
export const AGENT_ISSUED_AT_HEADER = "x-fuku-agent-issued-at";
/** How far a signed request's issued-at may be from the server clock, in seconds. */
export const AGENT_SIGNATURE_WINDOW_S = 300;

export interface AgentRequest {
  agentId: string;
  method: string;
  /** The API path with the agent id unencoded, e.g. /api/v1/agents/fuku:agent:0x…/execute. */
  path: string;
  idempotencyKey: string;
  /** Unix seconds. */
  issuedAt: number;
  /** The request body exactly as sent. */
  body: string;
}

export function agentRequestMessage(r: AgentRequest): string {
  return [
    "Fuku agent request",
    `Agent: ${r.agentId}`,
    `Request: ${r.method} ${r.path}`,
    `Idempotency-Key: ${r.idempotencyKey}`,
    `Issued-At: ${r.issuedAt}`,
    `Body: ${r.body}`,
  ].join("\n");
}

export const executePath = (agentId: string) => `/api/v1/agents/${agentId}/execute`;

/** The agent's key is the developer's own (external): only that key may speak for it over the API. */
export const holdsOwnKey = (agent: Pick<Agent, "agentWallet" | "agentKey">) => Boolean(agent.agentWallet && !agent.agentKey);

export interface PresentedSignature {
  /** The raw request body, as received. */
  body: string;
  signature: string | null;
  issuedAt: string | null;
}

/**
 * Check a v1 execute request against the agent's key. Required when the agent holds its own key;
 * verified whenever a signature is presented. Returns the signer, or null for an unsigned request
 * to an agent that does not need one.
 */
export async function verifyAgentRequest(
  agent: Pick<Agent, "id" | "name" | "agentWallet" | "agentKey">,
  presented: PresentedSignature,
  idempotencyKey: string | null,
  now = Math.floor(Date.now() / 1000),
): Promise<{ signer: string } | null> {
  if (!presented.signature) {
    if (holdsOwnKey(agent)) {
      throw new RequestError(
        `${agent.name} holds its own agent key: sign the request with it (${AGENT_SIGNATURE_HEADER}). @fuku/sdk does this with executeAction(…, { signer }).`,
        401,
        "agent_signature_required",
      );
    }
    return null;
  }
  if (!agent.agentWallet) throw new RequestError("This agent has no agent key to check a signature against.", 400, "agent_signature_unexpected");
  if (!idempotencyKey) throw new RequestError("A signed request needs an Idempotency-Key: the signature covers it.", 400, "invalid_request");
  const issuedAt = Number(presented.issuedAt);
  if (!presented.issuedAt || !Number.isSafeInteger(issuedAt)) {
    throw new RequestError(`A signed request needs ${AGENT_ISSUED_AT_HEADER} (unix seconds).`, 401, "agent_signature_invalid");
  }
  if (Math.abs(now - issuedAt) > AGENT_SIGNATURE_WINDOW_S) {
    throw new RequestError(`The agent signature was issued ${now - issuedAt} s from now; sign the request again.`, 401, "agent_signature_expired");
  }
  if (!isHex(presented.signature)) throw new RequestError("The agent signature is not hex.", 401, "agent_signature_invalid");
  const message = agentRequestMessage({ agentId: agent.id, method: "POST", path: executePath(agent.id), idempotencyKey, issuedAt, body: presented.body });
  let signer: string;
  try {
    signer = await recoverMessageAddress({ message, signature: presented.signature as Hex });
  } catch {
    throw new RequestError("The agent signature could not be recovered.", 401, "agent_signature_invalid");
  }
  if (!isAddressEqual(signer as Hex, agent.agentWallet as Hex)) {
    throw new RequestError(`The request is signed by ${signer}, not by ${agent.name}'s key.`, 401, "agent_signature_invalid");
  }
  return { signer: getAddress(signer) };
}
